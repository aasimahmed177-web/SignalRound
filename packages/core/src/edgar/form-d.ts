// Lane: SEC Form D. Every US private placement under Regulation D files a Form D within 15 days
// of the first sale, so the filings are the census the press covers a fraction of. No Firecrawl
// credits: EDGAR is a public JSON and XML API with two rules, a User-Agent that names the caller
// and at most 10 requests per second. https://www.sec.gov/os/accessing-edgar-data
//
// Search: the full-text index at efts.sec.gov, filtered to form D and a filing-date window.
// The query term is `LIVE`, the value of <testOrLive> in every real filing; "Form D" as words
// never appears in the indexed XML, so a search for it returns almost nothing.
// Filing: primary_doc.xml under the accession folder, read with a handful of tag lookups. The
// document is flat and fixed-schema, so a regex per tag is honest here; an XML parser would be
// a dependency for one document shape.
// Gate: most filings are not venture rounds. formDDisposition keeps an operating corporation,
// private, selling equity (not options or notes alone) outside a business combination, to more
// than one investor or for at least $5M; a data audit of ten kept filings (2026-09-04) found
// vehicles, a law firm, a listed biotech, an option grant, and single-investor SAFEs, and each
// rule here answers one of those.

import type { ExtractedItem } from "../records/resolve.ts";

export const EDGAR_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index";
export const EDGAR_ARCHIVES_URL = "https://www.sec.gov/Archives/edgar/data";
export const EDGAR_SUBMISSIONS_URL = "https://data.sec.gov/submissions";
export const EDGAR_DEFAULT_USER_AGENT = "fireround/0.1 (contact@example.com)";
/** EDGAR allows 10 requests per second; 8 leaves room for the clock skew of a shared runtime. */
export const EDGAR_REQUESTS_PER_SECOND = 8;
/** One search page. EDGAR caps `from` paging at 10,000 results, so a search reads at most this many pages. */
export const EDGAR_PAGE_SIZE = 100;
export const EDGAR_MAX_PAGES = 100;
/** Below this, a placement is a friends-and-family or bridge note, not a venture round. */
export const FORM_D_MIN_SOLD_USD = 1_000_000;
/** A sale to one investor below this is a SAFE, a strategic cheque, or a tranche, not a round; above it, one investor is still news. */
export const FORM_D_SINGLE_INVESTOR_MIN_USD = 5_000_000;
/** An amendment is news when the amount sold moved by at least this much, in dollars or as a share. */
export const FORM_D_MATERIAL_DELTA_USD = 1_000_000;
export const FORM_D_MATERIAL_DELTA_RATIO = 0.2;
/** Exemption items 3C and 3C.7 are Investment Company Act exclusions: the issuer is a fund. */
const POOLED_FUND_ITEMS = /^3C/i;

/** A filing-date span as ISO strings, the shape a workflow argument carries. */
export interface FormDSpan {
  start: string;
  end: string;
}

/** EDGAR is read a week of filings at a time: a step stays short enough for a serverless clock, and the seen ledger makes a retry cheap. */
export const FORM_D_CHUNK_DAYS = 7;

/**
 * A span cut into consecutive pieces of at most `days` filing days, oldest first, the last one
 * ending at the span's end. A span no longer than one piece is itself.
 */
export function formDSpanChunks(span: FormDSpan, days = FORM_D_CHUNK_DAYS): FormDSpan[] {
  const start = Date.parse(span.start);
  const end = Date.parse(span.end);
  if (!(end > start)) return [span];
  const step = days * 86_400_000;
  const out: FormDSpan[] = [];
  for (let from = start; from < end; from += step) {
    out.push({ start: new Date(from).toISOString(), end: new Date(Math.min(from + step, end)).toISOString() });
  }
  return out;
}

/** A filing dates its round by first sale, and Form D is due 15 days after; a month covers late filers. */
export const FORM_D_RESOLVE_DAYS = 30;

/**
 * The earliest announcement a Form D run keeps: 30 days before the span's first filing day, so a
 * backfill over July keeps July's sales, and a scheduled check (a span of the last two days)
 * keeps what it always kept.
 */
export function formDResolveStart(span: FormDSpan): Date {
  return new Date(Date.parse(span.start) - FORM_D_RESOLVE_DAYS * 86_400_000);
}

export type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

