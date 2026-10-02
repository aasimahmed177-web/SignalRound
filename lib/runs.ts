// How the Runs page reads a run row: whether it is still working, stalled, failed, or done;
// whether it did any work at all; and which lanes the list holds. Pure, with no database or
// server imports, so the client list and the server page share one reading.

import type { RunRow } from "./news.ts";

export type RunState = "running" | "stalled" | "failed" | "finished";

const MINUTE = 60_000;

/**
 * How long a row may sit without a finish before the page calls it stalled, per lane. Only rows
 * written at the start of the work can sit open: the sweep writes its row before searching (and a
 * manual ingest has done the same), while every other lane writes once, at the end, finished.
 *
 * The numbers come from the runs on record. Thirty sweeps took 2m 40s to 9m 41s end to end,
 * month windows included, so 30 minutes is three times the longest; the one sweep that sat open
 * for 56 minutes never wrote its final counts, which is the stall this mark is for. A manual
 * ingest reads one URL and has taken 17 minutes with a deep dive behind it. Corroborating a whole
 * backlog has taken 24 minutes, so it gets an hour. A deep dive writes its row open when the agent
 * starts; at effort high the durable wait gives up after about half an hour and the dossier check
 * follows, so an agent row gets 45 minutes.
 *
 * A plan with auto gap-fill or deep dives runs agent calls one after another inside a sweep and
 * can pass 30 minutes honestly. STALLED is advisory, not a verdict: the row reads finished the
 * moment its finish lands.
 */
export const STALL_AFTER_MS: Record<string, number> = {
  sweep: 30 * MINUTE,
  manual: 30 * MINUTE,
  monitor: 30 * MINUTE,
  agent: 45 * MINUTE,
  watch: 30 * MINUTE,
  formd: 30 * MINUTE,
  enrich: 30 * MINUTE,
  corroborate: 60 * MINUTE,
  // The X announcements lane writes its row once, finished, like Trending.
  announcements: 30 * MINUTE,
  // Trending writes its row once, finished; an open one never exists, so this only keeps the table complete.
  trending: 30 * MINUTE,
  // The dossier backfill works hundreds of companies a few at a time, several minutes each: a full pass runs for hours.
  dossiers: 24 * 60 * MINUTE,
  // The history backfill works every checked dossier's prior rounds a few companies at a time.
  history: 24 * 60 * MINUTE,
  // The accuracy check writes its row once, finished; like Trending, this only keeps the table complete.
  accuracy: 30 * MINUTE,
};

const DEFAULT_STALL_AFTER_MS = 30 * MINUTE;

export function stallAfterMs(lane: string): number {
  return STALL_AFTER_MS[lane] ?? DEFAULT_STALL_AFTER_MS;
}

type StateInput = Pick<RunRow, "lane" | "started_at" | "finished_at" | "error">;

/** A failure wins over everything; an open row is running until its lane's threshold, stalled after. */
export function runState(run: StateInput, now: Date | number = Date.now()): RunState {
  if (run.error) return "failed";
  if (run.finished_at !== null) return "finished";
  const elapsed = (typeof now === "number" ? now : now.getTime()) - new Date(run.started_at).getTime();
  return elapsed > stallAfterMs(run.lane) ? "stalled" : "running";
}

/** The tooltip on a STALLED tag: what the mark means and that it may still resolve. */
export function stalledNote(lane: string): string {
  const minutes = Math.round(stallAfterMs(lane) / MINUTE);
  return `No finish recorded ${minutes} minutes after it started, well past how long this lane takes. The work likely stopped mid-run (a redeploy or a crashed step); the row updates if it does finish.`;
}

type EmptyInput = Pick<RunRow, "finished_at" | "error" | "credits_estimated" | "credits_measured" | "counts">;

/**
 * A finished run that did nothing: every count zero or absent, no credits either way, no error.
 * An enrich pass with no pending companies writes one of these per preset each time it is asked;
 * they hide by default so the runs that did work stay readable. A run still open is never empty:
 * its counts land at the end.
 */
export function isEmptyRun(run: EmptyInput): boolean {
  if (run.finished_at === null || run.error) return false;
  if (run.credits_estimated || run.credits_measured) return false;
  return Object.values(run.counts ?? {}).every((n) => !n);
}

/** The order lane chips read in: the lanes that find rounds first, the housekeeping lanes after. */
const LANE_ORDER = [
  "sweep",
  "monitor",
  "manual",
  "watch",
  "announcements",
  "formd",
  "trending",
  "agent",
  "dossiers",
  "history",
  "corroborate",
  "enrich",
  "accuracy",
];

/** Each lane present in the rows with its count, in chip order; a lane this build does not know sorts last. */
export function laneCounts(runs: Array<Pick<RunRow, "lane">>): Array<{ lane: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.lane, (counts.get(r.lane) ?? 0) + 1);
  const rank = (lane: string) => {
    const i = LANE_ORDER.indexOf(lane);
    return i === -1 ? LANE_ORDER.length : i;
  };
  return [...counts].map(([lane, count]) => ({ lane, count })).sort((a, b) => rank(a.lane) - rank(b.lane) || a.lane.localeCompare(b.lane));
}

/** The span a run covers: start to finish, or start to now for a row still open (elapsed). */
export function durationLabel(start: string, end: string | null, now: Date | number = Date.now()): string {
  const to = end ? new Date(end).getTime() : typeof now === "number" ? now : now.getTime();
  const s = Math.max(0, Math.round((to - new Date(start).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The first line of an error, capped, for the one-line snippet under a failed row's lane. */
export function errorSnippet(error: string, max = 120): string {
  const line = error.trim().split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** A count key as a reader's label: `pages_extracted` and `notArticle` become "Pages extracted" and "Not article". */
export function countLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A count key that measures spend (`judge_credits`, `creditsUsed`, `spend_cap`), not work. */
function isSpendKey(key: string): boolean {
  return /credit|spend|cost/i.test(key);
}

/**
 * A run's counts minus the ones that measure spend, for a viewer who may not see what the instance
 * spends (seesSpend in lib/access.ts). Null stays null so "not reported" still reads as such.
 */
export function withoutSpend(counts: Record<string, number> | null): Record<string, number> | null {
  if (!counts) return null;
  return Object.fromEntries(Object.entries(counts).filter(([k]) => !isSpendKey(k)));
}
