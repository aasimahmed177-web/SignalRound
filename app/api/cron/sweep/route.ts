// The sweep, every preset. Vercel Cron calls this every hour with `Authorization: Bearer
// $CRON_SECRET`; the coverage rung decides which hours sweep and with which windows (Lite:
// Monday 06:00 UTC, the week window; Max: every hour, the day window). The same tick runs the
// watch-sites and Form D lanes when the rung has them on and the hour matches their cadence
// (daily at 06:00 UTC, hourly every hour); the watch lane's stage-free searches run every third
// hour on the hourly cadence (lib/lanes.ts). A tick with nothing due answers { skipped: "not due" }
// and the next due sweep hour.
//
// Manually, `?force=1` sweeps now whatever the hour (`?window=day` picks the window, week by
// default; `month-2` is one past calendar month; `?preset=seed` narrows to one preset):
//   curl -H "authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/sweep?force=1"
// One lane by hand, whatever the hour and whether the rung has it on:
//   curl -H "authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/sweep?lane=watch&force=1"
//   curl -H "authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/sweep?lane=formd&force=1"
//   curl -H "authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/sweep?lane=formd&force=1&days=90"   (a span of filings)
// The enrichment backlog by hand (every sweep enriches what it writes; this works what is left, up to ?limit= per preset, 50 by default):
//   curl -H "authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/sweep?lane=enrich&force=1"
// The corroboration backlog by hand (rows with no page from the company's own site, up to ?limit= per preset, 40 by default):
//   curl -H "authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/sweep?lane=corroborate&force=1"

// The historical backfill (`force=1` implied): one month sweep per preset for each of the last N
// calendar months ("month", "month-1", ...) and one Form D run over the same span; `estimate=1`
// prices it without starting anything. `pnpm backfill --months N` is the terminal in front of it.
//   curl -H "authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/sweep?backfill=3"

import { randomUUID } from "node:crypto";
import type { FormDSpan, WindowSpec } from "@fireround/core";
import { formatWindow, parseWindow } from "@fireround/core";
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { backfillSpan, backfillWindows, estimateBackfillCredits, parseBackfillMonths } from "@/lib/backfill";
import { sweepDue } from "@/lib/coverage";
import { cronAuthorized } from "@/lib/cron-auth";
import { claimCronTick } from "@/lib/cron-lease";
import { db } from "@/lib/db";
import { type LaneName, lanesDue, watchQueriesDue } from "@/lib/lanes";
import { listPresets } from "@/lib/presets";
import { getCoverage } from "@/lib/settings";
import { corroborateBacklogWorkflow } from "@/workflows/corroborate";
import { enrichWorkflow } from "@/workflows/enrich";
import { formDWorkflow } from "@/workflows/form-d";
import { type SweepJob, sweepWorkflow } from "@/workflows/sweep";
import { watchSitesWorkflow } from "@/workflows/watch-sites";

function laneParam(value: string | null): LaneName | null {
  return value === "watch" || value === "formd" ? value : null;
}

