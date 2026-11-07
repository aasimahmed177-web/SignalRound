// Recently funded companies (pre-seed to Series C, any country) and the people to write to: founders named in a
// public funding article or on the company's own site, and the public emails those pages print. Logged out only:
// news WordPress APIs and RSS feeds, Bing's public news RSS and web results, and the company's own pages.
// No email is ever built from a pattern; each one is kept with the page it appeared on and the text around it.

import { randomUUID } from "node:crypto";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { readPublicText } from "@fireround/core/web/transport";
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import {
  amountAsWritten,
  classifyEmail,
  companyFromHeadline,
  companyKey,
  countryFromText,
  domainGuesses,
  excludedDeal,
  type FounderMention,
  foundersFromTeamPage,
  foundersFromText,
  hostOf,
  type InboxType,
  leadersFromText,
  linkedinFor,
  pageEmailsInContext,
  pageText,
  readStage,
  rootDomain,
  type StageKey,
  websiteMatches,
} from "./funding-parse.ts";
import { classifyIndustry, type Industry } from "./industry.ts";
import type { ReadText } from "./job-boards.ts";
import { pool } from "./linkedin-posts.ts";
import { ingestSignal } from "./signals.ts";

const DAY_MS = 86_400_000;
const USER_AGENT = "Mozilla/5.0 (compatible; SignalRound/0.2; +https://github.com/aasimahmed177-web/SignalRound)";

export interface FounderEmail {
  email: string;
  kind: "founder_personal";
  source_url: string;
  quote: string;
}
export interface Founder {
  name: string;
  role: string;
  source_url: string;
  quote: string;
  linkedin_url: string | null;
  emails: FounderEmail[];
}
export interface CompanyEmail {
  email: string;
  kind: "company_inbox";
  inbox: InboxType;
  source_url: string;
  quote: string;
}
export interface FundedCompany {
  company: string;
  website: string | null;
  brief: string | null;
  industry: Industry;
  country: string | null;
  stage: string;
  stage_key: StageKey;
  amount: string | null;
  announced_on: string;
  funding_source_url: string;
  other_sources: string[];
  founders: Founder[];
  company_emails: CompanyEmail[];
}
/** A posted email: printed on a public page we kept, with the words around it. */
export function posted(email: { email: string; source_url: string; quote: string }): boolean {
  return Boolean(email.source_url && email.quote?.toLowerCase().includes(email.email.toLowerCase()));
}

// Desks that answer data-protection, legal, security or abuse requests: printed publicly, but nobody to pitch.
const NOT_OUTREACH_LOCAL =
  /^(?:privacy|dpo|legal|security|accessibility|abuse|compliance|gdpr|data-?protection|dataprotection|datenschutz|grievances?|whistle-?blow\w*|no-?reply|do-?not-?reply|postmaster|webmaster)(?:[._+-][\w.+-]*)?$/i;

/** An inbox worth writing to: not a privacy, DPO, legal, security, accessibility, abuse or compliance desk. */
export const isOutreachEmail = (email: string) => !NOT_OUTREACH_LOCAL.test(email.split("@")[0] ?? "");

/**
 * Keeps only contacts with an email posted somewhere public: founders without one are dropped, and
 * so are companies left with no posted email at all. Nothing is guessed or run through a verifier.
 */
export function postedContactsOnly(companies: FundedCompany[]): FundedCompany[] {
  return companies.flatMap((company) => {
    const founders = company.founders
      .map((founder) => ({ ...founder, emails: founder.emails.filter(posted) }))
      .filter((founder) => founder.emails.length);
    const company_emails = company.company_emails.filter((email) => posted(email) && isOutreachEmail(email.email));
    return founders.length || company_emails.length ? [{ ...company, founders, company_emails }] : [];
  });
}

export interface FundedRun {
  generated_at: string;
  window_days: number;
  stats: Record<string, number>;
  companies: FundedCompany[];
}

export interface NewsItem {
  title: string;
  url: string;
  published: Date;
  source: string;
  country: string | null;
  /** The article body when the feed carries it (WordPress content, full RSS). */
  html?: string;
  /** Set when the row comes from a roundup table that already states the round. */
  row?: { company: string; stage: string; amount: string | null };
}

const WORDPRESS: Array<{ source: string; origin: string; country: string | null }> = [
  { source: "Inc42", origin: "https://inc42.com", country: "India" },
  { source: "TechCrunch", origin: "https://techcrunch.com", country: null },
  { source: "TechCabal", origin: "https://techcabal.com", country: null },
  { source: "Startup Daily", origin: "https://www.startupdaily.net", country: "Australia" },
  { source: "EU-Startups", origin: "https://www.eu-startups.com", country: null },
  { source: "Crunchbase News", origin: "https://news.crunchbase.com", country: null },
];
const FEEDS: Array<{ source: string; url: string; country: string | null }> = [
  { source: "Entrackr", url: "https://entrackr.com/rss", country: "India" },
  { source: "Entrackr", url: "https://entrackr.com/rss/categories/news", country: "India" },
  { source: "Entrackr", url: "https://entrackr.com/rss/categories/snippets", country: "India" },
  { source: "YourStory", url: "https://yourstory.com/feed", country: "India" },
  { source: "YourStory", url: "https://yourstory.com/category/funding/feed", country: "India" },
  { source: "Tech.eu", url: "https://tech.eu/feed/", country: null },
  { source: "PR Newswire", url: "https://www.prnewswire.com/rss/financial-services-latest-news/venture-capital-list.rss", country: null },
];
const BING_NEWS_QUERIES = [
  '"raises" "pre-seed"',
  '"raises" "seed round"',
  '"secures" "seed funding"',
  '"raises" "Series A"',
  '"secures" "Series A"',
  '"raises" "Series B"',
  '"raises" "Series C"',
  "startup raises seed funding led by",
  "startup funding round Europe seed",
  "African startup raises seed",
  "Australian startup raises seed",
  "MENA startup raises seed round",
  "Southeast Asia startup raises Series A",
  "Latin America startup raises seed round",
  "press release announces seed funding round",
  "press release announces Series A funding",
];

