// The reads every visitor shares, cached for a minute or a few so a busy page does not query the
// database on every hit. Each is public and viewer-independent: it reads the rounds the feed
// publishes (publish and flagged) and nothing a session changes, so one entry serves everyone. The
// pages call the visitor-shaped ones (cachedFeedPage, cachedCompanyView, cachedNews, ...) only for a
// viewer who sees what the feed publishes (seesReview false); an admin, and every viewer of a
// private instance, reads the same functions fresh.
//
// `use cache: remote` puts the entry in the platform's shared cache (on Vercel, shared across
// function instances), so one query a minute stands in for every visitor's. Without a remote
// handler Next keeps it in process memory, which is what `pnpm start` wants anyway.
//
// Callers await `connection()` first, as the pages already do: that keeps these reads out of the
// build, which on CI has no database and on PGlite would contend for the store's lock.
//
// Every entry carries TAG_ROUNDS (or TAG_SETTINGS, TAG_PRESETS). The admin's server actions call
// updateTag on the one they change, so a publish or a preset edit shows at once; the sweep writes
// from workflow steps, outside any request, so what it lands shows within LIVE's minute.

import type { Preset } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { cacheLife, cacheTag } from "next/cache";
import { type CompanyView, readCompanyView } from "@/lib/company";
import { visitorRead, withinDeadline } from "@/lib/db";
import { type CompanySort, type InvestorSort, listCompanies, listInvestors } from "@/lib/directory";
import { companyTag, investorTag, TAG_ENTITY_DETAILS } from "@/lib/entity-tags";
import { type FeedPage, type FeedPageQuery, readFeedPage } from "@/lib/feed-page";
import { houseDomain, houseFreshSince, isFreshHouseRound } from "@/lib/house";
import { getInvestor, type InvestorPage } from "@/lib/investor";
import { landingStats } from "@/lib/landing";
import { listRuns, type NewsEntry, type RunRow, readNews } from "@/lib/news";
import { listRounds, listSectors, publicRoundQuery, type RoundRow } from "@/lib/persist";
import { listPresets } from "@/lib/presets";
import { getCoverage } from "@/lib/settings";
import { slackPreviews } from "@/lib/slack-delivery";
import { demoStats, type MarketView, marketView } from "@/lib/stats";
import { trendingTop } from "@/lib/trending";

/** Every cached read of the published rounds. */
export const TAG_ROUNDS = "rounds";
/** Cached reads of instance settings (the coverage rung). */
export const TAG_SETTINGS = "settings";
/** The preset list: the shipped files and the admin's custom rows. */
export const TAG_PRESETS = "presets";

/**
 * Counters and the newest rows on the front doors: a minute old at most while visited, gone after
 * ten idle minutes. Sweeps land hourly at the busiest rung, so a minute is invisible to a reader.
 */
const FRONT_DOOR = { stale: 60, revalidate: 60, expire: 600 };

/** Directory pages and the sector list: they move when a new company lands, a few times an hour. */
const DIRECTORY = { stale: 60, revalidate: 300, expire: 3600 };

/**
 * The feed's rows, the news, the runs, and the entity pages: refreshed at most a minute after a busy
 * page's last refresh, and never served more than three minutes old, however quiet the page. A
 * launch spike then costs one read per page and filter a minute instead of one per view.
 */
const LIVE = { stale: 60, revalidate: 60, expire: 180 };

const DETAIL = { stale: 60, revalidate: 600, expire: 3600 };

/**
 * One cached read, held to the visitor's deadline (lib/db.ts withinDeadline). A read that fails throws
 * out of the cache function, and a thrown read is never stored: within an entry's expire window the
 * stale copy keeps serving while the background refresh fails, and only a page with no copy left shows
 * its error state.
 */
async function read<T>(query: (handle: Db) => Promise<T>): Promise<T> {
  return withinDeadline(visitorRead(query));
}

/** The landing page's counters (lib/landing.ts). */
export async function cachedLandingStats() {
  "use cache: remote";
  cacheLife(FRONT_DOOR);
  cacheTag(TAG_ROUNDS);
  return read(landingStats);
}

/** The demo hero's week and day (lib/stats.ts). */
export async function cachedDemoStats() {
  "use cache: remote";
  cacheLife(FRONT_DOOR);
  cacheTag(TAG_ROUNDS);
  return read(demoStats);
}

/** The newest published rounds, as the feed's first page orders them: the landing page's glimpse. */
export async function cachedLatestRounds(limit: number): Promise<RoundRow[]> {
  "use cache: remote";
  cacheLife(FRONT_DOOR);
  cacheTag(TAG_ROUNDS);
  return (await read((h) => listRounds(h, publicRoundQuery({ limit, history: "exclude" })))).rows;
}

/** The newest published Series A rounds and the cursor after them: the landing page's API example. */
export async function cachedSeriesAPick(limit: number): Promise<{ rows: RoundRow[]; nextCursor: string | null }> {
  "use cache: remote";
  cacheLife(FRONT_DOOR);
  cacheTag(TAG_ROUNDS);
  return read((h) => listRounds(h, publicRoundQuery({ stages: ["series_a"], limit, history: "exclude" })));
}

/**
 * The house round while it is fresh (lib/house.ts), or null. Freshness is judged again by the
 * caller against the clock, so an entry cached a minute before the window closes cannot outlive it.
 */
