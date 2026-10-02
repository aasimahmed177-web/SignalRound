// Investor websites: the domain an investor's logo is fetched by, the way a company's comes from
// its verified homepage. One cheap search per investor (five results, no scrape, no JSON) and a
// pure pick over what it returns. The pick is conservative on purpose: a wrong logo beside a firm
// is worse than its monogram. The host's own label must be the firm's name (or the name plus an
// investing word, or a short form the name itself gives), the result must not be a directory,
// press, or social page, and a label that carries no investing word must also read as an investor
// in its title or description ("insight.com" is a reseller; "insightpartners.com" is the firm).
// A person resolves only through an investing vehicle named in parentheses.
// https://docs.firecrawl.dev/features/search

import { z } from "zod";
import { isLikelyPerson, isPersonShaped, isPlaceholderInvestor } from "../records/investors.ts";
import { NON_ARTICLE_HOSTS, normalizeCompanyKey, registrableDomain, SOCIAL_AND_DIRECTORY_HOSTS } from "../records/normalize.ts";
import { RATE, searchCredits } from "./credits.ts";

/** Results one investor search asks for: ten bill the same minimum search charge as five, and the firm's site is often sixth. */
export const INVESTOR_SEARCH_RESULTS = 10;
/** Investors one pipeline pass may resolve from its own scope, so a run's cost stays bounded. */
export const INVESTOR_DOMAINS_PER_RUN = 60;
/** Investors a pass may resolve per round (or company) in its scope: a round rarely names more. */
export const INVESTOR_DOMAINS_PER_ROUND = 20;
/**
 * Investors a pass may resolve from the backlog beyond its scope: whoever the history lane, the
 * watch lane, or an earlier capped pass left unchecked, newest rounds first. Every sweep drains
 * some, so the backlog cannot grow the way it did when only a pass's own rounds were read.
 */
export const INVESTOR_BACKLOG_PER_RUN = 30;

/** The search cap for a pass over this many rounds or companies: proportional, never above the per-run cap. */
export function investorDomainCap(scopeSize: number): number {
  return Math.min(INVESTOR_DOMAINS_PER_RUN, Math.max(0, scopeSize) * INVESTOR_DOMAINS_PER_ROUND);
}

/** What `searches` investor searches cost on the rate card. */
export function investorDomainCredits(searches: number): number {
  return searches * searchCredits(INVESTOR_SEARCH_RESULTS);
}

/** What `reads` homepage identity reads cost: the page plus the JSON format (branding rides free). */
export function investorHomepageCredits(reads: number): number {
  return reads * (RATE.scrapePage + RATE.jsonFormatPerPage);
}

/** One search result as the resolver reads it: where it points and what it says about itself. */
export interface InvestorSearchHit {
  url: string;
  title?: string | null;
  description?: string | null;
}

/**
 * The firm to search for, and whether the name had a person's shape (which asks for stricter
 * evidence). `individual` is the stronger reading: a common given name or an honorific, so the
 * name is taken for a person unless a firm's own site proves otherwise, and nothing short of that
 * proof (a snippet, an unreadable page) gives it a domain.
 */
export interface InvestorTarget {
  firm: string;
  person: boolean;
  individual: boolean;
}

export interface InvestorDomainPick {
  /** The registrable domain, bare: "a16z.com". */
  domain: string;
  /** The result that vouched for it. */
  url: string;
  reason: string;
}

/**
 * Aggregators, databases, press, and social sites. A result on one of them is a page about the
 * investor, never its own site, whatever the label says ("Bloomberg Beta" is not bloomberg.com).
 * The shared lists cover the social networks and investor databases; the rest are press and wikis.
 */
const NOT_AN_INVESTOR_SITE = new Set([
  ...SOCIAL_AND_DIRECTORY_HOSTS,
  ...NON_ARTICLE_HOSTS,
  "wikipedia.org",
  "wikidata.org",
  "techcrunch.com",
  "bloomberg.com",
  "reuters.com",
  "forbes.com",
  "fortune.com",
  "businessinsider.com",
  "axios.com",
  "theinformation.com",
  "wsj.com",
  "ft.com",
  "sifted.eu",
  "eu-startups.com",
  "venturebeat.com",
  "prnewswire.com",
  "businesswire.com",
  "globenewswire.com",
  "vcnewsdaily.com",
  "fundz.net",
  "craft.co",
  "owler.com",
  "openvc.app",
  "vcsheet.com",
  "tiktok.com",
  "threads.net",
  "reddit.com",
  "quora.com",
]);
/**
 * Hosts inside a domain that is otherwise a real investor's or company's: NFX's investor database
 * lives on nfx.com, and a page on Google Sites or an app store is not Google's or Apple's own.
 */
const NOT_AN_INVESTOR_HOST = new Set([
  "signal.nfx.com",
  "sites.google.com",
  "docs.google.com",
  "play.google.com",
  "maps.google.com",
  "apps.apple.com",
]);

/** Words a firm's name wears around its brand. The brand is what a host label spells. */
const STOP_WORDS = new Set([
  "the",
  "and",
  "of",
  "ventures",
  "venture",
  "capital",
  "partners",
  "partner",
  "vc",
  "fund",
  "funds",
  "management",
  "investments",
  "investment",
  "invest",
  "group",
  "holdings",
  "holding",
  "equity",
  "alternatives",
  "lp",
  "llp",
  "llc",
]);