const defaultRead: ReadText = (url, options) =>
  readPublicText(url, {
    timeoutMs: options?.timeoutMs ?? 15_000,
    maxBytes: options?.maxBytes ?? 3_000_000,
    headers: { "user-agent": USER_AGENT, ...options?.headers },
  });

const text = (html: string) => load(`<p>${html}</p>`).text().replace(/\s+/g, " ").trim();
const iso = (date: Date) => date.toISOString().slice(0, 10);

async function wordpressItems(read: ReadText, site: (typeof WORDPRESS)[number], since: Date): Promise<NewsItem[]> {
  const items: NewsItem[] = [];
  // WordPress reads a bare `after` in the site's own timezone (US outlets run hours behind UTC): ask from a day earlier
  // and let fetchNews keep only posts whose date_gmt is inside the window.
  const after = new Date(since.getTime() - DAY_MS).toISOString().slice(0, 19);
  for (let page = 1; page <= 6; page++) {
    const url = `${site.origin}/wp-json/wp/v2/posts?after=${after}&per_page=100&page=${page}&_fields=link,date_gmt,title,content`;
    const response = await read(url, { timeoutMs: 40_000, maxBytes: 12_000_000 });
    const posts = JSON.parse(response.text) as Array<{
      link: string;
      date_gmt: string;
      title: { rendered: string };
      content?: { rendered: string };
    }>;
    for (const post of posts)
      items.push({
        title: text(post.title.rendered),
        url: post.link,
        published: new Date(`${post.date_gmt}Z`),
        source: site.source,
        country: site.country,
        html: post.content?.rendered,
      });
    if (posts.length < 100) break;
  }
  return items;
}

const xml = new XMLParser({ ignoreAttributes: false, trimValues: true, cdataPropName: false });
const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const str = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value && typeof value === "object" && "#text" in value
      ? String((value as { "#text": unknown })["#text"])
      : "";

export function parseFeed(body: string, source: string, country: string | null): NewsItem[] {
  const parsed = xml.parse(body) as { rss?: { channel?: { item?: unknown } } };
  return list(parsed.rss?.channel?.item as Record<string, unknown> | Array<Record<string, unknown>>).flatMap((item) => {
    let url = str(item.link).trim();
    // Bing news wraps the article URL in a click-tracking link.
    if (/bing\.com\/news\/apiclick/.test(url)) url = new URL(url).searchParams.get("url") ?? "";
    const published = new Date(str(item.pubDate));
    const title = text(str(item.title));
    if (!url || !title || Number.isNaN(published.getTime())) return [];
    const html = str(item["content:encoded"]) || str(item.description);
    return [{ title, url, published, source: /bing\.com/.test(str(item.link)) ? `${source} (${hostOf(url)})` : source, country, html }];
  });
}

/** Inc42's weekly "Indian startups raised" post tabulates every deal of the week: date, name, amount, round. */
export function roundupRows(item: NewsItem): NewsItem[] {
  if (!item.html || !/<table/i.test(item.html)) return [];
  const $ = load(item.html);
  const rows: NewsItem[] = [];
  $("table tr").each((_, row) => {
    const cells = $(row)
      .find("td")
      .map((_, cell) => $(cell).text().replace(/\s+/g, " ").trim())
      .get();
    if (cells.length < 7) return;
    const [date, name, , , , amount, stage] = cells;
    const published = new Date(`${date} UTC`);
    if (!name || !stage || Number.isNaN(published.getTime())) return;
    rows.push({
      ...item,
      title: `${name} raises ${amount} in ${stage}`,
      published,
      row: { company: name, stage, amount: amount && /\d/.test(amount) ? amount.replace(/\*+$/, "") : null },
    });
  });
  return rows;
}

export async function fetchNews(options: { since: Date; read?: ReadText; bing?: boolean; log?: (m: string) => void }): Promise<NewsItem[]> {
  const read = options.read ?? defaultRead;
  const log = options.log ?? (() => {});
  const jobs: Array<Promise<NewsItem[]>> = [
    ...WORDPRESS.map((site) => wordpressItems(read, site, options.since).catch(fail(site.source))),
    ...FEEDS.map((feed) => read(feed.url).then((r) => parseFeed(r.text, feed.source, feed.country), fail(feed.url))),
  ];
  if (options.bing !== false)
    for (const query of BING_NEWS_QUERIES)
      jobs.push(
        read(
          `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&count=100&qft=sortbydate%3d%221%22&setlang=en-us`,
        ).then((r) => parseFeed(r.text, "Bing News", null), fail(`bing: ${query}`)),
      );
  const items = (await Promise.all(jobs)).flat().filter((item) => item.published >= options.since);
  log(`${items.length} news items since ${iso(options.since)}`);
  return items;

  function fail(label: string) {
    return (error: unknown): NewsItem[] => {
      log(`source failed: ${label} (${(error as Error).message})`);
      return [];
    };
  }
}

interface Candidate {
  company: string;
  /** Every spelling the headlines used, most common first. */
  names: string[];
  items: NewsItem[];
}

const FUNDING_VERB =
  /\b(?:raises?|raised|secures?|secured|bags?|lands?|closes?|nets?|snags?|scores?|picks? up|gets?|receives?|adds?|moves? on|takes? off|kicks? off|leads?|backs?|invests?|participates?|to raise)\b/i;
