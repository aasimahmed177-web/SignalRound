// Aggregates for the overview. Every number here is a SQL aggregate over the
// published and flagged records; review items are counted separately. Given a
// preset slug, every aggregate narrows to the rows, sources, and runs of that preset.
// market() is the public half (what any visitor may read); overview() adds the admin's
// review queue, runs, and credits.

import { parseWindow, STAGES, windowLabel } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, desc, eq, gte, inArray, lte, notInArray, type SQL, sql } from "drizzle-orm";
import { FILING_HOSTS } from "@/lib/news";
import { listRounds, type RoundRow } from "@/lib/persist";
import { type TrendingMark, trendingTop } from "@/lib/trending";

const { fundingRounds, companies, investors, roundInvestors, runs, sources, roundSources } = schema;

const visible = inArray(fundingRounds.disposition, ["publish", "flagged"]);
/**
 * The windowed numbers count what the lanes caught. A history row (an earlier round promoted from a
 * dossier, lib/history.ts) carries its real, older date, so it rarely falls inside a window at all,
 * and it is left out here so one never inflates a week's count or its "new" figure.
 */
const caught = and(visible, eq(fundingRounds.history, false), inArray(fundingRounds.certainty, ["announced", "reported"]));

export interface Overview {
  window_days: number;
  /** The preset every aggregate was narrowed to, or null for all presets. */
  preset: string | null;
  rounds: number;
  new_rounds: number;
  total_usd_millions: number;
  with_amount: number;
  review_count: number;
  /** Of the review count, SEC Form D filings (preset form-d): a different kind of item from a news record. */
  review_filings: number;
  by_stage: Array<{ stage: string; count: number; usd_millions: number }>;
  by_week: Array<{ week: string; count: number }>;
  top_sectors: Array<{ sector: string; count: number }>;
  top_investors: Array<{ id: string; name: string; leads: number; total: number }>;
  top_sources: Array<{ host: string; count: number }>;
  recent_runs: Array<{
    id: string;
    lane: string;
    window: string | null;
    preset: string;
    started_at: string;
    /** Null while the run is in flight: the row was written when the run began. */
    finished_at: string | null;
    credits_estimated: number | null;
    credits_measured: number | null;
    records: number | null;
  }>;
  credits_30d: number;
}

/**
 * The human name of a run's lane, in two parts: the lane, then the qualifier that separates its
 * runs (the sweep's window, the monitor's 24h, the agent's play). Watch, Form D, and enrich take
 * no qualifier: the watch lane writes `week` to its window column, but that names nothing the
 * reader can act on, and every check reads the section pages as they stand.
 *
 * A sweep's month window is relative ("month-2"), so the label names the month it meant, measured
 * from the run's start ("Jul 2026"); the month to date stays "month".
 */
export function runLaneLabel(
  lane: string,
  window: string | null,
  preset: string | null,
  startedAt?: string | Date | null,
): { name: string; qualifier: string | null } {
  switch (lane) {
    case "sweep":
      return { name: "Sweep", qualifier: window === null ? null : sweepWindowLabel(window, startedAt) };
    case "monitor":
      return { name: "Monitor", qualifier: window ?? "24h" };
    case "manual":
      return { name: "Manual", qualifier: null };
    case "watch":
      return { name: "Watch sites", qualifier: null };
    case "formd":
      return { name: "Form D", qualifier: null };
    case "enrich":
      return { name: "Enrich", qualifier: null };
    case "trending":
      return { name: "Trending", qualifier: null };
    case "corroborate":
      return { name: "Corroborate", qualifier: "backlog" };
    case "agent":
      return { name: "Agent", qualifier: AGENT_QUALIFIER[preset ?? ""] ?? preset };
    case "dossiers":
      return { name: "Dossiers", qualifier: "backfill" };
    case "history":
      return { name: "History", qualifier: preset === "history-backfill" ? "backfill" : null };
    case "accuracy":
      return { name: "Accuracy", qualifier: null };
    default:
      return { name: lane, qualifier: window };
  }
}

/** The agent's plays, as the Runs page names them. */
const AGENT_QUALIFIER: Record<string, string> = { "deep-dive": "deep dive", "dossier-check": "dossier check", review: "review" };

function sweepWindowLabel(window: string, startedAt: string | Date | null | undefined): string {
  try {
    return windowLabel(parseWindow(window), startedAt ? new Date(startedAt) : new Date());
  } catch {
    // A window this build does not read (an older row, a hand edit) is shown as stored.
    return window;
  }
}

