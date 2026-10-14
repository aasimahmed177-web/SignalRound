// Hrefs for the entity pages. Ids are primary keys (a name key or a domain for a company,
// a name key for an investor) and can hold spaces and dots, so every href encodes them and
// every page decodes its param. An investor's spaces become hyphens in its URL (investorSlug).

import { investorKeyForMerge } from "@fireround/core/client";

export function companyHref(id: string): string {
  return `/companies/${encodeURIComponent(id)}`;
}

/**
 * An investor's URL segment: its id with hyphens for spaces ("sequoia-capital-india", not
 * "sequoia%20capital%20india"). An investor id is a name key, lowercase letters, digits, and single
 * spaces (investorKeyForMerge), so it never holds a hyphen and the slug reads back exactly.
 */
export function investorSlug(id: string): string {
  return encodeURIComponent(id.trim().replace(/\s+/g, "-"));
}

export function investorHref(id: string): string {
  return `/investors/${investorSlug(id)}`;
}

/** The investor id a route param names: the hyphen slug, or an old URL's spaces, read back to the stored id. */
export function investorIdFromParam(value: string): string {
  return decodeParam(value)
    .trim()
    .replace(/[-\s]+/g, " ");
}

/**
 * Where an old investor URL now lives: a path whose segment still holds spaces (the "%20" links the
 * site handed out before hyphen slugs) moves permanently to the slug, the rest of the path and the
 * query kept by the caller. Null for any other path.
 */
export function legacyInvestorPath(pathname: string): string | null {
  const m = /^\/investors\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m?.[1]) return null;
  const decoded = decodeParam(m[1]);
  if (!/\s/.test(decoded)) return null;
  return `${investorHref(investorIdFromParam(m[1]))}${m[2] ?? ""}`;
}

/** Rows carry investor names, not ids; the key is how persistence keys them, so it is the id. */
export function investorHrefByName(name: string): string {
  return investorHref(investorKeyForMerge(name));
}

/** A route param as Next hands it over, whether or not it arrived still percent-encoded. */
export function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * A URL the web wrote, when it may go in an href or a src that React does not render (feeds, email,
 * Slack): http or https only, so a crafted page cannot plant a javascript: or data: link in a reader's
 * feed. React blocks javascript: URLs on the pages itself. Null otherwise.
 */
export function webUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}
