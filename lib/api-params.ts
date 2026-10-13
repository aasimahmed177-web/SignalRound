// Request-param parsing shared by the read API: a bad value is a 400 with one line, never a
// silent empty set. /api/v1/runs shares the limit rule.

import type { RoundCertainty, Stage } from "@fireround/core";
import { classifyStage, ROUND_CERTAINTIES, SECTOR_GROUP_LABEL, SECTOR_GROUPS, SECTORS, STAGES } from "@fireround/core";
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

const SINCE_HELP = "since must be a date (YYYY-MM-DD), a month (YYYY-MM), today, yesterday, or a number of days back such as 7d";
const MAX_DAYS_BACK = 36_500;

/**
 * The first day a read counts, as a person or an agent writes it: a date ("2026-10-04"), a month
 * ("2026-10", its first day), "today", "yesterday", or a number of days back ("7d", the day a week
 * before today). Days are UTC, the clock the rankings' windows count on. Anything else is a 400.
 */
export function parseSince(raw: string | null, now: Date = new Date()): Parsed<string | undefined> {
  if (raw === null) return ok(undefined);
  const word = raw.trim().toLowerCase();
  const daysBack = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString().slice(0, 10);
  if (word === "today") return ok(daysBack(0));
  if (word === "yesterday") return ok(daysBack(1));
  const back = /^(\d+)d$/.exec(word);
  if (back) {
    const n = Number(back[1]);
    return n <= MAX_DAYS_BACK ? ok(daysBack(n)) : bad(SINCE_HELP);
  }
  const day = /^\d{4}-\d{2}$/.test(word) ? `${word}-01` : word;
  if (!DAY.test(day)) return bad(SINCE_HELP);
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return bad(SINCE_HELP);
  return ok(day);
}

/** Other words for the rankings' windows. */
const WINDOW_WORDS: Record<string, string> = { week: "7d", month: "30d", quarter: "90d" };

/** A ranking's window: one of `choices` ("7d"), or week, month or quarter for 7d, 30d or 90d. */
export function parseWindow<T extends string>(raw: string | null, choices: readonly T[], fallback: T): Parsed<T> {
  if (raw === null || raw.trim() === "") return ok(fallback);
  const word = raw.trim().toLowerCase();
  const value = WINDOW_WORDS[word] ?? word;
  if (!(choices as readonly string[]).includes(value)) return bad(`window must be one of: ${choices.join(", ")}, or week, month, quarter`);
  return ok(value as T);
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

/** Other words for a sector or a group, compacted (lowercase, letters and digits only). */
const SECTOR_ALIASES: Record<string, string> = {
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
  saas: "software",
  b2bsoftware: "software",
  enterprise: "enterprise software",
  payment: "payments",
  insurance: "insurtech",
  web3: "crypto",
  blockchain: "crypto",
  defi: "crypto",
  healthcare: "health",
  digitalhealth: "healthtech",
  lifesciences: "biotech",
  medicaldevices: "medtech",
  climatetech: "climate",
  cleantech: "climate",
  ev: "mobility",
  transportation: "mobility",
  robot: "robotics",
  deeptech: "hardware",
  chips: "semiconductors",
  semis: "semiconductors",
  semiconductor: "semiconductors",
  spacetech: "space",
  aerospace: "aerospace and defense",
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
  industrial: "industrials",
};
const GROUPS = Object.keys(SECTOR_GROUPS) as Array<keyof typeof SECTOR_GROUPS>;
const SECTOR_WORDS = new Map<string, string>([
  ...SECTORS.map((s) => [compact(s), s] as const),
  ...GROUPS.flatMap((g) => [[compact(g), g] as const, [compact(SECTOR_GROUP_LABEL[g]), g] as const]),
  ...Object.entries(SECTOR_ALIASES),
]);
const GROUP_HINT = GROUPS.filter((g) => SECTOR_GROUPS[g].length > 1)
  .map((g) => `${g} (${SECTOR_GROUPS[g].join(", ")})`)
  .join("; ");

/**
 * A sector or a group of sectors from the feed's taxonomy, as a person or an agent writes it: "AI
 * infrastructure", "ai-infra", "Fin Tech", "dev tools", "healthcare". Case, spacing and punctuation
 * don't count, and a few common other names map on. A group ("ai", "health", "climate") matches every
 * sector under it (SECTOR_GROUPS). Anything else is a 400 listing the words, never a silent empty set.
 */
export function parseSector(raw: string | null): Parsed<string | undefined> {
  if (raw === null || raw.trim() === "") return ok(undefined);
  const sector = SECTOR_WORDS.get(compact(raw));
  if (!sector)
    return bad(
      `sector must be a sector or a group. Sectors: ${SECTORS.join(", ")}. Groups, each matching the sectors listed: ${GROUP_HINT}`,
    );
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
 * `sort=amount` orders by USD, published announced rounds first and then the provisional ones (flagged,
 * expected, reported, unconfirmed), each largest first with unknown amounts last; `sort=trending` by the Trending
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
  if (!cursor)
    return bad('cursor must be "YYYY-MM-DD|id" (an empty date reads the undated tail), or "amt:N|id" or "amtp:N|id" under sort=amount');
  if (cursor.sort !== sort) return bad("cursor was written under a different sort; drop it or match the sort");
  return ok(raw);
}
