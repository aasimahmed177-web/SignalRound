// Production health, the reading half: probe the database and the deployment, read the lanes'
// runs, the outbox, and the feed, and turn them into findings (lib/health.ts); then advance the
// incident state kept in the settings table under `health` and post what changed to the Slack
// incoming webhook in ALERT_SLACK_WEBHOOK_URL, or log it when that is unset.
// /api/cron/health runs it on Vercel Cron every ten minutes.

import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { isPublicDemo } from "./access.ts";
import { dashboardPassword } from "./dashboard-auth.ts";
import { db } from "./db.ts";
import {
  type Advance,
  advance,
  alertMessage,
  CONFIRM_CHECKS,
  DAILY_ALERT_CAP,
  type DbProbe,
  DELIVERY_FAILING_ATTEMPTS,
  dbFinding,
  delivered,
  deliveriesFinding,
  emptyHealthState,
  errorRateFindings,
  type FailingTarget,
  type Finding,
  freshnessFinding,
  type HealthState,
  type LastRuns,
  laneExpectations,
  laneFindings,
  type PageProbe,
  pagesFinding,
  parseHealthState,
  RUN_STALL_MS,
  redact,
  SCHEDULED_LANES,
  SPEND_HISTORY_DAYS,
  STALLED_RUN_ERROR,
  spendFinding,
  undelivered,
} from "./health.ts";
import { BACKOFF_MINUTES } from "./outbox.ts";
import { listPresets } from "./presets.ts";
import { getCoverage } from "./settings.ts";

const { deliveryTargets, fundingRounds, presetMonitors, runs, settings, slackSubscriptions, webhookDeliveries } = schema;

const HEALTH_KEY = "health";
const DAY = 86_400_000;

/** The public pages and API a visitor hits first; each must answer 2xx. */
export const PROBE_PATHS = ["/", "/feed", "/api/v1/rounds?limit=1"];
const PROBE_TIMEOUT_MS = 15_000;
const SLACK_TIMEOUT_MS = 10_000;
/**
 * With the store down there may be no record of the previous check; the database is probed once more
 * this long after the first failure, and two failures in one run stand in for two checks.
 */
export const CONFIRM_DELAY_MS = 20_000;

export interface HealthOptions {
  origin: string;
  handle?: () => Promise<Db>;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  webhookUrl?: string;
  /** Read and report without advancing the state or sending anything. */
  dry?: boolean;
}

export interface HealthReport {
  ok: boolean;
  /** What fails now, whether or not it has alerted yet. */
  failing: Array<Pick<Finding, "key" | "title" | "detail" | "cause">>;
  passing: string[];
  opened: string[];
  recovered: string[];
  capped: string[];
  /** Where the message went: Slack, the log, nowhere (nothing changed), or a failed post. */
  sent: "slack" | "log" | "failed" | null;
  /** Whether the state reached the store; false means it lives in this instance's memory only. */
  stored: boolean;
}

// The last state this instance saw, for when the store itself is what is failing.
const memory = globalThis as typeof globalThis & { __fireroundHealth?: HealthState };

function message(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}

/** A table read by its unqualified name, and when that fails, what explains it. */
export async function probeDb(handle: Db | null, openError?: string): Promise<DbProbe> {
  if (!handle) return { ok: false, error: openError ?? "no database handle" };
  try {
    await handle.execute(sql`select id from funding_rounds limit 1`);
    return { ok: true };
  } catch (err) {
    const probe: DbProbe = { ok: false, error: message(err), qualifiedOk: false, searchPath: null };
    try {
      await handle.execute(sql`select id from public.funding_rounds limit 1`);
      probe.qualifiedOk = true;
    } catch {}
    try {
      const res = await handle.execute(sql`select current_setting('search_path') as search_path`);
      probe.searchPath = String((res.rows[0] as { search_path?: unknown } | undefined)?.search_path ?? "");
    } catch {}
    return probe;
  }
}