const FUNDING_FACT =
  /\b(?:seed|series [a-z]|angel|funding|round|investment|financing|capital)\b|[$€£₹]\s?\d|\b(?:Rs|INR|USD|EUR)\.?\s?\d|\d\s?(?:mn|million|crore|cr|k)\b/i;

/** Funding headlines grouped by company: one candidate per company however many outlets covered the round. */
export function fundingCandidates(items: NewsItem[]): { candidates: Candidate[]; skipped: Record<string, number> } {
  const byKey = new Map<string, Candidate>();
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const expanded = items.flatMap((item) => (/startups? raised .* this week/i.test(item.title) ? roundupRows(item) : [item]));
  for (const item of expanded) {
    const reason = item.row ? null : excludedDeal(item.title);
    if (reason) {
      skip(reason);
      continue;
    }
    if (!item.row && !(FUNDING_VERB.test(item.title) && FUNDING_FACT.test(item.title))) {
      skip("not a funding headline");
      continue;
    }
    const company = item.row?.company ?? companyFromHeadline(item.title);
    if (!company) {
      skip("no company in headline");
      continue;
    }
    const key = companyKey(company);
    const existing = byKey.get(key);
    if (existing) {
      existing.items.push(item);
      existing.names.push(company);
    } else byKey.set(key, { company, names: [company], items: [item] });
  }
  // "Two Point O" and "Two Point O Capital" in the same week are one company.
  const keys = [...byKey.keys()].sort((a, b) => a.length - b.length);
  for (const short of keys)
    for (const long of keys) {
      const a = byKey.get(short);
      const b = byKey.get(long);
      if (!a || !b || a === b || short.length < 6 || !long.startsWith(short)) continue;
      b.items.push(...a.items);
      b.names.push(...a.names);
      byKey.delete(short);
      break;
    }
  for (const candidate of byKey.values()) {
    const counts = new Map<string, number>();
    for (const name of candidate.names) counts.set(name, (counts.get(name) ?? 0) + 1);
    candidate.names = [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || b.length - a.length);
    candidate.company = candidate.names[0] ?? candidate.company;
  }
  return { candidates: [...byKey.values()], skipped };
}

interface Page {
  url: string;
  html: string;
}

async function readPage(read: ReadText, url: string, timeoutMs = 12_000): Promise<Page | null> {
  try {
    const response = await read(url, { timeoutMs, maxBytes: 3_000_000 });
    if (!/<html|<body|<head|<!doctype/i.test(response.text.slice(0, 3000))) return null;
    return { url: response.url, html: response.text };
  } catch {
    return null;
  }
}

/** The article's own text: JSON-LD articleBody when the page has one, else its main content. */
export function articleText(html: string): string {
  const $ = load(html);
  for (const element of $("script[type='application/ld+json']").toArray()) {
    try {
      const data = JSON.parse($(element).text());
      for (const node of [data, ...(Array.isArray(data?.["@graph"]) ? data["@graph"] : [])].flat())
        if (typeof node?.articleBody === "string" && node.articleBody.length > 300) return node.articleBody;
    } catch {
      /* not JSON */
    }
  }
  const main = $("article .entry-content, .entry-content, .article-content, .post-content, article, main").first();
  return pageText(main.length ? ($.html(main) ?? html) : html);
}

/** The article's own body, without the outlet's navigation, sidebars and ads. */
function articleBody(html: string): string {
  const $ = load(html);
  const main = $(".entry-content, .article-content, .post-content, article, main").first();
  return main.length ? ($.html(main) ?? "") : html;
}

function links(html: string, base: string): Array<{ href: string; text: string }> {
  const $ = load(html);
  return $("a[href]")
    .toArray()
    .flatMap((element) => {
      try {
        const href = new URL($(element).attr("href") ?? "", base).toString();
        return /^https?:/.test(href) ? [{ href, text: $(element).text().replace(/\s+/g, " ").trim() }] : [];
      } catch {
        return [];
      }
    });
}

const PARKED =
  /domain (?:is )?for sale|buy this domain|this domain (?:name )?(?:is|may be) (?:for sale|available)|parked (?:free|domain)|hugedomains|sedoparking|afternic|dan\.com/i;
const CONTEXT_STOP = new Set(
  `startup startups company companies raises raised raising funding round rounds million crore seed series led investors investor ventures
  capital partners platform based founded today announced which their there would about with from that this into will have been after other
  existing participation business businesses global network services service solutions solution technology technologies development
  customers customer clients products product market markets growth including across support operations expansion expand further
  first since years month months where while these those through under team teams people india indian startup's company's said added
  according statement release press valuation total investment invested financing fresh capital deploy plans plan helps build building
  digital online world leading largest public private limited group based-in headquartered founder founders cofounder chief executive
  officer director managing partner existing angel angels family office offices round's backed backing participation strategic
  innovation innovative develop developing developed nation national international locally powered infrastructure experience
  together partnership million billion secures secured closes closed announces announced recently currently operations latest
  pre-seed raises funds expand expanding scale scaling accelerate support supported brings bring million-dollar oversubscribed`
    .split(/\s+/)
    .filter(Boolean),
);

/** Words from the funding article a real company homepage will share ("satellite", "robots", "payments"). */
export function contextWords(article: string, names: string[] = [], min = 6): string[] {
  const own = new Set(names.flatMap((name) => name.toLowerCase().split(/[^a-z0-9]+/)));
  const words = article
    .toLowerCase()
    .slice(0, 1500)
    .match(new RegExp(String.raw`\b[a-z]{${min},}\b`, "g"));
  return [...new Set((words ?? []).filter((word) => !CONTEXT_STOP.has(word) && !own.has(word)))].slice(0, 60);
}

