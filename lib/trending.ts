// The Trending layer's store side: which rounds the lane follows (visible, first seen in the last
// 72 hours), when each is due a search (first seen, +6h, +24h, +48h), the posts and Hacker News
// stories it keeps, the hourly rescore that turns them into a rank and a label, and the reads the
// feed, the company page, the landing page, and the API share. The rules themselves are pure and
// live in packages/core/src/trending/signals.ts.

import type { RoundSubject, RoundXSearch } from "@fireround/core";
import {
  amountTokens,
  frequentAccounts,
  HANDLE_LOOKUP_CREDITS,
  isOutletAccount,
  labelRounds,
  nameAliases,
  sameName,
  searchCredits,
  staleCheck,
  staleReadings,
  trendingScore,
  trendingSummary,
  X_POST_READ_CREDITS,
  X_SEARCH_LIMIT,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import type { TrendingHnStory } from "@fireround/core/db/schema";
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { type BuzzScale, buzzScale, EMPTY_SCALE } from "@/lib/buzz";
import { listRounds, type RoundQuery, type RoundRow } from "@/lib/persist";

const { trendingRounds, trendingPosts, fundingRounds, companies, roundInvestors, investors, roundSources, sources, enrichments } = schema;

const HOUR = 3_600_000;

/** How long a round stays in Trending after it is first seen. */
export const TRENDING_WINDOW_HOURS = 72;
/** When a followed round is searched on X, in hours after it was first seen. */
export const CHECKPOINT_HOURS = [0, 6, 24, 48] as const;
/**
 * A round announced more than a week before it was first seen (a backfill finding last month's
 * news) has had its conversation already: the lane does not follow it.
 */
export const ANNOUNCED_WITHIN_DAYS = 7;
/** Hacker News is free but not infinite: a followed round is asked about at most every three hours. */
export const HN_REFRESH_HOURS = 3;
/** A post's likes and reposts are read again at most every six hours. */
export const ENGAGEMENT_REFRESH_HOURS = 6;
/** Posts per labelled round the showcase reads for likes and reposts. */
export const SHOWCASE_POSTS = 3;
/** A homepage handle lookup is reused for a month across the company's rounds. */
const HANDLE_REUSE_DAYS = 30;
/** The outlet filter's lookback for accounts that turn up on many rounds. */
const FREQUENT_LOOKBACK_DAYS = 30;
/** The trending list's length: the feed's sort reads at most this many rounds. */
export const TRENDING_LIST_MAX = 200;

/** The reader's explanation, shown wherever the Trending view or strip appears. */
export const TRENDING_EXPLAINER =
  "Most discussed rounds first seen in the last 3 days, ranked by talk on X, in the press, and on Hacker News, weighted toward the last 24 hours. Counts are distinct accounts and outlets, not likes.";

/** The highest checkpoint whose hour has come, or -1 before the first (never, since the first is at 0). */
export function dueCheckpoint(firstSeenAt: Date, now: Date): number {
  const hours = (now.getTime() - firstSeenAt.getTime()) / HOUR;
  let k = -1;
  CHECKPOINT_HOURS.forEach((h, i) => {
    if (hours >= h) k = i;
  });
  return k;
}

/**
 * Whether a round is due a search now: a checkpoint has come that has not run. A round first seen
 * 30 hours ago and never searched runs once (for +24h), not three times; four searches at most.
 */
export function searchDue(checkpointsDone: number, firstSeenAt: Date, now: Date): boolean {
  const hours = (now.getTime() - firstSeenAt.getTime()) / HOUR;
  if (hours >= TRENDING_WINDOW_HOURS) return false;
  return dueCheckpoint(firstSeenAt, now) >= checkpointsDone;
}

/** A followed round with what the lane needs to search and score it. */
export interface FollowedRound {
  roundId: string;
  companyId: string;
  name: string;
  domain: string | null;
  website: string | null;
  firstSeenAt: string;
  announced: string;
  amounts: string[];
  checkpoints: number;
  xHandle: string | null;
  xHandleSource: string | null;
  handleCheckedAt: string | null;
  hnCheckedAt: string | null;
  /** What tells the company from a namesake for a one-word name: its description and the round's leads. */
  description?: string | null;
  leadInvestors?: string[];
}

/** The subject the relevance rule reads for a followed round. */
export function subjectOf(
  r: Pick<FollowedRound, "name" | "amounts" | "announced" | "xHandle"> &
    Partial<Pick<FollowedRound, "domain" | "description" | "leadInvestors">>,
): RoundSubject {
  return {
    name: r.name,
    aliases: nameAliases(r.name),
    handle: r.xHandle,
    amounts: r.amounts,
    announced: r.announced,
    domain: r.domain ?? null,
    leadInvestors: r.leadInvestors ?? [],
    description: r.description ?? null,
  };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Take up every visible round first seen in the last 72 hours (and announced within a week of
 * now) and return the rounds the lane follows, newest first. Idempotent: a round is inserted once.
 */
export async function followRounds(handle: Db, now: Date): Promise<FollowedRound[]> {
  const since = new Date(now.getTime() - TRENDING_WINDOW_HOURS * HOUR);
  const announcedFloor = isoDay(new Date(now.getTime() - ANNOUNCED_WITHIN_DAYS * 24 * HOUR));
  const fresh = await handle
    .select({ id: fundingRounds.id, companyId: fundingRounds.companyId, firstSeenAt: fundingRounds.firstSeenAt })
    .from(fundingRounds)
    .where(
      and(
        inArray(fundingRounds.disposition, ["publish", "flagged"]),
        gt(fundingRounds.firstSeenAt, since),
        sql`(${fundingRounds.announcedOn} is null or ${fundingRounds.announcedOn} >= ${announcedFloor})`,
        // A history row (an earlier round promoted from a dossier) is first seen today but is not news.
        eq(fundingRounds.history, false),
      ),
    );
  if (fresh.length > 0) {
    await handle
      .insert(trendingRounds)
      .values(fresh.map((r) => ({ roundId: r.id, companyId: r.companyId, firstSeenAt: r.firstSeenAt })))
      .onConflictDoNothing();
  }
  const rows = await handle
    .select({ t: trendingRounds, r: fundingRounds, c: companies })
    .from(trendingRounds)
    .innerJoin(fundingRounds, eq(fundingRounds.id, trendingRounds.roundId))
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    .where(and(gt(trendingRounds.firstSeenAt, since), inArray(fundingRounds.disposition, ["publish", "flagged"])))
    .orderBy(desc(trendingRounds.firstSeenAt));
  // A round re-dated to long before it was taken up is not searched again: its conversation is over.
  const kept = rows.filter(({ t, r }) => !announcedBeforeFollow(r.announcedOn, t.firstSeenAt));
  const leads = await leadInvestorNames(
    handle,
    kept.map(({ t }) => t.roundId),
  );
  return kept.map(({ t, r, c }) => ({
    roundId: t.roundId,
    companyId: c.id,
    name: c.name,
    domain: c.domain,
    website: c.website ?? (c.domain ? `https://${c.domain}` : null),
    firstSeenAt: t.firstSeenAt.toISOString(),
    announced: r.announcedOn ?? isoDay(t.firstSeenAt),
    amounts: amountTokens({
      asWritten: r.amountAsWritten,
      value: r.amountValue === null ? null : Number(r.amountValue),
      currency: r.amountCurrency,
      usdMillions: r.amountUsdMillions === null ? null : Number(r.amountUsdMillions),
    }),
    checkpoints: t.checkpoints,
    xHandle: t.xHandle,
    xHandleSource: t.xHandleSource,
    handleCheckedAt: t.handleCheckedAt?.toISOString() ?? null,
    hnCheckedAt: t.hnCheckedAt?.toISOString() ?? null,
    description: c.description,
    leadInvestors: leads.get(t.roundId) ?? [],
  }));
}

/**
 * The company's handle as another followed round already found it this month, so a company with
 * two rounds in the window pays for one homepage read. Null when no row has looked yet.
 */
export async function knownHandle(
  handle: Db,
  companyId: string,
  now: Date,
): Promise<{ handle: string | null; source: string | null } | null> {
  const [row] = await handle
    .select({ handle: trendingRounds.xHandle, source: trendingRounds.xHandleSource })
    .from(trendingRounds)
    .where(
      and(
        eq(trendingRounds.companyId, companyId),
        isNotNull(trendingRounds.handleCheckedAt),
        gt(trendingRounds.handleCheckedAt, new Date(now.getTime() - HANDLE_REUSE_DAYS * 24 * HOUR)),
      ),
    )
    .orderBy(desc(trendingRounds.handleCheckedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Store one round's search: every hit upserted by status id (a later query's relevant reading wins,
 * the likes already read are kept), the handle, and the checkpoint. `checkpoint` is the index that
 * just ran, so the next is due only when its hour comes.
 */
export async function storeSearch(
  handle: Db,
  roundId: string,
  search: Pick<RoundXSearch, "hits" | "handle">,
  checkpoint: number,
  now: Date,
  handleChecked: boolean,
): Promise<void> {
  const rows = search.hits.map((h) => ({
    roundId,
    postKey: h.statusId ?? `profile:${h.handle}`,
    kind: h.kind,
    statusId: h.statusId,
    handle: h.handle,
    authorName: h.name,
    url: h.url,
    snippet: h.snippet,
    postedAt: h.postedAt,
    relevant: h.relevant,
    nameHit: h.nameHit,
    amountHit: h.amountHit,
    isSelf: h.self,
    queries: h.queries,
  }));
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await handle
      .insert(trendingPosts)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [trendingPosts.roundId, trendingPosts.postKey],
        set: {
          relevant: sql`${trendingPosts.relevant} or excluded.relevant`,
          nameHit: sql`${trendingPosts.nameHit} or excluded.name_hit`,
          amountHit: sql`${trendingPosts.amountHit} or excluded.amount_hit`,
          isSelf: sql`excluded.is_self`,
          authorName: sql`coalesce(excluded.author_name, ${trendingPosts.authorName})`,
          postedAt: sql`coalesce(${trendingPosts.postedAt}, excluded.posted_at)`,
          queries: sql`(select coalesce(jsonb_agg(distinct q), '[]'::jsonb) from jsonb_array_elements_text(${trendingPosts.queries} || excluded.queries) q)`,
        },
      });
  }
  await handle
    .update(trendingRounds)
    .set({
      checkpoints: sql`greatest(${trendingRounds.checkpoints}, ${checkpoint + 1})`,
      searchedAt: now,
      ...(handleChecked
        ? { xHandle: search.handle?.handle ?? null, xHandleSource: search.handle?.source ?? "none", handleCheckedAt: now }
        : search.handle
          ? { xHandle: search.handle.handle, xHandleSource: search.handle.source }
          : {}),
      updatedAt: now,
    })
    .where(eq(trendingRounds.roundId, roundId));
}

/** Store a round's Hacker News stories and when they were read. */
export async function storeHn(handle: Db, roundId: string, stories: TrendingHnStory[], now: Date): Promise<void> {
  await handle.update(trendingRounds).set({ hn: stories, hnCheckedAt: now, updatedAt: now }).where(eq(trendingRounds.roundId, roundId));
}

/** Whether a followed round's Hacker News read is due: never read, or read over three hours ago. */
export function hnDue(r: Pick<FollowedRound, "hnCheckedAt">, now: Date): boolean {
  return !r.hnCheckedAt || now.getTime() - new Date(r.hnCheckedAt).getTime() >= HN_REFRESH_HOURS * HOUR;
}

/** Press hosts never count X itself: a post is the X signal's, not an outlet's. */
const NOT_PRESS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "news.ycombinator.com"]);

