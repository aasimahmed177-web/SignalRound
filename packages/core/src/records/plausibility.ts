// Whether a new reading of a round fits what the store already verified about the company. A trend
// story that names OpenAI in passing became an OpenAI "Series A" with no amount, beside verified
// $6.6 billion and $40 billion rounds; a company does not go back to its Series A after rounds that
// size. A reading like that, or one known only from a list page with no amount, is thin enough that a
// person should look before the feed shows it. Pure: persist decides where the row starts.

import type { FeedRecord } from "./schema.ts";
import type { Stage } from "./stages.ts";

/** One of the company's rounds on the store, as far as this rule reads it. */
export interface StoredRound {
  stage: string;
  announcedOn: string | null;
  amountUsdMillions: number | null;
  /** Read back and confirmed or corrected, or promoted as history from its own announcement. */
  verified: boolean;
}

/** How far along a stage is; the stages that say nothing about it (debt, grants, "other") have no rank. */
const STAGE_RANK: Partial<Record<Stage, number>> = {
  pre_seed: 0,
  seed: 1,
  bridge: 1,
  pre_a: 1,
  series_a: 2,
  series_b: 3,
  series_c: 4,
  series_d_plus: 5,
  growth: 6,
};

/** A verified round this large is a late-stage company's whatever its label ($40 billion "funding round"). */
export const LATE_STAGE_USD_MILLIONS = 1000;

function rankOf(r: Pick<StoredRound, "stage" | "amountUsdMillions">): number | null {
  const rank = STAGE_RANK[r.stage as Stage] ?? null;
  if (r.amountUsdMillions !== null && r.amountUsdMillions >= LATE_STAGE_USD_MILLIONS) return Math.max(rank ?? 0, STAGE_RANK.growth ?? 6);
  return rank;
}

/**
 * The verified earlier round a reading's stage falls below: a Series A after a verified Series C, or
 * after a verified round of a billion dollars or more. Null when the stage has no rank, the reading
 * is undated, or nothing verified came before it.
 */
export function stageRegression(record: Pick<FeedRecord, "stage" | "announced_date">, known: StoredRound[]): StoredRound | null {
  const mine = STAGE_RANK[record.stage];
  if (mine === undefined || !record.announced_date) return null;
  const day = record.announced_date;
  let worst: StoredRound | null = null;
  for (const k of known) {
    if (!k.verified || !k.announcedOn || k.announcedOn > day) continue;
    const rank = rankOf(k);
    if (rank === null || rank <= mine) continue;
    const worstRank = worst ? (rankOf(worst) ?? 0) : -1;
    // The furthest along, and of those the largest: the round a reader would name.
    if (rank > worstRank || (rank === worstRank && (k.amountUsdMillions ?? 0) > (worst?.amountUsdMillions ?? 0))) worst = k;
  }
  return worst;
}

/** Whether every source of the reading is a list: a weekly or monthly roundup dates its rounds to its period, never to a day. */
export function onlyFromLists(record: Pick<FeedRecord, "date_precision" | "sources">): boolean {
  return record.sources.length <= 1 && (record.date_precision === "week" || record.date_precision === "month");
}

/**
 * Why a reading should start in review rather than on the feed, or null when it may start where its
 * score puts it. Only a reading with no amount is held: a stated figure the read-back confirmed is
 * evidence of its own (Groq's real 2026 Series A after its lettering restarted), while a label with no
 * figure from a list, or below what the company verifiably raised before, is not.
 */
export function implausibleReading(
  record: Pick<FeedRecord, "stage" | "stage_as_written" | "announced_date" | "date_precision" | "sources" | "amount">,
  known: StoredRound[],
): string | null {
  if (record.amount.as_written !== null) return null;
  const earlier = stageRegression(record, known);
  if (earlier) {
    const size = earlier.amountUsdMillions !== null ? ` of $${earlier.amountUsdMillions}M` : "";
    return `a ${record.stage_as_written} with no amount after a verified ${earlier.stage} round${size} on ${earlier.announcedOn}`;
  }
  if (onlyFromLists(record)) return `a ${record.stage_as_written} with no amount, known only from a list`;
  return null;
}
