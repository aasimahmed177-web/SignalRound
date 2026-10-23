// Alexandria enrichment for companies whose domain the identity check already verified: the
// YC catalogue by name, narrowed to the domain. The row stores the answer with its provenance;
// the only writes onto companies itself fill fields that are still empty.

import type { AlexandriaEnrichment } from "@fireround/core";
import { alexandriaEnrich } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import type { NativeWebClient } from "@fireround/core/web";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

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
 * sweep), plus the safe fills: description and hq only where the row has none.
 */
export async function alexandriaBatch(handle: Db, client: NativeWebClient, batch: AlexandriaCompany[]): Promise<AlexandriaBatchResult> {
  let matched = 0;
  let credits = 0;
  for (const c of batch) {
    const e = await alexandriaEnrich(client, { company_key: c.id, company_name: c.name, domain: c.domain });
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
        hq: sql`coalesce(${companies.hq}, ${e.yc.status === "matched" ? e.yc.location : null})`,
        updatedAt: new Date(),
      })
      .where(eq(companies.id, c.id));
  }
  return { companies: batch.length, matched, credits };
}
