// The sweep cron against an in-memory Postgres: the rung decides whether an hour sweeps.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { schema } from "@fireround/core/db";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const started = vi.hoisted(() => [] as unknown[][]);
vi.mock("workflow/api", () => ({
  start: vi.fn(async (...args: unknown[]) => {
    started.push(args);
    return { runId: "mock" };
  }),
}));

import { GET as sweepGet } from "../app/api/cron/sweep/route";
import { db } from "../lib/db";
import { setCoverageSetting } from "../lib/settings";
import { enrichWorkflow } from "../workflows/enrich";
import { formDWorkflow } from "../workflows/form-d";
import { sweepWorkflow } from "../workflows/sweep";
import { watchSitesWorkflow } from "../workflows/watch-sites";

beforeAll(() => {
  // A Wednesday at 13:00 UTC: not a sweep hour for Lite, Standard, or Deep.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-09T13:00:00Z"));
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.setSystemTime(new Date("2026-09-09T13:00:00Z"));
  await (await db()).delete(schema.cronLeases);
});

describe("GET /api/cron/sweep", () => {
  test("an hour that is not due for the rung is skipped, with the next due hour", async () => {
    const res = await sweepGet(new Request("http://app.test/api/cron/sweep"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "not due", next: "2026-09-14T06:00:00.000Z" });
    expect(started).toHaveLength(0);
  });

  test("a due hour starts one sweep per preset and window, and Max's hourly lanes with it", async () => {
    await setCoverageSetting(await db(), { tier: "max", overrides: {} });
    const res = await sweepGet(new Request("http://app.test/api/cron/sweep"));
    const body = (await res.json()) as {
      ok: boolean;
      windows: string[];
      runs: Array<{ preset: string; window: string; runId: string }>;
      lanes: Array<{ lane: string; preset: string | null; runId: string }>;
    };
    expect(body.windows).toEqual(["day"]);
    // One sweep per preset file, in preset order, each with its own run id.
    expect(body.runs).toEqual([
      { preset: "series-a-b", window: "day", runId: expect.any(String) },
      { preset: "seed", window: "day", runId: expect.any(String) },
      { preset: "growth", window: "day", runId: expect.any(String) },
    ]);
    expect(new Set(body.runs.map((r) => r.runId)).size).toBe(3);
    // Max runs watch sites and Form D hourly, so 13:00 starts them beside the sweeps; every preset has watch sites.
    expect(body.lanes).toEqual([
      { lane: "watch", preset: "series-a-b", runId: expect.any(String) },
      { lane: "watch", preset: "seed", runId: expect.any(String) },
      { lane: "watch", preset: "growth", runId: expect.any(String) },
      { lane: "formd", preset: null, runId: expect.any(String) },
    ]);
    expect(started).toHaveLength(5);
    // One workflow run carries the whole tick: every preset's job in one call, in preset order.
    expect(started[0][0]).toBe(sweepWorkflow);
    expect(started[0][1]).toEqual([body.runs.map((r) => ({ presetSlug: r.preset, window: r.window, runId: r.runId })), "http://app.test"]);
    expect(started[1][0]).toBe(watchSitesWorkflow);
    // 13:00 is not a third hour, so this check reads the sections and skips the stage-free searches.
    expect(started[1][1]).toEqual(["series-a-b", body.lanes[0].runId, "http://app.test", false]);
    expect(started[2][1]).toEqual(["seed", body.lanes[1].runId, "http://app.test", false]);
    expect(started[3][1]).toEqual(["growth", body.lanes[2].runId, "http://app.test", false]);
    expect(started[4][0]).toBe(formDWorkflow);
    expect(started[4][1]).toEqual([body.lanes[3].runId, "http://app.test"]);
    await setCoverageSetting(await db(), { tier: "lite", overrides: {} });
  });

  test("daily lanes wait for 06:00 UTC, and run without a sweep when the sweep is not due", async () => {
    started.length = 0;
    // Lite with both lanes switched on: the sweep stays Monday 06:00, the lanes are daily.
    await setCoverageSetting(await db(), { tier: "lite", overrides: { watchSites: { enabled: true }, formD: { enabled: true } } });
    const noon = (await (await sweepGet(new Request("http://app.test/api/cron/sweep"))).json()) as { skipped?: string; lanes?: unknown[] };
    expect(noon.skipped).toBe("not due");
    expect(started).toHaveLength(0);

    // A Wednesday at 06:00 UTC: not a Lite sweep hour, but the daily lane hour.
    vi.setSystemTime(new Date("2026-09-09T06:00:00Z"));
    const six = (await (await sweepGet(new Request("http://app.test/api/cron/sweep"))).json()) as {
      windows: string[];
      runs: unknown[];
      lanes: Array<{ lane: string }>;
    };
    expect(six.windows).toEqual([]);
    expect(six.runs).toEqual([]);
    expect(six.lanes.map((l) => l.lane)).toEqual(["watch", "watch", "watch", "formd"]);
    expect(started).toHaveLength(4);
    expect(started.slice(0, 3).map((s) => s[0])).toEqual([watchSitesWorkflow, watchSitesWorkflow, watchSitesWorkflow]);
    expect(started[3][0]).toBe(formDWorkflow);

    vi.setSystemTime(new Date("2026-09-09T13:00:00Z"));
    await setCoverageSetting(await db(), { tier: "lite", overrides: {} });
  });

  test("?force=1 sweeps whatever the hour; ?window=day picks the window", async () => {
    started.length = 0;
    const res = await sweepGet(new Request("http://app.test/api/cron/sweep?force=1"));
    const body = (await res.json()) as { windows: string[]; runs: unknown[]; lanes: unknown[] };
    expect(body.windows).toEqual(["week"]);
    expect(body.runs).toHaveLength(3);
    expect(body.lanes).toEqual([]);
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const day = await sweepGet(new Request("http://app.test/api/cron/sweep?force=1&window=day"));
    expect(((await day.json()) as { windows: string[] }).windows).toEqual(["day"]);
    expect(started).toHaveLength(2);
  });

  test("?lane=watch&force=1 runs that lane alone, on a rung that has it off and at an hour that is not due", async () => {
    started.length = 0;
    const watch = (await (await sweepGet(new Request("http://app.test/api/cron/sweep?lane=watch&force=1"))).json()) as {
      runs: unknown[];
      lanes: Array<{ lane: string; preset: string | null }>;
    };
    expect(watch.runs).toEqual([]);
    expect(watch.lanes).toEqual([
      { lane: "watch", preset: "series-a-b", runId: expect.any(String) },
      { lane: "watch", preset: "seed", runId: expect.any(String) },
      { lane: "watch", preset: "growth", runId: expect.any(String) },
    ]);
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const formd = (await (await sweepGet(new Request("http://app.test/api/cron/sweep?lane=formd&force=1"))).json()) as {
      lanes: Array<{ lane: string }>;
    };
    expect(formd.lanes).toEqual([{ lane: "formd", preset: null, runId: expect.any(String) }]);
    expect(started).toHaveLength(4);
    expect(started.slice(0, 3).map((s) => s[0])).toEqual([watchSitesWorkflow, watchSitesWorkflow, watchSitesWorkflow]);
    expect(started[3][0]).toBe(formDWorkflow);
    // Without force, the lane still answers to the rung: Lite has it off.
    const gated = (await (await sweepGet(new Request("http://app.test/api/cron/sweep?lane=watch"))).json()) as { skipped?: string };
    expect(gated.skipped).toBe("not due");
    expect(started).toHaveLength(4);
  });

  test("?lane=formd&force=1&days=90 hands the lane a span of the last 90 days", async () => {
    started.length = 0;
    const res = (await (await sweepGet(new Request("http://app.test/api/cron/sweep?lane=formd&force=1&days=90"))).json()) as {
      lanes: Array<{ lane: string; runId: string }>;
    };
    expect(res.lanes).toEqual([{ lane: "formd", preset: null, runId: expect.any(String) }]);
    expect(started).toHaveLength(1);
    expect(started[0][0]).toBe(formDWorkflow);
    const [, , span] = started[0][1] as [string, string, { start: string; end: string }];
    expect(span.end).toBe("2026-09-09T13:00:00.000Z");
    expect(span.start).toBe("2026-06-11T13:00:00.000Z");
    // Without days the lane reads its cadence window, as before.
    started.length = 0;
    vi.setSystemTime(new Date(Date.now() + 60_000));
    await sweepGet(new Request("http://app.test/api/cron/sweep?lane=formd&force=1"));
    expect((started[0][1] as unknown[]).length).toBe(2);
  });

  test("?lane=enrich&force=1 works the enrichment backlog, one run per preset, with a bounded limit", async () => {
    started.length = 0;
    const res = (await (await sweepGet(new Request("http://app.test/api/cron/sweep?lane=enrich&force=1&limit=500"))).json()) as {
      runs: unknown[];
      lanes: Array<{ lane: string; preset: string; runId: string }>;
    };
    expect(res.runs).toEqual([]);
    expect(res.lanes.map((l) => [l.lane, l.preset])).toEqual([
      ["enrich", "series-a-b"],
      ["enrich", "seed"],
      ["enrich", "growth"],
    ]);
    expect(started).toHaveLength(3);
    expect(started[0][0]).toBe(enrichWorkflow);
    expect(started[0][1]).toEqual(["series-a-b", res.lanes[0].runId, 200]);
    // Without force it is not a lane the clock knows.
    started.length = 0;
    const gated = (await (await sweepGet(new Request("http://app.test/api/cron/sweep?lane=enrich"))).json()) as { skipped?: string };
    expect(gated.skipped).toBe("not due");
    expect(started).toHaveLength(0);
  });

  test("?force=1&window=month-2&preset=seed sweeps one past month for one preset", async () => {
    started.length = 0;
    const res = await sweepGet(new Request("http://app.test/api/cron/sweep?force=1&window=month-2&preset=seed"));
    const body = (await res.json()) as { windows: string[]; runs: Array<{ preset: string; window: string }>; lanes: unknown[] };
    expect(body.windows).toEqual(["month-2"]);
    expect(body.runs).toEqual([{ preset: "seed", window: "month-2", runId: expect.any(String) }]);
    expect(started).toHaveLength(1);
    expect(started[0][0]).toBe(sweepWorkflow);
    expect(started[0][1]).toEqual([[{ presetSlug: "seed", window: "month-2", runId: expect.any(String) }], "http://app.test"]);
    // A window this build cannot read falls back to the week.
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const odd = await sweepGet(new Request("http://app.test/api/cron/sweep?force=1&window=fortnight&preset=seed"));
    expect(((await odd.json()) as { windows: string[] }).windows).toEqual(["week"]);
  });

  test("?backfill=3 starts one month sweep per preset per month, newest first, and one Form D run over the span", async () => {
    started.length = 0;
    const res = await sweepGet(new Request("http://app.test/api/cron/sweep?backfill=3"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      backfill: number;
      windows: string[];
      formD: { start: string; end: string };
      runs: Array<{ preset: string; window: string; runId: string }>;
      lanes: Array<{ lane: string; preset: string | null; runId: string }>;
    };
    expect(body.backfill).toBe(3);
    expect(body.windows).toEqual(["month", "month-1", "month-2"]);
    // 3 presets x 3 months, grouped by preset in preset order.
    expect(body.runs.map((r) => `${r.preset} ${r.window}`)).toEqual([
      "series-a-b month",
      "series-a-b month-1",
      "series-a-b month-2",
      "seed month",
      "seed month-1",
      "seed month-2",
      "growth month",
      "growth month-1",
      "growth month-2",
    ]);
    expect(new Set(body.runs.map((r) => r.runId)).size).toBe(9);
    // The Form D span runs from the first day of the oldest month (July, from a September clock) to now.
    expect(body.formD).toEqual({ start: "2026-07-01T00:00:00.000Z", end: "2026-09-09T13:00:00.000Z" });
    expect(body.lanes).toEqual([{ lane: "formd", preset: null, runId: expect.any(String) }]);
    expect(started).toHaveLength(2);
    expect(started[0][0]).toBe(sweepWorkflow);
    expect(started[0][1]).toEqual([body.runs.map((r) => ({ presetSlug: r.preset, window: r.window, runId: r.runId })), "http://app.test"]);
    expect(started[1][0]).toBe(formDWorkflow);
    expect(started[1][1]).toEqual([body.lanes[0].runId, "http://app.test", body.formD]);
  });

  test("?backfill=N&estimate=1 prices the backfill without starting anything; a bad N is a 400", async () => {
    started.length = 0;
    const res = await sweepGet(new Request("http://app.test/api/cron/sweep?backfill=3&estimate=1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      backfill: number;
      windows: string[];
      presets: string[];
      formD: { start: string; end: string };
      estimate: { low: number; high: number; lines: Array<{ label: string; low: number; high: number }> };
    };
    expect(body.windows).toEqual(["month", "month-1", "month-2"]);
    expect(body.presets).toEqual(["series-a-b", "seed", "growth"]);
    expect(body.estimate.low).toBeGreaterThan(0);
    expect(body.estimate.high).toBeGreaterThanOrEqual(body.estimate.low);
    expect(body.estimate.lines.map((l) => l.label)).toEqual([
      "Series A and B: 3 month sweeps",
      "Seed and pre-seed: 3 month sweeps",
      "Series C and later: 3 month sweeps",
      "SEC Form D (EDGAR, no Firecrawl credits)",
    ]);
    expect(started).toHaveLength(0);
    for (const bad of ["0", "13", "abc", "-1", "2.5", ""]) {
      const r = await sweepGet(new Request(`http://app.test/api/cron/sweep?backfill=${bad}`));
      expect(r.status, bad).toBe(400);
    }
    expect(started).toHaveLength(0);
    // ?preset= narrows a backfill too: one preset, three months, and the Form D run.
    const one = (await (await sweepGet(new Request("http://app.test/api/cron/sweep?backfill=3&preset=growth"))).json()) as {
      runs: Array<{ preset: string }>;
      lanes: unknown[];
    };
    expect(one.runs.map((r) => r.preset)).toEqual(["growth", "growth", "growth"]);
    expect(one.lanes).toHaveLength(1);
    expect(started).toHaveLength(2);
  });

  test("a wrong bearer is unauthorized when CRON_SECRET is set", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await sweepGet(new Request("http://app.test/api/cron/sweep"))).status).toBe(401);
    expect((await sweepGet(new Request("http://app.test/api/cron/sweep", { headers: { authorization: "Bearer s3cret" } }))).status).toBe(
      200,
    );
    delete process.env.CRON_SECRET;
  });
});
