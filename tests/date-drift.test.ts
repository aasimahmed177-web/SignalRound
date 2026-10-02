// Dates only move earlier, and a person's fix stays fixed. Shaped like two rows from the 2026-09-25
// store audit: W4 Games' Aug 25 Series B, moved to a Business Wire redistribution URL-dated Sep 18 and
// then to the Sep 21 the read-back found on it; bluecore-energy, hand-fixed to Sep 8 and back at a trade
// republication's Sep 22 a day later.

import type { FeedRecord } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { keepsStoredDay, mergeDuplicateRounds, neverLater, persistRecords } from "../lib/persist";
import { applyRecordFixes, type RecordFix } from "../lib/repair";
import { record, testDb } from "./helpers";

const usd = (m: number, day: string) => ({
  value: m,
  currency: "USD",
  as_written: `$${m} million`,
  usd_millions: m,
  fx_rate: 1,
  fx_date: day,
});
const W4_RELEASE = "https://www.w4games.com/blog/w4-games-news-1/w4-games-raises-18-million-to-accelerate-international-presence-193";
const W4_WIRE =
  "https://www.businesswire.com/news/home/20260918614118/en/W4-Games-Raises-%2418-Million-to-Accelerate-International-Presence";

function w4(partial: Partial<FeedRecord>): FeedRecord {
  return record({
    company_name: "W4 Games",
    company_key: "w4 games",
    company_domain: "w4games.com",
    id: "w4-games:series_b:2026-08-26",
    stage: "series_b",
    stage_as_written: "Series B",
    amount: usd(18, "2026-08-25"),
    lead_investors: ["Tencent"],
    ...partial,
  });
}

async function row(db: Db, id: string) {
  const [r] = await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, id));
  return r;
}

describe("a later reading never moves a dated day later", () => {
  test("neverLater: a day with a basis, or a list's week or month, holds against any later day; a search result's day yields", () => {
    const aug25 = { announcedOn: "2026-08-25", datePrecision: "day", dateBasis: "page" };
    expect(neverLater(aug25, "2026-09-18")).toBe(true);
    expect(neverLater({ ...aug25, dateBasis: "stated" }, "2026-09-21")).toBe(true);
    expect(neverLater({ ...aug25, dateBasis: null }, "2026-09-21")).toBe(true);
    expect(neverLater(aug25, "2026-08-20")).toBe(false);
    expect(neverLater({ ...aug25, dateBasis: "result" }, "2026-09-18")).toBe(false);
    // A list's week or month is an upper bound: a later day is a later page's.
    expect(neverLater({ ...aug25, datePrecision: "week" }, "2026-09-18")).toBe(true);
    expect(neverLater({ ...aug25, datePrecision: "week" }, "2026-08-20")).toBe(false);
    expect(neverLater({ announcedOn: "2026-07-01", datePrecision: "month", dateBasis: "page" }, "2026-07-31")).toBe(false);
    expect(neverLater({ announcedOn: "2026-07-01", datePrecision: "month", dateBasis: "page" }, "2026-08-01")).toBe(true);
    // A stated later day no longer beats a byline's earlier one.
    expect(keepsStoredDay(aug25, { announced_date: "2026-09-21", date_precision: "day", date_basis: "stated" })).toBe(true);
  });

  test("W4 Games: a redistribution's URL day, then the read-back's stated day on it, leave Aug 25 alone", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [
        w4({
          announced_date: "2026-08-25",
          date_basis: "page",
          sources: [{ url: W4_RELEASE, host: "w4games.com", published: "2026-08-25" }],
        }),
      ],
      "series-a-b",
      "run-1",
    );
    // The sweep reads the Business Wire copy (URL-dated Sep 18) and joins it to the row.
    await persistRecords(
      db,
      [
        w4({
          id: "w4-games:series_b:2026-09-18",
          announced_date: "2026-09-18",
          date_basis: "url",
          sources: [{ url: W4_WIRE, host: "businesswire.com" }],
        }),
      ],
      "series-a-b",
      "run-2",
    );
    expect(await row(db, "w4-games:series_b:2026-08-26")).toMatchObject({ announcedOn: "2026-08-25", dateBasis: "page" });
    // The read-back takes the wire copy as primary and reads "September 21" off it as stated.
    await persistRecords(
      db,
      [
        w4({
          announced_date: "2026-09-21",
          date_basis: "stated",
          verification: { status: "corrected", notes: ["date 2026-09-18 (day) read as 2026-09-21 (day, businesswire.com)"], url: W4_WIRE },
          sources: [{ url: W4_WIRE, host: "businesswire.com" }],
        }),
      ],
      "series-a-b",
      "reconcile",
    );
    expect(await row(db, "w4-games:series_b:2026-08-26")).toMatchObject({ announcedOn: "2026-08-25", datePrecision: "day" });
  });

  test("a merge keeps the earlier dated day over a later stated one", async () => {
    const db = await testDb();
    // Two rows one batch wrote apart, merged by the post-write pass: the survivor keeps Aug 25.
    await persistRecords(
      db,
      [
        w4({ id: "w4-games:series_b:2026-09-21", announced_date: "2026-09-21", date_basis: "stated", confidence: 0.95 }),
        w4({ id: "w4-games:series_b:2026-08-25", announced_date: "2026-08-25", date_basis: "page", confidence: 0.6 }),
      ],
      "series-a-b",
      "run-1",
    );
    expect((await mergeDuplicateRounds(db)).merged).toBe(0);
    const rows = await db.select().from(schema.fundingRounds);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ announcedOn: "2026-08-25" });
  });
});

