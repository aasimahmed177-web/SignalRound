// Lane: watch sites. A publisher's funding section is a list of its newest articles; read
// the list, keep the article links not seen before, extract each once. One page read per
// site per check (1 credit), then the usual 5 per new page. The same lane runs the preset's
// stage-free searches ("has raised" million led by): a past-day search whose unseen result
// URLs are extracted once, like a section's links, because many large rounds are announced
// with no stage word for the sweep's queries to match.
//
// The read is a `scrape` with `formats: ["links"]`, not `map`: map scopes itself to the URL
// it is given, and on every section URL probed (six publishers, 2026-09-04) it returned only
// the section's own pagination and feed URLs, never an article. The section page's own links
// are the list a reader sees. Same price as a map call.

import { type Preset, type WatchQuery, watchQuery } from "../presets/types.ts";
import { canonicalUrl, dateFromUrl, hostOf, isArticleUrl, isDirectoryTitle, registrableDomain } from "../records/normalize.ts";
import type { NativeWebClient } from "../web/client.ts";
import { RATE, searchCredits } from "./credits.ts";
import type { ExtractTarget } from "./extract.ts";
import type { ScreenedResult } from "./sweep.ts";

/** One section read is one credit, priced as the map call lib/coverage.ts budgets per site (a links-only scrape costs the same). */
export const WATCH_READ_CREDITS: number = RATE.mapCall;

/** The most new pages one check extracts from one site. */
export const WATCH_DEFAULT_LIMIT = 20;

/**
 * Taxonomy segments: a listing when the path ends at the taxonomy or its term ("/category/funding",
 * "/author/jane-doe"), but an article's parent path when a long slug sits below the term, as Startup
 * Daily files every story ("/topic/funding/kinoxis-raises-6-75-million-with-a-grant").
 */
const TAXONOMY_SEGMENTS = new Set(["category", "categories", "section", "sections", "tag", "tags", "topic", "topics", "author", "authors"]);

/** Path segments that are never an article wherever they sit: pagination, feeds, site plumbing. */
const NOT_ARTICLE_SEGMENTS = new Set([
  "page",
  "feed",
  "feeds",
  "rss",
  "wp-content",
  "wp-json",
  "search",
  "login",
  "account",
  "newsletter",
  "newsletters",
  "events",
  "event",
  "video",
  "videos",
  "podcast",
  "podcasts",
  "about",
  "contact",
  "jobs",
  "startup-jobs",
  "tickets",
  "advertise",
  "subscribe",
  "shop",
]);

/** Segments that mark a publisher's news path; a slug under one of these is an article even when short. */
const ARTICLE_SEGMENTS = new Set(["news", "venture", "funding", "news-releases", "investment"]);

const NOT_ARTICLE_EXTENSIONS = /\.(pdf|xml|json|jpe?g|png|gif|svg|webp|mp[34]|zip|css|js)$/i;

/** A date in the path: /2026/09/04/ or /2026/09/ (monthly archives are dated too). */
const DATED_PATH = /\/20\d{2}\/(0[1-9]|1[0-2])(\/|$)/;

