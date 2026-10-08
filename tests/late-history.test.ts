import { schema } from "@fireround/core/db";
import { eq, sql } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { enqueueDeliveries } from "../lib/delivery";
import { repairLateHistory, repairReleaseDays } from "../lib/late-history";
import { listRounds, persistRecords, toFeedRow } from "../lib/persist";
import { createTarget } from "../lib/settings";
import { record, testDb } from "./helpers";

const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

test("a verified old announcement becomes history in the date-changing write", async () => {
  const db = await testDb();
  const fresh = record({ company_name: "Kognitos", announced_date: day(1), date_basis: "page" });
  await persistRecords(db, [fresh], "seed", "first");
  const earlier = { ...fresh, announced_date: "2023-02-07", date_basis: "stated" as const };
  await persistRecords(db, [earlier], "seed", "readback");
  const [stored] = await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, fresh.id));
  expect(stored).toMatchObject({ announcedOn: "2023-02-07", history: true, status: "seen" });
  expect(stored.hold).toMatch(/^reported later: announced 2023-02-07 \(stated\), first seen/);
  expect(await enqueueDeliveries(db, [fresh.id], "seed")).toBe(0);
  const { rows } = await listRounds(db, { ids: [fresh.id], includeReview: true, history: "only" });
  expect(toFeedRow(rows[0]).reported_later).toBe(true);
});

test("an initially old verified announcement is history before it can be delivered", async () => {
  const db = await testDb();
  const old = record({ company_name: "Nilo", announced_date: day(40), date_basis: "page" });
  await persistRecords(db, [old], "seed", "first");
  const [stored] = await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, old.id));
  expect(stored.history).toBe(true);
  expect(await enqueueDeliveries(db, [old.id], "seed")).toBe(0);
  expect((await listRounds(db, { ids: [old.id], history: "exclude" })).rows).toEqual([]);
});

test("a pinned old day counts, while week, month, and unverified URL dates do not", async () => {
  const db = await testDb();
  const pinned = record({ company_name: "Pinned", announced_date: day(1) });
  const weekly = record({ company_name: "Weekly", announced_date: day(30), date_precision: "week", date_basis: "page" });
  const monthly = record({ company_name: "Monthly", announced_date: day(60), date_precision: "month", date_basis: "page" });
  const unchecked = record({
    company_name: "Unchecked",
    announced_date: day(60),
    date_basis: "url",
    verification: { status: "unverified", notes: [], url: null },
  });
  await persistRecords(db, [pinned, weekly, monthly, unchecked], "seed", "first");
  await db
    .update(schema.fundingRounds)
    .set({ announcedOn: day(60), pinned: { announced_on: day(60) } })
    .where(eq(schema.fundingRounds.id, pinned.id));
  const rows = await db.select().from(schema.fundingRounds);
  expect(rows.find((r) => r.id === pinned.id)?.history).toBe(true);
  for (const item of [weekly, monthly, unchecked]) expect(rows.find((r) => r.id === item.id)?.history).toBe(false);
});

test("the repair is a dry run by default and idempotent when applied", async () => {
  const db = await testDb();
  const old = record({ company_name: "Reebelo", announced_date: day(1), date_basis: "stated" });
  await persistRecords(db, [old], "seed", "first");
  await db.execute(sql`ALTER TABLE funding_rounds DISABLE TRIGGER funding_rounds_reported_later`);
  await db
    .update(schema.fundingRounds)
    .set({ announcedOn: "2023-03-20", disposition: "publish" })
    .where(eq(schema.fundingRounds.id, old.id));
  await db.execute(sql`ALTER TABLE funding_rounds ENABLE TRIGGER funding_rounds_reported_later`);
  const changes = await repairLateHistory(db);
  expect(changes).toEqual([{ id: old.id, announcedOn: "2023-03-20", firstSeenAt: day(0), basis: "stated", source: old.sources[0].url }]);
  expect((await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, old.id)))[0].history).toBe(false);
  expect(await repairLateHistory(db, true)).toEqual(changes);
  expect(await repairLateHistory(db, true)).toEqual([]);
});

test("an unread instant delivery still waits for freshness after a successful read-back", async () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
  const db = await testDb();
  const item = record({ company_name: "Newco", announced_date: day(0), verification: { status: "unverified", notes: [], url: null } });
  await persistRecords(db, [item], "seed", "unread");
  await createTarget(db, { channel: "slack", target: "https://hooks.slack.test/abc", minConfidence: 0.5 });
  expect(await enqueueDeliveries(db, [item.id], "seed")).toBe(0);
  const result = await persistRecords(
    db,
    [{ ...item, verification: { status: "confirmed", notes: [], url: item.sources[0].url } }],
    "seed",
    "readback",
  );
  expect(result.changedIds).toContain(item.id);
  expect(await enqueueDeliveries(db, [item.id], "seed")).toBe(0);
  vi.unstubAllEnvs();
});

test("an instance with no model key still holds an unchecked round from delivery", async () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "");
  const db = await testDb();
  const item = record({ company_name: "Keyless", announced_date: day(0), verification: { status: "unverified", notes: [], url: null } });
  await persistRecords(db, [item], "seed", "unread");
  await createTarget(db, { channel: "slack", target: "https://hooks.slack.test/keyless", minConfidence: 0.5 });
  expect(await enqueueDeliveries(db, [item.id], "seed")).toBe(0);
  vi.unstubAllEnvs();
});

test("a round misdated far before its wire release goes back to the release's day and the feed, once", async () => {
  const db = await testDb();
  const released = day(1);
  const dateline = new Date(`${released}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const quote = `SAN FRANCISCO, ${dateline} /PRNewswire/ -- Supabase today announced $150 million in new funding led by GIC.`;
  const round = record({ company_name: "Supabase", announced_date: released, date_basis: "stated", evidence_quotes: [quote] });
  await persistRecords(db, [round], "growth", "first");
  // The state a stale page day left behind: the old day, and the reported-later rule's history flag and hold.
  await db
    .update(schema.fundingRounds)
    .set({
      announcedOn: "2023-10-30",
      dateBasis: "page",
      verification: { status: "confirmed", notes: ["held for review: earliest-report search pending"], url: null },
    })
    .where(eq(schema.fundingRounds.id, round.id));
  const before = (await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, round.id)))[0];
  expect(before).toMatchObject({ history: true, hold: expect.stringMatching(/^reported later: announced 2023-10-30/) });
  const changes = await repairReleaseDays(db);
  expect(changes).toEqual([{ id: round.id, from: "2023-10-30", to: released, backToFeed: true, quote }]);
  expect((await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, round.id)))[0].announcedOn).toBe("2023-10-30");
  expect(await repairReleaseDays(db, true)).toEqual(changes);
  const [after] = await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, round.id));
  expect(after).toMatchObject({ announcedOn: released, dateBasis: "stated", history: false, hold: null });
  expect(after.verification?.notes).toEqual(["held for review: earliest-report search pending"]);
  expect(await repairReleaseDays(db, true)).toEqual([]);
});
