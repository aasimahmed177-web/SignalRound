// Merge tombstones (round_merges): every merge path writes one, a reading that rebuilds a dropped id
// lands on the survivor, a dropped id is never delivered, and the seed reads the operator's logs.
// Shaped like Fearn on 2026-09-25: merged at 06:05 UTC, rebuilt by another preset's sweep at 15:01,
// and posted to the same Slack channel a second time.

import type { FeedRecord } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { enqueueDeliveries, flushDeliveries } from "../lib/delivery";
import { mergeDuplicateRounds, persistRecords, recordTombstone, tombstoneTargets } from "../lib/persist";
import { applyRecordFixes } from "../lib/repair";
import { createTarget } from "../lib/settings";
import { backupSources, parseAppliedMerges, parseCsv, parseMergeFixes, seedTombstones } from "../lib/tombstone-seed";
import { record, testDb } from "./helpers";

const DIGEST = "https://www.bizjournals.com/sanfrancisco/news/2026/09/24/sfbt-digest-thursday-databricks-uc-berkeley.html";
const usd = (m: number, day: string) => ({
  value: m,
  currency: "USD",
  as_written: `$${m} million`,
  usd_millions: m,
  fx_rate: 1,
  fx_date: day,
});

function seedRow(): FeedRecord {
  return record({
    company_name: "Fearn",
    company_key: "fearn",
    company_domain: "fearn.ai",
    id: "fearn:seed:2026-09-23",
    stage: "seed",
    stage_as_written: "seed",
    announced_date: "2026-06-10",
    date_basis: "stated",
    amount: usd(5.5, "2026-06-10"),
    confidence: 0.95,
    sources: [{ url: "https://www.prnewswire.com/news-releases/fearn-seed-302796012.html", host: "prnewswire.com" }],
  });
}

/** The digest's copy as the rule would not join it (another figure), so only a forced merge takes it. */
function digestCopy(amount = 5.5): FeedRecord {
  return record({
    company_name: "Fearn",
    company_key: "fearn",
    company_domain: "fearn.ai",
    id: "fearn:other:2026-09-24",
    stage: "other",
    stage_as_written: "funding round",
    announced_date: "2026-09-24",
    date_basis: "page",
    amount: usd(amount, "2026-09-24"),
    confidence: 0.84,
    sources: [{ url: DIGEST, host: "bizjournals.com" }],
  });
}

async function ids(db: Db): Promise<string[]> {
  return (await db.select({ id: schema.fundingRounds.id }).from(schema.fundingRounds)).map((r) => r.id).sort();
}

async function tombstones(db: Db): Promise<Array<{ droppedId: string; keptId: string }>> {
  return db.select({ droppedId: schema.roundMerges.droppedId, keptId: schema.roundMerges.keptId }).from(schema.roundMerges);
}

