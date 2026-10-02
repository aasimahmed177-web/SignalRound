// The pure half of the command palette: which sections a query keeps, and the flat option list
// the listbox renders and the arrow keys walk. No React here, so tests read it directly.

import type { SearchHit } from "@/lib/directory";
import { companyHref, investorHref } from "@/lib/links";
import type { NavItem } from "@/lib/nav";

export type PaletteGroup = "Go to" | "Companies" | "Investors" | "Search" | "Research";

export interface PaletteOption {
  /** Stable across renders for React keys and aria-activedescendant. */
  key: string;
  group: PaletteGroup;
  label: string;
  detail: string | null;
  href: string;
  /** What the row draws in front of the label. */
  lead:
    | { kind: "section"; item: NavItem }
    | { kind: "company"; hit: SearchHit }
    | { kind: "investor"; hit: SearchHit }
    | { kind: "search" }
    | { kind: "request" };
}

/**
 * The sections a query keeps: every one for an empty query, otherwise those whose label holds it,
 * prefix matches first. Descriptions stay out of it: a company name typed into the palette would
 * otherwise match half the sections' prose and push the companies down.
 */
export function matchSections(items: NavItem[], q: string): NavItem[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items;
  const hits = items.filter((n) => n.label.toLowerCase().includes(needle));
  return [
    ...hits.filter((n) => n.label.toLowerCase().startsWith(needle)),
    ...hits.filter((n) => !n.label.toLowerCase().startsWith(needle)),
  ];
}

/**
 * Section lines the palette says differently from the nav: NAV's line for Runs names credits, which
 * a demo visitor never sees, and the palette cannot tell who is looking, so it says what everyone sees.
 */
const PALETTE_DETAIL: Record<string, string> = {
  "/runs": "Every sweep, check, and enrichment, and what each one found.",
};

/**
 * Everything the listbox shows, in order: matching sections, company and investor hits, the feed
 * search, then the optional research action. Enter on a typed name opens the best hit. Feed search
 * opens Latest, which searches every round; Trending would search only the last three days.
 */
export function paletteOptions(
  items: NavItem[],
  q: string,
  hits: { companies: SearchHit[]; investors: SearchHit[] },
  requestsEnabled = false,
): PaletteOption[] {
  const term = q.trim();
  const out: PaletteOption[] = matchSections(items, term).map((item) => ({
    key: `section:${item.href}`,
    group: "Go to",
    label: item.label,
    detail: PALETTE_DETAIL[item.href] ?? item.description,
    href: item.href,
    lead: { kind: "section", item },
  }));
  for (const hit of hits.companies) {
    out.push({
      key: `company:${hit.id}`,
      group: "Companies",
      label: hit.name,
      detail: hit.detail,
      href: companyHref(hit.id),
      lead: { kind: "company", hit },
    });
  }
  for (const hit of hits.investors) {
    out.push({
      key: `investor:${hit.id}`,
      group: "Investors",
      label: hit.name,
      detail: hit.detail,
      href: investorHref(hit.id),
      lead: { kind: "investor", hit },
    });
  }
  if (term && items.some((n) => n.href === "/feed")) {
    out.push({
      key: "search:feed",
      group: "Search",
      label: `Search rounds for "${term}"`,
      detail: "Company, description, and investor, in the feed",
      href: `/feed?${new URLSearchParams({ q: term, view: "latest" }).toString()}`,
      lead: { kind: "search" },
    });
  }
  if (term && requestsEnabled) {
    out.push({
      key: "request:company",
      group: "Research",
      label: `Research "${term}"`,
      detail: "Check the company's website and funding history",
      href: "",
      lead: { kind: "request" },
    });
  }
  return out;
}
