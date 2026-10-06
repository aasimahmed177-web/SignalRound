// The coverage ladder as data. docs/coverage.md is the table for people; this is the same
// table for the program: one plan per rung, the estimate that prices a plan from the rate
// card, and the clock that says whether an hourly cron tick is a sweep hour for the rung.

import type { Preset, Window } from "@fireround/core";
import {
  brandingCredits,
  effectiveSources,
  extractionCredits,
  INVESTOR_DOMAINS_PER_RUN,
  investorDomainCredits,
  investorHomepageCredits,
  JUDGE_CREDITS_PER_RECORD,
  pageCredits,
  RATE,
  searchCredits,
  WATCH_READ_CREDITS,
  X_ANNOUNCEMENT_QUERIES,
  X_PROFILE_READ_CREDITS,
  xProfileCandidates,
} from "@fireround/core";
import { z } from "zod";

export const COVERAGE_TIERS = ["lite", "standard", "deep", "max"] as const;
export type CoverageTier = (typeof COVERAGE_TIERS)[number];

const SweepCadence = z.enum(["weekly", "daily", "twice_daily", "hourly"]);
export type SweepCadence = z.infer<typeof SweepCadence>;
const SweepWindow = z.enum(["day", "week"]);
const SearchSource = z.enum(["news", "web"]);
const SiteCadence = z.enum(["daily", "hourly"]);
/** Natural-language schedules Firecrawl's monitor accepts as `schedule.text`. */
const MonitorSchedule = z.enum(["daily at 9am", "every 6 hours", "hourly"]);
export type MonitorSchedule = z.infer<typeof MonitorSchedule>;
const Corroboration = z.enum(["off", "new", "new_and_updated", "all"]);
export type Corroboration = z.infer<typeof Corroboration>;
const EnrichmentDepth = z.enum(["homepage", "homepage_pricing", "plus_corroboration", "weekly_reenrich"]);
export type EnrichmentDepth = z.infer<typeof EnrichmentDepth>;
/** Alexandria lookups per verified company: off, the YC catalogue, or YC plus FullEnrich and Apollo firmographics. */
const Alexandria = z.enum(["off", "yc", "yc_firmographics"]);
export type Alexandria = z.infer<typeof Alexandria>;

export const CoveragePlan = z.object({
  /** How often the cron sweeps and which windows it sweeps; "week" outside a weekly cadence runs at the Monday anchor only. */
  sweep: z.object({ cadence: SweepCadence, windows: z.array(SweepWindow).min(1) }),
  /** Search sources the rung allows; a preset can be narrower. */
  sources: z.array(SearchSource).min(1),
  /** Ceiling on the preset's X accounts read per sweep. */
  xAccountsMax: z.number().int().min(0).max(10),
  watchSites: z.object({ enabled: z.boolean(), cadence: SiteCadence }),
  formD: z.object({ enabled: z.boolean(), cadence: SiteCadence }),
  monitorSchedule: MonitorSchedule,
  corroboration: Corroboration,
  /** Read each new record's primary page once more with the record in hand, about 5 credits a record; publish requires its pass. */
  judge: z.boolean(),
  enrichment: EnrichmentDepth,
  /** Alexandria records for each company with a verified domain: YC founders and batch, and FullEnrich and Apollo firmographics on the wider rungs. */
  alexandria: Alexandria,
  /** The Trending lane: X search on each new visible round at four checkpoints, Hacker News, and an hourly rescore. */
  trending: z.boolean(),
  agent: z.object({
    gapFill: z.enum(["manual", "auto"]),
    deepDive: z.enum(["manual", "threshold", "all"]),
    deepDiveMinUsdMillions: z.number().nonnegative(),
    discoverySweep: z.enum(["off", "weekly", "daily"]),
  }),
});
export type CoveragePlan = z.infer<typeof CoveragePlan>;

export const CoverageOverrides = z.object({
  sweep: CoveragePlan.shape.sweep.partial().optional(),
  sources: CoveragePlan.shape.sources.optional(),
  xAccountsMax: CoveragePlan.shape.xAccountsMax.optional(),
  watchSites: CoveragePlan.shape.watchSites.partial().optional(),
  formD: CoveragePlan.shape.formD.partial().optional(),
  monitorSchedule: MonitorSchedule.optional(),
  corroboration: Corroboration.optional(),
  enrichment: EnrichmentDepth.optional(),
  alexandria: Alexandria.optional(),
  trending: z.boolean().optional(),
  judge: z.boolean().optional(),
  agent: CoveragePlan.shape.agent.partial().optional(),
});
export type CoverageOverrides = z.infer<typeof CoverageOverrides>;

