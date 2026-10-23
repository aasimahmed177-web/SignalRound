// Corroboration reads a second opinion on a stored round. Ingest uses a focused search;
// scheduled verification searches the amount, lead, and raise separately, then maps the
// company's and investor's sites. Every attached page still passes same-round acceptance.
// https://docs.firecrawl.dev/features/search

import type { PageClassifier } from "../llm/jev.ts";
import { dedupeInvestorNames } from "../records/investors.ts";
import {
  canonicalUrl,
  classifyStage,
  hostOf,
  isArticleUrl,
  isJobPostingUrl,
  namesCompany,
  normalizeCompanyKey,
  normalizeInvestorKey,
  parseAmount,
  registrableDomain,
  SOCIAL_AND_DIRECTORY_HOSTS,
} from "../records/normalize.ts";
import type { ExtractedItem } from "../records/resolve.ts";
import { DEFAULT_TIERS, reconcileInvestorLists, resolveRounds, sameRoundWindow, settleDate, surerDate } from "../records/resolve.ts";
import { BAND_OF_STAGE, isStageless } from "../records/routing.ts";
import type { FeedRecord, Stage } from "../records/schema.ts";
import { STAGES } from "../records/schema.ts";
import { sourceFit } from "../records/source-fit.ts";
import type { Document, NativeWebClient, SearchResultNews, SearchResultWeb } from "../web/client.ts";
import { extractionCredits, searchCredits } from "./credits.ts";
import { searchName } from "./enrich.ts";
import type { ExtractResult } from "./extract.ts";
import { extractRounds } from "./extract.ts";

export interface CorroborationInput {
  company_name: string;
  stage_as_written: string;
  amount_as_written: string | null;
  announced_date: string | null;
  /** The normalized stage; derived from stage_as_written when absent. */
  stage?: Stage;
  /** The company's registrable domain when known; its own pages are the best second source. */
  company_domain?: string | null;
  company_domains?: string[];
  investor_domain?: string | null;
  /** What the company does, as the record has it; a word or two of it sharpens the search. */
  company_description?: string | null;
  company_headquarters?: string | null;
  /** The record's lead investors; the first one goes into the search. */
  lead_investors?: string[];
  /** URLs already on the record. Never read again. */
  known_urls?: string[];
  /** Where the record's day came from (see FeedRecord.date_basis); a borrowed day may be a late page's. */
  date_basis?: FeedRecord["date_basis"] | null;
  /** How well the record knows its day; a list's week or month may be a late page's too. */
  date_precision?: FeedRecord["date_precision"] | null;
}

export interface CorroborationOptions {
  /** Search results to ask for; the default 5 is one search credit unit. */
  limit?: number;
  /** Pages to extract at most. */
  maxPages?: number;
  /** Publisher tiers by host, layered over DEFAULT_TIERS. */
  tiers?: Record<string, number>;
  now?: Date;
  /** The scheduled pass looks for coverage from several independent angles. */
  broad?: boolean;
  /** An unsettled claim gets a dedicated search for the issuer's closing announcement. */
  seekAnnouncement?: boolean;
  classify?: PageClassifier | null;
}

/** One search result as the selector sees it. */
export interface CorroborationCandidate {
  url: string;
  title?: string;
  published?: string;
  snippet?: string;
  kind?: "primary" | "news" | "aggregator" | "other";
}

const MS_PER_DAY = 86_400_000;
/** Coverage of a round is written inside a month of it. */
const RECENCY_DAYS = 30;
/** How far before the announcement a corroborating page may be dated (an embargo leak, a Form D). */
const LEAD_DAYS = 3;
/** How far back the search and its pages reach for the release of a round whose day may be late. */
const REACH_BACK_DAYS = 365;
/** An earlier reading is this round's own announcement only when its amount agrees this closely. */
const EARLIER_AMOUNT_TOLERANCE = 0.1;

/**
 * Whether the record's day may be a later page's day rather than the announcement: it came from a
 * byline, a URL, or a search result, or it is a list's week or month, not a sentence that states it.
 * Coverage can trail a round by months (Term Sheet listed Fearn's June seed on Sep 23, a trend story
 * listed Xpeng Robotics' August round), so such a record's search and pages reach back a year.
 */
export function mayBeLate(input: Pick<CorroborationInput, "announced_date" | "date_basis" | "date_precision">): boolean {
  if (!input.announced_date) return false;
  if (input.date_basis !== "stated") return true;
  return Boolean(input.date_precision) && input.date_precision !== "day";
}

