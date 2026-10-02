// Apply migrations to DATABASE_URL at build or deploy time. No DATABASE_URL: nothing to do
// (the embedded PGlite database migrates itself on first use). The driver follows the URL,
// the same way the app's client does: Neon over HTTP, any other Postgres over pg.
//
// Several builds can migrate one database at once (a push to main and to a preview branch that
// shares its DATABASE_URL). The loser of that race fails on "already exists"; it waits and runs
// again, and by then the winner has recorded the migration, so the second run is a no-op.

import path from "node:path";
import { connectPostgres, directUrl } from "@fireround/core/db";
import { migrateSlackTargets } from "../lib/slack-credentials.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("migrate: DATABASE_URL not set, skipping (embedded database migrates on boot)");
  process.exit(0);
}
// Always the direct host: a migration is DDL in a transaction, the pooler's weak spot (directUrl).
const { db, driver, close } = await connectPostgres(directUrl(url));
const migrationsFolder = path.join(process.cwd(), "packages/core/drizzle");

async function run(): Promise<void> {
  if (driver === "neon") {
    const { migrate } = await import("drizzle-orm/neon-http/migrator");
    await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
  } else {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
  }
}

/** Postgres' duplicate_table and duplicate_object codes, or their message, anywhere in the cause chain. */
function isConcurrentDuplicate(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; e && depth < 5; depth++) {
    const { code, message, cause } = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (code === "42P07" || code === "42710") return true;
    if (typeof message === "string" && message.includes("already exists")) return true;
    // Two CREATE TABLE IF NOT EXISTS racing each other can still collide in the catalog itself.
    if (code === "23505" && typeof message === "string" && /pg_(type|class)/.test(message)) return true;
    e = cause;
  }
  return false;
}

const ATTEMPTS = 6;
for (let attempt = 1; ; attempt++) {
  try {
    await run();
    break;
  } catch (error) {
    if (attempt >= ATTEMPTS || !isConcurrentDuplicate(error)) throw error;
    console.log(`migrate: another build is migrating this database, retrying (${attempt}/${ATTEMPTS - 1})`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}
await migrateSlackTargets(db);
console.log(`migrate: up to date (${driver})`);
await close();