/**
 * The lanes whose `preset` column names no preset file (the agent's play, Form D's synthetic
 * `form-d`, Trending's `trending`): the lane label already carries it, so a table leaves the preset cell empty.
 */
export function laneOwnsPreset(lane: string): boolean {
  return lane === "agent" || lane === "formd" || lane === "dossiers" || lane === "trending" || lane === "history" || lane === "accuracy";
}

export interface ChargeableRun {
  started_at: string;
  finished_at: string | null;
  credits_estimated: number | null;
  credits_measured: number | null;
}

/** What a run is charged in a total: its measurement when no other measured run overlapped it, its estimate otherwise (the account balance is shared, so two overlapping measurements both count the same credits). */
export function chargeableCredits(run: ChargeableRun, all: ChargeableRun[]): { credits: number; overlapped: boolean } {
  // Still running: nothing is measured yet, so it charges nothing and marks nobody overlapped; its
  // estimate shows in the Est. column alone.
  if (run.finished_at === null) return { credits: 0, overlapped: false };
  if (run.credits_measured === null) return { credits: run.credits_estimated ?? 0, overlapped: false };
  const start = new Date(run.started_at).getTime();
  const end = new Date(run.finished_at ?? run.started_at).getTime();
  const overlapped = all.some((other) => {
    if (other === run || other.credits_measured === null) return false;
    const s = new Date(other.started_at).getTime();
    const e = new Date(other.finished_at ?? other.started_at).getTime();
    return s <= end && start <= e;
  });
  return { credits: overlapped ? (run.credits_estimated ?? 0) : run.credits_measured, overlapped };
}

