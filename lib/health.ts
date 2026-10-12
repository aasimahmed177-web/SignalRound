// Production health, the pure half: each check's verdict from data already read, the schedule each
// lane should keep (derived from the coverage plan through the same clocks the cron routes use), the
// incident state machine that decides when a verdict becomes a message, and the message itself.
// lib/health-check.ts reads the store and the deployment and feeds these; the tests feed fixtures.
//
// The rule is low noise: a failing check alerts only after it fails on two checks in a row, an
// incident sends one message when it opens and one when it clears (after two passing checks), and
// no more than DAILY_ALERT_CAP messages open incidents on one UTC day.

import type { CoveragePlan, MonitorSchedule } from "./coverage.ts";
import { sweepDue } from "./coverage.ts";
import { lanesDue } from "./lanes.ts";
import { durationLabel, errorSnippet } from "./runs.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One check's verdict. `key` names the incident it opens or clears; `link` is a path on the app's origin. */
export interface Finding {
  key: string;
  ok: boolean;
  title: string;
  detail: string;
  cause: string;
  link: string;
}

function pass(key: string, title: string, link: string): Finding {
  return { key, ok: true, title, detail: "", cause: "", link };
}

// The database.

export interface DbProbe {
  ok: boolean;
  /** The unqualified query's error, when it failed. */
  error?: string;
  /** Whether the same table answered schema-qualified (public.funding_rounds) when the unqualified name did not. */
  qualifiedOk?: boolean;
  searchPath?: string | null;
}

/** Hides a connection string that an error message might carry. */
export function redact(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://[redacted]");
}

/**
 * The database verdict. The probe reads a table by its unqualified name on purpose: on September 25,
 * 2026 a pooled connection's search_path was emptied and every query failed for four minutes while a
 * `select 1` would have passed. A qualified read that still answers names that cause outright.
 */
export function dbFinding(probe: DbProbe): Finding {
  const title = "Database queries are failing";
  if (probe.ok) return pass("db", title, "/feed");
  const error = errorSnippet(redact(probe.error ?? "unknown error"));
  if (probe.qualifiedOk) {
    return {
      key: "db",
      ok: false,
      title,
      detail: `An unqualified table read fails (${error}) while public.funding_rounds answers.`,
      cause: `The connection's search_path no longer reaches the tables (search_path is ${JSON.stringify(probe.searchPath ?? "")}).`,
      link: "/feed",
    };
  }
  return {
    key: "db",
    ok: false,
    title,
    detail: `A trivial read fails: ${error}`,
    cause: "The database is unreachable or refusing queries (Neon status, DATABASE_URL, or connection limits).",
    link: "/feed",
  };
}

// The deployment's own pages.

export interface PageProbe {
  path: string;
  /** The HTTP status; null when the request never got an answer. */
  status: number | null;
  error?: string;
}

/** The public pages and API answer 2xx; the first failure names the verdict. */
export function pagesFinding(probes: PageProbe[]): Finding {
  const failed = probes.filter((p) => p.status === null || p.status < 200 || p.status >= 300);
  if (failed.length === 0) return pass("pages", "Public pages are failing", "/");
  const first = failed[0];
  const list = failed.map((p) => `${p.path} ${p.status ?? "no answer"}`).join(", ");
  return {
    key: "pages",
    ok: false,
    title: `Public pages are failing: ${list}`,
    detail: first.error ? errorSnippet(redact(first.error)) : "",
    cause:
      first.status === null
        ? "The deployment did not answer in time: it is down, cold-starting past the timeout, or blocked in front."
        : `A render or API error on the deployment: see the Vercel function logs for ${first.path}.`,
    link: first.path,
  };
}

// The lanes' schedule.

/** The lanes that run on a schedule and write rows on Runs. */
export const SCHEDULED_LANES = ["sweep", "watch", "formd", "announcements", "trending", "monitor"] as const;
export type ScheduledLane = (typeof SCHEDULED_LANES)[number];