describe("round merge tombstones", () => {
  test("a forced merge (fix-records) writes one, and the rebuilt id lands on the survivor", async () => {
    const db = await testDb();
    await persistRecords(db, [seedRow()], "seed", "run-1");
    await persistRecords(db, [digestCopy(9)], "seed", "run-2");
    expect(await ids(db)).toEqual(["fearn:other:2026-09-24", "fearn:seed:2026-09-23"]);

    const fixed = await applyRecordFixes(db, [{ kind: "merge", keep: "fearn:seed:2026-09-23", drop: "fearn:other:2026-09-24" }], {
      apply: true,
    });
    expect(fixed.lines.join("\n")).toContain("tombstone: round_merges fearn:other:2026-09-24 -> fearn:seed:2026-09-23");
    expect(await tombstones(db)).toEqual([{ droppedId: "fearn:other:2026-09-24", keptId: "fearn:seed:2026-09-23" }]);

    // Another preset's sweep reads the digest again: same id, and nothing the dedupe rule would join.
    const summary = await persistRecords(db, [digestCopy(9)], "series-a-b", "run-3");
    expect(summary.inserted).toBe(0);
    expect(summary.insertedIds).toEqual([]);
    expect(summary.persistedIds).toEqual(["fearn:seed:2026-09-23"]);
    expect(await ids(db)).toEqual(["fearn:seed:2026-09-23"]);
  });

  test("mergeDuplicateRounds writes one per merge, and chains resolve to the last survivor", async () => {
    const db = await testDb();
    // One batch holding two readings the rule joins (same stage and figure inside 45 days): both are
    // written, and the post-write pass merges them.
    const copy = record({ ...seedRow(), id: "fearn:seed:2026-07-01", announced_date: "2026-07-01", date_basis: "page", confidence: 0.6 });
    const written = await persistRecords(db, [seedRow(), copy], "seed", "run-1");
    expect(written.persistedIds).toEqual(["fearn:seed:2026-09-23"]);
    expect(await tombstones(db)).toEqual([{ droppedId: "fearn:seed:2026-07-01", keptId: "fearn:seed:2026-09-23" }]);
    expect((await mergeDuplicateRounds(db)).merged).toBe(0);

    // The survivor merged later: the older tombstone moves with it, and the chain reads one hop either way.
    await recordTombstone(db, "fearn:seed:2026-09-23", "fearn:seed:2026-06-10");
    expect(await tombstones(db)).toContainEqual({ droppedId: "fearn:seed:2026-07-01", keptId: "fearn:seed:2026-06-10" });
    await db.insert(schema.roundMerges).values({ droppedId: "a", keptId: "b" });
    await db.insert(schema.roundMerges).values({ droppedId: "b", keptId: "c" });
    const targets = await tombstoneTargets(db, ["a", "b", "fearn:seed:2026-07-01", "unknown"]);
    expect(Object.fromEntries(targets)).toEqual({ a: "c", b: "c", "fearn:seed:2026-07-01": "fearn:seed:2026-06-10" });
  });

  test("a round whose id is a tombstone is never queued, and a queued row for one is dead-lettered", async () => {
    const db = await testDb();
    const fresh = new Date().toISOString().slice(0, 10);
    const copy = record({ ...digestCopy(), announced_date: fresh, confidence: 0.9 });
    await persistRecords(db, [copy], "seed", "run-1");
    await createTarget(db, { channel: "slack", target: "https://hooks.slack.test/abc", minConfidence: 0.5 });
    // Written before tombstones existed, or by a writer that raced the merge.
    await db.insert(schema.roundMerges).values({ droppedId: copy.id, keptId: "fearn:seed:2026-09-23" });
    expect(await enqueueDeliveries(db, [copy.id], "seed")).toBe(0);

    const [target] = await db.select().from(schema.deliveryTargets);
    await db.insert(schema.deliveries).values({ roundId: copy.id, channel: "slack", target: target?.id as string });
    const calls: string[] = [];
    const fetchOk: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response("ok");
    };
    expect(await flushDeliveries(db, "https://app.test", fetchOk)).toEqual({ sent: 0, failed: 0, deadLettered: 1 });
    expect(calls).toEqual([]);
    const [row] = await db.select().from(schema.deliveries).where(eq(schema.deliveries.roundId, copy.id));
    expect(row).toMatchObject({ status: "dead_letter", lastError: "merged into fearn:seed:2026-09-23: never delivered" });
  });
});

