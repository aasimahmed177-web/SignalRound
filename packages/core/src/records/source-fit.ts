// Whether a page is a source for a company's round. A link on a round tells a reader "this page
// reported this round", so a page attaches only when it is about this company: its title, its URL,
// or the sentence read off it names the company (or it is the company's own site). Job postings and
// front pages never attach, and an aggregator's page attaches only when its own headline names the
// company. Basecamp Research's Series C carried an Ashby job posting, Techmeme's homepage, and a
// Techmeme permalink about Coachella before this rule; every lane that attaches a source asks it.

import {
  ARTICLE_HOST_EXCEPTIONS,
  canonicalUrl,
  isArticleUrl,
  isJobPostingUrl,
  NON_ARTICLE_HOSTS,
  normalizeCompanyKey,
  registrableDomain,
} from "./normalize.ts";
import { headlineAmount, ROUNDUP_TITLE } from "./page-shape.ts";

/**
 * Aggregators and link rivers: one page carries the day's headlines for many stories, so the round
 * a reading found on it is usually another story's neighbour. Such a page is a source only when its
 * own headline is about the company (a Techmeme permalink titled with the round, a Hacker News item).
 */
export const AGGREGATOR_DOMAINS = new Set([
  "techmeme.com",
  "mediagazer.com",
  "digg.com",
  "memeorandum.com",
  "ycombinator.com",
  "hckrnews.com",
  "reddit.com",
  "flipboard.com",
  "ground.news",
  "lobste.rs",
  "news.google.com",
]);

/** Words of a headline about many rounds at once ("Startups raised $3.2B in August"), which no single story's headline has. */
const MANY_ROUNDS = /\b(?:startups|companies|firms|founders|deals|rounds|investments)\b/i;

/**
 * Whether a title is one story's headline about some other round: it states a figure, is neither a
 * roundup nor about many rounds, and (checked by the caller) neither names the company nor states
 * the round's amount. Entrackr's "Lumikai leads $600K pre-seed round in Demoverse" carried Sammmm's
 * seed round because the page ran its next story underneath; a sentence read off such a page is the
 * neighbour's, so it cannot place the company there.
 */
function anotherRoundsHeadline(title: string | null | undefined): boolean {
  if (!title || ROUNDUP_TITLE.test(title) || MANY_ROUNDS.test(title)) return false;
  return headlineAmount(title) !== null;
}

/** Hosts under an aggregator's registrable domain that are not the aggregator (Y Combinator's own blog and company pages). */
const AGGREGATOR_EXCEPTIONS = new Set(["www.ycombinator.com", "ycombinator.com"]);

/**
 * Words too common in company names to identify one on their own: "Research" in a headline is not
 * Basecamp Research, and "Robotics" is not Acme Robotics. A name made only of such words is matched
 * as the whole phrase.
 */
const GENERIC_NAME_WORDS = new Set([
  "the",
  "and",
  "for",
  "research",
  "lab",
  "labs",
  "tech",
  "technology",
  "technologies",
  "robotics",
  "robot",
  "robots",
  "systems",
  "software",
  "data",
  "energy",
  "power",
  "capital",
  "ventures",
  "security",
  "cyber",
  "cloud",
  "network",
  "networks",
  "group",
  "global",
  "digital",
  "food",
  "foods",
  "motors",
  "space",
  "quantum",
  "medical",
  "health",
  "healthcare",
  "care",
  "bio",
  "biotech",
  "biosciences",
  "bioscience",
  "therapeutics",
  "pharma",
  "pharmaceuticals",
  "genomics",
  "analytics",
  "solutions",
  "industries",
  "holdings",
  "company",
  "companies",
  "app",
  "apps",
  "studio",
  "studios",
  "games",
  "finance",
  "financial",
  "fintech",
  "pay",
  "payments",
  "money",
  "bank",
  "insurance",
  "intelligence",
  "machines",
  "materials",
  "science",
  "sciences",
  "climate",
  "carbon",
  "mobility",
  "automation",
  "logistics",
  "platform",
  "commerce",
  "media",
  "works",
  "open",
  "one",
  "new",
  "first",
  "united",
  "international",
  "startup",
  "funding",
  "raises",
  "series",
  "seed",
]);