/** When each press host first carried a round: the earlier of its fetch and its published day at noon UTC. */
async function pressHosts(handle: Db, roundIds: string[]): Promise<Map<string, Date[]>> {
  const out = new Map<string, Date[]>();
  if (roundIds.length === 0) return out;
  const rows = await handle
    .select({ roundId: roundSources.roundId, host: sources.host, fetchedAt: sources.fetchedAt, publishedAt: sources.publishedAt })
    .from(roundSources)
    .innerJoin(sources, eq(sources.id, roundSources.sourceId))
    .where(inArray(roundSources.roundId, roundIds));
  const first = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const host = r.host.replace(/^www\./, "");
    if (NOT_PRESS.has(host)) continue;
    const day = r.publishedAt ? /^(\d{4}-\d{2}-\d{2})/.exec(r.publishedAt)?.[1] : undefined;
    const published = day ? new Date(`${day}T12:00:00Z`).getTime() : Number.POSITIVE_INFINITY;
    const t = Math.min(r.fetchedAt.getTime(), Number.isFinite(published) ? published : r.fetchedAt.getTime());
    const hosts = first.get(r.roundId) ?? new Map<string, number>();
    hosts.set(host, Math.min(hosts.get(host) ?? Number.POSITIVE_INFINITY, t));
    first.set(r.roundId, hosts);
  }
  for (const [id, hosts] of first)
    out.set(
      id,
      [...hosts.values()].map((t) => new Date(t)),
    );
  return out;
}

