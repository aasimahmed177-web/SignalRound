// One company, everything the store knows about it: its rounds, the sources behind them, the
// investors on them, the profile enrichment, and the deep-dive dossier. The headline figures
// count only the rounds the feed lists (publish and flagged), as the directories do; review and
// rejected rows come along only when the caller asks (an admin), each wearing its status.

import type { AlexandriaEnrichment } from "@fireround/core";
import { canonicalUrl } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import type { CompanyRequestTally } from "@fireround/core/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { cache } from "react";
import type { StoredApollo } from "@/lib/apollo";
import type { BuzzScale } from "@/lib/buzz";
import { type LedgerPrior, ledgerReason } from "@/lib/company-request-status";
import { type Dossier, getDossier } from "@/lib/deepdive";
import { ruledOutPriors } from "@/lib/history";
import type { EnrichmentData, RoundRow } from "@/lib/persist";
import { listRounds, toEnrichment } from "@/lib/persist";
import { buzzFor, type RoundOnX, roundsOnX, type TrendingMark } from "@/lib/trending";

/** The listing the verified homepage read names for its own company, or null for a private one. */
function publicListing(data: unknown): string | null {
  const listing = (data as { profile?: { public_listing?: unknown; same_company?: boolean } | null } | undefined)?.profile;
  if (!listing || listing.same_company === false || typeof listing.public_listing !== "string") return null;
  const value = listing.public_listing.trim();
  return value && !/^(?:null|none|n\/a|private)$/i.test(value) ? value : null;
}

/** Each ledger row's reason, a dossier prior the funding search also found reading as that lead's. */
async function priorReasons(handle: Db, companyId: string): Promise<Record<string, string | null>> {
  const rows = await handle
    .select({
      key: schema.historyPromotions.priorKey,
      prior: schema.historyPromotions.prior,
      status: schema.historyPromotions.status,
      attempts: schema.historyPromotions.attempts,
      outcome: schema.historyPromotions.outcome,
    })
    .from(schema.historyPromotions)
    .where(eq(schema.historyPromotions.companyId, companyId));
  const byKey = new Map(rows.map((row) => [row.key, { ...row, outcome: row.outcome as LedgerPrior["outcome"] }]));
  return Object.fromEntries([...byKey].map(([key, row]) => [key, ledgerReason(byKey.get(row.outcome?.duplicateOf ?? "") ?? row)]));
}

const { companies, companyRequests, investors, roundInvestors, enrichments } = schema;

export interface CompanyPage {
  addedOnRequest: boolean;
  /** What the finishing request's research found and could verify; null without one, or for a request finished before tallies. */
  requestTally: CompanyRequestTally | null;
  /** For a requested company: why each earlier round on the ledger is not on the page yet, by prior key; null otherwise. */
  priorReasons: Record<string, string | null> | null;
  /** The exchange and ticker the verified homepage shows when the company is listed; a listing never hides the company or its rounds. */
  publicListing: string | null;
  company: {
    id: string;
    name: string;
    domain: string | null;
    website: string | null;
    logo_url: string | null;
    description: string | null;
    hq: string | null;
    sector: string | null;
  };
  /** The company's rounds, newest first: the feed's own (publish, flagged), plus review and rejected when asked for. */
  rounds: RoundRow[];
  enrichment: RoundRow["enrichment"];
  /** Alexandria's sourced facts for the verified domain: YC and FullEnrich, with provenance. */
  alexandria: AlexandriaEnrichment | null;
  /** Apollo's lookup on the same domain; a page shows only what the measurement cleared (lib/apollo.ts). */
  apollo: StoredApollo | null;
  /**
   * The agent's deep dive, when one has run and passed the dossier check. An admin (`withReview`)
   * also gets a dossier written before the check, which carries no verification.
   */
  dossier: Dossier | null;
  /** Union of the rounds' sources, one entry per URL, with the rounds each one supports. */
  sources: Array<{ url: string; host: string; title: string | null; published_at: string | null; round_ids: string[] }>;
  /** Investors across the company's feed rounds with how often they led and participated, as the investor pages count them. */
  investors: Array<{
    id: string;
    name: string;
    domain: string | null;
    logo_url: string | null;
    leads: number;
    participations: number;
    total: number;
    /** Each feed round the investor is on and whether it led it, so the page can group investors by round. */
    roles: Array<{ round_id: string; lead: boolean }>;
  }>;
  /** Over the feed rounds only (publish and flagged), so they match /companies. */
  totals: {
    rounds: number;
    /** Sum of stated USD amounts. */
    usd_millions_raised: number;
    first_seen: string | null;
    last_seen: string | null;
  };
}

/** A round the feed lists; listRounds without includeReview reads the same pair. */
export function inFeed(r: Pick<RoundRow, "disposition">): boolean {
  return r.disposition === "publish" || r.disposition === "flagged";
}

/**
 * generateMetadata and the page body both need the page; cache() dedupes the two lookups in one
 * request. `withReview` (an admin; see seesReview) adds the review and rejected rows. Without it a
 * company the feed does not list is null, so a visitor cannot reach it by URL either.
 */
