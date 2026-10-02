// History rounds against an in-memory Postgres with a scripted reader (no network): promotion
// through the normal read, resolve, read-back, and persist; what a history row is kept out of
// (deliveries, unread, Trending, the week's numbers, the default feed); what it joins (company and
// investor pages); the ledger's idempotence, merges, no-source outcomes, and backoff. The feeds and
// the route read the app's own store: tests/history-route.test.ts.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { describe, expect, test } from "vitest";

import { getCompany } from "../lib/company";
import { corroborateRecord } from "../lib/corroborate";
import { enqueueDeliveries, flushDeliveries } from "../lib/delivery";
import {
  claimPrior,
  finishPromotion,
  HISTORY_BACKFILL_DEFAULTS,
  HISTORY_MAX_ATTEMPTS,
  historyCoverage,
  historyTargets,
  nextHistoryRetry,
  parseHistoryBackfillParams,
  planPromotion,
  promotePrior,
  queueCompanyHistory,
  readPlan,
  ruledOutPriors,
} from "../lib/history";
import { addTallies, emptyHistoryTally, tallyPromotion } from "../lib/history-tally";
import { getInvestor } from "../lib/investor";
import { countRounds, feedHistory, listRounds, mergeDuplicateRounds, persistRecords, setStatus } from "../lib/persist";
import { applyRecordFixes } from "../lib/repair";
import { createTarget } from "../lib/settings";
import { demoStats, overview } from "../lib/stats";
import { followRounds, trendingRoundIds } from "../lib/trending";
import { record, testDb } from "./helpers";
import {
  isoDaysAgo,
  item,
  reader,
  round,
  SEED_KEY,
  SEED_PRIOR,
  SEED_URL,
  SERIES_B_URL,
  seed,
  seedSearch,
  verified,
} from "./history-fixtures";

const { fundingRounds, historyPromotions } = schema;

async function historyRow(handle: Db) {
  const rows = await handle.select().from(fundingRounds).where(eq(fundingRounds.history, true));
  return rows;
}

async function checkSeedFreshness(handle: Db) {
  const [feed] = await handle.select({ id: fundingRounds.id }).from(fundingRounds).where(eq(fundingRounds.stage, "series_b"));
  const client = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
  await corroborateRecord(handle, client, feed.id, { broad: true, maxPages: 0 });
}

