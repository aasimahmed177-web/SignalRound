// The history lane's bookkeeping: what one prior round's attempt came to, and the counts a company
// and a backfill add up. Workflow bodies (workflows/history.ts) call these between steps, and a
// workflow body is bundled for the workflow runtime, where Node modules do not load: keep this file
// import-free. The store side is lib/history.ts.

/** A failed promotion is tried this many times in all, then left failed. */
export const HISTORY_MAX_ATTEMPTS = 4;
/** Hours before the next try after the 1st, 2nd, and 3rd failure. */
export const HISTORY_BACKOFF_HOURS = [1, 6, 24] as const;

export interface PromotionOutcome {
  companyId: string;
  priorKey: string;
  /** deferred: announced inside the news window, looked for again once it has passed. */
  status: "promoted" | "no_source" | "failed" | "skipped" | "deferred";
  searched: boolean;
  /** A page stating the round was found. */
  sourced: boolean;
  /** A record went through persist (a new history row, or a merge into a row already there). */
  ingested: boolean;
  disposition: "publish" | "flagged" | "review" | "rejected" | null;
  /** The reading landed on a row already there (a feed row or an earlier history row) rather than a new one. */
  merged: boolean;
  roundId: string | null;
  credits: number;
  reason?: string;
}

/** The outcome of a prior round nothing was spent on: gone, done, held by another pass, or deferred as too recent. */
export function skippedOutcome(companyId: string, key: string, reason: string): PromotionOutcome {
  return {
    companyId,
    priorKey: key,
    status: reason === "recent" ? "deferred" : "skipped",
    searched: false,
    sourced: false,
    ingested: false,
    disposition: null,
    merged: false,
    roundId: null,
    credits: 0,
    reason,
  };
}

/** The outcome of a prior round whose attempt failed after spending `credits`; the ledger has its backoff. */
export function failedOutcome(companyId: string, key: string, error: string, credits: number, searched = false): PromotionOutcome {
  return { ...skippedOutcome(companyId, key, error.slice(0, 200)), status: "failed", searched, credits };
}

/** The counts one company's promotions add up to, and what a backfill carries between runs. */
export interface HistoryTally {
  companies: number;
  prior_rounds: number;
  searched: number;
  sourced: number;
  ingested: number;
  published: number;
  flagged: number;
  review: number;
  merged: number;
  no_source: number;
  failed: number;
  deferred: number;
  skipped: number;
  /** Companies not started because the credit ceiling was reached. */
  skipped_budget: number;
  credits: number;
}

export function emptyHistoryTally(): HistoryTally {
  return {
    companies: 0,
    prior_rounds: 0,
    searched: 0,
    sourced: 0,
    ingested: 0,
    published: 0,
    flagged: 0,
    review: 0,
    merged: 0,
    no_source: 0,
    failed: 0,
    deferred: 0,
    skipped: 0,
    skipped_budget: 0,
    credits: 0,
  };
}

/** Add one prior round's outcome to a tally. Pure. */
export function tallyPromotion(t: HistoryTally, o: PromotionOutcome): HistoryTally {
  const next = { ...t, prior_rounds: t.prior_rounds + 1, credits: t.credits + o.credits };
  if (o.searched) next.searched++;
  if (o.sourced) next.sourced++;
  if (o.ingested) next.ingested++;
  if (o.merged) next.merged++;
  if (o.disposition === "publish") next.published++;
  if (o.disposition === "flagged") next.flagged++;
  if (o.disposition === "review" || o.disposition === "rejected") next.review++;
  if (o.status === "no_source") next.no_source++;
  if (o.status === "failed") next.failed++;
  if (o.status === "deferred") next.deferred++;
  if (o.status === "skipped") next.skipped++;
  return next;
}

/** Two tallies as one: a company's into the backfill's. Pure. */
export function addTallies(a: HistoryTally, b: HistoryTally): HistoryTally {
  const out = { ...a };
  for (const k of Object.keys(out) as Array<keyof HistoryTally>) out[k] = a[k] + b[k];
  return out;
}
