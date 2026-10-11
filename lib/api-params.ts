// Request-param parsing shared by the read API: a bad value is a 400 with one line, never a
// silent empty set. /api/v1/runs shares the limit rule.

import type { RoundCertainty, Stage } from "@fireround/core";
import { classifyStage, ROUND_CERTAINTIES, SECTORS, STAGES } from "@fireround/core";
import { FEED_SORTS, type FeedSort, parseRoundCursor, parseTrendingCursor } from "./round-sort.ts";

export const ROUND_STATUSES = ["new", "updated", "seen"] as const;
export const ROUND_FORMATS = ["json", "csv", "jsonl"] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = (error: string): Parsed<never> => ({ ok: false, error });

/**
 * Headers for a read response. The public view is the same for every visitor, so a browser app on
 * another origin may read it and the CDN may hold it a minute; an insider's view (an admin, or anyone
 * on a private instance) carries operator detail, so it is never shared across origins or cached.
 */
export function readHeaders(insider: boolean): Record<string, string> {
  return insider
    ? { "cache-control": "private, no-store", vary: "Authorization" }
    : {
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
        vary: "Authorization",
      };
}

/**
 * A browser's CORS preflight for a public read. The read answers any origin (readHeaders), so the
 * preflight says so, and lets the Authorization header an API key rides in through; without this a
 * browser client that sends a key was refused before its GET left. Cached a day by the browser.
 */
export function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-max-age": "86400",
    },
  });
}

export function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

export function parseLimit(raw: string | null, fallback = 50): Parsed<number> {
  if (raw === null || raw === "") return ok(fallback);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) return bad("limit must be a whole number from 1 to 200");
  return ok(n);
}

export function parseSince(raw: string | null): Parsed<string | undefined> {
  if (raw === null) return ok(undefined);
  if (!DAY.test(raw)) return bad("since must be a real date as YYYY-MM-DD");
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return bad("since must be a real date as YYYY-MM-DD");
  return ok(raw);
}

export function parseMinUsd(raw: string | null): Parsed<number | undefined> {
  if (raw === null) return ok(undefined);
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0) return bad("min_usd must be a number at or above 0");
  return ok(n);
}

/**
 * One stage as a person or an agent writes it: the enum value ("series_a"), or the words for it
 * ("Series A", "series-a", "pre-seed", "Series D+", "Series F"), read by the same classifier that
 * labels rounds. A word it can't place is null, not "other".
 */
export function stageFromFilter(raw: string): Stage | null {
  const t = raw.trim().toLowerCase();
  if ((STAGES as readonly string[]).includes(t)) return t as Stage;
  const { stage } = classifyStage(t.replace(/[_-]+/g, " "));
  return stage === "other" ? null : stage;
}

export function parseStages(raw: string | null): Parsed<Stage[] | undefined> {
  if (raw === null) return ok(undefined);
  const values = raw.split(",").map(stageFromFilter);
  if (values.some((s) => s === null)) return bad(`stage must be one or more of: ${STAGES.join(", ")}`);
  return ok([...new Set(values as Stage[])]);
}

/** One of a fixed set of words, or the default when absent. */
export function parseChoice<T extends string>(raw: string | null, name: string, choices: readonly T[], fallback: T): Parsed<T> {
  if (raw === null || raw === "") return ok(fallback);
  if (!(choices as readonly string[]).includes(raw)) return bad(`${name} must be one of: ${choices.join(", ")}`);
  return ok(raw as T);
}

/** A 1-based page number. */
export function parsePage(raw: string | null): Parsed<number> {
  if (raw === null || raw === "") return ok(1);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10_000) return bad("page must be a whole number from 1");
  return ok(n);
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Other words for a sector, compacted (lowercase, letters and digits only). */
const SECTOR_ALIASES: Record<string, (typeof SECTORS)[number]> = {
  artificialintelligence: "ai",
  genai: "ai",
  generativeai: "ai",
  machinelearning: "ai",
  ml: "ai",
  aiinfra: "ai infrastructure",
  aicompute: "ai infrastructure",
  devtools: "developer tools",
  devtool: "developer tools",
  developertool: "developer tools",
  data: "data and analytics",
  analytics: "data and analytics",
  dataanalytics: "data and analytics",
  security: "cybersecurity",
  cyber: "cybersecurity",
  saas: "enterprise software",
  b2bsoftware: "enterprise software",
  enterprise: "enterprise software",
  payment: "payments",
  insurance: "insurtech",
  web3: "crypto",
  blockchain: "crypto",
  defi: "crypto",
  health: "healthtech",
  healthcare: "healthtech",
  digitalhealth: "healthtech",
  lifesciences: "biotech",
  medicaldevices: "medtech",
  climatetech: "climate",
  cleantech: "climate",
  ev: "mobility",
  transportation: "mobility",
  robot: "robotics",
  chips: "semiconductors",
  semis: "semiconductors",
  semiconductor: "semiconductors",
  spacetech: "space",
  defence: "defense",
  defensetech: "defense",
  retail: "ecommerce",
  dtc: "ecommerce",
  gaming: "media and gaming",
  media: "media and gaming",
  education: "edtech",
  hr: "hr tech",
  legal: "legal tech",
  realestate: "proptech",
  supplychain: "logistics",
  agtech: "agtech and food",
  foodtech: "agtech and food",
};
const SECTOR_WORDS = new Map<string, string>([...SECTORS.map((s) => [compact(s), s] as const), ...Object.entries(SECTOR_ALIASES)]);

