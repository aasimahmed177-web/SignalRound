import path from "node:path";
import type { FeedRecord } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { getDb, resetDbForTests } from "@fireround/core/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";

const migrationsFolder = path.join(process.cwd(), "packages/core/drizzle");

/**
 * A fresh Postgres with the real migrations applied. In-memory PGlite by default. With
 * TEST_DATABASE_URL set, a real server instead (schema dropped and rebuilt per test, so run
 * with --no-file-parallelism): the same suite then proves the pg driver path.
 */
export async function testDb(): Promise<Db> {
  resetDbForTests();
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const handle = await getDb({ databaseUrl: url });
    await handle.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
    const { migrate: migratePg } = await import("drizzle-orm/node-postgres/migrator");
    await migratePg(handle as unknown as Parameters<typeof migratePg>[0], { migrationsFolder });
    return handle;
  }
  const handle = await getDb({ pgliteDir: "memory://", databaseUrl: "" });
  await migrate(handle as Parameters<typeof migrate>[0], { migrationsFolder });
  return handle;
}

export function record(partial: Partial<FeedRecord> & { company_name: string }): FeedRecord {
  const key = partial.company_key ?? partial.company_name.toLowerCase();
  const stage = partial.stage ?? "series_a";
  const announced = partial.announced_date === undefined ? "2026-09-02" : partial.announced_date;
  return {
    id: `${key.replace(/\s+/g, "-")}:${stage}:${announced ?? "undated"}`,
    company_key: key,
    company_domain: null,
    company_website: null,
    company_description: null,
    stage,
    stage_as_written: "Series A",
    is_extension: false,
    amount: { value: 20, currency: "USD", as_written: "$20M", usd_millions: 20, fx_rate: 1, fx_date: "2026-09-02" },
    valuation_as_written: null,
    lead_investors: ["Fund One"],
    other_investors: [],
    announced_date: announced,
    date_precision: announced ? "day" : "unknown",
    headquarters: null,
    sector: "fintech",
    evidence_quotes: ["Acme raised $20M."],
    sources: [{ url: "https://reuters.com/acme", host: "reuters.com", title: "Acme raises $20M" }],
    confidence: 0.8,
    status: "new",
    undated: announced === null,
    // A record that reached persist has been judged: publish requires the page's confirmation.
    verification: { status: "confirmed", notes: [], url: "https://reuters.com/acme" },
    ...partial,
  };
}
