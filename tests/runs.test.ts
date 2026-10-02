import { describe, expect, test } from "vitest";
import { measuredCredits } from "../lib/credits";
import { listRuns } from "../lib/news";
import { bumpRunCount, ensureCheckRun, mergeRunCounts, recordRun } from "../lib/persist";
import {
  countLabel,
  durationLabel,
  errorSnippet,
  isEmptyRun,
  laneCounts,
  runState,
  stallAfterMs,
  stalledNote,
  withoutSpend,
} from "../lib/runs";
import { chargeableCredits, overview, runLaneLabel } from "../lib/stats";
import { testDb } from "./helpers";

describe("runLaneLabel", () => {
  const started = "2026-09-04T12:00:00Z";
  test("a sweep shows its window; a past month is named from the run's start, not today", () => {
    expect(runLaneLabel("sweep", "week", "seed", started)).toEqual({ name: "Sweep", qualifier: "week" });
    expect(runLaneLabel("sweep", "month", "seed", started)).toEqual({ name: "Sweep", qualifier: "month" });
    expect(runLaneLabel("sweep", "month-2", "seed", started)).toEqual({ name: "Sweep", qualifier: "Jul 2026" });
    expect(runLaneLabel("sweep", "month-9", "seed", new Date(started))).toEqual({ name: "Sweep", qualifier: "Dec 2025" });
    // The same row read in a later month still names July.
    expect(runLaneLabel("sweep", "month-2", "seed", "2026-09-04T12:00:00Z").qualifier).toBe("Jul 2026");
  });
  test("an unreadable window is shown as stored; a missing one has no qualifier", () => {
    expect(runLaneLabel("sweep", "fortnight", "seed", started)).toEqual({ name: "Sweep", qualifier: "fortnight" });
    expect(runLaneLabel("sweep", null, "seed", started)).toEqual({ name: "Sweep", qualifier: null });
  });
});

describe("monitor check runs", () => {
  test("the first ingest creates the check's row and reads its credits once; every ingest adds to the counters", async () => {
    const db = await testDb();
    let reads = 0;
    const detail = async () => {
      reads++;
      return { startedAt: "2026-09-04T22:04:00Z", estimatedCredits: 130, actualCredits: 88, totalPages: 47 };
    };
    expect(await ensureCheckRun(db, "chk-1", "series-a-b", detail)).toBe(true);
    expect(await ensureCheckRun(db, "chk-1", "series-a-b", detail)).toBe(false);
    expect(reads).toBe(1);

    await Promise.all([
      bumpRunCount(db, "check:chk-1", "records", 2),
      bumpRunCount(db, "check:chk-1", "records", 1),
      bumpRunCount(db, "check:chk-1", "pages_extracted", 1),
      bumpRunCount(db, "check:chk-1", "pages_extracted", 1),
    ]);
    await bumpRunCount(db, "check:chk-1", "started", 0);
    const [run] = await listRuns(db);
    expect(run).toMatchObject({
      id: "check:chk-1",
      lane: "monitor",
      credits_estimated: 130,
      credits_measured: 88,
      counts: { search_results: 47, records: 3, pages_extracted: 2 },
    });
    expect(run.counts).not.toHaveProperty("started");
  });

  test("a check whose detail read fails still has its row", async () => {
    const db = await testDb();
    expect(
      await ensureCheckRun(db, "chk-2", "series-a-b", async () => {
        throw new Error("api down");
      }),
    ).toBe(true);
    const [run] = await listRuns(db);
    expect(run).toMatchObject({ id: "check:chk-2", credits_measured: null });
  });
});

describe("recordRun", () => {
  test("inserts, then upserts the same run id", async () => {
    const db = await testDb();
    const startedAt = new Date("2026-09-04T20:00:00Z");
    await recordRun(db, {
      id: "run-1",
      presetSlug: "series-a-b",
      lane: "sweep",
      window: "week",
      startedAt,
      creditsEstimated: 535,
      counts: { records: 67 },
    });
    let runs = await listRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: "run-1", lane: "sweep", credits_estimated: 535, credits_measured: null, counts: { records: 67 } });

    await recordRun(db, {
      id: "run-1",
      presetSlug: "series-a-b",
      lane: "sweep",
      window: "week",
      startedAt,
      finishedAt: new Date("2026-09-04T20:03:20Z"),
      creditsEstimated: 535,
      creditsMeasured: 532,
      counts: { records: 67 },
    });
    runs = await listRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0].credits_measured).toBe(532);
    expect(runs[0].finished_at).toBe("2026-09-04T20:03:20.000Z");

    await recordRun(db, {
      id: "run-2",
      presetSlug: "series-a-b",
      lane: "enrich",
      startedAt: new Date("2026-09-04T20:17:45Z"),
      finishedAt: new Date(),
      creditsEstimated: 273,
      counts: { companies: 50 },
    });
    runs = await listRuns(db);
    expect(runs.map((r) => r.lane)).toEqual(["enrich", "sweep"]);
  });
});

