// History rounds, the pure part. A checked dossier lists a company's earlier rounds as text; one
// becomes a row only when its own announcement is found and read through the normal pipeline
// (extract, resolve, read-back, persist). This module holds the rules that pipeline does not
// already have: the key a prior round is tracked under, the search for its announcement, which
// results to read first, the window a page is resolved in, and whether a round the page reports
// is the prior round the dossier named. lib/history.ts runs them against the store and Firecrawl.

import { businessWords, hostCovered, searchName, sharesBusinessWords } from "../firecrawl/enrich.ts";
import type { PageVerdict } from "../llm/jev.ts";
import {
  canonicalUrl,
  classifyStage,
  hostOf,
  isArticleUrl,
  namesCompany,
  normalizeCompanyKey,
  normalizeInvestorKey,
  parseAmount,
  parseStatedDate,
  registrableDomain,
  SOCIAL_AND_DIRECTORY_HOSTS,
} from "./normalize.ts";
import { DEFAULT_TIERS, slugMayName } from "./resolve.ts";
import type { FeedRecord, Stage } from "./schema.ts";
import { STAGES } from "./schema.ts";
import { companySite, isFundingAggregatorUrl } from "./source-fit.ts";

/** A dossier prior round, as the check kept it; a lead has the same shape. */
export interface PriorRound {
  stage_as_written: string;
  amount_as_written: string | null;
  announced_date: string | null;
  lead_investors: string[];
  /** The page a lead named for the round: offered to the reading first, never trusted on its own. */
  source_url?: string | null;
}

/** The company a prior round belongs to, as the match reads it. */
export interface HistoryCompany {
  name: string;
  nameKey: string;
  domain: string | null;
  /** Other name keys the company row has been seen under. */
  aliasKeys?: string[];
  /** Other sites the company publishes on, as its homepage links them (a blog on another domain). */
  sites?: string[];
  /** What the record says the company does, for the tie below. */
  description?: string | null;
  /** The press sentence that best describes the company, from its own feed rounds. */
  evidence?: string | null;
  /** Hosts the company's homepage check refused as a namesake's (its profile's refused_hosts). */
  refusedHosts?: string[];
  sector?: string | null;
  headquarters?: string | null;
}

/** The city a headquarters names first, lowercased: "New York, NY" and "New York City" are one place. */
function sameCity(a: string | null | undefined, b: string | null | undefined): boolean {
  const city = (x: string | null | undefined) => (x ?? "").split(",")[0].trim().toLowerCase();
  const [x, y] = [city(a), city(b)];
  return x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x));
}

const DAY = 86_400_000;

/**
 * The key a prior round is tracked under: its label, amount, and date as the dossier writes them,
 * lowercased and trimmed. Readable on purpose (a ledger row says which round it is), and stable, so
 * a dossier saved again with the same rounds queues nothing new; a round the check rewrites (an
 * amount it could not source dropped) is a new key and is looked for again.
 */
export function priorKey(p: PriorRound): string {
  const clean = (s: string | null) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return [clean(p.stage_as_written), clean(p.amount_as_written), clean(p.announced_date)].join("|");
}

/** Stages a history round may carry: the dossier check keeps equity rounds only, so debt, grants, and secondaries never promote. */
export const HISTORY_STAGES: Stage[] = STAGES.filter((s) => s !== "debt" && s !== "grant" && s !== "secondary");

/** A label naming two rounds at once ("Seed and Series A", "Pre-A and Pre-A+", "successive rounds"): no one page announces it. */
function combinedLabel(label: string): boolean {
  return /\b(?:and|&|plus)\b|及|\/|\brounds\b|\bsuccessive\b|\bmultiple\b/i.test(label);
}

/** The stage a prior round's label names, or null when the label is generic ("funding round") or names several rounds. */
export function priorStage(p: Pick<PriorRound, "stage_as_written">): { stage: Stage; isExtension: boolean } | null {
  if (combinedLabel(p.stage_as_written)) return null;
  const c = classifyStage(p.stage_as_written);
  return c.stage === "other" || c.stage === "undisclosed" ? null : c;
}

