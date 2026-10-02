// The articles behind the records: every source page, with the rounds it reported.

import { DEFAULT_TIERS } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { loadPublisherTiers } from "./rules.ts";
import { chargeableCredits } from "./stats.ts";

const { sources, roundSources, fundingRounds, companies, roundInvestors, investors } = schema;

/**
 * Hosts whose pages are regulatory filings, not articles. A Form D is a source on the record
 * (the company page and the feed's expanded row list it) but it is not news, so News leaves it out.
 */
export const FILING_HOSTS = ["sec.gov", "www.sec.gov"] as const;

export interface NewsItem {
  id: string;
  url: string;
  host: string;
  title: string | null;
  published_at: string | null;
  fetched_at: string;
  query: string | null;
  /** The evidence sentence when one round owns the article; a roundup has no single excerpt. */
  excerpt: string | null;
  rounds: Array<{
    id: string;
    company_id: string;
    company: string;
    domain: string | null;
    logo_url: string | null;
    stage: string;
    stage_as_written: string;
    disposition: string;
    /** The round's first lead investor, when one is named. */
    lead: string | null;
    amount_as_written: string | null;
    usd_millions: number | null;
  }>;
}

export interface NewsQuery {
  limit?: number;
  /** Visitors see only articles behind at least one published round. */
  publishedOnly?: boolean;
  /** Articles whose rounds one preset wrote. */
  preset?: string;
}

/** The evidence sentence clipped on a word boundary; the reader can open the row for the rest. */
function clipQuote(quote: string | undefined): string | null {
  const text = quote?.trim();
  if (!text) return null;
  if (text.length <= 240) return text;
  const cut = text.slice(0, 240);
  const wordEnd = cut.lastIndexOf(" ");
  return `${(wordEnd > 0 ? cut.slice(0, wordEnd) : cut).trimEnd()}...`;
}

/**
 * Every article page on record, filings aside: the set listStories scans, so /news knows when its
 * window has covered it, and the landing page's "Articles read" quotes the same figure.
 */
export async function countArticles(handle: Db): Promise<number> {
  const [row] = await handle
    .select({ n: sql<number>`count(*)::int` })
    .from(sources)
    .where(notInArray(sources.host, [...FILING_HOSTS]));
  return row?.n ?? 0;
}