const loadCompany = cache(async (handle: Db, id: string, withReview: boolean): Promise<CompanyPage | null> => {
  const [[company], { rows: rounds }, enrichmentRows, dossier, [request]] = await Promise.all([
    handle.select().from(companies).where(eq(companies.id, id)).limit(1),
    listRounds(handle, { companyId: id, includeReview: withReview, limit: 200 }),
    handle
      .select({ kind: enrichments.kind, data: enrichments.data })
      .from(enrichments)
      .where(and(eq(enrichments.companyId, id), inArray(enrichments.kind, ["profile", "alexandria", "apollo"]))),
    getDossier(handle, id),
    handle
      .select({ id: companyRequests.id, tally: companyRequests.tally })
      .from(companyRequests)
      .where(and(eq(companyRequests.companyId, id), eq(companyRequests.status, "done")))
      .orderBy(desc(companyRequests.createdAt))
      .limit(1),
  ]);
  if (!company) return null;
  if (!withReview && rounds.length === 0 && !request) return null;
  const enrichmentByKind = new Map(enrichmentRows.map((row) => [row.kind, row.data]));
  const profile = enrichmentByKind.get("profile");
  const counted = rounds.filter(inFeed);

  const investorRows = counted.length
    ? await handle
        .select({
          id: investors.id,
          name: investors.name,
          domain: investors.domain,
          logoUrl: investors.logoUrl,
          role: roundInvestors.role,
          roundId: roundInvestors.roundId,
        })
        .from(roundInvestors)
        .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
        .where(
          inArray(
            roundInvestors.roundId,
            counted.map((r) => r.id),
          ),
        )
    : [];

  // One entry per canonical URL: the same article with and without tracking parameters is one source.
  const byUrl = new Map<string, CompanyPage["sources"][number]>();
  for (const round of rounds) {
    for (const source of round.sources) {
      const key = canonicalUrl(source.url);
      const entry = byUrl.get(key) ?? {
        url: source.url,
        host: source.host,
        title: source.title,
        published_at: source.published,
        round_ids: [],
      };
      entry.title ??= source.title;
      entry.published_at ??= source.published;
      if (!entry.round_ids.includes(round.id)) entry.round_ids.push(round.id);
      byUrl.set(key, entry);
    }
  }
  const sourceList = [...byUrl.values()].sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));

  const byInvestor = new Map<string, CompanyPage["investors"][number]>();
  for (const i of investorRows) {
    const entry = byInvestor.get(i.id) ?? {
      id: i.id,
      name: i.name,
      domain: i.domain,
      logo_url: i.logoUrl,
      leads: 0,
      participations: 0,
      total: 0,
      roles: [],
    };
    if (i.role === "lead") entry.leads++;
    else entry.participations++;
    entry.total++;
    entry.roles.push({ round_id: i.roundId, lead: i.role === "lead" });
    byInvestor.set(i.id, entry);
  }
  const investorList = [...byInvestor.values()].sort((a, b) => b.leads - a.leads || b.total - a.total || a.name.localeCompare(b.name));

  const seen = counted.map((r) => r.first_seen_at).sort();
  const lastSeen = counted.map((r) => r.last_seen_at).sort();
  const capitalRounds = counted.filter((r) => r.certainty === "announced" || r.certainty === "reported");

  return {
    addedOnRequest: Boolean(request),
    requestTally: request?.tally ?? null,
    company: {
      id: company.id,
      name: company.name,
      domain: company.domain,
      website: company.website,
      logo_url: company.logoUrl,
      description: company.description,
      hq: company.hq,
      sector: company.sector,
    },
    rounds,
    enrichment: toEnrichment(profile as EnrichmentData | undefined),
    publicListing: publicListing(profile),
    priorReasons: request ? await priorReasons(handle, id) : null,
    alexandria: (enrichmentByKind.get("alexandria") as AlexandriaEnrichment | undefined) ?? null,
    apollo: (enrichmentByKind.get("apollo") as StoredApollo | undefined) ?? null,
    // A visitor reads only a checked dossier; one written before the check waits for the backfill.
    dossier: withReview || dossier?.verification ? dossier : null,
    sources: sourceList,
    investors: investorList,
    totals: {
      rounds: capitalRounds.length,
      usd_millions_raised: Math.round(capitalRounds.reduce((n, r) => n + (r.amount.usd_millions ?? 0), 0) * 1000) / 1000,
      first_seen: seen[0] ?? null,
      last_seen: lastSeen[lastSeen.length - 1] ?? null,
    },
  };
});

/**
 * The cached loader with the flag always passed. React's cache() keys on the argument list as
 * written, so `(handle, id)` from generateMetadata and `(handle, id, false)` from the page body were
 * two entries, and every visitor's request read the whole page twice.
 */
export function getCompany(handle: Db, id: string, withReview = false): Promise<CompanyPage | null> {
  return loadCompany(handle, id, withReview);
}

/** Everything a company page reads: the page, what the Trending lane read on X, the Buzz marks, and the ruled-out priors. */
export interface CompanyView {
  page: CompanyPage;
  onX: RoundOnX[];
  buzz: { marks: Record<string, TrendingMark>; scale: BuzzScale };
  ruledOut: Set<string>;
}

/** The whole company page in two round trips, or null when it has nothing to show; one shape for the cached visitor read and the admin's fresh one. */
export async function readCompanyView(handle: Db, id: string, withReview = false): Promise<CompanyView | null> {
  const page = await getCompany(handle, id, withReview);
  if (!page) return null;
  const ids = page.rounds.map((r) => r.id);
  const [onX, buzz, ruledOut] = await Promise.all([roundsOnX(handle, ids), buzzFor(handle, ids), ruledOutPriors(handle, page.company.id)]);
  return { page, onX, buzz, ruledOut };
}