/** What the funding article says that the company's own homepage should echo. */
export interface SiteEvidence {
  /** Words of the headline ("spacetech", "robotics"): the strongest signal. */
  title: string[];
  /** Words of the article's opening. */
  body: string[];
  /** Founder surnames from the article: a homepage naming one is the company's. */
  surnames: string[];
}

/** Whether a homepage is about the business the article describes, scored on whole words. */
export function evidenceScore(siteText: string, evidence: SiteEvidence): number {
  const words = new Set(siteText.toLowerCase().match(/[a-z]+/g) ?? []);
  if (evidence.surnames.some((name) => words.has(name))) return 10;
  return 2 * evidence.title.filter((word) => words.has(word)).length + evidence.body.filter((word) => words.has(word)).length;
}

const CC_TLDS: Record<string, string> = {
  in: "India",
  "co.in": "India",
  uk: "United Kingdom",
  "co.uk": "United Kingdom",
  de: "Germany",
  fr: "France",
  es: "Spain",
  it: "Italy",
  nl: "Netherlands",
  "com.au": "Australia",
  au: "Australia",
  ng: "Nigeria",
  "com.ng": "Nigeria",
  ke: "Kenya",
  "co.ke": "Kenya",
  "co.za": "South Africa",
  ca: "Canada",
  sg: "Singapore",
  "com.sg": "Singapore",
  jp: "Japan",
  br: "Brazil",
  "com.br": "Brazil",
  be: "Belgium",
  at: "Austria",
  ch: "Switzerland",
  se: "Sweden",
  fi: "Finland",
  dk: "Denmark",
  no: "Norway",
  pl: "Poland",
  pt: "Portugal",
  ie: "Ireland",
  "co.il": "Israel",
  ae: "United Arab Emirates",
  "com.mx": "Mexico",
};

/** A country-code domain for another country than the article's is a namesake, not the company. */
export function tldFitsCountry(url: string, country: string | null): boolean {
  const host = hostOf(url);
  const suffix = rootDomain(host).split(".").slice(1).join(".");
  const tldCountry = CC_TLDS[suffix];
  return !country || !tldCountry || tldCountry === country;
}

function homepageFits(company: string, page: Page, evidence: SiteEvidence, linked: boolean): boolean {
  const $ = load(page.html);
  const title = $("title").first().text();
  const siteName = $("meta[property='og:site_name']").attr("content") ?? "";
  if (!websiteMatches(company, page.url, { title, siteName })) return false;
  const body = pageText(page.html).slice(0, 20_000).toLowerCase();
  if (PARKED.test(body) || body.length < 200) return false;
  const name = company.toLowerCase();
  const core = name.split(/\s+/).filter((token) => token.length >= 3)[0] ?? name;
  if (!body.includes(core) && !`${title} ${siteName}`.toLowerCase().includes(core)) return false;
  const score = evidenceScore(body, evidence);
  // An unlinked domain must echo the headline itself: industry words in the body alone match any agency's client list.
  return linked ? score >= 2 : score >= 10 || (score >= 4 && evidenceScore(body, { ...evidence, body: [] }) >= 2);
}

let searchQueue = Promise.resolve();
let rateLimitedRuns = 0;

/** The result links of DuckDuckGo's HTML results page (each wrapped in a /l/?uddg= redirect). */
export function searchResultLinks(html: string): string[] {
  const out: string[] = [];
  for (const link of links(html, "https://html.duckduckgo.com/")) {
    let href = link.href;
    try {
      const url = new URL(href);
      if (/duckduckgo\.com$/.test(url.hostname) && url.searchParams.get("uddg")) href = url.searchParams.get("uddg") ?? "";
    } catch {
      continue;
    }
    if (href && /^https?:/.test(href) && !/(?:^|\.)duckduckgo\.com$/.test(hostOf(href))) out.push(href);
  }
  return [...new Set(out)];
}

/**
 * DuckDuckGo's public HTML results page, logged out and under SignalRound's own User-Agent; one query at a time so a
 * burst is not rate-limited. (Brave Search answers that User-Agent with HTTP 429, so it is not used, and no browser
 * User-Agent is borrowed.) After three queries in a row end rate-limited, searching stops for the process.
 */
export async function webSearch(read: ReadText, query: string): Promise<string[]> {
  const run = searchQueue.then(async () => {
    if (rateLimitedRuns >= 3) return [];
    for (let attempt = 0; attempt < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, attempt ? 10_000 : 2_000));
      try {
        const response = await read(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          timeoutMs: 15_000,
          headers: { "accept-language": "en-US,en;q=0.9" },
        });
        // A challenge page instead of results is a rate limit.
        if (response.status === 202 || /anomaly-modal|challenge-form/.test(response.text)) continue;
        rateLimitedRuns = 0;
        return searchResultLinks(response.text);
      } catch (error) {
        if (!/HTTP (?:429|403|202)/.test((error as Error).message)) return [];
      }
    }
    rateLimitedRuns += 1;
    return [];
  });
  searchQueue = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** A homepage that fits the name and passed the verify step, with the pages that step read. */
interface VerifiedSite {
  home: Page;
  pages: Page[];
}

/**
 * The company's own homepage: a link in the article, then its name on common TLDs, then a web search. A homepage that
 * fits the name must also pass `verify` (the article names its domain, or the site names the round, an investor or a
 * founder); a namesake that fails is recorded in `rejected` and the search goes on.
 */
