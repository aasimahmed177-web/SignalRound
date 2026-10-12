import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { nextTickDelayMs, nextVerifyDelayMs, SCHEDULER_STARTED, schedulerEnabled, startScheduler, tickPaths } from "../lib/scheduler";

describe("schedulerEnabled", () => {
  test("off under pnpm dev, on when SCHEDULE=1 asks for it", () => {
    expect(schedulerEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(schedulerEnabled({ NODE_ENV: "development", SCHEDULE: "1" })).toBe(true);
  });

  test("a production self-host ticks by default; Vercel never double-ticks", () => {
    expect(schedulerEnabled({ NODE_ENV: "production" })).toBe(true);
    expect(schedulerEnabled({ NODE_ENV: "production", VERCEL: "1" })).toBe(false);
    expect(schedulerEnabled({ NODE_ENV: "production", SCHEDULE: "0" })).toBe(false);
  });
});

describe("nextTickDelayMs", () => {
  test("the next top of the hour, five seconds past it", () => {
    expect(nextTickDelayMs(new Date("2026-09-22T10:59:50Z"))).toBe(15_000);
    expect(nextTickDelayMs(new Date("2026-09-22T10:00:03Z"))).toBe(3_597_000 + 5_000);
  });
});

describe("nextVerifyDelayMs", () => {
  test("fires on quarter hours, leaving the top of the hour to the main tick", () => {
    expect(nextVerifyDelayMs(new Date("2026-09-22T10:14:50Z"))).toBe(15_000);
    expect(nextVerifyDelayMs(new Date("2026-09-22T10:59:50Z"))).toBe(915_000);
  });
});

describe("tickPaths", () => {
  test("the sweep, Trending, X announcements, round verification, and deliveries every hour; accuracy at 05:00, Slack digest at 07:00", () => {
    expect(tickPaths(new Date("2026-09-22T05:00:05Z"))).toEqual([
      "/api/cron/sweep",
      "/api/cron/trending",
      "/api/cron/announcements",
      "/api/cron/verify-rounds",
      "/api/cron/deliveries",
      "/api/cron/accuracy",
    ]);
    expect(tickPaths(new Date("2026-09-22T06:00:05Z"))).toEqual([
      "/api/cron/sweep",
      "/api/cron/trending",
      "/api/cron/announcements",
      "/api/cron/verify-rounds",
      "/api/cron/deliveries",
      "/api/cron/company-newsrooms",
    ]);
    expect(tickPaths(new Date("2026-09-22T07:00:05Z"))).toEqual([
      "/api/cron/sweep",
      "/api/cron/trending",
      "/api/cron/announcements",
      "/api/cron/verify-rounds",
      "/api/cron/deliveries",
      "/api/cron/slack-digest",
    ]);
    expect(tickPaths(new Date("2026-09-22T08:00:05Z"))).toEqual([
      "/api/cron/sweep",
      "/api/cron/trending",
      "/api/cron/announcements",
      "/api/cron/verify-rounds",
      "/api/cron/deliveries",
    ]);
  });
});

describe("startScheduler", () => {
  const calls: Array<{ url: string; authorization?: string }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T10:59:50Z"));
    calls.length = 0;
    delete (globalThis as Record<symbol, unknown>)[SCHEDULER_STARTED];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    delete (globalThis as Record<symbol, unknown>)[SCHEDULER_STARTED];
  });

  function fakeFetch(body: unknown = { ok: true, skipped: "not due" }): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), authorization: (init?.headers as Record<string, string> | undefined)?.authorization });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
  }

  test("the sweep path fires with the bearer at the boundary, then again an hour later", async () => {
    const logs: string[] = [];
    startScheduler({ origin: "http://localhost:3000", secret: "s3cret", fetch: fakeFetch(), log: (m) => logs.push(m) });
    expect(logs[0]).toMatch(/armed; next tick at 2026-09-22T11:00:05/);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toEqual([
      { url: "http://localhost:3000/api/cron/sweep", authorization: "Bearer s3cret" },
      { url: "http://localhost:3000/api/cron/trending", authorization: "Bearer s3cret" },
      { url: "http://localhost:3000/api/cron/announcements", authorization: "Bearer s3cret" },
      { url: "http://localhost:3000/api/cron/verify-rounds", authorization: "Bearer s3cret" },
      { url: "http://localhost:3000/api/cron/deliveries", authorization: "Bearer s3cret" },
    ]);

    // Three quarter-hour ticks (verification and the X announcements lane) run before the next hourly tick at 12:00:05.
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(calls).toHaveLength(16);
    expect(calls.slice(5, 11).map((c) => c.url)).toEqual(
      Array(3).fill(["http://localhost:3000/api/cron/verify-rounds", "http://localhost:3000/api/cron/announcements"]).flat(),
    );
    expect(calls[11].url).toBe("http://localhost:3000/api/cron/sweep");
    expect(calls[12].url).toBe("http://localhost:3000/api/cron/trending");
    expect(calls[13].url).toBe("http://localhost:3000/api/cron/announcements");
    expect(calls[14].url).toBe("http://localhost:3000/api/cron/verify-rounds");
    expect(calls[15].url).toBe("http://localhost:3000/api/cron/deliveries");
  });

  test("a rejected fetch is logged, not thrown, and the next tick still arms", async () => {
    const logs: string[] = [];
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    startScheduler({ origin: "http://localhost:3000", fetch: failing, log: (m) => logs.push(m) });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(logs.some((m) => m.includes("ECONNREFUSED"))).toBe(true);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(logs.filter((m) => m.includes("/api/cron/sweep") && m.includes("ECONNREFUSED"))).toHaveLength(2);
  });

  test("arming twice is a no-op", async () => {
    startScheduler({ origin: "http://localhost:3000", fetch: fakeFetch(), log: () => {} });
    startScheduler({ origin: "http://localhost:3000", fetch: fakeFetch(), log: () => {} });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toHaveLength(5);
  });

  test("a production schedule with no CRON_SECRET says up front that every tick will be refused", () => {
    vi.stubEnv("NODE_ENV", "production");
    const logs: string[] = [];
    startScheduler({ origin: "http://localhost:3000", fetch: fakeFetch(), log: (m) => logs.push(m) });
    expect(logs[0]).toMatch(/CRON_SECRET is not set/);
  });

  test("SCHEDULE_TICK_ON_START=1 ticks immediately, off by default", async () => {
    vi.stubEnv("SCHEDULE_TICK_ON_START", "1");
    startScheduler({ origin: "http://localhost:3000", fetch: fakeFetch(), log: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(5);
  });
});