/**
 * A sector from the feed's vocabulary, as a person or an agent writes it: "AI infrastructure",
 * "ai-infra", "Fin Tech", "dev tools", "healthcare". Case, spacing and punctuation don't count, and a
 * few common other names map onto their sector. Anything else is a 400 listing the words, never a
 * silent empty set.
 */
export function parseSector(raw: string | null): Parsed<string | undefined> {
  if (raw === null || raw.trim() === "") return ok(undefined);
  const sector = SECTOR_WORDS.get(compact(raw));
  if (!sector) return bad(`sector must be one of: ${SECTORS.join(", ")}`);
  return ok(sector);
}

/** Free search text: at most 200 characters. */
export function parseQuery(raw: string | null): Parsed<string | undefined> {
  if (raw === null || raw.trim() === "") return ok(undefined);
  if (raw.length > 200) return bad("q must be at most 200 characters");
  return ok(raw.trim());
}

export function parseStatuses(raw: string | null): Parsed<Array<(typeof ROUND_STATUSES)[number]> | undefined> {
  if (raw === null) return ok(undefined);
  const values = raw.split(",");
  if (values.some((s) => !(ROUND_STATUSES as readonly string[]).includes(s))) {
    return bad(`status must be one or more of: ${ROUND_STATUSES.join(", ")}`);
  }
  return ok(values as Array<(typeof ROUND_STATUSES)[number]>);
}

export function parseCertainty(raw: string | null): Parsed<RoundCertainty | undefined> {
  if (raw === null) return ok(undefined);
  if (!(ROUND_CERTAINTIES as readonly string[]).includes(raw)) {
    return bad(`certainty must be one of: ${ROUND_CERTAINTIES.join(", ")}`);
  }
  return ok(raw as RoundCertainty);
}

export function parseFormat(raw: string | null): Parsed<(typeof ROUND_FORMATS)[number]> {
  if (raw === null) return ok("json");
  if (!(ROUND_FORMATS as readonly string[]).includes(raw)) return bad(`format must be one of: ${ROUND_FORMATS.join(", ")}`);
  return ok(raw as (typeof ROUND_FORMATS)[number]);
}

/**
 * `sort=amount` orders by USD, largest first, unknown amounts last; `sort=trending` by the Trending
 * lane's score, the most discussed of the rounds first seen in the last three days first; absent is newest announced first.
 */
export function parseSort(raw: string | null): Parsed<FeedSort> {
  if (raw === null || raw === "") return ok("");
  if (!(FEED_SORTS as readonly string[]).includes(raw)) return bad("sort must be amount or trending, or absent for newest first");
  return ok(raw as FeedSort);
}

/** A cursor only pages the order that wrote it, so one from the other sort is a 400, not a silent restart. */
export function parseCursor(raw: string | null, sort: FeedSort = ""): Parsed<string | undefined> {
  if (raw === null) return ok(undefined);
  if (sort === "trending" || raw.startsWith("trend:")) {
    if (parseTrendingCursor(raw) === null) return bad('cursor under sort=trending must be "trend:N"');
    if (sort !== "trending") return bad("cursor was written under a different sort; drop it or match the sort");
    return ok(raw);
  }
  const cursor = parseRoundCursor(raw);
  if (!cursor) return bad('cursor must be "YYYY-MM-DD|id" (an empty date reads the undated tail), or "amt:N|id" under sort=amount');
  if (cursor.sort !== sort) return bad("cursor was written under a different sort; drop it or match the sort");
  return ok(raw);
}