/** The company as the rule sees it: its name, its registrable domain, and the other names it is stored under. */
export interface SourceSubject {
  name: string;
  domain?: string | null;
  /** Other names the company was seen under (company_aliases of kind name). */
  aliases?: readonly string[];
}

/** A page as one reading of the round saw it: its URL, the title it carried when read, and the sentence read off it. */
export interface SourceLink {
  url: string;
  title?: string | null;
  /** The evidence sentence (or sentences) the reading took from this page. */
  evidence?: readonly (string | null | undefined)[] | string | null;
}

/** The round the page would be a source for: its amount, in millions of its currency, as the row stores it. */
export interface SourceRound {
  amountValue: number | null;
  amountCurrency: string | null;
}

export type SourceFitReason = "job_posting" | "not_article" | "aggregator" | "not_about_company";
export type SourceFitBy = "domain" | "title" | "url" | "title_amount" | "evidence";
export type SourceFit = { attach: true; by: SourceFitBy } | { attach: false; reason: SourceFitReason };

/** A headline's amount agrees with the round's when they differ by no more than this share of the larger. */
const TITLE_AMOUNT_TOLERANCE = 0.1;

/**
 * Whether a headline states this round's amount: "Biodiversity AI Raises $140M" is Basecamp Research's
 * $140M Series C though it never names the company, as the wires often write it. The currency must
 * agree when both are known.
 */
export function titleStatesAmount(title: string | null | undefined, round: SourceRound | null | undefined): boolean {
  if (!round || round.amountValue === null || round.amountValue <= 0) return false;
  const headline = headlineAmount(title);
  if (!headline || headline.value <= 0) return false;
  if (headline.currency && round.amountCurrency && headline.currency !== round.amountCurrency) return false;
  return Math.abs(headline.value - round.amountValue) <= TITLE_AMOUNT_TOLERANCE * Math.max(headline.value, round.amountValue);
}

/** A name the rule matches: its key, and the tokens of it that identify the company alone. */
interface NameForm {
  key: string;
  distinctive: string[];
}

/** Every name the company goes by, the domain's own label among them (`basecamp-research.com` reads "basecamp research"). */
function nameForms(subject: SourceSubject): NameForm[] {
  const label = subject.domain ? subject.domain.split(".")[0] : "";
  const names = [subject.name, ...(subject.aliases ?? []), ...(label.length >= 4 ? [label] : [])];
  const forms: NameForm[] = [];
  for (const name of names) {
    const key = normalizeCompanyKey(name);
    if (!key || forms.some((f) => f.key === key)) continue;
    const distinctive = key.split(" ").filter((t) => t.length >= 3 && !GENERIC_NAME_WORDS.has(t));
    forms.push({ key, distinctive });
  }
  return forms;
}

/**
 * Whether a text names one form: half the distinctive tokens (rounded up) are words of the text, or
 * the whole key is a phrase in it when the name has no distinctive token. With `prefix` (a slug, which
 * runs words together and truncates), a text word that starts with a token of four or more letters,
 * or a text word of five or more letters that starts a token, counts.
 */
function namesForm(text: string, form: NameForm, prefix: boolean): boolean {
  const body = normalizeCompanyKey(text);
  if (!body) return false;
  if (` ${body} `.includes(` ${form.key} `)) return true;
  if (form.distinctive.length === 0) return false;
  const words = body.split(" ");
  const present = new Set(words);
  const hit = (t: string) =>
    present.has(t) || (prefix && words.some((w) => (t.length >= 4 && w.startsWith(t)) || (w.length >= 5 && t.startsWith(w))));
  return form.distinctive.filter(hit).length >= Math.ceil(form.distinctive.length / 2);
}

/** Whether a title or a sentence names the company by any of its names, or writes its domain. */
export function textNamesSubject(text: string | null | undefined, subject: SourceSubject): boolean {
  if (!text?.trim()) return false;
  if (subject.domain && text.toLowerCase().includes(subject.domain.toLowerCase())) return true;
  const forms = nameForms(subject);
  if (forms.some((f) => namesForm(text, f, false))) return true;
  // The company's own X account names it too: "@TaskletAI" is Tasklet, "@seltz_ai" is Seltz.
  const handles = [...text.matchAll(/(?:^|[^\w@])@(\w{3,15})\b/g)].map((m) =>
    m[1]
      .toLowerCase()
      .replace(/_/g, "")
      .replace(/(?:hq|app|ai|labs?|inc|io)$/, ""),
  );
  return forms.some((f) => f.key.replace(/\s+/g, "").length >= 4 && handles.includes(f.key.replace(/\s+/g, "")));
}

