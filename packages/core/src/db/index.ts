// Database client. No DATABASE_URL: PGlite, a file under ./data. With one: a Neon
// host goes over Neon's serverless HTTP driver (no sockets to pool on a function),
// any other Postgres over pg. Same schema, same migrations, one dialect. Tables
// are imported from ./schema.ts for queries.
//
// PGlite is single-process and must be closed cleanly. This module keeps one
// client per process (on globalThis, because Next.js compiles routes and the
// Workflow SDK step bundle as separate module instances, and two PGlite clients
// on one directory see different data and corrupt the store), holds a pid lock
// beside the data directory, closes on SIGINT/SIGTERM, and turns an unreadable
// directory into a message that says what to do.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof drizzlePglite>;

export type Driver = "neon" | "pg";

/** Neon hosts take the HTTP driver; DATABASE_DRIVER=neon|pg overrides (a Neon URL behind a custom domain, a pg pool by choice). */
export function driverFor(url: string): Driver {
  const forced = process.env.DATABASE_DRIVER;
  if (forced === "neon" || forced === "pg") return forced;
  try {
    return /\.neon\.tech$/.test(new URL(url).hostname) ? "neon" : "pg";
  } catch {
    return "pg";
  }
}

/**
 * The database's direct endpoint for a URL that names its pooler; any other URL as given. Neon's
 * pooler is a host (`ep-x-pooler.region.aws.neon.tech` to `ep-x.region.aws.neon.tech`); PlanetScale's
 * is a port on the same host (PgBouncer on 6432, Postgres on 5432), and a `|bouncer` suffix on the
 * user picks a dedicated PgBouncer. The pooler is PgBouncer in transaction mode: right for the app's
 * short reads, wrong for a script or migration that leans on session state (a SET, PGOPTIONS, a long
 * transaction), which it silently drops or refuses between statements.
 */