/** Stop words a host keeps when it spells the brand: "mandg.com" for M&G, "theraine.com" for The Raine Group. */
const CONNECTIVES = new Set(["the", "and", "of"]);

/** Suffixes a firm's host adds to its brand. The investing ones make the label itself a claim to be an investor. */
const INVESTING_SUFFIXES = [
  "vc",
  "vp",
  "cap",
  "capital",
  "ventures",
  "venture",
  "partners",
  "fund",
  "funds",
  "invest",
  "investments",
  "equity",
];
const NEUTRAL_SUFFIXES = ["hq", "group", "global", "co", "inc", "io"];
/**
 * The kind of firm a type word names. "vc" is venture capital and "vp" venture partners, so each
 * belongs to two. A domain whose suffix names a different kind than the name's own type word
 * ("HSR Ventures" on hsr-capital.com) is often a different firm that shares the brand.
 */
const TYPE_FAMILIES: Record<string, string[]> = {
  venture: ["venture"],
  ventures: ["venture"],
  vc: ["venture", "capital"],
  vp: ["venture", "partners"],
  capital: ["capital"],
  cap: ["capital"],
  partner: ["partners"],
  partners: ["partners"],
  fund: ["fund"],
  funds: ["fund"],
  invest: ["invest"],
  investment: ["invest"],
  investments: ["invest"],
  equity: ["equity"],
};
/**
 * The suffixes a one-word name may take on its domain: the ones a venture firm uses. "Archetype"
 * the crypto fund is archetype.fund; "archetypeinvestments.com" is how a wealth or property
 * manager names itself, and a dictionary word is shared by many of those.
 */
const ONE_WORD_SUFFIXES = new Set(["vc", "vp", "ventures", "venture", "capital", "cap", "partners", "fund", "funds"]);
const INVESTING_TAIL = new RegExp(`(?:${INVESTING_SUFFIXES.join("|")}|angels?)$`);

/**
 * Short forms publishers use where the host does too, keyed on the name's squashed tokens.
 * Only the trivial, unambiguous ones; a short form the name gives itself ("(QIA)") needs no entry.
 */
const SHORT_FORMS: Record<string, string[]> = {
  andreessenhorowitz: ["a16z"],
  newenterpriseassociates: ["nea"],
  lightspeed: ["lsvp"],
  lightspeedventurepartners: ["lsvp"],
  bessemerventurepartners: ["bvp"],
  institutionalventurepartners: ["ivp"],
  googleventures: ["gv"],
};

/**
 * Words that say the page is an investor's: what a firm's homepage or its search snippet writes.
 * Only words a non-investor rarely uses about itself. "investor" alone is not here ("Nvidia investor
 * relations" is a public company's page), and neither are "founders", "startups", "portfolio",
 * "backs": a community for founders or a design agency's portfolio writes them too.
 */
const INVESTING =
  /\b(?:venture|ventures|vc|venture capital|private equity|growth equity|investment (?:firm|manager|management|company|platform|partners?|fund)|asset management|family office|early[- ]stage|seed[- ]stage|growth[- ]stage|pre[- ]seed|seed fund|accelerator|incubator|invests? in|investing in)\b/i;

/** A title that says the domain is for sale or parked: the name is on it, the firm is not. */
const PARKED_TITLE = /\b(?:for sale|domain parking|parked|buy this domain|hugedomains|domain name)\b/i;

/** A role that makes the name a person described by their job, who invests as themselves. */
const PERSON_ROLE = /\b(?:co-?founders?|founders? of|ceo|cto|coo|cfo|chairman|chairwoman|president|former|formerly)\b|\bex-/i;

/** Letters inside a parenthetical that make it an investing vehicle ("JJCapinvest"), not an affiliation ("Freelance.com"). */
const VEHICLE = /cap|invest|ventur|fund|partners|holding|angel|\bvc\b|family office/i;
/** Words the person-shape rule does not know as firm words, which no person's name carries: "Blank VC", "Gandel Invest". */
const ORGANIZATION = /\b(?:vc|invest|angels?|accelerator|incubator|collective|capital\w*|ventures?)\b/i;
/**
 * A short form in parentheses is an organization's own ("German Aerospace Center (DLR)",
 * "Andreessen Horowitz (a16z)"), not a person's affiliation: two to six letters or digits. A
 * capitalized ordinary word is the exception, since that is how a person's company is written
 * ("Alexandre Prot (Qonto)"), and it stays an affiliation.
 */
function isShortForm(paren: string | null): paren is string {
  return !!paren && /^[A-Za-z0-9&]{2,6}$/.test(paren) && !/^[A-Z][a-z]+$/.test(paren);
}

/** The name before a spaced dash, colon, or parenthesis: the descriptor after it is not the name. */
function head(name: string): string {
  return (name.split(/\s+[–—-]\s+|\s*[:(]\s*/)[0] ?? name).trim();
}

function parenthetical(name: string): string | null {
  return /\(([^)]+)\)\s*$/.exec(name)?.[1]?.trim() || null;
}

/**
 * Who to search for, or null when no search can find a site worth showing: a placeholder, a
 * person named by their role, or a person whose parenthetical is an affiliation ("Sylvestre
 * Blavet (Freelance.com)", the company he founded, not a fund). A person whose parenthetical is an
 * investing vehicle ("Julien Jean (JJCapinvest)") is searched as that vehicle. A bare name with a
 * person's shape is still searched, since "Kleiner Perkins" and "General Catalyst" have it, and
 * the pick then asks for stricter evidence.
 */