function tbsDate(d: Date): string {
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

/**
 * Search recency for a record: the last 30 days when the round is undated or recent, else a
 * custom range around the announcement (a record found late still gets its coverage). A record
 * whose day may be late searches the past year, where its release would be.
 */
export function corroborationTbs(announcedDate: string | null, now: Date = new Date(), reachBack = false): string {
  if (reachBack) return "qdr:y";
  const announced = announcedDate ? new Date(`${announcedDate}T12:00:00Z`) : null;
  if (!announced || Number.isNaN(announced.getTime()) || now.getTime() - announced.getTime() <= RECENCY_DAYS * MS_PER_DAY) return "qdr:m";
  const from = new Date(announced.getTime() - LEAD_DAYS * MS_PER_DAY);
  const to = new Date(announced.getTime() + RECENCY_DAYS * MS_PER_DAY);
  return `cdr:1,cd_min:${tbsDate(from)},cd_max:${tbsDate(to)}`;
}

/** A search engine reads about this many terms; past it, the tail is ignored or the query over-constrains. */
const MAX_QUERY_TERMS = 12;
/** How many words of the description go into the query. */
const DESCRIPTION_TERMS = 2;
const DESCRIPTION_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "for",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "into",
  "as",
  "that",
  "which",
  "this",
  "it",
  "its",
  "is",
  "are",
  "was",
  "be",
  "has",
  "have",
  "their",
  "they",
  "we",
  "our",
  "you",
  "your",
  "company",
  "startup",
  "builds",
  "building",
  "makes",
  "making",
  "provides",
  "offers",
  "helps",
  "develops",
  "based",
]);

/** "Khosla Ventures" as a search term is "Khosla": the firm's own name, without the generic tail publishers vary. */
function investorHead(name: string): string {
  const keyTokens = new Set(normalizeInvestorKey(name).split(" ").filter(Boolean));
  const words = name.split(/\s+/).filter((w) => keyTokens.has(normalizeCompanyKey(w)));
  return words.length > 0 ? words.join(" ") : name.trim();
}

/** The first two content words of the description that are not the company's own name. */
function descriptionTerms(description: string | null | undefined, companyName: string): string[] {
  if (!description) return [];
  const own = new Set(normalizeCompanyKey(companyName).split(" ").filter(Boolean));
  const out: string[] = [];
  for (const word of description.split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 2) continue;
    const lower = word.toLowerCase();
    if (DESCRIPTION_STOPWORDS.has(lower) || own.has(normalizeCompanyKey(word))) continue;
    out.push(word);
    if (out.length === DESCRIPTION_TERMS) break;
  }
  return out;
}

/**
 * The search for a record: every distinguishing fact it has, in the order a common name needs
 * them. `"Acme" "Khosla" seed $7.5M AI assistant`: the name and the lead quoted, then the
 * stage as written, the amount as written, and two words of the description. At most
 * MAX_QUERY_TERMS words; when the budget is short the description is the first to go and the
 * name never goes.
 */
export function corroborationQuery(
  input: Pick<
    CorroborationInput,
    "company_name" | "company_domain" | "stage_as_written" | "amount_as_written" | "lead_investors" | "company_description"
  >,
): string {
  const name = `"${searchName(input.company_name, input.company_domain)}"`;
  const parts: string[] = [];
  const lead = input.lead_investors?.find((n) => n.trim().length > 0);
  if (lead) parts.push(`"${investorHead(lead)}"`);
  if (input.stage_as_written.trim()) parts.push(input.stage_as_written.trim());
  if (input.amount_as_written?.trim()) parts.push(input.amount_as_written.trim());
  parts.push(...descriptionTerms(input.company_description, input.company_name));

  const out = [name];
  let words = name.split(/\s+/).length;
  for (const part of parts) {
    const n = part.split(/\s+/).length;
    if (words + n > MAX_QUERY_TERMS) break;
    out.push(part);
    words += n;
  }
  return out.join(" ");
}

/**
 * Which results to read: not a page the record already has, not a social or directory page,
 * one entry per canonical URL, the company's own domain first, then by publisher tier, then
 * search rank. At most `max`.
 */