/** What the settings table stores under `coverage`. */
export const CoverageSetting = z.object({ tier: z.enum(COVERAGE_TIERS), overrides: CoverageOverrides.default({}) });
export type CoverageSetting = z.infer<typeof CoverageSetting>;

export const DEFAULT_COVERAGE_SETTING: CoverageSetting = { tier: "lite", overrides: {} };

/** A stored value that no longer parses (an older shape, a hand edit) falls back to the default rung. */
export function parseCoverageSetting(value: unknown): CoverageSetting {
  const parsed = CoverageSetting.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_COVERAGE_SETTING };
}

export const COVERAGE_LABELS: Record<CoverageTier, string> = { lite: "Lite", standard: "Standard", deep: "Deep", max: "Max" };

/** One line per rung, from "What each rung buys" in docs/coverage.md. */
export const COVERAGE_BLURBS: Record<CoverageTier, string> = {
  lite: "A weekly picture of the market for the price of a few pages.",
  standard: "A daily desk: every round the news reports, dated and corroborated, with logos and pricing.",
  deep: "A research team: publisher sections and Form D catch what search misses, every review item is researched, every sizable round gets a dossier.",
  max: "The firehose: hourly everything, a dossier on every company, agent sweeps for the long tail.",
};

const TABLE: Record<CoverageTier, CoveragePlan> = {
  lite: {
    sweep: { cadence: "weekly", windows: ["week"] },
    sources: ["news"],
    xAccountsMax: 0,
    watchSites: { enabled: false, cadence: "daily" },
    formD: { enabled: false, cadence: "daily" },
    monitorSchedule: "daily at 9am",
    corroboration: "off",
    judge: true,
    enrichment: "homepage",
    alexandria: "off",
    trending: false,
    agent: { gapFill: "manual", deepDive: "manual", deepDiveMinUsdMillions: 10, discoverySweep: "off" },
  },
  standard: {
    sweep: { cadence: "daily", windows: ["day", "week"] },
    sources: ["news", "web"],
    xAccountsMax: 2,
    watchSites: { enabled: false, cadence: "daily" },
    formD: { enabled: false, cadence: "daily" },
    monitorSchedule: "daily at 9am",
    corroboration: "new",
    judge: true,
    enrichment: "homepage_pricing",
    alexandria: "yc",
    trending: false,
    agent: { gapFill: "manual", deepDive: "manual", deepDiveMinUsdMillions: 10, discoverySweep: "off" },
  },
  deep: {
    sweep: { cadence: "twice_daily", windows: ["day"] },
    sources: ["news", "web"],
    xAccountsMax: 5,
    watchSites: { enabled: true, cadence: "daily" },
    formD: { enabled: true, cadence: "daily" },
    monitorSchedule: "every 6 hours",
    corroboration: "new_and_updated",
    judge: true,
    enrichment: "plus_corroboration",
    alexandria: "yc_firmographics",
    trending: true,
    agent: { gapFill: "auto", deepDive: "threshold", deepDiveMinUsdMillions: 10, discoverySweep: "weekly" },
  },
  max: {
    sweep: { cadence: "hourly", windows: ["day"] },
    sources: ["news", "web"],
    xAccountsMax: 10,
    watchSites: { enabled: true, cadence: "hourly" },
    formD: { enabled: true, cadence: "hourly" },
    monitorSchedule: "hourly",
    corroboration: "all",
    judge: true,
    enrichment: "weekly_reenrich",
    alexandria: "yc_firmographics",
    trending: true,
    agent: { gapFill: "auto", deepDive: "all", deepDiveMinUsdMillions: 10, discoverySweep: "daily" },
  },
};

export function coverageFor(tier: CoverageTier): CoveragePlan {
  return structuredClone(TABLE[tier]);
}