describe("a fix-records day and stage are pinned", () => {
  const BLUECORE = "bluecore-energy:pre_seed:2026-08-29";
  const TECHCRUNCH = "https://techcrunch.com/2026/09/08/nuclear-startup-bluecore-energy-raises-50m-seed-round-just-two-months-after-launch";
  const bluecore = (partial: Partial<FeedRecord>) =>
    record({
      company_name: "Bluecore Energy",
      company_key: "bluecore energy",
      company_domain: "bluecore.energy",
      id: BLUECORE,
      stage: "pre_seed",
      stage_as_written: "pre-seed",
      amount: usd(50, "2026-08-29"),
      ...partial,
    });
  const fixes: RecordFix[] = [
    {
      kind: "redate",
      round: BLUECORE,
      from: "2026-08-29",
      announced_on: "2026-09-08",
      basis: "url",
      evidence: { url: TECHCRUNCH, title: "Nuclear startup Bluecore Energy raises $50M seed round", published: "2026-09-08" },
      note: "announced September 8 (TechCrunch)",
    },
    {
      kind: "restage",
      round: BLUECORE,
      from: "pre_seed",
      stage: "seed",
      stage_as_written: "seed",
      evidence: TECHCRUNCH,
      note: "a $50M seed",
    },
  ];

  test("bluecore-energy: a trade republication's Sep 22 and a pre-seed label move neither the day nor the stage", async () => {
    const db = await testDb();
    await persistRecords(db, [bluecore({ announced_date: "2026-08-29", date_basis: "page" })], "seed", "run-1");
    const applied = await applyRecordFixes(db, fixes, { apply: true });
    expect(applied.refused).toBe(0);
    expect(await row(db, BLUECORE)).toMatchObject({
      announcedOn: "2026-09-08",
      stage: "seed",
      pinned: { announced_on: "2026-09-08", stage: "seed" },
    });
    // The republication, read the next night, and an earlier mention: the day and the stage stand.
    for (const day of ["2026-09-22", "2026-08-29"])
      await persistRecords(
        db,
        [
          bluecore({
            announced_date: day,
            date_basis: "stated",
            sources: [{ url: `https://www.ajot.com/news/bluecore-${day}`, host: "ajot.com" }],
          }),
        ],
        "seed",
        `run-${day}`,
      );
    expect(await row(db, BLUECORE)).toMatchObject({ announcedOn: "2026-09-08", dateBasis: "url", stage: "seed", stageAsWritten: "seed" });
  });

  test("a fix applied before pins existed is pinned when the file runs again, and only once", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [bluecore({ announced_date: "2026-09-08", date_basis: "url", stage: "seed", stage_as_written: "seed" })],
      "seed",
      "run-1",
    );
    await db.insert(schema.sources).values({ id: TECHCRUNCH, url: TECHCRUNCH, host: "techcrunch.com" }).onConflictDoNothing();
    await db.insert(schema.roundSources).values({ roundId: BLUECORE, sourceId: TECHCRUNCH }).onConflictDoNothing();
    const first = await applyRecordFixes(db, fixes, { apply: true });
    expect(first.lines.filter((l) => l.startsWith("pin "))).toHaveLength(2);
    expect((await row(db, BLUECORE))?.pinned).toEqual({ announced_on: "2026-09-08", stage: "seed" });
    const again = await applyRecordFixes(db, fixes, { apply: true });
    expect(again).toMatchObject({ applied: 0, skipped: 2 });
  });
});