const LANE_LABELS: Record<ScheduledLane, string> = {
  sweep: "Sweep",
  watch: "Watch sites",
  formd: "Form D",
  announcements: "X announcements",
  trending: "Trending",
  monitor: "Monitor webhooks",
};

const LANE_CAUSES: Record<ScheduledLane, string> = {
  sweep: "Vercel Cron is not calling /api/cron/sweep, or the sweep workflow is not starting (Vercel cron and Workflow logs).",
  watch: "Vercel Cron is not calling /api/cron/sweep, or the watch workflow is not starting (Vercel cron and Workflow logs).",
  formd: "Vercel Cron is not calling /api/cron/sweep, or the Form D workflow is not starting (Vercel cron and Workflow logs).",
  announcements: "Vercel Cron is not calling /api/cron/announcements, or its workflow is not starting (Vercel cron and Workflow logs).",
  trending: "Vercel Cron is not calling /api/cron/trending, or its workflow is not starting (Vercel cron and Workflow logs).",
  monitor:
    "Firecrawl monitor webhooks stopped arriving: a monitor paused or deleted on Firecrawl, or FIRECRAWL_WEBHOOK_SECRET no longer matches.",
};

/**
 * How long after a due tick a lane's run may still be missing. Two hours tolerates one missed hourly
 * tick (the next one covers it) and a sweep whose last preset starts late in the hour behind slow
 * ones; a daily or weekly lane that skipped its tick is reported two hours after it.
 */
export const LANE_GRACE_MS = 2 * HOUR;

/** How far back a due tick is looked for: past a week, so a weekly sweep's Monday tick is always found. */
const TICK_LOOKBACK_MS = 8 * DAY;

/**
 * Firecrawl owns a monitor's clock and posts only when a check finds pages (observed: an "hourly"
 * monitor checking every six hours), so a quiet hour proves nothing. The check can only catch intake
 * that stopped outright: nothing for a day past the plan's interval.
 */
export const MONITOR_SLACK_MS = DAY;

const MONITOR_INTERVAL_MS: Record<MonitorSchedule, number> = { "daily at 9am": DAY, "every 6 hours": 6 * HOUR, hourly: HOUR };

/** The newest top-of-hour tick at or before `before`, and not before `notBefore`, on which `due` holds. */
export function lastDueTick(due: (at: Date) => boolean, before: Date, notBefore: Date): Date | null {
  const floor = Math.max(notBefore.getTime(), before.getTime() - TICK_LOOKBACK_MS);
  const t = new Date(before);
  t.setUTCMinutes(0, 0, 0);
  for (; t.getTime() >= floor; t.setUTCHours(t.getUTCHours() - 1)) if (due(t)) return new Date(t);
  return null;
}

/** The longest stretch between two due ticks over the last two weeks: the sweep's real interval, whatever its cadence and windows. */
export function longestTickGapMs(due: (at: Date) => boolean, now: Date): number | null {
  const t = new Date(now);
  t.setUTCMinutes(0, 0, 0);
  let prev: number | null = null;
  let longest: number | null = null;
  for (const end = t.getTime() - 2 * TICK_LOOKBACK_MS; t.getTime() >= end; t.setUTCHours(t.getUTCHours() - 1)) {
    if (!due(t)) continue;
    if (prev !== null) longest = Math.max(longest ?? 0, prev - t.getTime());
    prev = t.getTime();
  }
  return longest;
}

/** What one lane owes: a run started at or after `since` for each preset (or one for the lane when `presets` is null). */
export interface LaneExpectation {
  lane: ScheduledLane;
  /** Null when the plan has the lane off or nothing is due yet. */
  since: Date | null;
  presets: string[] | null;
}

export interface LaneContext {
  plan: CoveragePlan;
  /** Every preset the sweep runs. */
  presets: Array<{ slug: string; watchSites: unknown[]; watchQueries: unknown[] }>;
  /** Stored preset monitors with when each was created. */
  monitors: Array<{ presetSlug: string; createdAt: Date }>;
  /** When the coverage setting last changed: a tick before it was due under another plan. */
  planSince: Date;
  now: Date;
}