/**
 * The stored state, read by the table's plain name and then schema-qualified, so the search_path
 * failure the database check reports does not also cost the record of it. Null when neither answers.
 */
async function loadState(handle: Db | null, now: Date): Promise<HealthState | null> {
  if (!handle) return null;
  try {
    const [row] = await handle.select({ value: settings.value }).from(settings).where(eq(settings.key, HEALTH_KEY)).limit(1);
    return parseHealthState(row?.value, now);
  } catch {}
  try {
    const res = await handle.execute(sql`select value from public.settings where key = ${HEALTH_KEY}`);
    return parseHealthState((res.rows[0] as { value?: unknown } | undefined)?.value, now);
  } catch {
    return null;
  }
}

async function saveState(handle: Db | null, state: HealthState): Promise<boolean> {
  memory.__fireroundHealth = state;
  if (!handle) return false;
  try {
    await handle
      .insert(settings)
      .values({ key: HEALTH_KEY, value: state })
      .onConflictDoUpdate({ target: settings.key, set: { value: state, updatedAt: new Date() } });
    return true;
  } catch {}
  try {
    await handle.execute(
      sql`insert into public.settings (key, value, updated_at) values (${HEALTH_KEY}, ${JSON.stringify(state)}::jsonb, now())
          on conflict (key) do update set value = excluded.value, updated_at = now()`,
    );
    return true;
  } catch {
    return false;
  }
}