export async function cachedHouseRound(): Promise<RoundRow | null> {
  "use cache: remote";
  cacheLife(FRONT_DOOR);
  cacheTag(TAG_ROUNDS);
  const house = houseDomain();
  if (!house) return null;
  const { rows } = await read((h) => listRounds(h, { company: house, since: houseFreshSince(), limit: 1, history: "exclude" }));
  return rows.find((r) => isFreshHouseRound(r, new Date(), house)) ?? null;
}

/**
 * The landing hero's rows: the most discussed rounds, which have had a day or two to gather sources,
 * or the newest when nothing has a score yet (a fresh clone), so the glimpse is never empty.
 */
export async function cachedLandingHero(limit: number): Promise<{ rows: RoundRow[]; trending: boolean }> {
  "use cache: remote";
  cacheLife(FRONT_DOOR);
  cacheTag(TAG_ROUNDS);
  return read(async (handle) => {
    const { rounds } = await trendingTop(handle, limit);
    if (rounds.length > 0) return { rows: rounds, trending: true };
    return { rows: (await listRounds(handle, publicRoundQuery({ limit, history: "exclude" }))).rows, trending: false };
  });
}

/**
 * Everything the Overview shows every viewer (lib/stats.ts marketView), keyed on the preset chip.
 * One entry, so the page costs one cache read however many panels it draws; the admin's panels
 * are read fresh beside it.
 */
export async function cachedMarket(preset: string): Promise<MarketView> {
  "use cache: remote";
  cacheLife(FRONT_DOOR);
  cacheTag(TAG_ROUNDS);
  return read((h) => marketView(h, preset || undefined));
}

/** Whether this instance's rung runs the Trending lane: the feed opens on Trending only when it does. */
export async function cachedTrendingOn(): Promise<boolean> {
  "use cache: remote";
  cacheLife(DIRECTORY);
  cacheTag(TAG_SETTINGS);
  return (await read(getCoverage)).trending;
}

/** The sectors on published rounds, for the feed's filter menu. */
export async function cachedSectors(): Promise<string[]> {
  "use cache: remote";
  cacheLife(DIRECTORY);
  cacheTag(TAG_ROUNDS);
  return read(listSectors);
}

/** One page of /companies. Keyed on the URL state, so the default view is the one that hits. */
export async function cachedCompanies(q: string, sort: CompanySort, page: number) {
  "use cache: remote";
  cacheLife(DIRECTORY);
  cacheTag(TAG_ROUNDS);
  return read((h) => listCompanies(h, { q, sort, page }));
}

/** One page of /investors, keyed like cachedCompanies. */
export async function cachedInvestors(q: string, sort: InvestorSort, page: number) {
  "use cache: remote";
  cacheLife(DIRECTORY);
  cacheTag(TAG_ROUNDS);
  return read((h) => listInvestors(h, { q, sort, page }));
}

/** The presets every visitor's picker lists (lib/presets.ts). The admin's Presets page reads them fresh. */
export async function cachedPresets(): Promise<Preset[]> {
  "use cache: remote";
  cacheLife(DIRECTORY);
  cacheTag(TAG_PRESETS);
  return read(listPresets);
}

/** One page of the feed as a visitor reads it (lib/feed-page.ts), keyed on the filters, the order, and the page. */
export async function cachedFeedPage(query: FeedPageQuery): Promise<FeedPage> {
  "use cache: remote";
  cacheLife(LIVE);
  cacheTag(TAG_ROUNDS);
  return read((h) => readFeedPage(h, query));
}

/** A company page as a visitor reads it: the feed's rounds only (lib/company.ts readCompanyView). */
export async function cachedCompanyView(id: string): Promise<CompanyView | null> {
  "use cache: remote";
  cacheLife(DETAIL);
  cacheTag(TAG_ENTITY_DETAILS, companyTag(id));
  return read((h) => readCompanyView(h, id));
}

/** An investor page as a visitor reads it: the feed's rounds only (lib/investor.ts). */
export async function cachedInvestor(id: string): Promise<InvestorPage | null> {
  "use cache: remote";
  cacheLife(DETAIL);
  cacheTag(TAG_ENTITY_DETAILS, investorTag(id));
  return read((h) => getInvestor(h, id));
}

/** The News page as a visitor reads it: articles behind a published round, and the article count. */
export async function cachedNews(preset: string, show: number): Promise<{ items: NewsEntry[]; total: number }> {
  "use cache: remote";
  cacheLife(LIVE);
  cacheTag(TAG_ROUNDS);
  return read((h) => readNews(h, { limit: show, preset: preset || undefined, publishedOnly: true }));
}

/** The Runs page's list as a visitor reads it: every lane but the admin ones. */
export async function cachedRuns(limit: number): Promise<RunRow[]> {
  "use cache: remote";
  cacheLife(LIVE);
  cacheTag(TAG_ROUNDS);
  return read((h) => listRuns(h, limit, { adminLanes: false }));
}

/** The Slack page's welcome and digest previews, drawn from the live store, keyed on the origin their links use. */
export async function cachedSlackPreviews(origin: string) {
  "use cache: remote";
  cacheLife(LIVE);
  cacheTag(TAG_ROUNDS);
  return read((h) => slackPreviews(h, origin));
}
