// The cross-source read on stored rows: a row that gained sources since it was verified (corroboration
// found a release, a dated article) is read again with all of them in view, and what the sources state
// lands through the same persist path a fresh record takes.

import type { FeedRecord, RateTable, ReconcileModel } from "@fireround/core";
import { firecrawlReader, normalizeCompanyKey, reconcileRecords, registrableDomain } from "@fireround/core";
import type { Db } from "@fireround/core/db";
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
  const result = await reconcileRecords(grown.map(recordFromRow), firecrawlReader(client), model, opts);
  const byPreset = new Map<string, FeedRecord[]>();
  for (const [i, record] of result.records.entries()) {
    const row = grown[i];
    if (!row) continue;
    if (record.verification?.status === "not_news" || record.verification?.status === "contradicted") {
      // The sources, read together, say this is not this company's round as news: off the feed, kept for the reviewer.
      await setDisposition(handle, row.id, "rejected");
      continue;
    }
    if (record.verification?.status === "skipped") continue;
    byPreset.set(row.preset_slug, [...(byPreset.get(row.preset_slug) ?? []), record]);
  }
  for (const [preset, records] of byPreset)
    await persistRecords(handle, records, preset, `reconcile:${new Date().toISOString().slice(0, 10)}`);
  return { reconciled: result.judged, credits: result.creditsEstimated };
}