/** Each probe path fetched from the app's own origin; a private instance's password rides along. */
export async function probePages(origin: string, fetchImpl: typeof fetch): Promise<PageProbe[]> {
  const password = dashboardPassword();
  const headers: Record<string, string> = password
    ? { authorization: `Basic ${Buffer.from(`health:${password}`).toString("base64")}` }
    : {};
  return Promise.all(
    PROBE_PATHS.map(async (path) => {
      try {
        const res = await fetchImpl(`${origin}${path}`, { headers, cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        await res.body?.cancel();
        return { path, status: res.status };
      } catch (err) {
        return { path, status: null, error: message(err) };
      }
    }),
  );
}

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/** The newest run start per scheduled lane and preset, with monitor webhook intake counted as a monitor run. */
async function lastRuns(handle: Db, since: Date): Promise<LastRuns> {
  const out: LastRuns = new Map();
  const note = (key: string, at: Date) => {
    const was = out.get(key);
    if (!was || at > was) out.set(key, at);
  };
  const rows = await handle
    .select({ lane: runs.lane, preset: runs.presetSlug, last: sql<unknown>`max(${runs.startedAt})` })
    .from(runs)
    .where(and(inArray(runs.lane, [...SCHEDULED_LANES]), gte(runs.startedAt, since)))
    .groupBy(runs.lane, runs.presetSlug);
  for (const r of rows) {
    note(r.lane, asDate(r.last));
    note(`${r.lane}:${r.preset}`, asDate(r.last));
  }
  const hooks = await handle
    .select({
      preset: sql<string | null>`${webhookDeliveries.payload}->'metadata'->>'preset'`,
      last: sql<unknown>`max(${webhookDeliveries.receivedAt})`,
    })
    .from(webhookDeliveries)
    .where(and(sql`${webhookDeliveries.type} like 'monitor.%'`, gte(webhookDeliveries.receivedAt, since)))
    .groupBy(sql`1`);
  for (const h of hooks) {
    note("monitor", asDate(h.last));
    if (h.preset) note(`monitor:${h.preset}`, asDate(h.last));
  }
  return out;
}

async function lanes(handle: Db, now: Date): Promise<Finding[]> {
  const [plan, presets, monitors, [coverageRow], [firstRun]] = await Promise.all([
    getCoverage(handle),
    listPresets(handle),
    handle.select({ presetSlug: presetMonitors.presetSlug, createdAt: presetMonitors.createdAt }).from(presetMonitors),
    handle.select({ updatedAt: settings.updatedAt }).from(settings).where(eq(settings.key, "coverage")).limit(1),
    handle.select({ at: sql<unknown>`min(${runs.startedAt})` }).from(runs),
  ]);
  // Nothing is owed before the plan last changed, nor before the store's first run: a new instance
  // with no runs yet is not late.
  const planSince = new Date(Math.max(coverageRow?.updatedAt.getTime() ?? 0, firstRun?.at ? asDate(firstRun.at).getTime() : now.getTime()));
  const expectations = laneExpectations({ plan, presets, monitors, planSince, now });
  return laneFindings(expectations, await lastRuns(handle, new Date(now.getTime() - 9 * DAY)), now);
}

/** A scheduled lane's run with no end RUN_STALL_MS after it started: the open rows `closeStalledRuns` writes failed. */
function stalled(now: Date) {
  return and(
    inArray(runs.lane, [...SCHEDULED_LANES]),
    isNull(runs.finishedAt),
    isNull(runs.error),
    lt(runs.startedAt, new Date(now.getTime() - RUN_STALL_MS)),
  );
}

/** Closes stalled runs as failed, so Runs stops showing them as running; returns how many. */
export async function closeStalledRuns(handle: Db, now: Date): Promise<number> {
  const closed = await handle
    .update(runs)
    .set({ finishedAt: now, error: STALLED_RUN_ERROR })
    .where(stalled(now))
    .returning({ id: runs.id });
  return closed.length;
}

async function errors(handle: Db, now: Date): Promise<Finding[]> {
  const rows = await handle
    .select({ lane: runs.lane, startedAt: runs.startedAt, error: runs.error, finishedAt: runs.finishedAt })
    .from(runs)
    .where(
      and(
        inArray(runs.lane, [...SCHEDULED_LANES]),
        gte(runs.startedAt, new Date(now.getTime() - DAY)),
        or(isNotNull(runs.finishedAt), isNotNull(runs.error), lt(runs.startedAt, new Date(now.getTime() - RUN_STALL_MS))),
      ),
    )
    .orderBy(desc(runs.startedAt))
    .limit(1000);
  // A dry check writes nothing, so a run it would close counts as failed here all the same.
  return errorRateFindings(rows.map((r) => ({ ...r, error: r.error ?? (r.finishedAt ? null : STALLED_RUN_ERROR) })));
}

/**
 * Targets whose sends keep failing: rows retrying after DELIVERY_FAILING_ATTEMPTS failed sends, and
 * rows dead-lettered by exhausting the backoff (a policy dead letter, such as a round no longer news
 * or a revoked subscription, never bumps attempts) in the last week with no successful send to the
 * same target since. A target that delivers again clears its dead letters from the verdict.
 */
export async function failingTargets(handle: Db, now: Date): Promise<FailingTarget[]> {
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
  const res = await handle.execute(sql`
    select d.target, d.channel, count(*)::int as rows,
      count(*) filter (where d.status = 'dead_letter')::int as dead,
      (array_agg(d.last_error order by d.updated_at desc))[1] as last_error
    from deliveries d
    where (d.status = 'failed' and d.attempts >= ${DELIVERY_FAILING_ATTEMPTS})
      or (d.status = 'dead_letter' and d.attempts >= ${BACKOFF_MINUTES.length} and d.updated_at >= ${since}::timestamptz
        and not exists (select 1 from deliveries s where s.target = d.target and s.status = 'sent' and s.updated_at > d.updated_at))
    group by d.target, d.channel
    order by d.target`);
  const rows = res.rows as Array<{ target: string; channel: string; rows: number; dead: number; last_error: string | null }>;
  if (rows.length === 0) return [];
  const subIds = rows.filter((r) => r.target.startsWith("sub:")).map((r) => r.target.slice(4));
  const targetIds = rows.filter((r) => !r.target.startsWith("sub:")).map((r) => r.target);
  const [subs, targets] = await Promise.all([
    subIds.length
      ? handle
          .select({ id: slackSubscriptions.id, channel: slackSubscriptions.channelName, team: slackSubscriptions.teamName })
          .from(slackSubscriptions)
          .where(inArray(slackSubscriptions.id, subIds))
      : [],
    targetIds.length
      ? handle
          .select({ id: deliveryTargets.id, label: deliveryTargets.label })
          .from(deliveryTargets)
          .where(inArray(deliveryTargets.id, targetIds))
      : [],
  ]);
  const subNames = new Map(subs.map((s) => [s.id, s.channel ? `#${s.channel}${s.team ? ` in ${s.team}` : ""}` : null]));
  const labels = new Map(targets.map((t) => [t.id, t.label]));
  return rows.map((r) => {
    const sub = r.target.startsWith("sub:") ? r.target.slice(4) : null;
    const label = sub
      ? (subNames.get(sub) ?? `Slack subscription ${sub.slice(0, 8)}`)
      : (labels.get(r.target) ?? (r.channel === "x" ? "Posting to X" : `${r.channel} target ${r.target.slice(0, 8)}`));
    return { label, rows: Number(r.rows), dead: Number(r.dead), lastError: r.last_error };
  });
}

/** Where an operator sees the outbox: Settings, or on a public demo with no password (Settings is a 404 there) the Slack page its subscriptions come from. */
function deliveriesLink(): string {
  return isPublicDemo() && !dashboardPassword() ? "/slack" : "/settings";
}

async function freshness(handle: Db, now: Date): Promise<Finding> {
  const [[row], plan] = await Promise.all([
    handle
      .select({ latest: sql<unknown>`max(${fundingRounds.firstSeenAt})` })
      .from(fundingRounds)
      .where(and(inArray(fundingRounds.disposition, ["publish", "flagged"]), eq(fundingRounds.history, false))),
    getCoverage(handle),
  ]);
  return freshnessFinding(row?.latest ? asDate(row.latest) : null, plan, now);
}

/** Each 24-hour span's recorded credits, newest first: what every run measured, else what it estimated. */
async function spend(handle: Db, now: Date): Promise<Finding> {
  const day = sql<number>`floor(extract(epoch from (${now.toISOString()}::timestamptz - ${runs.startedAt})) / 86400)::int`;
  const rows = await handle
    .select({ day, credits: sql<number>`coalesce(sum(coalesce(${runs.creditsMeasured}, ${runs.creditsEstimated})), 0)::int` })
    .from(runs)
    .where(
      and(
        gte(runs.startedAt, new Date(now.getTime() - (SPEND_HISTORY_DAYS + 1) * DAY)),
        sql`${runs.startedAt} <= ${now.toISOString()}::timestamptz`,
      ),
    )
    .groupBy(sql`1`);
  const days = Array.from({ length: SPEND_HISTORY_DAYS + 1 }, (_, i) => Number(rows.find((r) => Number(r.day) === i)?.credits ?? 0));
  const ceiling = Number(process.env.CREDIT_ALERT_PER_DAY);
  return spendFinding(days, Number.isInteger(ceiling) && ceiling > 0 ? ceiling : null);
}

async function postToSlack(url: string, text: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/** One line to the webhook, so an operator can see the channel receives alerts before anything fails. */
export async function sendTestAlert(opts: Pick<HealthOptions, "origin" | "fetch" | "webhookUrl" | "log">): Promise<HealthReport["sent"]> {
  const url = opts.webhookUrl ?? process.env.ALERT_SLACK_WEBHOOK_URL;
  const text = `Fireround alerting is connected for ${opts.origin}. Nothing is failing; this is a test.`;
  if (!url) {
    (opts.log ?? console.log)(`[health] ${text}`);
    return "log";
  }
  return (await postToSlack(url, text, opts.fetch ?? fetch)) ? "slack" : "failed";
}

/**
 * One health check: every finding, the state advanced by them, and the message for what opened or
 * cleared. With the database failing, the checks that read it are skipped (their incidents stay as
 * they were) and only the database verdict counts.
 */
export async function runHealthCheck(opts: HealthOptions): Promise<HealthReport> {
  const now = (opts.now ?? (() => new Date()))();
  const fetchImpl = opts.fetch ?? fetch;
  const log = opts.log ?? ((msg: string) => console.log(`[health] ${msg}`));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const webhookUrl = opts.webhookUrl ?? process.env.ALERT_SLACK_WEBHOOK_URL;

  let handle: Db | null = null;
  let openError: string | undefined;
  try {
    handle = await (opts.handle ?? db)();
  } catch (err) {
    openError = message(err);
  }
  let probe = await probeDb(handle, openError);

  const stored = await loadState(handle, now);
  const remembered = memory.__fireroundHealth;
  let state =
    stored && remembered
      ? remembered.checkedAt > stored.checkedAt
        ? remembered
        : stored
      : (stored ?? remembered ?? emptyHealthState(now));

  if (!probe.ok && !stored && !remembered && !opts.dry) {
    await sleep(CONFIRM_DELAY_MS);
    probe = await probeDb(handle, openError);
    if (!probe.ok && !state.incidents.db) {
      const f = dbFinding(probe);
      state = {
        ...state,
        incidents: { ...state.incidents, db: { ...f, since: now.toISOString(), fails: CONFIRM_CHECKS - 1, passes: 0, alerted: false } },
      };
    }
  }

  const findings: Finding[] = [dbFinding(probe)];
  let complete = probe.ok;
  if (probe.ok && handle) {
    const h = handle;
    if (!opts.dry) {
      const closed = await closeStalledRuns(h, now).catch(() => 0);
      if (closed > 0) log(`closed ${closed} run${closed === 1 ? "" : "s"} with no end two hours after starting`);
    }
    const groups: Array<[string, () => Promise<Finding | Finding[]>]> = [
      ["pages", async () => pagesFinding(await probePages(opts.origin, fetchImpl))],
      ["lanes", () => lanes(h, now)],
      ["errors", () => errors(h, now)],
      ["deliveries", async () => deliveriesFinding(await failingTargets(h, now), deliveriesLink())],
      ["freshness", () => freshness(h, now)],
      ["spend", () => spend(h, now)],
    ];
    for (const [name, run] of groups) {
      const key = `check:${name}`;
      const title = `The ${name} health check cannot run`;
      try {
        findings.push(...[await run()].flat(), { key, ok: true, title, detail: "", cause: "", link: "/runs" });
      } catch (err) {
        complete = false;
        findings.push({
          key,
          ok: false,
          title,
          detail: message(err),
          cause: "A bug or a schema change behind lib/health-check.ts.",
          link: "/runs",
        });
      }
    }
  }

  const failing = findings.filter((f) => !f.ok).map(({ key, title, detail, cause }) => ({ key, title, detail, cause }));
  const passing = findings.filter((f) => f.ok).map((f) => f.key);
  if (opts.dry) return { ok: failing.length === 0, failing, passing, opened: [], recovered: [], capped: [], sent: null, stored: false };

  const step: Advance = advance(state, findings, now, complete);
  const text = alertMessage(step, opts.origin, now, step.state.sent + 1 >= DAILY_ALERT_CAP);
  let sent: HealthReport["sent"] = null;
  let next = step.state;
  if (text) {
    if (webhookUrl) sent = (await postToSlack(webhookUrl, text, fetchImpl)) ? "slack" : "failed";
    else {
      log(text);
      sent = "log";
    }
    next = sent === "failed" ? undelivered(state, step) : delivered(step);
  }
  if (step.capped.length > 0) log(`daily cap reached; held back: ${step.capped.map((c) => c.title).join("; ")}`);
  if (sent === "failed") log("posting to ALERT_SLACK_WEBHOOK_URL failed; the next check retries");

  return {
    ok: failing.length === 0,
    failing,
    passing,
    opened: step.opened.map((o) => o.key),
    recovered: step.recovered.map((r) => r.key),
    capped: step.capped.map((c) => c.key),
    sent,
    stored: await saveState(handle, next),
  };
}
