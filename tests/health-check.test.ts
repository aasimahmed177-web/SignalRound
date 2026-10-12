// The health check end to end against an in-memory Postgres: the lanes' runs, the outbox, and the
// store read for real, the state kept in settings, and the Slack post captured. Includes the failure
// that started it: a connection whose search_path was emptied (September 25, 2026).
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { GET as healthGet } from "../app/api/cron/health/route";
import { CONFIRM_DELAY_MS, failingTargets, type HealthOptions, runHealthCheck } from "../lib/health-check";
import { persistRecords } from "../lib/persist";
import { setCoverageSetting } from "../lib/settings";
import { record, testDb } from "./helpers";

const MIN = 60_000;
const HOOK = "https://hooks.slack.test/services/T/B/x";
const ORIGIN = "https://fireround.test";
const PRESETS = ["series-a-b", "seed", "growth"];

beforeEach(() => {
  delete (globalThis as { __fireroundHealth?: unknown }).__fireroundHealth;
});

/** Captures Slack posts; every page probe answers `pageStatus`. */
function harness(handle: Db | (() => Promise<Db>), base: Date) {
  const posts: string[] = [];
  const logs: string[] = [];
  const state = { pageStatus: 200, minutes: 0 };
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).startsWith(HOOK)) {
      posts.push(JSON.parse(String(init?.body)).text);
      return new Response("ok");
    }
    return new Response("page", { status: state.pageStatus });
  };
  const run = (extra: Partial<HealthOptions> = {}) =>
    runHealthCheck({
      origin: ORIGIN,
      handle: typeof handle === "function" ? handle : async () => handle,
      fetch: fetchImpl,
      now: () => new Date(base.getTime() + state.minutes * MIN),
      sleep: async () => {},
      log: (m) => logs.push(m),
      webhookUrl: HOOK,
      ...extra,
    });
  return { posts, logs, state, run };
}

/** Max, set long enough ago that every tick of the last day is owed. */
async function maxPlan(handle: Db) {
  await setCoverageSetting(handle, { tier: "max", overrides: {} });
  await handle
    .update(schema.settings)
    .set({ updatedAt: new Date(Date.now() - 8 * 24 * 60 * MIN) })
    .where(eq(schema.settings.key, "coverage"));
}

/** A run for every hourly lane `minutesAgo` before `base`: each preset's sweep and watch, Form D, announcements, Trending. */
async function lanesRanAt(handle: Db, base: Date, minutesAgo: number, skip: string[] = []) {
  const startedAt = new Date(base.getTime() - minutesAgo * MIN);
  const rows = [
    ...PRESETS.map((p) => ({ lane: "sweep", presetSlug: p })),
    ...PRESETS.map((p) => ({ lane: "watch", presetSlug: p })),
    { lane: "formd", presetSlug: "form-d" },
    { lane: "announcements", presetSlug: "x-announcements" },
    { lane: "trending", presetSlug: "trending" },
  ].filter((r) => !skip.includes(`${r.lane}:${r.presetSlug}`));
  await handle.insert(schema.runs).values(
    rows.map((r, i) => ({
      id: `${r.lane}-${r.presetSlug}-${minutesAgo}-${i}`,
      ...r,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + MIN),
    })),
  );
}