/** A day at the end of a slug, as e27 and UKTN write it: "/life-lab-resources-grabs-us1m-20260924". */
const DATED_SLUG = /-(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;

/** A slug that reports money: a raise verb, a round word, or a figure ("raises-1-8m", "250m"). */
const FUNDING_SLUG =
  /(?:^|-)(?:raises?|raised|raising|closes|closed|secures?|secured|lands?|landed|bags|nets|grabs|funding|financing|seed|series|round|invests?|investment|backs|backed|million|billion|crore|\d+m|\d+mn|\d+b)(?:-|$)/;

/** A slug's hyphenated words, without an .html tail. */
function slugWords(segment: string): string[] {
  return segment
    .replace(/\.html?$/i, "")
    .split("-")
    .filter(Boolean);
}

/** The day a watch link's path states, when it states one: a dated path or a dated slug. */
export function watchLinkDate(link: string): Date | null {
  const dated = dateFromUrl(link);
  if (dated) return dated;
  let path: string;
  try {
    path = new URL(link).pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
  const m = DATED_SLUG.exec(path);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Whether `link` looks like an article on the same publisher as `siteUrl`: same registrable
 * domain, not the section itself, no plumbing segment, not a taxonomy listing, and either a date in
 * the path, a slug of three or more hyphenated words under a parent segment, or a news segment. A
 * slug at the site root is an evergreen page ("/unicorn-company-list", "/secure-your-tickets")
 * unless it reads as a funding story: four or more words with a raise word or figure, or a day at
 * its end. LatamList, BetaKit, Tech Funding News, and e27 file their stories at the root.
 */
export function isArticleLink(link: string, siteUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (registrableDomain(link) !== registrableDomain(siteUrl)) return false;
  if (canonicalUrl(link) === canonicalUrl(siteUrl)) return false;
  const segments = u.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  const lower = segments.map((s) => s.toLowerCase());
  if (lower.some((s) => NOT_ARTICLE_SEGMENTS.has(s))) return false;
  const last = segments[segments.length - 1];
  if (NOT_ARTICLE_EXTENSIONS.test(last)) return false;
  const words = slugWords(last);
  const taxonomy = lower.findIndex((s) => TAXONOMY_SEGMENTS.has(s));
  // A taxonomy listing or its term is never an article; a long slug two or more levels below the term is.
  if (taxonomy >= 0 && (segments.length - 1 < taxonomy + 2 || words.length < 4)) return false;
  if (DATED_PATH.test(u.pathname)) return true;
  if (segments.length >= 2 && words.length >= 3) return true;
  if (segments.slice(0, -1).some((s) => ARTICLE_SEGMENTS.has(s.toLowerCase()))) return true;
  // A slug at the site root is an article only when it reads as one: four or more words that report
  // money or end in a day (LatamList, BetaKit, Tech Funding News, e27). "/unicorn-company-list" does not.
  const slug = last.replace(/\.html?$/i, "").toLowerCase();
  return segments.length === 1 && words.length >= 4 && (FUNDING_SLUG.test(slug) || DATED_SLUG.test(slug));
}

/** A section page pins a few older features above its newest posts; a URL dated further back than this is not news. */
export const WATCH_MAX_AGE_DAYS = 14;

export interface WatchSiteOptions {
  /** Whether a URL was extracted before; the candidates table answers this in the app. */
  seen: (url: string) => Promise<boolean> | boolean;
  /** New pages to hand to extraction per site; default 20. */
  limit?: number;
  /** A URL whose path dates it older than this many days is skipped before extraction; default 14. */
  maxAgeDays?: number;
  now?: Date;
}

export interface WatchSiteResult {
  host: string;
  /** Links the section page carried, before any filter. */
  linked: number;
  /** Article links on the publisher inside the age window, seen or not. */
  articles: number;
  /** Article links not seen before, capped at `limit`; these are the extraction targets. */
  targets: ExtractTarget[];
  creditsEstimated: number;
}

/**
 * Read one publisher section and return its unseen article links as extraction targets
 * with query `watch:<host>`. Order is the page's own (newest first on every publisher watched).
 */
export async function watchSiteCandidates(client: NativeWebClient, siteUrl: string, opts: WatchSiteOptions): Promise<WatchSiteResult> {
  const host = hostOf(siteUrl);
  const limit = opts.limit ?? WATCH_DEFAULT_LIMIT;
  const oldest = (opts.now ?? new Date()).getTime() - (opts.maxAgeDays ?? WATCH_MAX_AGE_DAYS) * 86_400_000;
  const doc = await client.scrape(siteUrl, { formats: ["links"], onlyMainContent: true, timeout: 60_000 });
  const linked = doc.links ?? [];
  const articles = new Map<string, string>();
  for (const link of linked) {
    if (!isArticleLink(link, siteUrl)) continue;
    const dated = watchLinkDate(link);
    if (dated && dated.getTime() < oldest) continue;
    const key = canonicalUrl(link);
    if (!articles.has(key)) articles.set(key, link);
  }
  const targets: ExtractTarget[] = [];
  for (const [key] of articles) {
    if (targets.length >= limit) break;
    if (await opts.seen(key)) continue;
    targets.push({ url: key, query: `watch:${host}` });
  }
  return { host, linked: linked.length, articles: articles.size, targets, creditsEstimated: WATCH_READ_CREDITS };
}

/** Results a stage-free search asks for per source: the measured finds sat in the top twenty (September 2026). */
export const WATCH_QUERY_LIMIT = 20;

export interface WatchQueryResult {
  query: string;
  /** Results the search returned, before any filter; what it bills on. */
  results: number;
  /** Article results not seen before, capped at `limit`. */
  targets: ExtractTarget[];
  creditsEstimated: number;
  /** Every result once, with the rules' decision (an article URL and no directory title), for the classifier's reading. */
  screened: ScreenedResult[];
  /** Article results the directory-title rule alone declined, for the classifier to rescue; not yet checked against seen. */
  heldByTitle: ExtractTarget[];
}

/**
 * One stage-free search over the past day, its unseen article results as extraction targets with query
 * `watch:search`. Search dates results loosely, so a result is only a candidate: the resolver's window and
 * dating rules decide whether its round is this week's news.
 */
export async function watchQueryCandidates(
  client: NativeWebClient,
  input: string | WatchQuery,
  preset: Pick<Preset, "sources" | "excludeDomains">,
  opts: WatchSiteOptions,
): Promise<WatchQueryResult> {
  const limit = opts.limit ?? WATCH_DEFAULT_LIMIT;
  const { q: query, includeDomains } = watchQuery(input);
  // A query with its own domains reads only those; the rest keep the preset's exclusions.
  const domains = includeDomains.length
    ? { includeDomains }
    : preset.excludeDomains.length
      ? { excludeDomains: preset.excludeDomains }
      : {};
  const res = await client.search(query, {
    sources: preset.sources,
    tbs: "qdr:d",
    limit: WATCH_QUERY_LIMIT,
    highlights: false,
    ...domains,
  });
  const found = new Map<string, ExtractTarget>();
  const screened = new Map<string, ScreenedResult>();
  const held = new Map<string, ExtractTarget>();
  let results = 0;
  for (const kind of preset.sources) {
    for (const item of (res[kind] ?? []) as Array<{
      url?: string;
      title?: string;
      date?: string;
      description?: string;
      snippet?: string;
    }>) {
      if (!item.url) continue;
      results++;
      const key = canonicalUrl(item.url);
      const articleUrl = isArticleUrl(key);
      const article = articleUrl && !isDirectoryTitle(item.title);
      if (!screened.has(key))
        screened.set(key, {
          url: key,
          title: item.title,
          snippet: item.description ?? item.snippet,
          kept: article,
          heldByTitle: articleUrl && !article,
        });
      if (articleUrl && !article && !held.has(key))
        held.set(key, { url: key, title: item.title, published: item.date, query: "watch:search" });
      if (found.has(key) || !article) continue;
      found.set(key, { url: key, title: item.title, published: item.date, query: "watch:search" });
    }
  }
  const targets: ExtractTarget[] = [];
  for (const [key, target] of found) {
    if (targets.length >= limit) break;
    if (await opts.seen(key)) continue;
    targets.push(target);
  }
  return {
    query,
    results,
    targets,
    creditsEstimated: searchCredits(results),
    screened: [...screened.values()],
    heldByTitle: [...held.values()],
  };
}

export interface WatchRunOptions extends WatchSiteOptions {
  /** Called once per site with the URLs handed to extraction, so the next check skips them. */
  markSeen: (host: string, urls: string[]) => Promise<void> | void;
}

export interface WatchRunResult {
  candidates: ExtractTarget[];
  sites: WatchSiteResult[];
  /** The preset's stage-free searches, in order. */
  queries: WatchQueryResult[];
  /** One page read per site. */
  mapCredits: number;
  /** What the searches billed. */
  searchCredits: number;
}

/** A target list's URLs by host: seen state is kept per host (`watch:<host>`), whichever section or search found the page. */
function byHost(targets: ExtractTarget[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of targets) {
    const host = hostOf(t.url);
    out.set(host, [...(out.get(host) ?? []), t.url]);
  }
  return out;
}

/**
 * Every watch site of the preset, in order, then every stage-free search, marking each one's targets
 * seen before the next is read, so a page a section and a search both carry is extracted once.
 */
export async function runWatchSites(client: NativeWebClient, preset: Preset, opts: WatchRunOptions): Promise<WatchRunResult> {
  const sites: WatchSiteResult[] = [];
  const queries: WatchQueryResult[] = [];
  const candidates: ExtractTarget[] = [];
  for (const siteUrl of preset.watchSites) {
    const site = await watchSiteCandidates(client, siteUrl, opts);
    sites.push(site);
    candidates.push(...site.targets);
    await opts.markSeen(
      site.host,
      site.targets.map((t) => t.url),
    );
  }
  for (const query of preset.watchQueries) {
    const q = await watchQueryCandidates(client, query, preset, opts);
    queries.push(q);
    candidates.push(...q.targets);
    for (const [host, urls] of byHost(q.targets)) await opts.markSeen(host, urls);
  }
  return {
    candidates,
    sites,
    queries,
    mapCredits: sites.reduce((n, s) => n + s.creditsEstimated, 0),
    searchCredits: queries.reduce((n, q) => n + q.creditsEstimated, 0),
  };
}