export function investorSearchTarget(name: string): InvestorTarget | null {
  const trimmed = name.trim();
  if (!trimmed || isPlaceholderInvestor(trimmed) || PERSON_ROLE.test(trimmed)) return null;
  const base = head(trimmed);
  const paren = parenthetical(trimmed);
  if (isPersonShaped(base) && !ORGANIZATION.test(base) && !isShortForm(paren)) {
    if (paren) return VEHICLE.test(paren) && !isPersonShaped(paren) ? { firm: paren, person: false, individual: false } : null;
    return { firm: base, person: true, individual: isLikelyPerson(base) };
  }
  if (!base) return null;
  return { firm: base, person: false, individual: isLikelyPerson(base) && !ORGANIZATION.test(base) };
}

/** The search query for a target: the firm's name, steered toward its own site. */
export function investorQuery(target: InvestorTarget): string {
  return `${target.firm} investor official website`;
}

/**
 * The queries a resolution may spend, in order: the site-steered one, then the quoted name as an
 * investor, which surfaces the firm's own page when the first drowns in namesakes (BREEGA, Mercia).
 * The second runs only when the first offered no candidate that verified.
 */
export function investorQueries(target: InvestorTarget): string[] {
  return [investorQuery(target), `"${target.firm}" ${target.person ? "investor" : "venture capital"}`];
}

interface NameShape {
  /** The name's tokens as written, normalized: ["hsr", "ventures"]. */
  tokens: string[];
  /** Every token squashed: "luxcapital". */
  full: string;
  /** Tokens without the stop words, squashed: "lux". */
  core: string;
  /** Tokens without the type words but with their connectives, squashed: "mandg" for M&G Investments. */
  brand: string;
  coreTokens: string[];
  /** Short forms the host may spell instead. */
  shortForms: string[];
}

function shapeOf(firm: string, original: string): NameShape | null {
  // "Freelance.com" is a name with its domain in it; the dot must not split the brand.
  const tokens = normalizeCompanyKey(firm.replace(/\.(?:com|co|io|vc|net|org)$/i, ""))
    .split(" ")
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const coreTokens = tokens.filter((t) => !STOP_WORDS.has(t));
  const full = tokens.join("");
  const core = coreTokens.length > 0 ? coreTokens.join("") : full;
  const brand = tokens.filter((t) => !STOP_WORDS.has(t) || CONNECTIVES.has(t)).join("") || full;
  const shortForms = [...(SHORT_FORMS[full] ?? []), ...(SHORT_FORMS[core] ?? [])];
  // A short form the name gives itself, "Qatar Investment Authority (QIA)" or "Andreessen Horowitz (a16z)".
  const paren = parenthetical(original);
  if (paren !== firm && isShortForm(paren)) shortForms.push(paren.toLowerCase().replace(/&/g, ""));
  return { tokens, full, core, brand, coreTokens: coreTokens.length > 0 ? coreTokens : tokens, shortForms };
}

type LabelMatch = { kind: "name" | "short" } | { kind: "suffix"; suffix: string };

/** How a host's label spells the name (and with which suffix), or null when it does not. */
function labelMatch(label: string, shape: NameShape): LabelMatch | null {
  if (shape.shortForms.includes(label)) return { kind: "short" };
  if (label === shape.full || label === shape.core || label === shape.brand || label === `the${shape.core}` || label === `the${shape.full}`)
    return { kind: "name" };
  for (const suffix of [...INVESTING_SUFFIXES, ...NEUTRAL_SUFFIXES]) {
    if (label === `${shape.core}${suffix}` || label === `${shape.full}${suffix}`) return { kind: "suffix", suffix };
  }
  return null;
}

/**
 * How a registrable domain spells the name: label and top-level domain together when they write the
 * whole name exactly ("kensho.vc" is "Kensho VC", "hv.capital" is "HV Capital"), else the label alone.
 * Only the exact name: "offline.vc" does not write "Offline Ventures", so its label stays "offline".
 */
function domainMatch(domain: string, shape: NameShape): { label: string; match: LabelMatch } | null {
  const [first = "", ...rest] = domain.split(".");
  const label = first.replace(/-/g, "");
  if (label.length < 2) return null;
  const whole = `${label}${rest.join("")}`;
  if (rest.length === 1 && (whole === shape.full || whole === shape.brand)) return { label: whole, match: { kind: "name" } };
  const match = labelMatch(label, shape);
  return match ? { label, match } : null;
}

/**
 * Whether the result carries every word of the name, the type words included. A label that
 * matched only the brand left over once "Fund" or "Partners" came off ("founders" for Founders
 * Fund) is a common word a namesake can own; the result has to say the rest of the name.
 */
function writesEveryToken(text: string, shape: NameShape): boolean {
  const words = new Set(normalizeCompanyKey(text).split(" ").filter(Boolean));
  return shape.tokens.every((t) => words.has(t));
}

/** Whether the result writes the name as the record does, every token in order: "HSR Ventures", not "HSR Capital". */
function writesFullName(text: string, shape: NameShape): boolean {
  return ` ${normalizeCompanyKey(text)} `.includes(` ${shape.tokens.join(" ")} `);
}

/**
 * The extra bar a "name plus a suffix" label must clear, or null when there is none. A one-word
 * name takes only a venture firm's suffix, and the result must name it and read as an investor. A
 * name whose type word is a different kind from the suffix's (or whose suffix names no kind) must
 * be written out in full by the result.
 */