/** Spread that ignores undefined, so a partial override never blanks a field. */
function merge<T extends object>(base: T, over: Partial<T> | undefined): T {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** The rung's plan with the stored overrides on top. */
export function resolveCoverage(setting: CoverageSetting): CoveragePlan {
  const base = coverageFor(setting.tier);
  const o = setting.overrides;
  return {
    sweep: merge(base.sweep, o.sweep),
    sources: o.sources ?? base.sources,
    xAccountsMax: o.xAccountsMax ?? base.xAccountsMax,
    watchSites: merge(base.watchSites, o.watchSites),
    formD: merge(base.formD, o.formD),
    monitorSchedule: o.monitorSchedule ?? base.monitorSchedule,
    corroboration: o.corroboration ?? base.corroboration,
    judge: o.judge ?? base.judge,
    enrichment: o.enrichment ?? base.enrichment,
    alexandria: o.alexandria ?? base.alexandria,
    trending: o.trending ?? base.trending,
    agent: merge(base.agent, o.agent),
  };
}

/** The overrides that turn a rung's plan into `plan`: only the fields that differ, nested fields one by one. */
export function diffCoverage(tier: CoverageTier, plan: CoveragePlan): CoverageOverrides {
  const base = coverageFor(tier);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(base) as Array<keyof CoveragePlan>) {
    const b = base[key];
    const p = plan[key];
    if (JSON.stringify(b) === JSON.stringify(p)) continue;
    if (Array.isArray(b) || typeof b !== "object") {
      out[key] = p;
      continue;
    }
    const nested: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p as object)) if ((b as Record<string, unknown>)[k] !== v) nested[k] = v;
    out[key] = nested;
  }
  return CoverageOverrides.parse(out);
}

// The sweep clock. Vercel calls /api/cron/sweep every hour; these decide which hours count.

/** The hour every rung sweeps at, and the second hour Deep adds. */
export const SWEEP_HOUR_UTC = 6;
const SECOND_SWEEP_HOUR_UTC = 18;
/** Week windows run on Monday, the weekly anchor (getUTCDay: 0 is Sunday). */
const WEEKLY_ANCHOR_DAY = 1;

export interface SweepDue {
  due: boolean;
  /** The windows to sweep at this hour; empty when not due. */
  windows: Window[];
  /** The next due hour after `at`, ISO. */
  next: string;
}

function windowsAt(plan: CoveragePlan, at: Date): Window[] {
  const hour = at.getUTCHours();
  const anchor = at.getUTCDay() === WEEKLY_ANCHOR_DAY && hour === SWEEP_HOUR_UTC;
  const { cadence, windows } = plan.sweep;
  const hourDue = cadence === "hourly" || hour === SWEEP_HOUR_UTC || (cadence === "twice_daily" && hour === SECOND_SWEEP_HOUR_UTC);
  if (!hourDue) return [];
  if (cadence === "weekly" && !anchor) return [];
  return windows.filter((w) => w === "day" || anchor);
}

/** Whether the hour containing `at` is a sweep hour for the plan, which windows it sweeps, and when the next one is. */
export function sweepDue(plan: CoveragePlan, at: Date): SweepDue {
  const windows = windowsAt(plan, at);
  const next = new Date(at);
  next.setUTCMinutes(0, 0, 0);
  do next.setUTCHours(next.getUTCHours() + 1);
  while (windowsAt(plan, next).length === 0);
  return { due: windows.length > 0, windows, next: next.toISOString() };
}

// The estimate. Every constant is an assumption; the comment says what it stands on.

/** A month for pricing: thirty days, four and a third weeks. */
const DAYS_PER_MONTH = 30;
const WEEKS_PER_MONTH = DAYS_PER_MONTH / 7;
/** Sweep runs a month per cadence, for the day window; the week window runs once a week whatever the cadence. */
const DAY_SWEEPS_PER_MONTH: Record<SweepCadence, number> = { weekly: WEEKS_PER_MONTH, daily: 30, twice_daily: 60, hourly: 720 };
/** Unique pages as a share of raw search results: the 60 to 75 percent the Presets estimate already assumes. */
const UNIQUE_PAGE_SHARE = { low: 0.6, high: 0.75 };
/** A day window fills about half the result slots a week window does: fewer matching articles exist inside 24 hours. */
const DAY_WINDOW_RESULT_SHARE = 0.5;
/** New records one week-window sweep yields for one preset; measured 19 to 24 on the three shipped presets (2026-09-17). The 60 before it came from a month window. */
const RECORDS_PER_WEEK_SWEEP = 25;
/**
 * Read-back before publish, per record: the judge reads one page at JUDGE_CREDITS_PER_RECORD, and
 * the reconciler reads about four source pages at a credit each plus a second pass for rows
 * corroboration grew. Measured 3.7 to 4.5 a record on the same sweeps.
 */
const VERIFICATION_CREDITS_PER_RECORD = JUDGE_CREDITS_PER_RECORD;
/**
 * New records a day for one preset by cadence. A second pass a day buys freshness, not recall;
 * reading result lists around the clock catches what rolls off the top ten between passes.
 */
