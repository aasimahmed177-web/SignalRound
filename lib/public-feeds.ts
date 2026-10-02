// The public demo's feeds, as a visitor subscribes to them: /feeds/public/{slug}.{rss,atom,json}
// for every preset and for "all" (app/feeds/[token]/[file]/route.ts answers these only in demo
// mode). Each carries the /feed command Slack's RSS app takes, built on the instance's own origin,
// so a self-hosted demo hands out its own URLs.

import type { PresetOption } from "./presets.ts";
import { feedSubscribeCommand } from "./slack.ts";

export interface PublicFeed {
  slug: string;
  name: string;
  rss: string;
  atom: string;
  json: string;
  /** `/feed subscribe <rss>`, for any Slack channel's message box. */
  slack: string;
}

/** Every preset mixed, the route's "all": first in every picker. */
export const ALL_ROUNDS: PresetOption = { slug: "all", name: "All rounds" };

export function publicFeed(origin: string, { slug, name }: PresetOption): PublicFeed {
  const base = `${origin}/feeds/public/${slug}`;
  return { slug, name, rss: `${base}.rss`, atom: `${base}.atom`, json: `${base}.json`, slack: feedSubscribeCommand(`${base}.rss`) };
}

/** All rounds, then each preset in listPresets order. */
export function publicFeeds(origin: string, presets: PresetOption[]): PublicFeed[] {
  return [ALL_ROUNDS, ...presets.filter((p) => p.slug !== ALL_ROUNDS.slug)].map((p) => publicFeed(origin, p));
}

/**
 * A feed item's id, the same in RSS, Atom, and JSON Feed. Atom requires an IRI and the feed library
 * parses it as a URL, so the bare record id broke the whole feed whenever one started with a digit
 * ("50skills:other:2026-09-24" is no URI scheme). A URN is always a valid IRI and never changes as
 * the row is updated; the record id is percent-encoded except its colons, which a URN allows.
 */
export function feedItemId(recordId: string): string {
  return `urn:fireround:round:${encodeURIComponent(recordId).replace(/%3A/gi, ":")}`;
}