export function selectCorroborationUrls(
  results: CorroborationCandidate[],
  opts: { knownUrls: string[]; companyDomain?: string | null; tiers?: Record<string, number>; max?: number },
): CorroborationCandidate[] {
  const tiers = { ...DEFAULT_TIERS, ...opts.tiers };
  const known = new Set(opts.knownUrls.map(canonicalUrl));
  const seen = new Set<string>();
  const ranked: Array<{ candidate: CorroborationCandidate; score: number; position: number }> = [];
  results.forEach((candidate, position) => {
    const key = canonicalUrl(candidate.url);
    if (known.has(key) || seen.has(key)) return;
    const domain = registrableDomain(candidate.url);
    if (!domain || SOCIAL_AND_DIRECTORY_HOSTS.has(domain)) return;
    seen.add(key);
    const host = hostOf(candidate.url);
    const own = opts.companyDomain !== null && opts.companyDomain !== undefined && domain === opts.companyDomain;
    // A page sourceFit would never attach is not worth a scrape: a job posting names the company and its
    // latest round, and a front page or a search page lists it among the hour's other stories.
    if (isJobPostingUrl(candidate.url) || (!own && !isArticleUrl(candidate.url))) return;
    const tier = tiers[host] ?? tiers[domain] ?? 0.3;
    const score = own
      ? 2
      : candidate.kind === "primary"
        ? 1.5
        : tier >= 1
          ? Math.max(tier, 1.25)
          : candidate.kind === "news"
            ? 1.1
            : candidate.kind === "aggregator"
              ? 0.1
              : tier;
    ranked.push({ candidate, score, position });
  });
  ranked.sort((a, b) => b.score - a.score || a.position - b.position);
  return ranked.slice(0, opts.max ?? 3).map((r) => r.candidate);
}

export interface CorroborationSearch {
  query: string;
  candidates: CorroborationCandidate[];
  resultCount: number;
  creditsEstimated: number;
  /** Pages found on the company's own site by mapping it (0, 1, or 2), read ahead of the search's. */
  newsroom?: number;
}

/** A link on the company's site that reads like the page about a round: a post or release, not a section, a product, or a job. */
const NEWSROOM_PATH =
  /\/(?:news|newsroom|press|press-releases?|blog|announcements?|media|updates?|stories|journal|insights?|resources)(?:\/|$)|(?:raise[sd]?|funding|series-[a-f]|seed|investment|round|closes|announces?|secures?)/i;
const NEWSROOM_NOT_ARTICLE =
  /^\/?(?:news|newsroom|press|press-releases?|blog|announcements?|media|updates?|stories|journal|insights?|resources)\/?(?:page\/\d+\/?)?$|\/(?:tag|tags|category|categories|author|topics?)\//i;
const ROUND_WORDS =
  /\b(?:raise[sd]?|raising|funding|series [a-f]\b|series-[a-f]\b|seed|pre-seed|investment|round|closes?|announces?|secures?|million|billion|\$|€|£)/i;

/**
 * Which of a site's links to read as the company's own announcement: a post whose title or path carries
 * round language, ranked by how many round words it carries and the stage label when the title names it,
 * never a section index, a tag page, or a page the record already has. At most two.
 */
export function selectNewsroomLinks(
  links: Array<{ url: string; title?: string; description?: string }>,
  input: Pick<CorroborationInput, "stage_as_written" | "known_urls" | "company_domain">,
  max = 2,
): CorroborationCandidate[] {
  const known = new Set((input.known_urls ?? []).map(canonicalUrl));
  const stageWord = input.stage_as_written.toLowerCase().replace(/\s+/g, " ").trim();
  const seen = new Set<string>();
  const ranked: Array<{ candidate: CorroborationCandidate; score: number; position: number }> = [];
  links.forEach((link, position) => {
    let path: string;
    try {
      const u = new URL(link.url);
      if (input.company_domain && registrableDomain(link.url) !== input.company_domain) return;
      path = u.pathname;
    } catch {
      return;
    }
    const key = canonicalUrl(link.url);
    if (known.has(key) || seen.has(key)) return;
    if (NEWSROOM_NOT_ARTICLE.test(path) || path === "/" || path === "") return;
    const text = `${link.title ?? ""} ${link.description ?? ""} ${path.replace(/[-_/]/g, " ")}`;
    if (!NEWSROOM_PATH.test(path) && !ROUND_WORDS.test(link.title ?? "")) return;
    seen.add(key);
    const words = (text.match(ROUND_WORDS) ?? []).length;
    const namesStage = stageWord.length > 0 && text.toLowerCase().includes(stageWord);
    ranked.push({ candidate: { url: link.url, title: link.title }, score: words + (namesStage ? 3 : 0), position });
  });
  ranked.sort((a, b) => b.score - a.score || a.position - b.position);
  return ranked
    .filter((r) => r.score > 0)
    .slice(0, max)
    .map((r) => r.candidate);
}

