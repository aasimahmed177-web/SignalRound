// The late re-report hold (lib/late-report.ts), shaped like Assort Health on 2026-09-25: a paywalled
// SF Business Times profile dated Sep 25 read as "$120M funding", stage other, page-dated; Apollo had
// listed the $120M Series C for 2026-06 four seconds before the Slack post.

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { saveDossier } from "../lib/deepdive";
import { enqueueDeliveries, flushDeliveries } from "../lib/delivery";
import { holdLateReports, lateReportLead, participantReport, type RoundLead } from "../lib/late-report";
import { listRounds, persistRecords, setDisposition } from "../lib/persist";
import { createTarget } from "../lib/settings";
import { record, testDb } from "./helpers";
import { dossier } from "./history-fixtures";

const PROFILE = "https://www.bizjournals.com/sanfrancisco/news/2026/09/25/executive-profile-assort-ceo-jon-wang.html";
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const monthOf = (day: string) => day.slice(0, 7);

function profileRow(announced = today()) {
  return record({
    company_name: "Assort Health",
    company_key: "assort health",
    company_domain: "assorthealth.com",
    stage: "other",
    stage_as_written: "funding",
    announced_date: announced,
    date_basis: "page",
    amount: { value: 120, currency: "USD", as_written: "$120 million", usd_millions: 120, fx_rate: 1, fx_date: announced },
    confidence: 0.9,
    sources: [{ url: PROFILE, host: "bizjournals.com" }],
  });
}

async function apolloSays(
  handle: Awaited<ReturnType<typeof testDb>>,
  events: Array<{ type: string; amount: string | null; date: string | null }>,
) {
  await handle.insert(schema.enrichments).values({
    companyId: "assorthealth.com",
    kind: "apollo",
    data: { company_key: "assort health", apollo: { status: "matched", funding_events: events.map((e) => ({ ...e, source_url: null })) } },
  });
}

async function row(handle: Awaited<ReturnType<typeof testDb>>, id: string) {
  const [r] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, id));
  return r;
}

describe("lateReportLead", () => {
  const assort = { id: "a", stage: "other", announcedOn: "2026-09-25", dateBasis: "page", amountUsdMillions: 120, history: false };
  const apollo: RoundLead = { stage: "series_c", usdMillions: 120, date: "2026-06", origin: "Apollo", label: "Series C $120M" };

  test("the same figure in a month more than 45 days before a borrowed day holds the row", () => {
    expect(lateReportLead(assort, [apollo])).toBe(apollo);
    // The end of the lead's month is what counts: August's events are within 45 days of Sep 25.
    expect(lateReportLead(assort, [{ ...apollo, date: "2026-08" }])).toBeNull();
    expect(lateReportLead(assort, [{ ...apollo, date: "2026-08-09" }])?.date).toBe("2026-08-09");
  });

  test("another figure, another stage family, too far back, or a history row is no re-report", () => {
    expect(lateReportLead(assort, [{ ...apollo, usdMillions: 76 }])).toBeNull();
    expect(lateReportLead({ ...assort, stage: "series_a" }, [apollo])).toBeNull();
    // Series C and Series D sit in one family: a provider's label for the round the store files otherwise.
    expect(lateReportLead({ ...assort, stage: "series_d_plus" }, [apollo])).toBe(apollo);
    expect(lateReportLead(assort, [{ ...apollo, date: "2022-01" }])).toBeNull();
    expect(lateReportLead({ ...assort, history: true }, [apollo])).toBeNull();
    expect(lateReportLead({ ...assort, amountUsdMillions: null }, [apollo])).toBeNull();
  });

  test("a stated day yields only to a stored round whose own day is stated", () => {
    const stated = { ...assort, dateBasis: "stated" };
    expect(lateReportLead(stated, [apollo])).toBeNull();
    const release: RoundLead = { ...apollo, date: "2026-06-24", origin: "round assort-health:series_c:2026-06-24", stated: true };
    expect(lateReportLead(stated, [release])).toBe(release);
  });
});

