import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/runs/auto-refresh";
import { EMPTY_PARAM, LANE_PARAM, RunFilters, runsHref } from "@/components/runs/run-filters";
import { RunsList, type RunView } from "@/components/runs/runs-list";
import { PageBody } from "@/components/shell/page-body";
import { PageHeader } from "@/components/shell/page-header";
import { PillSkeleton, SkeletonLine, StatRowSkeleton, TableSkeleton } from "@/components/ui/skeletons";
import { Stat } from "@/components/ui/stat";
import { seesReview, seesSpend, viewer } from "@/lib/access";
import { cachedPresets, cachedRuns } from "@/lib/cached";
import { db } from "@/lib/db";
import { compact, relativeTime } from "@/lib/format";
import { listRuns, type RunRow } from "@/lib/news";
import { presetOptions } from "@/lib/presets";
import { publicRunError } from "@/lib/public-view";
import { durationLabel, errorSnippet, isEmptyRun, laneCounts, runState, stalledNote, withoutSpend } from "@/lib/runs";
import { shareMetadata } from "@/lib/share";
import { laneOwnsPreset, runLaneLabel } from "@/lib/stats";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function param(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** The lane's name as a reader says it. A lane this build has no label for (a newer row) reads capitalized, not as a raw slug. */
function laneLabel(lane: string, window: string | null = null, preset: string | null = null, startedAt?: string) {
  const label = runLaneLabel(lane, window, preset, startedAt);
  return label.name === lane ? { ...label, name: lane.charAt(0).toUpperCase() + lane.slice(1) } : label;
}

async function RunsBody({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const sp = await searchParams;
  const lane = param(sp[LANE_PARAM]);
  const showEmpty = param(sp[EMPTY_PARAM]) === "1";
  const v = await viewer();
  // A demo visitor reads every lane but the admin ones (the accuracy check's tallies of Review's flags).
  const adminLanes = seesReview(v);
  // Credits are the operator's: a demo visitor reads what each run did, never what it cost.
  const spend = seesSpend(v);
  // A visitor's list is one shared cache entry a minute (lib/cached.ts); an admin reads it fresh.
  const [runs, presets] = await Promise.all([adminLanes ? listRuns(await db(), 100, { adminLanes }) : cachedRuns(100), cachedPresets()]);
  const presetName = new Map(presetOptions(presets).map((p) => [p.slug, p.name]));
  const now = Date.now();

  // Stats read the lane in view, empty runs included: an empty run is a run that happened, hidden
  // for legibility rather than struck from the record. It adds nothing to credits or records by
  // definition, so only the run count moves, and its hint says how many of those are empty.
  const inLane = lane ? runs.filter((r) => r.lane === lane) : runs;
  const credits = spend ? inLane.reduce((n, r) => n + r.credits_charged, 0) : 0;
  const records = inLane.reduce((n, r) => n + (r.counts?.records ?? 0), 0);
  const pages = inLane.reduce((n, r) => n + (r.counts?.pages_extracted ?? 0), 0);
  const found = inLane.reduce((n, r) => n + (r.counts?.rounds_extracted ?? 0), 0);
  const emptyInLane = inLane.filter(isEmptyRun).length;
  const laneName = lane ? laneLabel(lane).name : null;

  // Chips count what the list would show under the current toggle, so a chip's number matches its rows.
  const listed = showEmpty ? runs : runs.filter((r) => !isEmptyRun(r));
  const lanes = laneCounts(listed).map((l) => ({ ...l, label: laneLabel(l.lane).name }));
  if (lane && !lanes.some((l) => l.lane === lane)) lanes.push({ lane, label: laneName ?? lane, count: 0 });
  const shown = lane ? listed.filter((r) => r.lane === lane) : listed;

  // Poll only while something is genuinely in flight: a stalled row will not finish on a 15s beat.
  const running = runs.filter((r) => runState(r, now) === "running").length;

  const view = (r: RunRow): RunView => {
    const label = laneLabel(r.lane, r.window, r.preset, r.started_at);
    const state = runState(r, now);
    // A driver error quotes its query: a visitor reads the public sentence (lib/public-view.ts).
    const error = adminLanes ? r.error : publicRunError(r.error);
    return {
      id: r.id,
      laneName: label.name,
      qualifier: label.qualifier,
      preset: laneOwnsPreset(r.lane) ? null : (presetName.get(r.preset) ?? r.preset),
      presetSlug: r.preset,
      state,
      stalledNote: state === "stalled" ? stalledNote(r.lane) : null,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      started: relativeTime(r.started_at),
      duration: durationLabel(r.started_at, r.finished_at, now),
      counts: spend ? r.counts : withoutSpend(r.counts),
      credits: spend
        ? { estimated: r.credits_estimated, measured: r.credits_measured, charged: r.credits_charged, overlapped: r.overlapped }
        : null,
      error,
      errorSnippet: error ? errorSnippet(error) : null,
    };
  };

  const empty = "rounded-12 border border-dashed border-border-muted p-12 text-center text-body-small text-muted-foreground";

  return (
    <PageBody>
      <AutoRefresh running={running} />
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat
            label="RUNS"
            value={inLane.length}
            hint={[laneName ?? "Last 100", emptyInLane ? `${emptyInLane} empty` : null].filter(Boolean).join(" · ")}
          />
          {spend ? (
            <>
              <Stat label="CREDITS" value={compact(credits)} hint="Measured or estimated" />
              <Stat label="RECORDS" value={compact(records)} hint="Rounds written" />
              <Stat
                label="CREDITS / RECORD"
                value={records ? (credits / records).toFixed(1) : "0"}
                hint={laneName ?? "Across every lane"}
              />
            </>
          ) : (
            <>
              <Stat label="PAGES READ" value={compact(pages)} hint="Articles and filings extracted" />
              <Stat label="RECORDS" value={compact(records)} hint="Rounds written" />
              <Stat label="ROUNDS FOUND" value={compact(found)} hint="Before checking and merging" />
            </>
          )}
        </div>
        {spend && (
          <p className="text-body-small text-muted-foreground">
            Measured is the account's drop during the run; a run that overlapped another shares that drop, so the total charges its estimate
            instead.
          </p>
        )}
      </div>
      {runs.length === 0 ? (
        <div className={empty}>No runs yet.</div>
      ) : (
        <div className="space-y-3">
          <RunFilters lane={lane} showEmpty={showEmpty} total={listed.length} lanes={lanes} emptyCount={emptyInLane} />
          {shown.length > 0 ? (
            <RunsList runs={shown.map(view)} />
          ) : emptyInLane > 0 ? (
            <div className={empty}>
              Every run here did no work.{" "}
              <Link href={runsHref(lane, true)} className="text-foreground underline underline-offset-2">
                Show {emptyInLane} empty {emptyInLane === 1 ? "run" : "runs"}
              </Link>
            </div>
          ) : (
            <div className={empty}>No runs of this kind among the last 100.</div>
          )}
        </div>
      )}
    </PageBody>
  );
}

/** Lane chips at the real labels' widths: All, then Sweep, Monitor, Manual, Agent, Corroborate, Enrich. */
const LANE_CHIPS = ["w-16", "w-20", "w-22", "w-20", "w-18", "w-28", "w-18"].map((w, i) => ({ key: `l${i}`, w }));

/** A run card's figure row below md: five label-over-figure cells. */
const RUN_FIGURES = (
  <div className="mt-2 grid grid-cols-5 gap-x-2">
    {["p", "r", "c", "e", "m"].map((k) => (
      <div key={k}>
        <SkeletonLine text="text-mono-x-small" width="w-10" />
        <SkeletonLine text="text-mono-small" width="w-8" />
      </div>
    ))}
  </div>
);

/** The runs page's shape while it loads: the stat row and its note, the lane chips, then the runs table (cards below md). */
function RunsSkeleton() {
  return (
    <PageBody>
      <div className="space-y-3">
        <StatRowSkeleton />
        <SkeletonLine width="w-3/4" />
      </div>
      <div className="space-y-3">
        <div className="flex gap-1.5 overflow-hidden">
          {LANE_CHIPS.map((c) => (
            <PillSkeleton key={c.key} className={c.w} />
          ))}
          <PillSkeleton className="ml-auto hidden w-36 sm:block" />
        </div>
        <TableSkeleton
          rows={10}
          logo={false}
          lines={1}
          bar={false}
          rowPad="py-3"
          headPad="py-2.5"
          cardExtra={RUN_FIGURES}
          cols={[
            "w-36",
            "w-24",
            "hidden w-20 xl:block",
            "hidden w-16 text-right xl:block",
            "w-16 text-right",
            "w-20 text-right",
            "w-16 text-right",
            "w-24 text-right",
          ]}
        />
      </div>
    </PageBody>
  );
}

const RUNS_DESCRIPTION = "Every sweep, check, and enrichment the pipeline ran, and what each one found.";

export const metadata = {
  title: "Runs",
  ...shareMetadata({ title: "Pipeline runs", description: RUNS_DESCRIPTION, image: "root", canonical: "/runs" }),
};

export default function RunsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      {/* NAV's line for Runs names credits; this page's header is static, so it says what every viewer sees. */}
      <PageHeader section={4} description={RUNS_DESCRIPTION} />
      <Suspense fallback={<RunsSkeleton />}>
        <RunsBody searchParams={searchParams} />
      </Suspense>
    </>
  );
}
