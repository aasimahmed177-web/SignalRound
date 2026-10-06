// Alexandria: provider tools reached through scrape(). For a company whose domain the
// identity check already verified, the Y Combinator catalogue returns its founders, batch,
// and one-liner; FullEnrich returns firmographics keyed on the same domain; Apollo, ten
// domains a call, returns its own firmographics and a list of funding events. Every lookup is
// keyed on the verified domain: a YC search hit counts only when its website resolves to it,
// and an Apollo record only when its domain and its name are both this company's, so a
// namesake never writes a fact. A provider whose terms the org has not accepted comes
// back as a typed outcome, not a crash, so the page can say what an admin must do.
// https://docs.firecrawl.dev/alexandria

import type { AlexandriaCall, Firecrawl } from "firecrawl";
import { namesCompany, normalizeCompanyKey, registrableDomain } from "../records/normalize.ts";

export interface AlexandriaFounder {
  name: string;
  title: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
}

export interface AlexandriaEnrichment {
  company_key: string;
  /** The verified domain every lookup keyed on. */
  domain: string;
  /** Sum of creditsCost across the calls this enrichment made. */
  credits: number;
  yc:
    | {
        status: "matched";
        slug: string;
        url: string;
        batch: string | null;
        year_founded: number | null;
        team_size: number | null;
        location: string | null;
        one_liner: string | null;
        tags: string[];
        yc_status: string | null;
        founders: AlexandriaFounder[];
      }
    | { status: "none" }
    | { status: "error"; message: string };
  firmographics:
    | {
        status: "matched";
        provider: "fullenrich";
        description: string | null;
        year_founded: number | null;
        headcount: number | null;
        headcount_range: string | null;
        company_type: string | null;
        specialties: string[];
        logo_url: string | null;
        industry: string | null;
        hq: string | null;
        linkedin_url: string | null;
        raw: unknown;
      }
    | { status: "none" }
    | { status: "terms_required"; url: string }
    | { status: "error"; message: string }
    | { status: "off" };
}

export type AlexandriaOutcome =
  | { ok: true; records: unknown[]; credits: number }
  | { ok: false; kind: "terms_required"; url: string }
  | { ok: false; kind: "error"; message: string };

const TERMS_URL = /https:\/\/\S+/;

/**
 * One Alexandria execution. The terms gate fails the whole request before it runs, so the SDK
 * throws; a per-call failure (a bad option, a provider error) lands on the item instead and
 * costs nothing. `records` reads `data.records` and falls back to `data.companies`, the key
 * FullEnrich's lookup returns, then `data.organizations`, Apollo's (one entry per domain asked,
 * null for a miss).
 */
