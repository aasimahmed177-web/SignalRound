// The public demo's rate limiter. Every open door that costs something per call (the read API and
// its exports, the command palette's search, the MCP tools, the public Add to Slack, the logo route)
// asks here first. A serverless deployment runs many short-lived instances, so the count lives in the
// store (the rate_limits table, one row per bucket and client in a fixed window); an in-memory count
// in front of it refuses a client this instance has already seen go over without a round trip.
//
// Only a public demo's visitors are counted: a private instance's callers carried the password (or
// the operator left it open on purpose), and an admin is the operator. A store that cannot count
// lets the call through: a limiter that fails closed would take the whole demo down with the
// database, and the Vercel Firewall rules in docs/deploy.md stand in front either way.

import { createHash } from "node:crypto";
import { schema } from "@fireround/core/db";
import { lt, sql } from "drizzle-orm";
import { alexandriaCaller, isPublicDemo } from "@/lib/access";
import { db } from "@/lib/db";

const { rateLimits } = schema;

export interface Limit {
  bucket: string;
  /** Calls allowed per window. */
  limit: number;
  windowMs: number;
}

const MINUTE = 60_000;

/**
 * The budgets, per client address. Generous for a person, tight for a script: a reader paging the API
 * or typing in the palette never meets them, and one address cannot pull the store at scale.
 */
export const LIMITS = {
  /** /api/v1 JSON and JSONL pages (at most 200 rows each). */
  api: { bucket: "api", limit: 60, windowMs: MINUTE },
  /** A CSV with no limit: up to 10,000 rows, fifty queries. */
  export: { bucket: "export", limit: 10, windowMs: 10 * MINUTE },
  /** The command palette asks on each keystroke. */
  search: { bucket: "search", limit: 120, windowMs: MINUTE },
  mcp: { bucket: "mcp", limit: 60, windowMs: MINUTE },
  /** The public Add to Slack: ten starts per ten minutes, as before. */
  slackConnect: { bucket: "slack-connect", limit: 10, windowMs: 10 * MINUTE },
  /** A page draws a tile per row, and the CDN answers most of them. */
  logo: { bucket: "logo", limit: 600, windowMs: MINUTE },
  companyRequest: { bucket: "company-request", limit: 3, windowMs: 24 * 60 * MINUTE },
} as const satisfies Record<string, Limit>;

/** The client address the platform reports: Vercel's first forwarded hop (set by Vercel, not the client), else a constant bucket. */
export function clientKey(h: Headers): string {
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || "unknown";
}

export interface RateDecision {
  ok: boolean;
  /** Seconds until the window turns over. */
  retryAfter: number;
}

/** This instance's view of each window, keyed by row key and window start. */
const local = new Map<string, number>();
const LOCAL_MAX = 10_000;
/** One call in this many also deletes rows from windows a day old, so the table stays small without a cron. */
const PRUNE_ONE_IN = 200;

export async function resetRateLimitsForTests(): Promise<void> {
  local.clear();
  await (await db()).delete(rateLimits);
}

/**
 * Count one call from `client` against `limit` and say whether it may proceed. The client is hashed
 * before it is stored or kept, so no address is written anywhere.
 */
export async function rateLimit(limit: Limit, client: string, now: number = Date.now(), failClosed = false): Promise<RateDecision> {
  const windowStart = Math.floor(now / limit.windowMs) * limit.windowMs;
  const retryAfter = Math.max(1, Math.ceil((windowStart + limit.windowMs - now) / 1000));
  const key = `${limit.bucket}:${createHash("sha256").update(client).digest("hex").slice(0, 32)}`;
  const localKey = `${key}@${windowStart}`;
  const seen = (local.get(localKey) ?? 0) + 1;
  if (local.size >= LOCAL_MAX) local.clear();
  local.set(localKey, seen);
  // This instance alone has seen more than the budget: the store's count can only be higher.
  if (seen > limit.limit) return { ok: false, retryAfter };
  try {
    const handle = await db();
    const [row] = await handle
      .insert(rateLimits)
      .values({ key, windowStart: new Date(windowStart), hits: 1 })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: {
          hits: sql`case when ${rateLimits.windowStart} = excluded.window_start then ${rateLimits.hits} + 1 else 1 end`,
          windowStart: sql`excluded.window_start`,
        },
      })
      .returning({ hits: rateLimits.hits });
    if (Math.random() * PRUNE_ONE_IN < 1) {
      await handle.delete(rateLimits).where(lt(rateLimits.windowStart, new Date(now - 24 * 60 * MINUTE)));
    }
    return { ok: (row?.hits ?? 1) <= limit.limit, retryAfter };
  } catch {
    return { ok: !failClosed, retryAfter };
  }
}

/** Whether this request is counted at all: a public demo's visitor, never an admin or a private instance's caller. */
export function counted(insider: boolean): boolean {
  return isPublicDemo() && !insider;
}

/** The refusal: a 429 nobody caches, saying when to come back. */
export function tooManyRequests(decision: RateDecision): Response {
  return Response.json(
    { error: `Too many requests from this address. Try again in ${decision.retryAfter} seconds.` },
    { status: 429, headers: { "retry-after": String(decision.retryAfter), "cache-control": "no-store" } },
  );
}

/**
 * The route handlers' one-liner: null when the request may proceed (not counted, Alexandria's
 * calls, or within budget), else the 429 to return.
 */
export async function limitRequest(request: Request, limit: Limit, insider = false): Promise<Response | null> {
  if (!counted(insider) || alexandriaCaller(request.headers.get("authorization"))) return null;
  const decision = await rateLimit(limit, clientKey(request.headers));
  return decision.ok ? null : tooManyRequests(decision);
}