export function directUrl(url: string): string {
  try {
    const u = new URL(url);
    if (/\.neon\.tech$/.test(u.hostname) && /-pooler\./.test(u.hostname)) {
      return url.replace(u.hostname, u.hostname.replace("-pooler.", "."));
    }
    if (/\.psdb\.cloud$/.test(u.hostname) && (u.port === "6432" || u.username.includes("%7C") || u.username.includes("|"))) {
      u.port = "5432";
      u.username = decodeURIComponent(u.username).split("|")[0];
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

/** A Drizzle client over DATABASE_URL with the right driver, plus its closer. Used by getDb and by the migrate script. */
/** Connections one process may hold in its pg pool: DATABASE_POOL_MAX, else 3. */
export function poolMax(): number {
  const n = Number(process.env.DATABASE_POOL_MAX);
  return Number.isInteger(n) && n > 0 ? n : 3;
}

export async function connectPostgres(
  url: string,
  onPool?: (pool: import("pg").Pool) => void,
): Promise<{ db: Db; driver: Driver; close: () => Promise<void> }> {
  const driver = driverFor(url);
  if (driver === "neon") {
    const { neon } = await import("@neondatabase/serverless");
    // SAFETY: every driver returns a PgDatabase with the same query-builder surface; the union type breaks Drizzle overloads.
    return { db: drizzleNeon({ client: neon(url) }) as unknown as Db, driver, close: async () => {} };
  }
  const { default: pg } = await import("pg");
  const { drizzle: drizzlePg } = await import("drizzle-orm/node-postgres");
  // A serverless instance holds its connections only while it works: idle ones close within seconds,
  // so dozens of instances stay under a PgBouncer's client-connection ceiling. A connection the
  // pooler cannot hand out within five seconds is an error, not a wait: a page read fails fast and its
  // cached copy keeps serving, instead of every render queueing behind the pooler's login timeout.
  const pool = new pg.Pool({ connectionString: url, max: poolMax(), idleTimeoutMillis: 5_000, connectionTimeoutMillis: 5_000 });
  onPool?.(pool);
  // SAFETY: as above.
  return { db: drizzlePg({ client: pool }) as unknown as Db, driver, close: () => pool.end() };
}

interface DbState {
  cached: Db | null;
  closer: (() => Promise<void>) | null;
  hooksInstalled: boolean;
}
const globalScope = globalThis as typeof globalThis & { __fundingFeedDb?: DbState };
globalScope.__fundingFeedDb ??= { cached: null, closer: null, hooksInstalled: false };
const state: DbState = globalScope.__fundingFeedDb;

export interface DbOptions {
  databaseUrl?: string;
  /** Connect to the database's direct endpoint even when the URL names the pooler (directUrl): scripts and migrations. */
  direct?: boolean;
  /** Called with the pg pool when one is made, so a host can manage its connections (Vercel's attachDatabasePool). */
  onPool?: (pool: import("pg").Pool) => void;
  /** PGlite data directory; default ./data/fireround. Use "memory://" for tests. */
  pgliteDir?: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Another live process holds the PGlite directory. Its own class so a script can print the message without the stack. */
export class StoreLockedError extends Error {
  override readonly name = "StoreLockedError";
  constructor(dir: string, pid: number) {
    super(
      `The embedded database at ${dir} is open in another process (pid ${pid}). PGlite is single-process: stop the other command first, or set DATABASE_URL to a Postgres so both can run.`,
    );
  }
}

function acquireLock(dir: string): () => void {
  const lockPath = `${dir}.lock`;
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    if (pid && pid !== process.pid && pidAlive(pid)) throw new StoreLockedError(dir, pid);
  }
  writeFileSync(lockPath, String(process.pid));
  return () => {
    try {
      if (existsSync(lockPath) && readFileSync(lockPath, "utf8").trim() === String(process.pid)) rmSync(lockPath);
    } catch {
      // best effort
    }
  };
}

export async function getDb(opts: DbOptions = {}): Promise<Db> {
  if (state.cached) return state.cached;
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (url) {
    const { db, close } = await connectPostgres(opts.direct ? directUrl(url) : url, opts.onPool);
    state.cached = db;
    state.closer = close;
    return state.cached;
  }
  if (process.env.VERCEL) {
    throw new Error("DATABASE_URL is not set. On Vercel the embedded database has nowhere to live; attach a Postgres (Neon) and redeploy.");
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = opts.pgliteDir ?? process.env.PGLITE_DIR ?? "./data/fireround";
  const memory = dir === "memory://";
  let releaseLock = () => {};
  if (!memory) {
    mkdirSync(dirname(dir), { recursive: true });
    releaseLock = acquireLock(dir);
  }
  const client = new PGlite(memory ? undefined : dir);
  try {
    await client.waitReady;
    await client.query("select 1");
  } catch (err) {
    releaseLock();
    throw new Error(
      `The embedded database at ${dir} could not be opened (${err instanceof Error ? err.message : String(err)}). ` +
        "It was probably not closed cleanly. The store is a cache of the web: remove the directory and run a sweep again.",
    );
  }
  state.cached = drizzlePglite({ client });
  state.closer = async () => {
    try {
      await client.close();
    } finally {
      releaseLock();
    }
  };
  if (!memory) installShutdownHooks();
  return state.cached;
}

function installShutdownHooks(): void {
  if (state.hooksInstalled) return;
  state.hooksInstalled = true;
  const shutdown = (signal: NodeJS.Signals) => {
    const close = state.closer;
    state.closer = null;
    process.removeAllListeners(signal);
    if (!close) {
      process.kill(process.pid, signal);
      return;
    }
    close().finally(() => {
      process.kill(process.pid, signal);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("beforeExit", () => {
    const close = state.closer;
    state.closer = null;
    void close?.();
  });
}

/** Close the embedded database and release the lock. Scripts call this before exiting. */
export async function closeDb(): Promise<void> {
  const close = state.closer;
  state.closer = null;
  state.cached = null;
  await close?.();
}

export function resetDbForTests(): void {
  void state.closer?.();
  state.cached = null;
  state.closer = null;
}

export { schema };