test("a PhysicsX investor's stated $25m participation is not a new $25m Series C", async () => {
  const db = await testDb();
  const participant = record({
    company_name: "PhysicsX",
    company_key: "physicsx",
    company_domain: "physicsx.ai",
    stage: "series_c",
    stage_as_written: "Series C",
    announced_date: "2026-07-30",
    date_basis: "page",
    amount: { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null },
    sources: [
      {
        url: "https://www.british-business-bank.co.uk/news-and-events/news/british-business-bank-invests-25m-investment-physicsx-including-fourth-investment-british-growth",
        host: "british-business-bank.co.uk",
        evidence:
          "The British Business Bank has invested $25m into PhysicsX, the physics AI company for industrials, as part of its Series C financing.",
      },
    ],
  });
  expect(participantReport(participant.sources[0].evidence ?? "", "Series C")).toBe(true);
  expect(participantReport(participant.sources[0].evidence ?? "", "Series B")).toBe(false);
  await persistRecords(db, [participant], "growth", "physicsx-test");
  expect((await row(db, participant.id))?.hold).toMatch(/^held: Series C appears as a participant/);
  expect(await enqueueDeliveries(db, [participant.id], "growth")).toBe(0);
  const original = "https://www.physicsx.ai/newsroom/physicsx-announces-300m-series-c-to-accelerate-physics-ai-for-industrial-engineering";
  let searched = false;
  await holdLateReports(db, [(await row(db, participant.id))?.companyId ?? "physicsx.ai"], {
    searchOriginal: async () => {
      searched = true;
      return {
        stage: "series_c",
        usdMillions: 300,
        date: "2026-06-08",
        origin: "the original announcement",
        label: "Series C $300 million",
        stated: true,
        sourceUrl: original,
        amount: { value: 300, currency: "USD", as_written: "$300 million", usd_millions: 300, fx_rate: 1, fx_date: "2026-06-08" },
        evidence: "PhysicsX today announced an oversubscribed $300 million Series C financing.",
      };
    },
  });
  expect(searched).toBe(true);
  const stored = await row(db, participant.id);
  expect(stored).toMatchObject({ history: true, announcedOn: "2026-06-08", amountUsdMillions: "300.000", disposition: "review" });
  expect(await enqueueDeliveries(db, [participant.id], "growth")).toBe(0);
});

test("an original announcement never moves a reviewer-pinned day", async () => {
  const db = await testDb();
  const participant = record({
    company_name: "PhysicsX",
    company_key: "physicsx",
    stage: "series_c",
    stage_as_written: "Series C",
    announced_date: "2026-07-30",
    sources: [{ url: PROFILE, host: "bizjournals.com", evidence: "An investor joins the Series C for PhysicsX." }],
  });
  await persistRecords(db, [participant], "growth", "pinned-test");
  await db
    .update(schema.fundingRounds)
    .set({ pinned: { announced_on: "2026-07-30" } })
    .where(eq(schema.fundingRounds.id, participant.id));
  await holdLateReports(db, [(await row(db, participant.id))?.companyId ?? "physicsx"], {
    searchOriginal: async () => ({
      stage: "series_c",
      usdMillions: 300,
      date: "2026-06-08",
      origin: "the original announcement",
      label: "Series C $300 million",
      stated: true,
      sourceUrl: "https://physicsx.ai/newsroom/series-c",
    }),
  });
  expect(await row(db, participant.id)).toMatchObject({ history: true, announcedOn: "2026-07-30", pinned: { announced_on: "2026-07-30" } });
});