function suffixBar(suffix: string, shape: NameShape, text: string, named: boolean, investing: boolean): string | null {
  if (shape.tokens.length === 1) {
    if (!ONE_WORD_SUFFIXES.has(suffix)) return `a one-word name does not take "${suffix}"`;
    if (!(named && investing)) return "a one-word name needs the result to name it as an investor";
    return null;
  }
  const nameKinds = new Set(shape.tokens.flatMap((t) => TYPE_FAMILIES[t] ?? []));
  if (nameKinds.size === 0) return null;
  const sameKind = (TYPE_FAMILIES[suffix] ?? []).some((k) => nameKinds.has(k));
  if (!sameKind && !writesFullName(text, shape))
    return `"${suffix}" is a different kind of firm than the name's, and the result does not write the full name`;
  return null;
}

/** Whether the result's own words name the firm: every brand token, or the brand squashed together. */
function namesFirm(text: string, shape: NameShape): boolean {
  const words = new Set(normalizeCompanyKey(text).split(" ").filter(Boolean));
  if (shape.coreTokens.every((t) => words.has(t))) return true;
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .includes(shape.core);
}

/**
 * The investor's own domain among the search results, or null. Results are read in search order
 * and the first that passes wins:
 *   - the host is not a directory, press, wiki, or social site;
 *   - its registrable label spells the name ("sequoiacap" for Sequoia Capital: the brand plus
 *     "cap"), or a short form ("a16z", or "(QIA)" the name gave);
 *   - a label that carries an investing word or is a short form needs the result to name the firm
 *     or read as an investor; a bare-brand label ("insight", "kleinerperkins") needs both, since a
 *     reseller or a namesake can own the plain word;
 *   - a "name plus a suffix" label clears one more bar: a one-word name takes only a venture
 *     firm's suffix and must be named as an investor ("archetypeinvestments" is not Archetype),
 *     and a suffix naming a different kind of firm than the name's type word needs the full name
 *     written in the result ("hsr-capital" is not HSR Ventures unless it says "HSR Ventures");
 *   - a label that is only the brand left once the type words came off ("founders" for Founders
 *     Fund) needs the result to carry every word of the name, "Fund" included;
 *   - a title saying the domain is for sale or parked is refused whatever the label.
 */
export function pickInvestorDomain(name: string, hits: InvestorSearchHit[]): InvestorDomainPick | null {
  const target = investorSearchTarget(name);
  const shape = target && shapeOf(target.firm, name);
  if (!target || !shape) return null;
  for (const hit of hits) {
    const read = readHit(hit, target, shape);
    if (read?.pass) return { domain: read.domain, url: hit.url, reason: read.pass };
  }
  return null;
}

/** One search result as the resolver reads it: the domain its label spells the name as, and the snippet bar's verdict. */
interface HitReading {
  domain: string;
  /** The page a homepage read should start from: the result's own host when it is the domain's front door. */
  homepage: string;
  match: LabelMatch;
  /** The snippet bar's reason when the result passes it alone, else null. */
  pass: string | null;
}

function readHit(hit: InvestorSearchHit, target: InvestorTarget, shape: NameShape): HitReading | null {
  let host: string;
  try {
    const u = new URL(hit.url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    host = u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
  const domain = registrableDomain(hit.url);
  if (!domain || NOT_AN_INVESTOR_SITE.has(domain) || NOT_AN_INVESTOR_HOST.has(host)) return null;
  const spelled = domainMatch(domain, shape);
  if (!spelled) return null;
  const { label, match } = spelled;
  const homepage = `https://${host === domain ? new URL(hit.url).hostname : domain}`;
  const title = hit.title ?? "";
  if (PARKED_TITLE.test(title)) return null;
  const text = `${title} ${hit.description ?? ""}`;
  const named = namesFirm(text, shape);
  const investing = INVESTING.test(text);
  const fail = { domain, homepage, match, pass: null };
  // A short form is evidence on its own (curated, or given by the name). A person-shaped name is
  // otherwise held to the bare-brand bar even on a carrying label: the host must read as a firm,
  // not as someone's page that happens to share the name.
  const carries = match.kind === "short" || (!target.person && INVESTING_TAIL.test(label));
  if (!(carries ? named || investing : named && investing)) return fail;
  if (match.kind === "suffix" && suffixBar(match.suffix, shape, text, named, investing) !== null) return fail;
  const coreOnly = match.kind === "name" && shape.core !== shape.full && (label === shape.core || label === `the${shape.core}`);
  if (coreOnly && !writesEveryToken(text, shape)) return fail;
  const why = match.kind === "short" ? "a short form of the name" : match.kind === "suffix" ? "the name plus a suffix" : "the name";
  const says = named && investing ? "names the firm as an investor" : named ? "names the firm" : "reads as an investor";
  return { ...fail, pass: `${domain} spells ${why}, and the result ${says}` };
}

// ---------------------------------------------------------------------------------------------
// Candidates and the homepage's own word
//
// The snippet bar above is a search result's word; the pass below asks the site itself. Every
// candidate whose label spells the name (or that the round's own press release links under the
// firm's name) is read once: the branding format for its logo, and a JSON verdict on whose site it
// is, what kind of investor, and what the site says it does. A candidate is taken only when the
// deterministic gates hold too: the page stays on the candidate's domain, its own name (title, site
// name, brand) names the firm, and a label that did not spell the name came from a link whose text
// did. A snippet stands in only when the homepage could not be read at all, never for a person.

/**
 * Where a candidate came from: a search result's host, a domain a directory's snippet printed, a
 * link in the round's press, or the domain the store already holds (a re-verification).
 */
export type CandidateOrigin = "search" | "hint" | "source" | "stored";

export interface InvestorCandidate {
  domain: string;
  /** The URL the homepage read starts from. */
  homepage: string;
  origin: CandidateOrigin;
  /** How the host spells the name: its label, or only a press link's text ("anchor"). */
  spelled: "name" | "short" | "suffix" | "anchor";
  /** The snippet bar's reason when the search result passed it alone, else null. */
  snippet: string | null;
  armPage?: boolean;
}

/** A bare domain a result's snippet prints ("Website: kensho.vc"), the hint a profile page gives. */
const PRINTED_DOMAIN =
  /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|co|io|vc|ventures|capital|fund|partners|net|org|ai|xyz|eu|de|fr|uk|in|sg|jp|ca|au|ch|nl|se|es|it|il|br|co\.uk|com\.au|com\.sg))\b/gi;