/** Investor names per round, for the outlet filter's exception (a lead's own account is a person). */
async function investorNames(handle: Db, roundIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (roundIds.length === 0) return out;
  const rows = await handle
    .select({ roundId: roundInvestors.roundId, name: investors.name })
    .from(roundInvestors)
    .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
    .where(inArray(roundInvestors.roundId, roundIds));
  for (const r of rows) out.set(r.roundId, [...(out.get(r.roundId) ?? []), r.name]);
  return out;
}

/** Lead investor names per round: one of the stale check's signs that a post means this company. */
async function leadInvestorNames(handle: Db, roundIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (roundIds.length === 0) return out;
  const rows = await handle
    .select({ roundId: roundInvestors.roundId, name: investors.name })
    .from(roundInvestors)
    .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
    .where(and(inArray(roundInvestors.roundId, roundIds), eq(roundInvestors.role, "lead")));
  for (const r of rows) out.set(r.roundId, [...(out.get(r.roundId) ?? []), r.name]);
  return out;
}

/**
 * Announced more than a week before the lane took the round up: the rule followRounds applies at
 * the door, applied again to a round whose day moved back after it was followed.
 */
export function announcedBeforeFollow(announcedOn: string | null, firstSeenAt: Date): boolean {
  if (!announcedOn) return false;
  return announcedOn < isoDay(new Date(firstSeenAt.getTime() - ANNOUNCED_WITHIN_DAYS * 24 * HOUR));
}