describe("measuredCredits", () => {
  test("the difference of the balance before and after is the run's cost", () => {
    expect(measuredCredits(100, 40)).toBe(60);
    expect(measuredCredits(500, 500)).toBe(0);
  });

  test("an unmetered key reports 0 at both reads: unknown, not free", () => {
    expect(measuredCredits(0, 0)).toBeNull();
  });

  test("a missing balance read is unknown", () => {
    expect(measuredCredits(null, 5)).toBeNull();
    expect(measuredCredits(5, null)).toBeNull();
    expect(measuredCredits(null, null)).toBeNull();
  });
});

describe("chargeableCredits", () => {
  const a = { started_at: "2026-09-01T10:00:00Z", finished_at: "2026-09-01T10:10:00Z", credits_estimated: 100, credits_measured: 500 };
  const b = { started_at: "2026-09-01T10:05:00Z", finished_at: "2026-09-01T10:15:00Z", credits_estimated: 80, credits_measured: 400 };
  const c = { started_at: "2026-09-01T11:00:00Z", finished_at: "2026-09-01T11:10:00Z", credits_estimated: 50, credits_measured: 60 };
  const all = [a, b, c];

  test("overlapping measurements both charge their estimates; a run alone charges what it measured", () => {
    expect(chargeableCredits(a, all)).toEqual({ credits: 100, overlapped: true });
    expect(chargeableCredits(b, all)).toEqual({ credits: 80, overlapped: true });
    expect(chargeableCredits(c, all)).toEqual({ credits: 60, overlapped: false });
  });

  test("a finished run with no measurement charges its estimate and is never overlapped", () => {
    const unmeasured = {
      started_at: "2026-09-01T10:02:00Z",
      finished_at: "2026-09-01T10:08:00Z",
      credits_estimated: 10,
      credits_measured: null,
    };
    expect(chargeableCredits(unmeasured, all)).toEqual({ credits: 10, overlapped: false });
  });

  test("a run still in flight has no finish and no measurement: it charges nothing and marks nobody overlapped", () => {
    const running = {
      started_at: "2026-09-01T10:02:00Z",
      finished_at: null,
      credits_estimated: 600,
      credits_measured: null,
    };
    expect(chargeableCredits(running, all)).toEqual({ credits: 0, overlapped: false });
    // Overlapping the running row does not mark the measured runs beside it.
    expect(chargeableCredits(a, [...all, running])).toEqual({ credits: 100, overlapped: true });
    expect(chargeableCredits(c, [...all, running])).toEqual({ credits: 60, overlapped: false });
  });

  test("a run row written at start lists finished_at null, takes progress counts, and charges 0 until it finishes", async () => {
    const db = await testDb();
    const now = Date.now();
    await recordRun(db, {
      id: "run-running",
      presetSlug: "series-a-b",
      lane: "sweep",
      window: "week",
      startedAt: new Date(now - 120_000),
      creditsEstimated: 620,
      counts: {},
    });
    await mergeRunCounts(db, "run-running", { search_results: 40, unique_urls: 30 });
    const running = (await listRuns(db)).find((r) => r.id === "run-running");
    expect(running?.finished_at).toBeNull();
    expect(running?.credits_charged).toBe(0);
    expect(running?.credits_estimated).toBe(620);
    expect(running?.counts).toEqual({ search_results: 40, unique_urls: 30 });

    // A measured neighbour whose span crosses the running row is not overlapped by it.
    await recordRun(db, {
      id: "run-done",
      presetSlug: "seed",
      lane: "sweep",
      window: "week",
      startedAt: new Date(now - 110_000),
      finishedAt: new Date(now - 30_000),
      creditsEstimated: 100,
      creditsMeasured: 500,
      counts: {},
    });
    const done = (await listRuns(db)).find((r) => r.id === "run-done");
    expect(done?.overlapped).toBe(false);
    expect(done?.credits_charged).toBe(500);
  });

  test("overview's 30-day total adds estimates for overlapped runs, not their shared measurement", async () => {
    const db = await testDb();
    const now = Date.now();
    await recordRun(db, {
      id: "run-a",
      presetSlug: "series-a-b",
      lane: "sweep",
      startedAt: new Date(now - 600_000),
      finishedAt: new Date(now - 300_000),
      creditsEstimated: 100,
      creditsMeasured: 500,
    });
    await recordRun(db, {
      id: "run-b",
      presetSlug: "seed",
      lane: "sweep",
      startedAt: new Date(now - 550_000),
      finishedAt: new Date(now - 250_000),
      creditsEstimated: 80,
      creditsMeasured: 400,
    });
    expect((await overview(db)).credits_30d).toBe(180);
  });
});

