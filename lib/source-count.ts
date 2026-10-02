// One source count per round, the same on every surface. A row lists its sources, and its verdict
// remembers how many of them the reader read (`sources_seen`); the two drift when corroboration adds
// a page after the read (Wealthcome's badge said 1 source while its panel and RSS listed 2) or a
// prune removes one. The count a reader sees is always the list they can open; the verdict's reach
// is said beside it only when it read fewer ("verified against 1 of 2 sources").

interface Counted {
  sources: readonly unknown[];
  verification: { status: string; sources_seen?: number } | null;
}

/** The count every badge, panel, feed item, and card shows: the sources listed on the row. */
export function sourceCount(r: Pick<Counted, "sources">): number {
  return r.sources.length;
}

/** Whether the verdict confirmed the row (confirmed or corrected), the only verdicts that claim verification. */
export function isVerified(r: Pick<Counted, "verification">): boolean {
  const status = r.verification?.status;
  return status === "confirmed" || status === "corrected";
}

/**
 * How many of the listed sources the verdict read, or null when the row was never verified. Capped
 * at the list: a page pruned after the read is not a source the row still shows.
 */
export function sourcesRead(r: Counted): number | null {
  if (!isVerified(r)) return null;
  const listed = sourceCount(r);
  return Math.min(r.verification?.sources_seen ?? listed, listed);
}

const noun = (n: number) => (n === 1 ? "source" : "sources");

/** "2 sources", the list's count with its noun. */
export function sourcesLabel(r: Pick<Counted, "sources">): string {
  const n = sourceCount(r);
  return `${n} ${noun(n)}`;
}

/**
 * The verified reach in words, after a verb: "2 sources" when the verdict read them all, "1 of 2
 * sources" when pages arrived after it read. Null for a row never verified.
 */
export function readAgainst(r: Counted): string | null {
  const read = sourcesRead(r);
  if (read === null) return null;
  const listed = sourceCount(r);
  return read < listed ? `${read} of ${listed} ${noun(listed)}` : `${listed} ${noun(listed)}`;
}
