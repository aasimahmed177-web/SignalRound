// Alexandria: provider tools reached through scrape(). For a company whose domain the identity
// check already verified, the Y Combinator catalogue returns its founders, batch, and one-liner. The
// lookup is keyed on the verified domain: a YC search hit counts only when its website resolves to
// it, so a namesake never writes a fact. A provider whose terms the org has not accepted comes back
// as a typed outcome, not a crash, so the page can say what an admin must do.
// https://docs.firecrawl.dev/alexandria

import type { AlexandriaCall, Firecrawl } from "firecrawl";
import { registrableDomain } from "../records/normalize.ts";

export interface AlexandriaFounder {
  name: string;
  title: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
}

export interface AlexandriaEnrichment {
  company_key: string;
  /** The verified domain the lookup keyed on. */
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
}

export type AlexandriaOutcome =
  | { ok: true; records: unknown[]; credits: number }
  | { ok: false; kind: "terms_required"; url: string }
  | { ok: false; kind: "error"; message: string };

const TERMS_URL = /https:\/\/\S+/;

/**
 * One Alexandria execution. The terms gate fails the whole request before it runs, so the SDK
 * throws; a per-call failure (a bad option, a provider error) lands on the item instead and
 * costs nothing. `records` reads `data.records`, falling back to `data.data`.
 */
export async function alexandriaCall(client: Firecrawl, call: AlexandriaCall): Promise<AlexandriaOutcome> {
  try {
    const res = await client.scrape({ alexandria: call });
    const item = res.alexandria[0];
    if (!item) return { ok: false, kind: "error", message: "the call returned no result" };
    if (item.error) return { ok: false, kind: "error", message: item.error.message };
    const data = item.data as { records?: unknown[]; data?: unknown[] } | undefined;
    return {
      ok: true,
      records: data?.records ?? data?.data ?? [],
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

/** A failed call as an error fact; the terms gate names the page an admin must visit. */
function callError(outcome: Exclude<AlexandriaOutcome, { ok: true }>): { status: "error"; message: string } {
  return { status: "error", message: outcome.kind === "terms_required" ? `terms required: ${outcome.url}` : outcome.message };
}

/**
 * The full pass for one company: YC search by name, narrowed to the hit on its verified
 * domain, then that company's profile.
 */
export async function alexandriaEnrich(
  client: Firecrawl,
  company: { company_key: string; company_name: string; domain: string },
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

  return { company_key: company.company_key, domain: company.domain, credits, yc };
}