describe("runState", () => {
  const started = "2026-09-22T10:00:00Z";
  const at = (minutes: number) => new Date(new Date(started).getTime() + minutes * 60_000);
  const open = { lane: "sweep", started_at: started, finished_at: null, error: null };

  test("an open sweep is running inside its 30 minutes and stalled past them", () => {
    expect(runState(open, at(9))).toBe("running");
    expect(runState(open, at(30))).toBe("running");
    expect(runState(open, at(31))).toBe("stalled");
    expect(runState(open, at(45).getTime())).toBe("stalled");
  });

  test("the threshold is the lane's: a backlog corroboration gets an hour, an unknown lane the default", () => {
    expect(stallAfterMs("sweep")).toBe(30 * 60_000);
    expect(stallAfterMs("corroborate")).toBe(60 * 60_000);
    expect(stallAfterMs("something-new")).toBe(30 * 60_000);
    expect(runState({ ...open, lane: "corroborate" }, at(45))).toBe("running");
    expect(runState({ ...open, lane: "corroborate" }, at(61))).toBe("stalled");
  });

  test("a finished row is finished however long it took; an error is failed, open or not", () => {
    expect(runState({ ...open, finished_at: at(56).toISOString() }, at(600))).toBe("finished");
    expect(runState({ ...open, finished_at: at(1).toISOString(), error: "boom" }, at(2))).toBe("failed");
    expect(runState({ ...open, error: "boom" }, at(2))).toBe("failed");
  });

  test("the stalled note names the lane's threshold", () => {
    expect(stalledNote("sweep")).toContain("30 minutes");
    expect(stalledNote("corroborate")).toContain("60 minutes");
  });
});

describe("isEmptyRun", () => {
  const base = {
    finished_at: "2026-09-22T10:00:01Z",
    error: null,
    credits_estimated: 0,
    credits_measured: null,
    counts: { pricing: 0, resolved: 0, companies: 0, alexandria: 0 },
  };

  test("a finished run with every count zero and no credits is empty; so is one with no counts at all", () => {
    expect(isEmptyRun(base)).toBe(true);
    expect(isEmptyRun({ ...base, counts: null, credits_estimated: null })).toBe(true);
    expect(isEmptyRun({ ...base, counts: {} })).toBe(true);
  });

  test("any count, any credit, or an error is work worth showing", () => {
    expect(isEmptyRun({ ...base, counts: { companies: 4 } })).toBe(false);
    expect(isEmptyRun({ ...base, credits_estimated: 19 })).toBe(false);
    expect(isEmptyRun({ ...base, credits_measured: 3 })).toBe(false);
    expect(isEmptyRun({ ...base, error: "agent failed" })).toBe(false);
  });

  test("an open run is never empty: its counts land at the end", () => {
    expect(isEmptyRun({ ...base, finished_at: null })).toBe(false);
  });
});

describe("laneCounts", () => {
  test("counts each lane present, in chip order, unknown lanes last by name", () => {
    const runs = ["enrich", "sweep", "zeta", "sweep", "agent", "alpha", "monitor", "sweep"].map((lane) => ({ lane }));
    expect(laneCounts(runs)).toEqual([
      { lane: "sweep", count: 3 },
      { lane: "monitor", count: 1 },
      { lane: "agent", count: 1 },
      { lane: "enrich", count: 1 },
      { lane: "alpha", count: 1 },
      { lane: "zeta", count: 1 },
    ]);
    expect(laneCounts([])).toEqual([]);
  });
});

describe("run display helpers", () => {
  test("durationLabel reads seconds, minutes, then hours; an open row counts to now", () => {
    const s = "2026-09-22T10:00:00Z";
    expect(durationLabel(s, "2026-09-22T10:00:42Z")).toBe("42s");
    expect(durationLabel(s, "2026-09-22T10:09:41Z")).toBe("9m 41s");
    expect(durationLabel(s, "2026-09-22T11:15:00Z")).toBe("1h 15m");
    expect(durationLabel(s, null, new Date("2026-09-22T10:45:00Z"))).toBe("45m 0s");
    expect(durationLabel(s, "2026-09-22T09:59:00Z")).toBe("0s");
  });

  test("errorSnippet keeps the first line and caps it", () => {
    expect(errorSnippet("Error: timed out\n    at step (sweep.ts:12)")).toBe("Error: timed out");
    const long = errorSnippet("x".repeat(300), 40);
    expect(long).toHaveLength(40);
    expect(long.endsWith("…")).toBe(true);
  });

  test("countLabel turns snake and camel keys into sentence case", () => {
    expect(countLabel("pages_extracted")).toBe("Pages extracted");
    expect(countLabel("notArticle")).toBe("Not article");
    expect(countLabel("judge_not_news")).toBe("Judge not news");
    expect(countLabel("records")).toBe("Records");
  });

  test("withoutSpend drops the counters that measure credits and keeps the work", () => {
    expect(withoutSpend({ pages_extracted: 12, judge_credits: 40, corroborationCredits: 9, creditsUsed: 3, records: 2 })).toEqual({
      pages_extracted: 12,
      records: 2,
    });
    expect(withoutSpend(null)).toBeNull();
  });
});