/** One `map` credit. */
export const MAP_CREDITS = 0;

/**
 * The company's own page about the round, found by mapping its site: the source that fixes the day, the
 * amount, and the syndicate when the press has only a republisher's or a roundup's reading. One credit
 * when the record knows the company's domain and has none of its pages yet.
 */
async function mapNewsroom(
  client: NativeWebClient,
  input: CorroborationInput,
  refreshKnown = false,
): Promise<{ candidates: CorroborationCandidate[]; creditsEstimated: number }> {
  const domains = [...new Set([input.company_domain, ...(input.company_domains ?? [])].filter((d): d is string => Boolean(d)))];
  if (input.investor_domain) domains.push(input.investor_domain);
  const mapped = await Promise.all(
    domains.map(async (domain) => {
      if (!refreshKnown && (input.known_urls ?? []).some((u) => registrableDomain(u) === domain))
        return { candidates: [], creditsEstimated: 0 };
      const investor = domain === input.investor_domain;
      const search = investor
        ? input.company_name
        : [input.company_name, input.stage_as_written, "funding", "raises"].filter(Boolean).join(" ");
      try {
        const result = await client.map(`https://${domain}`, { search, limit: 30, includeSubdomains: true, timeout: 30_000 });
        const links = (result.links ?? []).map((l) => ({ url: l.url, title: l.title, description: l.description }));
        return {
          candidates: selectNewsroomLinks(links, { ...input, company_domain: domain }, 2),
          creditsEstimated: MAP_CREDITS,
        };
      } catch {
        return { candidates: [], creditsEstimated: 0 };
      }
    }),
  );
  return { candidates: mapped.flatMap((r) => r.candidates), creditsEstimated: mapped.reduce((n, r) => n + r.creditsEstimated, 0) };
}

/** Step 1: search news and web, retrying a less constrained shape only when no page is selectable. */
export async function searchCorroboration(
  client: NativeWebClient,
  input: CorroborationInput,
  opts: CorroborationOptions = {},
): Promise<CorroborationSearch> {
  const limit = opts.limit ?? 5;
  const name = `"${searchName(input.company_name, input.company_domain)}"`;
  const firstQueries = opts.broad
    ? [
        ...(opts.seekAnnouncement
          ? [
              [
                name,
                "announces",
                input.stage_as_written,
                input.amount_as_written,
                input.company_domain ? `site:${input.company_domain}` : null,
              ]
                .filter(Boolean)
                .join(" "),
              [name, "announces", input.stage_as_written, input.amount_as_written].filter(Boolean).join(" "),
            ]
          : []),
        [name, input.stage_as_written, input.amount_as_written].filter(Boolean).join(" "),
        [name, input.lead_investors?.[0] ? `"${investorHead(input.lead_investors[0])}"` : null, "funding"].filter(Boolean).join(" "),
        `${name} raises`,
      ]
    : [corroborationQuery(input)];
  const searchOptions = {
    sources: ["news", "web"] as ["news", "web"],
    tbs: corroborationTbs(input.announced_date, opts.now, Boolean(opts.broad) || mayBeLate(input)),
    limit,
    highlights: Boolean(opts.broad),
  };
  async function batch(queries: string[]) {
    const settled = await Promise.allSettled(queries.map((q) => client.search(q, searchOptions)));
    const responses = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (responses.length === 0) return null;
    const results: CorroborationCandidate[] = [];
    for (const result of responses)
      for (const kind of ["news", "web"] as const) {
        const list = (result[kind] ?? []) as Array<SearchResultWeb | SearchResultNews | Document>;
        for (const item of list) {
          const url = "url" in item ? item.url : (item as Document).metadata?.sourceURL;
          if (!url) continue;
          const title = "title" in item ? item.title : (item as Document).metadata?.title;
          const published = "date" in item ? (item as SearchResultNews).date : undefined;
          const snippet = "description" in item ? item.description : undefined;
          const highlights = "highlights" in item ? item.highlights : undefined;
          results.push({
            url,
            title,
            published,
            snippet: [
              typeof snippet === "string" ? snippet : "",
              ...(Array.isArray(highlights) ? highlights.filter((h): h is string => typeof h === "string") : []),
            ]
              .filter(Boolean)
              .join(" "),
          });
        }
      }
    if (opts.classify) {
      const verdicts = await opts.classify(
        results.map((r) => ({ company: input.company_name, url: r.url, title: r.title, snippet: r.snippet })),
      );
      results.forEach((r, i) => {
        if (verdicts[i] && verdicts[i].kindConfidence >= 0.85) r.kind = verdicts[i].kind;
      });
    }
    return {
      candidates: selectCorroborationUrls(results, {
        knownUrls: input.known_urls ?? [],
        companyDomain: input.company_domain,
        tiers: opts.tiers,
        max: opts.maxPages ?? (opts.broad ? 6 : undefined),
      }),
      resultCount: results.length,
      creditsEstimated: responses.reduce((n, r) => n + searchCredits((r.news?.length ?? 0) + (r.web?.length ?? 0) || limit), 0),
    };
  }
  const first = await batch(firstQueries);
  if (!first) throw new Error("All corroboration searches failed");
  const fallbackQuery = [name, input.amount_as_written?.trim(), ...descriptionTerms(input.company_description, input.company_name)]
    .filter(Boolean)
    .join(" ");
  const shouldRetry = opts.maxPages !== 0 && first.candidates.length === 0 && !firstQueries.includes(fallbackQuery);
  const retry = shouldRetry ? await batch([fallbackQuery]) : null;
  return {
    query: [...firstQueries, ...(shouldRetry ? [fallbackQuery] : [])].join(" | "),
    candidates: retry?.candidates ?? first.candidates,
    resultCount: first.resultCount + (retry?.resultCount ?? 0),
    creditsEstimated: first.creditsEstimated + (retry?.creditsEstimated ?? 0),
  };
}

