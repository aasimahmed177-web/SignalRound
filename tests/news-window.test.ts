// The news window (lib/deliverable.ts): no channel sends a round as new when its announced day is more
// than 14 days before the moment of sending. Slack targets, webhooks, and the email digest here; the
// Slack subscriptions and the public daily digest in slack-subscriptions.test.ts.

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";
import { NEWS_WINDOW_DAYS, staleForNews } from "../lib/deliverable";
import { enqueueDeliveries, flushDeliveries, sendSampleDigest } from "../lib/delivery";
import { persistRecords, setDisposition } from "../lib/persist";
import { createEmailTarget, createTarget, setTargetExpected } from "../lib/settings";
import { record, testDb } from "./helpers";

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe("staleForNews", () => {
  const now = new Date("2026-09-25T15:05:46Z");
  test("more than 14 days before the day of sending is stale; undated is not judged here", () => {
    expect(NEWS_WINDOW_DAYS).toBe(14);
    expect(staleForNews("2026-09-11", now)).toBe(false);
    expect(staleForNews("2026-09-10", now)).toBe(true);
    // Assort Health's Series C, announced June 24 and posted as new on Sep 25.
    expect(staleForNews("2026-06-24", now)).toBe(true);
    expect(staleForNews("2026-09-25", now)).toBe(false);
    expect(staleForNews(null, now)).toBe(false);
    expect(staleForNews("not a day", now)).toBe(false);
  });
});

