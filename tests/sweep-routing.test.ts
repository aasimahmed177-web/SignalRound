// The sweep resolves with every stage a preset keeps and files each round under the preset that keeps
// it (workflows/sweep.ts), over a three-day window for the hourly day sweep. None of that may let old
// news through: a re-routed round is still dropped out of window, held as a late re-report, and kept
// out of delivery by the news window, exactly as it would be in its own preset's sweep.

import type { ExtractedItem, ExtractedRound } from "@fireround/core";
import { DAY_WINDOW_RESOLVE_DAYS, groupByPreset, hostOf, resolveRounds, resolveWindowStartFor, sweepResolveOptions } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { SWEEP_SEEN_DAYS } from "../lib/lanes";
import { setDisposition } from "../lib/persist";
import { enqueueRouted, persistRouted, routingTable } from "../lib/routing";
import { createTarget } from "../lib/settings";
import { record, testDb } from "./helpers";

const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);

function round(partial: Partial<ExtractedRound> & { company_name: string; round_type_as_written: string }): ExtractedRound {
  return {
    company_website: null,
    company_description: null,
    amount_as_written: "$24 million",
    amount_kind: "round",
    valuation_as_written: null,
    lead_investors: ["Fund One"],
    other_investors: [],
    announced_date: null,
    headquarters: null,
    sector: null,
    evidence_quote: `${partial.company_name} today announced it raised $24 million in ${partial.round_type_as_written} funding led by Fund One.`,
    source_url: null,
    is_background: false,
    is_rumor: false,
    ...partial,
  };
}

function item(r: ExtractedRound, url: string, published: string): ExtractedItem {
  return { round: r, source: { url, host: hostOf(url), published, title: `${r.company_name} raises $24 million` }, page_kind: "article" };
}

describe("the sweep's resolve window", () => {
  test("the day window resolves over three days, the same span the sweep's ledger skips a read page", () => {
    expect(DAY_WINDOW_RESOLVE_DAYS).toBe(3);
    expect(SWEEP_SEEN_DAYS.day).toBe(DAY_WINDOW_RESOLVE_DAYS);
    expect(NOW.getTime() - resolveWindowStartFor("day", NOW).getTime()).toBe(3 * 86_400_000);
    expect(NOW.getTime() - resolveWindowStartFor("week", NOW).getTime()).toBe(7 * 86_400_000);
  });
});

describe("a round of another preset's stage, read by this preset's sweep", () => {
  test("lands under the preset that keeps it instead of being dropped as another stage", async () => {
    const table = await routingTable(await testDb());
    const items = [
      item(
        round({ company_name: "Routeco", round_type_as_written: "Series A", announced_date: daysAgo(2) }),
        "https://news.example/2026/routeco-raises",
        daysAgo(2),
      ),
      item(
        round({ company_name: "Bridgeco", round_type_as_written: "pre-Series A", announced_date: daysAgo(1) }),
        "https://news.example/2026/bridgeco-raises",
        daysAgo(1),
      ),
    ];
    // What the seed sweep resolved with before: its own stages only.
    const narrow = resolveRounds(items, { ...sweepResolveOptions(["pre_seed", "seed"], "day", NOW), now: NOW });
    expect(narrow.kept).toHaveLength(0);
    expect(narrow.dropped.otherStage).toBe(2);
    const wide = resolveRounds(items, { ...sweepResolveOptions(table.stages, "day", NOW), now: NOW });
    expect(wide.kept.map((r) => r.company_key).sort()).toEqual(["bridgeco", "routeco"]);
    const { groups } = groupByPreset(wide.kept, table.presets, "seed");
    expect([...groups.keys()]).toEqual(["series-a-b"]);
    expect(
      groups
        .get("series-a-b")
        ?.map((r) => r.stage)
        .sort(),
    ).toEqual(["pre_a", "series_a"]);
  });

  test("a round announced before the three days is still dropped out of window, whatever preset would keep it", async () => {
    const table = await routingTable(await testDb());
    const items = [
      // Surfaced on day two: lands late.
      item(
        round({ company_name: "Lateco", round_type_as_written: "Series B", announced_date: daysAgo(2) }),
        "https://news.example/lateco",
        daysAgo(0),
      ),
      // A re-report of a round from twenty days ago on a page published today: old news.
      item(
        round({ company_name: "Oldco", round_type_as_written: "Series C", announced_date: daysAgo(20) }),
        "https://news.example/oldco",
        daysAgo(0),
      ),
      // Five days: outside the sweep's three and the day of slack past them.
      item(
        round({ company_name: "Staleco", round_type_as_written: "Series A", announced_date: daysAgo(5) }),
        "https://news.example/staleco",
        daysAgo(5),
      ),
    ];
    const r = resolveRounds(items, { ...sweepResolveOptions(table.stages, "day", NOW), now: NOW });
    expect(r.kept.map((x) => x.company_key)).toEqual(["lateco"]);
    expect(r.dropped.outOfWindow).toBe(2);
  });
});

