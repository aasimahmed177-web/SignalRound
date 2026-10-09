// Server only: the root layout and the pages that set their own alternates read it; the client components that
// build subscribe links import lib/public-feeds.ts, which must stay free of request helpers.

import { isPublicDemo } from "./access.ts";
import { ALL_ROUNDS } from "./public-feeds.ts";

/**
 * The feed autodiscovery links every page's <head> carries (<link rel="alternate" type="application/rss+xml">),
 * so a reader pasting any page's URL finds the feed of all rounds. Only on a public demo, the one
 * place /feeds/public answers without a token. A page that sets its own alternates (a canonical URL)
 * passes these as its `types`, since Next replaces a parent's alternates rather than merging them.
 */
export function feedAlternateTypes(): Record<string, Array<{ url: string; title: string }>> | undefined {
  if (!isPublicDemo()) return undefined;
  const base = `/feeds/public/${ALL_ROUNDS.slug}`;
  return {
    "application/rss+xml": [{ url: `${base}.rss`, title: "Fireround: all rounds (RSS)" }],
    "application/atom+xml": [{ url: `${base}.atom`, title: "Fireround: all rounds (Atom)" }],
    "application/feed+json": [{ url: `${base}.json`, title: "Fireround: all rounds (JSON Feed)" }],
  };
}