describe("runHealthCheck", () => {
  test("a healthy Max instance passes every check, sends nothing, and stores its state", async () => {
    const handle = await testDb();
    const base = new Date();
    await maxPlan(handle);
    await lanesRanAt(handle, base, 5);
    const h = harness(handle, base);
    const report = await h.run();
    expect(report.failing).toEqual([]);
    expect(report.passing).toEqual(
      expect.arrayContaining(["db", "pages", "lane:sweep", "lane:monitor", "errors:sweep", "deliveries", "freshness"]),
    );
    expect(report.sent).toBeNull();
    expect(report.stored).toBe(true);
    const [row] = await handle.select().from(schema.settings).where(eq(schema.settings.key, "health"));
    expect(row.value).toMatchObject({ incidents: {}, sent: 0 });
    expect(h.posts).toEqual([]);
  });

  test("a late sweep alerts on the second check only, once, and posts one recovery after two passing checks", async () => {
    const handle = await testDb();
    const base = new Date();
    await maxPlan(handle);
    await lanesRanAt(handle, base, 5, ["sweep:growth"]);
    await lanesRanAt(handle, base, 300, []);
    const h = harness(handle, base);

    const first = await h.run();
    expect(first.failing.map((f) => f.key)).toEqual(["lane:sweep"]);
    expect(first.failing[0].title).toBe("Sweep lane is late for growth");
    expect(first.opened).toEqual([]);
    expect(h.posts).toEqual([]);

    h.state.minutes = 10;
    const second = await h.run();
    expect(second.opened).toEqual(["lane:sweep"]);
    expect(second.sent).toBe("slack");
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toContain("*Fireround alert: Sweep lane is late for growth*");
    expect(h.posts[0]).toContain("Likely cause: Vercel Cron is not calling /api/cron/sweep");
    expect(h.posts[0]).toContain(`<${ORIGIN}/runs|fireround.test/runs>`);

    h.state.minutes = 20;
    expect((await h.run()).opened).toEqual([]);
    expect(h.posts).toHaveLength(1);

    await handle
      .insert(schema.runs)
      .values({ id: "growth-back", presetSlug: "growth", lane: "sweep", startedAt: new Date(base.getTime() + 25 * MIN) });
    h.state.minutes = 30;
    expect((await h.run()).recovered).toEqual([]);
    h.state.minutes = 40;
    const recovered = await h.run();
    expect(recovered.recovered).toEqual(["lane:sweep"]);
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]).toMatch(/^\*Fireround recovered: Sweep lane is late for growth\* \(failing since /);
  });

  test("an emptied search_path fails the database check with that cause; the state still saves, schema-qualified", async () => {
    const handle = await testDb();
    const base = new Date();
    const h = harness(handle, base);
    await handle.execute(sql`set search_path to ''`);
    try {
      const first = await h.run();
      expect(first.failing.map((f) => f.key)).toEqual(["db"]);
      expect(first.failing[0].cause).toMatch(/search_path no longer reaches the tables/);
      expect(first.stored).toBe(true);
      h.state.minutes = 10;
      const second = await h.run();
      expect(second.opened).toEqual(["db"]);
      expect(h.posts[0]).toContain("*Fireround alert: Database queries are failing*");
      expect(h.posts[0]).toContain("while public.funding_rounds answers");
    } finally {
      await handle.execute(sql`set search_path to public`);
    }
    const [row] = await handle.select().from(schema.settings).where(eq(schema.settings.key, "health"));
    expect(row.value).toMatchObject({ incidents: { db: { alerted: true } }, sent: 1 });
    h.state.minutes = 20;
    await h.run();
    h.state.minutes = 30;
    expect((await h.run()).recovered).toEqual(["db"]);
    expect(h.posts).toHaveLength(2);
  });

  test("with the store unreachable and no memory of the last check, a failure confirmed within the run alerts once", async () => {
    const base = new Date();
    const slept: number[] = [];
    const h = harness(() => Promise.reject(new Error("connect ECONNREFUSED postgres://u:secret@db.test/neondb")), base);
    const first = await h.run({ webhookUrl: "", sleep: async (ms) => void slept.push(ms) });
    expect(slept).toEqual([CONFIRM_DELAY_MS]);
    expect(first.opened).toEqual(["db"]);
    expect(first.sent).toBe("log");
    expect(first.stored).toBe(false);
    expect(h.logs[0]).toContain("Database queries are failing");
    expect(h.logs[0]).not.toContain("secret");
    // This instance remembers it: the next check neither waits nor repeats.
    h.state.minutes = 10;
    const second = await h.run({ webhookUrl: "", sleep: async (ms) => void slept.push(ms) });
    expect(slept).toHaveLength(1);
    expect(second.opened).toEqual([]);
    expect(h.logs.filter((l) => l.includes("Fireround alert"))).toHaveLength(1);
  });

  test("a failing public page opens its own incident; a dry run reports without advancing or sending", async () => {
    const handle = await testDb();
    const base = new Date();
    const h = harness(handle, base);
    h.state.pageStatus = 500;
    const dry = await h.run({ dry: true });
    expect(dry.failing.map((f) => f.key)).toEqual(["pages"]);
    expect(dry.stored).toBe(false);
    expect(await handle.select().from(schema.settings).where(eq(schema.settings.key, "health"))).toEqual([]);
    await h.run();
    h.state.minutes = 10;
    expect((await h.run()).opened).toEqual(["pages"]);
    expect(h.posts[0]).toContain("Public pages are failing: / 500, /feed 500, /api/v1/rounds?limit=1 500");
  });

  test("a Slack post that fails is retried on the next check", async () => {
    const handle = await testDb();
    const base = new Date();
    const h = harness(handle, base);
    h.state.pageStatus = 503;
    let refuse = true;
    const flaky: typeof fetch = async (url) =>
      String(url).startsWith(HOOK) ? new Response("no", { status: refuse ? 500 : 200 }) : new Response("", { status: 503 });
    await h.run({ fetch: flaky });
    h.state.minutes = 10;
    const failed = await h.run({ fetch: flaky });
    expect(failed.sent).toBe("failed");
    refuse = false;
    h.state.minutes = 20;
    const retried = await h.run({ fetch: flaky });
    expect(retried.opened).toEqual(["pages"]);
    expect(retried.sent).toBe("slack");
  });

  test("a day that spends past twice the week's busiest alerts on the second check, and CREDIT_ALERT_PER_DAY overrides the ceiling", async () => {
    const handle = await testDb();
    const base = new Date();
    await maxPlan(handle);
    await lanesRanAt(handle, base, 5);
    const day = 24 * 60 * MIN;
    await handle.insert(schema.runs).values([
      ...[1, 2, 3, 4].map((d) => ({
        id: `spend-${d}`,
        lane: "history",
        presetSlug: "history",
        startedAt: new Date(base.getTime() - d * day - 30 * MIN),
        creditsMeasured: 100_000,
      })),
      {
        id: "spend-today",
        lane: "history",
        presetSlug: "history",
        startedAt: new Date(base.getTime() - 60 * MIN),
        creditsEstimated: 250_000,
      },
    ]);
    const h = harness(handle, base);
    expect((await h.run()).failing.map((f) => f.key)).toEqual(["spend"]);
    h.state.minutes = 10;
    const second = await h.run();
    expect(second.opened).toEqual(["spend"]);
    expect(h.posts[0]).toContain("*Fireround alert: Credits are past the daily ceiling: 250,000 in the last 24 hours*");

    process.env.CREDIT_ALERT_PER_DAY = "300000";
    try {
      expect((await h.run({ dry: true })).failing).toEqual([]);
    } finally {
      delete process.env.CREDIT_ALERT_PER_DAY;
    }
  });
});