/** Accounts on too many recent rounds to be talking about any one: the aggregator half of the outlet filter. */
export async function frequentHandles(handle: Db, now: Date): Promise<Set<string>> {
  const since = new Date(now.getTime() - FREQUENT_LOOKBACK_DAYS * 24 * HOUR);
  const [perHandle, [searched]] = await Promise.all([
    handle
      .select({ handle: trendingPosts.handle, n: sql<number>`count(distinct ${trendingPosts.roundId})::int` })
      .from(trendingPosts)
      .where(and(eq(trendingPosts.relevant, true), isNotNull(trendingPosts.handle), gt(trendingPosts.firstSeenAt, since)))
      .groupBy(trendingPosts.handle),
    handle
      .select({ n: sql<number>`count(*)::int` })
      .from(trendingRounds)
      .where(and(isNotNull(trendingRounds.searchedAt), gt(trendingRounds.searchedAt, since))),
  ]);
  return frequentAccounts(new Map(perHandle.map((r) => [r.handle as string, r.n])), searched?.n ?? 0);
}

export interface RescoreSummary {
  scored: number;
  labelled: string[];
  stale: number;
  people: number;
}

/**
 * The hourly rescore: every round still inside its 72 hours, from the posts, press sources, and
 * Hacker News stories on record, with no Firecrawl call. Outlet flags on the posts are refreshed
 * (an account becomes an aggregator as it turns up on more rounds), then the score, the stale
 * verdict, the rank, and the label are written back. Rounds past their window lose rank and label.
 */