/** The span a prior round's date allows: a day, a month (YYYY-MM), a year (YYYY), or nothing. */
export function priorDateRange(date: string | null): { from: Date; to: Date; precision: "day" | "month" | "year" } | null {
  if (!date) return null;
  const d = date.trim();
  if (/^\d{4}$/.test(d)) {
    const y = Number(d);
    return { from: new Date(Date.UTC(y, 0, 1)), to: new Date(Date.UTC(y, 11, 31)), precision: "year" };
  }
  const month = /^(\d{4})-(\d{2})$/.exec(d);
  if (month) {
    const y = Number(month[1]);
    const m = Number(month[2]) - 1;
    return { from: new Date(Date.UTC(y, m, 1)), to: new Date(Date.UTC(y, m + 1, 0)), precision: "month" };
  }
  const day = parseStatedDate(d);
  return day ? { from: day, to: day, precision: "day" } : null;
}

/** Whether a prior round says enough to recognise its announcement: a specific stage, an amount, or a dated day. */
export function promotable(p: PriorRound): boolean {
  return priorStage(p) !== null || parseAmount(p.amount_as_written).value !== null || priorDateRange(p.announced_date)?.precision === "day";
}

/** "$36M in additional funding (Series A totals $50M)" searches as "$36M": the first figure with its currency and unit. */
function amountTerm(asWritten: string | null): string | null {
  if (!asWritten) return null;
  const s = asWritten.replace(/\(.*?\)/g, " ").trim();
  if (s.length <= 18) return s;
  const m = /(?:[A-Z]{2,3}\$?|[$€£¥₹])?\s?\d[\d.,]*\s?(?:million|billion|crore|lakh|mn|bn|[mbk])?\b/i.exec(s);
  return m ? m[0].trim() : null;
}

