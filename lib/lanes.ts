// The watch-sites and Form D lanes: when an hour runs them, which filing window Form D reads,
// and the seen-URL ledger both keep in the candidates table under a synthetic monitor id
// (`watch:<host>` and `formd`), so a page or a filing is extracted once. The sweep keeps one too
// (`sweep:<preset>:<window>`), dated: an hourly day-window sweep's searches return the same
// articles all day, and each re-read cost five credits and found nothing new (September 2026).

import type { Candidate, WindowSpec } from "@fireround/core";
import { type Db, schema } from "@fireround/core/db";
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import type { CoveragePlan } from "@/lib/coverage";

export type LaneCadence = CoveragePlan["watchSites"]["cadence"];
export type LaneName = "watch" | "formd";

/** Daily lanes run at this UTC hour, the same hour the weekly and daily sweeps run. */
export const DAILY_LANE_HOUR_UTC = 6;

/** Whether an hourly tick runs a lane on this cadence: hourly always, daily at 06:00 UTC. */
export function laneDue(cadence: LaneCadence, at: Date): boolean {
  return cadence === "hourly" || at.getUTCHours() === DAILY_LANE_HOUR_UTC;
}

/** The lanes this tick runs under the plan: enabled and due. */
export function lanesDue(plan: CoveragePlan, at: Date): Record<LaneName, boolean> {
  return {
    watch: plan.watchSites.enabled && laneDue(plan.watchSites.cadence, at),
    formd: plan.formD.enabled && laneDue(plan.formD.cadence, at),
  };
}

/**
 * The filing-date window a Form D check reads: the last two days on the daily cadence (a filing
 * posted late on day one appears in EDGAR's index on day two), the last three hours on hourly.
 * EDGAR searches by calendar day, so an hourly window is one or two days wide in practice.
 */
export function formDWindow(cadence: LaneCadence, at: Date): { start: Date; end: Date } {
  const ms = cadence === "hourly" ? 3 * 3_600_000 : 2 * 86_400_000;
  return { start: new Date(at.getTime() - ms), end: at };
}

/**
 * Hours between the watch lane's stage-free searches on the hourly cadence. A past-day search returns
 * much the same results hour to hour (September 2026: 20 to 40 results a query, a handful new each
 * hour), so searching every third hour finds the same rounds for a third of the search credits.
 */
export const WATCH_QUERY_EVERY_HOURS = 3;

/** Whether this check runs the stage-free searches: every daily check, every third hourly one. */
export function watchQueriesDue(cadence: LaneCadence, at: Date): boolean {
  return cadence === "daily" || at.getUTCHours() % WATCH_QUERY_EVERY_HOURS === 0;
}

export function watchMonitorId(host: string): string {
  return `watch:${host}`;
}

export const FORM_D_MONITOR_ID = "formd";

/** A URL is seen when it has a row that is not `failed`; a failed extraction is read again next time. */
export async function seenCandidate(handle: Db, monitorId: string, url: string): Promise<boolean> {
  const rows = await handle
    .select({ url: schema.candidates.url })
    .from(schema.candidates)
    .where(and(eq(schema.candidates.monitorId, monitorId), eq(schema.candidates.url, url), ne(schema.candidates.status, "failed")))
    .limit(1);
  return rows.length > 0;
}

/**
 * Days after which the watch lane reads a page again when that read produced no stored round. A page
 * a later rule would keep is otherwise lost for good: Unit1 Studio's and Novadip's September 21 rounds
 * were read by the first watch run, dropped under a rule since changed, and never read again. A page
 * that is a source of a stored round stays seen for good.
 */
export const WATCH_EMPTY_REREAD_DAYS = 7;

/**
 * The watch lane's seen test: a row that is not `failed`, read within the last week or a source of a
 * stored round. A section keeps linking a page for days, so an unproductive page is read at most once a
 * week while it stays linked; its rounds meet the week window and every safeguard like any other read.
 */
export async function seenWatchCandidate(handle: Db, monitorId: string, url: string, now: Date = new Date()): Promise<boolean> {
  const rows = await handle
    .select({ createdAt: schema.candidates.createdAt })
    .from(schema.candidates)
    .where(and(eq(schema.candidates.monitorId, monitorId), eq(schema.candidates.url, url), ne(schema.candidates.status, "failed")))
    .limit(1);
  if (rows.length === 0) return false;
  if (rows[0].createdAt.getTime() >= now.getTime() - WATCH_EMPTY_REREAD_DAYS * 86_400_000) return true;
  const source = await handle.select({ id: schema.sources.id }).from(schema.sources).where(eq(schema.sources.id, url)).limit(1);
  return source.length > 0;
}

