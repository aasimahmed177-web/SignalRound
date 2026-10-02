// What a 404 says, from the address that missed. Pure, so the copy is tested without a render.

import { decodeParam, investorIdFromParam } from "@/lib/links";

export interface MissingPage {
  title: string;
  body: string;
  /** Where the search box sends its query, and what it searches. */
  searchAction: "/companies" | "/investors" | "/feed";
  searchLabel: string;
  /** The words from the address, to start the search with; empty for a page that is not an entity. */
  prefill: string;
}

/**
 * A missing company or investor page reads as one, with the likely reasons in order: a typo in the
 * address, then a record merged into another. Anything else is a page that does not exist. The
 * proxy may rewrite a miss under a prefix (`/_missing/companies/<id>`), so the kind is read from
 * wherever the segment sits.
 */
export function missingPage(pathname: string | null): MissingPage {
  const m = /\/(companies|investors)\/([^/?#]+)/.exec(pathname ?? "");
  const words = !m ? "" : m[1] === "investors" ? investorIdFromParam(m[2]) : decodeParam(m[2]).replace(/\s+/g, " ").trim();
  if (m?.[1] === "companies") {
    return {
      title: "No company at this address.",
      body: "Check the spelling in the link. A company page can also move when two records turn out to be the same company, so search for it by name or domain.",
      searchAction: "/companies",
      searchLabel: "Search companies",
      prefill: words,
    };
  }
  if (m?.[1] === "investors") {
    return {
      title: "No investor at this address.",
      body: "Check the spelling in the link. An investor page can also move when two names turn out to be the same firm, so search for it by name.",
      searchAction: "/investors",
      searchLabel: "Search investors",
      prefill: words,
    };
  }
  return {
    title: "Nothing at this address.",
    body: "Check the spelling in the link, or search the funding rounds for a company, an investor, or a description.",
    searchAction: "/feed",
    searchLabel: "Search rounds",
    prefill: "",
  };
}
