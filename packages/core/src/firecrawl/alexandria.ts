// Alexandria: provider tools reached through scrape(). For a company whose domain the identity
// check already verified, the Y Combinator catalogue returns its founders, batch, and one-liner. The
// lookup is keyed on the verified domain: a YC search hit counts only when its website resolves to
// it, so a namesake never writes a fact. A provider whose terms the org has not accepted comes back
// as a typed outcome, not a crash, so the page can say what an admin must do.
// https://docs.firecrawl.dev/alexandria

import { z } from "zod";
import { registrableDomain } from "../records/normalize.ts";
import type { NativeWebClient } from "../web/client.ts";

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

interface CatalogueCall {
  provider: string;
  capability: string;
  options?: Record<string, unknown>;
}

const YcProfile = z.object({
  name: z.string(),
  slug: z.string(),
  website: z.string().nullable(),
  batch_name: z.string().nullable(),
  year_founded: z.number().nullable(),
  team_size: z.number().nullable(),
  location: z.string().nullable(),
  one_liner: z.string().nullable(),
  tags: z.array(z.string()),
  ycdc_status: z.string().nullable(),
  founders: z.array(
    z.object({ name: z.string(), title: z.string().nullable(), linkedin_url: z.string().nullable(), twitter_url: z.string().nullable() }),
  ),
});

/**
 * One Alexandria execution. The terms gate fails the whole request before it runs, so the SDK
 * throws; a per-call failure (a bad option, a provider error) lands on the item instead and
 * costs nothing. `records` reads `data.records`, falling back to `data.data`.
 */
export async function alexandriaCall(client: NativeWebClient, call: CatalogueCall): Promise<AlexandriaOutcome> {
  try {
    if (call.provider !== "ycombinator-com") throw new Error("Only the public YC directory is supported by native catalogue research.");
    let urls: string[] = [];
    if (call.capability === "companies/company") {
      const slug = String(call.options?.slug ?? "");
      if (!/^[a-z0-9-]+$/i.test(slug)) throw new Error("Invalid YC company slug");
      urls = [`https://www.ycombinator.com/companies/${slug}`];
    } else if (call.capability === "companies/search") {
      const result = await client.search(`site:ycombinator.com/companies ${String(call.options?.query ?? "")}`, { limit: 4 });
      urls = (result.web ?? []).flatMap((hit) => {
        const url = hit.url;
        return typeof url === "string" && /^https:\/\/(?:www\.)?ycombinator\.com\/companies\/[a-z0-9-]+\/?$/i.test(url) ? [url] : [];
      });
    } else throw new Error("Unsupported native catalogue capability");
    const records: unknown[] = [];
    for (const url of [...new Set(urls)].slice(0, 4)) {
      const doc = await client.scrape(url, {
        formats: [
          {
            type: "json",
            schema: z.toJSONSchema(YcProfile),
            prompt:
              "Read this YC company profile. Use only facts on this page. Null for missing values. Do not infer founders or websites.",
          },
        ],
      });
      const parsed = YcProfile.safeParse(doc.json);
      if (parsed.success) records.push({ ...parsed.data, url });
    }
    return { ok: true, records, credits: 0 };
  } catch (e) {
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
  client: NativeWebClient,
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