export interface CorroborationResult {
  search: CorroborationSearch;
  extraction: ExtractResult | null;
  /** This round as read from the accepted pages, folded into one record; null when no page describes it. */
  fragment: FeedRecord | null;
  /** Individual same-round readings, preserving each page's own field claims. */
  readings?: FeedRecord[];
  /** Same company, stage and stated day, but a different amount; not attached as the same round. */
  disputed?: FeedRecord[];
  /** Readings of pages on the company's own site refused only because the page names its round under another name (a product's). */
  ownSite?: FeedRecord[];
  /** Pages that stated rounds, none of them this one: another company with the name, or the same name and different facts. */
  rejected: number;
  creditsEstimated: number;
}

/**
 * How far back a corroborating page may be dated: a month before the announcement, a year when the
 * record's day may be late, or two months when the record is undated.
 */
function corroborationWindowStart(input: CorroborationInput, now: Date, broad = false): Date {
  const announced = input.announced_date ? new Date(`${input.announced_date}T12:00:00Z`) : null;
  const back = broad || mayBeLate(input) ? REACH_BACK_DAYS : RECENCY_DAYS;
  if (announced && !Number.isNaN(announced.getTime())) return new Date(announced.getTime() - back * MS_PER_DAY);
  return new Date(now.getTime() - (broad ? REACH_BACK_DAYS : 2 * RECENCY_DAYS) * MS_PER_DAY);
}

/** The record as the acceptance rule sees it: the facts a candidate round has to agree with. */
export type CorroborationSubject = Pick<
  CorroborationInput,
  | "company_name"
  | "company_domain"
  | "company_description"
  | "company_headquarters"
  | "lead_investors"
  | "stage"
  | "stage_as_written"
  | "amount_as_written"
  | "announced_date"
  | "date_basis"
  | "date_precision"
>;

export type CorroborationVerdict = { accept: true } | { accept: false; reason: "company" | "round" | "amount" };

/** Two stated USD amounts may differ by this share of the larger before they are two different rounds. */
const AMOUNT_TOLERANCE = 0.25;

/** Whether a page title names the company: every word of the record's normalized name appears in the title, since a headline writes the name out. */
export function titleNamesCompany(title: string | null | undefined, companyName: string): boolean {
  return namesCompany(title, companyName, { share: 1 });
}

/**
 * Whether a candidate round, read from a corroborating page, is the record's round. Same
 * company first: the extracted company's key equals the record's, or its domain does, or the
 * page title names the record's company (a wire headline about "Acme Robotics" corroborates
 * "Acme"). Then compatible facts: the stage agrees, or the two readings fall inside the week
 * `sameRoundWindow` allows across stages, and inside 45 days when both are dated (or, for a record
 * whose day may be late, the same round's earlier announcement, see earlierAnnouncement); and two
 * stated USD amounts agree within 25 percent. A missing date or amount on either side is not a
 * disagreement. Pure: the same rule the tests pin.
 */