/** "Energy Impact Partners (EIP)" searches as "Energy Impact": the firm's own words without the vehicle tail publishers vary. */
function leadTerm(name: string): string {
  const head = name.split(/\s*[(:]\s*/)[0] ?? name;
  const keyTokens = new Set(normalizeInvestorKey(head).split(" ").filter(Boolean));
  const words = head.split(/\s+/).filter((w) => keyTokens.has(normalizeCompanyKey(w)));
  return (words.length > 0 ? words.join(" ") : head).trim();
}

/** A search engine reads about this many terms; past it the tail is ignored or over-constrains. */
const MAX_QUERY_TERMS = 12;

/**
 * The search for a prior round's announcement: the name quoted, the label, the amount, the year,
 * the first lead quoted, then "funding". The name never goes; the tail goes first when the budget
 * is short. `"Branch Energy" Seed $4.5 million 2021 "Comcast" funding`.
 */
export function historyQuery(company: Pick<HistoryCompany, "name"> & Partial<Pick<HistoryCompany, "domain">>, p: PriorRound): string {
  const name = `"${searchName(company.name, company.domain)}"`;
  const parts: string[] = [];
  const label = p.stage_as_written.replace(/\s+/g, " ").trim();
  if (label && !combinedLabel(label)) parts.push(label);
  const amount = amountTerm(p.amount_as_written);
  if (amount) parts.push(amount);
  const year = /^(\d{4})/.exec(p.announced_date ?? "")?.[1];
  if (year) parts.push(year);
  const lead = p.lead_investors.find((n) => n.trim().length > 0);
  if (lead) parts.push(`"${leadTerm(lead)}"`);
  if (!/\b(?:round|funding|financing|investment|raise)/i.test(label)) parts.push("funding");
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

/** The search on the company's own site (a `map` with a search term) for its post about the round. */
export function newsroomSearch(company: Pick<HistoryCompany, "name"> & Partial<Pick<HistoryCompany, "domain">>, p: PriorRound): string {
  return [searchName(company.name, company.domain), p.stage_as_written, "funding raises announces"].filter(Boolean).join(" ");
}

/** A page the search, the company's site, or the dossier offered. */
export interface HistoryCandidate {
  url: string;
  title?: string;
  description?: string;
  published?: string;
  /** Where it came from: the company's own site, the search, a page the dossier check cited, or the page a lead named. */
  via: "site" | "search" | "dossier" | "lead";
  /** The classifier's reading of its title and snippet, when one ran (llm/jev.ts). */
  verdict?: PageVerdict;
}

/** Below this, the classifier is sure a page is not about the company's raise (it mentions one in passing): it is not read, unless it is the company's own. */
export const MENTION_ONLY = 0.2;
/** The classifier's page kinds as a candidate's rank: the company's own announcement first, a database last. */
const KIND_RANK: Record<PageVerdict["kind"], number> = { primary: 1, news: 0.5, other: -1, aggregator: -3 };

/** Whether a page may verify or date a round: never a funding database, by host, path, or the classifier's reading, nor a page it reads as neither an announcement nor an article. */
export function notAPrimarySource(c: Pick<HistoryCandidate, "url" | "verdict">): "aggregator" | "other" | null {
  if (isFundingAggregatorUrl(c.url) || c.verdict?.kind === "aggregator") return "aggregator";
  return c.verdict?.kind === "other" ? "other" : null;
}

/** A stage label a title or slug names: "seed", "pre-seed", "series b". */
const STAGE_IN_TEXT = /\b(pre[- ]?seed|seed|pre[- ]?series [a-k]|series [a-k])\b/g;
/** Words a page about a raise carries in its title, description, or slug. */
const FUNDING_WORDS = /\b(rais|fund|round|seed|series|invest|financ|backed|led by|secur|closes)/;
/** Words of a company's news section: its own pages without them are the product (examples, manuals, shared files). */
const NEWS_WORDS = /\b(blog|news|press|announc|updates?|posts?|stories)\b/;

/**
 * Which pages to read, best first, at most `max`: an article URL (never a directory, a social
 * profile, or a section index), one per canonical URL, that names the company in its title or
 * slug, or sits on its own domain, or was cited by the dossier check. Wires and releases (tier 1.0)
 * and the press rank by tier; the company's own post ranks with the wires, but only when its title,
 * description, or slug is about a raise (a product page on the same domain is not). A page that
 * names the dossier's stage or amount ranks higher, one the dossier cited higher still, and one that
 * names only another stage ("Series B" when the dossier's round is the seed) lower. The company's own
 * site includes a sibling that names it (tldraw.dev and tldraw.substack.com for tldraw.com). An own
 * page with neither funding nor news words (an app page, a manual) is dropped when anything better is
 * offered, and a funding database or profile farm is read last: it never verifies a round. With the
 * classifier's verdicts, a page it is sure only mentions a raise in passing is not read, and its page
 * kind ranks the rest: primary, then news, then other, then aggregator.
 */
export function rankHistoryCandidates(
  candidates: HistoryCandidate[],
  opts: { company: Pick<HistoryCompany, "name" | "domain" | "sites">; prior: PriorRound; tiers?: Record<string, number>; max?: number },
): HistoryCandidate[] {
  const tiers = { ...DEFAULT_TIERS, ...opts.tiers };
  const seen = new Map<string, { candidate: HistoryCandidate; score: number; position: number; junk: boolean }>();
  const stageWord = opts.prior.stage_as_written
    .toLowerCase()
    .replace(/[-_]/g, " ")
    .replace(/\b(round|funding|financing|investment)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const amountDigits = (amountTerm(opts.prior.amount_as_written) ?? "").replace(/[^\d.]/g, "").replace(/\.$/, "");
  const amountHit = amountDigits ? new RegExp(`(^|[^\\d.])${amountDigits.replace(".", "\\.")}($|[^\\d])`) : null;
  candidates.forEach((candidate, position) => {
    if (!isArticleUrl(candidate.url)) return;
    const domain = registrableDomain(candidate.url);
    if (!domain) return;
    const key = canonicalUrl(candidate.url);
    let path = "";
    try {
      path = new URL(candidate.url).pathname;
    } catch {
      return;
    }
    const named = namesCompany(candidate.title, opts.company.name, { share: 1 }) || slugMayName(path, opts.company.name);
    const site = companySite(candidate.url, opts.company);
    const own = site === "own" || (site === "sibling" && named);
    if (SOCIAL_AND_DIRECTORY_HOSTS.has(domain) && !own) return;
    const cited = candidate.via === "dossier" || candidate.via === "lead";
    if (!own && !named && !cited) return;
    const host = hostOf(candidate.url);
    let slug = path;
    try {
      slug = decodeURIComponent(path);
    } catch {
      // A malformed escape reads as written.
    }
    const text = `${candidate.title ?? ""} ${candidate.description ?? ""} ${slug.replace(/[-_/]+/g, " ")}`.toLowerCase().replace(/,/g, "");
    const stageHit = Boolean(stageWord) && text.includes(stageWord);
    const otherStage = [...text.matchAll(STAGE_IN_TEXT)].some((m) => m[1].replace(/-/g, " ") !== stageWord);
    const tier = tiers[host] ?? tiers[domain] ?? 0.3;
    const funding = FUNDING_WORDS.test(text);
    const base = own ? (funding ? 2 : NEWS_WORDS.test(text) ? 0.5 : 0) : tier + (tier >= 1 ? 1 : 0);
    // A company's own page is kept whatever its headline: Resend's handbook states its seed under "How we got here".
    if (candidate.verdict && !cited && candidate.verdict.aboutRaise < MENTION_ONLY && candidate.verdict.kind !== "primary") return;
    const kind = notAPrimarySource(candidate) === "aggregator" ? -3 : candidate.verdict ? KIND_RANK[candidate.verdict.kind] : 0;
    const score =
      base + (cited ? 0.75 : 0) + (stageHit ? 1 : 0) + (amountHit?.test(text) ? 1 : 0) - (otherStage && !stageHit ? 1 : 0) + kind;
    const junk = own && !cited && !funding && !NEWS_WORDS.test(text);
    const prev = seen.get(key);
    // The same page from two places keeps its best reading and its earliest position.
    if (!prev || score > prev.score)
      seen.set(key, { candidate, score, position: prev?.position ?? position, junk: junk && (prev?.junk ?? true) });
  });
  const ranked = [...seen.values()];
  const useful = ranked.filter((r) => !r.junk);
  return (useful.length > 0 ? useful : ranked)
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .slice(0, opts.max ?? 5)
    .map((r) => r.candidate);
}

/**
 * The window a candidate page is resolved in: the prior round's span with a year and a month on
 * each side (the dossier's date can be a close, a filing, or a profile's month), open at the start
 * for an undated round, never past now. The resolver's own dating rules run unchanged inside it; the
 * match below is what holds the round to the dossier's date.
 */
export function historyWindow(p: Pick<PriorRound, "announced_date">, now: Date): { windowStart: Date; windowEnd?: Date } {
  const range = priorDateRange(p.announced_date);
  if (!range) return { windowStart: new Date(Date.UTC(2000, 0, 1)) };
  const windowStart = new Date(range.from.getTime() - 400 * DAY);
  const end = new Date(range.to.getTime() + 400 * DAY);
  return end.getTime() < now.getTime() ? { windowStart, windowEnd: end } : { windowStart };
}

/** How far a page's day may sit from the dossier's, by the dossier's precision. */
const DATE_SLACK_DAYS = { day: 120, month: 60, year: 60 } as const;
/** A dated day this close to the dossier's day is evidence on its own. */
const DAY_MATCH_DAYS = 14;
/** Two amounts in one currency agree inside fifteen percent, and disagree past a quarter. */
const AMOUNT_AGREE = 0.15;
const AMOUNT_DISAGREE = 0.25;

export type PriorMatch =
  | { ok: true; score: number; evidence: string[] }
  | { ok: false; reason: "company" | "namesake" | "untied" | "stage" | "amount" | "date" | "undated" | "weak" };

/**
 * Whether the record's company is the dossier's company: a key, an alias key, the domain, or every
 * word of one name inside the other. A domain the page gives that is not the company's refuses it,
 * unless it is a site the company publishes on (tldraw.dev for tldraw.com); a sibling that shares
 * only the label must still carry the company's name.
 */
export function sameHistoryCompany(
  company: HistoryCompany,
  record: Pick<FeedRecord, "company_key" | "company_domain" | "company_name">,
): boolean {
  const site =
    company.domain && record.company_domain ? companySite(`https://${record.company_domain.replace(/^https?:\/\//, "")}`, company) : null;
  if (company.domain && record.company_domain && !site) return false;
  const keys = new Set([company.nameKey, ...(company.aliasKeys ?? [])].filter(Boolean));
  if (keys.has(record.company_key)) return true;
  if (site === "own") return true;
  return namesCompany(record.company_name, company.name, { share: 1 }) || namesCompany(company.name, record.company_name, { share: 1 });
}

/**
 * Whether the page's round is tied to this company and not only to its name. A name search finds a
 * namesake's rounds as readily as the company's own: Primer (primer.io, payment orchestration) took
 * Primer Technologies' $69M Series D (primer.ai, AI data analysis for defense), and Hadrian
 * (hadrian.io, offensive security) took four of Hadrian Automation's manufacturing rounds, $1.37B
 * among them, from hadrian.co, a host its own homepage check had already refused. A round is tied
 * when its page is on the company's own site, when the page gives the company's own domain, or when
 * the page's words about the company (its description, the round's sentences, the headline) share the
 * record's line of business, or the page places it in the record's sector or city. It is never tied when the page, the company it names, or the page a
 * lead pointed to sits on a host the company's homepage check refused. A record with no description
 * has no line of business to hold a page to, and its name alone ties it, as before.
 */
export function historySourceTie(
  prior: Pick<PriorRound, "source_url">,
  record: Pick<
    FeedRecord,
    "company_domain" | "company_website" | "company_description" | "evidence_quotes" | "sources" | "sector" | "headquarters"
  >,
  company: HistoryCompany,
): { ok: true; tie: "own_site" | "domain" | "business" | "unchecked" } | { ok: false; reason: "namesake" | "untied" } {
  const refused = (company.refusedHosts ?? []).filter((h) => !company.domain || !hostCovered(company.domain, [h]));
  const subjects = [record.company_domain, record.company_website, prior.source_url, ...record.sources.map((s) => s.url)];
  if (subjects.some((u) => hostCovered(u, refused))) return { ok: false, reason: "namesake" };
  if (record.sources.some((s) => companySite(s.url, company) === "own")) return { ok: true, tie: "own_site" };
  const named = registrableDomain(record.company_domain ?? record.company_website);
  if (company.domain && named && (named === company.domain || (company.sites ?? []).includes(named))) return { ok: true, tie: "domain" };
  const description = company.description?.trim() || null;
  if (!description) return { ok: true, tie: "unchecked" };
  const text = [record.company_description, ...record.evidence_quotes, ...record.sources.map((s) => s.title)].filter(Boolean).join(" ");
  if (company.domain && text.toLowerCase().includes(company.domain)) return { ok: true, tie: "domain" };
  const context = { company_name: company.name, headquarters: null, sector: null, headline: null };
  // The press sentence that describes the company is a second statement of its business; a round
  // sentence ("raised $5M led by Y") names only investors, so it can tie a page but never refuse one.
  const evidence = company.evidence?.trim() || null;
  // Only a sentence that names a business can vouch: "Primer raised $50 million in a Series B" names none.
  const quoted = { ...context, company_description: null, evidence };
  const shares =
    sharesBusinessWords(text, { ...context, company_description: description, evidence: null }) ||
    (evidence !== null && businessWords(quoted).length > 0 && sharesBusinessWords(text, quoted)) ||
    // The page's own reading of the company in the record's sector, or in its city, is the same
    // business told in other words (Slingshot's "mental health chatbot" for "a foundation model for psychology").
    (Boolean(record.sector) && record.sector !== "other" && record.sector === company.sector) ||
    sameCity(record.headquarters, company.headquarters);
  return shares ? { ok: true, tie: "business" } : { ok: false, reason: "untied" };
}

/** Whether a lead the dossier names is among the investors the page names for the round. */
function leadAgrees(prior: PriorRound, record: Pick<FeedRecord, "lead_investors" | "other_investors">): boolean {
  const named = [...record.lead_investors, ...record.other_investors];
  return prior.lead_investors.some((lead) => {
    const key = normalizeInvestorKey(lead);
    const term = leadTerm(lead);
    return named.some((n) => normalizeInvestorKey(n) === key || namesCompany(n, term, { share: 1 }));
  });
}

/**
 * How far a page's day may sit from a dossier month or year when the amount and the stage (or a
 * lead) both agree: such a date is often the close, a filing, or a profile's month, and the
 * announcement can come months later ("closed in July, announced in November"). The page's day is
 * the one kept. A dossier day keeps the ordinary slack.
 */
const DATE_SLACK_STRONG_DAYS = 400;

/**
 * Whether a round a page reports is the dossier's prior round. The company first, and the page tied to
 * it rather than to a namesake (historySourceTie); then a day (a page
 * that dates nothing cannot place the round, and its row would only wait in review while the ledger
 * called the round done, so the next page is read instead); then no
 * contradiction (two amounts in one currency more than a quarter apart, a day outside the dossier's
 * span with its slack, conflicting amounts under different equity labels, a debt or grant reading)
 * and at least one positive agreement: the same specific stage (and the same extension flag),
 * amounts inside fifteen percent, or a day within two weeks of a dossier day. A conflicting stage
 * needs a date within a month of the lead's span; an undated hint cannot relabel another round. A lead the
 * dossier names among the page's investors is further evidence, never the only one. When the amount
 * agrees and so does the stage or a lead, the day may sit up to DATE_SLACK_STRONG_DAYS from a
 * dossier month or year. A page whose only round is another round (the Series B article that recalls the seed,
 * which the resolver drops as background) never matches. Pure: the tests pin it.
 */
export function matchPriorRound(prior: PriorRound, record: FeedRecord, company: HistoryCompany): PriorMatch {
  if (!sameHistoryCompany(company, record)) return { ok: false, reason: "company" };
  const tie = historySourceTie(prior, record, company);
  if (!tie.ok) return tie;
  if (record.stage === "debt" || record.stage === "grant" || record.stage === "secondary") return { ok: false, reason: "stage" };
  if (!record.announced_date) return { ok: false, reason: "undated" };
  const evidence: string[] = [];
  let score = 0;

  const mine = parseAmount(prior.amount_as_written);
  const theirs = record.amount;
  let amountAgrees = false;
  let amountGap: number | null = null;
  if (mine.value !== null && theirs.value !== null && mine.currency && mine.currency === theirs.currency) {
    const gap = Math.abs(mine.value - theirs.value) / Math.max(mine.value, theirs.value);
    amountGap = gap;
    if (gap > AMOUNT_DISAGREE) return { ok: false, reason: "amount" };
    if (gap <= AMOUNT_AGREE) {
      amountAgrees = true;
      score += 2;
      evidence.push("amount");
    }
  }

  const stage = priorStage(prior);
  const recordStageKnown = record.stage !== "other" && record.stage !== "undisclosed";
  let stageAgrees = false;
  if (stage && recordStageKnown) {
    // A lead often writes an extension as its bare stage ("seed round" for tldraw's seed extension):
    // the same stage is no contradiction, though only the same extension flag is agreement.
    const extendsLead = stage.stage === record.stage && !stage.isExtension && record.is_extension;
    if (stage.stage === record.stage && stage.isExtension === record.is_extension) stageAgrees = true;
    else if (
      !extendsLead &&
      ((amountGap !== null && !amountAgrees) || (stage.stage === record.stage && stage.isExtension && !record.is_extension))
    )
      return { ok: false, reason: "stage" };
  }
  const lead = leadAgrees(prior, record);

  const range = priorDateRange(prior.announced_date);
  const day = record.announced_date ? parseStatedDate(record.announced_date) : null;
  const stageConflict = stage && recordStageKnown && stage.stage !== record.stage;
  if (stageConflict && !range) return { ok: false, reason: "weak" };
  if (range && day) {
    // A dossier day is usually the announcement itself; only a month or a year is widened.
    const strong = range.precision !== "day" && amountAgrees && (stageAgrees || lead);
    const slack = (stageConflict ? 31 : strong ? DATE_SLACK_STRONG_DAYS : DATE_SLACK_DAYS[range.precision]) * DAY;
    if (day.getTime() < range.from.getTime() - slack || day.getTime() > range.to.getTime() + slack) return { ok: false, reason: "date" };
    score += 0.5;
    if (range.precision === "day" && Math.abs(day.getTime() - range.from.getTime()) <= DAY_MATCH_DAYS * DAY) {
      score += 1;
      evidence.push("day");
    }
  }

  if (stageAgrees) {
    score += 2;
    evidence.push("stage");
  }
  if (evidence.length === 0) return { ok: false, reason: "weak" };
  if (lead) {
    score += 1;
    evidence.push("lead");
  }
  if (stage && recordStageKnown && stage.stage !== record.stage) evidence.push("stage label differs; announcement wins");
  return { ok: true, score, evidence };
}

// Leads. A funding event a search result or a listing states is not a fact: its dates run weeks off and
// it repeats rounds. One the store lacks becomes a prior round on the ledger and goes through the same
// search, reading, and read-back as a dossier's; only a page that states it writes a row.

/** A funding event as a lead offers it: the label, figure, date, and the page that states it. */
export interface FundingLead {
  type: string;
  amount: string | null;
  /** YYYY-MM or YYYY-MM-DD. */
  date: string | null;
  source_url: string | null;
}

/** A round the store (or the ledger) already has, as the lead check reads it. */
export interface KnownRound {
  stage: Stage | null;
  stage_as_written?: string;
  is_extension?: boolean;
  /** The amount in USD millions when known. */
  usd_millions: number | null;
  /** YYYY-MM-DD, YYYY-MM, YYYY, or null. */
  announced_on: string | null;
}

/** Two rounds this far apart are not one round, whatever their labels. */
const LEAD_SAME_ROUND_DAYS = 400;

/** The middle of a date's span, or null. */
function midpoint(date: string | null): number | null {
  const r = priorDateRange(date);
  return r ? (r.from.getTime() + r.to.getTime()) / 2 : null;
}

/** A lead's figure in USD millions when it is written in dollars; other currencies are not compared. */
function leadUsd(amount: string | null): number | null {
  const a = parseAmount(amount);
  return a.value !== null && a.currency === "USD" ? a.value : null;
}

/**
 * Whether a lead is a round already known: dated within LEAD_SAME_ROUND_DAYS (or either undated),
 * and either the same stage with no contradicting amounts (two figures more than a quarter apart are
 * two rounds: Ultrahuman's $48M and $70M Series C), or the same figure inside a tenth under another
 * label with dates no more than a month apart. Extensions need dates within two weeks, and two
 * explicitly different numbered extensions are separate rounds.
 */
export function knownRound(lead: KnownRound, known: KnownRound[]): boolean {
  const at = midpoint(lead.announced_on);
  return known.some((k) => {
    const kAt = midpoint(k.announced_on);
    if (at !== null && kAt !== null && Math.abs(at - kAt) > LEAD_SAME_ROUND_DAYS * DAY) return false;
    const both = lead.usd_millions !== null && k.usd_millions !== null;
    const gap = both
      ? Math.abs((lead.usd_millions as number) - (k.usd_millions as number)) /
        Math.max(lead.usd_millions as number, k.usd_millions as number)
      : null;
    const nearby = at !== null && kAt !== null && Math.abs(at - kAt) <= 31 * DAY;
    const leadSuffix = /\bseries\s+[a-k][- ]?(\d+)\b/i.exec(lead.stage_as_written ?? "")?.[1];
    const knownSuffix = /\bseries\s+[a-k][- ]?(\d+)\b/i.exec(k.stage_as_written ?? "")?.[1];
    const extension = lead.is_extension || k.is_extension || leadSuffix || knownSuffix;
    if (extension && at !== null && kAt !== null && Math.abs(at - kAt) > 14 * DAY) return false;
    if (lead.stage && k.stage === lead.stage && (gap === null || gap <= 0.25)) {
      if (leadSuffix && knownSuffix && leadSuffix !== knownSuffix) return false;
      if (leadSuffix !== knownSuffix && (leadSuffix || knownSuffix)) return nearby && gap !== null && gap <= 0.1;
      if (lead.is_extension !== k.is_extension && extension) return nearby && gap !== null && gap <= 0.1;
      return true;
    }
    return nearby && gap !== null && gap <= 0.1;
  });
}

/** A lead as a prior round, or null when its label names no specific equity stage ("Other", "Venture (Round not Specified)", debt, a grant). */
export function leadPrior(lead: FundingLead): PriorRound | null {
  const stage = priorStage({ stage_as_written: lead.type });
  if (
    (!stage || !HISTORY_STAGES.includes(stage.stage)) &&
    !(
      /^funding round$/i.test(lead.type.trim()) &&
      promotable({ stage_as_written: lead.type, amount_as_written: lead.amount, announced_date: lead.date, lead_investors: [] })
    )
  )
    return null;
  return {
    stage_as_written: lead.type.trim(),
    amount_as_written: lead.amount,
    announced_date: lead.date,
    lead_investors: [],
    source_url: lead.source_url,
  };
}

/** A prior round as a known round, for checking a lead against what the ledger already holds. */
export function priorAsKnown(p: PriorRound): KnownRound {
  const stage = priorStage(p);
  return {
    stage: stage?.stage ?? null,
    stage_as_written: p.stage_as_written,
    is_extension: stage?.isExtension,
    usd_millions: leadUsd(p.amount_as_written),
    announced_on: p.announced_date,
  };
}

/**
 * The leads worth a search: a specific equity stage the store and the ledger do not already know,
 * each round once. The provider's own repeats fold first, the one with a news link kept (Clay's
 * Series A appears in 2019 and again in 2022 with the same figure).
 */
export function missingLeads(leads: FundingLead[], known: KnownRound[]): PriorRound[] {
  const out: PriorRound[] = [];
  const priors = leads
    .map(leadPrior)
    .filter((p): p is PriorRound => p !== null)
    .sort((a, b) => Number(Boolean(b.source_url)) - Number(Boolean(a.source_url)));
  for (const p of priors) {
    const k = priorAsKnown(p);
    if (knownRound(k, known)) continue;
    const repeat = out.some((o) => {
      const ok = priorAsKnown(o);
      return (
        !ok.is_extension &&
        !k.is_extension &&
        !/\bseries\s+[a-k][- ]?\d+\b/i.test(`${o.stage_as_written} ${p.stage_as_written}`) &&
        ok.stage === k.stage &&
        ok.usd_millions !== null &&
        k.usd_millions !== null &&
        Math.abs(ok.usd_millions - k.usd_millions) / Math.max(ok.usd_millions, k.usd_millions) <= 0.1
      );
    });
    if (repeat || knownRound(k, out.map(priorAsKnown))) continue;
    out.push(p);
  }
  return out;
}