/**
 * The candidates a search offers, in search order, one per domain: every result whose label spells
 * the name (whether or not its snippet passed), then the domains other results' snippets print (a
 * profile's "Website: kensho.vc") whose label spells it too. Profile pages are hints, never answers:
 * what they point to still faces the homepage read.
 */
export function investorCandidates(name: string, hits: InvestorSearchHit[]): InvestorCandidate[] {
  const target = investorSearchTarget(name);
  const shape = target && shapeOf(target.firm, name);
  if (!target || !shape) return [];
  const out = new Map<string, InvestorCandidate>();
  const hints: InvestorCandidate[] = [];
  for (const hit of hits) {
    const read = readHit(hit, target, shape);
    const armPage = !!read && writesFullName(`${hit.title ?? ""} ${hit.url.replace(/[/._-]+/g, " ")}`, shape);
    const seen = read && out.get(read.domain);
    if (seen) {
      seen.armPage ||= armPage;
      continue;
    }
    if (read) {
      const spelled = read.match.kind === "suffix" ? "suffix" : read.match.kind;
      out.set(read.domain, { domain: read.domain, homepage: read.homepage, origin: "search", spelled, snippet: read.pass, armPage });
      continue;
    }
    for (const m of `${hit.title ?? ""} ${hit.description ?? ""}`.matchAll(PRINTED_DOMAIN)) {
      const printed = registrableDomain(m[1]?.toLowerCase() ?? "");
      if (!printed || NOT_AN_INVESTOR_SITE.has(printed)) continue;
      const match = domainMatch(printed, shape)?.match;
      if (!match) continue;
      hints.push({ domain: printed, homepage: `https://${printed}`, origin: "hint", spelled: match.kind, snippet: null });
    }
  }
  for (const h of hints) if (!out.has(h.domain)) out.set(h.domain, h);
  return [...out.values()];
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The candidate a stored domain makes, for re-verifying it with the same homepage read: spelled as
 * its label spells the name, or "anchor" when it does not (the site's own name must then carry it).
 */
export function storedCandidate(name: string, domain: string): InvestorCandidate | null {
  const target = investorSearchTarget(name);
  const shape = target && shapeOf(target.firm, name);
  if (!target || !shape) return null;
  const match = domainMatch(domain, shape)?.match;
  return { domain, homepage: `https://${domain}`, origin: "stored", spelled: match ? match.kind : "anchor", snippet: null };
}

/** A markdown link: its visible text and its target. */
const MARKDOWN_LINK = /\[([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/g;

/**
 * The investor's site as the round's own press links it: a link whose visible text is the firm's
 * name (every word of it, nothing much else), or whose host spells the name, to the front page or
 * one level down of a site that is not the publisher's, a directory, or a social network. The
 * press release is the one page that names this firm on this round, so a namesake rarely gets in;
 * what it links still faces the homepage read.
 */
export function anchorCandidates(name: string, markdown: string, pageUrl: string): InvestorCandidate[] {
  const target = investorSearchTarget(name);
  const shape = target && shapeOf(target.firm, name);
  if (!target || !shape) return [];
  const own = registrableDomain(pageUrl);
  const out = new Map<string, InvestorCandidate>();
  for (const m of markdown.matchAll(MARKDOWN_LINK)) {
    const [, text = "", url = ""] = m;
    const domain = registrableDomain(url);
    const host = hostOfUrl(url);
    if (!domain || domain === own || NOT_AN_INVESTOR_SITE.has(domain) || NOT_AN_INVESTOR_HOST.has(host) || out.has(domain)) continue;
    let depth = 0;
    try {
      depth = new URL(url).pathname.split("/").filter(Boolean).length;
    } catch {
      continue;
    }
    if (depth > 1) continue;
    const match = domainMatch(domain, shape)?.match;
    const anchor = text.replace(/[*_`]/g, "").trim();
    const anchorWords = normalizeCompanyKey(anchor).split(" ").filter(Boolean);
    const anchorNames = writesEveryToken(anchor, shape) && anchorWords.length <= shape.tokens.length + 2;
    if (!match && !anchorNames) continue;
    const spelled = match ? match.kind : "anchor";
    out.set(domain, {
      domain,
      homepage: `https://${host === domain ? new URL(url).hostname : domain}`,
      origin: "source",
      spelled,
      snippet: null,
    });
  }
  return [...out.values()];
}

/** A search result about a person: a LinkedIn or X profile, or a snippet that describes someone. */
const PERSON_PROFILE = /(?:^|\.)linkedin\.com\/in\/|(?:^|\/\/)(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/?$/;
const PERSON_WORDS =
  /\b(?:angel investor|entrepreneur|serial founder|co-?founder|founder (?:and|&) ceo|founder of|ceo of|partner at|investor at|businessman|businesswoman|executive|researcher|scientist|engineer|professor|author|investor and|is an? (?:american|british|indian|french|german|canadian|israeli|australian|swedish|finnish|dutch|spanish|italian)|his|her)\b/i;
/** A name that is a person's by its form alone: an honorific ("Dr Michael Boyer") or a couple ("Terri and John Penshorn"). */
const PERSON_FORM = /^(?:dr|mr|mrs|ms|prof|sir|dame|lord)\.?\s|^\S+\s+(?:and|&)\s+\S+\s+\S+$/i;
/** Words that make the name a company's: "Eli Lilly and Company", "Morgan Stanley (NYSE: MS)". */
const COMPANY_WORDS =
  /\b(?:and company|& co\b|inc\b|incorporated|corporation|ltd\b|limited|llc\b|plc\b|nyse|nasdaq|investor relations|annual report|headquartered)\b/i;

/**
 * Whether a search for an individual's name reads as a person: a profile or a biography naming them,
 * and no result naming a company by that name. Only then is the investor recorded as a person; with
 * neither, the kind stays unknown, since "Eli Lilly" and "Morgan Stanley" have a given name first too.
 */
export function readsAsPerson(name: string, hits: InvestorSearchHit[]): boolean {
  const target = investorSearchTarget(name);
  const shape = target && shapeOf(target.firm, name);
  if (!target?.individual || !shape) return false;
  const about = hits.filter((h) => writesFullName(`${h.title ?? ""} ${h.description ?? ""}`, shape));
  if (about.some((h) => COMPANY_WORDS.test(`${h.title ?? ""} ${h.description ?? ""}`))) return false;
  if (PERSON_FORM.test(name.trim())) return true;
  return about.some((h) => PERSON_PROFILE.test(h.url) || PERSON_WORDS.test(`${h.title ?? ""} ${h.description ?? ""}`));
}

/** The kinds of site the homepage read tells apart, as the JSON verdict names them. */
export const SITE_KINDS = [
  "venture capital firm",
  "private equity or growth investor",
  "corporate venture arm",
  "corporation",
  "accelerator or incubator",
  "government or public program",
  "family office",
  "angel network or syndicate",
  "asset manager, bank, or insurer",
  "university or foundation",
  "personal website of an individual",
  "startup or other company",
  "news, directory, or database",
  "parked or unavailable",
  "other",
] as const;

// Field order is deliberate, as on the company read: the model names whose site it is and what
// kind before it may judge whether that is the investor, and the facts come last and may be empty.
export const InvestorSite = z.object({
  site_name: z.string().describe("The organization or person this website belongs to, as the site itself writes its name"),
  kind: z
    .enum(SITE_KINDS)
    .describe(
      "What the site's owner is. A firm that manages funds is one of the investor kinds, never a corporation: buyout and growth firms " +
        "(Blackstone, Bain Capital) are private equity; fund managers, banks, and insurers (BlackRock, Wellington) are asset managers; " +
        "a sovereign or state fund or agency (GIC, Temasek, a regional development bank) is a government program; a company's own " +
        "investing unit (Intel Capital, Salesforce Ventures) is a corporate venture arm. 'corporation' is only for an operating company " +
        "whose business is not investing.",
    ),
  identity_reason: z
    .string()
    .describe(
      "One sentence: whose site this is, and whether that is the investor named in the prompt or a different organization or person",
    ),
  is_named_investor: z.boolean(),
  is_parent_of_named_investor: z
    .boolean()
    .describe(
      "true when the named investor is this organization's own venture arm, fund, or investing program (Coinbase Ventures on " +
        "coinbase.com, Pfizer Ventures on pfizer.com); false when the two only share a word.",
    ),
  business_is_investing: z
    .boolean()
    .describe(
      "true when the organization's own business is investing money: venture capital, private equity, managing funds or assets, " +
        "a sovereign or state investment fund. false for an operating company that sells products or services.",
    ),
  description: z.string().describe("One sentence on what this organization does, in the site's own words; empty if the site does not say"),
  headquarters: z
    .string()
    .describe("City and country of the headquarters exactly as the site states it; empty if the site does not state it"),
});
export type InvestorSite = z.infer<typeof InvestorSite>;

export const investorSiteJsonSchema = z.toJSONSchema(InvestorSite, { target: "draft-07", io: "output" });

/** The identity prompt for one investor's homepage read. */
export function investorSitePrompt(name: string): string {
  return (
    `A funding round lists "${name}" as an investor. Decide whether this website is that investor's own site. ` +
    `is_named_investor is true only when the site belongs to the organization named "${name}", or to its venture arm, fund, or program under that name. ` +
    `It is false for a company that "${name}" invested in, for a different organization or person that shares the name or part of it, ` +
    "for a personal website of an individual, and for news, directory, or parked pages. " +
    `When "${name}" is a company's venture arm or fund (a company's name followed by Ventures, Capital, or Fund) and this site is that company's own, ` +
    "is_parent_of_named_investor is true even though the arm has no site here; it is false when the two only share a word. " +
    "Write only what the site states; leave description or headquarters empty rather than guess."
  );
}

/** How an investor shows on its page: the kind of investor, never guessed past what the site or the name says. */
export const INVESTOR_TYPES = [
  "venture_capital",
  "private_equity",
  "corporate_venture",
  "corporate",
  "accelerator",
  "government",
  "family_office",
  "angel_group",
  "asset_manager",
  "foundation",
  "person",
] as const;
export type InvestorType = (typeof INVESTOR_TYPES)[number];

const TYPE_OF_KIND: Partial<Record<(typeof SITE_KINDS)[number], InvestorType>> = {
  "venture capital firm": "venture_capital",
  "private equity or growth investor": "private_equity",
  "corporate venture arm": "corporate_venture",
  corporation: "corporate",
  "accelerator or incubator": "accelerator",
  "government or public program": "government",
  "family office": "family_office",
  "angel network or syndicate": "angel_group",
  "asset manager, bank, or insurer": "asset_manager",
  "university or foundation": "foundation",
};

/** Types whose business is investing; the rest (an operating company, a university) are taken only when no investor's site spelled the name. */
const INVESTING_TYPES = new Set<InvestorType>([
  "venture_capital",
  "private_equity",
  "corporate_venture",
  "accelerator",
  "government",
  "family_office",
  "angel_group",
  "asset_manager",
]);

/** Top-level domains only investors use as their own. */
const INVESTOR_TLDS = new Set(["vc", "fund", "capital", "ventures", "partners", "investments"]);

/** The words a company's investing arm adds to the parent's brand. */
const ARM_WORDS = new Set(["ventures", "venture", "capital", "fund", "funds", "vc", "investments", "invest", "digital", "labs", "growth"]);

/** Whether the name is a brand plus arm words only, on a host that spells the brand, and the site's own name is that brand. */
function parentArm(name: string, domain: string, ownName: string): boolean {
  const tokens = normalizeCompanyKey(investorSearchTarget(name)?.firm ?? name)
    .split(" ")
    .filter(Boolean);
  const brand = tokens.filter((t) => !ARM_WORDS.has(t) && t !== "the");
  if (brand.length === 0 || brand.length === tokens.length) return false;
  const label = domain.split(".")[0]?.replace(/-/g, "") ?? "";
  if (label !== brand.join("")) return false;
  const words = new Set(normalizeCompanyKey(ownName).split(" "));
  return brand.every((t) => words.has(t));
}

/** What one homepage read returned, as the verdict reads it. */
export interface InvestorHomepage {
  /** The URL the scrape reports it ended on, after redirects. */
  finalUrl?: string | null;
  status?: number | null;
  title?: string | null;
  siteName?: string | null;
  brandName?: string | null;
  site?: InvestorSite | null;
}

export type InvestorVerdict =
  | {
      ok: true;
      domain: string;
      type: InvestorType;
      /** An investing type, which outranks a corporation's or a bank's site. */
      investing: boolean;
      reason: string;
      description: string | null;
      headquarters: string | null;
    }
  /** `unreadable`: the page could not be judged (an error status, no verdict), which is unknown, not refused. */
  | { ok: false; unreadable: boolean; reason: string };

/**
 * Whether a homepage read makes the candidate this investor's site. The gates, in order: the page
 * answered; it did not land on another domain whose label does not spell the name (a rebrand or an
 * acquirer's site: "Sequoia India" on peakxv.com); it is not parked; the verdict says it is the
 * named investor and not a person's page, a startup, or a directory; the page's own name (title,
 * site name, brand, or the verdict's site_name) names the firm; and a person-shaped name needs a
 * firm's site, not a person's. A corporation or a bank passes only on a host that spells the name
 * itself, never on a suffix or a press link alone.
 */
export function judgeInvestorHomepage(
  name: string,
  candidate: InvestorCandidate,
  page: InvestorHomepage,
  /** The rounds' own evidence naming this investor: the text that must write a one-word name's suffix. */
  context = "",
): InvestorVerdict {
  const target = investorSearchTarget(name);
  const shape = target && shapeOf(target.firm, name);
  if (!target || !shape) return { ok: false, unreadable: false, reason: "no firm to verify" };
  if (page.status && page.status >= 400) return { ok: false, unreadable: true, reason: `the homepage answered ${page.status}` };
  const site = page.site;
  if (!site) return { ok: false, unreadable: true, reason: "the homepage read returned no verdict" };
  let domain = candidate.domain;
  const landed = page.finalUrl ? registrableDomain(page.finalUrl) : null;
  if (landed && landed !== candidate.domain) {
    if (NOT_AN_INVESTOR_SITE.has(landed) || !domainMatch(landed, shape))
      return { ok: false, unreadable: false, reason: `redirects to ${landed}` };
    domain = landed;
  }
  if (PARKED_TITLE.test(page.title ?? "") || site.kind === "parked or unavailable")
    return { ok: false, unreadable: false, reason: "parked or unavailable" };
  if (site.kind === "personal website of an individual")
    return { ok: false, unreadable: false, reason: `a person's own site (${site.site_name})` };
  if (site.kind === "startup or other company" || site.kind === "news, directory, or database" || site.kind === "other")
    return { ok: false, unreadable: false, reason: `${site.kind}: ${site.site_name}` };
  const conflictingBrand = [page.title, page.siteName, page.brandName].some((text) => {
    if (!text || (shape.tokens.length > 1 && writesFullName(text, shape))) return false;
    const words = normalizeCompanyKey(text).split(" ");
    const at = words.indexOf(shape.core);
    return at >= 0 && words.slice(at + 1).some((word) => STOP_WORDS.has(word) && !CONNECTIVES.has(word));
  });
  // A company's own venture arm is shown with its parent's site and logo when it has none of its own:
  // the name is the parent's brand plus venture words only ("Coinbase Ventures"), the host spells that
  // brand, the site is the parent's by its own name, and either the verdict says the arm is the
  // parent's or a search result on the parent's own domain writes the arm's whole name (the page
  // alone rarely says so, so the verdict seldom does).
  const armOf = parentArm(name, candidate.domain, [page.title, page.siteName, page.brandName, site.site_name].join(" | "));
  if (!site.is_named_investor && armOf && !conflictingBrand && (site.is_parent_of_named_investor || candidate.armPage)) {
    return {
      ok: true,
      domain,
      type: "corporate_venture",
      investing: true,
      reason: `${domain}: ${site.site_name}, the parent of its venture arm`,
      description: null,
      headquarters: null,
    };
  }
  if (!site.is_named_investor) return { ok: false, unreadable: false, reason: `not the named investor: ${site.identity_reason}` };
  const ownName = [page.title, page.siteName, page.brandName, site.site_name].filter(Boolean).join(" | ");
  const shortNamed = candidate.spelled === "short" && shape.shortForms.some((f) => normalizeCompanyKey(ownName).split(" ").includes(f));
  if (!namesFirm(ownName, shape) && !shortNamed)
    return { ok: false, unreadable: false, reason: `the site's own name is "${site.site_name}"` };
  // The verdict's kind calls a fund manager a corporation often enough (BlackRock, Blackstone,
  // Temasek) that its own answer on the business decides: an investing business is an investment firm.
  const type = site.kind === "corporation" && site.business_is_investing ? "asset_manager" : TYPE_OF_KIND[site.kind];
  if (!type) return { ok: false, unreadable: false, reason: site.kind };
  const investing = INVESTING_TYPES.has(type);
  // The label bars the snippet reader applies hold on the site's own name too: "picuscap.com" is
  // not Picus Ventures unless the site writes "Picus Ventures", and "alliance.com" is not Alliance VC
  // unless it writes the whole name, whatever the verdict thinks of a shared brand.
  const spelled = domainMatch(domain, shape);
  const label = spelled?.label ?? "";
  const match = spelled?.match;
  const ownText = `${ownName} ${site.description}`;
  if (match?.kind === "suffix") {
    const bar = suffixBar(match.suffix, shape, ownText, true, investing);
    if (bar) return { ok: false, unreadable: false, reason: bar };
    // A one-word name on a suffixed host is a guess at which of the firms that share the word it is
    // ("Huma" is not humacapital.com.br because the site says "Huma Capital"): the round's own words
    // must write the suffixed name too.
    const suffixed = ` ${normalizeCompanyKey(context)} `.includes(` ${shape.tokens[0]} ${match.suffix} `);
    if (shape.tokens.length === 1 && !suffixed)
      return { ok: false, unreadable: false, reason: `the round never writes "${shape.tokens[0]} ${match.suffix}", only "${target.firm}"` };
  }
  // Only a one-word brand is a common word a namesake owns ("founders" for Founders Fund), so the site
  // must write the whole name as the record does, in order: "Ithaka Infrastructure Partners" is not
  // Ithaka Partners. A brand of two words ("dstglobal" for DST Global Partners) is the firm once its
  // own site names it.
  const coreOnly =
    match?.kind === "name" &&
    shape.coreTokens.length === 1 &&
    shape.core !== shape.full &&
    (label === shape.core || label === `the${shape.core}`);
  const siteMatchesSuffix =
    match?.kind === "suffix" &&
    [page.title, page.siteName, page.brandName].some((text) =>
      ` ${normalizeCompanyKey(text ?? "")} `.includes(` ${shape.tokens[0]} ${match.suffix} `),
    ) &&
    ` ${normalizeCompanyKey(context)} `.includes(` ${shape.tokens[0]} ${match.suffix} `);
  if (shape.coreTokens.length === 1 && conflictingBrand && !siteMatchesSuffix)
    return { ok: false, unreadable: false, reason: `the page brands itself differently from "${target.firm}"` };
  // Unless the host itself is an investor's (a .vc or .fund domain), or the site calls itself by the
  // brand alone and is a venture or private equity firm: "liquid2.vc" is Liquid2 Ventures, "tpg.com"
  // whose site says "TPG" is TPG Capital, while "founders.org", a community, stays refused.
  const tld = domain.split(".").slice(1).join(".");
  const brandAlone = normalizeCompanyKey(site.site_name) === shape.core && (type === "venture_capital" || type === "private_equity");
  const investorHost = INVESTOR_TLDS.has(tld) && investing;
  if (coreOnly && !writesFullName(ownName, shape) && !brandAlone && !investorHost)
    return { ok: false, unreadable: false, reason: `${domain} spells only "${shape.core}", and the site does not write the whole name` };
  if (!investing && candidate.spelled !== "name" && candidate.spelled !== "short")
    return { ok: false, unreadable: false, reason: `a ${site.kind} on a host that does not spell the name itself` };
  const clean = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    return t && t.length <= 400 ? t : null;
  };
  return {
    ok: true,
    domain,
    type,
    investing,
    reason: `${domain}: ${site.site_name}, ${site.kind}${candidate.origin === "source" ? ", linked from the round's press" : ""}`,
    description: clean(site.description),
    headquarters: clean(site.headquarters),
  };
}