export function acceptCorroboration(record: CorroborationSubject, candidate: FeedRecord, pageTitle?: string | null): CorroborationVerdict {
  if (record.company_domain && candidate.company_domain && record.company_domain !== candidate.company_domain)
    return { accept: false, reason: "company" };
  const sameHq = Boolean(
    record.company_headquarters &&
      candidate.headquarters &&
      normalizeCompanyKey(record.company_headquarters) === normalizeCompanyKey(candidate.headquarters),
  );
  const words = (description: string) =>
    new Set(
      normalizeCompanyKey(description)
        .split(" ")
        .filter((word) => word.length > 4),
    );
  const candidateWords = words(candidate.company_description ?? "");
  const sameDescription = Boolean(
    record.company_description &&
      candidate.company_description &&
      [...words(record.company_description)].filter((word) => candidateWords.has(word)).length >= 2,
  );
  const linkedSite = Boolean(
    record.company_domain && candidate.sources.some((source) => registrableDomain(source.url) === record.company_domain),
  );
  const key = normalizeCompanyKey(record.company_name);
  const sameKey = key.length > 0 && candidate.company_key === key;
  const storedAmount = parseAmount(record.amount_as_written);
  const namedRound =
    sameKey &&
    candidate.sources.some((source) => titleNamesCompany(source.title, record.company_name)) &&
    candidate.evidence_quotes.some((quote) => namesCompany(quote, record.company_name)) &&
    storedAmount.value !== null &&
    candidate.amount.value !== null &&
    storedAmount.currency === candidate.amount.currency &&
    Math.abs(storedAmount.value - candidate.amount.value) / Math.max(storedAmount.value, candidate.amount.value) <= 0.25;
  if (
    (!record.company_domain || record.company_domain !== candidate.company_domain) &&
    !linkedSite &&
    !sameHq &&
    !sameDescription &&
    !namedRound
  )
    return { accept: false, reason: "company" };
  const sameDomain = Boolean(record.company_domain) && candidate.company_domain === record.company_domain;
  if (!sameKey && !sameDomain && !titleNamesCompany(pageTitle, record.company_name)) return { accept: false, reason: "company" };

  const stage = record.stage ?? classifyStage(record.stage_as_written).stage;
  const namedSeries = (label: string) => /\bseries\s+([a-z])(?=[^a-z]|$)/i.exec(label)?.[1]?.toLowerCase() ?? null;
  const existingSeries = namedSeries(record.stage_as_written);
  const candidateSeries = namedSeries(candidate.stage_as_written);
  if (existingSeries && candidateSeries && existingSeries !== candidateSeries) return { accept: false, reason: "round" };
  if (
    !sameRoundWindow({ stage, announced_date: record.announced_date }, { stage: candidate.stage, announced_date: candidate.announced_date })
  ) {
    return earlierAnnouncement(record, stage, candidate) ? { accept: true } : { accept: false, reason: "round" };
  }

  const mine = parseAmount(record.amount_as_written);
  const theirs = candidate.amount;
  if (mine.value !== null && theirs.value !== null && mine.currency === "USD" && theirs.currency === "USD") {
    if (Math.abs(mine.value - theirs.value) > AMOUNT_TOLERANCE * Math.max(mine.value, theirs.value))
      return { accept: false, reason: "amount" };
  }
  return { accept: true };
}

/**
 * Whether a reading outside the same-round window is this round's own earlier announcement: the
 * record's day may be late, the reading is a day before it on the same stage (or on a named equity
 * stage when the record's is stageless: a late page often drops the label), and both state the
 * amount in one currency within a tenth (a company does not raise the same seed twice). Fearn's
 * June 10 release against a Sep 23 newsletter's reading of the same $5.5M seed; Assort Health's
 * June 24 Series C release against a Sep 25 profile's unlabelled "$120M funding". The read-back that
 * follows a row gaining sources then dates and stages the row from the release.
 */