describe("promotion", () => {
  test("a requested company can verify a recent round as history instead of news", async () => {
    const handle = await testDb();
    const day = isoDaysAgo(5);
    const prior = { ...SEED_PRIOR, announced_date: day };
    const companyId = await seed(handle, [prior]);
    await handle.update(fundingRounds).set({ announcedOn: "2025-01-10" }).where(eq(fundingRounds.companyId, companyId));
    const key = `seed|$6 million|${day}`;
    await queueCompanyHistory(handle, companyId);
    const recentUrl = `https://techcrunch.com/${day.replaceAll("-", "/")}/footprint-raises-6m-seed-index-ventures`;
    const { reader: scripted } = reader({
      search: [{ url: recentUrl, title: "Footprint raises $6M seed led by Index Ventures", via: "search" }],
      pages: { [recentUrl]: [item(recentUrl, round({ announced_date: day }))] },
    });
    const plan = await planPromotion(handle, scripted, companyId, key, "request:recent", new Date(), true);
    expect(plan.skip).toBeNull();
    const reading = await readPlan(handle, scripted, plan);
    const result = await finishPromotion(handle, scripted, plan, reading, "request:recent", new Date(), true);
    expect(result.status).toBe("promoted");
    const [stored] = await handle
      .select()
      .from(fundingRounds)
      .where(eq(fundingRounds.id, result.roundId as string));
    expect(stored.history).toBe(true);
    expect(await enqueueDeliveries(handle, [stored.id], "series-a-b")).toBe(0);
  });

  test("a dossier's prior round with its own announcement becomes a verified history row, already seen", async () => {
    const handle = await testDb();
    const companyId = await seed(handle);
    expect(await queueCompanyHistory(handle, companyId)).toEqual([SEED_KEY]);
    const { reader: r, calls } = reader({ search: seedSearch, pages: { [SEED_URL]: [item(SEED_URL, round({}))] } });

    const out = await promotePrior(handle, r, companyId, SEED_KEY, "history:test");
    expect(out).toMatchObject({ status: "promoted", searched: true, sourced: true, ingested: true, merged: false });
    // The normal review rules decide: one source that confirmed the round is publish or flagged by its confidence.
    expect(["publish", "flagged"]).toContain(out.disposition);
    expect(calls).toMatchObject({ search: 1, map: 1, extract: 1, verify: 1 });
    expect(calls.queries[0]).toBe('"Footprint" Seed $6 million 2022 "Index" funding');
    // The map, the search, the page read at the rate card, and the read-back's 4.
    expect(out.credits).toBeGreaterThan(4);

    const [row] = await historyRow(handle);
    expect(row).toMatchObject({
      companyId,
      stage: "seed",
      announcedOn: "2022-08-03",
      status: "seen",
      disposition: out.disposition,
      history: true,
    });
    const [ledger] = await handle.select().from(historyPromotions);
    expect(ledger).toMatchObject({ status: "promoted", roundId: row.id, sourceUrl: SEED_URL, claimedBy: null });
    expect(ledger.credits).toBe(out.credits);
  });

  test("a prior round the check dropped for want of evidence is a lead: queued as check, searched, and promoted only when a page states it", async () => {
    const handle = await testDb();
    const companyId = await seed(handle, [], true, [
      { field: "prior_rounds", item: "Seed $6 million 2022-08-03", reason: "not confirmed on a second reading", prior: SEED_PRIOR },
      { field: "prior_rounds", item: "Venture debt $5 million 2025", reason: "not an equity round" },
    ]);
    await checkSeedFreshness(handle);
    expect(await historyTargets(handle)).toEqual([companyId]);
    expect(await queueCompanyHistory(handle, companyId)).toEqual([SEED_KEY]);
    const [ledger] = await handle.select().from(historyPromotions);
    expect(ledger).toMatchObject({ origin: "check", status: "pending", priorKey: SEED_KEY });
    const { reader: r } = reader({ search: seedSearch, pages: { [SEED_URL]: [item(SEED_URL, round({}))] } });
    const out = await promotePrior(handle, r, companyId, SEED_KEY, "history:test");
    expect(out.status).toBe("promoted");
    expect(await historyRow(handle)).toHaveLength(1);
  });

  test("an audit's lead needs no dossier: queued by fix-records, it is worked like any lead", async () => {
    const handle = await testDb();
    const companyId = await seed(handle, [], false);
    const fixes = await applyRecordFixes(
      handle,
      [
        {
          kind: "history_lead",
          company: companyId,
          stage_as_written: "Seed",
          amount_as_written: "$6 million",
          announced_date: "2022-08-03",
          lead_investors: ["Index Ventures"],
          evidence: SEED_URL,
          note: "the company's seed, missing from its history",
        },
      ],
      { apply: true },
    );
    expect(fixes).toMatchObject({ applied: 1, refused: 0 });
    expect(await historyTargets(handle)).toEqual([companyId]);
    expect(await queueCompanyHistory(handle, companyId)).toEqual([SEED_KEY]);
    const [ledger] = await handle.select().from(historyPromotions);
    expect(ledger).toMatchObject({ origin: "audit", status: "pending" });
    expect(ledger.prior.source_url).toBe(SEED_URL);
    // The page the audit named is read even when the search finds nothing.
    const { reader: r } = reader({ search: [], pages: { [SEED_URL]: [item(SEED_URL, round({}))] } });
    const out = await promotePrior(handle, r, companyId, SEED_KEY, "history:test");
    expect(out.status).toBe("promoted");
    // Queued twice, it is one lead.
    const again = await applyRecordFixes(
      handle,
      [
        {
          kind: "history_lead",
          company: companyId,
          stage_as_written: "Seed",
          amount_as_written: "$6 million",
          announced_date: "2022-08-03",
          lead_investors: ["Index Ventures"],
          evidence: SEED_URL,
          note: "again",
        },
      ],
      { apply: true },
    );
    expect(again).toMatchObject({ applied: 0, skipped: 1 });
  });

  test("a seed a stealth launch discloses beside its later round is a lead: queued as page, and promoted from that page", async () => {
    const handle = await testDb();
    const seedPrior = {
      stage_as_written: "Seed",
      amount_as_written: "$6 million",
      announced_date: null,
      lead_investors: ["Index Ventures"],
      source_url: SERIES_B_URL,
    };
    const b = record({
      company_name: "Footprint",
      company_key: "footprint",
      company_domain: "onefootprint.com",
      stage: "series_b",
      stage_as_written: "Series B",
      announced_date: isoDaysAgo(2),
      amount: { value: 40, currency: "USD", as_written: "$40M", usd_millions: 40, fx_rate: 1, fx_date: null },
      lead_investors: ["QED Investors"],
      sources: [{ url: SERIES_B_URL, host: "techcrunch.com", title: "Footprint comes out of stealth with a $40M Series B" }],
      confidence: 0.9,
      earlier_rounds: [seedPrior, { ...seedPrior, stage_as_written: "Series B", amount_as_written: "$40M" }],
    });
    await persistRecords(handle, [b], "series-a-b", "run-1");
    // The Series B itself is on the store, so only the seed joins the ledger; persisting again adds nothing.
    await persistRecords(handle, [b], "series-a-b", "run-2");
    const ledger = await handle.select().from(historyPromotions);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ origin: "page", status: "pending", priorKey: "seed|$6 million|" });
    const [{ companyId }] = await handle
      .select({ companyId: fundingRounds.companyId })
      .from(fundingRounds)
      .where(eq(fundingRounds.id, b.id));
    await handle.update(fundingRounds).set({ disposition: "publish" }).where(eq(fundingRounds.companyId, companyId));
    expect(await historyTargets(handle)).toEqual([companyId]);
    expect(await queueCompanyHistory(handle, companyId)).toEqual(["seed|$6 million|"]);
    // The launch page announces the Series B and discloses the seed; read for this lead, it keeps the seed.
    const onPage = (r: ReturnType<typeof round>) => ({
      ...item(SERIES_B_URL, r),
      source: { ...item(SERIES_B_URL, r).source, title: "Footprint comes out of stealth with a $40M Series B" },
    });
    const pages = {
      [SERIES_B_URL]: [
        onPage(
          round({
            round_type_as_written: "Series B",
            amount_as_written: "$40 million",
            lead_investors: ["QED Investors"],
            announced_date: isoDaysAgo(2),
            evidence_quote: "Footprint raised $40 million in a Series B led by QED Investors.",
          }),
        ),
        onPage(
          round({
            announced_date: null,
            is_background: true,
            evidence_quote: "Footprint raised $6 million in a seed round led by Index Ventures.",
          }),
        ),
      ],
    };
    const { reader: r } = reader({ search: [], pages });
    const out = await promotePrior(handle, r, companyId, "seed|$6 million|", "history:test");
    expect(out.status).toBe("promoted");
    const [history] = await historyRow(handle);
    expect(history).toMatchObject({ stage: "seed", amountAsWritten: "$6 million", companyId });
  });

  test("an audit's lead is worked when every round of the company was rejected; other leads wait for a visible round", async () => {
    const handle = await testDb();
    const companyId = await seed(handle, [], false);
    const lead = {
      kind: "history_lead" as const,
      company: companyId,
      stage_as_written: "Seed",
      amount_as_written: "$6 million",
      announced_date: "2022-08-03",
      lead_investors: ["Index Ventures"],
      evidence: SEED_URL,
      note: "the company's seed; its only row was a trend story's",
    };
    expect(await applyRecordFixes(handle, [lead], { apply: true })).toMatchObject({ applied: 1 });
    // The hand check rejects the one row the feed had, as it did Anthropic's.
    await handle.update(fundingRounds).set({ disposition: "rejected" }).where(eq(fundingRounds.companyId, companyId));
    expect(await historyTargets(handle)).toEqual([companyId]);
    // An Apollo lead alone does not bring back a company no one can see.
    await handle.update(historyPromotions).set({ origin: "apollo" });
    expect(await historyTargets(handle)).toEqual([]);
  });

  test("idempotent: a promoted round is never searched again, the dossier saved again queues nothing, and the backfill skips it", async () => {
    const handle = await testDb();
    const companyId = await seed(handle);
    await queueCompanyHistory(handle, companyId);
    const { reader: r } = reader({ search: seedSearch, pages: { [SEED_URL]: [item(SEED_URL, round({}))] } });
    await promotePrior(handle, r, companyId, SEED_KEY, "history:test");
    expect(await historyTargets(handle)).toEqual([]);

    const again = reader({ search: seedSearch, pages: { [SEED_URL]: [item(SEED_URL, round({}))] } });
    const second = await promotePrior(handle, again.reader, companyId, SEED_KEY, "history:other");
    expect(second).toMatchObject({ status: "skipped", reason: "done", credits: 0 });
    expect(again.calls.search).toBe(0);
    expect(await queueCompanyHistory(handle, companyId)).toEqual([]);
    expect(await historyRow(handle)).toHaveLength(1);
    const cov = await historyCoverage(handle);
    expect(cov).toMatchObject({ dossiers: 1, prior_rounds: 1, promoted: 1, unqueued: 0, history_rows: 1 });
  });

  test("a round already on the store merges into it by the existing rules: the feed row stays a feed row and is not marked updated", async () => {
    const handle = await testDb();
    const companyId = await seed(handle);
    // The lanes caught the seed back then; a reader has read it.
    const feedSeed = record({
      company_name: "Footprint",
      company_key: "footprint",
      company_domain: "onefootprint.com",
      stage: "seed",
      stage_as_written: "Seed",
      announced_date: "2022-08-04",
      amount: { value: 6, currency: "USD", as_written: "$6M", usd_millions: 6, fx_rate: 1, fx_date: null },
      lead_investors: ["Index Ventures"],
      sources: [{ url: "https://news.example/footprint-seed", host: "news.example" }],
    });
    await persistRecords(handle, [feedSeed], "series-a-b", "run-0");
    await handle
      .update(fundingRounds)
      .set({ firstSeenAt: new Date("2022-08-04T12:00:00Z"), history: false, hold: null })
      .where(eq(fundingRounds.id, feedSeed.id));
    await setStatus(handle, [feedSeed.id], "seen");
    await queueCompanyHistory(handle, companyId);
    const { reader: r } = reader({ search: seedSearch, pages: { [SEED_URL]: [item(SEED_URL, round({}))] } });

    const out = await promotePrior(handle, r, companyId, SEED_KEY, "history:test");
    expect(out).toMatchObject({ status: "promoted", merged: true, roundId: feedSeed.id });
    expect(await historyRow(handle)).toHaveLength(0);
    const [row] = await handle.select().from(fundingRounds).where(eq(fundingRounds.id, feedSeed.id));
    expect(row).toMatchObject({ history: false, status: "seen" });
    // The history reading's page joined the feed row's sources.
    const { rows } = await listRounds(handle, { ids: [feedSeed.id] });
    expect(rows[0].sources.map((s) => s.url)).toContain(SEED_URL);
  });

  test("a feed row folded into a history row makes the survivor a feed row with the feed row's read state", async () => {
    const handle = await testDb();
    const companyId = await seed(handle);
    await queueCompanyHistory(handle, companyId);
    const { reader: r } = reader({ search: seedSearch, pages: { [SEED_URL]: [item(SEED_URL, round({}))] } });
    await promotePrior(handle, r, companyId, SEED_KEY, "history:test");
    const [hist] = await historyRow(handle);
    // The same seed arrives later from a lane under another id (another day inside the dedupe window), unread.
    const late = record({
      company_name: "Footprint",
      company_key: "footprint",
      company_domain: "onefootprint.com",
      stage: "seed",
      stage_as_written: "Seed",
      announced_date: "2022-08-03",
      id: "footprint-inc:seed:2022-08-03",
      amount: { value: 6, currency: "USD", as_written: "$6M", usd_millions: 6, fx_rate: 1, fx_date: null },
    });
    await handle.insert(fundingRounds).values({
      id: late.id,
      companyId,
      presetSlug: "series-a-b",
      stage: "seed",
      stageAsWritten: "Seed",
      amountAsWritten: "$6M",
      amountValue: "6",
      amountCurrency: "USD",
      amountUsdMillions: "6",
      announcedOn: "2022-08-03",
      datePrecision: "day",
      confidence: "0.70",
      disposition: "flagged",
      status: "new",
    });
    await mergeDuplicateRounds(handle);
    const survivors = await handle.select().from(fundingRounds).where(eq(fundingRounds.stage, "seed"));
    expect(survivors).toHaveLength(1);
    // Whichever row survives, the round the lanes caught as news stays news: a feed row, unread.
    expect([hist.id, late.id]).toContain(survivors[0].id);
    expect(survivors[0]).toMatchObject({ history: false, status: "new" });
  });

  test("no source: nothing found, or pages that state another round, leave the round as dossier text", async () => {
    const handle = await testDb();
    const companyId = await seed(handle);
    await queueCompanyHistory(handle, companyId);
    // The search finds nothing; the page the dossier check cited for the round is still tried, and will not read.
    const none = reader({ search: [] });
    expect(await promotePrior(handle, none.reader, companyId, SEED_KEY, "history:test")).toMatchObject({
      status: "no_source",
      searched: true,
      sourced: false,
      reason: "no page states it",
    });
    expect(none.calls.extract).toBe(1);
    expect(none.calls.verify).toBe(0);
    expect(await historyRow(handle)).toHaveLength(0);

    // A second company whose only page is the Series B article recalling the seed as background.
    const handle2 = await testDb();
    const c2 = await seed(handle2);
    await queueCompanyHistory(handle2, c2);
    const recall = reader({
      search: [{ url: SERIES_B_URL, title: "Footprint raises $40M Series B", via: "search" }],
      pages: {
        [SERIES_B_URL]: [
          item(
            SERIES_B_URL,
            round({
              round_type_as_written: "Series B",
              amount_as_written: "$40 million",
              announced_date: "2025-01-10",
              lead_investors: ["QED Investors"],
              evidence_quote: "Footprint raised $40 million in a Series B.",
            }),
          ),
          item(SERIES_B_URL, round({ is_background: true, announced_date: null })),
        ],
      },
    });
    const out = await promotePrior(handle2, recall.reader, c2, SEED_KEY, "history:test");
    expect(out.status).toBe("no_source");
    expect(recall.calls.verify).toBe(0);
    const [ledger] = await handle2.select().from(historyPromotions);
    expect(ledger.status).toBe("no_source");
    expect(JSON.stringify(ledger.outcome)).toContain(SERIES_B_URL);
    expect(await historyRow(handle2)).toHaveLength(0);
  });

  test("an undated prior round is not dated from the company's own post unless the round's sentence states the day", async () => {
    const handle = await testDb();
    const undated = { ...SEED_PRIOR, announced_date: null };
    const companyId = await seed(handle, [undated]);
    const [key] = await queueCompanyHistory(handle, companyId);
    // A migrated blog: the post reads as published in 2026, the sentence gives no day.
    const blog = "https://onefootprint.com/blog/footprint-seed";
    const { reader: r, calls } = reader({
      search: [{ url: blog, title: "Footprint raises $6M seed led by Index Ventures", via: "search" }],
      pages: { [blog]: [{ ...item(blog, round({ announced_date: null })), page_date: "2026-04-22" }] },
    });
    const out = await promotePrior(handle, r, companyId, key, "history:test");
    expect(out.status).toBe("no_source");
    expect(calls.verify).toBe(0);
    const [ledger] = await handle.select().from(historyPromotions);
    expect(JSON.stringify(ledger.outcome)).toContain("undated round on the company's own site");
  });

  test("an own-site announcement with a day printed beside its headline dates an undated prior", async () => {
    const handle = await testDb();
    const undated = { ...SEED_PRIOR, announced_date: null };
    const companyId = await seed(handle, [undated]);
    const [key] = await queueCompanyHistory(handle, companyId);
    const url = "https://onefootprint.com/news/footprint-raises-seed";
    const { reader: r } = reader({
      search: [{ url, title: "Footprint raises $6M seed", via: "search" }],
      pages: {
        [url]: [{ ...item(url, round({ announced_date: null })), page_date: "2022-08-03", visible_article_date: true }],
      },
    });
    const out = await promotePrior(handle, r, companyId, key, "history:test");
    expect(out.status).toBe("promoted");
    const [promoted] = await historyRow(handle);
    expect(promoted.announcedOn).toBe("2022-08-03");
    expect(promoted.history).toBe(true);
  });

  test("a read-back that did not run is a failure on a backoff, never a row; past the last try it stays failed", async () => {
    const handle = await testDb();
    const companyId = await seed(handle);
    await queueCompanyHistory(handle, companyId);
    const broken = reader({ search: seedSearch, pages: { [SEED_URL]: [item(SEED_URL, round({}))] }, verify: verified("unverified") });
    const t0 = new Date();
    const out = await promotePrior(handle, broken.reader, companyId, SEED_KEY, "history:test", t0);
    expect(out).toMatchObject({ status: "failed", searched: true });
    expect(await historyRow(handle)).toHaveLength(0);
    let [ledger] = await handle.select().from(historyPromotions);
    expect(ledger).toMatchObject({ status: "failed", attempts: 1 });
    expect(ledger.nextAttemptAt.getTime() - t0.getTime()).toBe(3_600_000);
    expect(await nextHistoryRetry(handle, companyId)).toBe(ledger.nextAttemptAt.toISOString());
    // Not due inside its backoff.
    expect(await queueCompanyHistory(handle, companyId, t0)).toEqual([]);

    let at = t0;
    for (let i = 2; i <= HISTORY_MAX_ATTEMPTS; i++) {
      at = new Date(at.getTime() + 25 * 3_600_000);
      await promotePrior(handle, broken.reader, companyId, SEED_KEY, "history:test", at);
    }
    [ledger] = await handle.select().from(historyPromotions);
    expect(ledger).toMatchObject({ status: "failed", attempts: HISTORY_MAX_ATTEMPTS });
    expect(await nextHistoryRetry(handle, companyId)).toBeNull();
    expect(await queueCompanyHistory(handle, companyId, new Date(at.getTime() + 30 * 86_400_000))).toEqual([]);
  });

  test("a round another pass holds is left to it; a round inside the news window waits for the feed", async () => {
    const handle = await testDb();
    const companyId = await seed(handle, [
      SEED_PRIOR,
      { ...SEED_PRIOR, stage_as_written: "Series A", amount_as_written: "$13 million", announced_date: isoDaysAgo(3) },
    ]);
    const keys = await queueCompanyHistory(handle, companyId);
    expect(keys).toHaveLength(2);
    expect(await claimPrior(handle, companyId, SEED_KEY, "history:first")).toBe(true);
    const { reader: r, calls } = reader({ search: seedSearch, pages: { [SEED_URL]: [item(SEED_URL, round({}))] } });
    expect(await promotePrior(handle, r, companyId, SEED_KEY, "history:second")).toMatchObject({ status: "skipped", reason: "claimed" });
    expect(calls.search).toBe(0);

    const recent = await promotePrior(handle, r, companyId, keys[1], "history:second");
    expect(recent).toMatchObject({ status: "deferred", credits: 0 });
    const [row] = await handle.select().from(historyPromotions).where(eq(historyPromotions.priorKey, keys[1]));
    expect(row.status).toBe("pending");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 3 * 86_400_000);
  });

  test("a vague prior round is written skipped and never searched; an unchecked dossier queues nothing", async () => {
    const handle = await testDb();
    const companyId = await seed(handle, [
      { stage_as_written: "Strategic investment", amount_as_written: null, announced_date: "2025", lead_investors: [] },
    ]);
    expect(await queueCompanyHistory(handle, companyId)).toEqual([]);
    const [row] = await handle.select().from(historyPromotions);
    expect(row.status).toBe("skipped");
    expect(await historyTargets(handle)).toEqual([]);

    const h2 = await testDb();
    const c2 = await seed(h2, [SEED_PRIOR], false);
    expect(await queueCompanyHistory(h2, c2)).toEqual([]);
    expect(await historyTargets(h2)).toEqual([]);
  });
});

