// The feed's two orders, its two views, and the keyset cursors that page through them. Pure, so the
// paging rules are unit-tested without a store; persist.ts turns a parsed cursor into SQL.

/**
 * "" is the default (newest announced first); "amount" is largest USD first, unknown amounts last,
 * with every published, announced round ahead of the provisional ones (see isProvisional).
 */
export const ROUND_SORTS = ["", "amount"] as const;
export type RoundSort = (typeof ROUND_SORTS)[number];

/** Anything but a known sort reads as the default, so a stale or hand-typed URL still renders. */
export function toRoundSort(raw: string | null | undefined): RoundSort {
  return raw === "amount" ? "amount" : "";
}

/**
 * The feed's orders as the URL writes them: the two keyset orders above, plus "trending", the
 * Trending lane's rank (lib/trending.ts). Trending is a short ranked list, not a keyset over the
 * store, so it pages by position and never reaches listRounds' cursor.
 */
export const FEED_SORTS = ["", "amount", "trending"] as const;
export type FeedSort = (typeof FEED_SORTS)[number];

export function toFeedSort(raw: string | null | undefined): FeedSort {
  return raw === "trending" ? "trending" : toRoundSort(raw);
}

/**
 * The feed page's two views: "latest" walks the store in one of the keyset orders, "trending" is
 * the Trending lane's ranked list. The URL writes `view=trending` or `view=latest`; `sort=trending`,
 * the spelling from before the switch, still opens Trending so an old link lands in the same place,
 * and any other `sort` is one of Latest's orders. A bare `/feed` opens `fallback`: Trending on an
 * instance whose rung runs the lane, Latest where it would be empty.
 */
export type FeedView = "latest" | "trending";

export function toFeedView(view: string | null | undefined, sort: string | null | undefined, fallback: FeedView = "latest"): FeedView {
  if (view === "trending" || sort === "trending") return "trending";
  if (view === "latest" || sort) return "latest";
  return fallback;
}

/** The feed params that narrow the set, as the URL writes them (raw strings; empty means unset). */
export interface FeedNarrowing {
  q?: string;
  stage?: string;
  sector?: string;
  min?: string;
  preset?: string;
  since?: string;
  until?: string;
  source?: string;
  certainty?: string;
}

/** Whether any search, filter, or date range is set. */
export function isNarrowed(n: FeedNarrowing): boolean {
  return Object.values(n).some((v) => typeof v === "string" && v.trim() !== "");
}

/**
 * The view a /feed with no `view` in its URL opens. Trending ranks only the last three days, so a
 * search, a filter, or a date range there comes back empty or short (`q=groq` found nothing while
 * the round sat in Latest). Any narrowing opens Latest, which walks every round; a bare feed opens
 * Trending where the lane runs. An explicit `view=trending` still wins through toFeedView.
 */
export function defaultFeedView(trendingOn: boolean, narrowing: FeedNarrowing): FeedView {
  return trendingOn && !isNarrowed(narrowing) ? "trending" : "latest";
}

/** Where every link into the Trending view points. */
export const TRENDING_VIEW_HREF = "/feed?view=trending";

/**
 * The ids that tie the switch (a client component) to the panel it controls (the server page):
 * here, not beside the switch, because the server page cannot call into a client module.
 */
export const FEED_VIEW_PANEL = "feed-view-panel";

export function viewTabId(view: FeedView): string {
  return `feed-view-${view}`;
}

/** A trending page's cursor: the position after the last row, `trend:N`. */
const TREND_CURSOR = /^trend:(\d{1,4})$/;

export function parseTrendingCursor(raw: string): number | null {
  const m = TREND_CURSOR.exec(raw);
  return m ? Number(m[1]) : null;
}

export function trendingCursorAfter(offset: number): string {
  return `trend:${offset}`;
}

/** What the two keyset orders read off a round. */
export interface SortableRound {
  id: string;
  announcedOn: string | null;
  amountUsdMillions: string | null;
  disposition: string;
  certainty: string;
}

/**
 * A round that is not a published, announced round: flagged (or in review), or expected, reported,
 * or unconfirmed. The amount order lists these after every published announced round, each part
 * largest first, so "the biggest rounds" leads with money announced on the record. The row still
 * says its certainty and disposition; this only decides where it sorts.
 */
export function isProvisional(r: { disposition: string; certainty: string }): boolean {
  return r.disposition !== "publish" || r.certainty !== "announced";
}

/**
 * Where the previous page ended. Each sort has its own shape so a cursor from one order is never
 * read under the other: dated pages are `YYYY-MM-DD|id` (the undated tail is `|id`), amount
 * pages are `amt:25.5|id` among the published announced rounds and `amtp:25.5|id` among the
 * provisional ones after them (the tail of unknown amounts is `amt:|id` or `amtp:|id`).
 */
export type RoundCursor =
  | { sort: ""; announced: string | null; id: string }
  | { sort: "amount"; provisional: boolean; usdMillions: string | null; id: string };

const DATE_CURSOR = /^(\d{4}-\d{2}-\d{2})?\|([^|]+)$/;
const AMOUNT_CURSOR = /^amt(p)?:(\d+(?:\.\d+)?)?\|([^|]+)$/;

export function parseRoundCursor(raw: string): RoundCursor | null {
  const amount = AMOUNT_CURSOR.exec(raw);
  if (amount) return { sort: "amount", provisional: amount[1] === "p", usdMillions: amount[2] ?? null, id: amount[3] };
  const date = DATE_CURSOR.exec(raw);
  if (date) return { sort: "", announced: date[1] ?? null, id: date[2] };
  return null;
}

/** The cursor after a row, in the given order. `usdMillions` is the store's numeric text, kept exact. */
export function roundCursorAfter(sort: RoundSort, row: SortableRound): string {
  return sort === "amount"
    ? `amt${isProvisional(row) ? "p" : ""}:${row.amountUsdMillions ?? ""}|${row.id}`
    : `${row.announcedOn ?? ""}|${row.id}`;
}

/**
 * The comparator the SQL order implements, for tests and any in-memory list: under amount, the
 * published announced rounds before the provisional ones; then a key descending with nulls last,
 * then id descending as the tie-break so equal keys still page in a fixed order.
 */
export function compareRounds(sort: RoundSort, a: SortableRound, b: SortableRound): number {
  if (sort === "amount" && isProvisional(a) !== isProvisional(b)) return isProvisional(a) ? 1 : -1;
  const key = (r: SortableRound) => (sort === "amount" ? r.amountUsdMillions : r.announcedOn);
  const ka = key(a);
  const kb = key(b);
  if (ka !== kb) {
    if (ka === null) return 1;
    if (kb === null) return -1;
    const diff = sort === "amount" ? Number(kb) - Number(ka) : kb.localeCompare(ka);
    if (diff !== 0) return diff;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** True when a row falls strictly after the cursor in its order: the in-memory twin of the SQL keyset. */
export function isAfterCursor(cursor: RoundCursor, row: SortableRound): boolean {
  const at: SortableRound =
    cursor.sort === "amount"
      ? {
          id: cursor.id,
          announcedOn: null,
          amountUsdMillions: cursor.usdMillions,
          disposition: cursor.provisional ? "flagged" : "publish",
          certainty: "announced",
        }
      : { id: cursor.id, announcedOn: cursor.announced, amountUsdMillions: null, disposition: "publish", certainty: "announced" };
  return compareRounds(cursor.sort, at, row) < 0;
}