function earlierAnnouncement(record: CorroborationSubject, stage: Stage, candidate: FeedRecord): boolean {
  const namesStage = candidate.stage === stage || (isStageless(stage) && BAND_OF_STAGE[candidate.stage] !== undefined);
  if (!namesStage || candidate.date_precision !== "day") return false;
  if (!record.announced_date || !candidate.announced_date || candidate.announced_date >= record.announced_date) return false;
  if (
    record.lead_investors?.length &&
    candidate.lead_investors.length &&
    !record.lead_investors.some((lead) =>
      candidate.lead_investors.some((other) => normalizeInvestorKey(lead) === normalizeInvestorKey(other)),
    )
  )
    return false;
  const mine = parseAmount(record.amount_as_written);
  const theirs = candidate.amount;
  if (mine.value === null || theirs.value === null || !mine.currency || mine.currency !== theirs.currency) return false;
  return Math.abs(mine.value - theirs.value) <= EARLIER_AMOUNT_TOLERANCE * Math.max(mine.value, theirs.value);
}

/** Only tokens this long say anything on their own; "AI" or "Co" in a headline is not the company. */
const MENTION_TOKEN_MIN = 4;

/**
 * Whether a stored source can be about the company, from what its row holds: the host is the
 * company's own domain, or the title carries one of the name's tokens of four or more letters,
 * or the URL path does (search results title a page with the wrong story often enough that the
 * slug gets a say, but only to keep a link, never to drop one). Null when the stored data cannot
 * say (no title, or a name with no token that long), so a cleanup keeps the link rather than
 * guessing.
 */
export function sourceMentionsCompany(
  source: { title: string | null; host: string; url?: string | null },
  company: { name: string; domain: string | null },
): boolean | null {
  if (company.domain && registrableDomain(source.host) === company.domain) return true;
  const tokens = normalizeCompanyKey(company.name)
    .split(" ")
    .filter((t) => t.length >= MENTION_TOKEN_MIN);
  if (tokens.length === 0 || !source.title?.trim()) return null;
  let path = "";
  try {
    if (source.url) path = decodeURIComponent(new URL(source.url).pathname);
  } catch {
    path = "";
  }
  const haystack = ` ${normalizeCompanyKey(`${source.title} ${path}`)} `;
  return tokens.some((t) => haystack.includes(` ${t} `));
}

/** Investor names deduped on their identity key; the longer spelling of a firm is the one kept. */
function mergeInvestors(a: string[], b: string[]): string[] {
  return dedupeInvestorNames([...a, ...b]);
}

/**
 * The accepted readings as one fragment: the first (the record's own stage, then the surest)
 * is the base, the rest add sources, quotes, investors, and any value the base lacks.
 */
function foldFragments(records: FeedRecord[], stage: Stage): FeedRecord {
  const ordered = [...records].sort((a, b) => Number(b.stage === stage) - Number(a.stage === stage) || b.confidence - a.confidence);
  const [first, ...rest] = ordered;
  const into: FeedRecord = { ...first, sources: [...first.sources], evidence_quotes: [...first.evidence_quotes] };
  for (const from of rest) {
    into.company_website = into.company_website ?? from.company_website;
    into.company_domain = into.company_domain ?? from.company_domain;
    into.company_description = into.company_description ?? from.company_description;
    // A second reading whose sentence is about another company on the same page never reaches here: the
    // resolver drops it where it knows the page's other names.
    if (into.amount.value === null && from.amount.value !== null) into.amount = from.amount;
    into.lead_investors = mergeInvestors(into.lead_investors, from.lead_investors);
    into.other_investors = mergeInvestors(into.other_investors, from.other_investors);
    into.headquarters = into.headquarters ?? from.headquarters;
    into.sector = into.sector ?? from.sector;
    if (surerDate(into, from)) {
      into.announced_date = from.announced_date;
      into.date_precision = from.date_precision;
      into.undated = false;
    }
    for (const q of from.evidence_quotes) if (!into.evidence_quotes.includes(q)) into.evidence_quotes.push(q);
    for (const s of from.sources) if (!into.sources.some((x) => x.url === s.url)) into.sources.push(s);
  }
  // A wire release the second reading brought in dates a rough record to the day.
  const settled = settleDate(into, { onlyRough: into.date_basis === undefined });
  return { ...settled, ...reconcileInvestorLists(settled.lead_investors, settled.other_investors) };
}

/**
 * The whole play: search, extract the chosen pages, and judge each page on its own. A page's
 * rounds are resolved by themselves (so an impostor's investors never ride in on a good page's
 * record), every stage is kept so the cross-stage week rule can speak, and acceptCorroboration
 * decides. The accepted readings fold into one fragment; the pages that stated rounds and none
 * of them this one are counted as rejected.
 */
