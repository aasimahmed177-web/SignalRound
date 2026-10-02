// Hacker News for the Trending lane: Algolia's public search API (free, no key), stories posted
// from two days before the announcement to five after, kept when the title names the company and
// reads as funding news. https://hn.algolia.com/api

import { hnStoryMatches, type RoundSubject } from "./signals.ts";

export interface HnStory {
  id: string;
  title: string;
  url: string | null;
  points: number;
  comments: number;
  at: string;
}

interface AlgoliaHit {
  objectID: string;
  title?: string | null;
  url?: string | null;
  points?: number | null;
  num_comments?: number | null;
  created_at?: string;
}

/** Stories about this round on Hacker News, best first. A failed request is no stories, not an error: HN is a bonus signal. */
export async function hnStories(
  subject: Pick<RoundSubject, "name" | "aliases" | "announced">,
  domain: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<HnStory[]> {
  const t0 = Math.floor(new Date(`${subject.announced}T00:00:00Z`).getTime() / 1000);
  const lo = t0 - 2 * 86_400;
  const hi = t0 + 5 * 86_400;
  const queries = [...new Set([subject.name, domain].filter((q): q is string => !!q))];
  const hits = new Map<string, AlgoliaHit>();
  for (const q of queries) {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&numericFilters=${encodeURIComponent(`created_at_i>${lo},created_at_i<${hi}`)}&hitsPerPage=50`;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const body = (await res.json()) as { hits?: AlgoliaHit[] };
      for (const h of body.hits ?? []) hits.set(h.objectID, h);
    } catch {
      // A timeout or a refused request leaves this query out; the next run asks again.
    }
  }
  return [...hits.values()]
    .filter((h) => hnStoryMatches({ title: h.title ?? null, url: h.url ?? null }, subject, domain))
    .map((h) => ({
      id: h.objectID,
      title: h.title ?? "",
      url: h.url ?? null,
      points: h.points ?? 0,
      comments: h.num_comments ?? 0,
      at: h.created_at ?? new Date(t0 * 1000).toISOString(),
    }))
    .sort((a, b) => b.points - a.points);
}
