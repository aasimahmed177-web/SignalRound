// An investor's shown name: the fullest spelling its own key allows. One investor row covers every
// spelling that folds to its key ("Nexus" and "Nexus Venture Partners" are both "nexus"), and the row
// keeps the first spelling it was written with, so a firm first seen as "Nexus" read as "Nexus" on every
// round. A spelling that adds only vehicle words ("Venture Partners", "Capital") to the shown one, and
// still folds to the same key, replaces it. Nothing here ever joins two keys: a firm whose fuller name
// folds elsewhere ("Nexus VP", "Sequoia Capital China") is another row and stays one.

import { investorKeyForMerge } from "@fireround/core";

/** The vehicle words a fuller spelling may add: the ones the investor key folds away. */
const VEHICLE_WORDS = [
  "Venture Partners",
  "Venture Capital",
  "Ventures",
  "Venture",
  "Capital",
  "Partners",
  "Management",
  "Investments",
  "Investment",
  "Holdings",
  "Group",
  "Fund",
];
const VEHICLE = new RegExp(`^(?:\\s+(?:${VEHICLE_WORDS.map((w) => w.replace(/ /g, "\\s+")).join("|")}))+$`, "i");

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `candidate` when it is `shown` plus vehicle words and folds to the same investor; null otherwise. */
export function fullerInvestorName(shown: string, candidate: string): string | null {
  const a = shown.trim();
  const b = candidate.trim().replace(/\s+/g, " ");
  if (b.length <= a.length || !b.toLowerCase().startsWith(a.toLowerCase())) return null;
  if (!VEHICLE.test(b.slice(a.length))) return null;
  return investorKeyForMerge(a) === investorKeyForMerge(b) ? b : null;
}

/**
 * The one fuller spelling of `shown` these texts use (a round's own sentences and pages), or null when
 * they use none or more than one ("Nexus Ventures" beside "Nexus Venture Partners" is not settled).
 */
export function fullerNameIn(shown: string, texts: readonly string[]): string | null {
  const words = VEHICLE_WORDS.map((w) => w.replace(/ /g, "\\s+")).join("|");
  const re = new RegExp(`\\b${escapeRegExp(shown.trim()).replace(/\\? /g, "\\s+")}(?:\\s+(?:${words}))+\\b`, "g");
  const found = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(re)) {
      const fuller = fullerInvestorName(shown, m[0]);
      if (fuller) found.add(fuller);
    }
  }
  return found.size === 1 ? ([...found][0] ?? null) : null;
}