/** A store with one promoted history row, for the exclusion checks. */
async function promoted(): Promise<{ handle: Db; companyId: string; id: string }> {
  const handle = await testDb();
  const companyId = await seed(handle);
  await checkSeedFreshness(handle);
  await queueCompanyHistory(handle, companyId);
  const { reader: r } = reader({ search: seedSearch, pages: { [SEED_URL]: [item(SEED_URL, round({}))] } });
  const out = await promotePrior(handle, r, companyId, SEED_KEY, "history:test");
  if (!out.roundId) throw new Error("not promoted");
  return { handle, companyId, id: out.roundId };
}

describe("what a history row is kept out of", () => {
  test("deliveries: never queued, and an outbox row for one is dead-lettered unsent", async () => {
    const { handle, id } = await promoted();
    const target = await createTarget(handle, { channel: "webhook", target: "https://hooks.example.test/funding", minConfidence: 0.1 });
    expect(await enqueueDeliveries(handle, [id], "series-a-b")).toBe(0);
    await handle.insert(schema.deliveries).values({ roundId: id, target: target.id, channel: "webhook" });
    let sent = 0;
    const fetchOk: typeof fetch = async () => {
      sent++;
      return new Response("ok");
    };
    const summary = await flushDeliveries(handle, "https://app.test", fetchOk);
    expect(sent).toBe(0);
    expect(summary.deadLettered).toBe(1);
    const [row] = await handle.select().from(schema.deliveries);
    expect(row.lastError).toBe("history round: never delivered");
  });

  test("unread: never new or updated, whatever marks it", async () => {
    const { handle, id } = await promoted();
    expect(await setStatus(handle, [id], "new")).toBe(0);
    const { rows } = await listRounds(handle, { ids: [id] });
    expect(rows[0]).toMatchObject({ status: "seen", history: true });
    // A second history reading with a new amount changes the row and still leaves it seen.
    const [row] = await handle.select().from(fundingRounds).where(eq(fundingRounds.id, id));
    const again = record({
      id,
      company_name: "Footprint",
      company_key: "footprint",
      company_domain: "onefootprint.com",
      stage: "seed",
      stage_as_written: "Seed",
      announced_date: row.announcedOn,
      amount: { value: 6.2, currency: "USD", as_written: "$6.2M", usd_millions: 6.2, fx_rate: 1, fx_date: null },
    });
    await persistRecords(handle, [again], "series-a-b", "history:again", { history: true, companyId: row.companyId });
    const [after] = await handle.select().from(fundingRounds).where(eq(fundingRounds.id, id));
    expect(after.status).toBe("seen");
  });

  test("Trending: never followed and never ranked, even first seen today", async () => {
    const { handle, id } = await promoted();
    // Even at a recent date a history row is not news.
    await handle
      .update(fundingRounds)
      .set({ announcedOn: isoDaysAgo(1) })
      .where(eq(fundingRounds.id, id));
    const followed = await followRounds(handle, new Date());
    expect(followed.map((r) => r.roundId)).not.toContain(id);
    await handle.insert(schema.trendingRounds).values({ roundId: id, companyId: "x", firstSeenAt: new Date(), score: 99, stale: false });
    expect(await trendingRoundIds(handle, new Date())).not.toContain(id);
  });

  test("the week's numbers: a history row is never counted, whatever its date", async () => {
    const { handle, id } = await promoted();
    const before = await overview(handle, 7);
    const beforeDemo = await demoStats(handle);
    await handle
      .update(fundingRounds)
      .set({ announcedOn: isoDaysAgo(1) })
      .where(eq(fundingRounds.id, id));
    const after = await overview(handle, 7);
    expect(after.rounds).toBe(before.rounds);
    expect(after.new_rounds).toBe(before.new_rounds);
    expect(after.total_usd_millions).toBe(before.total_usd_millions);
    expect((await demoStats(handle)).rounds_7d).toBe(beforeDemo.rounds_7d);
  });

  test("the default feed: left out of Latest unless the reader asks for dates or a company", async () => {
    const { handle, id } = await promoted();
    const latest = await listRounds(handle, { history: feedHistory({}) });
    expect(latest.rows.map((r) => r.id)).not.toContain(id);
    expect(await countRounds(handle, { history: feedHistory({}) })).toBe(1);
    const dated = await listRounds(handle, {
      since: "2022-01-01",
      until: "2022-12-31",
      history: feedHistory({ since: "2022-01-01", until: "2022-12-31" }),
    });
    expect(dated.rows.map((r) => r.id)).toEqual([id]);
    expect(feedHistory({ company: "onefootprint.com" })).toBeUndefined();
  });
});