/** A week key (YYYY-MM-DD) as a short axis label: Jun 15. */
export function weekLabel(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export async function overview(handle: Db, windowDays = 30, presetSlug?: string): Promise<Overview> {
  const since = isoDaysAgo(windowDays);
  // Every round-side condition carries the preset when one is given; sources and runs
  // narrow through their own preset columns below.
  const ofPreset = presetSlug ? eq(fundingRounds.presetSlug, presetSlug) : undefined;
  const inWindow = and(caught, gte(fundingRounds.announcedOn, since), ofPreset);

  const totalsQ = handle
    .select({
      rounds: sql<number>`count(*)::int`,
      new_rounds: sql<number>`count(*) filter (where ${fundingRounds.status} = 'new')::int`,
      total_usd: sql<number>`coalesce(sum(${fundingRounds.amountUsdMillions}), 0)::float`,
      with_amount: sql<number>`count(${fundingRounds.amountUsdMillions})::int`,
    })
    .from(fundingRounds)
    .where(inWindow);

  const reviewQ = handle
    .select({
      count: sql<number>`count(*)::int`,
      filings: sql<number>`count(*) filter (where ${fundingRounds.presetSlug} = 'form-d')::int`,
    })
    .from(fundingRounds)
    .where(and(eq(fundingRounds.disposition, "review"), ofPreset));

  // Every stage with a round in the window, in STAGES order (Pre-seed first, Growth last),
  // so the panel reads as a ladder whatever presets are switched on.
  const byStageQ = handle
    .select({
      stage: fundingRounds.stage,
      count: sql<number>`count(*)::int`,
      usd: sql<number>`coalesce(sum(${fundingRounds.amountUsdMillions}), 0)::float`,
    })
    .from(fundingRounds)
    .where(inWindow)
    .groupBy(fundingRounds.stage);

  const byWeekQ = handle
    .select({
      week: sql<string>`to_char(date_trunc('week', ${fundingRounds.announcedOn}::date), 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(fundingRounds)
    .where(and(caught, gte(fundingRounds.announcedOn, isoDaysAgo(12 * 7)), ofPreset))
    .groupBy(sql`date_trunc('week', ${fundingRounds.announcedOn}::date)`)
    .orderBy(sql`date_trunc('week', ${fundingRounds.announcedOn}::date)`);

  const topSectorsQ = handle
    .select({ sector: companies.sector, count: sql<number>`count(*)::int` })
    .from(fundingRounds)
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    .where(and(inWindow, sql`${companies.sector} is not null`))
    .groupBy(companies.sector)
    .orderBy(desc(sql`count(*)`))
    .limit(8);

  const topInvestorsQ = handle
    .select({
      id: investors.id,
      name: investors.name,
      leads: sql<number>`count(*) filter (where ${roundInvestors.role} = 'lead')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(roundInvestors)
    .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
    .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
    .where(inWindow)
    .groupBy(investors.id, investors.name)
    .orderBy(desc(sql`count(*) filter (where ${roundInvestors.role} = 'lead')`), desc(sql`count(*)`))
    .limit(8);

  // A source has no preset of its own; under a preset it counts when one of that preset's rounds cites it.
  const sourceOfPreset = presetSlug
    ? sql`exists (select 1 from ${roundSources} rs join ${fundingRounds} f on f.id = rs.round_id where rs.source_id = ${sources.id} and f.preset_slug = ${presetSlug})`
    : undefined;
  const topSourcesQ = handle
    .select({ host: sources.host, count: sql<number>`count(*)::int` })
    .from(sources)
    .where(and(gte(sources.fetchedAt, new Date(Date.now() - windowDays * 86_400_000)), sourceOfPreset))
    .groupBy(sources.host)
    .orderBy(desc(sql`count(*)`))
    .limit(8);

  const runOfPreset = presetSlug ? eq(runs.presetSlug, presetSlug) : undefined;
  const recentRunsQ = handle
    .select({
      id: runs.id,
      lane: runs.lane,
      window: runs.window,
      preset: runs.presetSlug,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      creditsEstimated: runs.creditsEstimated,
      creditsMeasured: runs.creditsMeasured,
      counts: runs.counts,
    })
    .from(runs)
    .where(runOfPreset)
    .orderBy(desc(runs.startedAt))
    .limit(6);

  const chargeableQ = handle
    .select({
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      creditsEstimated: runs.creditsEstimated,
      creditsMeasured: runs.creditsMeasured,
    })
    .from(runs)
    .where(and(gte(runs.startedAt, new Date(Date.now() - 30 * 86_400_000)), runOfPreset));

  // Nine independent reads. Over Neon's HTTP driver each is its own round trip, so awaiting them
  // one by one put nine network hops on every overview; together they cost about one.
  const [[totals], [review], byStage, byWeek, topSectors, topInvestors, topSources, recentRuns, chargeableRows] = await Promise.all([
    totalsQ,
    reviewQ,
    byStageQ,
    byWeekQ,
    topSectorsQ,
    topInvestorsQ,
    topSourcesQ,
    recentRunsQ,
    chargeableQ,
  ]);
  const stageOrder = (s: string) => {
    const i = (STAGES as readonly string[]).indexOf(s);
    return i < 0 ? STAGES.length : i;
  };
  byStage.sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage));
  const chargeableRuns: ChargeableRun[] = chargeableRows.map((r) => ({
    started_at: r.startedAt.toISOString(),
    finished_at: r.finishedAt?.toISOString() ?? null,
    credits_estimated: r.creditsEstimated,
    credits_measured: r.creditsMeasured,
  }));

  return {
    window_days: windowDays,
    preset: presetSlug ?? null,
    rounds: totals?.rounds ?? 0,
    new_rounds: totals?.new_rounds ?? 0,
    total_usd_millions: Math.round(totals?.total_usd ?? 0),
    with_amount: totals?.with_amount ?? 0,
    review_count: review?.count ?? 0,
    review_filings: review?.filings ?? 0,
    by_stage: byStage.map((r) => ({ stage: r.stage, count: r.count, usd_millions: Math.round(r.usd) })),
    by_week: byWeek.map((r) => ({ week: r.week, count: r.count })),
    top_sectors: topSectors.map((r) => ({ sector: r.sector ?? "", count: r.count })),
    top_investors: topInvestors.map((r) => ({ id: r.id, name: r.name, leads: r.leads, total: r.total })),
    top_sources: topSources.map((r) => ({ host: r.host, count: r.count })),
    recent_runs: recentRuns.map((r) => ({
      id: r.id,
      lane: r.lane,
      window: r.window,
      preset: r.preset,
      started_at: r.startedAt.toISOString(),
      finished_at: r.finishedAt?.toISOString() ?? null,
      credits_estimated: r.creditsEstimated,
      credits_measured: r.creditsMeasured,
      records: (r.counts as Record<string, number> | null)?.records ?? (r.counts as Record<string, number> | null)?.companies ?? null,
    })),
    credits_30d: chargeableRuns.reduce((n, r) => n + chargeableCredits(r, chargeableRuns).credits, 0),
  };
}

export interface DemoStats {
  rounds_7d: number;
  usd_7d: number;
  /** Runs that started in the last 24 hours, every lane. */
  runs_24h: number;
}

/**
 * The three numbers on the public demo's front door: a week of the store, a day of runs. The week
 * is overview(7)'s totals row (the same filter, the same rounding) read on its own, so the front
 * door does not pay for the eight panels of the overview it never shows.
 */
export async function demoStats(handle: Db): Promise<DemoStats> {
  const [[week], [r]] = await Promise.all([
    handle
      .select({
        rounds: sql<number>`count(*)::int`,
        total_usd: sql<number>`coalesce(sum(${fundingRounds.amountUsdMillions}), 0)::float`,
      })
      .from(fundingRounds)
      .where(and(caught, gte(fundingRounds.announcedOn, isoDaysAgo(7)))),
    handle
      .select({ n: sql<number>`count(*)::int` })
      .from(runs)
      .where(gte(runs.startedAt, new Date(Date.now() - 86_400_000))),
  ]);
  return { rounds_7d: week?.rounds ?? 0, usd_7d: Math.round(week?.total_usd ?? 0), runs_24h: r?.n ?? 0 };
}

/** A span of announced days, inclusive; `until` null means open-ended, up to today and past it. */
export interface MarketSpan {
  since: string;
  until: string | null;
}

export interface MarketTotals extends MarketSpan {
  rounds: number;
  usd_millions: number;
  with_amount: number;
}

export interface Market {
  /** The preset every aggregate was narrowed to, or null for all presets. */
  preset: string | null;
  /** The last 7 days, the same span demoStats and the landing page call this week. */
  week: MarketTotals;
  /** The 8 days before `week`, the same length, so the comparison is like for like. */
  prev_week: MarketTotals;
  month: MarketTotals;
  prev_month: MarketTotals;
  /** Twelve Monday-to-Sunday weeks, oldest first, zero-filled, the current week last. */
  by_week: Array<{ week: string; until: string; count: number; usd_millions: number }>;
  by_stage: Array<{ stage: string; count: number; usd_millions: number }>;
  top_sectors: Array<{ sector: string; count: number }>;
  /** Investors ranked by the rounds they led in the month; `usd_millions` is their lead share, each round split evenly between its leads. */
  top_leads: Array<{ id: string; name: string; leads: number; usd_millions: number }>;
  /** Publishers ranked by the month's rounds they reported (filings left out). */
  top_publishers: Array<{ host: string; count: number }>;
  /**
   * The day the store first saw a news round the feed lists (every preset), or null when it has
   * none. A round announced before it was found by a backfill sweep, so earlier spans undercount.
   */
  watching_since: string | null;
}

const DAY_MS = 86_400_000;

function isoDay(now: Date, daysAgo: number): string {
  return new Date(now.getTime() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The spans the market view compares. The week starts on the day demoStats counts from, so the
 * landing page, the demo hero, and this page quote one number; each earlier span has the same
 * number of days as the one it is compared with.
 */
export function marketSpans(now: Date = new Date()): Record<"week" | "prev_week" | "month" | "prev_month", MarketSpan> {
  return {
    week: { since: isoDay(now, 7), until: null },
    prev_week: { since: isoDay(now, 15), until: isoDay(now, 8) },
    month: { since: isoDay(now, 30), until: null },
    prev_month: { since: isoDay(now, 61), until: isoDay(now, 31) },
  };
}

/** Twelve weeks, Monday to Sunday (UTC), oldest first, ending with the week holding `now`. */
export function weekGrid(now: Date = new Date(), weeks = 12): MarketSpan[] {
  const monday = new Date(now);
  monday.setUTCHours(12, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const out: MarketSpan[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(monday.getTime() - i * 7 * DAY_MS);
    out.push({ since: start.toISOString().slice(0, 10), until: new Date(start.getTime() + 6 * DAY_MS).toISOString().slice(0, 10) });
  }
  return out;
}

/**
 * The public market view: only rounds the feed lists (publish and flagged), and only news rounds,
 * never a history row, so every figure matches the feed filtered to the same days (the page links
 * each one there with history=exclude). Nothing here reads the review queue, runs, or credits.
 */
export async function market(handle: Db, presetSlug?: string, now: Date = new Date()): Promise<Market> {
  const spans = marketSpans(now);
  const grid = weekGrid(now);
  const ofPreset = presetSlug ? eq(fundingRounds.presetSlug, presetSlug) : undefined;
  const inMonth = and(caught, gte(fundingRounds.announcedOn, spans.month.since), ofPreset);
  const within = (s: MarketSpan) =>
    s.until
      ? sql`${fundingRounds.announcedOn} >= ${s.since} and ${fundingRounds.announcedOn} <= ${s.until}`
      : sql`${fundingRounds.announcedOn} >= ${s.since}`;
  const keys = ["week", "prev_week", "month", "prev_month"] as const;

  // One scan over the last two months answers all four spans.
  const totalsQ = handle
    .select(
      Object.fromEntries(
        keys.flatMap((k) => [
          [`${k}_rounds`, sql<number>`count(*) filter (where ${within(spans[k])})::int`],
          [`${k}_usd`, sql<number>`coalesce(sum(${fundingRounds.amountUsdMillions}) filter (where ${within(spans[k])}), 0)::float`],
          [`${k}_with`, sql<number>`count(${fundingRounds.amountUsdMillions}) filter (where ${within(spans[k])})::int`],
        ]),
      ) as Record<string, SQL<number>>,
    )
    .from(fundingRounds)
    .where(and(caught, gte(fundingRounds.announcedOn, spans.prev_month.since), ofPreset));

  const weekKey = sql<string>`to_char(date_trunc('week', ${fundingRounds.announcedOn}::date), 'YYYY-MM-DD')`;
  const byWeekQ = handle
    .select({
      week: weekKey,
      count: sql<number>`count(*)::int`,
      usd: sql<number>`coalesce(sum(${fundingRounds.amountUsdMillions}), 0)::float`,
    })
    .from(fundingRounds)
    .where(and(caught, gte(fundingRounds.announcedOn, grid[0].since), lte(fundingRounds.announcedOn, grid[grid.length - 1].until ?? "")))
    .groupBy(weekKey);

  const byStageQ = handle
    .select({
      stage: fundingRounds.stage,
      count: sql<number>`count(*)::int`,
      usd: sql<number>`coalesce(sum(${fundingRounds.amountUsdMillions}), 0)::float`,
    })
    .from(fundingRounds)
    .where(inMonth)
    .groupBy(fundingRounds.stage);

  const topSectorsQ = handle
    .select({ sector: companies.sector, count: sql<number>`count(*)::int` })
    .from(fundingRounds)
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    // "other" is where the classifier puts what fits no sector: not a sector a reader can act on.
    .where(and(inMonth, sql`${companies.sector} is not null`, sql`${companies.sector} <> 'other'`))
    .groupBy(companies.sector)
    .orderBy(desc(sql`count(*)`), companies.sector)
    .limit(8);

  // Each led round's amount split evenly between its leads, as on the investor page (lib/investor.ts):
  // one of ten co-leads on a $65B round is credited $6.5B, and the list never counts a round ten times.
  const leadShareUsd = sql<number>`coalesce(sum(${fundingRounds.amountUsdMillions} / (select count(*) from round_investors l where l.round_id = ${fundingRounds.id} and l.role = 'lead')), 0)::float`;
  const topLeadsQ = handle
    .select({
      id: investors.id,
      name: investors.name,
      leads: sql<number>`count(distinct ${fundingRounds.id})::int`,
      usd: leadShareUsd,
    })
    .from(roundInvestors)
    .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
    .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
    .where(and(inMonth, eq(roundInvestors.role, "lead")))
    .groupBy(investors.id, investors.name)
    .orderBy(desc(sql`count(distinct ${fundingRounds.id})`), desc(leadShareUsd), investors.name)
    .limit(8);

  const topPublishersQ = handle
    .select({ host: sources.host, count: sql<number>`count(distinct ${fundingRounds.id})::int` })
    .from(roundSources)
    .innerJoin(sources, eq(sources.id, roundSources.sourceId))
    .innerJoin(fundingRounds, eq(fundingRounds.id, roundSources.roundId))
    .where(and(inMonth, notInArray(sources.host, [...FILING_HOSTS])))
    .groupBy(sources.host)
    .orderBy(desc(sql`count(distinct ${fundingRounds.id})`), sources.host)
    .limit(8);

  const watchingQ = handle
    .select({ since: sql<string | null>`to_char(min(${fundingRounds.firstSeenAt}) at time zone 'UTC', 'YYYY-MM-DD')` })
    .from(fundingRounds)
    .where(caught);

  const [[totals], byWeek, byStage, topSectors, topLeads, topPublishers, [watching]] = await Promise.all([
    totalsQ,
    byWeekQ,
    byStageQ,
    topSectorsQ,
    topLeadsQ,
    topPublishersQ,
    watchingQ,
  ]);
  const t = (totals ?? {}) as Record<string, number>;
  const total = (k: (typeof keys)[number]): MarketTotals => ({
    ...spans[k],
    rounds: t[`${k}_rounds`] ?? 0,
    usd_millions: Math.round(t[`${k}_usd`] ?? 0),
    with_amount: t[`${k}_with`] ?? 0,
  });
  const weeks = new Map(byWeek.map((w) => [w.week, w]));
  byStage.sort((a, b) => stageIndex(a.stage) - stageIndex(b.stage));
  return {
    preset: presetSlug ?? null,
    week: total("week"),
    prev_week: total("prev_week"),
    month: total("month"),
    prev_month: total("prev_month"),
    by_week: grid.map((g) => ({
      week: g.since,
      until: g.until ?? g.since,
      count: weeks.get(g.since)?.count ?? 0,
      usd_millions: Math.round(weeks.get(g.since)?.usd ?? 0),
    })),
    by_stage: byStage.map((r) => ({ stage: r.stage, count: r.count, usd_millions: Math.round(r.usd) })),
    top_sectors: topSectors.map((r) => ({ sector: r.sector ?? "", count: r.count })),
    top_leads: topLeads.map((r) => ({ id: r.id, name: r.name, leads: r.leads, usd_millions: Math.round(r.usd) })),
    top_publishers: topPublishers.map((r) => ({ host: r.host, count: r.count })),
    watching_since: watching?.since ?? null,
  };
}

/**
 * Whether a span can stand as a baseline: the store was already finding rounds when it began. A
 * span before that holds only what backfill sweeps turned up, so a change against it measures
 * the instance starting up, not the market.
 */
export function comparable(span: MarketSpan, watchingSince: string | null): boolean {
  return watchingSince === null || watchingSince <= span.since;
}

/** A stage's place on the ladder (Pre-seed first, Growth last); an unknown stage sorts after. */
function stageIndex(stage: string): number {
  const i = (STAGES as readonly string[]).indexOf(stage);
  return i < 0 ? STAGES.length : i;
}

/**
 * How a figure moved against the span before it, as the change and the rest of the phrase, so a
 * phone can show the change alone: ["Up 24%", "on last week"], ["Level", "with last week"],
 * ["None", "last week"].
 */
export function versusParts(current: number, previous: number, against: string): [string, string] {
  if (previous === 0) return ["None", current === 0 ? `${against} either` : against];
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return ["Level", `with ${against}`];
  return [`${pct > 0 ? "Up" : "Down"} ${Math.abs(pct)}%`, `on ${against}`];
}

/** versusParts as one phrase: "Up 24% on last week". */
export function versus(current: number, previous: number, against: string): string {
  return versusParts(current, previous, against).join(" ");
}

/**
 * The feed filtered to what a market figure counts: the Latest view (a bare /feed opens Trending
 * on the hosted instance), the figure's days, and history=exclude, since a date range otherwise
 * brings in earlier rounds the figure leaves out. Other filters (stage, sector, source, sort,
 * preset) pass through as given; empty ones are dropped.
 */
export function marketFeedHref(span: MarketSpan | null, filters: Record<string, string | undefined> = {}): string {
  const qs = new URLSearchParams();
  if (!filters.sort) qs.set("view", "latest");
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  if (span) {
    qs.set("since", span.since);
    if (span.until) qs.set("until", span.until);
    qs.set("history", "exclude");
  }
  return `/feed?${qs}`;
}

/** Everything the Overview shows every viewer: the aggregates, the week's biggest rounds, and what is trending. */
export interface MarketView {
  market: Market;
  /** The week's five largest rounds by stated amount, largest first; a round with no amount is left out. */
  biggest: RoundRow[];
  /** The Trending lane's top five under the preset, and how many rounds the Trending view lists. */
  trending: { rounds: Array<RoundRow & { trending: TrendingMark }>; total: number };
}

/** The Overview's public read, in three parallel parts; lib/cached.ts shares one entry of it among visitors. */
export async function marketView(handle: Db, presetSlug?: string, now: Date = new Date()): Promise<MarketView> {
  const week = marketSpans(now).week;
  const [m, biggest, trending] = await Promise.all([
    market(handle, presetSlug, now),
    // The rounds that closed, as the Capital figure above them counts them: an expected round is not raised money.
    listRounds(handle, { since: week.since, sort: "amount", history: "exclude", certainty: "closed", preset: presetSlug, limit: 5 }),
    trendingTop(handle, 5, presetSlug, now),
  ]);
  return { market: m, biggest: biggest.rows.filter((r) => r.amount.usd_millions !== null), trending };
}
