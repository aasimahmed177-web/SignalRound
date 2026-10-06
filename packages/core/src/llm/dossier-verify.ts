// The dossier check. The agent's dossier reads well and is wrong often enough to matter: funders
// listed as customers, the round we just verified listed again as a "prior round", a total raised
// from before that round, an employee called a founder, a directory's "alternatives" list called
// competitors. So nothing it writes is shown until a model with the evidence in hand has ruled on
// every claim. Firecrawl reads the dossier's own sources (the company's site first, then the wire
// and the press), plus a search when those are thin; our verified record is evidence too, and it
// wins. The model only keeps or drops what the dossier says, item by item, and every kept claim
// carries the words that state it, which must be found in the page it cites. It never writes a fact.

import { generateText, Output } from "ai";
import type { Document, Firecrawl, SearchResultWeb } from "firecrawl";
import { z } from "zod";
import { mapLimit } from "../firecrawl/credits.ts";
import type { CompanyDossier } from "../firecrawl/deepdive.ts";
import {
  businessWords,
  describingQuote,
  distinguishingWords,
  hostMatchesCompany,
  searchName,
  sharesBusinessWords,
} from "../firecrawl/enrich.ts";
import { classifyStage, hostOf, parseAmount } from "../records/normalize.ts";
import type { ReconcileModel } from "./model.ts";

/** One of our rounds, as the store holds it: the facts the dossier must agree with. */
export interface OurRound {
  stage_as_written: string;
  amount_as_written: string | null;
  amount_value: number | null;
  amount_currency: string | null;
  usd_millions: number | null;
  announced_on: string | null;
  lead_investors: string[];
  other_investors: string[];
  /** Publish, or confirmed by the read-back: the record the feed stands behind. */
  verified: boolean;
  evidence: string[];
}

export interface DossierSubject {
  name: string;
  domain: string | null;
  website: string | null;
  description: string | null;
  hq: string | null;
  sector: string | null;
}

/** Provider facts stored for the domain (Alexandria): sourced, so they count as evidence. */
export interface DossierFacts {
  yc: { url: string; batch: string | null; year_founded: number | null; team_size: number | null; founders: string[] } | null;
  firmographics: { year_founded: number | null; headcount: number | null; headcount_range: string | null; hq: string | null } | null;
}

export interface DossierContext {
  company: DossierSubject;
  rounds: OurRound[];
  facts: DossierFacts | null;
  /** ISO day of the check: what "most recent" and "stale" are measured from. */
  today: string;
}

export interface EvidencePage {
  id: string;
  url: string;
  kind: "company" | "press" | "our_source" | "search" | "other";
  title?: string;
  markdown: string;
}

/** Pages of the dossier's own sources read per check. */
export const MAX_DOSSIER_SOURCES = 8;
/** Pages of our rounds' sources read beside them: the announcement we verified, where totals are usually stated. */
export const MAX_OUR_SOURCES = 2;
/** Characters per page the model reads: an about page or a release fits whole. */
export const DOSSIER_PAGE_CHARS = 12_000;
/** Below this many readable pages, or with none from the company's own site, a search adds more. */
export const THIN_EVIDENCE_PAGES = 4;
export const DOSSIER_SEARCH_RESULTS = 5;

/** Hosts behind a login or paywall: a scrape returns a teaser or a wall, never the claim. */
const WALLED_HOSTS = ["linkedin.com", "crunchbase.com", "pitchbook.com", "zoominfo.com", "rocketreach.co", "owler.com", "apollo.io"];
/** Directories and databases: readable, but a claim sourced only here is weak, so they read last. */
const DIRECTORY_HOSTS = [
  "cbinsights.com",
  "tracxn.com",
  "dealroom.co",
  "g2.com",
  "f6s.com",
  "craft.co",
  "northdata.de",
  "northdata.com",
  "getlatka.com",
  "caplight.com",
  "fundup.ai",
  "cryptorank.io",
  "startbase.com",
  "startup.eu",
  "inc42.com",
  "multiples.vc",
  "apps.apple.com",
  "play.google.com",
];
const WIRE_HOSTS = /(^|\.)(prnewswire|businesswire|globenewswire|prweb|accesswire|newswire)\.(com|ca)$/;

const onHost = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

/** Whether a URL is on the company's own site: its stored domain, or a host that spells its name. */
export function isCompanySite(url: string, company: Pick<DossierSubject, "name" | "domain">): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (company.domain && (host === company.domain || host.endsWith(`.${company.domain}`))) return true;
  return hostMatchesCompany(host, company.name);
}

/**
 * On the company's site, what a page can substantiate: who (about, team), what (the homepage), then
 * the lists (customers, alternatives), then its own funding news (totals and earlier rounds), and
 * pricing last, since it backs only the business model. Pure.
 */
function sitePageRank(url: string): number {
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return 9;
  }
  if (/about|team|company|founder|story|leadership|who-we-are|ueber-uns|uber-uns/.test(path)) return 0;
  if (path === "/" || path === "" || /^\/[a-z]{2}(-[a-z]{2})?\/?$/.test(path)) return 1;
  if (/customer|case-stud|alternative|compare|competitor|-vs-|\/vs\//.test(path)) return 2;
  if (/news|press|blog|funding|series|seed|raise/.test(path)) return 3;
  if (/pricing|plans/.test(path)) return 4;
  return 5;
}

/**
 * Which of the dossier's sources to read, best first: the company's own pages (four at most, so the
 * press is heard too), then wires and articles, then the rest, with directories last and walled
 * hosts never. Pure.
 */
