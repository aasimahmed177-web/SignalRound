// An investor's shown name: the fullest spelling its own key allows, when the investor's own site
// confirms it. One investor row covers every spelling that folds to its key ("Nexus" and "Nexus Venture
// Partners" are both "nexus"), and the row keeps the first spelling it was written with, so a firm first
// seen as "Nexus" read as "Nexus" on every round. A spelling that adds only vehicle words ("Venture
// Partners", "Capital") replaces it only when the investor's verified domain spells the fuller name out
// (nexusvp.com: Nexus plus the initials VP; uncorkcapital.com: Uncork Capital). A domain that is the
// short name itself (google.com, baincapital.com) means the short name is the firm and the fuller one is
// another (Google Ventures, Bain Capital Ventures); no domain, no change. Nothing here ever joins two keys.

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

function compact(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Whether the investor's domain spells this fuller name: its first label is the whole name compacted
 * (uncorkcapital) or the short name plus the added words' initials (nexus + vp), and is not the short
 * name alone.
 */
export function domainConfirms(shown: string, fuller: string, domain: string | null | undefined): boolean {
  const label = domain ? compact(domain.split(".")[0] ?? "") : "";
  if (!label || label === compact(shown)) return false;
  const initials = fuller
    .slice(shown.trim().length)
    .trim()
    .split(/\s+/)
    .map((w) => w[0]?.toLowerCase() ?? "")
    .join("");
  return label === compact(fuller) || label === compact(shown) + initials;
}

/** `candidate` when it is `shown` plus vehicle words, folds to the same investor, and the investor's domain spells it; null otherwise. */
export function fullerInvestorName(shown: string, candidate: string, domain: string | null | undefined): string | null {
  const a = shown.trim();
  const b = candidate.trim().replace(/\s+/g, " ");
  if (b.length <= a.length || !b.toLowerCase().startsWith(a.toLowerCase())) return null;
  if (!VEHICLE.test(b.slice(a.length))) return null;
  if (investorKeyForMerge(a) !== investorKeyForMerge(b)) return null;
  return domainConfirms(a, b, domain) ? b : null;
}

/**
 * The one fuller spelling of `shown` these texts use that the investor's domain confirms, or null. A
 * spelling must end the name: "China Merchants Venture" followed by "Capital Fund" is a longer name, not this one.
 */
export function fullerNameIn(shown: string, texts: readonly string[], domain: string | null | undefined): string | null {
  const words = VEHICLE_WORDS.map((w) => w.replace(/ /g, "\\s+")).join("|");
  const re = new RegExp(`\\b${escapeRegExp(shown.trim()).replace(/\\? /g, "\\s+")}(?:\\s+(?:${words}))+\\b(?![ \\t]+[A-Z0-9&])`, "g");
  const found = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(re)) {
      const fuller = fullerInvestorName(shown, m[0], domain);
      if (fuller) found.add(fuller);
    }
  }
  return found.size === 1 ? ([...found][0] ?? null) : null;
}
