// One investor: the rounds it sat on and in which seat, who it invests beside, and
// where (sector) and when (stage) it shows up. Every figure reads the rounds the feed lists
// (publish and flagged), the same set /investors counts, so the two never disagree.

import { INVESTOR_TYPES, type InvestorType } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { cache } from "react";
import type { RoundRow } from "@/lib/persist";
import { listRounds } from "@/lib/persist";

const { investors, roundInvestors } = schema;

export type InvestorRole = "lead" | "participant";

export interface InvestorPage {
  /**
   * `domain` is the investor's own site, bare ("a16z.com"); null until a search resolves it.
   * `logo_url` is the logo the branding format read off that site; null until read, when the tile falls back to the favicon.
   */
  investor: {
    id: string;
    name: string;
    domain: string | null;
    logo_url: string | null;
    /** INVESTOR_TYPES: the homepage verdict's kind, or "person"; null until the resolver has looked. */
    kind: InvestorType | null;
    /** One sentence from the investor's own homepage; null when the site does not say. */
    description: string | null;
    /** Headquarters as the investor's own homepage states them; null when it does not. */
    headquarters: string | null;
  };
  /** Feed rounds (publish and flagged) this investor is named on, newest first. */
  rounds: Array<RoundRow & { role: InvestorRole }>;
  /**
   * `lead_share_usd_millions` splits each led round's stated amount evenly between its leads, so a
   * firm that is one of ten co-leads on a $65B round is credited $6.5B, not $65B, and the figures
   * across firms add up to the money actually led. How co-leads divide a round is rarely disclosed,
   * so it is an even split, labelled as such; `co_led` counts the led rounds it shared.
   */
  totals: { led: number; co_led: number; participated: number; lead_share_usd_millions: number };
  /** How far the record reaches past its own seats: the stat row's fallbacks. */
  reach: {
    /** Sum of the stated USD round sizes over every round it is named on, lead or not: the rounds' size, not its cheque. */
    usd_millions: number;
    /** Distinct investors named beside it; co_investors is capped at 15, this is not. */
    co_investors: number;
  };
  /** Investors named on the same rounds, most shared rounds first, the top 15. */
  co_investors: Array<{ id: string; name: string; domain: string | null; logo_url: string | null; rounds: number }>;
  sectors: Array<{ sector: string; count: number }>;
  stages: Array<{ stage: string; count: number }>;
}

function isInvestorType(kind: string | null): kind is InvestorType {
  return (INVESTOR_TYPES as readonly string[]).includes(kind ?? "");
}

/** How the page names each kind. Plain words, and nothing past what the site or the search said. */
const TYPE_LABELS: Record<InvestorType, string> = {
  venture_capital: "Venture capital",
  private_equity: "Private equity",
  corporate_venture: "Corporate venture arm",
  corporate: "Corporation",
  accelerator: "Accelerator",
  government: "Government or public fund",
  family_office: "Family office",
  angel_group: "Angel group",
  asset_manager: "Investment firm",
  foundation: "University or foundation",
  person: "Individual investor",
};

export function investorTypeLabel(kind: InvestorType | null): string | null {
  return kind ? TYPE_LABELS[kind] : null;
}

function countBy<T>(items: T[], key: (item: T) => string | null): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * generateMetadata and the page body both need the page; cache() dedupes the two lookups in one
 * request. An investor named only on rounds the feed does not list is null unless `withReview`
 * (an admin; see seesReview), who gets the page with no rounds rather than a 404 from a review row's link.
 */
const loadInvestor = cache(async (handle: Db, id: string, withReview: boolean): Promise<InvestorPage | null> => {
  // The investor row and its seats are keyed on the id alone, so they are read together.
  const [[investor], seats] = await Promise.all([
    handle
      .select({
        id: investors.id,
        name: investors.name,
        domain: investors.domain,
        logoUrl: investors.logoUrl,
        kind: investors.kind,
        description: investors.description,
        headquarters: investors.headquarters,
      })
      .from(investors)
      .where(eq(investors.id, id))
      .limit(1),
    handle
      .select({ roundId: roundInvestors.roundId, role: roundInvestors.role })
      .from(roundInvestors)
      .where(eq(roundInvestors.investorId, id)),
  ]);
  if (!investor) return null;

  const roleByRound = new Map(seats.map((s) => [s.roundId, s.role === "lead" ? ("lead" as const) : ("participant" as const)]));
  const ids = [...roleByRound.keys()];

  const { rows } = ids.length ? await listRounds(handle, { ids, limit: 200 }) : { rows: [] };
  if (!withReview && rows.length === 0) return null;
  const rounds = rows.map((r) => ({ ...r, role: roleByRound.get(r.id) ?? ("participant" as const) }));
  const roundIds = rounds.map((r) => r.id);

  const co = roundIds.length
    ? await handle
        .select({
          id: investors.id,
          name: investors.name,
          domain: investors.domain,
          logoUrl: investors.logoUrl,
          rounds: sql<number>`count(*)::int`,
          total: sql<number>`count(*) over ()::int`,
        })
        .from(roundInvestors)
        .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
        .where(and(inArray(roundInvestors.roundId, roundIds), ne(roundInvestors.investorId, id)))
        .groupBy(investors.id, investors.name, investors.domain, investors.logoUrl)
        .orderBy(desc(sql`count(*)`), investors.name)
        .limit(15)
    : [];

  const sumUsd = (rs: typeof rounds) => Math.round(rs.reduce((n, r) => n + (r.amount.usd_millions ?? 0), 0) * 1000) / 1000;
  const capitalRounds = rounds.filter((r) => r.certainty === "announced" || r.certainty === "reported");
  const led = capitalRounds.filter((r) => r.role === "lead");
  const leadShare = (r: (typeof rounds)[number]) => (r.amount.usd_millions ?? 0) / Math.max(1, r.lead_investors.length);
  return {
    investor: {
      id: investor.id,
      name: investor.name,
      domain: investor.domain,
      logo_url: investor.logoUrl,
      kind: isInvestorType(investor.kind) ? investor.kind : null,
      description: investor.description,
      headquarters: investor.headquarters,
    },
    rounds,
    totals: {
      led: led.length,
      co_led: led.filter((r) => r.lead_investors.length > 1).length,
      participated: capitalRounds.length - led.length,
      lead_share_usd_millions: Math.round(led.reduce((n, r) => n + leadShare(r), 0) * 1000) / 1000,
    },
    reach: { usd_millions: sumUsd(capitalRounds), co_investors: co[0]?.total ?? 0 },
    co_investors: co.map((c) => ({ id: c.id, name: c.name, domain: c.domain, logo_url: c.logoUrl, rounds: c.rounds })),
    sectors: countBy(rounds, (r) => r.company.sector).map(([sector, count]) => ({ sector, count })),
    stages: countBy(rounds, (r) => r.stage).map(([stage, count]) => ({ stage, count })),
  };
});

/**
 * The cached loader with the flag always passed. React's cache() keys on the argument list as
 * written, so `(handle, id)` from generateMetadata and `(handle, id, false)` from the page body were
 * two entries, and every visitor's request read the whole page twice.
 */
export function getInvestor(handle: Db, id: string, withReview = false): Promise<InvestorPage | null> {
  return loadInvestor(handle, id, withReview);
}