const RECORDS_PER_DAY: Record<SweepCadence, number> = { weekly: 0, daily: 10, twice_daily: 10, hourly: 20 };
/** New records a day the agent discovery sweep adds: the long tail search does not rank. */
const DISCOVERY_RECORDS_PER_DAY: Record<CoveragePlan["agent"]["discoverySweep"], number> = { off: 0, weekly: 1, daily: 10 };
/** One monitor check: what Firecrawl quotes for the default preset's 8-query search target with a judge. */
const MONITOR_CHECK_CREDITS = 130;
const MONITOR_CHECKS_PER_MONTH: Record<MonitorSchedule, number> = { "daily at 9am": 30, "every 6 hours": 120, hourly: 720 };
/** Corroboration of one record: one search and three more articles extracted. */
const CORROBORATION_CREDITS = searchCredits(10) + extractionCredits(3);
/** Records corroborated as a multiple of new records: updated ones add about a third; "all" re-corroborates every record once more in the month. */
const CORROBORATION_MULTIPLE: Record<Corroboration, number> = { off: 0, new: 1, new_and_updated: 1.3, all: 2 };
/** Homepage enrichment: one scrape with a JSON format. About half the companies need a five-result website search first. */
const HOMEPAGE_CREDITS = extractionCredits(1);
const WEBSITE_SEARCH_SHARE = 0.5;
const WEBSITE_SEARCH_CREDITS = searchCredits(5);
/** The homepage must verify as the record's company; about one company in five fails on the first candidate and reads a second. */
const VERIFICATION_RETRY_SHARE = 0.2;
/** Six companies in ten link a pricing page; each is one more extraction. */
const PRICING_PAGE_SHARE = 0.6;
/**
 * Investors a new record names that the store has not searched for yet: 1,565 distinct investors
 * across 347 companies (2026-09-22) is 4.5 a company, and repeats grow as the store fills. A pass
 * resolves INVESTOR_DOMAINS_PER_RUN of them at most.
 */
const NEW_INVESTORS_PER_RECORD = 3;
/**
 * One investor's resolution as it usually runs: a minimum-charge search and one homepage verdict
 * (the page plus JSON), which also reads the logo. A hard one spends a second search, more verdicts,
 * or a press page; an individual often spends only the search. The usual case is the estimate. The
 * Lite rung reads no verdict: the search and a branding-only logo read, 25 a pass at most.
 */
function investorCredits(plan: CoveragePlan, investors: number): number {
  if (plan.enrichment === "homepage") return investorDomainCredits(investors) + brandingCredits(investors);
  return investorDomainCredits(investors) + investorHomepageCredits(investors);
}

/** Investors a pass resolves at most on this rung (workflows/enrich.ts). */
function investorsPerRun(plan: CoveragePlan): number {
  return plan.enrichment === "homepage" ? LITE_INVESTORS_PER_RUN : INVESTOR_DOMAINS_PER_RUN;
}
const LITE_INVESTORS_PER_RUN = 25;
/** Weekly re-enrichment reads every company's homepage again each week of the month. */
const REENRICH_PASSES_PER_MONTH = WEEKS_PER_MONTH;
/**
 * Alexandria per company with a verified domain: the YC search plus a company read on about a third
 * of them; FullEnrich adds its lookup (5), and Apollo 30 for each company it matches, a miss free. It
 * matched 21 of 26 visible companies in the September 2026 measurement, so 24 a company.
 */
const APOLLO_CREDITS_PER_COMPANY = 24;
const ALEXANDRIA_CREDITS: Record<Alexandria, number> = { off: 0, yc: 7, yc_firmographics: 12 + APOLLO_CREDITS_PER_COMPANY };
/**
 * The funding events Apollo lists that the store lacks, queued as history leads: 18 across the same
 * 26 companies (a specific equity stage the store, the ledger, and the dossier did not already know),
 * each searched and verified at a prior round's price (HISTORY_CREDITS_PER_PRIOR).
 */
const APOLLO_LEADS_PER_COMPANY = 0.7;
/** The Research button's cap per review item; about one record in ten lands in review. */
const GAP_FILL_CREDITS = 400;
const REVIEW_SHARE = 0.1;
/**
 * One checked dossier per company: the agent at effort high (capped at 2,500) plus the check's page
 * reads, about 17. Effort medium measured 82 a dive on average over 68 dives; high is priced at
 * about three times that until the backfill measures it (lib/deepdive.ts DEEP_DIVE_CREDITS). At the
 * threshold rung about three rounds in ten are above $10M.
 */
