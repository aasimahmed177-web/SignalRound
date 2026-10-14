// A few facts about a round that cannot all be true. A row that breaks one goes to Review with the
// reason, never fixed by a rule: a person decides which reading is wrong. There are deliberately no
// trajectory rules (a valuation that falls, a lettering that restarts): down rounds and renamed
// series are real.

import { classifyStage, parseAmount } from "./normalize.ts";
import type { FeedRecord } from "./schema.ts";

/** Two rounds of one stage this close together are one round, an extension, or a tranche. */
export const SAME_STAGE_DAYS = 60;
const DAY = 86_400_000;

/** A stored round of the same company, as the check reads it. */
export interface SiblingRound {
  id: string;
  stage: string;
  stageAsWritten: string;
  isExtension?: boolean;
  announcedOn: string | null;
  amountScope?: string | null;
}

/** A label that names a tranche of a series: "Series B1", "Series B-2", "C-1". */
export function trancheLabel(label: string): boolean {
  return /\bseries\s+[a-k][-\s]?\d\b|\b[a-k]-\d\b/i.test(label);
}

/**
 * Why the record cannot stand as read, or null: a valuation below the amount raised; an amount at or
 * above the financing total it is part of; or another round of the same stage within SAME_STAGE_DAYS
 * with neither called an extension or a tranche.
 */
export function invariantBreach(
  r: Pick<
    FeedRecord,
    | "id"
    | "stage"
    | "stage_as_written"
    | "is_extension"
    | "announced_date"
    | "amount"
    | "valuation_as_written"
    | "financing_total_as_written"
    | "amount_scope"
  >,
  siblings: SiblingRound[],
): string | null {
  const amount = r.amount.value;
  const valuation = parseAmount(r.valuation_as_written);
  if (
    amount !== null &&
    valuation.value !== null &&
    (!valuation.currency || valuation.currency === r.amount.currency) &&
    valuation.value < amount
  ) {
    return `the valuation ${r.valuation_as_written} is below the amount ${r.amount.as_written}`;
  }
  const total = parseAmount(r.financing_total_as_written ?? null).value;
  if (amount !== null && total !== null && r.amount_scope !== "financing_total" && amount >= total) {
    return `the amount ${r.amount.as_written} is at or above the financing total ${r.financing_total_as_written}`;
  }
  const day = r.announced_date ? Date.parse(r.announced_date) : Number.NaN;
  if (Number.isNaN(day) || classifyStage(r.stage_as_written).stage === "other") return null;
  const linked = (s: { isExtension: boolean; label: string; scope?: string | null }) =>
    s.isExtension || trancheLabel(s.label) || s.scope === "tranche";
  if (linked({ isExtension: r.is_extension, label: r.stage_as_written, scope: r.amount_scope })) return null;
  const twin = siblings.find((s) => {
    if (s.id === r.id || s.stage !== r.stage || !s.announcedOn) return false;
    if (linked({ isExtension: s.isExtension ?? false, label: s.stageAsWritten, scope: s.amountScope })) return false;
    return Math.abs(Date.parse(s.announcedOn) - day) <= SAME_STAGE_DAYS * DAY;
  });
  return twin
    ? `another ${twin.stageAsWritten} on ${twin.announcedOn} within ${SAME_STAGE_DAYS} days, with no extension or tranche between them`
    : null;
}
