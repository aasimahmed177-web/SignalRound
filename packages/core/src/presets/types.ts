// A preset is the unit of configuration: what to search for, what the monitor
// judges against, and which stages the feed keeps. Presets are data (JSON in
// presets/), so a new signal is a file, not a code change.

import { z } from "zod";
import { STAGES } from "../records/schema.ts";

/** Slugs are file names and URL segments: lowercase, digits, hyphens. */
export const PRESET_SLUG = /^[a-z0-9-]+$/;

/** A slug from a display name: "Series C & later" becomes "series-c-later". Empty when nothing survives. */
export function slugifyPresetName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // the accents NFKD split off, so "Späte" reads spate, not spa-te
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A stage-free search with its own domain list: the press-wire search reads only Business Wire,
 * GlobeNewswire, and PR Newswire, where a `site:` chain in the query text matched less (measured
 * September 2026).
 */
export const WatchQuery = z.object({
  q: z.string().max(256),
  includeDomains: z.array(z.string()).max(20).default([]),
});
export type WatchQuery = z.infer<typeof WatchQuery>;

/** A watch query as the lane runs it, whichever form the preset wrote it in. */
export function watchQuery(q: string | WatchQuery): WatchQuery {
  return typeof q === "string" ? { q, includeDomains: [] } : q;
}

export const Preset = z.object({
  slug: z.string().regex(PRESET_SLUG),
  name: z.string(),
  description: z.string(),
  /** Position in lists and switchers, ascending; the lowest is the default preset. Ties fall back to the slug. */
  order: z.number().int().default(100),
  /** Recall lever: search terms, not sentences. 1 to 12 (the monitor's limit). */
  queries: z.array(z.string().max(256)).min(1).max(12),
  /** Precision lever for the monitor's judge. */
  goal: z.string().max(2000),
  stages: z.array(z.enum(STAGES)).min(1),
  sources: z.array(z.enum(["news", "web"])).default(["news", "web"]),
  excludeDomains: z.array(z.string()).default([]),
  includeDomains: z.array(z.string()).default([]),
  /** Results per source per query on the sweep. */
  limit: z.number().int().min(1).max(100).default(10),
  /**
   * X accounts whose latest posts the sweep reads (handles without the @). NativeWebClient serves
   * x.com through Grok at 34 credits a profile, so a few funding-dense accounts, not many.
   */
  xAccounts: z
    .array(z.string().regex(/^[A-Za-z0-9_]{1,15}$/))
    .max(10)
    .default([]),
  /**
   * Publisher funding sections the watch lane reads (a category or section page whose list is
   * the newest articles). One page read per site per check, then one extraction per new URL.
   */
  watchSites: z.array(z.url()).max(20).default([]),
  /**
   * Stage-free searches the watch lane runs over the past day ("has raised" million led by), each
   * unseen article result extracted once like a section's links. Many large rounds are announced
   * with no stage word ("$75 million in financing"), so the sweep's queries never match them; the
   * resolver files each round under the preset that keeps it.
   */
  watchQueries: z
    .array(z.union([z.string().max(256), WatchQuery]))
    .max(12)
    .default([]),
  /** Monitor: recency window and combined result cap per check. */
  monitor: z
    .object({
      searchWindow: z.enum(["5m", "15m", "1h", "6h", "24h", "7d"]).default("24h"),
      maxResults: z.number().int().min(1).max(50).default(50),
      schedule: z.string().default("daily at 9am"),
      timezone: z.string().default("UTC"),
    })
    .default({ searchWindow: "24h", maxResults: 50, schedule: "daily at 9am", timezone: "UTC" }),
});
export type Preset = z.infer<typeof Preset>;

export function parsePreset(input: unknown): Preset {
  return Preset.parse(input);
}
