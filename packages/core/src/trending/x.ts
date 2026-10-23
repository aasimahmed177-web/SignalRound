// The Trending layer's NativeWebClient calls: X search for one round (search restricted to x.com, then
// every result dated by its status id), the company's handle from its homepage links, and one
// post read through NativeWebClient's X scrape for its likes and reposts. The announcements lane also
// searches X's own index through Alexandria's X provider, which sees a post minutes after it is posted.
// https://docs.firecrawl.dev/features/search and https://docs.firecrawl.dev/features/scrape

import { mapLimit, RATE, searchCredits } from "../firecrawl/credits.ts";
import type { NativeWebClient, SearchResultWeb } from "../web/client.ts";
import {
  type AnnouncementLead,
  bioFromProfile,
  type LeadRejection,
  leadArticleQuery,
  pickCorroboration,
  readAnnouncement,
  X_ANNOUNCEMENT_LIMIT,
  X_ANNOUNCEMENT_QUERIES,
} from "./announcements.ts";
import {
  type Classified,
  chooseHandle,
  classifyX,
  handlesFromLinks,
  parseXPost,
  parseXResult,
  type RoundSubject,
  type XPostRead,
  type XQuery,
  type XQueryKey,
  type XResult,
  xQueries,
} from "./signals.ts";

/** Results a query asks for: one search at the 20-result rate, 4 credits. */
export const X_SEARCH_LIMIT = 20;
/** A homepage read for its links only: the base page, 1 credit. */
export const HANDLE_LOOKUP_CREDITS = RATE.scrapePage;
/** One post read through the X scrape (Grok): 1 base plus 29 for the X query. */
export const X_POST_READ_CREDITS = RATE.xProfileRequest;

export interface XHit extends XResult, Classified {
  /** Which of the round's queries returned it. */
  queries: XQueryKey[];
}

export interface XSearchCall {
  key: XQueryKey;
  q: string;
  results: number;
  credits: number;
  error: string | null;
}

export interface RoundXSearch {
  hits: XHit[];
  handle: { handle: string; source: "homepage" | "search" } | null;
  calls: XSearchCall[];
  credits: number;
}

async function runQuery(client: NativeWebClient, query: XQuery): Promise<{ call: XSearchCall; web: SearchResultWeb[] }> {
  try {
    const res = await client.search(query.q, { limit: X_SEARCH_LIMIT, tbs: query.tbs, sources: ["web"] });
    const web = (res.web ?? []).filter((w): w is SearchResultWeb => typeof (w as SearchResultWeb).url === "string");
    // Search bills per ten results returned, so the count is the measurement.
    return { call: { key: query.key, q: query.q, results: web.length, credits: searchCredits(web.length), error: null }, web };
  } catch (e) {
    return { call: { key: query.key, q: query.q, results: 0, credits: 0, error: e instanceof Error ? e.message : String(e) }, web: [] };
  }
}

/** The company's handle going into a search: one an earlier checkpoint verified, or unverified candidates from its homepage. */
export interface HandleInput {
  verified: { handle: string; source: "homepage" | "search" } | null;
  candidates: readonly string[];
}

/**
 * One round's X search. The name queries run first; their results can verify a homepage handle
 * (or name one when the homepage had none), and only a verified handle gets the third query.
 * Every result is parsed, deduped by status id (a profile hit by its account), and classified.
 */
export async function searchRoundOnX(
  client: NativeWebClient,
  subject: Omit<RoundSubject, "handle">,
  handles: HandleInput,
  searchedAt: Date = new Date(),
): Promise<RoundXSearch> {
  const base: RoundSubject = { ...subject, handle: null };
  const first = await mapLimit(xQueries(base, false), 2, (q) => runQuery(client, q));
  const parsed = (web: SearchResultWeb[]) => web.map((w) => parseXResult(w, searchedAt)).filter((r): r is XResult => r !== null);
  const early = first.flatMap((f) => parsed(f.web));
  const handle = handles.verified ?? chooseHandle(handles.candidates, subject.name, early);
  const withHandle: RoundSubject = { ...base, handle: handle?.handle ?? null };
  const handleQuery = xQueries(withHandle, true).find((q) => q.key === "handle_fund");
  const third = handleQuery ? [await runQuery(client, handleQuery)] : [];

  const hits = new Map<string, XHit>();
  for (const { call, web } of [...first, ...third]) {
    for (const r of parsed(web)) {
      const key = r.statusId ?? `profile:${r.handle}`;
      const prev = hits.get(key);
      const c = classifyX(r, withHandle);
      if (prev) {
        if (!prev.queries.includes(call.key)) prev.queries.push(call.key);
        // A second query's snippet can carry the amount or the name the first one cut.
        if (c.relevant && !prev.relevant) Object.assign(prev, { ...r, ...c, queries: prev.queries });
        continue;
      }
      hits.set(key, { ...r, ...c, queries: [call.key] });
    }
  }
  const calls = [...first, ...third].map((f) => f.call);
  return { hits: [...hits.values()], handle, calls, credits: calls.reduce((n, c) => n + c.credits, 0) };
}