export function rankDossierSources(urls: string[], company: Pick<DossierSubject, "name" | "domain">, max = MAX_DOSSIER_SOURCES): string[] {
  const seen = new Set<string>();
  const unique = urls.filter((u) => {
    const key = u.replace(/[#?].*$/, "").replace(/\/$/, "");
    if (!/^https?:\/\//i.test(u) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const own = unique.filter((u) => isCompanySite(u, company)).sort((a, b) => sitePageRank(a) - sitePageRank(b));
  const rest = unique.filter((u) => !isCompanySite(u, company) && !onHost(hostOf(u), WALLED_HOSTS));
  const tier = (u: string) => {
    const host = hostOf(u);
    if (WIRE_HOSTS.test(host)) return 0;
    if (host === "ycombinator.com" || host.endsWith("sec.gov")) return 1;
    if (onHost(host, DIRECTORY_HOSTS)) return 3;
    return 2;
  };
  const others = rest.map((u, i) => ({ u, i })).sort((a, b) => tier(a.u) - tier(b.u) || a.i - b.i);
  const picked = own.slice(0, 4);
  for (const { u } of others) if (picked.length < max) picked.push(u);
  for (const u of own.slice(4)) if (picked.length < max) picked.push(u);
  return picked;
}

// The verdict the model returns. Items are referred to by index so it can only rule on what the
// dossier says, never restate it.

const Ruling = z.enum(["supported", "contradicted", "unsupported"]);
const Cite = {
  verdict: Ruling,
  source: z.string().nullable().describe("The evidence id that states the claim (S1, Q2, R, A); null when none does."),
  quote: z
    .string()
    .nullable()
    .describe("The smallest span of that evidence that states the claim, copied exactly, at most 300 characters; null when none."),
  confidence: z.enum(["high", "low"]).describe("low when the evidence is indirect, from a directory only, ambiguous, or you are unsure."),
  reason: z.string().describe("A few words on why, naming what disagrees when contradicted."),
};
const FieldCheck = z.object(Cite);
const ItemCheck = z.object({ index: z.number().int().describe("The claim's index as listed."), ...Cite });

export const DossierVerdict = z.object({
  identity: z.object({
    same_company: z
      .enum(["yes", "no", "unclear"])
      .describe(
        "Whether the dossier and the evidence are about the company in our record (name, what it does, where, its rounds). A namesake is no.",
      ),
    reason: z.string(),
  }),
  one_liner: FieldCheck,
  founded_year: FieldCheck,
  headcount_estimate: FieldCheck,
  total_raised: FieldCheck.extend({
    includes_our_latest_round: z
      .enum(["yes", "no", "unclear"])
      .describe(
        "yes when the stated total is from on or after our latest round's date, or plainly counts it; no when it predates it or is smaller than that round alone.",
      ),
  }),
  business_model: FieldCheck,
  why_it_matters: FieldCheck,
  founders: z.array(
    ItemCheck.extend({
      is_founder: z.boolean().describe("Whether evidence calls this person a founder or co-founder of this company."),
      role_supported: z.boolean(),
      background_supported: z.boolean(),
    }),
  ),
  prior_rounds: z.array(
    ItemCheck.extend({
      is_equity_round: z
        .boolean()
        .describe(
          "false for a loan, a grant, debt, a credit facility, or venture debt. Convertible notes and SAFEs from investors are equity.",
        ),
      same_as_our_round: z
        .boolean()
        .describe("true when this is one of the rounds in our record, even under another label, amount, or a date a few months off."),
      amount_supported: z.boolean(),
      date_supported: z.boolean(),
      leads_supported: z.array(z.string()).describe("The listed leads that evidence names as leading this round, spelled as listed."),
    }),
  ),
  customers: z.array(
    ItemCheck.extend({
      kind: z
        .enum(["customer", "investor_or_backer", "partner_or_supplier", "person", "other"])
        .describe(
          "What evidence says this name is to the company: a customer or user; an investor, accelerator, incubator, grant program, or public funder; a partner, supplier, integration, or manufacturer; a named individual; or something else.",
        ),
    }),
  ),
  investors_and_backers: z.array(ItemCheck),
  competitors: z.array(ItemCheck),
});
export type DossierVerdict = z.infer<typeof DossierVerdict>;

/** The second look at claims the first pass kept on weak footing: quote it or lose it. */
export const DossierRecheck = z.object({
  claims: z.array(
    z.object({
      id: z.string().describe("The claim id as listed."),
      verdict: Ruling,
      source: z.string().nullable(),
      quote: z.string().nullable().describe("The exact words that state the claim, copied from that evidence; null when none."),
    }),
  ),
});
export type DossierRecheck = z.infer<typeof DossierRecheck>;

export interface DroppedClaim {
  /** The dossier field: founders, prior_rounds, customers, total_raised_as_written, and so on. */
  field: string;
  /** The list item or value that went, for a reader of the record. */
  item: string | null;
  reason: string;
  /**
   * A prior round dropped only for want of evidence among the pages the check read (unsupported, not
   * confirmed on a second reading), kept whole: the history pass searches for its own announcement,
   * which the check never read. A round dropped for being wrong (contradicted, ours, not equity) has none.
   */
  prior?: CompanyDossier["prior_rounds"][number];
}

/** A drop that says the pages were silent, not that the claim was wrong. */
const WANT_OF_EVIDENCE = /^(?:unsupported|not confirmed|not checked)/;

/** What the check did, stored beside the dossier it produced. */
export interface DossierVerification {
  version: 1;
  checked_at: string;
  /** The model label, "gateway:openai/gpt-6-sol". */
  model: string;
  /** Pages read and handed to the model (the dossier's sources, our rounds' sources, search results). */
  sources_checked: string[];
  searched: boolean;
  kept: number;
  dropped: DroppedClaim[];
  /** Kept claim to the URL of the evidence that states it ("founders[0]": "https://acme.com/about"); R and A are our record and provider facts. */
  citations: Record<string, string>;
  /** Claims sent to the second pass. */
  rechecked: number;
  /** Firecrawl credits the check's reads cost at the rate card. */
  credits: number;
}

export type DossierCheck =
  | { status: "verified"; dossier: CompanyDossier; verification: DossierVerification }
  | { status: "rejected"; reason: "different company" | "identity unclear"; detail: string; verification: DossierVerification };

/** Lowercase letters and digits with single spaces: what a quote and a page are compared as. */
function normalizeForQuote(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Markdown as a reader sees it: a link or an image is its visible text, never its target. A model
 * quotes "Co-chaired by Sam Altman and Elon Musk", while the page's markdown reads "Co-chaired by
 * [Sam Altman](https://observer.com/person/sam-altman/ "Sam Altman") and ..."; compared raw, the
 * quote never matched, and OpenAI lost Altman, Brockman, and Sutskever as founders.
 */
export function visibleMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/<https?:\/\/[^>\s]+>/g, " ");
}

/** A quote the model shortened with an ellipsis: each piece must be found, in order. */
const ELLIPSIS = /\s*(?:\[\s*(?:\.\s*){3}\]|\(\s*(?:\.\s*){3}\)|\.{3,}|…)\s*/;

/** Whether the quote appears in the text, ignoring case, accents, punctuation, and markdown. A quote of a few characters proves nothing. */
export function quoteFound(quote: string | null, text: string): boolean {
  if (!quote) return false;
  const q = normalizeForQuote(visibleMarkdown(quote));
  if (q.length < 4) return false;
  const page = normalizeForQuote(visibleMarkdown(text));
  if (page.includes(q)) return true;
  // "fellow co-founders Altman ... and Karpathy": every piece of real length, in the page's order.
  const pieces = quote
    .split(ELLIPSIS)
    .map((p) => normalizeForQuote(visibleMarkdown(p)))
    .filter(Boolean);
  if (pieces.length < 2 || pieces.some((p) => p.length < 4)) return false;
  let at = 0;
  for (const p of pieces) {
    const found = page.indexOf(p, at);
    if (found < 0) return false;
    at = found + p.length;
  }
  return true;
}

/** Our record as a text block the model reads and a quote can be checked against. */
export function recordEvidence(ctx: DossierContext): string {
  const c = ctx.company;
  const lines = [
    `Company: ${c.name}`,
    c.domain ? `Domain on record: ${c.domain}` : null,
    c.description ? `Described as: ${c.description}` : null,
    c.hq ? `Headquarters: ${c.hq}` : null,
    c.sector ? `Sector: ${c.sector}` : null,
  ].filter(Boolean);
  for (const r of ctx.rounds) {
    const investors = [
      r.lead_investors.length ? `led by ${r.lead_investors.join(", ")}` : null,
      r.other_investors.length ? `with ${r.other_investors.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(
      `Round${r.verified ? " (verified)" : ""}: ${r.stage_as_written}, ${r.amount_as_written ?? "amount not stated"}, announced ${r.announced_on ?? "undated"}${investors ? `, ${investors}` : ""}.`,
    );
    for (const e of r.evidence.slice(0, 2)) lines.push(`  Evidence: ${e}`);
  }
  return lines.join("\n");
}

export function factsEvidence(facts: DossierFacts | null): string | null {
  if (!facts) return null;
  const lines: string[] = [];
  if (facts.yc) {
    const y = facts.yc;
    lines.push(
      `Y Combinator record (${y.url}): batch ${y.batch ?? "unknown"}, founded ${y.year_founded ?? "unknown"}, team size ${y.team_size ?? "unknown"}, founders ${y.founders.length ? y.founders.join(", ") : "not listed"}.`,
    );
  }
  if (facts.firmographics) {
    const f = facts.firmographics;
    lines.push(
      `FullEnrich firmographics: founded ${f.year_founded ?? "unknown"}, headcount ${f.headcount ?? f.headcount_range ?? "unknown"}, headquarters ${f.hq ?? "unknown"}.`,
    );
  }
  return lines.length ? lines.join("\n") : null;
}

/** The claims, one per line with its id: what the model rules on and what a recheck names. */
export function dossierClaims(d: CompanyDossier): Array<{ id: string; field: string; index: number | null; text: string }> {
  const out: Array<{ id: string; field: string; index: number | null; text: string }> = [];
  const add = (field: string, text: string | null, index: number | null = null) => {
    if (text) out.push({ id: index === null ? field : `${field}[${index}]`, field, index, text });
  };
  add("one_liner", d.one_liner || null);
  add("founded_year", d.founded_year === null ? null : String(d.founded_year));
  add("headcount_estimate", d.headcount_estimate);
  add("total_raised", d.total_raised_as_written);
  add("business_model", d.business_model);
  add("why_it_matters", d.why_it_matters || null);
  d.founders.forEach((f, i) => {
    add("founders", `${f.name}; role: ${f.role ?? "none given"}; background: ${f.background ?? "none given"}`, i);
  });
  d.prior_rounds.forEach((r, i) => {
    add(
      "prior_rounds",
      `${r.stage_as_written}; amount: ${r.amount_as_written ?? "none given"}; date: ${r.announced_date ?? "none given"}; leads: ${r.lead_investors.join(", ") || "none given"}`,
      i,
    );
  });
  d.customers.forEach((n, i) => {
    add("customers", n, i);
  });
  d.investors_and_backers.forEach((n, i) => {
    add("investors_and_backers", n, i);
  });
  d.competitors.forEach((n, i) => {
    add("competitors", n, i);
  });
  return out;
}

const RULES = [
  "You check a company dossier that a research agent wrote. Rule on every claim using only the evidence below. Never supply a corrected value or a new fact: you keep or drop what the dossier says.",
  "Identity first: is the dossier, and is the evidence, about the company in our record? Judge by the name, what it does, where it is, and its rounds. A company with the same or a similar name in another business or country is a different company. The domain on our record can itself be wrong; judge the whole picture and say so in the reason.",
  "A claim is supported only when an evidence item states it about this company; quote the smallest span that states it, copied exactly. Contradicted when evidence or our record states otherwise. Unsupported when nothing states it.",
  "Our record (R) is verified and wins: a claim that disagrees with it is contradicted, and a prior round that is one of our rounds (the same round under another label, a different amount, or a date a few months off) is same_as_our_round.",
  "Customers: first decide kind from the evidence, then rule on that relationship: supported means evidence states the relationship kind names. A customer only when evidence says it buys or uses the product (a case study, 'customers include', 'used by', a customer logo wall). An investor, accelerator, incubator, grant program, or public funder (a 'supported by' or 'backed by' logo) is investor_or_backer. A partner, supplier, integration, reseller, or manufacturer is partner_or_supplier. A named individual (a testimonial) is person. A founder's employer or university is other.",
  "Founders: the verdict rules on the person being a founder or co-founder of this company (is_founder): one evidence calls a co-founder, a founder, or a member of the founding team is one, including one who has since left; an executive or employee is not, and neither is an early funder or board member evidence never calls a founder. Role and background are ruled separately (role_supported, background_supported) and do not change the verdict; a role is supported only as evidence states it (a co-chair at founding is not a CEO).",
  "Prior rounds: the verdict rules on the round having happened; amount, date, and leads are ruled separately (amount_supported, date_supported, leads_supported) and do not change the verdict. Equity only: a bank loan, a grant, debt, a credit or growth facility, or venture debt is not an equity round. A corporation's strategic investment in the company (Microsoft's in OpenAI, Amazon's or Google's in Anthropic), including one paid partly in cloud credits, is an equity round; a commercial contract or compute purchase is not.",
  "Headcount and total raised go stale: when a newer evidence item gives a different figure, the older one is contradicted. For total raised, say whether it includes our latest round.",
  "Competitors: supported only when evidence names it as a competitor, rival, or alternative to this company. A directory's generic 'similar companies' list is weak: confidence low.",
  "One-liner, business model, and why it matters: supported only when every factual statement in them is stated by evidence or our record, and every number matches; otherwise unsupported or contradicted.",
  "Mark confidence low whenever the support is indirect, ambiguous, from a directory alone, or you are unsure.",
];

export function dossierVerifyPrompt(d: CompanyDossier, ctx: DossierContext, pages: EvidencePage[]): string {
  const facts = factsEvidence(ctx.facts);
  const evidence = [
    `--- R: our record ---\n${recordEvidence(ctx)}`,
    facts ? `--- A: provider facts ---\n${facts}` : null,
    ...pages.map(
      (p) =>
        `--- ${p.id} (${p.kind}) ---\nURL: ${p.url}${p.title ? `\nTitle: ${p.title}` : ""}\n\n${p.markdown.slice(0, DOSSIER_PAGE_CHARS)}`,
    ),
  ].filter(Boolean);
  const claims = dossierClaims(d)
    .map((c) => `${c.id}: ${c.text}`)
    .join("\n");
  return [
    RULES.join("\n"),
    `Today is ${ctx.today}. Return a check for every listed claim, by its index; a field with no claim listed still needs an entry (verdict unsupported).`,
    `Dossier claims:\n${claims}`,
    `Evidence:\n\n${evidence.join("\n\n")}`,
  ].join("\n\n");
}

export function dossierRecheckPrompt(claims: Array<{ id: string; text: string }>, ctx: DossierContext, base: string): string {
  return [
    "A first reading kept these dossier claims on weak footing. For each, find the exact words in the evidence that state it about this company and copy them. If no evidence states it, the verdict is unsupported. Do not infer; do not accept a directory's list as proof on its own.",
    `Today is ${ctx.today}.`,
    `Claims:\n${claims.map((c) => `${c.id}: ${c.text}`).join("\n")}`,
    base,
  ].join("\n\n");
}

/** A total can be the company's total only when it is at least our biggest round in the same currency. */
export function totalBelowOurRound(total: string, rounds: OurRound[]): OurRound | null {
  const t = parseAmount(total);
  if (t.value === null || !t.currency) return null;
  for (const r of rounds) {
    if (r.amount_value === null || r.amount_currency !== t.currency) continue;
    if (t.value < r.amount_value * 0.98) return r;
  }
  return null;
}

const DAY = 86_400_000;

/** A prior round that is one of ours: the same stage inside four months, or the same amount in the same currency. Our record wins. */
/**
 * The series letter a stage names ("Series E" is "e", "Series F2" is "f"), else null. Every lettered
 * stage past C shares one bucket, so the letters are what tell a Series D from a Series E.
 */
export function seriesLetter(stageAsWritten: string | null | undefined): string | null {
  return /^series\s+([a-z])(?:\d|-\d)?(?:\s+round)?$/i.exec((stageAsWritten ?? "").trim().replace(/\s+/g, " "))?.[1]?.toLowerCase() ?? null;
}

export function duplicatesOurRound(prior: CompanyDossier["prior_rounds"][number], rounds: OurRound[]): OurRound | null {
  const stage = classifyStage(prior.stage_as_written).stage;
  const amount = parseAmount(prior.amount_as_written);
  const when = prior.announced_date
    ? Date.parse(prior.announced_date.length === 4 ? `${prior.announced_date}-07-01` : prior.announced_date)
    : NaN;
  for (const r of rounds) {
    // Anthropic's dossier called Amazon's $2.75B tranche (March 2024) a "Series E", and the bucket
    // matched it to the Series D two months earlier; two named letters that differ are two rounds.
    const [ours, theirs] = [seriesLetter(r.stage_as_written), seriesLetter(prior.stage_as_written)];
    const ourStage = ours && theirs && ours !== theirs ? "other" : classifyStage(r.stage_as_written).stage;
    const ourWhen = r.announced_on ? Date.parse(r.announced_on) : NaN;
    const close = Number.isFinite(when) && Number.isFinite(ourWhen) && Math.abs(when - ourWhen) <= 120 * DAY;
    if (stage !== "other" && stage === ourStage && (close || !Number.isFinite(when))) return r;
    if (
      amount.value !== null &&
      r.amount_value !== null &&
      amount.currency === r.amount_currency &&
      Math.abs(amount.value - r.amount_value) <= 0.1 * Math.max(amount.value, r.amount_value) &&
      (close || !Number.isFinite(when) || stage === ourStage)
    )
      return r;
  }
  return null;
}

const NOT_A_CUSTOMER: Record<string, string> = {
  partner_or_supplier: "a partner or supplier, not a customer",
  person: "a person, not a customer",
  other: "not a customer by the evidence",
  customer: "a customer",
  investor_or_backer: "a backer, not a customer",
};

const sameName = (a: string, b: string) => normalizeForQuote(a) === normalizeForQuote(b);

/** "S1", "s1 ", "Source 1" all name evidence S1. */
function evidenceId(id: string | null): string | null {
  if (!id) return null;
  const t = id.trim().toUpperCase();
  return /^SOURCE\s*\d+$/.test(t) ? `S${t.replace(/\D/g, "")}` : t;
}

interface ClaimCheck {
  verdict: z.infer<typeof Ruling>;
  source: string | null;
  quote: string | null;
  confidence: "high" | "low";
  reason: string;
}

/**
 * Apply the verdict to the dossier. Pure: the tests drive it with fixtures. A claim stays when the
 * model called it supported and its quote is found in the evidence it cites (or, after a recheck,
 * anywhere in the evidence); everything else goes, with the reason recorded. `rechecked` holds the
 * second pass's word on the claims the first kept on weak footing; a claim that needed one and did
 * not get a quoted yes is dropped.
 */
export function applyDossierVerdict(
  d: CompanyDossier,
  v: DossierVerdict,
  ctx: DossierContext,
  evidence: Map<string, { url: string | null; text: string }>,
  rechecked: Map<string, { verdict: string; source: string | null; quote: string | null }> = new Map(),
): {
  dossier: CompanyDossier;
  dropped: DroppedClaim[];
  citations: Record<string, string>;
  needsRecheck: string[];
  /** Customer claims the evidence recast as backers: a recheck asks about that relationship, not the customer one. */
  backerIds: string[];
  kept: number;
} {
  const dropped: DroppedClaim[] = [];
  const citations: Record<string, string> = {};
  const needsRecheck: string[] = [];
  let kept = 0;
  const allText = [...evidence.values()].map((e) => e.text).join("\n");

  /** keep, drop, or recheck one claim; returns whether it stays. */
  const judge = (id: string, field: string, item: string | null, check: ClaimCheck | undefined): boolean => {
    if (!check) {
      dropped.push({ field, item, reason: "not checked" });
      return false;
    }
    if (check.verdict !== "supported") {
      dropped.push({ field, item, reason: `${check.verdict}: ${check.reason}` });
      return false;
    }
    const second = rechecked.get(id);
    if (second) {
      if (second.verdict === "supported" && quoteFound(second.quote, allText)) {
        const url = evidence.get(evidenceId(second.source) ?? "")?.url;
        if (url) citations[id] = url;
        kept++;
        return true;
      }
      dropped.push({
        field,
        item,
        reason: `not confirmed on a second reading${second.verdict !== "supported" ? ` (${second.verdict})` : ""}`,
      });
      return false;
    }
    const cited = evidence.get(evidenceId(check.source) ?? "");
    if (check.confidence === "low" || !cited || !quoteFound(check.quote, cited.text)) {
      needsRecheck.push(id);
      return false;
    }
    if (cited.url) citations[id] = cited.url;
    kept++;
    return true;
  };

  const byIndex = <T extends { index: number }>(list: T[]) => new Map(list.map((c) => [c.index, c]));
  const latest = [...ctx.rounds].sort((a, b) => (b.announced_on ?? "").localeCompare(a.announced_on ?? ""))[0];

  const one_liner = d.one_liner && judge("one_liner", "one_liner", d.one_liner, v.one_liner) ? d.one_liner : "";
  const founded_year =
    d.founded_year !== null && judge("founded_year", "founded_year", String(d.founded_year), v.founded_year) ? d.founded_year : null;
  const headcount_estimate =
    d.headcount_estimate && judge("headcount_estimate", "headcount_estimate", d.headcount_estimate, v.headcount_estimate)
      ? d.headcount_estimate
      : null;
  const business_model =
    d.business_model && judge("business_model", "business_model", d.business_model, v.business_model) ? d.business_model : null;
  const why_it_matters =
    d.why_it_matters && judge("why_it_matters", "why_it_matters", d.why_it_matters, v.why_it_matters) ? d.why_it_matters : "";

  // Total raised: supported, and consistent with our rounds, or it goes.
  let total_raised_as_written: string | null = null;
  if (d.total_raised_as_written) {
    const t = d.total_raised_as_written;
    const below = totalBelowOurRound(t, ctx.rounds);
    const ourAmounts = ctx.rounds.some((r) => r.amount_as_written);
    if (below) dropped.push({ field: "total_raised_as_written", item: t, reason: `below our ${below.stage_as_written} round alone` });
    else if (v.total_raised.includes_our_latest_round === "no" && latest)
      dropped.push({ field: "total_raised_as_written", item: t, reason: `predates our ${latest.stage_as_written} round` });
    else if (v.total_raised.includes_our_latest_round === "unclear" && ourAmounts)
      dropped.push({ field: "total_raised_as_written", item: t, reason: "unclear whether it counts our latest round" });
    else if (judge("total_raised", "total_raised_as_written", t, v.total_raised)) total_raised_as_written = t;
  }

  const founderChecks = byIndex(v.founders);
  const founders = d.founders.flatMap((f, i) => {
    const c = founderChecks.get(i);
    if (c && c.verdict === "supported" && !c.is_founder) {
      dropped.push({ field: "founders", item: f.name, reason: "not a founder by the evidence" });
      return [];
    }
    if (!judge(`founders[${i}]`, "founders", f.name, c)) return [];
    return [{ name: f.name, role: c?.role_supported ? f.role : null, background: c?.background_supported ? f.background : null }];
  });

  const roundChecks = byIndex(v.prior_rounds);
  const prior_rounds = d.prior_rounds.flatMap((r, i) => {
    const c = roundChecks.get(i);
    const label = [r.stage_as_written, r.amount_as_written, r.announced_date].filter(Boolean).join(" ");
    const ours = duplicatesOurRound(r, ctx.rounds);
    if (ours || c?.same_as_our_round) {
      dropped.push({ field: "prior_rounds", item: label, reason: `our record has this round${ours ? ` (${ours.stage_as_written})` : ""}` });
      return [];
    }
    const stage = classifyStage(r.stage_as_written).stage;
    if ((c && !c.is_equity_round) || stage === "debt" || stage === "grant") {
      dropped.push({ field: "prior_rounds", item: label, reason: "not an equity round" });
      return [];
    }
    if (!judge(`prior_rounds[${i}]`, "prior_rounds", label, c)) {
      const last = dropped[dropped.length - 1];
      if (last?.field === "prior_rounds" && last.item === label && WANT_OF_EVIDENCE.test(last.reason)) last.prior = r;
      return [];
    }
    return [
      {
        stage_as_written: r.stage_as_written,
        amount_as_written: c?.amount_supported ? r.amount_as_written : null,
        announced_date: c?.date_supported ? r.announced_date : null,
        lead_investors: r.lead_investors.filter((n) => c?.leads_supported.some((s) => sameName(s, n))),
      },
    ];
  });

  const ourInvestors = ctx.rounds.flatMap((r) => [...r.lead_investors, ...r.other_investors]);
  const customerChecks = byIndex(v.customers);
  const customers: string[] = [];
  const movedBackers: string[] = [];
  const backerIds: string[] = [];
  d.customers.forEach((name, i) => {
    const id = `customers[${i}]`;
    const c = customerChecks.get(i);
    // Evidence that names another relationship settles "customer" whichever way the model voiced the
    // verdict (a weaker model calls a funder-as-customer "contradicted"). A backer moves to Backers on
    // the same quoted evidence; anything else goes.
    if (c && c.kind === "investor_or_backer" && c.verdict !== "unsupported") {
      backerIds.push(id);
      if (judge(id, "customers", name, { ...c, verdict: "supported" })) movedBackers.push(name);
      return;
    }
    if (c && c.kind !== "customer" && c.verdict !== "unsupported") {
      dropped.push({ field: "customers", item: name, reason: NOT_A_CUSTOMER[c.kind] });
      return;
    }
    if (judge(id, "customers", name, c)) customers.push(name);
  });

  const backerChecks = byIndex(v.investors_and_backers);
  const backers = d.investors_and_backers.filter((name, i) =>
    judge(`investors_and_backers[${i}]`, "investors_and_backers", name, backerChecks.get(i)),
  );
  // Backers our rounds already name are shown there; the dossier's list keeps the rest (accelerators, grants, earlier investors).
  const investors_and_backers = [...new Set([...backers, ...movedBackers])].filter((n) => !ourInvestors.some((o) => sameName(o, n)));

  const competitorChecks = byIndex(v.competitors);
  const competitors = d.competitors.filter((name, i) => judge(`competitors[${i}]`, "competitors", name, competitorChecks.get(i)));

  // The sources a reader sees are the pages that state what was kept.
  const sources = [...new Set(Object.values(citations))].filter((u) => /^https?:\/\//i.test(u));

  return {
    dossier: {
      one_liner,
      founded_year,
      founders,
      headcount_estimate,
      total_raised_as_written,
      prior_rounds,
      customers,
      investors_and_backers,
      competitors,
      business_model,
      why_it_matters,
      sources,
    },
    dropped,
    citations,
    needsRecheck,
    backerIds,
    kept,
  };
}

/** Distinguishing words a description needs before a one-liner's wording is held to it. */
const ONE_LINER_DESCRIPTION_WORDS = 4;

/**
 * Why the dossier's one-liner may not stand as the company's description, or null when it may. A
 * one-liner read from the company's own site, our record, or provider facts stands. One read from any
 * other page is held to the check a homepage gets: the page must name the company or carry its
 * domain, and the sentence must share the record's line of business. Silicon Mobility's dossier
 * researched SiliconFlow, an AI-inference company: its one-liner, "SiliconFlow provides developers and
 * enterprises with AI infrastructure", came from siliconflow.cn/about, a page that never says Silicon
 * Mobility, and it stood as the description of an EV semiconductor company. The line of business is
 * compared only against a description with ONE_LINER_DESCRIPTION_WORDS words to compare: a one-liner
 * says what the company does in its own words, and against a short description ("a medical technology
 * company") it rarely shares one. Of the checked one-liners read off-site, about one in eight failed
 * against any description, nearly all of them the right company's; against four words or more, one in 25.
 */
export function oneLinerFault(
  oneLiner: string,
  citedUrl: string | undefined,
  pages: Array<Pick<EvidencePage, "url" | "title" | "markdown">>,
  ctx: Pick<DossierContext, "company" | "rounds">,
): string | null {
  const c = ctx.company;
  const page = citedUrl ? pages.find((p) => p.url === citedUrl) : undefined;
  if (!page || isCompanySite(page.url, c)) return null;
  const raw = `${page.title ?? ""} ${page.markdown}`;
  const name = normalizeForQuote(searchName(c.name, c.domain));
  const named = name.length > 0 && ` ${normalizeForQuote(visibleMarkdown(raw))} `.includes(` ${name} `);
  const domain = c.domain ? raw.toLowerCase().includes(c.domain.toLowerCase()) : false;
  if (!named && !domain) return `its page (${hostOf(page.url)}) names neither ${c.name} nor ${c.domain ?? "its domain"}`;
  const context = { company_name: c.name, headquarters: null, sector: null, headline: null };
  const described = { ...context, company_description: c.description, evidence: null };
  if (!c.description?.trim() || distinguishingWords(described).length < ONE_LINER_DESCRIPTION_WORDS) return null;
  // Our rounds' press sentence is a second statement of the business: it can vouch for the one-liner, never refuse it alone.
  const evidence = describingQuote(
    c.name,
    ctx.rounds.flatMap((r) => r.evidence),
  );
  const quoted = { ...context, company_description: null, evidence };
  const shares =
    sharesBusinessWords(oneLiner, described) ||
    (evidence !== null && businessWords(quoted).length > 0 && sharesBusinessWords(oneLiner, quoted));
  return shares ? null : "it does not share the record's line of business";
}

export type ReadDossierPages = (urls: string[]) => Promise<Array<{ url: string; title?: string; markdown: string }>>;
export type SearchDossier = (query: string, limit: number) => Promise<Array<{ url: string; title?: string; markdown: string }>>;

export interface VerifyDossierDeps {
  read: ReadDossierPages;
  search: SearchDossier;
  model: Pick<ReconcileModel, "label">;
  /** The structured calls; injected in tests, the AI SDK against the configured model otherwise. */
  generate: <T>(prompt: string, schema: z.ZodType<T>) => Promise<T>;
  /** Firecrawl credits for one page read and for one search with its results read. */
  credits?: { page: number; search: (results: number) => number };
}

/** The search query when the dossier's sources are thin: the name, quoted, with the domain or what the company does. */
export function dossierSearchQuery(company: DossierSubject): string {
  const hint = company.domain ?? company.description?.split(/\s+/).slice(0, 6).join(" ") ?? "";
  return `"${searchName(company.name, company.domain)}" ${hint}`.trim();
}

/**
 * Check a dossier against its evidence. Throws when no evidence could be read at all or the model
 * fails: the caller must not save anything then, and a durable caller retries.
 */
export async function verifyDossier(
  d: CompanyDossier,
  ctx: DossierContext,
  deps: VerifyDossierDeps,
  opts: { ourSourceUrls?: string[]; now?: Date } = {},
): Promise<DossierCheck> {
  const pageCredits = deps.credits?.page ?? 1;
  const searchCredits = deps.credits?.search ?? ((n: number) => 2 + n);
  const picked = rankDossierSources(d.sources, ctx.company);
  const ours = (opts.ourSourceUrls ?? []).filter((u) => !picked.includes(u)).slice(0, MAX_OUR_SOURCES);
  let credits = (picked.length + ours.length) * pageCredits;
  const read = await deps.read([...picked, ...ours]);
  const pages: EvidencePage[] = [];
  let s = 0;
  for (const url of [...picked, ...ours]) {
    const page = read.find((p) => p.url === url);
    if (!page?.markdown.trim()) continue;
    s++;
    const kind = ours.includes(url) ? "our_source" : isCompanySite(url, ctx.company) ? "company" : "press";
    // Link targets go before the cut: they are not what a quote copies, and on a page of linked names
    // (a founders profile) they spend a third of the characters the model reads.
    pages.push({ id: `S${s}`, url, kind, title: page.title, markdown: visibleMarkdown(page.markdown) });
  }
  let searched = false;
  const ownPages = pages.filter((p) => p.kind === "company").length;
  if (pages.length < THIN_EVIDENCE_PAGES || ownPages === 0) {
    searched = true;
    try {
      const results = await deps.search(dossierSearchQuery(ctx.company), DOSSIER_SEARCH_RESULTS);
      credits += searchCredits(results.length);
      let q = 0;
      for (const r of results) {
        if (!r.markdown.trim() || pages.some((p) => p.url === r.url)) continue;
        q++;
        pages.push({ id: `Q${q}`, url: r.url, kind: "search", title: r.title, markdown: visibleMarkdown(r.markdown).slice(0, 4000) });
      }
    } catch {
      // A failed search leaves the pages already read; the check runs on those.
    }
  }
  if (pages.length === 0) throw new Error("no evidence could be read");

  const evidence = new Map<string, { url: string | null; text: string }>([
    ["R", { url: null, text: recordEvidence(ctx) }],
    ...pages.map((p) => [p.id, { url: p.url, text: `${p.title ?? ""}\n${p.markdown.slice(0, DOSSIER_PAGE_CHARS)}` }] as const),
  ]);
  const facts = factsEvidence(ctx.facts);
  if (facts) evidence.set("A", { url: ctx.facts?.yc?.url ?? null, text: facts });

  const prompt = dossierVerifyPrompt(d, ctx, pages);
  const verdict = await deps.generate(prompt, DossierVerdict);
  const base: Omit<DossierVerification, "kept" | "dropped" | "citations" | "rechecked"> = {
    version: 1,
    checked_at: (opts.now ?? new Date()).toISOString(),
    model: deps.model.label,
    sources_checked: pages.map((p) => p.url),
    searched,
    credits,
  };

  if (verdict.identity.same_company !== "yes") {
    const reason = verdict.identity.same_company === "no" ? "different company" : "identity unclear";
    return {
      status: "rejected",
      reason,
      detail: verdict.identity.reason,
      verification: {
        ...base,
        kept: 0,
        dropped: [{ field: "identity", item: ctx.company.name, reason: verdict.identity.reason }],
        citations: {},
        rechecked: 0,
      },
    };
  }

  let applied = applyDossierVerdict(d, verdict, ctx, evidence);
  let rechecked = 0;
  if (applied.needsRecheck.length > 0) {
    const claims = dossierClaims(d)
      .filter((c) => applied.needsRecheck.includes(c.id))
      .map((c) =>
        applied.backerIds.includes(c.id)
          ? { ...c, text: `${c.text} (as an investor, accelerator, incubator, grant program, or public funder of the company)` }
          : c,
      );
    rechecked = claims.length;
    // The evidence block is the same; the recheck prompt quotes it after its own instructions.
    const evidenceBlock = prompt.slice(prompt.indexOf("Evidence:\n\n"));
    const second = await deps.generate(dossierRecheckPrompt(claims, ctx, evidenceBlock), DossierRecheck);
    const answers = new Map(second.claims.map((c) => [c.id, c]));
    // A claim the second pass skipped is not confirmed.
    for (const id of applied.needsRecheck) if (!answers.has(id)) answers.set(id, { id, verdict: "unsupported", source: null, quote: null });
    applied = applyDossierVerdict(d, verdict, ctx, evidence, answers);
  }
  const fault = applied.dossier.one_liner ? oneLinerFault(applied.dossier.one_liner, applied.citations.one_liner, pages, ctx) : null;
  if (fault) {
    // Only the description goes; the other claims stand or fall on their own evidence.
    const { one_liner: _, ...citations } = applied.citations;
    applied = {
      ...applied,
      dossier: {
        ...applied.dossier,
        one_liner: "",
        sources: [...new Set(Object.values(citations))].filter((u) => /^https?:\/\//i.test(u)),
      },
      citations,
      dropped: [...applied.dropped, { field: "one_liner", item: applied.dossier.one_liner, reason: fault }],
      kept: applied.kept - 1,
    };
  }
  return {
    status: "verified",
    dossier: applied.dossier,
    verification: { ...base, kept: applied.kept, dropped: applied.dropped, citations: applied.citations, rechecked },
  };
}

/** Firecrawl reads the pages: markdown, main content, a week-old cached copy when it has one. An unreadable page is left out. */
export function firecrawlDossierReader(client: Firecrawl, maxAge = 7 * DAY): ReadDossierPages {
  return async (urls) => {
    const out: Array<{ url: string; title?: string; markdown: string }> = [];
    await mapLimit(urls, 4, async (url) => {
      try {
        const doc = await client.scrape(url, { formats: ["markdown"], onlyMainContent: true, timeout: 45_000, maxAge });
        if (doc.markdown?.trim()) out.push({ url, title: doc.metadata?.title, markdown: doc.markdown });
      } catch {
        // Left out; the check runs on the pages that could be read.
      }
    });
    return out;
  };
}

/** One Firecrawl search with each result's main content read in the same call. */
export function firecrawlDossierSearch(client: Firecrawl): SearchDossier {
  return async (query, limit) => {
    const result = await client.search(query, {
      limit,
      sources: ["web"],
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
    });
    const out: Array<{ url: string; title?: string; markdown: string }> = [];
    for (const item of (result.web ?? []) as Array<SearchResultWeb | Document>) {
      const doc = item as Document;
      const url = "url" in item && typeof item.url === "string" ? item.url : doc.metadata?.sourceURL;
      if (!url || !doc.markdown) continue;
      out.push({ url, title: ("title" in item ? item.title : doc.metadata?.title) ?? undefined, markdown: doc.markdown });
    }
    return out;
  };
}

/** The structured call against a configured model at high reasoning effort: the AI SDK maps it for each provider. */
export function dossierGenerator(model: ReconcileModel, opts: { timeoutMs?: number } = {}): VerifyDossierDeps["generate"] {
  return async <T>(prompt: string, schema: z.ZodType<T>): Promise<T> => {
    const result = await generateText({
      model: model.model,
      output: Output.object({ schema }),
      prompt,
      maxRetries: 2,
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 5 * 60_000),
      reasoning: "high",
    });
    const output = await result.output;
    if (!output) throw new Error("the model returned no verdict");
    return output as T;
  };
}