export async function alexandriaCall(client: Firecrawl, call: AlexandriaCall): Promise<AlexandriaOutcome> {
  try {
    const res = await client.scrape({ alexandria: call });
    const item = res.alexandria[0];
    if (!item) return { ok: false, kind: "error", message: "the call returned no result" };
    if (item.error) return { ok: false, kind: "error", message: item.error.message };
    const data = item.data as { records?: unknown[]; companies?: unknown[]; organizations?: unknown[]; data?: unknown[] } | undefined;
    return {
      ok: true,
      records: data?.records ?? data?.companies ?? data?.organizations ?? data?.data ?? [],
      credits: item.creditsCost ?? res.creditsCost ?? 0,
    };
  } catch (e) {
    // Read the error's shape rather than instanceof SdkError: two copies of the SDK in one
    // process (root and workspace package) fail instanceof, and a value import would pull
    // the SDK's axios chain into the workflow bundle, which has no `require`.
    const err = e as { code?: string; message?: string; requiresAction?: { type?: string; url?: string } } | null;
    const action = err?.requiresAction;
    if (action?.type === "accept_terms" || err?.code === "THIRD_PARTY_DATA_TERMS_REQUIRED") {
      return { ok: false, kind: "terms_required", url: action?.url ?? String(err?.message ?? "").match(TERMS_URL)?.[0] ?? "" };
    }
    return { ok: false, kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

interface YcSearchHit {
  name?: string;
  slug?: string;
  website?: string;
  url?: string;
  batch?: string;
  one_liner?: string;
  team_size?: number;
  stage?: string;
  status?: string;
  tags?: string[];
}

interface YcCompanyRecord {
  slug?: string;
  batch_name?: string;
  year_founded?: number;
  team_size?: number;
  location?: string;
  one_liner?: string;
  tags?: string[];
  website?: string;
  ycdc_status?: string;
  founders?: Array<{
    name?: string;
    title?: string | null;
    bio?: string;
    linkedin_url?: string | null;
    twitter_url?: string | null;
    active?: boolean;
  }>;
}

interface FirmographicsRecord {
  name?: string;
  description?: string | null;
  year_founded?: number | null;
  headcount?: number | null;
  headcount_range?: string | null;
  company_type?: string | null;
  specialties?: string[];
  logo_url?: string | null;
  industry?: { main_industry?: string | null } | null;
  locations?: {
    headquarters?: {
      city?: string | null;
      region?: string | null;
      country?: string | null;
    } | null;
  } | null;
  social_profiles?: {
    professional_network?: { url?: string | null } | null;
  } | null;
}

/**
 * The search hit that is this company: its website must resolve to the verified domain. A
 * same-name hit on another domain is a namesake and yields nothing.
 */
export function pickYcHit(records: unknown[], domain: string): YcSearchHit | null {
  for (const r of records) {
    const hit = r as YcSearchHit;
    if (typeof hit.website === "string" && registrableDomain(hit.website) === domain) return hit;
  }
  return null;
}

/** The matched YC shape: the company record fills what the search hit saw first, founders minus bios. */
export function ycFromRecord(
  hit: YcSearchHit,
  company: YcCompanyRecord | null,
): Extract<AlexandriaEnrichment["yc"], { status: "matched" }> {
  const slug = company?.slug ?? hit.slug ?? "";
  return {
    status: "matched",
    slug,
    url: hit.url ?? `https://www.ycombinator.com/companies/${slug}`,
    batch: company?.batch_name ?? hit.batch ?? null,
    year_founded: positiveOrNull(company?.year_founded),
    team_size: positiveOrNull(company?.team_size ?? hit.team_size),
    location: company?.location ?? null,
    one_liner: company?.one_liner ?? hit.one_liner ?? null,
    tags: company?.tags ?? hit.tags ?? [],
    yc_status: company?.ycdc_status ?? hit.status ?? null,
    founders: (company?.founders ?? [])
      .filter((f) => f.active !== false && typeof f.name === "string")
      .map((f) => ({
        name: f.name as string,
        title: f.title ?? null,
        linkedin_url: f.linkedin_url ?? null,
        twitter_url: f.twitter_url ?? null,
      })),
  };
}

/** A provider writes 0 for a year or a headcount it does not know; a count below 1 is unknown. */
function positiveOrNull(n: number | null | undefined): number | null {
  return typeof n === "number" && n > 0 ? n : null;
}

/** The typed scalars a reader may see; the raw record stays for the fields not yet mapped. */
export function firmographicsFromRecord(record: unknown): Extract<AlexandriaEnrichment["firmographics"], { status: "matched" }> {
  const r = (record ?? {}) as FirmographicsRecord;
  const hqOf = r.locations?.headquarters;
  const hq = hqOf?.city
    ? [hqOf.city, hqOf.region && hqOf.region !== hqOf.city ? hqOf.region : hqOf.country].filter(Boolean).join(", ")
    : null;
  return {
    status: "matched",
    provider: "fullenrich",
    description: r.description ?? null,
    year_founded: positiveOrNull(r.year_founded),
    headcount: positiveOrNull(r.headcount),
    headcount_range: r.headcount_range ?? null,
    company_type: r.company_type ?? null,
    specialties: r.specialties ?? [],
    logo_url: r.logo_url ?? null,
    industry: r.industry?.main_industry ?? null,
    hq,
    linkedin_url: r.social_profiles?.professional_network?.url ?? null,
    raw: record,
  };
}

/** A failed call as an error fact; the terms gate names the page an admin must visit. */
function callError(outcome: Exclude<AlexandriaOutcome, { ok: true }>): { status: "error"; message: string } {
  return { status: "error", message: outcome.kind === "terms_required" ? `terms required: ${outcome.url}` : outcome.message };
}

/**
 * The FullEnrich lookup alone, keyed on the verified domain: shared by the full pass and by
 * the refresh that fills rows written while the provider's terms were unaccepted.
 */
export async function alexandriaFirmographics(
  client: Firecrawl,
  domain: string,
): Promise<{ firmographics: AlexandriaEnrichment["firmographics"]; credits: number }> {
  const lookup = await alexandriaCall(client, {
    provider: "fullenrich",
    capability: "companies/lookup",
    options: { domain },
  });
  const firmographics: AlexandriaEnrichment["firmographics"] = !lookup.ok
    ? lookup.kind === "terms_required"
      ? { status: "terms_required", url: lookup.url }
      : { status: "error", message: lookup.message }
    : lookup.records.length > 0
      ? firmographicsFromRecord(lookup.records[0])
      : { status: "none" };
  return { firmographics, credits: lookup.ok ? lookup.credits : 0 };
}

/**
 * The full pass for one company: YC search by name, narrowed to the hit on its verified
 * domain, then that company's profile; FullEnrich keyed on the domain when the plan asks.
 */
export async function alexandriaEnrich(
  client: Firecrawl,
  company: { company_key: string; company_name: string; domain: string },
  opts: { firmographics: boolean },
): Promise<AlexandriaEnrichment> {
  let credits = 0;
  let yc: AlexandriaEnrichment["yc"] = { status: "none" };

  const search = await alexandriaCall(client, {
    provider: "ycombinator-com",
    capability: "companies/search",
    options: { query: company.company_name },
  });
  credits += search.ok ? search.credits : 0;
  if (!search.ok) {
    yc = callError(search);
  } else {
    const hit = pickYcHit(search.records, company.domain);
    if (hit?.slug) {
      const detail = await alexandriaCall(client, {
        provider: "ycombinator-com",
        capability: "companies/company",
        options: { slug: hit.slug },
      });
      credits += detail.ok ? detail.credits : 0;
      yc = detail.ok ? ycFromRecord(hit, (detail.records[0] as YcCompanyRecord) ?? null) : callError(detail);
    }
  }

  let firmographics: AlexandriaEnrichment["firmographics"] = { status: "off" };
  if (opts.firmographics) {
    const r = await alexandriaFirmographics(client, company.domain);
    firmographics = r.firmographics;
    credits += r.credits;
  }

  return { company_key: company.company_key, domain: company.domain, credits, yc, firmographics };
}

// Apollo. One bulk call reads up to ten verified domains and bills per matched company; a miss is
// free. What is kept is trimmed to the fields a page or a lead can use: never the technologies (it
// listed an LMS and a bug tracker for Firecrawl), never the keywords, never anything about people.

/** Apollo's bulk lookup takes at most this many domains a call. */
export const APOLLO_BATCH = 10;
/** The stored shape's version, on the enrichment row: a later reader knows which fields to expect. */
export const APOLLO_SCHEMA_VERSION = 1;

/** One funding event as Apollo lists it: a lead for the history lane, never a fact on a page. */
export interface ApolloFundingEvent {
  /** YYYY-MM: Apollo dates an event to the first of a month, and the month itself can be weeks off. */
  date: string | null;
  type: string;
  /** "$35M", "€300K": the figure as Apollo writes it, with its currency symbol. */
  amount: string | null;
  /** The news link Apollo cites for the event, a page the promotion may read first. */
  source_url: string | null;
}

export type ApolloResult =
  | {
      status: "matched";
      apollo_id: string | null;
      name: string;
      domain: string;
      /** A company page on LinkedIn whose slug plausibly names this company, else null. */
      linkedin_url: string | null;
      hq: string | null;
      country: string | null;
      headcount: number | null;
      founded_year: number | null;
      logo_url: string | null;
      total_funding_usd: number | null;
      funding_events: ApolloFundingEvent[];
    }
  | { status: "none" }
  /** Apollo matched the domain to another company (another name, or another domain): nothing is kept but what it said. */
  | { status: "namesake"; name: string | null; domain: string | null }
  | { status: "error"; message: string };

export interface ApolloEnrichment {
  schema_version: number;
  company_key: string;
  /** The verified domain the lookup keyed on. */
  domain: string;
  /** This company's share of its batch's credits: a matched record's price, nothing for a miss. */
  credits: number;
  apollo: ApolloResult;
}

interface ApolloOrganization {
  id?: string | null;
  name?: string | null;
  primary_domain?: string | null;
  website_url?: string | null;
  linkedin_url?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  estimated_num_employees?: number | null;
  founded_year?: number | null;
  logo_url?: string | null;
  total_funding?: number | null;
  funding_events?: Array<{
    date?: string | null;
    type?: string | null;
    amount?: string | number | null;
    currency?: string | null;
    news_url?: string | null;
  }> | null;
}

/** A name with its spaces gone, for "CarbonSix" against "Carbon Six". */
function compactKey(name: string): string {
  return normalizeCompanyKey(name).replace(/\s+/g, "");
}

/**
 * Whether Apollo's name is this company's: every word of one inside the other after the legal and
 * generic tails come off ("Vals AI" and "Vals", "DIALYBRID" and "Dialybrid S.r.l."), or the same
 * letters once spaces go. The domain alone is not enough: Apollo filed cognition.com under a
 * four-person "CoDev Labs".
 */
export function apolloNameMatches(apolloName: string | null | undefined, name: string): boolean {
  if (!apolloName) return false;
  if (namesCompany(apolloName, name, { share: 1 }) || namesCompany(name, apolloName, { share: 1 })) return true;
  const a = compactKey(apolloName);
  return a.length >= 3 && a === compactKey(name);
}

/**
 * A LinkedIn company page as https://www.linkedin.com/company/<slug>, or null: the host must be
 * LinkedIn's, the path a company page, and the slug must plausibly name the company (it contains the
 * name or the domain's label, "grow-with-clay" for Clay, "tryprofound" for tryprofound.com, or the
 * name contains it). A people page or another company's slug is refused.
 */
export function validLinkedinCompanyUrl(url: string | null | undefined, company: { name: string; domain: string }): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
  if (!/^([a-z]{2,3}\.)?linkedin\.com$/i.test(parsed.hostname.replace(/^www\./i, ""))) return null;
  const m = /^\/company\/([^/?#]+)\/?$/i.exec(parsed.pathname);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return null;
  }
  const slugKey = slug.replace(/[^a-z0-9]/g, "");
  const nameKey = compactKey(company.name);
  const label = compactKey(company.domain.split(".")[0] ?? "");
  const plausible =
    (nameKey.length >= 2 && slugKey.includes(nameKey)) ||
    (label.length >= 3 && slugKey.includes(label)) ||
    (slugKey.length >= 4 && nameKey.includes(slugKey));
  return plausible ? `https://www.linkedin.com/company/${m[1]}` : null;
}

/** "2026-05-01T00:00:00.000+00:00" as 2026-05; Apollo's day is always the first, so only the month is kept. */
function apolloMonth(date: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(date ?? "");
  return m ? `${m[1]}-${m[2]}` : null;
}

/** Headquarters as city with its region (or its country), the way FullEnrich's is written. */
function apolloHq(o: ApolloOrganization): string | null {
  if (!o.city) return null;
  const region = o.state && o.state !== o.city ? o.state : o.country;
  return [o.city, region].filter(Boolean).join(", ");
}

/**
 * One Apollo record for one company, trimmed: matched only when its domain resolves to the verified
 * domain and its name is the company's; otherwise a namesake that keeps nothing but what it claimed.
 */
export function apolloFromRecord(record: unknown, company: { name: string; domain: string }): ApolloResult {
  if (!record) return { status: "none" };
  const o = record as ApolloOrganization;
  const domain = registrableDomain(o.primary_domain ?? o.website_url ?? null);
  if (domain !== company.domain || !apolloNameMatches(o.name, company.name)) {
    return { status: "namesake", name: o.name ?? null, domain };
  }
  const events: ApolloFundingEvent[] = [];
  for (const e of o.funding_events ?? []) {
    if (!e?.type) continue;
    const amount = e.amount === null || e.amount === undefined || e.amount === "" ? null : `${e.currency ?? ""}${e.amount}`;
    events.push({ date: apolloMonth(e.date), type: e.type, amount, source_url: e.news_url ?? null });
  }
  return {
    status: "matched",
    apollo_id: o.id ?? null,
    name: o.name ?? company.name,
    domain,
    linkedin_url: validLinkedinCompanyUrl(o.linkedin_url, company),
    hq: apolloHq(o),
    country: o.country ?? null,
    headcount: positiveOrNull(o.estimated_num_employees),
    founded_year: positiveOrNull(o.founded_year),
    logo_url: o.logo_url ?? null,
    total_funding_usd: positiveOrNull(o.total_funding),
    funding_events: events,
  };
}

/** Split a list into runs of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Apollo for many companies, APOLLO_BATCH domains a call. The answer lists one entry per domain in
 * the order asked (null for a miss); when its length differs, an entry is placed by its own domain
 * instead. A call that fails marks its companies error, so the next pass asks again; a batch's
 * credits are shared among the entries Apollo matched, which is what it bills.
 */
export async function apolloBulk(
  client: Firecrawl,
  companies: Array<{ company_key: string; company_name: string; domain: string }>,
): Promise<ApolloEnrichment[]> {
  const out: ApolloEnrichment[] = [];
  for (const batch of chunk(companies, APOLLO_BATCH)) {
    const call = await alexandriaCall(client, {
      provider: "apollo",
      capability: "companies/bulk-enrich",
      options: { "domains[]": batch.map((c) => c.domain) },
    });
    if (!call.ok) {
      const apollo = callError(call);
      for (const c of batch)
        out.push({ schema_version: APOLLO_SCHEMA_VERSION, company_key: c.company_key, domain: c.domain, credits: 0, apollo });
      continue;
    }
    const positional = call.records.length === batch.length;
    const byDomain = new Map<string, unknown>();
    for (const r of call.records) {
      const d = r ? registrableDomain((r as ApolloOrganization).primary_domain ?? (r as ApolloOrganization).website_url ?? null) : null;
      if (d && !byDomain.has(d)) byDomain.set(d, r);
    }
    const records = batch.map((c, i) => (positional ? call.records[i] : byDomain.get(c.domain)) ?? null);
    const billed = records.filter(Boolean).length;
    const share = billed > 0 ? call.credits / billed : 0;
    batch.forEach((c, i) => {
      out.push({
        schema_version: APOLLO_SCHEMA_VERSION,
        company_key: c.company_key,
        domain: c.domain,
        credits: records[i] ? share : 0,
        apollo: apolloFromRecord(records[i], { name: c.company_name, domain: c.domain }),
      });
    });
  }
  return out;
}