export async function listNews(handle: Db, q: NewsQuery = {}): Promise<NewsItem[]> {
  const rows = await handle
    .select({
      id: sources.id,
      url: sources.url,
      host: sources.host,
      title: sources.title,
      publishedAt: sources.publishedAt,
      fetchedAt: sources.fetchedAt,
      query: sources.query,
      roundCount: sql<number>`(select count(*) from ${roundSources} rs where rs.source_id = ${sources.id})::int`,
    })
    .from(sources)
    .where(notInArray(sources.host, [...FILING_HOSTS]))
    .orderBy(desc(sql`coalesce(${sources.publishedAt}::text, '')`), desc(sources.fetchedAt))
    .limit(q.limit ?? 60);

  const ids = rows.map((r) => r.id);
  const linkConds = [inArray(roundSources.sourceId, ids)];
  if (q.preset) linkConds.push(eq(fundingRounds.presetSlug, q.preset));
  if (q.publishedOnly) linkConds.push(eq(fundingRounds.disposition, "publish"));
  const links = ids.length
    ? await handle
        .select({
          sourceId: roundSources.sourceId,
          roundId: fundingRounds.id,
          companyId: companies.id,
          company: companies.name,
          domain: companies.domain,
          logoUrl: companies.logoUrl,
          stage: fundingRounds.stage,
          stageAsWritten: fundingRounds.stageAsWritten,
          disposition: fundingRounds.disposition,
          amountAsWritten: fundingRounds.amountAsWritten,
          usd: fundingRounds.amountUsdMillions,
          quotes: fundingRounds.evidenceQuotes,
        })
        .from(roundSources)
        .innerJoin(fundingRounds, eq(fundingRounds.id, roundSources.roundId))
        .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
        .where(and(...linkConds))
    : [];

  // Leads for every linked round in one query, not a listRounds per article.
  const roundIds = [...new Set(links.map((l) => l.roundId))];
  const leadRows = roundIds.length
    ? await handle
        .select({ roundId: roundInvestors.roundId, name: investors.name })
        .from(roundInvestors)
        .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
        .where(and(inArray(roundInvestors.roundId, roundIds), eq(roundInvestors.role, "lead")))
    : [];
  const leadByRound = new Map(leadRows.map((l) => [l.roundId, l.name]));

  // A narrowed list drops articles with no surviving round; the open list still shows linked
  // pages that have none (a source can exist before its round links do).
  const narrowed = q.publishedOnly === true || !!q.preset;
  return rows
    .filter((r) => !narrowed || links.some((l) => l.sourceId === r.id))
    .map((r) => {
      const linked = links.filter((l) => l.sourceId === r.id);
      return {
        id: r.id,
        url: r.url,
        host: r.host,
        title: r.title,
        published_at: r.publishedAt,
        fetched_at: r.fetchedAt.toISOString(),
        query: r.query,
        excerpt: linked.length === 1 ? clipQuote(linked[0].quotes[0]) : null,
        rounds: linked.map((l) => ({
          id: l.roundId,
          company_id: l.companyId,
          company: l.company,
          domain: l.domain,
          logo_url: l.logoUrl,
          stage: l.stage,
          stage_as_written: l.stageAsWritten,
          disposition: l.disposition,
          lead: leadByRound.get(l.roundId) ?? null,
          amount_as_written: l.amountAsWritten,
          usd_millions: l.usd === null ? null : Number(l.usd),
        })),
      };
    });
}

/** A source as a story card shows it: the NewsItem minus its round links. */
export type NewsSource = Pick<NewsItem, "id" | "url" | "host" | "title" | "published_at" | "fetched_at" | "query">;

/**
 * One round reported by several pages is one card: the primary source's headline, every other
 * copy under "Also in". A page that reported two or more rounds stays an article; its chips
 * carry the story.
 */
export interface Story {
  kind: "story";
  round: NewsItem["rounds"][number];
  primary: NewsSource;
  also: NewsSource[];
  excerpt: string | null;
  /** The card's day-group key: the primary's published day, or its fetch day when undated. */
  day: string;
}

export interface StoryArticle {
  kind: "article";
  item: NewsItem;
}

export type NewsEntry = Story | StoryArticle;

/**
 * Which copy of a syndicated story leads the group: highest publisher tier (the same merge the
 * lanes score with, file rules over the defaults), then earliest publish day, then shortest URL.
 */
export function orderSources<T extends { host: string; published_at: string | null; url: string }>(
  items: T[],
  tiers: Record<string, number>,
): T[] {
  const tierOf = (host: string) => tiers[host] ?? tiers[host.replace(/^www\./, "")] ?? 0.3;
  return [...items].sort(
    (a, b) =>
      tierOf(b.host) - tierOf(a.host) || (a.published_at ?? "9999").localeCompare(b.published_at ?? "9999") || a.url.length - b.url.length,
  );
}