const DEEP_DIVE_CREDITS = 300;
const DEEP_DIVE_THRESHOLD_SHARE = 0.3;
/**
 * Each checked dossier's prior rounds are looked for and, when found, promoted to history rounds
 * (lib/history.ts): a map of the company's site, one search, and one to five page reads until one
 * states the round, then the read-back. Checked dossiers of visible companies listed 0.8 prior rounds
 * each (147 over 183, September 2026). Two local proofs over the same 13 prior rounds priced a
 * promoted round at 11 to 21 credits (16 on average) and one with no source (five pages read) at 28
 * to 30; a round too vague to search is free.
 */
const HISTORY_PRIORS_PER_DOSSIER = 0.8;
const HISTORY_CREDITS_PER_PRIOR = { low: 11, high: 30 };
/**
 * On "all", each sweep tick also works up to two visible companies still without a checked dossier.
 * Once the backlog is drained (the backfill does it in one pass) this is near zero, so the low end
 * is zero and the high end is two dives every tick.
 */
const BACKLOG_DIVES_PER_TICK = 2;
/** One agent discovery sweep over a window. */
const DISCOVERY_SWEEP_CREDITS = 1500;
/**
 * Watch sites: each preset's publisher pages, one links read per check. New URLs a day per site: the
 * seven original sections gave about twenty each; the daily aggregators give up to forty and the
 * regional desks five to ten (September 2026), so twelve is the average across the 28 sites.
 */
const WATCH_NEW_PAGES_PER_SITE_PER_DAY = 12;
const SITE_CHECKS_PER_DAY: Record<CoveragePlan["watchSites"]["cadence"], number> = { daily: 1, hourly: 24 };
/**
 * The watch lane's stage-free searches: each asks for 20 results from news and web (30 to 40 came back
 * on September 24, 2026, so 8 credits), every third hour on the hourly cadence and once a day on the
 * daily one; the six searches together turned up about 65 unread article URLs a day, each extracted once,
 * so each search is priced at about eleven new pages a day.
 */
const WATCH_QUERY_RUNS_PER_DAY: Record<CoveragePlan["watchSites"]["cadence"], number> = { daily: 1, hourly: 8 };
const WATCH_QUERY_CREDITS = searchCredits(40);
const WATCH_QUERY_NEW_PAGES_PER_QUERY_PER_DAY = 11;
/**
 * The X announcements lane: twelve queries, each a `site:x.com` search (20 results, 4 credits) and a
 * search of X's own index through Alexandria (30 credits), on every run it searches (every quarter hour
 * on Max, once a day on Deep), and for each new lead a search for its article (2 credits) on its schedule (six
 * for a status post; profile pages are no longer leads) with the pages that name the company read once.
 * Measured over 48 hours of posts (September 24, 2026): about 25 new leads a day, two in five with pages
 * worth reading, two or three pages each. A founder's post that a second account confirms gets its bio
 * read through the X scrape (30 credits) and the company's homepage links (1), a few a day.
 */
const X_ANNOUNCEMENT_RUNS_PER_DAY: Record<CoveragePlan["watchSites"]["cadence"], number> = { daily: 1, hourly: 96 };
/** Each query also searches X's own index through Alexandria's X provider: 30 credits a call. */
const X_LIVE_SEARCH_CREDITS = 30;
const X_ANNOUNCEMENT_SEARCHES = X_ANNOUNCEMENT_QUERIES.length;
const X_LEADS_PER_DAY = { low: 15, high: 40 };
const X_ARTICLE_SEARCHES_PER_LEAD = { low: 3, high: 6 };
const X_ARTICLE_PAGES_PER_LEAD = { low: 1, high: 3 };
const X_FOUNDER_CHECKS_PER_DAY = { low: 1, high: 5 };
/** EDGAR full-text search is not a Firecrawl call. */
const FORM_D_CREDITS = 0;
/**
 * The Trending lane, per new record: four search checkpoints (first seen, +6h, +24h, +48h), two
 * or three `site:x.com` searches each (the name with funding words, the name with the amount, the
 * company's handle when one verifies), and one links-only homepage read for the handle. The spike
 * measured 3.4 credits a search (a search bills per ten results; four in five came back full at 20)
 * and a handle on about two companies in three, so 2.7 searches a checkpoint; the high end prices
 * three full searches every time. Records that land in review are never followed, which the low
 * end takes off at REVIEW_SHARE. Hacker News (Algolia) is free.
 */
