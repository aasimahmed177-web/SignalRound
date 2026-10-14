// The cross-source read on stored rows: a row that gained sources since it was verified (corroboration
// found a release, a dated article) is read again with all of them in view, and what the sources state
// lands through the same persist path a fresh record takes.

import type { FeedRecord, RateTable, ReconcileModel } from "@fireround/core";
import { firecrawlReader, normalizeCompanyKey, reconcileRecords, registrableDomain } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { listRounds, persistRecords, type RoundRow, setDisposition } from "./persist.ts";

/** A stored row as the record the reconciler reads: every field it may correct, every source it may cite. */
export function recordFromRow(row: RoundRow): FeedRecord {
  return {
    id: row.id,
    company_key: normalizeCompanyKey(row.company.name),
    company_name: row.company.name,
    company_domain: row.company.domain ?? registrableDomain(row.company.website),
    company_website: row.company.website,
    company_description: row.company.description,
    stage: row.stage,
    stage_as_written: row.stage_as_written,
    is_extension: row.is_extension,
    amount: { ...row.amount, fx_rate: null, fx_date: null },
    valuation_as_written: row.valuation_as_written,
    lead_investors: [...row.lead_investors],
    other_investors: [...row.other_investors],
    announced_date: row.announced_on,
    certainty: row.certainty,
    date_precision: row.date_precision,
    date_basis: row.date_basis ?? undefined,
    verification: (row.verification as FeedRecord["verification"]) ?? undefined,
    headquarters: row.company.hq,
    sector: row.company.sector,
    evidence_quotes: [...row.evidence_quotes],
    sources: row.sources.map((s) => ({
      url: s.url,
      host: s.host,
      title: s.title ?? undefined,
      published: s.published ?? undefined,
      query: s.query ?? undefined,
    })),
    confidence: row.confidence,
    status: row.status,
    undated: row.announced_on === null,
  };
}

/** Rows among `ids` whose source count grew past what their verifier read. */
export function grownRows(rows: RoundRow[]): RoundRow[] {
  return rows.filter(
    (r) =>
      r.verification?.status !== "not_news" &&
      r.disposition !== "rejected" &&
      r.sources.length > (r.verification?.sources_listed ?? r.verification?.sources_seen ?? 0),
  );
}

export async function reconcileGrownRows(
  handle: Db,
  client: Firecrawl,
  model: ReconcileModel,
  ids: string[],
  opts: { rates: RateTable | null; tiers?: Record<string, number> },
): Promise<{ reconciled: number; credits: number }> {
  if (ids.length === 0) return { reconciled: 0, credits: 0 };
  const { rows } = await listRounds(handle, { ids, includeReview: true, limit: ids.length });
  const grown = grownRows(rows);
  if (grown.length === 0) return { reconciled: 0, credits: 0 };
  // A renamed company's older pages use its former name; the read-back is told the names it also goes by.
  const aliasRows = await handle
    .select({ companyId: schema.companyAliases.companyId, alias: schema.companyAliases.alias })
    .from(schema.companyAliases)
    .where(
      and(eq(schema.companyAliases.kind, "name"), inArray(schema.companyAliases.companyId, [...new Set(grown.map((r) => r.company.id))])),
    );
  const records = grown.map((row) => {
    const aliases = aliasRows.filter((a) => a.companyId === row.company.id).map((a) => a.alias);
    return aliases.length ? { ...recordFromRow(row), company_aliases: aliases } : recordFromRow(row);
  });
  const result = await reconcileRecords(records, firecrawlReader(client), model, opts);
  // A history row is read back as history: its day comes from its pages, so no earliest-report search is owed.
  const batches = new Map<string, { preset: string; history: boolean; records: FeedRecord[] }>();
  for (const [i, record] of result.records.entries()) {
    const row = grown[i];
    if (!row) continue;
    if (record.verification?.status === "not_news" || record.verification?.status === "contradicted") {
      // The sources, read together, say this is not this company's round as news: off the feed, kept for the reviewer.
      await setDisposition(handle, row.id, "rejected");
      continue;
    }
    if (record.verification?.status === "skipped") continue;
    const key = `${row.preset_slug}:${row.history}`;
    const batch = batches.get(key) ?? { preset: row.preset_slug, history: row.history, records: [] };
    batch.records.push(record);
    batches.set(key, batch);
  }
  for (const { preset, history, records } of batches.values())
    await persistRecords(handle, records, preset, `reconcile:${new Date().toISOString().slice(0, 10)}`, history ? { history } : {});
  return { reconciled: result.judged, credits: result.creditsEstimated };
}
