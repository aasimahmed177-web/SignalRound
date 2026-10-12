// Corroborate one stored round: read what the wire and the company's newsroom say about
// it and fold that in through applyFill, so a second source can add a date, an amount, a
// lead, more investors, and its own quotes. A higher-tier contradiction is held for review.
// Only a page that describes this same round (core's acceptCorroboration) is folded in; a
// page about another company with the name is counted as rejected and leaves no trace.
// The record is rescored with the extra sources; a row in review leaves the queue on its own
// when the second source lifts it over the line.

import type { CorroborationCandidate, CorroborationOptions, FeedRecord } from "@fireround/core";
import {
  canonicalUrl,
  corroborate,
  DEFAULT_TIERS,
  fetchRates,
  hostOf,
  jevClassifier,
  parseAmount,
  registrableDomain,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { earliestReport, releaseDay, storedReleaseSources } from "./freshness.ts";
import { applyFill, type RecordFill } from "./gapfill.ts";
import { listRounds, type RoundRow } from "./persist.ts";
import { autoPromotionEligible, investorDomainsForRound, storedVisibilityEvidence } from "./round-verification.ts";
import { loadPublisherTiers } from "./rules.ts";

export interface CorroborateOutcome {
  /** URLs read (the search found nothing new when zero). */
  read: number;
  /** Pages read that described a round, none of them this one. */
  rejected: number;
  /** Pages found on the company's own site by mapping it and read ahead of the search. */
  newsroom: number;
  added: { sources: number; investors: number; fields: string[] };
  confidence: { before: number; after: number };
  disposition: { before: RoundRow["disposition"]; after: RoundRow["disposition"] };
  creditsEstimated: number;
  contradictions: string[];
  reviewConflict: boolean;
}

export function openVerificationConflict(row: Pick<RoundRow, "disposition" | "verification">): boolean {
  return row.disposition === "flagged" && Boolean(row.verification?.notes.some((n) => n.startsWith("Verification conflict:")));
}

function sourceRank(url: string, domain: string | null, investorDomains: string[], tiers: Record<string, number>): number {
  const host = registrableDomain(url);
  if (host && host === domain) return 2;
  if (host && investorDomains.includes(host)) return 1.5;
  if (host && ["businesswire.com", "prnewswire.com", "globenewswire.com", "accesswire.com", "newswire.ca"].includes(host)) return 1.2;
  return tiers[hostOf(url)] ?? tiers[host ?? ""] ?? 0.3;
}

export function corroborationConflicts(
  row: RoundRow,
  readings: FeedRecord[],
  investorDomains: string[],
  tiers: Record<string, number>,
): string[] {
  const current = Math.max(0, ...row.sources.map((s) => sourceRank(s.url, row.company.domain, investorDomains, tiers)));
  const reasons: string[] = [];
  for (const r of readings) {
    const source = r.sources[0];
    if (!source || sourceRank(source.url, row.company.domain, investorDomains, tiers) <= current) continue;
    const mine = parseAmount(row.amount.as_written);
    if (
      mine.value !== null &&
      r.amount.value !== null &&
      mine.currency === r.amount.currency &&
      Math.abs(mine.value - r.amount.value) > 0.1 * Math.max(mine.value, r.amount.value)
    )
      reasons.push(`amount ${row.amount.as_written} vs ${r.amount.as_written} (${source.url})`);
    if (row.valuation_as_written && r.valuation_as_written && row.valuation_as_written !== r.valuation_as_written)
      reasons.push(`valuation ${row.valuation_as_written} vs ${r.valuation_as_written} (${source.url})`);
    if (row.stage !== r.stage && row.stage !== "other" && r.stage !== "other")
      reasons.push(`stage ${row.stage_as_written} vs ${r.stage_as_written} (${source.url})`);
    if (
      row.certainty === "announced" &&
      row.announced_on &&
      r.announced_date &&
      row.announced_on !== r.announced_date &&
      row.date_basis === "stated" &&
      r.date_basis === "stated" &&
      r.date_precision === "day" &&
      r.date_precision === "day"
    )
      reasons.push(`date ${row.announced_on} vs ${r.announced_date} (${source.url})`);
  }
  return [...new Set(reasons)];
}

/** A corroboration fragment as a fill: the fragment's sources are exactly the pages just read, so each becomes a source row. */
export function fragmentToFill(fragment: FeedRecord, candidates: CorroborationCandidate[] = []): RecordFill {
  const kinds = new Map(candidates.map((c) => [canonicalUrl(c.url), c.kind]));
  return {
    announced_date: fragment.announced_date,
    amount_as_written: fragment.amount.as_written,
    lead_investors: fragment.lead_investors,
    other_investors: fragment.other_investors,
    company_website: fragment.company_website,
    headquarters: fragment.headquarters,
    sector: fragment.sector,
    evidence_quotes: fragment.evidence_quotes,
    // Each page keeps its own day: an earlier release read beside today's coverage is not dated to the fragment's day.
    sources: fragment.sources.map((s) => ({
      url: s.url,
      title: s.title ?? null,
      published: s.published ?? fragment.announced_date,
      evidence: s.evidence ?? null,
      query: kinds.get(canonicalUrl(s.url)) === "news" ? "corroborate:news" : "corroborate",
    })),
    query: "corroborate",
  };
}

export interface CorroborateRecordOptions extends CorroborationOptions {
  /** Injected by tests; loaded from the rules file otherwise. */
  tiers?: Record<string, number>;
  /** Injected by tests; fetched otherwise. */
  rates?: Awaited<ReturnType<typeof fetchRates>> | null;
}

/** The round was merged into another, or removed, after the lane picked it up: nothing left to corroborate. */
export class RecordGone extends Error {
  constructor() {
    super("Record not found.");
  }
}

export async function corroborateRecord(
  handle: Db,
  client: Firecrawl,
  roundId: string,
  opts: CorroborateRecordOptions = {},
): Promise<CorroborateOutcome> {
  const { rows } = await listRounds(handle, { ids: [roundId], includeReview: true, certainty: "all", limit: 1 });
  const row = rows[0];
  if (!row) throw new RecordGone();

  const tiers = opts.tiers ?? { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
  const domains = await handle
    .select({ key: schema.companyAliases.aliasKey })
    .from(schema.companyAliases)
    .where(and(eq(schema.companyAliases.companyId, row.company.id), eq(schema.companyAliases.kind, "domain")));
  const investorDomains = await investorDomainsForRound(handle, row.id);
  const result = await corroborate(
    client,
    {
      company_name: row.company.name,
      stage_as_written: row.stage_as_written,
      stage: row.stage,
      amount_as_written: row.amount.as_written,
      announced_date: row.announced_on,
      company_domain: row.company.domain,
      company_domains: opts.broad ? domains.map((d) => d.key) : [],
      investor_domain: opts.broad ? investorDomains[0] : null,
      company_description: row.company.description,
      company_headquarters: row.company.hq,
      lead_investors: row.lead_investors,
      known_urls: row.sources.map((s) => s.url),
      date_basis: row.date_basis,
      date_precision: row.date_precision,
    },
    {
      ...opts,
      broad: opts.broad || row.certainty !== "announced",
      seekAnnouncement: row.certainty !== "announced",
      tiers,
      classify: opts.broad ? jevClassifier() : null,
    },
  );

  const read = result.extraction?.pages.filter((p) => p.ok).length ?? 0;
  const contradictions = corroborationConflicts(row, [...(result.readings ?? []), ...(result.disputed ?? [])], investorDomains, tiers);
  const reviewConflict = contradictions.length > 0 || openVerificationConflict(row);
  if (opts.broad && !row.history) {
    const readings = result.readings ?? [];
    const pages = [...(await storedReleaseSources(handle, row.id)), ...readings.flatMap((r) => r.sources)];
    const release = releaseDay(pages, row.company.domain, tiers);
    const earliest = earliestReport(readings, row.company.domain, investorDomains, tiers, release, pages);
    const date = !row.pinned?.announced_on && earliest && (!row.announced_on || earliest < row.announced_on) ? earliest : row.announced_on;
    // The day keeps the basis its reading had: a page's byline read as a stated day would outrank later corrections.
    const sameDay = readings.filter((r) => r.announced_date === date);
    const basis = sameDay.some((r) => r.date_basis === "stated") ? "stated" : (sameDay[0]?.date_basis ?? "page");
    if (date) {
      await handle
        .update(schema.fundingRounds)
        .set({
          ...(date !== row.announced_on ? { announcedOn: date, datePrecision: "day", dateBasis: basis } : {}),
          freshnessCheckedOn: date,
        })
        .where(eq(schema.fundingRounds.id, row.id));
      row.freshness_checked_on = date;
      if (date !== row.announced_on) {
        row.announced_on = date;
        row.date_precision = "day";
        row.date_basis = basis;
      }
    }
  }
  if (!result.fragment) {
    if (contradictions.length) await flagContradictions(handle, row, contradictions);
    if (opts.broad && !contradictions.length) await promoteCheckedRound(handle, row.id, investorDomains, tiers);
    return {
      read,
      rejected: result.rejected,
      newsroom: result.search.newsroom ?? 0,
      added: { sources: 0, investors: 0, fields: [] },
      confidence: { before: row.confidence, after: row.confidence },
      disposition: { before: row.disposition, after: row.disposition },
      creditsEstimated: result.creditsEstimated,
      contradictions,
      reviewConflict,
    };
  }

  const rates = opts.rates === undefined ? await fetchRates("latest").catch(() => null) : opts.rates;
  const official = result.readings?.find(
    (reading) =>
      reading.certainty === "announced" &&
      reading.sources.some((source) => {
        const domain = registrableDomain(source.url);
        return (
          domain === row.company.domain ||
          (domain !== null && investorDomains.includes(domain)) ||
          ["businesswire.com", "prnewswire.com", "globenewswire.com", "accesswire.com", "newswire.ca"].includes(domain ?? "") ||
          (domain !== null && (tiers[domain] ?? 0) >= 0.7)
        );
      }),
  );
  const applied = await applyFill(
    handle,
    row,
    {
      ...fragmentToFill(result.fragment, result.search.candidates),
      officialAnnouncementUrl: official?.sources[0]?.url,
      officialValuation: official?.valuation_as_written,
      ...(official?.announced_date ? { announced_date: official.announced_date } : {}),
    },
    {
      rates,
      tiers,
      now: opts.now,
      protectFacts: reviewConflict,
    },
  );
  if (contradictions.length) await flagContradictions(handle, row, contradictions);
  return {
    read,
    rejected: result.rejected,
    newsroom: result.search.newsroom ?? 0,
    added: {
      sources: applied.added.sources,
      investors: applied.added.investors,
      fields: applied.filled.filter((f) => f !== "source" && f !== "investors"),
    },
    confidence: applied.confidence,
    disposition: applied.disposition,
    creditsEstimated: result.creditsEstimated,
    contradictions,
    reviewConflict,
  };
}

export async function promoteCheckedRound(handle: Db, id: string, investorDomains: string[], tiers: Record<string, number>): Promise<void> {
  const { rows } = await listRounds(handle, { ids: [id], includeReview: true, certainty: "all", limit: 1 });
  const row = rows[0];
  if (!row || row.history || row.disposition !== "review" || row.hold || !row.announced_on || row.freshness_checked_on !== row.announced_on)
    return;
  if (!autoPromotionEligible(row.verification?.notes, row.preset_slug)) return;
  if (row.sources.length > 1 && Math.max(row.verification?.sources_seen ?? 0, row.verification?.sources_listed ?? 0) < row.sources.length)
    return;
  if (!(await storedVisibilityEvidence(handle, row, investorDomains, tiers))) return;
  if (row.verification?.status === "contradicted" || row.verification?.status === "not_news" || row.confidence < 0.5) return;
  await handle
    .update(schema.fundingRounds)
    .set({
      disposition:
        row.confidence >= 0.75 && row.amount.as_written && ["confirmed", "corrected"].includes(row.verification?.status ?? "")
          ? "publish"
          : "flagged",
    })
    .where(
      and(
        eq(schema.fundingRounds.id, id),
        eq(schema.fundingRounds.disposition, "review"),
        eq(schema.fundingRounds.freshnessCheckedOn, row.announced_on),
      ),
    );
}

async function flagContradictions(handle: Db, row: RoundRow, reasons: string[]): Promise<void> {
  const verification = row.verification ?? { status: "unverified", notes: [], url: null };
  await handle
    .update(schema.fundingRounds)
    .set({
      disposition: sql`CASE WHEN ${schema.fundingRounds.disposition} = 'review' THEN 'review'::disposition ELSE 'flagged'::disposition END`,
      verification: { ...verification, notes: [...new Set([...verification.notes, ...reasons.map((r) => `Verification conflict: ${r}`)])] },
      updatedAt: new Date(),
    })
    .where(and(eq(schema.fundingRounds.id, row.id), inArray(schema.fundingRounds.disposition, ["publish", "flagged", "review"])));
}