/** The forced sweep's window: any spec `parseWindow` reads, the week otherwise. */
function windowParam(value: string | null): WindowSpec {
  if (value === null) return "week";
  try {
    return formatWindow(parseWindow(value));
  } catch {
    return "week";
  }
}

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tick = new Date();
  const url = new URL(request.url);
  const origin = process.env.APP_ORIGIN ?? url.origin;
  const force = url.searchParams.get("force") === "1";
  if (force && url.searchParams.get("lane") === "enrich") {
    // Not a scheduled lane: sweeps enrich inline, so this only exists to work a backlog by hand.
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    if (!(await claimCronTick(await db(), "sweep", tick))) return NextResponse.json({ ok: true, skipped: "already claimed" });
    const enrichRuns: Array<{ lane: "enrich"; preset: string; runId: string }> = [];
    for (const p of await listPresets()) {
      const runId = randomUUID();
      await start(enrichWorkflow, [p.slug, runId, limit]);
      enrichRuns.push({ lane: "enrich", preset: p.slug, runId });
    }
    return NextResponse.json({ ok: true, windows: [], runs: [], lanes: enrichRuns });
  }
  if (force && url.searchParams.get("lane") === "corroborate") {
    // Not a scheduled lane either: sweeps corroborate what they write; this brings rows with no page from
    // the company's own site through the newsroom read, up to ?limit= per preset, 40 by default.
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 40));
    if (!(await claimCronTick(await db(), "sweep", tick))) return NextResponse.json({ ok: true, skipped: "already claimed" });
    const runs: Array<{ lane: "corroborate"; preset: string; runId: string }> = [];
    for (const p of await listPresets()) {
      const runId = randomUUID();
      await start(corroborateBacklogWorkflow, [p.slug, runId, limit]);
      runs.push({ lane: "corroborate", preset: p.slug, runId });
    }
    return NextResponse.json({ ok: true, windows: [], runs: [], lanes: runs });
  }
  const onlyLane = laneParam(url.searchParams.get("lane"));
  const now = new Date();

  const backfillParam = url.searchParams.get("backfill");
  const backfill = parseBackfillMonths(backfillParam);
  if (backfillParam !== null && backfill === null) {
    return NextResponse.json({ error: "backfill must be a whole number of months from 1 to 12" }, { status: 400 });
  }

  let windows: WindowSpec[] = [];
  let lanes: Record<LaneName, boolean>;
  let formDSpan: FormDSpan | undefined;
  if (backfill !== null) {
    windows = backfillWindows(backfill);
    lanes = { watch: false, formd: true };
    formDSpan = backfillSpan(backfill, now);
    if (url.searchParams.get("estimate") === "1") {
      const [plan, presets] = await Promise.all([db().then(getCoverage), listPresets()]);
      const estimate = estimateBackfillCredits(plan, presets, backfill);
      return NextResponse.json({ ok: true, backfill, windows, presets: presets.map((p) => p.slug), formD: formDSpan, estimate });
    }
  } else if (force) {
    // A forced tick runs what it names: one lane, or the sweep.
    if (onlyLane) lanes = { watch: onlyLane === "watch", formd: onlyLane === "formd" };
    else {
      windows = [windowParam(url.searchParams.get("window"))];
      lanes = { watch: false, formd: false };
    }
  } else {
    const plan = await getCoverage(await db());
    const due = sweepDue(plan, now);
    const dueLanes = lanesDue(plan, now);
    lanes = onlyLane ? { watch: onlyLane === "watch" && dueLanes.watch, formd: onlyLane === "formd" && dueLanes.formd } : dueLanes;
    const sweepNow = due.due && !onlyLane;
    if (!sweepNow && !lanes.watch && !lanes.formd) return NextResponse.json({ ok: true, skipped: "not due", next: due.next });
    if (sweepNow) windows = due.windows.map(formatWindow);
  }

  // `?preset=` narrows a forced or backfill tick to one preset; a scheduled tick sweeps every preset.
  const onlyPreset = force || backfill !== null ? url.searchParams.get("preset") : null;
  const presets = (await listPresets()).filter((p) => !onlyPreset || p.slug === onlyPreset);
  if (!(await claimCronTick(await db(), "sweep", tick))) return NextResponse.json({ ok: true, skipped: "already claimed" });
  const runs: Array<{ preset: string; window: WindowSpec; runId: string }> = [];
  const jobs: SweepJob[] = [];
  for (const p of presets) {
    for (const window of windows) {
      const runId = randomUUID();
      jobs.push({ presetSlug: p.slug, window, runId });
      runs.push({ preset: p.slug, window, runId });
    }
  }
  // One workflow run per tick: the jobs sweep in order inside it, so each run's measured
  // credits are its own rather than the whole tick's.
  if (jobs.length > 0) await start(sweepWorkflow, [jobs, origin]);

  const laneRuns: Array<{ lane: LaneName; preset: string | null; runId: string }> = [];
  if (lanes.watch) {
    // A forced check runs the stage-free searches too; a scheduled one on their own cadence.
    const withQueries = force || watchQueriesDue((await getCoverage(await db())).watchSites.cadence, now);
    for (const p of presets) {
      if (p.watchSites.length === 0 && p.watchQueries.length === 0) continue;
      const runId = randomUUID();
      await start(watchSitesWorkflow, [p.slug, runId, origin, withQueries]);
      laneRuns.push({ lane: "watch", preset: p.slug, runId });
    }
  }
  if (lanes.formd) {
    const runId = randomUUID();
    // `?lane=formd&force=1&days=N` reads the last N days of filings instead of the rung's cadence window.
    const days = Number(url.searchParams.get("days"));
    if (!formDSpan && force && Number.isInteger(days) && days > 0 && days <= 366) {
      formDSpan = { start: new Date(now.getTime() - days * 86_400_000).toISOString(), end: now.toISOString() };
    }
    await start(formDWorkflow, formDSpan ? [runId, origin, formDSpan] : [runId, origin]);
    laneRuns.push({ lane: "formd", preset: null, runId });
  }

  return NextResponse.json({ ok: true, windows, runs, lanes: laneRuns, ...(backfill !== null ? { backfill, formD: formDSpan } : {}) });
}
