// App-side database handle. PGlite (./data) with migrations applied on first
// use; Neon when DATABASE_URL is set (migrations run at deploy via drizzle-kit).
// One migration-applied handle per process: Next.js instantiates modules per
// route bundle, so the promise lives on globalThis.

import path from "node:path";
import type { Db, DbOptions } from "@fireround/core/db";
import { getDb, StoreLockedError } from "@fireround/core/db";
import { attachDatabasePool } from "@vercel/functions";
import { concurrencyLimited, retryingFetch } from "./db-retry.ts";
import { migrateSlackTargets } from "./slack-credentials.ts";

const globalScope = globalThis as typeof globalThis & { __fundingFeedReady?: Promise<Db> };

/**
 * Queries one process may have on Neon at once over HTTP, separately from the pg socket pool.
 * A function instance serves many requests at a time, so under a spike this is what
 * keeps a few dozen instances from asking for more connections than a small compute has.
 */
const NEON_MAX_IN_FLIGHT = 16;

export function db(): Promise<Db> {
  return open({ onPool: process.env.VERCEL ? attachOnVercel : undefined });
}

/** On Vercel's Fluid compute an instance may suspend with idle connections open; this closes them first. */
function attachOnVercel(pool: Parameters<typeof attachDatabasePool>[0]): void {
  attachDatabasePool(pool);
}

/** The first caller in a process picks the options; every later one shares its handle. */
function open(opts: DbOptions): Promise<Db> {
  if (!globalScope.__fundingFeedReady) {
    globalScope.__fundingFeedReady = (async () => {
      if (process.env.DATABASE_URL) {
        // Neon's HTTP driver fetches once per query; at most NEON_MAX_IN_FLIGHT run at once per process, and a
        // bare "fetch failed" gets one careful retry (lib/db-retry.ts). Set before the first query, and never
        // over a fetch someone else installed.
        const { neonConfig } = await import("@neondatabase/serverless");
        neonConfig.fetchFunction ??= concurrencyLimited(retryingFetch(fetch), NEON_MAX_IN_FLIGHT);
      }
      const handle = await getDb(opts);
      if (!process.env.DATABASE_URL) {
        const { migrate } = await import("drizzle-orm/pglite/migrator");
        await migrate(handle as Parameters<typeof migrate>[0], { migrationsFolder: path.join(process.cwd(), "packages/core/drizzle") });
      }
      await migrateSlackTargets(handle);
      return handle;
    })().catch((err) => {
      globalScope.__fundingFeedReady = undefined;
      throw err;
    });
  }
  return globalScope.__fundingFeedReady;
}

/**
 * The handle for a command-line script, always on a Neon database's direct host: a script's long
 * transactions and session settings (PGOPTIONS) do not survive the transaction-mode pooler, which
 * the app's own URL may name (directUrl in @fireround/core/db). A locked store is an answer, not a
 * crash: the message says which process holds it and what to do, so it prints alone and the script
 * exits 1 rather than dumping a stack trace with pnpm's ELIFECYCLE under it.
 */
export async function openStore(): Promise<Db> {
  try {
    return await open({ direct: true });
  } catch (err) {
    if (!(err instanceof StoreLockedError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}