export async function rescore(handle: Db, now: Date): Promise<RescoreSummary> {
  const since = new Date(now.getTime() - TRENDING_WINDOW_HOURS * HOUR);
  await handle
    .update(trendingRounds)
    .set({ rank: null, label: false, updatedAt: now })
    .where(and(sql`${trendingRounds.firstSeenAt} <= ${since}`, sql`(${trendingRounds.rank} is not null or ${trendingRounds.label})`));
  const followed = await handle
    .select({
      t: trendingRounds,
      announcedOn: fundingRounds.announcedOn,
      amountValue: fundingRounds.amountValue,
      amountCurrency: fundingRounds.amountCurrency,
      name: companies.name,
      domain: companies.domain,
      description: companies.description,
    })
    .from(trendingRounds)
    .innerJoin(fundingRounds, eq(fundingRounds.id, trendingRounds.roundId))
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    .where(and(gt(trendingRounds.firstSeenAt, since), inArray(fundingRounds.disposition, ["publish", "flagged"])));
  // A round re-dated to well before it was first seen (a repair, a corrected read-back) is old news the
  // lane would not have taken up: it leaves Trending, and the stale flag that pointed at its date clears.
  const aged = followed.filter((r) => announcedBeforeFollow(r.announcedOn, r.t.firstSeenAt));
  for (const r of aged) {
    await handle
      .update(trendingRounds)
      .set({ rank: null, label: false, score: 0, stale: false, staleReason: null, scoredAt: now, updatedAt: now })
      .where(eq(trendingRounds.roundId, r.t.roundId));
  }
  const rows = followed.filter((r) => !aged.includes(r));
  if (rows.length === 0) return { scored: 0, labelled: [], stale: 0, people: 0 };
  const ids = rows.map((r) => r.t.roundId);
  const [posts, press, names, leads, frequent] = await Promise.all([
    handle.select().from(trendingPosts).where(inArray(trendingPosts.roundId, ids)),
    pressHosts(handle, ids),
    investorNames(handle, ids),
    leadInvestorNames(handle, ids),
    frequentHandles(handle, now),
  ]);
  const postsByRound = new Map<string, (typeof posts)[number][]>();
  for (const p of posts) postsByRound.set(p.roundId, [...(postsByRound.get(p.roundId) ?? []), p]);

  const computed = rows.map(({ t, announcedOn, amountValue, amountCurrency, name, domain, description }) => {
    const list = postsByRound.get(t.roundId) ?? [];
    const invest = names.get(t.roundId) ?? [];
    const outletHandles = new Set<string>();
    const earliest = new Map<string, number>();
    const outletAuthors = new Set<string>();
    for (const p of list) {
      const outlet = isOutletAccount(p.handle, p.authorName, frequent, invest);
      if (outlet && p.handle) outletHandles.add(p.handle);
      if (!p.relevant || !p.handle || !p.postedAt) continue;
      if (outlet) {
        outletAuthors.add(p.handle);
        continue;
      }
      earliest.set(p.handle, Math.min(earliest.get(p.handle) ?? Number.POSITIVE_INFINITY, p.postedAt.getTime()));
    }
    const announced = announcedOn ?? isoDay(t.firstSeenAt);
    const verdict = staleCheck(
      staleReadings(list, {
        name,
        handle: t.xHandle,
        domain,
        leadInvestors: leads.get(t.roundId) ?? [],
        description,
        amount: { value: amountValue === null ? null : Number(amountValue), currency: amountCurrency },
      }),
      announced,
    );
    const outletTimes = press.get(t.roundId) ?? [];
    const hn = (t.hn ?? []).map((s) => ({ points: s.points, at: new Date(s.at) }));
    const s = verdict.stale
      ? { score: 0, x: 0, press: 0, hn: 0 }
      : trendingScore({ people: [...earliest.values()].map((ms) => new Date(ms)), outlets: outletTimes, hn }, now);
    return {
      roundId: t.roundId,
      firstSeenAt: t.firstSeenAt,
      outletHandles: [...outletHandles],
      people: earliest.size,
      outletAccounts: outletAuthors.size,
      outlets: outletTimes.length,
      hnPoints: hn.reduce((n, h) => n + h.points, 0),
      stale: verdict.stale,
      staleReason: verdict.reason,
      score: s,
    };
  });

  const { rank, labelled } = labelRounds(
    computed.map((c) => ({
      roundId: c.roundId,
      score: c.score.score,
      stale: c.stale,
      firstSeenAt: c.firstSeenAt,
      people: c.people,
      outlets: c.outlets,
    })),
    now,
  );
  for (const c of computed) {
    await handle
      .update(trendingPosts)
      .set({
        isOutlet: c.outletHandles.length
          ? sql`coalesce(${trendingPosts.handle} in (${sql.join(
              c.outletHandles.map((h) => sql`${h}`),
              sql`, `,
            )}), false)`
          : false,
      })
      .where(eq(trendingPosts.roundId, c.roundId));
    await handle
      .update(trendingRounds)
      .set({
        people: c.people,
        outletAccounts: c.outletAccounts,
        outlets: c.outlets,
        hnPoints: c.hnPoints,
        score: c.score.score,
        signals: { x: c.score.x, press: c.score.press, hn: c.score.hn },
        rank: rank.get(c.roundId) ?? null,
        label: labelled.has(c.roundId),
        stale: c.stale,
        staleReason: c.staleReason,
        scoredAt: now,
        updatedAt: now,
      })
      .where(eq(trendingRounds.roundId, c.roundId));
  }
  return {
    scored: computed.length,
    labelled: [...labelled],
    stale: computed.filter((c) => c.stale).length,
    people: computed.reduce((n, c) => n + c.people, 0),
  };
}

/** A post the showcase reads for likes and reposts, with what it needs to judge the post's own words. */
export interface ShowcaseTarget {
  roundId: string;
  postKey: string;
  url: string;
  /** Posted by the company's own account: its words stand for the round without naming it. */
  self: boolean;
  subject: Pick<RoundSubject, "name" | "aliases" | "handle" | "amounts">;
}

/**
 * For each labelled round, the posts worth showing with their likes: the company's own
 * announcement first, then its founders' and investors' accounts, then everyone else, earliest
 * first (the first posts are the ones others repost). Outlets are left out. Only posts not read in
 * the last six hours are returned, so a post is paid for at most four times a day.
 */