describe("every target channel", () => {
  const env = { key: process.env.RESEND_API_KEY, from: process.env.DIGEST_FROM };
  afterEach(() => {
    process.env.RESEND_API_KEY = env.key;
    process.env.DIGEST_FROM = env.from;
    if (env.key === undefined) delete process.env.RESEND_API_KEY;
    if (env.from === undefined) delete process.env.DIGEST_FROM;
  });

  test("expected rounds require each target's opt-in at enqueue and send, while an announced upgrade can enter news", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.DIGEST_FROM = "Fireround <digest@app.test>";
    const db = await testDb();
    const planned = record({ company_name: "Planned", company_key: "planned", announced_date: day(1), certainty: "expected" });
    const confirmed = record({ company_name: "Confirmed", company_key: "confirmed", announced_date: day(1), certainty: "expected" });
    const stale = record({ company_name: "Old plan", company_key: "old-plan", announced_date: day(25), certainty: "expected" });
    await persistRecords(db, [planned, confirmed, stale], "series-a-b", "run-expected");
    for (const r of [planned, confirmed, stale]) await setDisposition(db, r.id, "publish");
    const slack = await createTarget(db, { channel: "slack", target: "https://hooks.slack.test/abc" });
    const hook = await createTarget(db, { channel: "webhook", target: "https://hooks.example.test/f", includeExpected: true });
    const email = await createEmailTarget(db, { target: "deals@example.test", cadence: "weekly" });
    expect(await enqueueDeliveries(db, [planned.id, stale.id], "series-a-b")).toBe(1);
    expect(
      await sendSampleDigest(db, email.id, "https://app.test", async () => {
        throw new Error("unexpected email");
      }),
    ).toEqual({ round: null, error: null });
    await setTargetExpected(db, slack.id, true);
    expect(await enqueueDeliveries(db, [planned.id, stale.id], "series-a-b")).toBe(1);
    await db.insert(schema.deliveries).values({ roundId: planned.id, channel: "email", target: email.id });
    await setTargetExpected(db, hook.id, false);
    const bodies: string[] = [];
    const fetchOk: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response("ok");
    };
    expect(await flushDeliveries(db, "https://app.test", fetchOk)).toEqual({ sent: 1, failed: 0, deadLettered: 2 });
    expect(bodies.join("\n")).toContain("Planned");
    expect(bodies.join("\n")).not.toContain("Old plan");
    await db.update(schema.fundingRounds).set({ certainty: "announced" }).where(eq(schema.fundingRounds.id, confirmed.id));
    expect(await enqueueDeliveries(db, [confirmed.id, stale.id], "series-a-b")).toBe(3);
    await db.update(schema.fundingRounds).set({ certainty: "announced" }).where(eq(schema.fundingRounds.id, planned.id));
    expect(await enqueueDeliveries(db, [planned.id], "series-a-b")).toBe(3);
    expect((await db.select().from(schema.deliveries).where(eq(schema.deliveries.roundId, planned.id))).map((d) => d.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(await enqueueDeliveries(db, [planned.id], "series-a-b")).toBe(0);
    const replay = await flushDeliveries(db, "https://app.test", fetchOk);
    expect(replay).toEqual({ sent: 6, failed: 0, deadLettered: 0 });
    expect(
      (await db.select().from(schema.deliveries).where(eq(schema.deliveries.roundId, planned.id))).map((d) => d.deliveredCertainty),
    ).toEqual(["announced", "announced", "announced"]);
    expect(await enqueueDeliveries(db, [planned.id], "series-a-b")).toBe(0);
  });

  test("a stale round is never queued for Slack, webhooks, or email, and one that went stale in the queue is dead-lettered", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.DIGEST_FROM = "Fireround <digest@app.test>";
    const db = await testDb();
    const fresh = record({ company_name: "Newco", company_key: "newco", announced_date: day(1), confidence: 0.9 });
    const stale = record({ company_name: "Oldco", company_key: "oldco", announced_date: day(20), confidence: 0.9 });
    const undated = record({ company_name: "Nodate", company_key: "nodate", announced_date: null, confidence: 0.9 });
    await persistRecords(db, [fresh, stale, undated], "series-a-b", "run-1");
    await setDisposition(db, fresh.id, "publish");
    await setDisposition(db, stale.id, "publish");
    const slack = await createTarget(db, { channel: "slack", target: "https://hooks.slack.test/abc", minConfidence: 0.5 });
    const hook = await createTarget(db, { channel: "webhook", target: "https://hooks.example.test/f", minConfidence: 0.5 });
    const email = await createEmailTarget(db, { target: "deals@example.test", cadence: "weekly", minConfidence: 0.5 });
    // Only the fresh round, on all three channels (the undated one starts in review and is not visible).
    expect(await enqueueDeliveries(db, [fresh.id, stale.id, undated.id], "series-a-b")).toBe(3);

    // Queued in time by an older build, or before a re-date moved it back: refused at the moment of sending.
    for (const [channel, target] of [
      ["slack", slack.id],
      ["webhook", hook.id],
      ["email", email.id],
    ] as const)
      await db.insert(schema.deliveries).values({ roundId: stale.id, channel, target });
    const bodies: string[] = [];
    const spy: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response('{"id":"email_1"}');
    };
    expect(await flushDeliveries(db, "https://app.test", spy)).toEqual({ sent: 3, failed: 0, deadLettered: 3 });
    expect(bodies.join("\n")).toContain("Newco");
    expect(bodies.join("\n")).not.toContain("Oldco");
    const dead = await db.select().from(schema.deliveries);
    expect(dead.filter((d) => d.roundId === stale.id).map((d) => d.lastError)).toEqual(
      Array(3).fill(`announced ${stale.announced_date}, more than 14 days before sending: not news`),
    );
  });
});

describe("a round dated only by a list", () => {
  test("waits for a second source before any channel sends it", async () => {
    const db = await testDb();
    const digest = {
      url: "https://startupcorners.com/digest/funding-digest-x",
      host: "startupcorners.com",
      title: "Startup Funding Roundup",
    };
    const listed = record({
      company_name: "Listco",
      company_key: "listco",
      announced_date: day(1),
      date_precision: "week",
      date_basis: "page",
      confidence: 0.9,
      sources: [digest],
    });
    await persistRecords(db, [listed], "series-a-b", "run-1");
    await setDisposition(db, listed.id, "publish");
    await createTarget(db, { channel: "slack", target: "https://hooks.slack.test/abc", minConfidence: 0.5 });
    expect(await enqueueDeliveries(db, [listed.id], "series-a-b")).toBe(0);
    // Corroboration brings a second publisher: two sources, and it goes once approved.
    await persistRecords(
      db,
      [{ ...listed, sources: [digest, { url: "https://techcrunch.com/2026/09/26/listco-seed/", host: "techcrunch.com" }] }],
      "series-a-b",
      "run-2",
    );
    await setDisposition(db, listed.id, "publish");
    expect(await enqueueDeliveries(db, [listed.id], "series-a-b")).toBe(1);
  });
});