export async function corroborate(
  client: NativeWebClient,
  input: CorroborationInput,
  opts: CorroborationOptions = {},
): Promise<CorroborationResult> {
  const now = opts.now ?? new Date();
  // The company's own page first, when the site can be mapped; then the search's best pages.
  const [newsroom, searched] = await Promise.all([
    mapNewsroom(client, input, Boolean(opts.broad)),
    searchCorroboration(client, input, opts),
  ]);
  const own = new Set(newsroom.candidates.map((c) => canonicalUrl(c.url)));
  const search: CorroborationSearch = {
    ...searched,
    candidates: [...newsroom.candidates, ...searched.candidates.filter((c) => !own.has(canonicalUrl(c.url)))].slice(
      0,
      opts.maxPages ?? (opts.broad ? 6 : 3),
    ),
    creditsEstimated: searched.creditsEstimated + newsroom.creditsEstimated,
    newsroom: newsroom.candidates.length,
  };
  if (search.candidates.length === 0)
    return { search, extraction: null, fragment: null, rejected: 0, creditsEstimated: search.creditsEstimated };
  const read = await readCandidates(client, input, search.candidates, { ...opts, now });
  return { search, ...read, creditsEstimated: search.creditsEstimated + read.creditsEstimated };
}

/**
 * Extract these pages and judge each on its own, as corroborate does after its search: the readings
 * that describe this round (acceptCorroboration, and a page that is a source for the company), the
 * same-day same-stage readings that disagree only on the amount, and how many pages described a round
 * that is not this one. The credits are the extraction's alone.
 */
export async function readCandidates(
  client: NativeWebClient,
  input: CorroborationInput,
  candidates: CorroborationCandidate[],
  opts: CorroborationOptions = {},
): Promise<Omit<CorroborationResult, "search">> {
  const now = opts.now ?? new Date();
  const stage = input.stage ?? classifyStage(input.stage_as_written).stage;
  const extraction = await extractRounds(client, candidates, { concurrency: 10 });
  const byPage = new Map<string, ExtractedItem[]>();
  for (const item of extraction.items) byPage.set(item.source.url, [...(byPage.get(item.source.url) ?? []), item]);

  const subject: CorroborationSubject = { ...input, stage };
  const parsedAmount = parseAmount(input.amount_as_written);
  const subjectAmount = { amountValue: parsedAmount.value, amountCurrency: parsedAmount.currency };
  const accepted: FeedRecord[] = [];
  const disputed: FeedRecord[] = [];
  const ownSite: FeedRecord[] = [];
  let rejected = 0;
  for (const items of byPage.values()) {
    const resolved = resolveRounds(items, {
      stages: [...STAGES],
      windowStart: corroborationWindowStart(input, now, Boolean(opts.broad)),
      now,
      publisherTiers: opts.tiers,
    });
    const title = items[0]?.source.title ?? null;
    // The page must also be a source for the record's company as the record knows it (its domain
    // included): a job posting or an aggregator's other story names the company and is still refused.
    const ours = resolved.kept.filter((r) => {
      if (!r.sources.every((s) => sourceFit(s, { name: input.company_name, domain: input.company_domain }, subjectAmount).attach))
        return false;
      const verdict = acceptCorroboration(subject, r, title);
      if (
        !verdict.accept &&
        verdict.reason === "amount" &&
        r.stage === stage &&
        r.announced_date === input.announced_date &&
        (r.company_key === normalizeCompanyKey(input.company_name) || r.company_domain === input.company_domain)
      )
        disputed.push(r);
      // A post on the company's own site may be read under its product's name ("Introducing Alexandria
      // and NativeWebClient's $75M Series B" read as Alexandria's round): kept aside, for a caller that checks the facts itself.
      if (
        !verdict.accept &&
        verdict.reason === "company" &&
        input.company_domain &&
        r.sources.every((s) => registrableDomain(s.url) === input.company_domain)
      )
        ownSite.push(r);
      return verdict.accept;
    });
    if (ours.length === 0) rejected++;
    accepted.push(...ours);
  }
  const fragment = accepted.length > 0 ? foldFragments(accepted, stage) : null;
  const pages = extraction.pages.filter((p) => p.ok).map((p) => p.url);
  return { extraction, fragment, readings: accepted, disputed, ownSite, rejected, creditsEstimated: extractionCredits(pages) };
}
