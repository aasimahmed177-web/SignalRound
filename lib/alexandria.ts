// Alexandria enrichment for companies whose domain the identity check already verified: the
// YC catalogue by name narrowed to the domain, then FullEnrich by domain on rungs that buy
// firmographics. The row stores both providers' answers with their provenance; the only
// writes onto companies itself fill fields that are still empty.

import type { AlexandriaEnrichment } from "@fireround/core";
import { alexandriaEnrich, alexandriaFirmographics } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";

export type { AlexandriaFact, AlexandriaFactsInput } from "./alexandria-facts.ts";
export { alexandriaFacts, companyLinkedin, fullEnrichFoundedYear, ycBatchShort, ycFoundedYear } from "./alexandria-facts.ts";

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";

const { companies, enrichments, fundingRounds } = schema;

export interface AlexandriaCompany {
  id: string;
  name: string;
  domain: string;
}

/**
 * Companies with a verified domain, a live round in this preset, and no alexandria row yet:
 * the ones the enrich batch just resolved plus the backlog the sweep picks up gradually.
 */
export async function pendingAlexandria(handle: Db, presetSlug: string | null, limit: number): Promise<AlexandriaCompany[]> {
  const rows = await handle
    .selectDistinct({ id: companies.id, name: companies.name, domain: companies.domain })
    .from(companies)
    .innerJoin(fundingRounds, eq(fundingRounds.companyId, companies.id))
    .leftJoin(enrichments, and(eq(enrichments.companyId, companies.id), eq(enrichments.kind, "alexandria")))
    .where(
      and(
        isNotNull(companies.domain),
        ...(presetSlug ? [eq(fundingRounds.presetSlug, presetSlug)] : []),
        inArray(fundingRounds.disposition, ["publish", "flagged"]),
        isNull(enrichments.companyId),
      ),
    )
    .limit(limit);
  return rows.filter((r): r is AlexandriaCompany => r.domain !== null);
}

export interface AlexandriaBatchResult {
  companies: number;
  matched: number;
  credits: number;
}

/**
 * One batch: an enrichment row per company (even a no-match, so it is not retried on every
 * sweep), plus the safe fills: description, logo, and hq only where the row has none.
 */
export async function alexandriaBatch(
  handle: Db,
  client: Firecrawl,
  batch: AlexandriaCompany[],
  opts: { firmographics: boolean },
): Promise<AlexandriaBatchResult> {
  let matched = 0;
  let credits = 0;
  for (const c of batch) {
    const e = await alexandriaEnrich(client, { company_key: c.id, company_name: c.name, domain: c.domain }, opts);
    credits += e.credits;
    if (e.yc.status === "matched") matched++;
    const sourceUrl = e.yc.status === "matched" ? e.yc.url : null;
    await handle
      .insert(enrichments)
      .values({ companyId: c.id, kind: "alexandria", data: e, sourceUrl })
      .onConflictDoUpdate({
        target: [enrichments.companyId, enrichments.kind],
        set: { data: e, sourceUrl, fetchedAt: new Date() },
      });
    // Facts with provenance fill what is empty; they never overwrite what the record stated.
    await handle
      .update(companies)
      .set({
        description: sql`coalesce(${companies.description}, ${e.yc.status === "matched" ? e.yc.one_liner : null})`,
        logoUrl: sql`coalesce(${companies.logoUrl}, ${e.firmographics.status === "matched" ? e.firmographics.logo_url : null})`,
        hq: sql`coalesce(${companies.hq}, ${e.yc.status === "matched" ? e.yc.location : null}, ${e.firmographics.status === "matched" ? e.firmographics.hq : null})`,
        updatedAt: new Date(),
      })
      .where(eq(companies.id, c.id));
  }
  return { companies: batch.length, matched, credits };
}

/**
 * Rows whose firmographics never ran (terms unaccepted at the time, or the plan had it off)
 * get the FullEnrich lookup alone: the YC search is paid for already and does not re-run. The
 * row keeps its yc half; credits add to what the row already spent.
 */
export async function refreshFirmographics(
  handle: Db,
  client: Firecrawl,
  opts: { limit: number; maxCredits?: number; delayMs?: number },
): Promise<{ companies: number; matched: number; credits: number }> {
  const rows = await handle
    .select({ companyId: enrichments.companyId, domain: companies.domain, data: enrichments.data })
    .from(enrichments)
    .innerJoin(companies, eq(companies.id, enrichments.companyId))
    .where(
      and(eq(enrichments.kind, "alexandria"), sql`${enrichments.data}->'firmographics'->>'status' in ('terms_required', 'off', 'error')`),
    )
    .limit(opts.limit);
  let matched = 0;
  let credits = 0;
  let processed = 0;
  for (const r of rows) {
    if (!r.domain) continue;
    if (opts.maxCredits && credits >= opts.maxCredits) break;
    if (opts.delayMs && processed > 0) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    const e = r.data as AlexandriaEnrichment;
    const { firmographics, credits: c } = await alexandriaFirmographics(client, r.domain);
    credits += c;
    if (firmographics.status === "matched") matched++;
    const data: AlexandriaEnrichment = { ...e, credits: e.credits + c, firmographics };
    await handle
      .update(enrichments)
      .set({ data, fetchedAt: new Date() })
      .where(and(eq(enrichments.companyId, r.companyId), eq(enrichments.kind, "alexandria")));
    if (firmographics.status === "matched") {
      await handle
        .update(companies)
        .set({
          logoUrl: sql`coalesce(${companies.logoUrl}, ${firmographics.logo_url})`,
          hq: sql`coalesce(${companies.hq}, ${firmographics.hq})`,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, r.companyId));
    }
    processed++;
  }
  return { companies: processed, matched, credits };
}