async function findWebsite(
  read: ReadText,
  names: string[],
  articles: Page[],
  evidence: SiteEvidence,
  country: string | null,
  verify: (home: Page) => Promise<Page[] | null>,
  rejected: Set<string>,
): Promise<VerifiedSite | null> {
  const company = names[0] ?? "";
  const tried = new Set<string>();
  const attempt = async (url: string, linked = false): Promise<VerifiedSite | null> => {
    const origin = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return "";
      }
    })();
    if (!origin || tried.has(origin) || !tldFitsCountry(origin, country)) return null;
    tried.add(origin);
    const page = await readPage(read, `${origin}/`, 8_000);
    if (!page) return null;
    // A guessed domain that redirects deep into another site (two-point-o.ai → a .com landing page) is not a homepage.
    const landed = new URL(page.url);
    if (!linked && !/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/?|home\/?|index\.html?)?$/i.test(landed.pathname)) return null;
    if (landed.origin !== origin && tried.has(landed.origin)) return null;
    tried.add(landed.origin);
    if (!names.some((name) => homepageFits(name, page, evidence, linked))) return null;
    const pages = await verify(page);
    if (pages) return { home: page, pages };
    rejected.add(rootDomain(hostOf(page.url)));
    return null;
  };
  const linked = articles
    .flatMap((article) => links(articleBody(article.html), article.url))
    .filter((link) => names.some((name) => websiteMatches(name, link.href)));
  for (const link of linked.slice(0, 4)) {
    const site = await attempt(link.href, true);
    if (site) return site;
  }
  const guesses = [...new Set(names.flatMap(domainGuesses))];
  for (let i = 0; i < guesses.length; i += 8) {
    const sites = await Promise.all(guesses.slice(i, i + 8).map((host) => attempt(`https://${host}`)));
    const hit = sites.find(Boolean);
    if (hit) return hit;
  }
  for (const query of [`"${company}" ${evidence.title.slice(0, 2).join(" ")} official website`]) {
    const results = (await webSearch(read, query)).filter((url) => names.some((name) => websiteMatches(name, url))).slice(0, 3);
    for (const url of results) {
      const site = await attempt(url);
      if (site) return site;
    }
  }
  return null;
}

const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a page's HTML (its text or its links) names this domain: "journify.io" is not "journify.ai". */
export function mentionsDomain(html: string, domain: string): boolean {
  return Boolean(domain) && new RegExp(String.raw`(?<![a-z0-9-])${escapeRe(domain)}(?![a-z0-9-])`, "i").test(html);
}

const INVESTOR_STOP = /^(?:the|a|an|its|existing|several|various|other|new|investors?|participation|angels?)$/i;