describe("a re-routed round meets every trust safeguard on persist and delivery", () => {
  test("a late re-report the store's history ledger shows is held under the preset it was routed to, and never queued", async () => {
    const db = await testDb();
    await createTarget(db, { channel: "slack", target: "https://hooks.slack.test/abc", minConfidence: 0.5 });
    // An earlier round already stored, and a lead for its Series B already on the ledger.
    const earlier = record({
      company_name: "Heldco",
      company_key: "heldco",
      company_domain: "heldco.com",
      stage: "seed",
      stage_as_written: "Seed",
      announced_date: daysAgo(500),
      date_basis: "stated",
      amount: { value: 4, currency: "USD", as_written: "$4M", usd_millions: 4, fx_rate: 1, fx_date: daysAgo(500) },
    });
    await persistRouted(db, [earlier], "seed", "run-0");
    const prior = { stage_as_written: "Series B", amount_as_written: "$40M", announced_date: daysAgo(120).slice(0, 7), lead_investors: [] };
    await db
      .insert(schema.historyPromotions)
      .values({ companyId: "heldco.com", priorKey: "series b|$40m", prior, origin: "search", status: "pending" });
    // The seed sweep reads a page-dated profile that reports the same $40M Series B as new.
    const reReport = record({
      company_name: "Heldco",
      company_key: "heldco",
      company_domain: "heldco.com",
      stage: "series_b",
      stage_as_written: "Series B",
      announced_date: daysAgo(0),
      date_basis: "page",
      amount: { value: 40, currency: "USD", as_written: "$40 million", usd_millions: 40, fx_rate: 1, fx_date: daysAgo(0) },
      confidence: 0.9,
    });
    const s = await persistRouted(db, [reReport], "seed", "run-1");
    expect(Object.keys(s.changedByPreset)).toEqual(["series-a-b"]);
    const [row] = await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, reReport.id));
    expect(row.presetSlug).toBe("series-a-b");
    expect(row.disposition).toBe("review");
    expect(row.hold).toMatch(/^held: the history ledger \(search\) reports Series B \$40M/);
    expect(await enqueueRouted(db, s.changedByPreset)).toBe(0);
  });

  test("a re-routed round announced more than 14 days ago is never queued on any channel", async () => {
    const db = await testDb();
    await createTarget(db, { channel: "slack", target: "https://hooks.slack.test/abc", minConfidence: 0.5 });
    const fresh = record({
      company_name: "Freshco",
      company_key: "freshco",
      stage: "series_a",
      announced_date: daysAgo(1),
      confidence: 0.9,
    });
    const stale = record({
      company_name: "Staleco",
      company_key: "staleco",
      stage: "series_a",
      announced_date: daysAgo(20),
      confidence: 0.9,
    });
    const s = await persistRouted(db, [fresh, stale], "growth", "run-1");
    expect(s.changedByPreset["series-a-b"]?.sort()).toEqual([fresh.id, stale.id].sort());
    await setDisposition(db, fresh.id, "publish");
    expect(await enqueueRouted(db, s.changedByPreset)).toBe(1);
    const queued = await db.select().from(schema.deliveries);
    expect(queued.map((d) => d.roundId)).toEqual([fresh.id]);
  });
});