const TRENDING_CHECKPOINTS = 4;
const TRENDING_SEARCHES = { low: 2.7, high: 3 };
const TRENDING_SEARCH_CREDITS = { low: 3.4, high: searchCredits(20) };
const TRENDING_HANDLE_CREDITS = RATE.scrapePage;
/**
 * The showcase: likes and reposts for the top three posts of each labelled round (five at most)
 * through the X scrape (30 credits a post), each post at most every six hours. Instance-wide, not
 * per preset. Low: nothing earns the label. High: five labelled rounds all day, every day.
 */
const TRENDING_SHOWCASE_READS_PER_DAY = { low: 0, high: 5 * 3 * 4 };

export interface EstimateLine {
  label: string;
  low: number;
  high: number;
}

export interface CoverageEstimate {
  low: number;
  high: number;
  lines: EstimateLine[];
}

interface Range {
  low: number;
  high: number;
}

/**
 * One sweep of one preset over one window: searches, unique pages, X profiles. A month window
 * prices like a week: search returns the same `limit` results a query whatever the recency, so
 * the credits are the same searches and about the same pages; only a day window is thinner.
 */
export function sweepCredits(preset: Preset, plan: CoveragePlan, window: Window): Range & { x: number } {
  const sources = effectiveSources(preset, plan.sources);
  const perQuery = Math.round(sources.length * preset.limit * (window === "day" ? DAY_WINDOW_RESULT_SHARE : 1));
  const results = preset.queries.length * perQuery;
  const search = preset.queries.length * searchCredits(perQuery);
  const x = Math.min(preset.xAccounts.length, plan.xAccountsMax) * pageCredits("https://x.com/_");
  return {
    low: search + extractionCredits(Math.round(results * UNIQUE_PAGE_SHARE.low)),
    high: search + extractionCredits(Math.round(results * UNIQUE_PAGE_SHARE.high)),
    x,
  };
}

export interface SweepEstimate {
  searches: number;
  results: number;
  pagesLow: number;
  pagesHigh: number;
  xAccounts: number;
  xCredits: number;
  /** New records the run is priced for; verification, corroboration, and enrichment scale with it. */
  records: number;
  /** The search-and-pages portion alone; the total adds X, verification, corroboration, enrichment. */
  sweepLow: number;
  sweepHigh: number;
  verificationCredits: number;
  corroborationCredits: number;
  enrichmentCredits: number;
  alexandriaCredits: number;
  creditsLow: number;
  creditsHigh: number;
  /** Publisher sections the watch lane reads; each check is one credit per site, then 5 per new page. */
  watchSites: number;
  watchEnabled: boolean;
  watchCadence: "daily" | "hourly";
  watchReadCredits: number;
}

/**
 * Rate-card estimate before a run, under the coverage rung's ceilings on sources and X
 * accounts. Unique pages run about 60 to 75 percent of raw results in practice. Pure, so the
 * first-run panel and the presets server action read it without lib/ importing app/.
 */
export function estimateSweep(preset: Preset, plan: CoveragePlan, window: Window = "week"): SweepEstimate {
  const sources = effectiveSources(preset, plan.sources);
  const searches = preset.queries.length;
  // A day window fills about half the result slots, as sweepCredits prices it; a week fills them all.
  const perQuery = Math.round(sources.length * preset.limit * (window === "day" ? DAY_WINDOW_RESULT_SHARE : 1));
  const results = searches * perQuery;
  const search = searches * searchCredits(perQuery);
  const pagesLow = Math.round(results * 0.6);
  const pagesHigh = Math.round(results * 0.75);
  const xProfiles = xProfileCandidates(preset, plan.xAccountsMax);
  const xCredits = extractionCredits(xProfiles.map((c) => c.url));
  const sweepLow = search + extractionCredits(pagesLow);
  const sweepHigh = search + extractionCredits(pagesHigh);
  // What the sweep feeds: every new record is verified before publish, corroborated on rungs that
  // corroborate, and enriched once; the measured records count is why these outweigh the pages.
  const records = window === "day" ? Math.round(RECORDS_PER_WEEK_SWEEP * DAY_WINDOW_RESULT_SHARE) : RECORDS_PER_WEEK_SWEEP;
  const verificationCredits = plan.judge ? records * VERIFICATION_CREDITS_PER_RECORD : 0;
  const corroborationCredits = Math.round(records * CORROBORATION_MULTIPLE[plan.corroboration] * CORROBORATION_CREDITS);
  // Enrichment includes the investors' websites and logos: the run's new investors, up to the per-pass cap.
  const investorsCredits = investorCredits(plan, Math.min(records * NEW_INVESTORS_PER_RECORD, investorsPerRun(plan)));
  const enrichmentCredits = Math.round(records * enrichmentPerCompany(plan)) + investorsCredits;
  const alexandriaCredits = Math.round(records * ALEXANDRIA_CREDITS[plan.alexandria]);
  return {
    searches,
    results,
    pagesLow,
    pagesHigh,
    xAccounts: xProfiles.length,
    xCredits,
    records,
    sweepLow,
    sweepHigh,
    verificationCredits,
    corroborationCredits,
    enrichmentCredits,
    alexandriaCredits,
    creditsLow: sweepLow + xCredits + verificationCredits + corroborationCredits + enrichmentCredits + alexandriaCredits,
    creditsHigh: sweepHigh + xCredits + verificationCredits + corroborationCredits + enrichmentCredits + alexandriaCredits,
    watchSites: preset.watchSites.length,
    watchEnabled: plan.watchSites.enabled,
    watchCadence: plan.watchSites.cadence,
    watchReadCredits: preset.watchSites.length * WATCH_READ_CREDITS,
  };
}

