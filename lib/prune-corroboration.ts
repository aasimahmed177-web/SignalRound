// Undo what corroboration attached before it checked the round: for every round with more
// than one source, re-read each link against the stored data alone. A link goes when its
// source's title and URL path carry none of the company's name tokens, its host is not the
// company's own domain, and its title states an amount more than 2x away from the round's: a
// headline that omits the company is common journalism, so the name alone proves nothing, but a
// headline about a different sum is about a different story. The earliest linked source and
// anything a first-reading lane wrote (sweep, X, watch, Form D, monitor) are never pruned.
// Source rows left without a round go with their links. `scripts/maintenance/prune-corroboration.ts` is the command.

import { HEADLINE_AMOUNT_RATIO, headlineAmount, sourceMentionsCompany } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, sql } from "drizzle-orm";

const { companies, fundingRounds, sources, roundSources } = schema;

/** A source row as one round links it. */
export interface StoredLink {
  sourceId: string;
  url: string;
  title: string | null;
  host: string;
  query: string | null;
  fetchedAt: Date;
}

/** The queries the second readings write; every other query (or none) is a first reading and is never pruned. */
export function isSecondReadingQuery(query: string | null): boolean {
  return query === "corroborate" || (query?.startsWith("agent:") ?? false);
}

/** The round's own amount, as the row stores it: millions of the currency. */
export interface RoundAmount {
  amountValue: number | null;
  amountCurrency: string | null;
}

/** True when a title states an amount and it sits more than 2x from the round's, in a comparable currency. */
export function titleContradictsAmount(title: string | null, round: RoundAmount): boolean {
  const headline = headlineAmount(title);
  if (!headline || round.amountValue === null || round.amountValue <= 0) return false;
  if (headline.currency && round.amountCurrency && headline.currency !== round.amountCurrency) return false;
  const ratio = Math.max(headline.value, round.amountValue) / Math.min(headline.value, round.amountValue);
  return ratio > HEADLINE_AMOUNT_RATIO;
}

/**
 * The links to drop for one round: not the earliest linked source, written by a second reading,
 * and demonstrably about something else: the title names none of the company's tokens
 * (sourceMentionsCompany says false, not null) and states an amount that contradicts the round's.
 */
export function linksToDrop(company: { name: string; domain: string | null }, round: RoundAmount, links: StoredLink[]): StoredLink[] {
  if (links.length < 2) return [];
  const earliest = [...links].sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime() || a.sourceId.localeCompare(b.sourceId))[0];
  return links.filter(
    (l) =>
      l !== earliest &&
      isSecondReadingQuery(l.query) &&
      sourceMentionsCompany({ title: l.title, host: l.host, url: l.url }, company) === false &&
      titleContradictsAmount(l.title, round),
  );
}

export interface PruneSummary {
  /** Rounds with more than one source. */
  rounds: number;
  /** Links on those rounds. */
  checked: number;
  drops: Array<{ roundId: string; company: string; sourceId: string; title: string | null }>;
  /** Source rows the drops left with no round. */
  orphans: number;
}

export async function pruneCorroborationSources(handle: Db, opts: { dryRun?: boolean } = {}): Promise<PruneSummary> {
  const multi = await handle
    .select({ roundId: roundSources.roundId })
    .from(roundSources)
    .groupBy(roundSources.roundId)
    .having(sql`count(*) > 1`);
  const roundIds = multi.map((r) => r.roundId);
  const summary: PruneSummary = { rounds: roundIds.length, checked: 0, drops: [], orphans: 0 };
  if (roundIds.length === 0) return summary;

  const rows = await handle
    .select({
      roundId: roundSources.roundId,
      sourceId: sources.id,
      url: sources.url,
      title: sources.title,
      host: sources.host,
      query: sources.query,
      fetchedAt: sources.fetchedAt,
      name: companies.name,
      domain: companies.domain,
      amountValue: fundingRounds.amountValue,
      amountCurrency: fundingRounds.amountCurrency,
    })
    .from(roundSources)
    .innerJoin(sources, eq(sources.id, roundSources.sourceId))
    .innerJoin(fundingRounds, eq(fundingRounds.id, roundSources.roundId))
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    .where(inArray(roundSources.roundId, roundIds));
  summary.checked = rows.length;

  const byRound = new Map<string, { company: { name: string; domain: string | null }; round: RoundAmount; links: StoredLink[] }>();
  for (const r of rows) {
    const entry = byRound.get(r.roundId) ?? {
      company: { name: r.name, domain: r.domain },
      round: { amountValue: r.amountValue === null ? null : Number(r.amountValue), amountCurrency: r.amountCurrency },
      links: [],
    };
    entry.links.push({ sourceId: r.sourceId, url: r.url, title: r.title, host: r.host, query: r.query, fetchedAt: r.fetchedAt });
    byRound.set(r.roundId, entry);
  }
  for (const [roundId, { company, round, links }] of byRound) {
    for (const l of linksToDrop(company, round, links))
      summary.drops.push({ roundId, company: company.name, sourceId: l.sourceId, title: l.title });
  }

  const droppedSourceIds = [...new Set(summary.drops.map((d) => d.sourceId))];
  if (droppedSourceIds.length === 0) return summary;

  if (opts.dryRun) {
    // What the drops would orphan: sources every one of whose links is on the drop list.
    const linkCounts = await handle
      .select({ sourceId: roundSources.sourceId, n: sql<number>`count(*)::int` })
      .from(roundSources)
      .where(inArray(roundSources.sourceId, droppedSourceIds))
      .groupBy(roundSources.sourceId);
    const dropsPerSource = new Map<string, number>();
    for (const d of summary.drops) dropsPerSource.set(d.sourceId, (dropsPerSource.get(d.sourceId) ?? 0) + 1);
    summary.orphans = linkCounts.filter((c) => (dropsPerSource.get(c.sourceId) ?? 0) >= c.n).length;
    return summary;
  }

  for (const d of summary.drops) {
    await handle.delete(roundSources).where(and(eq(roundSources.roundId, d.roundId), eq(roundSources.sourceId, d.sourceId)));
  }
  const orphaned = await handle
    .delete(sources)
    .where(
      and(inArray(sources.id, droppedSourceIds), sql`not exists (select 1 from ${roundSources} rs where rs.source_id = ${sources.id})`),
    )
    .returning({ id: sources.id });
  summary.orphans = orphaned.length;
  return summary;
}