export interface EdgarOptions {
  fetch?: FetchLike;
  userAgent?: string;
  /** Requests per second across every EDGAR host; default 8. */
  requestsPerSecond?: number;
}

/** The env-configured caller identity, or the default with the placeholder contact. */
export function edgarUserAgent(env: Record<string, string | undefined> = process.env): string {
  const v = env.EDGAR_USER_AGENT?.trim();
  return v && v.length > 0 ? v : EDGAR_DEFAULT_USER_AGENT;
}

/** Spaces request starts so a burst of fetches stays under EDGAR's per-second limit. */
export class EdgarThrottle {
  private nextAt = 0;
  private readonly intervalMs: number;
  constructor(requestsPerSecond: number = EDGAR_REQUESTS_PER_SECOND) {
    this.intervalMs = Math.ceil(1000 / requestsPerSecond);
  }
  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.intervalMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

export class EdgarClient {
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly throttle: EdgarThrottle;
  /** Requests made, for the run's counts. */
  requests = 0;

  constructor(opts: EdgarOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.userAgent = opts.userAgent ?? edgarUserAgent();
    this.throttle = new EdgarThrottle(opts.requestsPerSecond);
  }

  async get(url: string): Promise<Response> {
    await this.throttle.wait();
    this.requests++;
    return this.fetchImpl(url, { headers: { "User-Agent": this.userAgent, Accept: "application/json, text/xml, */*" } });
  }

  async text(url: string): Promise<string> {
    const res = await this.get(url);
    if (!res.ok) throw new Error(`EDGAR ${res.status} for ${url}`);
    return res.text();
  }