describe("holding a late re-report", () => {
  test("a row the store's Apollo events show is old goes to review, never delivered, with the reason on it", async () => {
    const db = await testDb();
    await createTarget(db, { channel: "slack", target: "https://hooks.slack.test/abc", minConfidence: 0.5 });
    // Apollo already read for this company (an earlier round): the persist path holds the row as it lands.
    await persistRecords(
      db,
      [
        record({
          ...profileRow(daysAgo(400)),
          stage: "series_b",
          stage_as_written: "Series B",
          amount: { value: 76, currency: "USD", as_written: "$76 million", usd_millions: 76, fx_rate: 1, fx_date: daysAgo(400) },
          date_basis: "stated",
        }),
      ],
      "growth",
      "run-0",
    );
    await apolloSays(db, [{ type: "Series C", amount: "$120M", date: monthOf(daysAgo(93)) }]);
    const fresh = profileRow();
    await persistRecords(db, [fresh], "growth", "run-1");
    const held = await row(db, fresh.id);
    expect(held?.disposition).toBe("review");
    expect(held?.hold).toMatch(/^held: Apollo reports Series C \$120M dated \d{4}-\d{2}, more than 45 days before this row's/);
    expect((held?.verification as { notes: string[] } | undefined)?.notes).toContain(held?.hold);
    expect(await enqueueDeliveries(db, [fresh.id], "growth")).toBe(0);

    // A later reading of the same page does not move it back out of review, and keeps the reason in its notes.
    await persistRecords(
      db,
      [{ ...fresh, verification: { status: "confirmed", notes: ["sources agree"], url: PROFILE } }],
      "growth",
      "run-2",
    );
    const again = await row(db, fresh.id);
    expect(again?.disposition).toBe("review");
    expect((again?.verification as { notes: string[] } | undefined)?.notes).toEqual([
      "sources agree",
      "held for review: earliest-report search pending",
      again?.hold,
    ]);

    // A person who publishes it lifts the hold.
    await setDisposition(db, fresh.id, "publish");
    expect((await row(db, fresh.id))?.hold).toBeNull();
  });

  test("Apollo read after the row landed, in the same sweep, holds it before the deliver step", async () => {
    const db = await testDb();
    const fresh = profileRow();
    await persistRecords(db, [fresh], "growth", "run-1");
    expect((await row(db, fresh.id))?.disposition).toBe("review");
    await apolloSays(db, [{ type: "Series C", amount: "$120M", date: monthOf(daysAgo(93)) }]);
    // What apolloBatch runs once it has stored the company's events.
    expect(await holdLateReports(db, ["assorthealth.com"])).toEqual([fresh.id]);
    expect((await row(db, fresh.id))?.disposition).toBe("review");
    const { rows } = await listRounds(db, { includeReview: false });
    expect(rows.map((r) => r.id)).not.toContain(fresh.id);
  });

  test("a lead that arrives after the row went out flags it and nothing more is sent", async () => {
    const db = await testDb();
    await createTarget(db, { channel: "slack", target: "https://hooks.slack.test/abc", minConfidence: 0.5 });
    const fresh = profileRow();
    await persistRecords(db, [fresh], "growth", "run-1");
    await setDisposition(db, fresh.id, "publish");
    expect(await enqueueDeliveries(db, [fresh.id], "growth")).toBe(1);
    const ok: typeof fetch = async () => new Response("ok");
    expect((await flushDeliveries(db, "https://app.test", ok)).sent).toBe(1);

    // The dossier, written at the end of the tick, lists the Series C in June.
    await saveDossier(
      db,
      "assorthealth.com",
      dossier([
        {
          stage_as_written: "Series C",
          amount_as_written: "$120 million",
          announced_date: daysAgo(93),
          lead_investors: ["Menlo Ventures"],
        },
      ]),
      null,
    );
    const held = await row(db, fresh.id);
    expect(held?.disposition).toBe("flagged");
    expect(held?.hold).toMatch(/^held: the company dossier reports Series C \$120 million/);

    // A second target added later, or a re-queue: never sent again.
    await createTarget(db, { channel: "webhook", target: "https://hooks.example.test/f", minConfidence: 0.5 });
    expect(await enqueueDeliveries(db, [fresh.id], "growth")).toBe(0);
    const [target] = await db.select().from(schema.deliveryTargets).where(eq(schema.deliveryTargets.channel, "webhook"));
    await db.insert(schema.deliveries).values({ roundId: fresh.id, channel: "webhook", target: target?.id as string });
    const calls: string[] = [];
    const spy: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response("ok");
    };
    expect(await flushDeliveries(db, "https://app.test", spy)).toEqual({ sent: 0, failed: 0, deadLettered: 1 });
    expect(calls).toEqual([]);
  });
});
