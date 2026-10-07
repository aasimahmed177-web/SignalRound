// The order a round's sources are listed in, everywhere a reader or an agent sees them (the API, the
// MCP tools, the feeds, the company page, Slack): the company's own announcement first, then a wire's
// release of it, then the established outlets, then everything else. Pure, so every surface lists the
// same page first, and the first page is the round's `primary_source` when it is the company's or a wire's.

import { DEFAULT_TIERS, registrableDomain } from "@fireround/core";

/** Wires carry the issuer's own release: primary evidence, as the company's site is. */
export const WIRE_DOMAINS = new Set([
  "businesswire.com",
  "prnewswire.com",
  "globenewswire.com",
  "accesswire.com",
  "newswire.ca",
  "einpresswire.com",
  "webwire.com",
  "prweb.com",
  "newsfilecorp.com",
  "pr.com",
]);

/** A publisher at or above this tier is an established outlet (DEFAULT_TIERS: TechCrunch, Reuters, SiliconANGLE). */
const MAJOR_TIER = 0.7;

export type SourceKind = "company" | "wire" | "major" | "other";

/** What a page is to this round: the company's own (its domain or one it is known by), a wire's, an established outlet's, or other. */
export function sourceKind(url: string, companyDomains: readonly string[], tiers: Record<string, number> = DEFAULT_TIERS): SourceKind {
  const domain = registrableDomain(url);
  if (!domain) return "other";
  if (companyDomains.includes(domain)) return "company";
  if (WIRE_DOMAINS.has(domain)) return "wire";
  return (tiers[domain] ?? 0) >= MAJOR_TIER ? "major" : "other";
}

const RANK: Record<SourceKind, number> = { company: 0, wire: 1, major: 2, other: 3 };

/**
 * Sources in reading order: by kind, then the earlier-dated page (the announcement before its
 * write-ups), then the URL, so the order never depends on how the database returned them.
 */
export function orderSources<T extends { url: string; published?: string | null }>(
  sources: readonly T[],
  companyDomains: readonly string[],
  tiers: Record<string, number> = DEFAULT_TIERS,
): T[] {
  const kinds = new Map(sources.map((s) => [s, RANK[sourceKind(s.url, companyDomains, tiers)]]));
  return [...sources].sort(
    (a, b) =>
      (kinds.get(a) ?? 3) - (kinds.get(b) ?? 3) ||
      (a.published ?? "9999").localeCompare(b.published ?? "9999") ||
      (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
  );
}

export interface PrimarySource {
  url: string;
  /** company: the company's own announcement; wire: its release on a newswire. */
  kind: "company" | "wire";
}

/** The round's official announcement among its sources: the company's own page first, else a wire's release; null when neither is there. */
export function primarySourceOf(
  sources: readonly { url: string; published?: string | null }[],
  companyDomains: readonly string[],
): PrimarySource | null {
  const first = orderSources(sources, companyDomains)[0];
  if (!first) return null;
  const kind = sourceKind(first.url, companyDomains);
  return kind === "company" || kind === "wire" ? { url: first.url, kind } : null;
}