export async function showcaseTargets(handle: Db, roundIds: string[], now: Date): Promise<ShowcaseTarget[]> {
  if (roundIds.length === 0) return [];
  const [posts, names, founders, subjects] = await Promise.all([
    handle
      .select()
      .from(trendingPosts)
      .where(
        and(
          inArray(trendingPosts.roundId, roundIds),
          eq(trendingPosts.relevant, true),
          eq(trendingPosts.kind, "post"),
          eq(trendingPosts.isOutlet, false),
        ),
      ),
    investorNames(handle, roundIds),
    founderNames(handle, roundIds),
    handle
      .select({ t: trendingRounds, r: fundingRounds, name: companies.name })
      .from(trendingRounds)
      .innerJoin(fundingRounds, eq(fundingRounds.id, trendingRounds.roundId))
      .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
      .where(inArray(trendingRounds.roundId, roundIds)),
  ]);
  const subjectOfRound = new Map(
    subjects.map(({ t, r, name }) => [
      t.roundId,
      {
        name,
        aliases: nameAliases(name),
        handle: t.xHandle,
        amounts: amountTokens({
          asWritten: r.amountAsWritten,
          value: r.amountValue === null ? null : Number(r.amountValue),
          currency: r.amountCurrency,
          usdMillions: r.amountUsdMillions === null ? null : Number(r.amountUsdMillions),
        }),
      },
    ]),
  );
  const out: ShowcaseTarget[] = [];
  for (const id of roundIds) {
    const people = [...(names.get(id) ?? []), ...(founders.get(id) ?? [])];
    const picked = pickDisplayPosts(
      posts.filter((p) => p.roundId === id),
      people,
    ).slice(0, SHOWCASE_POSTS);
    for (const p of picked) {
      if (p.engagementAt && now.getTime() - p.engagementAt.getTime() < ENGAGEMENT_REFRESH_HOURS * HOUR) continue;
      const subject = subjectOfRound.get(id);
      if (subject) out.push({ roundId: id, postKey: p.postKey, url: p.url, self: p.isSelf, subject });
    }
  }
  return out;
}

/** YC founders from Alexandria, by round, so a founder's post ranks with the company's own. */
async function founderNames(handle: Db, roundIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const rows = await handle
    .select({ roundId: fundingRounds.id, data: enrichments.data })
    .from(fundingRounds)
    .innerJoin(enrichments, and(eq(enrichments.companyId, fundingRounds.companyId), eq(enrichments.kind, "alexandria")))
    .where(inArray(fundingRounds.id, roundIds));
  for (const r of rows) {
    const yc = (r.data as { yc?: { status?: string; founders?: Array<{ name?: string }> } } | null)?.yc;
    const list = yc?.status === "matched" ? (yc.founders ?? []).map((f) => f.name).filter((n): n is string => !!n) : [];
    out.set(r.roundId, list);
  }
  return out;
}

type PostRow = typeof trendingPosts.$inferSelect;

/**
 * The display order for a round's posts: the company's own first, then accounts named like one of
 * `people` (its investors and founders), then posts with likes read (most first), then the rest,
 * earliest first. One post per author, so three posts are three voices.
 */
export function pickDisplayPosts<T extends Pick<PostRow, "handle" | "authorName" | "isSelf" | "postedAt" | "likes" | "postKey">>(
  posts: T[],
  people: readonly string[],
): T[] {
  const tier = (p: T) => (p.isSelf ? 0 : p.authorName && people.some((n) => sameName(p.authorName as string, n)) ? 1 : 2);
  const sorted = [...posts].sort(
    (a, b) =>
      tier(a) - tier(b) ||
      (b.likes ?? -1) - (a.likes ?? -1) ||
      (a.postedAt?.getTime() ?? Number.POSITIVE_INFINITY) - (b.postedAt?.getTime() ?? Number.POSITIVE_INFINITY) ||
      a.postKey.localeCompare(b.postKey),
  );
  const seen = new Set<string>();
  return sorted.filter((p) => {
    const who = p.handle ?? p.postKey;
    if (seen.has(who)) return false;
    seen.add(who);
    return true;
  });
}

/** A post read through the X scrape: its likes, reposts, and the post's own words for the snippet. */
export async function storeEngagement(
  handle: Db,
  target: Pick<ShowcaseTarget, "roundId" | "postKey">,
  read: { likes: number | null; reposts: number | null; text: string | null },
  now: Date,
): Promise<void> {
  const text = read.text?.replace(/\s+/g, " ").trim();
  await handle
    .update(trendingPosts)
    .set({
      likes: read.likes,
      reposts: read.reposts,
      engagementAt: now,
      ...(text ? { snippet: text.length > 280 ? `${text.slice(0, 279).trimEnd()}…` : text } : {}),
    })
    .where(and(eq(trendingPosts.roundId, target.roundId), eq(trendingPosts.postKey, target.postKey)));
}

// Estimates. Measured in the spike: a name or handle query returned 20 results (4 credits) about
// four times in five and fewer (2 credits) otherwise, 3.4 on average.

/** One search at the lane's limit, the rate-card ceiling. */
export const X_QUERY_CREDITS = searchCredits(X_SEARCH_LIMIT);

/** What a run is expected to spend before it starts: the searches due, the handle lookups, and the showcase reads. */
export function estimateRun(due: Array<Pick<FollowedRound, "xHandle" | "handleCheckedAt" | "amounts">>, showcaseReads: number): number {
  let credits = 0;
  for (const r of due) {
    const queries = 1 + (r.amounts.length > 0 ? 1 : 0) + (r.xHandle || !r.handleCheckedAt ? 1 : 0);
    credits += queries * X_QUERY_CREDITS + (r.handleCheckedAt ? 0 : HANDLE_LOOKUP_CREDITS);
  }
  return credits + showcaseReads * X_POST_READ_CREDITS;
}

