// Numbered pages for the dashboard feed. Pure, so the pager's arithmetic is unit-tested; the
// read API keeps keyset cursors (see round-sort.ts), which stay correct while rows arrive.

/** A 1-based page from the URL; anything that is not a whole number from 1 up reads as page one. */
export function parsePage(raw: string | null | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** How many pages `total` rows fill; an empty set still has one (empty) page. */
export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

/** The 1-based row span a page shows ("51 to 100 of 350"); `from` is 0 when there are no rows. */
export function pageSpan(page: number, size: number, total: number): { from: number; to: number } {
  if (total <= 0) return { from: 0, to: 0 };
  const from = (page - 1) * size + 1;
  return { from: Math.min(from, total), to: Math.min(page * size, total) };
}

/**
 * The numbers a pager shows: always the first and last page, the current page with one neighbour
 * each side, and a gap for any longer run. A gap that would hide a single page shows that page,
 * so the list never trades one number for an ellipsis.
 */
export function pageList(current: number, count: number): Array<number | "gap"> {
  const keep = new Set([1, count, current - 1, current, current + 1].filter((n) => n >= 1 && n <= count));
  const sorted = [...keep].sort((a, b) => a - b);
  const out: Array<number | "gap"> = [];
  let prev = 0;
  for (const n of sorted) {
    if (n - prev === 2) out.push(n - 1);
    else if (n - prev > 2) out.push("gap");
    out.push(n);
    prev = n;
  }
  return out;
}