describe("what a history row joins", () => {
  test("the company page lists it latest first and counts it in the total raised; the investor page lists it", async () => {
    const { handle, companyId, id } = await promoted();
    const page = await getCompany(handle, companyId);
    expect(page?.rounds.map((r) => r.stage)).toEqual(["series_b", "seed"]);
    expect(page?.rounds.find((r) => r.id === id)?.history).toBe(true);
    expect(page?.totals).toMatchObject({ rounds: 2, usd_millions_raised: 46 });
    const [lead] = await handle
      .select({ investorId: schema.roundInvestors.investorId })
      .from(schema.roundInvestors)
      .where(eq(schema.roundInvestors.roundId, id));
    const investor = await getInvestor(handle, lead.investorId);
    expect(investor?.rounds.map((r) => r.id)).toContain(id);
  });
});

describe("the backfill's bookkeeping", () => {
  test("params: defaults, bounds, and an error that names the bad one", () => {
    expect(parseHistoryBackfillParams({})).toEqual({ limit: null, ...HISTORY_BACKFILL_DEFAULTS });
    expect(parseHistoryBackfillParams({ limit: "10", concurrency: 2, maxTotalCredits: "500" })).toEqual({
      limit: 10,
      concurrency: 2,
      maxTotalCredits: 500,
    });
    for (const [k, v] of [
      ["limit", 0],
      ["concurrency", 101],
      ["maxTotalCredits", -1],
      ["limit", "abc"],
    ] as const) {
      const out = parseHistoryBackfillParams({ [k]: v });
      expect("error" in out && out.error).toContain(k);
    }
  });

  test("the tally counts each outcome once and adds the credits", () => {
    const base = { companyId: "a", priorKey: "k", searched: true, sourced: true, ingested: true, merged: false, roundId: "r", credits: 20 };
    let t = emptyHistoryTally();
    t = tallyPromotion(t, { ...base, status: "promoted", disposition: "publish" });
    t = tallyPromotion(t, { ...base, status: "promoted", disposition: "review", merged: true });
    t = tallyPromotion(t, { ...base, status: "no_source", sourced: false, ingested: false, disposition: null, roundId: null, credits: 3 });
    t = tallyPromotion(t, {
      ...base,
      status: "failed",
      sourced: false,
      ingested: false,
      disposition: null,
      roundId: null,
      credits: 0,
      searched: false,
    });
    expect(t).toMatchObject({
      prior_rounds: 4,
      searched: 3,
      sourced: 2,
      ingested: 2,
      published: 1,
      review: 1,
      merged: 1,
      no_source: 1,
      failed: 1,
      credits: 43,
    });
    expect(addTallies(t, t).credits).toBe(86);
  });
});

describe("ruledOutPriors", () => {
  test("a vague prior, or one with no amount and no page found, is ruled out; one with an amount stays", async () => {
    const handle = await testDb();
    await persistRecords(handle, [record({ company_name: "Heidi", company_key: "heidi" })], "series-a-b", "run-1");
    const prior = (stage: string, amount: string | null, date: string) => ({
      stage_as_written: stage,
      amount_as_written: amount,
      announced_date: date,
      lead_investors: [],
    });
    await handle.insert(historyPromotions).values([
      { companyId: "heidi", priorKey: "seed", prior: prior("Seed", "$5 million", "2021"), status: "no_source" },
      { companyId: "heidi", priorKey: "series-c", prior: prior("Series C", null, "2023-01-23"), status: "no_source" },
      { companyId: "heidi", priorKey: "investment", prior: prior("Investment", null, "2021"), status: "skipped" },
      { companyId: "heidi", priorKey: "series-a", prior: prior("Series A", "$10 million", "2023-10"), status: "promoted" },
    ]);
    expect([...(await ruledOutPriors(handle, "heidi"))].sort()).toEqual(["investment", "series-c"]);
  });
});