// Reads.

/** What a row wears in the feed and the API. */
export interface TrendingMark {
  label: boolean;
  rank: number | null;
  score: number;
  people: number;
  outlets: number;
  hn_points: number;
  /** "14 people on X · 6 outlets · HN 3 pts" */
  summary: string;
  scored_at: string | null;
}

function toMark(t: typeof trendingRounds.$inferSelect): TrendingMark {
  return {
    label: t.label,
    rank: t.rank,
    score: Math.round(t.score * 1000) / 1000,
    people: t.people,
    outlets: t.outlets,
    hn_points: t.hnPoints,
    summary: trendingSummary({ people: t.people, outlets: t.outlets, hnPoints: t.hnPoints }),
    scored_at: t.scoredAt?.toISOString() ?? null,
  };
}

/** The live marks for these rounds: in their window, scored, not stale. A round without one reads null. */
export async function trendingMarks(handle: Db, roundIds: string[], now: Date = new Date()): Promise<Map<string, TrendingMark>> {
  const out = new Map<string, TrendingMark>();
  if (roundIds.length === 0) return out;
  const since = new Date(now.getTime() - TRENDING_WINDOW_HOURS * HOUR);
  const rows = await handle
    .select()
    .from(trendingRounds)
    .where(
      and(
        inArray(trendingRounds.roundId, roundIds),
        gt(trendingRounds.firstSeenAt, since),
        eq(trendingRounds.stale, false),
        isNotNull(trendingRounds.scoredAt),
      ),
    );
  for (const t of rows) out.set(t.roundId, toMark(t));
  return out;
}

/**
 * The Buzz column's inputs for one page of rows: each row's live mark and the scale its meter is
 * read against (the quantiles of every scored round in the window, lib/buzz.ts). Two queries for
 * the whole page, never one per row; the window is a few hundred rounds at most. Each mark's rank
 * is re-read from the same list, in the Trending view's order, so a round that left the window
 * since the last rescore does not leave a gap in the ranks the view prints.
 */
export async function buzzFor(
  handle: Db,
  roundIds: string[],
  now: Date = new Date(),
): Promise<{ marks: Record<string, TrendingMark>; scale: BuzzScale }> {
  if (roundIds.length === 0) return { marks: {}, scale: EMPTY_SCALE };
  const since = new Date(now.getTime() - TRENDING_WINDOW_HOURS * HOUR);
  const [marks, scores] = await Promise.all([
    trendingMarks(handle, roundIds, now),
    handle
      .select({ id: trendingRounds.roundId, score: trendingRounds.score })
      .from(trendingRounds)
      .innerJoin(fundingRounds, eq(fundingRounds.id, trendingRounds.roundId))
      .where(
        and(
          gt(trendingRounds.firstSeenAt, since),
          eq(trendingRounds.stale, false),
          gt(trendingRounds.score, 0),
          inArray(fundingRounds.disposition, ["publish", "flagged"]),
        ),
      )
      .orderBy(desc(trendingRounds.score), desc(trendingRounds.roundId)),
  ]);
  scores.forEach((r, i) => {
    const mark = marks.get(r.id);
    if (mark) mark.rank = i + 1;
  });
  return { marks: Object.fromEntries(marks), scale: buzzScale(scores.map((r) => Number(r.score))) };
}

/** The rounds labelled at the last rescore and still inside their window. */
export async function labelledRoundIds(handle: Db, now: Date): Promise<string[]> {
  const since = new Date(now.getTime() - TRENDING_WINDOW_HOURS * HOUR);
  const rows = await handle
    .select({ id: trendingRounds.roundId })
    .from(trendingRounds)
    .where(and(eq(trendingRounds.label, true), gt(trendingRounds.firstSeenAt, since)));
  return rows.map((r) => r.id);
}