/**
 * Each scheduled lane's expectation under the plan, from the clocks the cron routes run on: sweepDue
 * for the sweep, lanesDue for watch sites and Form D, every hour for Trending and X announcements
 * when the rung has them on, and the monitor schedule plus MONITOR_SLACK_MS for the webhooks.
 */
export function laneExpectations(ctx: LaneContext): LaneExpectation[] {
  const { plan, now, planSince } = ctx;
  const before = new Date(now.getTime() - LANE_GRACE_MS);
  const tick = (on: boolean, due: (at: Date) => boolean) => (on ? lastDueTick(due, before, planSince) : null);
  const monitorSince = new Date(now.getTime() - MONITOR_INTERVAL_MS[plan.monitorSchedule] - MONITOR_SLACK_MS);
  const monitored = ctx.monitors.filter((m) => m.createdAt <= monitorSince).map((m) => m.presetSlug);
  return [
    { lane: "sweep", since: tick(true, (at) => sweepDue(plan, at).due), presets: ctx.presets.map((p) => p.slug) },
    {
      lane: "watch",
      since: tick(plan.watchSites.enabled, (at) => lanesDue(plan, at).watch),
      presets: ctx.presets.filter((p) => p.watchSites.length > 0 || p.watchQueries.length > 0).map((p) => p.slug),
    },
    { lane: "formd", since: tick(plan.formD.enabled, (at) => lanesDue(plan, at).formd), presets: null },
    { lane: "announcements", since: tick(plan.watchSites.enabled, () => true), presets: null },
    { lane: "trending", since: tick(plan.trending, () => true), presets: null },
    { lane: "monitor", since: monitored.length > 0 ? monitorSince : null, presets: monitored },
  ];
}

/** Newest run start per lane and preset, keyed `lane` and `lane:preset`. */
export type LastRuns = Map<string, Date>;