/** The whole News list folded into stories: sources behind one round group by that round. */
export async function listStories(handle: Db, q: NewsQuery = {}): Promise<NewsEntry[]> {
  const [items, fileTiers] = await Promise.all([listNews(handle, q), loadPublisherTiers()]);
  const tiers = { ...DEFAULT_TIERS, ...fileTiers };
  const toSource = (i: NewsItem): NewsSource => ({
    id: i.id,
    url: i.url,
    host: i.host,
    title: i.title,
    published_at: i.published_at,
    fetched_at: i.fetched_at,
    query: i.query,
  });
  const byRound = new Map<string, NewsItem[]>();
  const entries: NewsEntry[] = [];
  for (const item of items) {
    if (item.rounds.length !== 1) {
      entries.push({ kind: "article", item });
      continue;
    }
    const rid = item.rounds[0].id;
    byRound.set(rid, [...(byRound.get(rid) ?? []), item]);
  }
  for (const group of byRound.values()) {
    const [primary, ...also] = orderSources(group, tiers);
    entries.push({
      kind: "story",
      round: group[0].rounds[0],
      primary: toSource(primary),
      also: also.map(toSource),
      excerpt: primary.excerpt,
      day: (primary.published_at ?? primary.fetched_at).slice(0, 10),
    });
  }
  const dayOf = (e: NewsEntry) => (e.kind === "story" ? e.day : (e.item.published_at ?? e.item.fetched_at).slice(0, 10));
  const pubOf = (e: NewsEntry) => (e.kind === "story" ? e.primary.published_at : e.item.published_at) ?? "";
  return entries.sort((a, b) => dayOf(b).localeCompare(dayOf(a)) || pubOf(b).localeCompare(pubOf(a)));
}

/** Titles that are a publisher's index page rather than one story. */
export const SECTION_INDEX_TITLE = /breaking news|press releases? from|news and press releases/i;

/**
 * What a syndicated copy group shares: the title the wire sent, lowercased and without the
 * " - Publisher" / " | Publisher" tail each outlet appended. A section index page ("press
 * releases from Acme") has no shared title and never folds.
 */
export function sourceGroupKey(title: string | null): string | null {
  if (!title) return null;
  if (SECTION_INDEX_TITLE.test(title)) return null;
  const key = title
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s+[-|]\s+[^-|]+$/, "")
    .trim();
  return key || null;
}

export interface RunRow {
  id: string;
  preset: string;
  lane: string;
  window: string | null;
  started_at: string;
  finished_at: string | null;
  credits_estimated: number | null;
  credits_measured: number | null;
  /** The charge a total takes for this run: the measurement, or the estimate when a measured sibling overlapped it. */
  credits_charged: number;
  overlapped: boolean;
  counts: Record<string, number> | null;
  error: string | null;
}

/** The News page's list and the article count beside it, in one round trip; the visitor's cached read (lib/cached.ts) and the admin's fresh one. */
export async function readNews(handle: Db, q: NewsQuery): Promise<{ items: NewsEntry[]; total: number }> {
  const [items, total] = await Promise.all([listStories(handle, q), countArticles(handle)]);
  return { items, total };
}

/**
 * Lanes whose rows are for admins: the accuracy check's counts describe flags only Review shows, so a
 * public demo's visitor never sees the row that tallies them (on Runs or /api/v1/runs).
 */
export const ADMIN_RUN_LANES = ["accuracy"] as const;

export async function listRuns(handle: Db, limit = 50, opts: { adminLanes?: boolean } = {}): Promise<RunRow[]> {
  const rows = await handle
    .select()
    .from(schema.runs)
    .where(opts.adminLanes === false ? notInArray(schema.runs.lane, [...ADMIN_RUN_LANES]) : undefined)
    .orderBy(desc(schema.runs.startedAt))
    .limit(limit);
  const chargeable = rows.map((r) => ({
    started_at: r.startedAt.toISOString(),
    finished_at: r.finishedAt?.toISOString() ?? null,
    credits_estimated: r.creditsEstimated,
    credits_measured: r.creditsMeasured,
  }));
  return rows.map((r, i) => {
    const { credits, overlapped } = chargeableCredits(chargeable[i], chargeable);
    return {
      id: r.id,
      preset: r.presetSlug,
      lane: r.lane,
      window: r.window,
      started_at: chargeable[i].started_at,
      finished_at: chargeable[i].finished_at,
      credits_estimated: r.creditsEstimated,
      credits_measured: r.creditsMeasured,
      credits_charged: credits,
      overlapped,
      counts: (r.counts as Record<string, number> | null) ?? null,
      error: r.error,
    };
  });
}