/** The trending order: rounds in their window, not stale, with a score, best first; never a history row. */
export async function trendingRoundIds(handle: Db, now: Date = new Date(), limit = TRENDING_LIST_MAX): Promise<string[]> {
  const since = new Date(now.getTime() - TRENDING_WINDOW_HOURS * HOUR);
  const rows = await handle
    .select({ id: trendingRounds.roundId })
    .from(trendingRounds)
    .innerJoin(fundingRounds, eq(fundingRounds.id, trendingRounds.roundId))
    .where(
      and(
        gt(trendingRounds.firstSeenAt, since),
        eq(trendingRounds.stale, false),
        gt(trendingRounds.score, 0),
        inArray(fundingRounds.disposition, ["publish", "flagged"]),
        eq(fundingRounds.history, false),
      ),
    )
    .orderBy(desc(trendingRounds.score), desc(trendingRounds.roundId))
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * One page of the feed in trending order under the feed's own filters. The trending set is small
 * (a few hundred rounds at most), so it is read whole, filtered through the same query the feed
 * uses, and paged in memory.
 */
export async function listTrending(
  handle: Db,
  q: Omit<RoundQuery, "sort" | "cursor" | "offset" | "limit" | "ids">,
  page: { offset: number; limit: number },
  now: Date = new Date(),
): Promise<{ rows: RoundRow[]; total: number }> {
  const ids = await trendingRoundIds(handle, now);
  if (ids.length === 0) return { rows: [], total: 0 };
  const { rows } = await listRounds(handle, { ...q, ids, limit: TRENDING_LIST_MAX });
  const order = new Map(ids.map((id, i) => [id, i]));
  const sorted = rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { rows: sorted.slice(page.offset, page.offset + page.limit), total: sorted.length };
}

/** A post as the "On X" block shows it. */
export interface DisplayPost {
  url: string;
  handle: string | null;
  author: string | null;
  snippet: string;
  posted_at: string | null;
  likes: number | null;
  reposts: number | null;
  self: boolean;
}

export interface RoundOnX {
  round_id: string;
  posts: DisplayPost[];
  people: number;
  outlets: number;
  hn_points: number;
  label: boolean;
  /** For an admin only: why the lane suppressed this round and flagged its date. */
  stale_reason: string | null;
}

/**
 * The company page's "On X" block: for each of these rounds with relevant posts, up to three
 * (the company's own, then its investors' and founders', then the most liked or earliest), and the
 * counts. Not limited to the window: a round keeps its posts after it leaves Trending.
 */
export async function roundsOnX(handle: Db, roundIds: string[]): Promise<RoundOnX[]> {
  if (roundIds.length === 0) return [];
  const [tRows, posts, names, founders] = await Promise.all([
    handle.select().from(trendingRounds).where(inArray(trendingRounds.roundId, roundIds)),
    handle
      .select()
      .from(trendingPosts)
      .where(and(inArray(trendingPosts.roundId, roundIds), eq(trendingPosts.relevant, true), eq(trendingPosts.isOutlet, false))),
    investorNames(handle, roundIds),
    founderNames(handle, roundIds),
  ]);
  const out: RoundOnX[] = [];
  for (const id of roundIds) {
    const t = tRows.find((r) => r.roundId === id);
    const list = posts.filter((p) => p.roundId === id && p.kind === "post");
    if (!t || (list.length === 0 && !t.stale)) continue;
    const picked = pickDisplayPosts(list, [...(names.get(id) ?? []), ...(founders.get(id) ?? [])]).slice(0, SHOWCASE_POSTS);
    out.push({
      round_id: id,
      posts: picked.map((p) => ({
        url: p.url,
        handle: p.handle,
        author: p.authorName,
        snippet: p.snippet,
        posted_at: p.postedAt?.toISOString() ?? null,
        likes: p.likes,
        reposts: p.reposts,
        self: p.isSelf,
      })),
      people: t.people,
      outlets: t.outlets,
      hn_points: t.hnPoints,
      label: t.label,
      stale_reason: t.stale ? t.staleReason : null,
    });
  }
  return out;
}

/** How many relevant X posts each round has on record: the Built with strip's X step. */
export async function xPostCounts(handle: Db, roundIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (roundIds.length === 0) return out;
  const rows = await handle
    .select({ roundId: trendingPosts.roundId, n: sql<number>`count(*)::int` })
    .from(trendingPosts)
    .where(and(inArray(trendingPosts.roundId, roundIds), eq(trendingPosts.relevant, true)))
    .groupBy(trendingPosts.roundId);
  for (const r of rows) out.set(r.roundId, r.n);
  return out;
}

/**
 * The overview's Trending panel: the lane's top rounds under an optional preset, each with its
 * mark, and how many rounds the Trending view lists under the same preset.
 */
export async function trendingTop(
  handle: Db,
  limit: number,
  preset?: string,
  now: Date = new Date(),
): Promise<{ rounds: Array<RoundRow & { trending: TrendingMark }>; total: number }> {
  const { rows, total } = await listTrending(handle, { preset }, { offset: 0, limit }, now);
  const marks = await trendingMarks(
    handle,
    rows.map((r) => r.id),
    now,
  );
  return {
    rounds: rows.flatMap((r) => {
      const trending = marks.get(r.id);
      return trending ? [{ ...r, trending }] : [];
    }),
    total,
  };
}