/** Investors an article says led the round ("led by Northwind Ventures and Example Capital"). */
export function leadInvestors(text: string): string[] {
  const out = new Set<string>();
  const name = String.raw`\p{Lu}[\p{L}\d&'’.-]*(?:\s+(?:\p{Lu}[\p{L}\d&'’.-]*|&|of))*`;
  for (const match of text.matchAll(new RegExp(String.raw`\b(?:co-)?led by\s+(${name}(?:\s*(?:,|and|&)\s*(?:the\s+)?${name})*)`, "gu")))
    for (const part of (match[1] ?? "").split(/\s*(?:,|\band\b)\s*/)) {
      const investor = part
        .replace(/^the\s+/i, "")
        .replace(/[.’']+$/, "")
        .trim();
      if (investor.length >= 3 && !INVESTOR_STOP.test(investor)) out.add(investor);
    }
  return [...out];
}

/**
 * Whether a site's own text names this round: a founder the article names, an investor that led it, or the amount
 * raised in a sentence about funding. Another company with the same name (cowboy.com, the e-bike maker) names none.
 */
export function siteMentionsRound(siteText: string, round: { founders: string[]; investors: string[]; amount: string | null }): boolean {
  const lower = siteText.toLowerCase().replace(/\s+/g, " ");
  if (round.founders.some((name) => name.split(/\s+/).length >= 2 && lower.includes(name.toLowerCase()))) return true;
  if (round.investors.some((name) => new RegExp(String.raw`\b${escapeRe(name.toLowerCase())}\b`).test(lower))) return true;
  const figure = /(\d+(?:[.,]\d+)?)\s?(m|mn|million|k|cr|crore|bn|billion)?\b/i.exec(round.amount ?? "");
  if (!figure?.[1]) return false;
  const unit = (figure[2] ?? "").toLowerCase();
  const units = /^m|^million/.test(unit) ? "(?:m|mn|million)" : unit ? escapeRe(unit) : "(?:m|mn|million|k)";
  const amount = new RegExp(String.raw`(?<![\d.,])${escapeRe(figure[1])}\s?${units}\b`, "i");
  return lower
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => amount.test(sentence) && /\b(?:rais|fund|round|seed|series|invest|financ)/i.test(sentence));
}

/**
 * The article's own one-line description of the company ("Journify, a customer data platform for marketers, …"):
 * the first sentence near the top that names the company and says what it is or does.
 */
export function descriptorSentence(text: string, company: string): string | null {
  const first = companyFirst(company);
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[\p{Lu}"“])/u)
    .slice(0, 12)
    .filter((sentence) => sentence.toLowerCase().includes(first));
  const describes =
    /\b(?:is an?|is the|, an?\b|, the\b|which (?:builds|develops|makes|provides|offers|helps|runs)|builds|develops|provides|offers|helps|makes|operates|enables|lets|specialises|specializes|focuses)\b/i;
  const hit =
    sentences.find((sentence) => describes.test(sentence) && !/\b(?:rais|secur|clos)\w*\b/i.test(sentence)) ??
    sentences.find((sentence) => describes.test(sentence));
  return hit ? hit.trim().slice(0, 220) : null;
}

const SITE_LINK =
  /contact|about|team|founder|leadership|people|company|imprint|impressum|legal|privacy|press|media|story|who-we-are|our-story|kontakt/i;
const SITE_PATHS = ["/contact", "/contact-us", "/about", "/about-us", "/team", "/imprint", "/impressum", "/privacy-policy"];

async function companyPages(read: ReadText, home: Page): Promise<Page[]> {
  const root = rootDomain(hostOf(home.url));
  const origin = new URL(home.url).origin;
  const found = links(home.html, home.url)
    .filter((link) => rootDomain(hostOf(link.href)) === root && (SITE_LINK.test(new URL(link.href).pathname) || SITE_LINK.test(link.text)))
    .map((link) => link.href.split("#")[0] ?? link.href);
  const urls = [...new Set([...found, ...SITE_PATHS.map((path) => `${origin}${path}`)])].filter((url) => url !== home.url).slice(0, 9);
  const pages = await pool(urls, 4, (url) => readPage(read, url, 8_000));
  const seen = new Set<string>([home.html.length.toString()]);
  return [home, ...pages.filter((page): page is Page => !!page && rootDomain(hostOf(page.url)) === root)].filter((page) => {
    // Unknown paths often serve the homepage again.
    const key = page.html.length.toString();
    if (page !== home && seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function brief(home: Page): string | null {
  const $ = load(home.html);
  const raw =
    $("meta[name='description']").attr("content")?.trim() ||
    $("meta[property='og:description']").attr("content")?.trim() ||
    $("h1").first().text().trim() ||
    $("title").first().text();
  const value = raw?.replace(/\s+/g, " ").trim();
  if (!value) return null;
  const first = value.split(/(?<=[.!?])\s+/)[0] ?? value;
  return (first.length >= 25 ? first : value).slice(0, 220);
}

const FREE_MAIL = /@(?:gmail|googlemail|outlook|hotmail|yahoo|proton|protonmail|icloud|me|zoho)\.[a-z.]+$/i;

function emailBelongs(email: string, company: string, website: string | null, country: string | null): boolean {
  const domain = email.split("@")[1] ?? "";
  if (website && rootDomain(domain) === rootDomain(hostOf(website))) return true;
  if (!tldFitsCountry(`https://${domain}`, country)) return false;
  return websiteMatches(company, `https://${domain}`);
}

/** Research one company: its round, website, founders and public emails. Null when the round is out of scope. */
export async function researchCompany(read: ReadText, candidate: Candidate): Promise<FundedCompany | { skipped: string }> {
  const items = [...candidate.items].sort((a, b) => Number(!!a.row) - Number(!!b.row) || a.published.getTime() - b.published.getTime());
  const articles: Page[] = [];
  const bodies: Array<{ url: string; text: string }> = [];
  for (const item of items.filter((item) => !item.row).slice(0, 3)) {
    let page: Page | null = item.html && item.html.length > 1500 ? { url: item.url, html: item.html } : null;
    if (!page && !item.row) page = await readPage(read, item.url);
    if (!page) continue;
    articles.push(page);
    bodies.push({ url: item.url, text: item.html && page.html === item.html ? pageText(item.html) : articleText(page.html) });
  }
  const primary = items.find((item) => !item.row && bodies.some((body) => body.url === item.url)) ?? items[0];
  if (!primary) return { skipped: "no source" };
  const primaryText = bodies.find((body) => body.url === primary.url)?.text ?? "";
  // The stage: the roundup cell, the headline, then the article's own sentences that announce the raise.
  const row = items.find((item) => item.row && readStage(item.row.stage))?.row;
  let stage = row ? readStage(row.stage) : null;
  for (const item of items) stage ??= readStage(item.title);
  for (const body of bodies) {
    if (stage) break;
    const first = companyFirst(candidate.company);
    const sentence = body.text
      .split(/(?<=[.!?])\s+/)
      .slice(0, 8)
      .filter((s) => s.toLowerCase().includes(first) && /\b(?:rais|secur|clos|bag|funding|round)/i.test(s));
    for (const s of sentence) stage ??= readStage(s);
  }
  if (!stage) return { skipped: "no stage stated" };
  if ("excluded" in stage) return { skipped: stage.excluded };
  const allText = bodies.map((body) => body.text).join("\n");
  if (/\b(?:venture debt|debt financing)\b/i.test(primary.title)) return { skipped: "debt" };

  const founders = new Map<string, Founder>();
  const addFounder = (mention: FounderMention, sourceUrl: string) => {
    const key = mention.name.toLowerCase();
    if (founders.has(key)) return;
    founders.set(key, {
      name: mention.name,
      role: mention.role,
      source_url: sourceUrl,
      quote: mention.quote,
      linkedin_url: null,
      emails: [],
    });
  };
  for (const body of bodies) {
    // An article about several rounds ("A, B and C raise…") only names this company's founders next to its name.
    const title = items.find((item) => item.url === body.url)?.title ?? "";
    const strict =
      /(?:,| and | & ).*\b(?:raise|secure|bag|land|get|net|close)\b(?!s)/i.test(title) ||
      !title.toLowerCase().includes(companyFirst(candidate.company));
    for (const mention of foundersFromText(body.text, candidate.company, { strict })) addFounder(mention, body.url);
  }
  const country = countryFromText(`${primary.title}. ${primaryText}`, primary.country) ?? countryFromText(allText);
  const evidence: SiteEvidence = {
    title: contextWords(items.map((item) => item.title).join(" "), candidate.names, 5),
    body: contextWords(primaryText, candidate.names),
    surnames: [...founders.values()].map((f) => f.name.toLowerCase().split(/\s+/).at(-1) ?? "").filter((n) => n.length >= 4),
  };
  const amount = row?.amount ?? amountAsWritten(primary.title) ?? amountFromText(primaryText, candidate.company);
  // A homepage is the company's only when a funding article names its domain, or the site itself names the round, an
  // investor that led it or a founder: journify.ai, cowboy.com (e-bikes) and phaze.ai are other companies' sites.
  const round = { founders: [...founders.values()].map((f) => f.name), investors: leadInvestors(allText), amount };
  const sources: Page[] = [...articles];
  let unread = items.filter((item) => !item.row && !articles.some((article) => article.url === item.url)).map((item) => item.url);
  const verify = async (home: Page): Promise<Page[] | null> => {
    const domain = rootDomain(hostOf(home.url));
    if (sources.some((page) => mentionsDomain(page.html, domain))) return companyPages(read, home);
    while (unread.length && sources.length < 6) {
      const [url, ...rest] = unread;
      unread = rest;
      const page = url ? await readPage(read, url) : null;
      if (!page) continue;
      sources.push(page);
      if (mentionsDomain(page.html, domain)) return companyPages(read, home);
    }
    const pages = await companyPages(read, home);
    return siteMentionsRound(pages.map((page) => pageText(page.html)).join("\n"), round) ? pages : null;
  };
  const rejected = new Set<string>();
  const site = await findWebsite(read, candidate.names, articles, evidence, country, verify, rejected);
  const home = site?.home ?? null;
  const pages = site?.pages ?? [];
  for (const page of pages) {
    if (page === home || /about|team|founder|leadership|people|company|story|who-we-are/i.test(new URL(page.url).pathname))
      for (const mention of foundersFromTeamPage(page.html, candidate.company)) addFounder(mention, page.url);
    // A contact card or imprint line that titles someone CEO, founder or managing director ("Ana Example" / "CEO").
    for (const mention of leadersFromText(pageText(page.html), candidate.company)) addFounder(mention, page.url);
  }

  const allLinks = [...articles, ...pages].flatMap((page) => links(page.html, page.url));
  for (const founder of founders.values()) founder.linkedin_url = linkedinFor(founder.name, allLinks);

  const website = home ? `${new URL(home.url).origin}/` : null;
  const companyEmails = new Map<string, CompanyEmail>();
  for (const page of [...pages, ...articles]) {
    const own = pages.includes(page);
    // Quotes carry the card's name and title above a bare address ("Ana Example · CEO · ana@acme.example").
    for (const found of pageEmailsInContext(page.html, page.url)) {
      if (rejected.has(rootDomain(found.email.split("@")[1] ?? ""))) continue;
      const belongs = emailBelongs(found.email, candidate.company, website, country);
      const kind = classifyEmail(found.email, [...founders.values()], found.quote);
      // A founder's free-mail address counts only when the company's own page prints it as theirs.
      const personal = kind.founder && (belongs || (own && FREE_MAIL.test(found.email)));
      if (personal) {
        const founder = founders.get(kind.founder?.toLowerCase() ?? "");
        if (founder && !founder.emails.some((e) => e.email === found.email)) founder.emails.push({ ...found, kind: "founder_personal" });
        continue;
      }
      if (!belongs || !isOutreachEmail(found.email) || companyEmails.has(found.email)) continue;
      companyEmails.set(found.email, { ...found, kind: "company_inbox", inbox: kind.inbox });
    }
  }
  // Without a verified site, the article's own sentence about the company is its brief.
  const summary = home ? brief(home) : descriptorSentence(primaryText, candidate.company);
  const industry = classifyIndustry([
    { text: summary, url: home?.url ?? primary.url, weight: 3 },
    { text: primary.title, url: primary.url, weight: 2 },
    { text: home ? pageText(home.html).slice(0, 4000) : null, url: home?.url, weight: 1 },
  ]);
  return {
    company: candidate.company,
    website,
    brief: summary,
    industry,
    country,
    stage: row?.stage ?? stage.asWritten,
    stage_key: stage.key,
    amount,
    announced_on: iso(items.reduce((min, item) => (item.published < min ? item.published : min), primary.published)),
    funding_source_url: primary.url,
    other_sources: [...new Set(items.map((item) => item.url))].filter((url) => url !== primary.url),
    founders: [...founders.values()],
    company_emails: [...companyEmails.values()].sort((a, b) => inboxRank(a.inbox) - inboxRank(b.inbox)),
  };
}

const INBOX_ORDER: InboxType[] = ["founders", "general", "person", "sales", "press", "other", "careers", "support"];
const inboxRank = (inbox: InboxType) => INBOX_ORDER.indexOf(inbox);
const companyFirst = (company: string) => {
  const tokens = company.toLowerCase().split(/\s+/);
  return (tokens.find((token) => token.length >= 3 && !["the", "and"].includes(token)) ?? tokens[0] ?? "").replace(/[^\p{L}\p{N}]/gu, "");
};

function amountFromText(body: string, company: string): string | null {
  const first = companyFirst(company);
  const sentence = body
    .split(/(?<=[.!?])\s+/)
    .slice(0, 6)
    .find((s) => s.toLowerCase().includes(first) && /\b(?:rais|secur|clos|bag)/i.test(s));
  return sentence ? amountAsWritten(sentence) : null;
}

export interface CollectFundedOptions {
  days: number;
  now?: Date;
  read?: ReadText;
  bing?: boolean;
  limit?: number;
  log?: (message: string) => void;
}

export async function collectFunded(options: CollectFundedOptions): Promise<FundedRun> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - options.days * DAY_MS);
  const read = options.read ?? defaultRead;
  const log = options.log ?? (() => {});
  const items = await fetchNews({ since, read, bing: options.bing, log });
  const { candidates, skipped } = fundingCandidates(items);
  log(
    `${candidates.length} companies with a funding headline (${Object.entries(skipped)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ")})`,
  );
  const stats: Record<string, number> = { news_items: items.length, candidates: candidates.length, ...prefix("headline_skipped", skipped) };
  const results = await pool(candidates.slice(0, options.limit ?? candidates.length), 6, async (candidate) => {
    try {
      const result = await researchCompany(read, candidate);
      if ("skipped" in result) log(`  skip ${candidate.company}: ${result.skipped}`);
      else
        log(
          `  ${result.company} — ${result.stage} ${result.amount ?? ""} — ${result.website ?? "no site"} — ${result.founders.length} founder(s), ${result.company_emails.length + result.founders.reduce((n, f) => n + f.emails.length, 0)} email(s)`,
        );
      return result;
    } catch (error) {
      log(`  failed ${candidate.company}: ${(error as Error).message}`);
      return { skipped: "error" };
    }
  });
  const found = mergeByWebsite(results.filter((result): result is FundedCompany => !("skipped" in result)));
  for (const result of results) if ("skipped" in result) stats[`skipped_${result.skipped}`] = (stats[`skipped_${result.skipped}`] ?? 0) + 1;
  const companies = postedContactsOnly(found);
  companies.sort((a, b) => b.announced_on.localeCompare(a.announced_on) || a.company.localeCompare(b.company));
  Object.assign(stats, {
    researched: found.length,
    dropped_no_posted_email: found.length - companies.length,
    companies: companies.length,
    with_website: companies.filter((c) => c.website).length,
    with_founder_name: companies.filter((c) => c.founders.length).length,
    with_founder_email: companies.filter((c) => c.founders.some((f) => f.emails.length)).length,
    with_any_email: companies.filter((c) => c.company_emails.length || c.founders.some((f) => f.emails.length)).length,
  });
  return { generated_at: now.toISOString(), window_days: options.days, stats, companies };
}

const prefix = (name: string, values: Record<string, number>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [`${name}_${k}`, v]));

/** Two headline spellings that resolve to one website are one company. */
function mergeByWebsite(companies: FundedCompany[]): FundedCompany[] {
  const byHost = new Map<string, FundedCompany>();
  const out: FundedCompany[] = [];
  for (const company of companies) {
    const host = company.website ? rootDomain(hostOf(company.website)) : null;
    const existing = host ? byHost.get(host) : undefined;
    if (!existing) {
      if (host) byHost.set(host, company);
      out.push(company);
      continue;
    }
    existing.other_sources = [...new Set([...existing.other_sources, company.funding_source_url, ...company.other_sources])];
    for (const founder of company.founders) if (!existing.founders.some((f) => f.name === founder.name)) existing.founders.push(founder);
    for (const email of company.company_emails)
      if (!existing.company_emails.some((e) => e.email === email.email)) existing.company_emails.push(email);
  }
  return out;
}

/** --apply: each company becomes a funding signal (its website feeds the jobs collector), with its people and emails. */
/**
 * The signal URL for one company's round: the article URL plus a fragment naming the company, so the companies of one
 * roundup article (which share its URL) are separate signals instead of overwriting each other.
 */
export function fundingSignalUrl(company: Pick<FundedCompany, "company" | "funding_source_url">): string {
  const url = new URL(company.funding_source_url);
  url.hash = `company=${encodeURIComponent(companyKey(company.company) || company.company.toLowerCase())}`;
  return url.toString();
}

export async function storeFunded(handle: Db, run: FundedRun): Promise<{ signals: number; people: number; emails: number }> {
  let people = 0;
  let emails = 0;
  const companies = postedContactsOnly(run.companies);
  for (const company of companies) {
    const signal = await ingestSignal(handle, {
      channel: "funding-news",
      url: fundingSignalUrl(company),
      title: `${company.company} raises ${company.amount ?? "undisclosed"} (${company.stage})`,
      summary: company.brief,
      company: company.company,
      author: null,
      published_at: company.announced_on,
      confidence: null,
      tags: [company.stage_key],
      metadata: {
        company_website: company.website,
        stage: company.stage,
        stage_key: company.stage_key,
        amount: company.amount,
        country: company.country,
        industry: company.industry,
        funding_source_url: company.funding_source_url,
        other_sources: company.other_sources,
      },
    });
    const ids = new Map<string, string>();
    for (const founder of company.founders) {
      const [row] = await handle
        .insert(schema.signalPeople)
        .values({
          id: randomUUID(),
          signalId: signal.id,
          company: company.company,
          companyWebsite: company.website,
          name: founder.name,
          role: founder.role,
          sourceUrl: founder.source_url,
          quote: founder.quote,
          linkedinUrl: founder.linkedin_url,
        })
        .onConflictDoUpdate({
          target: [schema.signalPeople.signalId, schema.signalPeople.name],
          set: {
            role: founder.role,
            sourceUrl: founder.source_url,
            quote: founder.quote,
            linkedinUrl: founder.linkedin_url,
            updatedAt: new Date(),
          },
        })
        .returning({ id: schema.signalPeople.id });
      if (row) ids.set(founder.name, row.id);
      people += 1;
    }
    const rows = [
      ...company.founders.flatMap((founder) =>
        founder.emails.map((email) => ({ ...email, personId: ids.get(founder.name) ?? null, inbox: "person" as InboxType })),
      ),
      ...company.company_emails.map((email) => ({ ...email, personId: null })),
    ];
    for (const email of rows) {
      await handle
        .insert(schema.signalEmails)
        .values({
          id: randomUUID(),
          signalId: signal.id,
          personId: email.personId,
          email: email.email,
          kind: email.kind,
          inbox: email.inbox,
          sourceUrl: email.source_url,
          quote: email.quote,
        })
        .onConflictDoUpdate({
          target: [schema.signalEmails.signalId, schema.signalEmails.email],
          set: {
            personId: email.personId,
            kind: email.kind,
            inbox: email.inbox,
            sourceUrl: email.source_url,
            quote: email.quote,
            updatedAt: new Date(),
          },
        });
      emails += 1;
    }
  }
  return { signals: companies.length, people, emails };
}