/** Whether a URL's path names the company (a slug runs words together, so prefixes count) or carries its domain. */
export function urlNamesSubject(url: string, subject: SourceSubject): boolean {
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // A malformed escape leaves the path as written.
    }
  } catch {
    return false;
  }
  if (subject.domain && path.toLowerCase().includes(subject.domain.toLowerCase())) return true;
  const text = path.replace(/[-_/.+]/g, " ");
  return nameForms(subject).some((f) => namesForm(text, f, true));
}

/** Whether a URL is on an aggregator: its whole domain, or a listed host such as news.google.com. */
export function isAggregatorUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (AGGREGATOR_EXCEPTIONS.has(host)) return false;
  const domain = registrableDomain(url) ?? host;
  return AGGREGATOR_DOMAINS.has(domain) || AGGREGATOR_DOMAINS.has(host.replace(/^www\./, ""));
}

/**
 * Funding databases and company-profile farms: they restate rounds from other pages, often with the
 * wrong day (trysignalbase dated tldraw's April Series A to June) or no day at all (startupintros'
 * /orgs/tldraw), and sometimes a total as a round (cbinsights' "Series A $14.7M"). Such a page may
 * name a round worth looking for, but never verifies or dates one. The investor databases the sweep
 * never reads (NON_ARTICLE_HOSTS) count too. Not the link rivers above, whose permalinks are stories.
 */
export const FUNDING_AGGREGATOR_HOSTS = new Set([
  "trysignalbase.com",
  "startupintros.com",
  "checkthat.ai",
  "hraness.com",
  "simplify.jobs",
  "cbinsights.com",
  "billiondollarpitchdecks.com",
  "craft.co",
  "owler.com",
  "parsers.vc",
  "getlatka.com",
  "fundz.net",
  "multiples.vc",
  "tamradar.com",
  "dropstab.com",
  // Forums: a thread repeats what someone read elsewhere (Factory's round was on the feed from a Reddit post alone).
  "reddit.com",
  "quora.com",
  "hckrnews.com",
  "lobste.rs",
]);

/** Forum hosts under a domain whose other hosts are not forums (Y Combinator's own blog is not Hacker News). */
const FORUM_HOSTS = new Set(["news.ycombinator.com"]);

/**
 * The shape of a company profile on a site that files companies: /orgs/tldraw, /brands/acme, /c/acme,
 * "who-funded-acme", /company/acme/financials. A host list alone never catches the next farm.
 */
const AGGREGATOR_PATH =
  /^\/(?:orgs?|organizations?|brands?|c|profiles?)\/[^/]+\/?$|who-?funded|\/funding-rounds?\b|\/(?:company|companies|startups?)\/[^/]+\/(?:financials|funding|investors|valuation)\b/i;

/** Whether a page restates rounds rather than reporting one: a funding database, a profile farm, or a profile-shaped path on any host. */
export function isFundingAggregatorUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (ARTICLE_HOST_EXCEPTIONS.has(host)) return false;
  const domain = registrableDomain(url) ?? host;
  if (FUNDING_AGGREGATOR_HOSTS.has(domain) || NON_ARTICLE_HOSTS.has(domain) || FORUM_HOSTS.has(host)) return true;
  return AGGREGATOR_PATH.test(u.pathname);
}

/**
 * Whether a round's sources are all secondhand: funding databases, profile farms, forums, or, for a
 * host no tier names, a page the classifier read as an aggregator or as neither an announcement nor an
 * article (`kinds`, by canonical URL). Such pages may point at a round but never make it visible or
 * date it alone; a company's or an investor's post, a wire release, or a publication can.
 */
export function secondhandOnly(
  urls: readonly string[],
  tiers: Record<string, number>,
  kinds: ReadonlyMap<string, string> = new Map(),
): boolean {
  if (urls.length === 0) return false;
  return urls.every((url) => {
    if (isFundingAggregatorUrl(url)) return true;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (tiers[host] !== undefined || tiers[host.replace(/^www\./, "")] !== undefined) return false;
    const kind = kinds.get(canonicalUrl(url));
    return kind === "aggregator" || kind === "other";
  });
}

