import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { corroborationConflicts, openVerificationConflict } from "../lib/corroborate.ts";
import { listRounds, persistRecords, type RoundRow } from "../lib/persist.ts";
import { grownRows } from "../lib/reconcile.ts";
import {
  claimRoundVerification,
  completeRoundVerification,
  evidenceComplete,
  finishRoundVerification,
  nextVerification,
  seedRoundVerification,
} from "../lib/round-verification.ts";
import { record, testDb } from "./helpers.ts";

const company = { domain: "acme.com" };
const sources = (...entries: Array<[string, string]>) => entries.map(([url, title]) => ({ url, title, query: null }));

describe("round verification schedule", () => {
  test("expires an unconfirmed report after 90 days without hiding its filtered record", async () => {
    const handle = await testDb();
    const item = record({ company_name: "Waiting", certainty: "expected" });
    await persistRecords(handle, [item], "series-a-b", "expected:verify");
    const now = new Date();
    const old = new Date(now.getTime() - 91 * 86_400_000);
    await handle.update(schema.fundingRounds).set({ firstSeenAt: old }).where(eq(schema.fundingRounds.id, item.id));
    const [row] = (await listRounds(handle, { ids: [item.id], includeReview: true })).rows;
    await seedRoundVerification(handle, now);
    await finishRoundVerification(handle, row, 0, [], {}, now);
    const [stored] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, item.id));
    expect(stored.certainty).toBe("unconfirmed");
    expect((stored.verification as { notes: string[] }).notes).toContain("Still unconfirmed 90 days after its first report.");
    expect((await listRounds(handle)).rows).toHaveLength(0);
    expect((await listRounds(handle, { certainty: "unconfirmed", includeReview: true })).rows).toHaveLength(1);
  });

  test("uses the first sighting, daily through day 30 and weekly through day 90", () => {
    const first = new Date("2026-09-27T00:00:00Z");
    expect([0, 1, 2, 3, 4, 30, 31, 38, 39].map((n) => nextVerification(first, n)?.toISOString() ?? null)).toEqual([
      "2026-09-27T01:00:00.000Z",
      "2026-09-27T06:00:00.000Z",
      "2026-09-28T00:00:00.000Z",
      "2026-09-30T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
      "2026-10-27T00:00:00.000Z",
      "2026-11-03T00:00:00.000Z",
      "2026-12-22T00:00:00.000Z",
      "2026-12-26T00:00:00.000Z",
    ]);
    expect(nextVerification(first, 40)).toBeNull();
  });

  test("an unconfirmed round keeps searching even after independent evidence is complete", async () => {
    const handle = await testDb();
    const item = record({
      company_name: "Still Unconfirmed",
      certainty: "unconfirmed",
      company_domain: "stillunconfirmed.com",
      sources: [
        { url: "https://stillunconfirmed.com/news/round", host: "stillunconfirmed.com", title: "Still Unconfirmed funding" },
        { url: "https://reuters.com/still-unconfirmed", host: "reuters.com", title: "Investors back Still Unconfirmed" },
      ],
    });
    await persistRecords(handle, [item], "series-a-b", "test:unconfirmed");
    const row = (await listRounds(handle, { ids: [item.id], includeReview: true, certainty: "all" })).rows[0];
    const first = new Date(row.first_seen_at);
    const now = new Date(first.getTime() + 29 * 24 * 3_600_000);
    await seedRoundVerification(handle, now);
    await finishRoundVerification(handle, { ...row, freshness_checked_on: row.announced_on }, 1, [], {}, now);
    const [ledger] = await handle.select().from(schema.roundVerification).where(eq(schema.roundVerification.roundId, item.id));
    expect(ledger.status).toBe("pending");
    expect(ledger.nextAttemptAt).toEqual(nextVerification(first, 30));
  });

  test("reactivates unconfirmed ledgers stopped by the former 72-hour schedule only inside 90 days", async () => {
    const handle = await testDb();
    const item = record({ company_name: "Previous Ledger", certainty: "unconfirmed" });
    await persistRecords(handle, [item], "series-a-b", "test:previous-ledger");
    const row = (await listRounds(handle, { ids: [item.id], includeReview: true, certainty: "all" })).rows[0];
    const first = new Date(row.first_seen_at);
    await seedRoundVerification(handle, first);
    await completeRoundVerification(handle, row.id);
    const within = new Date(first.getTime() + 5 * 86_400_000);
    await seedRoundVerification(handle, within);
    let [ledger] = await handle.select().from(schema.roundVerification).where(eq(schema.roundVerification.roundId, row.id));
    expect(ledger).toMatchObject({ status: "pending", nextAttemptAt: within });
    await completeRoundVerification(handle, row.id);
    await seedRoundVerification(handle, new Date(first.getTime() + 91 * 86_400_000));
    [ledger] = await handle.select().from(schema.roundVerification).where(eq(schema.roundVerification.roundId, row.id));
    expect(ledger.status).toBe("done");
  });

  test("needs primary and independent established journalism, not syndicated wire copies", () => {
    const release = ["https://acme.com/news/seed", "Acme raises $8M seed"] as [string, string];
    const copy = ["https://techcrunch.com/acme-seed", "Acme raises $8M seed"] as [string, string];
    const reporting = ["https://reuters.com/technology/acme-funding", "Investors back Acme's funding"] as [string, string];
    expect(evidenceComplete({ company, sources: sources(release, copy) })).toBe(false);
    expect(evidenceComplete({ company, sources: sources(release, reporting) })).toBe(true);
    expect(evidenceComplete({ company, sources: sources(reporting, ["https://axios.com/acme-seed", "Acme closes seed"]) })).toBe(false);
    expect(
      evidenceComplete({ company, sources: sources(["https://investor.vc/news/acme", "Acme funding"], reporting) }, ["investor.vc"]),
    ).toBe(true);
    expect(evidenceComplete({ company, sources: sources(["https://businesswire.com/acme", "Acme release"], reporting) })).toBe(true);
  });

  test("a row with newly attached sources still needs read-back after evidence becomes complete", () => {
    const release = ["https://acme.com/news/seed", "Acme raises $8M seed"] as [string, string];
    const reporting = ["https://reuters.com/technology/acme-funding", "Investors back Acme's funding"] as [string, string];
    const row = {
      company,
      sources: sources(release, reporting),
      verification: { status: "corrected", notes: [], url: null, sources_seen: 1 },
      disposition: "publish",
    } as unknown as RoundRow;
    expect(evidenceComplete(row)).toBe(true);
    expect(grownRows([row])).toEqual([row]);
    expect(grownRows([{ ...row, verification: { status: "corrected", notes: [], url: null, sources_listed: 2 } }])).toEqual([]);
  });

  test("claims due work once, persists the attempt, and schedules the next slot", async () => {
    const handle = await testDb();
    const item = record({ company_name: "Checkpoint" });
    await persistRecords(handle, [item], "series-a-b", "test:verify");
    const first = (await listRounds(handle, { ids: [item.id], includeReview: true })).rows[0];
    const now = new Date(new Date(first.first_seen_at).getTime() + 2 * 3_600_000);
    await seedRoundVerification(handle, now);
    expect(await claimRoundVerification(handle, "worker-a", 1, now)).toEqual([item.id]);
    expect(await claimRoundVerification(handle, "worker-b", 1, now)).toEqual([]);
    await finishRoundVerification(handle, first, 20, [], {}, now);
    const state = await handle.select().from(schema.roundVerification).where(eq(schema.roundVerification.roundId, item.id));
    expect(state[0]).toMatchObject({ attempts: 1, credits: 20, status: "pending", claimedBy: null });
    expect(state[0].nextAttemptAt.toISOString()).toBe(nextVerification(new Date(first.first_seen_at), 1)?.toISOString());
    expect(await claimRoundVerification(handle, "worker-b", 1, now)).toEqual([]);
    await completeRoundVerification(handle, item.id, now);
    const completed = await handle.select().from(schema.roundVerification).where(eq(schema.roundVerification.roundId, item.id));
    expect(completed[0]).toMatchObject({ attempts: 1, status: "done" });
  });

  test("a higher-tier rounded conversion is not a money conflict, but a material mismatch is", () => {
    const row = {
      company: { domain: "acme.com" },
      sources: [{ url: "https://low.example/acme" }],
      amount: { as_written: "$3M" },
      stage: "seed",
      stage_as_written: "Seed",
      announced_on: "2026-09-27",
      date_basis: "stated",
      date_precision: "day",
      valuation_as_written: null,
    } as RoundRow;
    const source = [{ url: "https://acme.com/news/seed", host: "acme.com", title: "Acme seed" }];
    const reading = record({ company_name: "Acme", stage: "seed", announced_date: "2026-09-27", sources: source });
    expect(corroborationConflicts(row, [{ ...reading, amount: { ...reading.amount, value: 3.1, as_written: "$3.1M" } }], [], {})).toEqual(
      [],
    );
    expect(corroborationConflicts(row, [{ ...reading, amount: { ...reading.amount, value: 5, as_written: "$5M" } }], [], {})).toEqual([
      "amount $3M vs $5M (https://acme.com/news/seed)",
    ]);
  });

  test("an expired worker cannot finish after another worker takes the claim", async () => {
    const handle = await testDb();
    const item = record({ company_name: "Claimed Again" });
    await persistRecords(handle, [item], "series-a-b", "test:lease");
    const row = (await listRounds(handle, { ids: [item.id], includeReview: true })).rows[0];
    const now = new Date(new Date(row.first_seen_at).getTime() + 2 * 3_600_000);
    await seedRoundVerification(handle, now);
    expect(await claimRoundVerification(handle, "first", 1, now)).toEqual([item.id]);
    const later = new Date(now.getTime() + 3_600_001);
    expect(await claimRoundVerification(handle, "second", 1, later)).toEqual([item.id]);
    await finishRoundVerification(handle, row, 10, [], {}, later, null, "first");
    const claimed = await handle.select().from(schema.roundVerification).where(eq(schema.roundVerification.roundId, item.id));
    expect(claimed[0]).toMatchObject({ attempts: 0, claimedBy: "second", status: "running" });
    await finishRoundVerification(handle, row, 20, [], {}, later, null, "second");
    const finished = await handle.select().from(schema.roundVerification).where(eq(schema.roundVerification.roundId, item.id));
    expect(finished[0]).toMatchObject({ attempts: 1, credits: 20, status: "pending" });
  });

  test("a flagged conflict blocks automatic revisions until a person publishes it", () => {
    const verification = { status: "confirmed", notes: ["Verification conflict: amount $95M vs $170M"], url: null };
    expect(openVerificationConflict({ disposition: "flagged", verification })).toBe(true);
    expect(openVerificationConflict({ disposition: "publish", verification })).toBe(false);
  });
});