  async json<T>(url: string): Promise<T> {
    return JSON.parse(await this.text(url)) as T;
  }
}

/** One search hit, reduced to what the lane reads. */
export interface FormDHit {
  /** Accession number with dashes, 0001706556-26-000003. */
  adsh: string;
  /** Ten-digit CIK with leading zeros. */
  cik: string;
  form: "D" | "D/A";
  /** YYYY-MM-DD. */
  fileDate: string;
  /** Exemption items, 06B, 3C, 3C.7. */
  items: string[];
  displayName: string;
  /** The exchange ticker EDGAR appends to a reporting company's name, "Gossamer Bio, Inc.  (GOSS)  (CIK ...)"; null for a private issuer. */
  ticker: string | null;
}

interface SearchResponse {
  hits: {
    total: { value: number };
    hits: Array<{
      _id: string;
      _source: {
        ciks: string[];
        display_names: string[];
        file_date: string;
        form: string;
        adsh: string;
        items?: string[];
      };
    }>;
  };
}

export function searchUrl(startdt: string, enddt: string, from = 0): string {
  const u = new URL(EDGAR_SEARCH_URL);
  u.searchParams.set("q", "LIVE");
  u.searchParams.set("forms", "D");
  u.searchParams.set("dateRange", "custom");
  u.searchParams.set("startdt", startdt);
  u.searchParams.set("enddt", enddt);
  if (from > 0) u.searchParams.set("from", String(from));
  return u.toString();
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Every Form D and D/A filed in [start, end] by filing date, 100 a request through the `from`
 * offset until the response's total is reached (or the last page is short). The client's
 * throttle spaces the requests like every other EDGAR call.
 */
export async function searchFormD(client: EdgarClient, start: Date, end: Date, maxPages = EDGAR_MAX_PAGES): Promise<FormDHit[]> {
  const out: FormDHit[] = [];
  const startdt = isoDay(start);
  const enddt = isoDay(end);
  let read = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await client.json<SearchResponse>(searchUrl(startdt, enddt, page * EDGAR_PAGE_SIZE));
    read += res.hits.hits.length;
    for (const h of res.hits.hits) {
      const s = h._source;
      if (s.form !== "D" && s.form !== "D/A") continue;
      if (!s.ciks?.[0] || !s.adsh) continue;
      const { name, ticker } = splitDisplayName(s.display_names?.[0] ?? "");
      out.push({
        adsh: s.adsh,
        cik: s.ciks[0].padStart(10, "0"),
        form: s.form,
        fileDate: s.file_date,
        items: s.items ?? [],
        displayName: name,
        ticker,
      });
    }
    if (read >= res.hits.total.value || res.hits.hits.length < EDGAR_PAGE_SIZE) break;
  }
  return out;
}

/**
 * A search hit's display name is the issuer, then the ticker when the issuer is a reporting
 * company, then the CIK, each set off by two spaces: "Gossamer Bio, Inc.  (GOSS)  (CIK 0001728117)".
 * The two-space separator is what tells the ticker from a parenthetical inside a name.
 */
export function splitDisplayName(display: string): { name: string; ticker: string | null } {
  const withoutCik = display.replace(/\s*\(CIK \d+\)\s*$/, "");
  const m = /\s{2,}\(([A-Z0-9][A-Z0-9.-]{0,9})\)\s*$/.exec(withoutCik);
  return m ? { name: withoutCik.slice(0, m.index).trim(), ticker: m[1] } : { name: withoutCik.trim(), ticker: null };
}

/** The filing's index page, the URL a reader opens: .../<adsh-no-dashes>/<adsh>-index.htm */
export function filingIndexUrl(hit: Pick<FormDHit, "cik" | "adsh">): string {
  return `${EDGAR_ARCHIVES_URL}/${Number(hit.cik)}/${hit.adsh.replace(/-/g, "")}/${hit.adsh}-index.htm`;
}

export function primaryDocUrl(hit: Pick<FormDHit, "cik" | "adsh">): string {
  return `${EDGAR_ARCHIVES_URL}/${Number(hit.cik)}/${hit.adsh.replace(/-/g, "")}/primary_doc.xml`;
}

export interface FormDPerson {
  name: string;
  relationships: string[];
}

export interface FormDFiling {
  issuer: string;
  /** Item 1's entity type as written: Corporation, Limited Liability Company, Limited Partnership, Business Trust, Other. */
  entityType: string | null;
  /** The free text beside entityType Other ("Professional Limited Liability Company"). */
  entityTypeOtherDesc: string | null;
  city: string | null;
  stateOrCountry: string | null;
  stateOrCountryDescription: string | null;
  industryGroup: string | null;
  totalOfferingAmount: number | null;
  /** True when the offering amount is written as Indefinite. */
  offeringIndefinite: boolean;
  totalAmountSold: number | null;
  /** YYYY-MM-DD, or null when the first sale is yet to occur. */
  dateOfFirstSale: string | null;
  isAmendment: boolean;
  /** Item 10: the offering finances a merger or acquisition. */
  isBusinessCombination: boolean;
  /** Security types checked on the form, lowercased: equity, debt, option, other. */
  securityTypes: string[];
  relatedPersons: FormDPerson[];
  /** Number of investors already in, when stated. */
  investorCount: number | null;
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  if (!m) return null;
  const v = decodeEntities(m[1]).trim();
  return v.length > 0 ? v : null;
}

function block(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : null;
}

function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function money(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v.replace(/[,$\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** The fields the lane reads from a primary_doc.xml. Missing tags are null, never a throw. */
export function parseFormD(xml: string): FormDFiling {
  const issuer = block(xml, "primaryIssuer") ?? "";
  const address = block(issuer, "issuerAddress") ?? "";
  const offering = block(xml, "offeringData") ?? "";
  const sales = block(offering, "offeringSalesAmounts") ?? "";
  const filingType = block(offering, "typeOfFiling") ?? "";
  const firstSale = block(filingType, "dateOfFirstSale") ?? "";
  const securities = block(offering, "typesOfSecuritiesOffered") ?? "";
  const totalOffering = tag(sales, "totalOfferingAmount");

  const securityTypes: string[] = [];
  if (tag(securities, "isEquityType") === "true") securityTypes.push("equity");
  if (tag(securities, "isDebtType") === "true") securityTypes.push("debt");
  if (tag(securities, "isOptionToAcquireType") === "true") securityTypes.push("options");
  if (tag(securities, "isSecurityToBeAcquiredType") === "true") securityTypes.push("securities to be acquired");
  if (tag(securities, "isPooledInvestmentFundType") === "true") securityTypes.push("pooled investment fund interests");
  if (tag(securities, "isOtherType") === "true") securityTypes.push(tag(securities, "descriptionOfOtherType")?.toLowerCase() ?? "other");

  const relatedPersons: FormDPerson[] = blocks(block(xml, "relatedPersonsList") ?? "", "relatedPersonInfo").map((p) => {
    const nameBlock = block(p, "relatedPersonName") ?? "";
    const name = [tag(nameBlock, "firstName"), tag(nameBlock, "middleName"), tag(nameBlock, "lastName")].filter(Boolean).join(" ");
    const relationships = blocks(block(p, "relatedPersonRelationshipList") ?? "", "relationship").map((r) => decodeEntities(r).trim());
    return { name, relationships };
  });

  const investors = block(offering, "investors") ?? "";
  const count = tag(investors, "totalNumberAlreadyInvested");

  return {
    issuer: tag(issuer, "entityName") ?? "",
    entityType: tag(issuer, "entityType"),
    entityTypeOtherDesc: tag(issuer, "entityTypeOtherDesc"),
    city: tag(address, "city"),
    stateOrCountry: tag(address, "stateOrCountry"),
    stateOrCountryDescription: tag(address, "stateOrCountryDescription"),
    industryGroup: tag(block(offering, "industryGroup") ?? "", "industryGroupType"),
    totalOfferingAmount: /indefinite/i.test(totalOffering ?? "") ? null : money(totalOffering),
    offeringIndefinite: /indefinite/i.test(totalOffering ?? ""),
    totalAmountSold: money(tag(sales, "totalAmountSold")),
    dateOfFirstSale: tag(firstSale, "yetToOccur") === "true" ? null : tag(firstSale, "value"),
    isAmendment: tag(block(filingType, "newOrAmendment") ?? "", "isAmendment") === "true",
    isBusinessCombination: tag(block(offering, "businessCombinationTransaction") ?? "", "isBusinessCombinationTransaction") === "true",
    securityTypes,
    relatedPersons,
    investorCount: count !== null && Number.isFinite(Number(count)) ? Number(count) : null,
  };
}

export type FormDSkip =
  | "pooled_fund"
  | "small_sale"
  | "no_amount"
  | "amendment_unchanged"
  | "amendment_no_predecessor"
  | "not_operating_company"
  | "vehicle_name"
  | "not_corporation"
  | "public_issuer"
  | "business_combination"
  | "options_or_warrants"
  | "debt_only"
  | "single_investor_small";

/** Every skip, in the order the counts are reported. */
export const FORM_D_SKIPS: readonly FormDSkip[] = [
  "pooled_fund",
  "small_sale",
  "no_amount",
  "amendment_unchanged",
  "amendment_no_predecessor",
  "not_operating_company",
  "vehicle_name",
  "not_corporation",
  "public_issuer",
  "business_combination",
  "options_or_warrants",
  "debt_only",
  "single_investor_small",
];

/**
 * Form D's own industry-group vocabulary, kept to the groups an operating startup files under.
 * Most Form D filings are real estate vehicles, funds, and lending entities, none of which is a
 * venture round; anything outside this list is not news for a funding feed.
 */
export const FORM_D_OPERATING_INDUSTRIES =
  /^(Technology|Other Technology|Computers|Telecommunications|Biotechnology|Health Care|Other Health Care|Pharmaceuticals|Business Services|Retailing|Restaurants|Manufacturing|Energy|Other Energy|Electric Utilities|Energy Conservation|Environmental Services|Agriculture|Travel|Airlines and Airports|Lodging and Conventions|Tourism and Travel Services|Other Travel|Health Insurance|Hospitals and Physicians|Other)$/i;

/** The words a street address ends in, as they appear in an issuer name ("1250 Main Street LLC", "Gratiot Ave, LLC"). */
const STREET_WORD = "(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|pkwy|parkway|hwy|highway)";

/**
 * Issuer names that describe a vehicle, a fund, a project, or a property rather than a company:
 * fund and vehicle words, a Roman-numeral series before the entity suffix, a street number followed
 * by a street word, or a name that ends in a street word.
 */
export const FORM_D_VEHICLE_NAME = new RegExp(
  [
    String.raw`\b(fund|funds|parent|bidco|topco|midco|holdco|finco|borrower|issuer|capital partners|opportunit(y|ies)|holdings?|acquisition|spv|co-?invest(ment)?s?|reit|trust|project|partners,? (lp|l\.p\.)|lp|l\.p\.|llp|investors|ventures? (i|ii|iii|iv|v|vi)\b|series [a-z0-9]+ of|portfolio|income|properties|realty|estates?|apartments|residences|land|lending|mortgage|credit|notes?)\b`,
    String.raw`\b(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b,? ?(lp|llc|l\.p\.)$`,
    String.raw`\b\d{1,5}\s+([a-z]+\.?\s+){1,3}${STREET_WORD}\b`,
    String.raw`\b${STREET_WORD}\.?,?\s*(llc|l\.l\.c\.|lp|l\.p\.|inc\.?)?\s*$`,
  ].join("|"),
  "i",
);

/** Security types that are debt or a note: a lender's paper, not a round. */
const DEBT_OR_NOTE = /\b(debt|notes?|promissory|debentures?|bonds?|loans?)\b/i;

/**
 * Whether the issuer is a corporation: Item 1's entity type is Corporation, or Other described as
 * one (a foreign form named a corporation). LLCs, LPs, trusts, and professional entities are
 * vehicles or practices, not venture-backed startups. A filing without the tag is not judged here.
 */
export function formDIsCorporation(filing: Pick<FormDFiling, "entityType" | "entityTypeOtherDesc">): boolean {
  if (filing.entityType === null) return true;
  if (/^corporation$/i.test(filing.entityType.trim())) return true;
  return /^other$/i.test(filing.entityType.trim()) && /\bcorp(oration)?\b/i.test(filing.entityTypeOtherDesc ?? "");
}

/** Whether an amendment's amount sold moved enough to be news against the filing it amends. */
export function materialChange(sold: number, previousSold: number | null): boolean {
  if (previousSold === null) return sold >= FORM_D_MIN_SOLD_USD;
  const delta = Math.abs(sold - previousSold);
  return delta >= FORM_D_MATERIAL_DELTA_USD || delta >= FORM_D_MATERIAL_DELTA_RATIO * Math.max(previousSold, 1);
}

/** What the lane knows about a filing beyond its own XML. */
export interface FormDContext {
  /** The amount sold on the filing this one amends; undefined means no predecessor was looked up, null means none exists. */
  previousSold?: number | null;
  /** The issuer is a reporting company (a ticker on the search hit, or tickers or a 10-K or 10-Q in its submissions). */
  publicIssuer?: boolean;
}

/**
 * The lane's filter on a parsed filing: a venture round is an operating corporation, private,
 * selling equity (not options or notes alone) to more than one investor or for more than $5M,
 * outside a business combination. The first failing rule names the skip.
 */
export function formDDisposition(filing: FormDFiling, context: FormDContext = {}): FormDSkip | null {
  if (/pooled investment fund/i.test(filing.industryGroup ?? "")) return "pooled_fund";
  if (filing.securityTypes.includes("pooled investment fund interests")) return "pooled_fund";
  if (filing.totalAmountSold === null) return "no_amount";
  if (filing.totalAmountSold < FORM_D_MIN_SOLD_USD) return "small_sale";
  if (filing.industryGroup && !FORM_D_OPERATING_INDUSTRIES.test(filing.industryGroup.trim())) return "not_operating_company";
  if (FORM_D_VEHICLE_NAME.test(filing.issuer)) return "vehicle_name";
  if (!formDIsCorporation(filing)) return "not_corporation";
  if (context.publicIssuer) return "public_issuer";
  if (filing.isBusinessCombination) return "business_combination";
  const equity = filing.securityTypes.includes("equity");
  if (!equity && filing.securityTypes.includes("options")) return "options_or_warrants";
  if (!equity && filing.securityTypes.length > 0 && filing.securityTypes.every((t) => DEBT_OR_NOTE.test(t))) return "debt_only";
  if (filing.investorCount === 1 && filing.totalAmountSold < FORM_D_SINGLE_INVESTOR_MIN_USD) return "single_investor_small";
  if (filing.isAmendment) {
    if (context.previousSold === undefined) return "amendment_no_predecessor";
    if (!materialChange(filing.totalAmountSold, context.previousSold)) return "amendment_unchanged";
  }
  return null;
}

/** True when the search hit alone says fund: exemption items 3C or 3C.7. Saves the XML fetch. */
export function hitIsPooledFund(hit: FormDHit): boolean {
  return hit.items.some((i) => POOLED_FUND_ITEMS.test(i));
}

/** True when the search hit alone says reporting company: EDGAR appends the ticker to a listed issuer's name. Saves the XML fetch. */
export function hitIsPublicIssuer(hit: Pick<FormDHit, "ticker">): boolean {
  return hit.ticker !== null;
}

const usd = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** "Southbury, CT" for a US state code; "London, United Kingdom" for EDGAR's letter-digit country codes. */
export function formDHeadquarters(filing: FormDFiling): string | null {
  const city = filing.city ? titleCase(filing.city) : null;
  const code = filing.stateOrCountry;
  const region =
    code && /^[A-Z]{2}$/.test(code) ? code : filing.stateOrCountryDescription ? titleCase(filing.stateOrCountryDescription) : null;
  return [city, region].filter(Boolean).join(", ") || null;
}

export function formDLabel(filing: FormDFiling): string {
  const types = filing.securityTypes.filter((t) => t !== "pooled investment fund interests");
  return types.length > 0 ? `Form D (${types.join(", ")})` : "Form D";
}

/** The sentence a reader sees as evidence, built from the filing's own fields; the amount appears as written. */
export function formDEvidence(filing: FormDFiling, hit: FormDHit, amountAsWritten: string): string {
  const what = filing.securityTypes.length > 0 ? `${filing.securityTypes.join(" and ")} securities` : "securities";
  const offering = filing.offeringIndefinite
    ? "in an offering of indefinite size"
    : filing.totalOfferingAmount !== null
      ? `of a $${usd.format(filing.totalOfferingAmount)} offering`
      : null;
  const sale = filing.dateOfFirstSale ? `first sale ${filing.dateOfFirstSale}` : "first sale yet to occur";
  const investors = filing.investorCount !== null ? `${filing.investorCount} investors` : null;
  const parenthetical = [sale, investors, filing.industryGroup].filter(Boolean).join("; ");
  const kind = hit.form === "D/A" ? "an amended Form D" : "a Form D";
  const parts = [
    `${filing.issuer} reported in ${kind} filed ${hit.fileDate} that it sold ${amountAsWritten} of ${what} under Regulation D`,
    offering,
    `(${parenthetical}).`,
  ];
  return parts.filter(Boolean).join(" ");
}

/** The source title a reader sees for a filing: "Form D: Acme Robotics, Inc.", "Form D/A: ..." for an amendment. */
export function formDTitle(filing: Pick<FormDFiling, "issuer">, hit: Pick<FormDHit, "form">): string {
  return `Form ${hit.form}: ${filing.issuer}`;
}

/**
 * A kept filing as the extraction item the resolver takes. The stage rule for "Form D" maps to
 * `other` (see classifyStage), so the lane's workflow passes stages that include it. A first sale
 * yet to occur is dated by the filing instead, so the record is never undated. The source carries
 * the filing's own title and date, so it never renders as a bare EDGAR URL.
 */
export function formDItem(filing: FormDFiling, hit: FormDHit): ExtractedItem {
  const url = filingIndexUrl(hit);
  const amountAsWritten = `$${usd.format(filing.totalAmountSold ?? 0)}`;
  const announced = filing.dateOfFirstSale ?? hit.fileDate;
  return {
    round: {
      company_name: filing.issuer,
      company_website: null,
      company_description: null,
      round_type_as_written: formDLabel(filing),
      amount_as_written: amountAsWritten,
      amount_kind: "round",
      valuation_as_written: null,
      lead_investors: [],
      // Form D relationships are Executive Officer, Director, and Promoter; the form has no investor role.
      other_investors: filing.relatedPersons.filter((p) => p.relationships.some((r) => /investor/i.test(r))).map((p) => p.name),
      announced_date: announced,
      headquarters: formDHeadquarters(filing),
      sector: null,
      evidence_quote: formDEvidence(filing, hit, amountAsWritten),
      source_url: url,
      is_background: false,
      is_rumor: false,
    },
    source: { url, host: "sec.gov", title: formDTitle(filing, hit), published: hit.fileDate, query: "formd" },
  };
}

interface Submissions {
  tickers?: string[];
  filings: { recent: { accessionNumber: string[]; form: string[]; filingDate: string[]; primaryDocument: string[] } };
}

/** A reporting company's periodic forms; one in the recent filings makes the issuer public whatever its ticker field says. */
const PERIODIC_REPORT = /^10-[KQ](\/A)?$/;

/** Whether the submissions index describes a reporting company: a ticker, or a 10-K or 10-Q among its recent filings. */
export function submissionsArePublic(subs: Pick<Submissions, "tickers"> & { filings: { recent: { form: string[] } } }): boolean {
  return (subs.tickers?.length ?? 0) > 0 || subs.filings.recent.form.some((f) => PERIODIC_REPORT.test(f));
}

/**
 * What an amendment is measured against: the amount sold on the Form D it supersedes (the issuer's
 * latest D or D/A filed before it), and whether the issuer is a reporting company. Both come from
 * the submissions index (one request), then the predecessor's primary document (one more).
 * `previousSold` is null when the issuer has no earlier Form D on file.
 */
export async function amendmentContext(client: EdgarClient, hit: FormDHit): Promise<Required<FormDContext>> {
  const subs = await client.json<Submissions>(`${EDGAR_SUBMISSIONS_URL}/CIK${hit.cik}.json`);
  const publicIssuer = submissionsArePublic(subs);
  const r = subs.filings.recent;
  let best: { adsh: string; date: string } | null = null;
  for (let i = 0; i < r.accessionNumber.length; i++) {
    if (r.form[i] !== "D" && r.form[i] !== "D/A") continue;
    const adsh = r.accessionNumber[i];
    if (adsh === hit.adsh) continue;
    const date = r.filingDate[i];
    if (date > hit.fileDate || (date === hit.fileDate && adsh > hit.adsh)) continue;
    if (!best || date > best.date || (date === best.date && adsh > best.adsh)) best = { adsh, date };
  }
  if (!best) return { previousSold: null, publicIssuer };
  const xml = await client.text(primaryDocUrl({ cik: hit.cik, adsh: best.adsh }));
  return { previousSold: parseFormD(xml).totalAmountSold, publicIssuer };
}

export interface FormDRunOptions extends EdgarOptions {
  /** Whether a filing (by index URL) was handled before. */
  seen: (url: string) => Promise<boolean> | boolean;
  /** Parallel filings in flight; the throttle still spaces the requests. Default 4. */
  concurrency?: number;
}

export interface FormDRunResult {
  hits: number;
  /** Hits not seen before, whose XML was read. */
  fetched: number;
  kept: number;
  skipped: Record<FormDSkip | "seen" | "error", number>;
  items: ExtractedItem[];
  /** Index URLs handled this run (kept or skipped after a read), to mark seen. */
  handled: string[];
  requests: number;
}

/** Search a filing-date window, read each unseen filing, and return the kept ones as extraction items. */
export async function runFormD(start: Date, end: Date, opts: FormDRunOptions): Promise<FormDRunResult> {
  const client = new EdgarClient(opts);
  const hits = await searchFormD(client, start, end);
  const skipped = { seen: 0, ...Object.fromEntries(FORM_D_SKIPS.map((k) => [k, 0])), error: 0 } as FormDRunResult["skipped"];
  const items: ExtractedItem[] = [];
  const handled: string[] = [];
  let fetched = 0;

  const work = async (hit: FormDHit) => {
    const url = filingIndexUrl(hit);
    if (await opts.seen(url)) {
      skipped.seen++;
      return;
    }
    if (hitIsPooledFund(hit)) {
      skipped.pooled_fund++;
      handled.push(url);
      return;
    }
    if (hitIsPublicIssuer(hit)) {
      skipped.public_issuer++;
      handled.push(url);
      return;
    }
    try {
      fetched++;
      const filing = parseFormD(await client.text(primaryDocUrl(hit)));
      // The public-issuer check costs nothing on a new filing (the ticker is on the hit) and nothing
      // extra on an amendment: the submissions index read for the predecessor carries the answer.
      let context: FormDContext = {};
      if (filing.isAmendment && filing.totalAmountSold !== null && filing.totalAmountSold >= FORM_D_MIN_SOLD_USD) {
        context = await amendmentContext(client, hit);
      }
      const skip = formDDisposition(filing, context);
      handled.push(url);
      if (skip) {
        skipped[skip]++;
        return;
      }
      items.push(formDItem(filing, hit));
    } catch {
      // Left unhandled so the next check reads it again.
      skipped.error++;
    }
  };

  const concurrency = opts.concurrency ?? 4;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, hits.length) }, async () => {
      while (next < hits.length) await work(hits[next++]);
    }),
  );

  return { hits: hits.length, fetched, kept: items.length, skipped, items, handled, requests: client.requests };
}