describe("stalled runs", () => {
  test("a scheduled run with no end two hours on is closed as failed and counts toward its lane's error rate", async () => {
    const handle = await testDb();
    const base = new Date();
    await maxPlan(handle);
    await lanesRanAt(handle, base, 5);
    const ago = (minutes: number) => new Date(base.getTime() - minutes * MIN);
    await handle
      .insert(schema.runs)
      .values([
        ...[150, 210, 270].map((m) => ({ id: `stalled-${m}`, lane: "sweep", presetSlug: "seed", startedAt: ago(m) })),
        { id: "running", lane: "sweep", presetSlug: "growth", startedAt: ago(30) },
        { id: "backfill", lane: "history", presetSlug: "history-backfill", startedAt: ago(300) },
      ]);
    const h = harness(handle, base);

    const dry = await h.run({ dry: true });
    expect(dry.failing.map((f) => f.key)).toEqual(["errors:sweep"]);
    const open = await handle.select().from(schema.runs).where(sql`${schema.runs.finishedAt} is null`);
    expect(open.map((r) => r.id).sort()).toEqual(["backfill", "running", "stalled-150", "stalled-210", "stalled-270"]);

    const report = await h.run();
    expect(report.failing).toEqual([
      expect.objectContaining({ key: "errors:sweep", title: "Sweep runs are failing: 3 of the last 6 errored" }),
    ]);
    expect(h.logs).toContain("closed 3 runs with no end two hours after starting");
    const rows = await handle.select().from(schema.runs).where(sql`${schema.runs.id} in ('stalled-150', 'running', 'backfill')`);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["stalled-150"]).toMatchObject({ error: "never finished: no end two hours after it started" });
    expect(byId["stalled-150"].finishedAt).not.toBeNull();
    expect(byId.running).toMatchObject({ finishedAt: null, error: null });
    expect(byId.backfill).toMatchObject({ finishedAt: null, error: null });
  });
});