function utcLabel(at: Date): string {
  return `${at.toISOString().slice(11, 16)} UTC ${at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

/**
 * One verdict per scheduled lane: late when a run it owed never started. A preset with no run on
 * record in a lane that has runs for other presets is new to it (a preset given watch sites in a
 * deploy) and is excused until its first run; a lane with no run on record at all is late.
 */
export function laneFindings(expectations: LaneExpectation[], lastRuns: LastRuns, now: Date): Finding[] {
  return expectations.map(({ lane, since, presets }) => {
    const key = `lane:${lane}`;
    const label = LANE_LABELS[lane];
    if (!since) return pass(key, `${label} lane is late`, "/runs");
    const owed = presets ?? [null];
    const lastOf = (p: string | null) => lastRuns.get(p === null ? lane : `${lane}:${p}`);
    const lanePresetsRan = owed.some((p) => lastOf(p));
    const late = owed.filter((p) => {
      const last = lastOf(p);
      return last ? last < since : !lanePresetsRan;
    });
    if (late.length === 0) return pass(key, `${label} lane is late`, "/runs");
    const stalest = late
      .map(lastOf)
      .filter((d): d is Date => d !== undefined)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const who = presets ? ` for ${late.join(", ")}` : "";
    const lastText = stalest
      ? `last run ${utcLabel(stalest)} (${durationLabel(stalest.toISOString(), now.toISOString())} ago)`
      : "no run on record";
    return {
      key,
      ok: false,
      title: `${label} lane is late${who}`,
      detail: `Owed a run since ${utcLabel(since)}; ${lastText}.`,
      cause: LANE_CAUSES[lane],
      link: "/runs",
    };
  });
}

// The lanes' errors.

/** How many of a lane's newest finished runs the error rate reads, the fewest it needs, and the rate that fails it. */
export const ERROR_WINDOW_RUNS = 8;
export const ERROR_MIN_RUNS = 4;
export const ERROR_RATE_THRESHOLD = 0.5;

/**
 * A scheduled lane's run with no end this long after it started never will: the longest finished run
 * of any scheduled lane in the two weeks to October 11, 2026 took 29 minutes. The check closes it as failed
 * with STALLED_RUN_ERROR, and it counts toward the lane's error rate like any failed run.
 */
export const RUN_STALL_MS = 2 * HOUR;
export const STALLED_RUN_ERROR = "never finished: no end two hours after it started";

export interface RunOutcome {
  lane: string;
  startedAt: Date;
  error: string | null;
}

/**
 * Per scheduled lane, the share of its newest finished runs (last day) that errored. Eight runs is two
 * hourly sweep ticks of three presets, so one bad tick (a Firecrawl blip) stays under half and two
 * do not. The agent lanes are left out: a deep dive records a verdict ("dossier rejected") as its error.
 */
export function errorRateFindings(runs: RunOutcome[]): Finding[] {
  return SCHEDULED_LANES.map((lane) => {
    const key = `errors:${lane}`;
    const label = LANE_LABELS[lane];
    const recent = runs
      .filter((r) => r.lane === lane)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, ERROR_WINDOW_RUNS);
    const failed = recent.filter((r) => r.error);
    if (recent.length < ERROR_MIN_RUNS || failed.length / recent.length < ERROR_RATE_THRESHOLD) {
      return pass(key, `${label} runs are failing`, "/runs");
    }
    return {
      key,
      ok: false,
      title: `${label} runs are failing: ${failed.length} of the last ${recent.length} errored`,
      detail: "",
      cause: `Latest error: ${errorSnippet(redact(failed[0].error ?? ""))}`,
      link: "/runs",
    };
  });
}

// Deliveries.

/** Attempts after which a delivery that keeps failing is reported, before it reaches the dead letters. */
export const DELIVERY_FAILING_ATTEMPTS = 3;

export interface FailingTarget {
  /** A reader's name for the target; never the webhook URL, which is a secret. */
  label: string;
  rows: number;
  dead: number;
  lastError: string | null;
}

/** Deliveries dead-lettered by failed sends (not by policy) or failing again and again, per target. */
export function deliveriesFinding(targets: FailingTarget[], link: string): Finding {
  if (targets.length === 0) return pass("deliveries", "Deliveries are failing", link);
  const names = targets.map((t) => `${t.label} (${t.dead > 0 ? `${t.dead} dead-lettered` : `${t.rows} retrying`})`);
  const withError = targets.find((t) => t.lastError);
  return {
    key: "deliveries",
    ok: false,
    title: `Deliveries are failing to ${targets.length === 1 ? "1 target" : `${targets.length} targets`}`,
    detail: names.join(", "),
    cause: withError ? `Latest error: ${errorSnippet(redact(withError.lastError ?? ""))}` : "Sends to the target keep failing.",
    link,
  };
}

// Freshness.

/** Half a day on top of the sweep's own interval before a quiet feed is unusual. */
export const FRESHNESS_SLACK_MS = 12 * HOUR;

/**
 * No new visible round for longer than the sweep's interval under the plan plus FRESHNESS_SLACK_MS:
 * thirteen hours on the hourly rung, a week and a half-day on the weekly one. An empty store is not
 * a failure: a new instance has nothing to be late with.
 */
export function freshnessFinding(latestVisible: Date | null, plan: CoveragePlan, now: Date): Finding {
  const title = "No new round on the feed";
  const interval = longestTickGapMs((at) => sweepDue(plan, at).due, now);
  if (!latestVisible || interval === null) return pass("freshness", title, "/feed");
  const quiet = now.getTime() - latestVisible.getTime();
  if (quiet <= interval + FRESHNESS_SLACK_MS) return pass("freshness", title, "/feed");
  return {
    key: "freshness",
    ok: false,
    title: `No new round on the feed for ${durationLabel(latestVisible.toISOString(), now.toISOString())}`,
    detail: `The newest visible round was first seen ${utcLabel(latestVisible)}.`,
    cause: "The lanes run but publish nothing: search returns nothing new, or the judge or the news rule refuses every record.",
    link: "/feed",
  };
}

// Credits.

/** The 24-hour spans before the last 24 hours that the spend check compares against, and how many must have spent anything. */
export const SPEND_HISTORY_DAYS = 8;
export const SPEND_MIN_HISTORY_DAYS = 3;
/** The last 24 hours fail at this many times the busiest span before them. */
export const SPEND_SPIKE_MULTIPLE = 2;

/**
 * The Firecrawl credits the runs recorded in the last 24 hours (`days[0]`; `days[1]` is the 24 hours
 * before, and so on) against a ceiling: `ceiling` when the operator set one (CREDIT_ALERT_PER_DAY),
 * else twice the busiest of the eight spans before. Busiest rather than average, so a rung that sweeps
 * once a week compares its sweep day with last week's. A store with under three spans of history owes nothing.
 */
export function spendFinding(days: number[], ceiling: number | null): Finding {
  const title = "Credits are past the daily ceiling";
  const spent = days[0] ?? 0;
  const before = days.slice(1, SPEND_HISTORY_DAYS + 1);
  const busiest = Math.max(0, ...before);
  const limit = ceiling ?? (before.filter((n) => n > 0).length >= SPEND_MIN_HISTORY_DAYS ? SPEND_SPIKE_MULTIPLE * busiest : null);
  if (limit === null || spent <= limit) return pass("spend", title, "/runs");
  return {
    key: "spend",
    ok: false,
    title: `Credits are past the daily ceiling: ${spent.toLocaleString("en-US")} in the last 24 hours`,
    detail: ceiling
      ? `CREDIT_ALERT_PER_DAY is ${ceiling.toLocaleString("en-US")}.`
      : `Twice the busiest day of the week before (${busiest.toLocaleString("en-US")}).`,
    cause: "A lane is looping, a backfill is running, or the coverage rung went up. Runs lists each run's credits.",
    link: "/runs",
  };
}

// The incident state machine.

/** Consecutive checks a condition must fail before it alerts, and pass before it is called recovered. */
export const CONFIRM_CHECKS = 2;
/** Messages that open incidents per UTC day; recoveries of announced incidents always go. */
export const DAILY_ALERT_CAP = 5;

export interface Incident {
  title: string;
  detail: string;
  cause: string;
  link: string;
  /** The first failing check, ISO. */
  since: string;
  fails: number;
  passes: number;
  /** Whether the opening message went out; a recovery is only sent for an announced incident. */
  alerted: boolean;
}

export interface HealthState {
  incidents: Record<string, Incident>;
  /** The UTC day `sent` counts, YYYY-MM-DD. */
  day: string;
  sent: number;
  /** When the state was last written, ISO: the newer of two copies wins. */
  checkedAt: string;
}

export function emptyHealthState(now: Date): HealthState {
  return { incidents: {}, day: now.toISOString().slice(0, 10), sent: 0, checkedAt: now.toISOString() };
}

/** A stored value as state; anything unreadable starts clean. */
export function parseHealthState(value: unknown, now: Date): HealthState {
  const v = value as Partial<HealthState> | null | undefined;
  if (!v || typeof v !== "object" || typeof v.incidents !== "object" || v.incidents === null) return emptyHealthState(now);
  return {
    incidents: v.incidents,
    day: typeof v.day === "string" ? v.day : now.toISOString().slice(0, 10),
    sent: typeof v.sent === "number" ? v.sent : 0,
    checkedAt: typeof v.checkedAt === "string" ? v.checkedAt : new Date(0).toISOString(),
  };
}

export type KeyedIncident = Incident & { key: string };

export interface Advance {
  state: HealthState;
  opened: KeyedIncident[];
  recovered: KeyedIncident[];
  /** Incidents confirmed but held back by the daily cap; they open when the cap resets if still failing. */
  capped: KeyedIncident[];
}

/**
 * One check's findings applied to the state. A failure opens an incident on its CONFIRM_CHECKS-th
 * consecutive check; a pass before that forgets it (a flap never alerts). An announced incident
 * recovers on its CONFIRM_CHECKS-th consecutive pass and is quiet until then. `complete` says every
 * check ran, so an incident whose key no finding named (a lane since removed) counts as a pass;
 * otherwise those are left as they were. The caller sends `opened` and `recovered` as one message
 * and calls `delivered` only once it went out.
 */
export function advance(prev: HealthState, findings: Finding[], now: Date, complete: boolean): Advance {
  const today = now.toISOString().slice(0, 10);
  const incidents: Record<string, Incident> = {};
  const recovered: KeyedIncident[] = [];
  const confirmed: KeyedIncident[] = [];
  const named = new Set(findings.map((f) => f.key));
  const results = [
    ...findings,
    ...(complete ? Object.keys(prev.incidents).filter((k) => !named.has(k)) : []).map((key) => ({ ...prev.incidents[key], key, ok: true })),
  ];
  if (!complete) for (const [key, inc] of Object.entries(prev.incidents)) if (!named.has(key)) incidents[key] = inc;

  for (const f of results) {
    const was = prev.incidents[f.key];
    if (f.ok) {
      if (!was?.alerted) continue;
      const passes = was.passes + 1;
      if (passes >= CONFIRM_CHECKS) recovered.push({ ...was, key: f.key, passes });
      else incidents[f.key] = { ...was, passes, fails: 0 };
      continue;
    }
    const next: Incident = {
      title: f.title,
      detail: f.detail,
      cause: f.cause,
      link: f.link,
      since: was?.since ?? now.toISOString(),
      fails: (was?.fails ?? 0) + 1,
      passes: 0,
      alerted: was?.alerted ?? false,
    };
    incidents[f.key] = next;
    if (!next.alerted && next.fails >= CONFIRM_CHECKS) confirmed.push({ ...next, key: f.key });
  }

  const sent = prev.day === today ? prev.sent : 0;
  const open = confirmed.length > 0 && sent < DAILY_ALERT_CAP;
  return {
    state: { incidents, day: today, sent, checkedAt: now.toISOString() },
    opened: open ? confirmed : [],
    recovered,
    capped: open ? [] : confirmed,
  };
}

/** The state once the message for `step` went out: its openings announced and counted against the day's cap. */
export function delivered(step: Advance): HealthState {
  const incidents = { ...step.state.incidents };
  for (const o of step.opened) incidents[o.key] = { ...incidents[o.key], alerted: true };
  return { ...step.state, incidents, sent: step.state.sent + (step.opened.length > 0 ? 1 : 0) };
}

/**
 * The state when the message could not be sent: recoveries stay pending so the next check retries
 * them, and openings stay unannounced so the next check opens them again.
 */
export function undelivered(prev: HealthState, step: Advance): HealthState {
  const incidents = { ...step.state.incidents };
  for (const r of step.recovered) incidents[r.key] = { ...prev.incidents[r.key], passes: r.passes - 1 };
  return { ...step.state, incidents };
}

// The message.

/** Slack's mrkdwn escapes: `&`, `<`, and `>` are control characters in message text. */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The Slack text for one check: each new incident with what fails, since when, the likely cause, and
 * one link; each recovery on a line. Plain mrkdwn, no mentions. Null when there is nothing to say.
 */
export function alertMessage(step: Pick<Advance, "opened" | "recovered">, origin: string, now: Date, capReached: boolean): string | null {
  const parts: string[] = [];
  for (const o of step.opened) {
    const lines = [
      `*Fireround alert: ${esc(o.title)}*`,
      `Failing since ${utcLabel(new Date(o.since))} (${durationLabel(o.since, now.toISOString())}).${o.detail ? ` ${esc(o.detail)}` : ""}`,
      `Likely cause: ${esc(o.cause)}`,
      `<${origin}${o.link}|${esc(`${origin.replace(/^https?:\/\//, "")}${o.link}`)}>`,
    ];
    parts.push(lines.join("\n"));
  }
  for (const r of step.recovered) {
    parts.push(
      `*Fireround recovered: ${esc(r.title)}* (failing since ${utcLabel(new Date(r.since))}, ${durationLabel(r.since, now.toISOString())})`,
    );
  }
  if (parts.length === 0) return null;
  if (capReached && step.opened.length > 0)
    parts.push(`Daily cap of ${DAILY_ALERT_CAP} alerts reached: new incidents wait until 00:00 UTC.`);
  return parts.join("\n\n");
}