describe("seeding tombstones from the operator's files", () => {
  test("reads apply logs, fix files, and backups", () => {
    const log = [
      "APPLY: writing.",
      "merge fearn:other:2026-09-24 into fearn:seed:2026-09-23 (rule: same company)",
      "  keep: fearn:seed:2026-09-23: ...",
      "merge sammmm:seed:2026-09-22 into sammmm:seed:2025-01-30 (forced)",
    ].join("\n");
    expect(parseAppliedMerges(log, "a.applied.txt")).toEqual([
      { drop: "fearn:other:2026-09-24", keep: "fearn:seed:2026-09-23", from: "a.applied.txt" },
      { drop: "sammmm:seed:2026-09-22", keep: "sammmm:seed:2025-01-30", from: "a.applied.txt" },
    ]);
    // A dry run's log names merges that never happened.
    expect(parseAppliedMerges(log.replace("APPLY: writing.", "DRY RUN: nothing is written."), "a.dryrun.txt")).toEqual([]);
    expect(parseMergeFixes('[{"kind":"merge","keep":"k","drop":"d"},{"kind":"reject","round":"r"}]', "f.json")).toEqual([
      { drop: "d", keep: "k", from: "f.json", unordered: true },
    ]);
    expect(parseMergeFixes("not json", "f.json")).toEqual([]);
    expect(parseCsv('a,b\n"x, ""y""",2\r\n')).toEqual([
      ["a", "b"],
      ['x, "y"', "2"],
    ]);
    expect(
      Object.fromEntries(backupSources('round_id,source_id,field_claims\nr1,https://a,"{""t"":1}"\nr1,https://b,\nr2,https://a,\n')),
    ).toEqual({ r1: ["https://a", "https://b"], r2: ["https://a"] });
  });

  test("writes only what the store confirms, turns an unordered pair the way the merge went, and follows chains", async () => {
    const db = await testDb();
    await persistRecords(db, [seedRow()], "seed", "run-1");
    const pairs = [
      { drop: "fearn:other:2026-09-24", keep: "fearn:seed:2026-09-23", from: "dupes.applied.txt" },
      { drop: "fearn:other:2026-09-24", keep: "fearn:seed:2026-09-23", from: "slack.applied.txt" },
      // The fix file named the survivor as the drop; the merge kept it by survivorOrder.
      { drop: "fearn:seed:2026-09-23", keep: "fearn:seed:2026-06-01", from: "fix.json", unordered: true },
      // Kept row merged again later: the chain reaches a row that exists.
      { drop: "fearn:x:1", keep: "fearn:x:2", from: "old.applied.txt" },
      { drop: "fearn:x:2", keep: "fearn:seed:2026-09-23", from: "old.applied.txt" },
      { drop: "fearn:gone:1", keep: "fearn:gone:2", from: "old.applied.txt" },
    ];
    await persistRecords(
      db,
      [record({ ...digestCopy(9), id: "still:here:1", company_name: "Still", company_key: "still" })],
      "seed",
      "run-2",
    );
    pairs.push({ drop: "still:here:1", keep: "fearn:seed:2026-09-23", from: "never.json" });

    const dry = await seedTombstones(db, pairs, { apply: false });
    expect(dry.lines).toEqual([
      "tombstone fearn:other:2026-09-24 -> fearn:seed:2026-09-23 (dupes.applied.txt)",
      "tombstone fearn:seed:2026-06-01 -> fearn:seed:2026-09-23 (fix.json)",
      "tombstone fearn:x:1 -> fearn:x:2 (now in fearn:seed:2026-09-23) (old.applied.txt)",
      "tombstone fearn:x:2 -> fearn:seed:2026-09-23 (old.applied.txt)",
      "refuse fearn:gone:1 -> fearn:gone:2 (old.applied.txt): fearn:gone:2 is not in the store and no merge leads from it to a row that is",
      "skip still:here:1 -> fearn:seed:2026-09-23 (never.json): still:here:1 is still in the store (never merged, or rebuilt; merge it first)",
    ]);
    expect(await tombstones(db)).toEqual([]);

    const applied = await seedTombstones(db, pairs, { apply: true });
    expect(applied).toMatchObject({ written: 4, refused: 1, skipped: 1 });
    expect(Object.fromEntries(await tombstoneTargets(db, ["fearn:x:1", "fearn:other:2026-09-24"]))).toEqual({
      "fearn:x:1": "fearn:seed:2026-09-23",
      "fearn:other:2026-09-24": "fearn:seed:2026-09-23",
    });
    // Twice changes nothing.
    expect(await seedTombstones(db, pairs, { apply: true })).toMatchObject({ written: 0, skipped: 5, refused: 1 });
  });
});