describe("failingTargets", () => {
  test("counts sends that keep failing and dead letters from exhausted retries, never policy dead letters or recovered targets", async () => {
    const handle = await testDb();
    const today = new Date().toISOString().slice(0, 10);
    const rounds = ["Acme", "Beta", "Gamma", "Delta"].map((name) => record({ company_name: name, announced_date: today }));
    await persistRecords(handle, rounds, "series-a-b", "run-1");
    const [a, b, c, d] = rounds.map((r) => r.id);
    await handle
      .insert(schema.slackSubscriptions)
      .values({ id: "s1", teamId: "T1", teamName: "Acme Inc", channelId: "C1", channelName: "deals", manageTokenHash: "h1" });
    await handle
      .insert(schema.deliveryTargets)
      .values({ id: "t-hook", channel: "webhook", target: "https://secret.example/hook?token=abc", label: "Team hook" });
    const old = new Date(Date.now() - 60 * MIN);
    await handle.insert(schema.deliveries).values([
      // Exhausted retries to the subscription: counted.
      {
        roundId: a,
        channel: "slack",
        target: "sub:s1",
        status: "dead_letter",
        attempts: 8,
        lastError: "slack: invalid_token",
        updatedAt: old,
      },
      // Policy dead letters (a revoked subscription, a round no longer news): not counted.
      {
        roundId: b,
        channel: "slack",
        target: "sub:gone",
        status: "dead_letter",
        attempts: 0,
        lastError: "subscription revoked: account_inactive",
      },
      { roundId: c, channel: "slack", target: "sub:gone", status: "dead_letter", attempts: 1, lastError: "announced 20 days ago" },
      // Three failed sends to the webhook, still retrying: counted, and its URL never shown.
      { roundId: a, channel: "webhook", target: "t-hook", status: "failed", attempts: 3, lastError: "webhook 502: bad gateway" },
      // Two failed sends: not yet.
      { roundId: d, channel: "slack", target: "sub:s2", status: "failed", attempts: 2, lastError: "slack: timeout" },
    ]);
    const failing = await failingTargets(handle, new Date());
    expect(failing).toEqual([
      { label: "#deals in Acme Inc", rows: 1, dead: 1, lastError: "slack: invalid_token" },
      { label: "Team hook", rows: 1, dead: 0, lastError: "webhook 502: bad gateway" },
    ]);
    // A later successful send to the subscription clears its dead letter.
    await handle.insert(schema.deliveries).values({ roundId: b, channel: "slack", target: "sub:s1", status: "sent", attempts: 1 });
    expect((await failingTargets(handle, new Date())).map((t) => t.label)).toEqual(["Team hook"]);
  });
});

describe("GET /api/cron/health", () => {
  test("refuses a missing or wrong bearer when CRON_SECRET is set; the test line logs without a webhook", async () => {
    process.env.CRON_SECRET = "s3cret";
    const hook = process.env.ALERT_SLACK_WEBHOOK_URL;
    delete process.env.ALERT_SLACK_WEBHOOK_URL;
    try {
      expect((await healthGet(new Request("http://app.test/api/cron/health"))).status).toBe(401);
      expect((await healthGet(new Request("http://app.test/api/cron/health", { headers: { authorization: "Bearer nope" } }))).status).toBe(
        401,
      );
      const res = await healthGet(new Request("http://app.test/api/cron/health?test=1", { headers: { authorization: "Bearer s3cret" } }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, sent: "log" });
    } finally {
      delete process.env.CRON_SECRET;
      if (hook !== undefined) process.env.ALERT_SLACK_WEBHOOK_URL = hook;
    }
  });
});
