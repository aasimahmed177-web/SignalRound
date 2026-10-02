// Everything the feed's table reads for one page, in one place, so the page can serve a visitor
// from one shared cache entry (lib/cached.ts cachedFeedPage) and read the same thing fresh for an
// admin. A visitor's bare /feed used to cost some eighteen queries a view; under a launch spike
// that is the difference between a quiet database and a saturated one.

import type { Db } from "@fireround/core/db";
import type { BuzzScale } from "@/lib/buzz";
import type { FeedCertainty } from "@/lib/feed-certainty";
import { storeIsEmpty } from "@/lib/first-run";
import { houseDomain, houseFreshSince, isFreshHouseRound } from "@/lib/house";
import { pageCount } from "@/lib/pages";
import { countRounds, listRounds, type RoundQuery, type RoundRow } from "@/lib/persist";
import type { FeedSort } from "@/lib/round-sort";
import { buzzFor, listTrending, type TrendingMark } from "@/lib/trending";

export interface FeedPageQuery {
  filters: Omit<RoundQuery, "sort" | "cursor" | "offset" | "limit" | "ids"> & { certainty?: FeedCertainty };
  sort: FeedSort;
  /** The 1-based page the URL asked for; a page past the end reads as the last. */
  page: number;
  size: number;
}

export interface FeedPage {
  rows: RoundRow[];
  total: number;
  /** The page shown, after clamping. */
  page: number;
  count: number;
  /** No rounds in the store at all: the first-run panel instead of an empty table. */
  empty: boolean;
  /** The house round (lib/house.ts) on page one while fresh; the caller judges freshness again against its clock. */
  houseRound: RoundRow | null;
  buzz: { marks: Record<string, TrendingMark>; scale: BuzzScale };
}

export async function readFeedPage(handle: Db, { filters, sort, page: requested, size }: FeedPageQuery): Promise<FeedPage> {
  // Trending is the lane's ranked list under the same filters; the other two orders walk the store.
  const trendingPage = (page: number) => listTrending(handle, filters, { offset: (page - 1) * size, limit: size });
  const pageOf = (page: number) =>
    sort === "trending"
      ? trendingPage(page).then(({ rows }) => ({ rows }))
      : listRounds(handle, { ...filters, sort, offset: (page - 1) * size, limit: size });
  // The house round is featured on page one while it is fresh and the filters still admit it.
  const house = houseDomain();
  const houseLookup =
    house && requested === 1
      ? listRounds(handle, { ...filters, company: house, since: houseFreshSince(), limit: 1, history: "exclude" }).then(
          ({ rows }) => rows.find((r) => isFreshHouseRound(r, new Date(), house)) ?? null,
        )
      : Promise.resolve(null);
  const [first, total, empty, houseRound] = await Promise.all([
    pageOf(requested),
    sort === "trending" ? trendingPage(1).then(({ total }) => total) : countRounds(handle, filters),
    storeIsEmpty(handle),
    houseLookup,
  ]);
  // A page past the end (rows were merged away, or a hand-typed URL) shows the last page, not an empty table.
  const count = pageCount(total, size);
  const page = Math.min(requested, count);
  const { rows } = page === requested ? first : await pageOf(page);
  // The Buzz column in both views: each row's counts and the window's quantiles its meter is read against.
  const buzz = await buzzFor(
    handle,
    rows.map((r) => r.id),
  );
  return { rows, total, page, count, empty, houseRound, buzz };
}