/** Blog hosts that give each publisher a subdomain: acme.substack.com is Acme's when Acme's domain label is acme. */
const BLOG_PLATFORMS = new Set(["substack.com", "ghost.io", "medium.com", "beehiiv.com", "hashnode.dev", "wordpress.com", "blogspot.com"]);

/**
 * Whether a page is on the company's own site. "own": its domain, or a site its homepage links to
 * (`sites`, stored as domain aliases). "sibling": the company's domain label on another suffix
 * (tldraw.dev for tldraw.com) or as its subdomain on a blog platform (tldraw.substack.com), where
 * companies often publish their announcements. Another company can hold the same label, so a sibling
 * counts only when the page names the company; the caller holds it to that. Null otherwise.
 */
export function companySite(url: string, subject: { domain?: string | null; sites?: readonly string[] }): "own" | "sibling" | null {
  if (!subject.domain) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  const domain = registrableDomain(url) ?? host;
  if (domain === subject.domain) return "own";
  if (subject.sites?.some((site) => host === site || host.endsWith(`.${site}`))) return "own";
  const label = subject.domain.split(".")[0];
  if (label.length < 3) return null;
  if (BLOG_PLATFORMS.has(domain)) return host.split(".")[0] === label ? "sibling" : null;
  return domain.split(".")[0] === label ? "sibling" : null;
}

/**
 * The sibling sites a homepage links (tldraw.dev, tldraw.substack.com): the company's own publishing,
 * vouched for by its homepage, so they are "own" from then on. A site that only shares the label is
 * not linked and stays a sibling that must name the company.
 */
export function linkedSites(links: readonly string[], domain: string): string[] {
  const out = new Set<string>();
  for (const link of links) {
    if (companySite(link, { domain }) !== "sibling") continue;
    const registrable = registrableDomain(link);
    if (!registrable) continue;
    out.add(BLOG_PLATFORMS.has(registrable) ? new URL(link).hostname.toLowerCase().replace(/^www\./, "") : registrable);
  }
  return [...out].slice(0, 5);
}

/** Whether a URL is the root of a site: its homepage is never a report of a round, the company's own included. */
function isSiteRoot(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "";
  } catch {
    return true;
  }
}

/**
 * Whether a page may be a source for the company's round, and why not when it may not. In order: a
 * job posting never is; a front page, a section index, a tag or search page, or a directory entry
 * never is (the company's own posts are, wherever its site files them); an aggregator is only when
 * the title it carried when read names the company; the company's own site is; otherwise the title,
 * the URL, a headline stating the round's amount, or the evidence read off the page must place the
 * company there. A roundup that does not name the company in its title or URL therefore needs an
 * evidence sentence that does, and a single story's headline about another round admits no evidence. Pure: the same rule the resolver, corroboration, the fill path, and
 * `pnpm prune-unrelated-sources` apply.
 */
export function sourceFit(link: SourceLink, subject: SourceSubject, round?: SourceRound | null): SourceFit {
  if (isJobPostingUrl(link.url)) return { attach: false, reason: "job_posting" };
  const own = Boolean(subject.domain) && registrableDomain(link.url) === subject.domain;
  if (own && !isSiteRoot(link.url)) return { attach: true, by: "domain" };
  if (!isArticleUrl(link.url)) return { attach: false, reason: "not_article" };
  const titled = textNamesSubject(link.title, subject);
  if (isAggregatorUrl(link.url)) return titled ? { attach: true, by: "title" } : { attach: false, reason: "aggregator" };
  if (titled) return { attach: true, by: "title" };
  if (urlNamesSubject(link.url, subject)) return { attach: true, by: "url" };
  if (titleStatesAmount(link.title, round)) return { attach: true, by: "title_amount" };
  if (anotherRoundsHeadline(link.title)) return { attach: false, reason: "not_about_company" };
  const evidence = typeof link.evidence === "string" ? [link.evidence] : (link.evidence ?? []);
  if (evidence.some((q) => textNamesSubject(q, subject))) return { attach: true, by: "evidence" };
  return { attach: false, reason: "not_about_company" };
}