/** New records a month for one preset under the plan. */
function recordsPerMonth(plan: CoveragePlan): number {
  const discovery = DISCOVERY_RECORDS_PER_DAY[plan.agent.discoverySweep] * DAYS_PER_MONTH;
  if (plan.sweep.cadence === "weekly") return RECORDS_PER_WEEK_SWEEP * WEEKS_PER_MONTH + discovery;
  return RECORDS_PER_DAY[plan.sweep.cadence] * DAYS_PER_MONTH + discovery;
}

/** Credits to enrich one new company: the homepage scrape with its retry share and website search, plus the pricing page on rungs that read it. */
function enrichmentPerCompany(plan: CoveragePlan): number {
  const homepage = HOMEPAGE_CREDITS * (1 + VERIFICATION_RETRY_SHARE) + WEBSITE_SEARCH_SHARE * WEBSITE_SEARCH_CREDITS;
  const pricing = plan.enrichment === "homepage" ? 0 : PRICING_PAGE_SHARE * extractionCredits(1);
  return homepage + pricing;
}

/** Rate-card estimate for a month of the plan over these presets, plus `monitors` live monitors. */
export function estimateMonthlyCredits(plan: CoveragePlan, presets: Preset[], monitors: number): CoverageEstimate {
  const lines: EstimateLine[] = [];
  const add = (label: string, low: number, high = low) => {
    lines.push({ label, low: Math.round(low), high: Math.round(high) });
  };

  const sweeps: Range = { low: 0, high: 0 };
  let x = 0;
  for (const preset of presets) {
    for (const window of plan.sweep.windows) {
      const runs = window === "week" ? WEEKS_PER_MONTH : DAY_SWEEPS_PER_MONTH[plan.sweep.cadence];
      const one = sweepCredits(preset, plan, window);
      sweeps.low += one.low * runs;
      sweeps.high += one.high * runs;
      x += one.x * runs;
    }
  }
  add("Sweeps (search and pages)", sweeps.low, sweeps.high);
  if (x > 0) add("X accounts", x);

  if (plan.watchSites.enabled) {
    const sites = presets.reduce((n, p) => n + p.watchSites.length, 0);
    const perDay =
      sites * (SITE_CHECKS_PER_DAY[plan.watchSites.cadence] * RATE.mapCall + WATCH_NEW_PAGES_PER_SITE_PER_DAY * extractionCredits(1));
    add("Watch sites (map, then new pages)", perDay * DAYS_PER_MONTH);
    const queries = presets.reduce((n, p) => n + p.watchQueries.length, 0);
    if (queries > 0) {
      const perDayQueries =
        WATCH_QUERY_RUNS_PER_DAY[plan.watchSites.cadence] * queries * WATCH_QUERY_CREDITS +
        queries * WATCH_QUERY_NEW_PAGES_PER_QUERY_PER_DAY * extractionCredits(1);
      add("Stage-free searches (then new pages)", perDayQueries * DAYS_PER_MONTH);
    }
    const xSearch =
      X_ANNOUNCEMENT_RUNS_PER_DAY[plan.watchSites.cadence] * X_ANNOUNCEMENT_SEARCHES * (searchCredits(20) + X_LIVE_SEARCH_CREDITS);
    const xLeads = (r: "low" | "high") =>
      X_LEADS_PER_DAY[r] * (X_ARTICLE_SEARCHES_PER_LEAD[r] * searchCredits(10) + X_ARTICLE_PAGES_PER_LEAD[r] * extractionCredits(1)) +
      X_FOUNDER_CHECKS_PER_DAY[r] * (X_PROFILE_READ_CREDITS + RATE.scrapePage);
    add("X announcements (search, then articles)", (xSearch + xLeads("low")) * DAYS_PER_MONTH, (xSearch + xLeads("high")) * DAYS_PER_MONTH);
  }
  if (plan.formD.enabled) add("SEC Form D (EDGAR, no Firecrawl credits)", FORM_D_CREDITS);
  if (monitors > 0)
    add(
      `Monitor checks (${monitors} ${monitors === 1 ? "monitor" : "monitors"})`,
      monitors * MONITOR_CHECK_CREDITS * MONITOR_CHECKS_PER_MONTH[plan.monitorSchedule],
    );

  const records = presets.length * recordsPerMonth(plan);
  if (plan.judge) add("Verification (read-back before publish)", records * VERIFICATION_CREDITS_PER_RECORD);
  if (plan.corroboration !== "off") add("Corroboration", records * CORROBORATION_MULTIPLE[plan.corroboration] * CORROBORATION_CREDITS);

  const passes = plan.enrichment === "weekly_reenrich" ? 1 + REENRICH_PASSES_PER_MONTH : 1;
  // Investor domains and logos are read once, not re-enriched; a month's new investors all get theirs across the passes.
  add("Enrichment", records * enrichmentPerCompany(plan) * passes + investorCredits(plan, records * NEW_INVESTORS_PER_RECORD));
  if (plan.alexandria !== "off")
    add(
      plan.alexandria === "yc_firmographics" ? "Alexandria (YC, FullEnrich, and Apollo records)" : "Alexandria (YC records)",
      records * ALEXANDRIA_CREDITS[plan.alexandria],
    );
  if (plan.alexandria === "yc_firmographics")
    add(
      "Apollo leads (each searched and verified as a history round)",
      records * APOLLO_LEADS_PER_COMPANY * HISTORY_CREDITS_PER_PRIOR.low,
      records * APOLLO_LEADS_PER_COMPANY * HISTORY_CREDITS_PER_PRIOR.high,
    );

  if (plan.trending) {
    const perRecord = (r: "low" | "high") =>
      TRENDING_CHECKPOINTS * TRENDING_SEARCHES[r] * TRENDING_SEARCH_CREDITS[r] + TRENDING_HANDLE_CREDITS;
    const showcase = (r: "low" | "high") => TRENDING_SHOWCASE_READS_PER_DAY[r] * DAYS_PER_MONTH * RATE.xProfileRequest;
    add(
      "Trending (X search, handles, showcase posts)",
      records * (1 - REVIEW_SHARE) * perRecord("low") + showcase("low"),
      records * perRecord("high") + showcase("high"),
    );
  }
  if (plan.agent.gapFill === "auto") add("Agent gap-fill on review items", records * REVIEW_SHARE * GAP_FILL_CREDITS);
  if (plan.agent.deepDive !== "manual") {
    const share = plan.agent.deepDive === "all" ? 1 : DEEP_DIVE_THRESHOLD_SHARE;
    add("Agent deep dive", records * share * DEEP_DIVE_CREDITS);
    add(
      "History rounds (each dossier's prior rounds)",
      records * share * HISTORY_PRIORS_PER_DOSSIER * HISTORY_CREDITS_PER_PRIOR.low,
      records * share * HISTORY_PRIORS_PER_DOSSIER * HISTORY_CREDITS_PER_PRIOR.high,
    );
  }
  if (plan.agent.deepDive === "all") {
    add(
      "Agent deep dive backlog (2 a sweep while it lasts, with their history rounds)",
      0,
      DAY_SWEEPS_PER_MONTH[plan.sweep.cadence] *
        BACKLOG_DIVES_PER_TICK *
        (DEEP_DIVE_CREDITS + HISTORY_PRIORS_PER_DOSSIER * HISTORY_CREDITS_PER_PRIOR.high),
    );
  }
  if (plan.agent.discoverySweep !== "off") {
    const runs = plan.agent.discoverySweep === "daily" ? DAYS_PER_MONTH : WEEKS_PER_MONTH;
    add("Agent discovery sweep", presets.length * runs * DISCOVERY_SWEEP_CREDITS);
  }

  return {
    low: lines.reduce((n, l) => n + l.low, 0),
    high: lines.reduce((n, l) => n + l.high, 0),
    lines,
  };
}