/** X handles linked from the company's homepage (links only, 1 credit), status links excluded. */
export async function homepageHandles(
  client: NativeWebClient,
  website: string,
): Promise<{ handles: string[]; credits: number; error: string | null }> {
  try {
    const doc = await client.scrape(website, { formats: ["links"], onlyMainContent: false, timeout: 30_000 });
    return { handles: handlesFromLinks(doc.links ?? []), credits: doc.metadata?.creditsUsed ?? HANDLE_LOOKUP_CREDITS, error: null };
  } catch (e) {
    return { handles: [], credits: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One post through NativeWebClient's X scrape: likes and reposts (views and replies are not reliable there). */
export async function readXPost(
  client: NativeWebClient,
  url: string,
): Promise<{ post: XPostRead | null; credits: number; error: string | null }> {
  try {
    const doc = await client.scrape(url, { formats: ["markdown"], timeout: 60_000 });
    const md = doc.markdown ?? "";
    return { post: md ? parseXPost(md) : null, credits: doc.metadata?.creditsUsed ?? X_POST_READ_CREDITS, error: null };
  } catch (e) {
    return { post: null, credits: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface AnnouncementSearch {
  leads: AnnouncementLead[];
  /** Why the rest were not leads, counted. */
  rejected: Partial<Record<LeadRejection, number>>;
  calls: Array<{ key: string; results: number; leads: number; credits: number; error: string | null }>;
  credits: number;
}

/**
 * The lane's searches for funding posts, all at once (NativeWebClient allows far more concurrent requests
 * than eight), every result read into a lead or a reason it is not one; a post two searches return
 * is one lead.
 */
export async function searchAnnouncements(
  client: NativeWebClient,
  now: Date = new Date(),
  opts: { queries?: ReadonlyArray<{ key: string; q: string }>; lookbackHours?: number } = {},
): Promise<AnnouncementSearch> {
  const queries = opts.queries ?? X_ANNOUNCEMENT_QUERIES;
  const byKey = new Map<string, AnnouncementLead>();
  const rejected: Partial<Record<LeadRejection, number>> = {};
  const read = (x: XResult, title: string | undefined) => {
    const lead = readAnnouncement(x, title, now, opts.lookbackHours);
    if (typeof lead === "string") {
      rejected[lead] = (rejected[lead] ?? 0) + 1;
      return 0;
    }
    if (!byKey.has(lead.key)) byKey.set(lead.key, lead);
    return 1;
  };
  // Public search only. Authenticated social workers can submit additional observations through /api/v1/signals.
  const calls = await Promise.all(
    queries.map(async ({ key, q }) => {
      try {
        // Newest first: ranked by relevance, the past day's results were mostly profile pages and older
        // posts (2,564 of 3,240 dropped as old over the lane's first 20 runs).
        const res = await client.search(q, { limit: X_ANNOUNCEMENT_LIMIT, tbs: X_ANNOUNCEMENT_TBS, sources: ["web"] });
        const web = (res.web ?? []).filter((w): w is SearchResultWeb => typeof (w as SearchResultWeb).url === "string");
        let leads = 0;
        for (const w of web) {
          const x = parseXResult(w, now);
          if (x) leads += read(x, w.title);
        }
        return { key, results: web.length, leads, credits: searchCredits(web.length), error: null };
      } catch (e) {
        return { key, results: 0, leads: 0, credits: 0, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const all = calls;
  return { leads: [...byKey.values()], rejected, calls: all, credits: all.reduce((n, c) => n + c.credits, 0) };
}

/** The announcement searches' recency: the past day, sorted by date. */
export const X_ANNOUNCEMENT_TBS = "sbd:1,qdr:d";

/** A founder's X profile read for its bio, through NativeWebClient's X scrape: 1 base plus 29 for the X query. */
export const X_PROFILE_READ_CREDITS = RATE.xProfileRequest;

/** One X profile's bio and links, for the check that a founder's account is tied to the company. */
export async function profileBio(
  client: NativeWebClient,
  handle: string,
): Promise<{ bio: string; links: string[]; credits: number; error: string | null }> {
  try {
    const doc = await client.scrape(`https://x.com/${handle}`, { formats: ["markdown", "links"], timeout: 60_000 });
    return {
      bio: bioFromProfile(doc.markdown ?? ""),
      links: doc.links ?? [],
      credits: doc.metadata?.creditsUsed ?? X_PROFILE_READ_CREDITS,
      error: null,
    };
  } catch (e) {
    return { bio: "", links: [], credits: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Results the article search asks for: ten, the rate's smallest step (2 credits). */
export const LEAD_ARTICLE_LIMIT = 10;

/** The search for a lead's article, and the pages worth reading from it (not yet read for this lead). */
export async function searchLeadArticles(
  client: NativeWebClient,
  lead: AnnouncementLead,
  alreadyRead: readonly string[] = [],
): Promise<{ picks: Array<{ url: string; title?: string }>; results: number; credits: number; error: string | null }> {
  const q = leadArticleQuery(lead);
  if (!q) return { picks: [], results: 0, credits: 0, error: null };
  try {
    const res = await client.search(q.q, { limit: LEAD_ARTICLE_LIMIT, tbs: q.tbs, sources: ["news", "web"] });
    const results = [...(res.news ?? []), ...(res.web ?? [])] as Array<{
      url?: string;
      title?: string;
      description?: string;
      snippet?: string;
    }>;
    const read = new Set(alreadyRead);
    const picks = pickCorroboration(
      results.map((r) => ({ url: r.url, title: r.title, description: r.description ?? r.snippet })),
      lead,
    ).filter((p) => !read.has(p.url));
    return { picks, results: results.length, credits: searchCredits(results.length), error: null };
  } catch (e) {
    return { picks: [], results: 0, credits: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