/** Insert or reset rows for URLs the lane is about to read; a re-read restarts the row's clock. */
export async function upsertCandidates(
  handle: Db,
  monitorId: string,
  urls: string[],
  status: string,
  checkId: string | null,
): Promise<void> {
  // One row per URL: the same filing can be read twice in a run (as a hit and as the filing an
  // amendment supersedes), and ON CONFLICT DO UPDATE refuses to touch a row twice in one statement.
  const unique = [...new Set(urls)];
  if (unique.length === 0) return;
  const CHUNK = 200;
  for (let i = 0; i < unique.length; i += CHUNK) {
    await handle
      .insert(schema.candidates)
      .values(unique.slice(i, i + CHUNK).map((url) => ({ monitorId, url, status, checkId })))
      .onConflictDoUpdate({
        target: [schema.candidates.monitorId, schema.candidates.url],
        set: { status, checkId, createdAt: sql`now()` },
      });
  }
}

export async function markCandidates(handle: Db, monitorId: string, urls: string[], status: string): Promise<void> {
  if (urls.length === 0) return;
  await handle
    .update(schema.candidates)
    .set({ status })
    .where(and(eq(schema.candidates.monitorId, monitorId), inArray(schema.candidates.url, urls)));
}

/**
 * How long a sweep skips a URL it read, by window. A day-window search dates results loosely and
 * returns an article for two or three days; a week window, for the week. A month window (a backfill)
 * never skips: it reads older rounds that a day window's resolve dropped as out of window.
 */
export const SWEEP_SEEN_DAYS: Record<"day" | "week", number> = { day: 3, week: 7 };

/** The sweep's ledger for one preset and window: a page a Series A sweep read may still hold a seed round. */
export function sweepMonitorId(presetSlug: string, window: string): string {
  return `sweep:${presetSlug}:${window}`;
}

/** The URLs of `urls` read on this ledger since `since` and not failed: the sweep skips these. */
export async function seenSince(handle: Db, monitorId: string, urls: string[], since: Date): Promise<Set<string>> {
  const unique = [...new Set(urls)];
  const out = new Set<string>();
  const CHUNK = 500;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const rows = await handle
      .select({ url: schema.candidates.url })
      .from(schema.candidates)
      .where(
        and(
          eq(schema.candidates.monitorId, monitorId),
          inArray(schema.candidates.url, unique.slice(i, i + CHUNK)),
          ne(schema.candidates.status, "failed"),
          gte(schema.candidates.createdAt, since),
        ),
      );
    for (const r of rows) out.add(r.url);
  }
  return out;
}

/** Write what a sweep read, dated now: a read page is skipped for the window's days, a failed one read again. */
export async function recordReads(handle: Db, monitorId: string, ok: string[], failed: string[], checkId: string | null): Promise<void> {
  for (const [urls, status] of [
    [ok, "extracted"],
    [failed, "failed"],
  ] as const) {
    const unique = [...new Set(urls)];
    const CHUNK = 200;
    for (let i = 0; i < unique.length; i += CHUNK) {
      await handle
        .insert(schema.candidates)
        .values(unique.slice(i, i + CHUNK).map((url) => ({ monitorId, url, status, checkId })))
        .onConflictDoUpdate({
          target: [schema.candidates.monitorId, schema.candidates.url],
          set: { status, checkId, createdAt: sql`now()` },
        });
    }
  }
}

/** The candidates the ledger has not seen inside the window's days; a month window skips nothing. */
export async function unseenCandidates(
  handle: Db,
  candidates: Candidate[],
  presetSlug: string,
  window: WindowSpec,
  now: Date,
): Promise<Candidate[]> {
  if (window !== "day" && window !== "week") return candidates;
  const since = new Date(now.getTime() - SWEEP_SEEN_DAYS[window] * 86_400_000);
  const pages = candidates.filter((c) => !c.kinds.includes("x")).map((c) => c.url);
  const seen = await seenSince(handle, sweepMonitorId(presetSlug, window), pages, since);
  return candidates.filter((c) => c.kinds.includes("x") || !seen.has(c.url));
}
