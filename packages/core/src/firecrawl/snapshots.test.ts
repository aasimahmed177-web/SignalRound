import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, expect, test } from "vitest";
import { closeDb, getDb } from "../db/index.ts";
import { pageSnapshotReads, pageSnapshots } from "../db/schema.ts";
import { MAX_SNAPSHOT_BYTES, prunePageSnapshots, savePageSnapshot } from "./snapshots.ts";

afterEach(async () => {
  await closeDb();
});

test("deduplicates identical markdown and retains the URL's extraction", async () => {
  const db = await getDb({ pgliteDir: "memory://" });
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  const a = await savePageSnapshot("https://example.com/a", "# A\nA raised $2 million.", { rounds: ["a"] });
  const b = await savePageSnapshot("https://example.com/b", "# A\nA raised $2 million.");
  expect(a).toMatch(/^[a-f0-9]{64}$/);
  expect(a).toBe(b);
  expect(await db.select().from(pageSnapshots)).toHaveLength(1);
  expect(await db.select().from(pageSnapshotReads)).toHaveLength(2);
  expect(
    (await db.select().from(pageSnapshotReads).where(eq(pageSnapshotReads.sourceUrl, "https://example.com/a")))[0]?.rawExtraction,
  ).toEqual({
    rounds: ["a"],
  });
  expect(await savePageSnapshot("https://example.com/too-long", "x".repeat(MAX_SNAPSHOT_BYTES + 1))).toBeNull();
  expect(await db.select().from(pageSnapshots)).toHaveLength(1);
});

test("a failed snapshot write does not fail the scrape", async () => {
  await getDb({ pgliteDir: "memory://" });
  expect(await savePageSnapshot("https://example.com/a", "# A\nA raised $2 million.")).toBeNull();
});

test("retention removes stale references and unreferenced content, but keeps shared content", async () => {
  const db = await getDb({ pgliteDir: "memory://" });
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  const shared = await savePageSnapshot("https://example.com/old", "shared");
  await savePageSnapshot("https://example.com/new", "shared");
  const orphan = await savePageSnapshot("https://example.com/orphan", "orphan");
  const old = new Date("2025-01-01T00:00:00Z");
  await db.update(pageSnapshotReads).set({ readAt: old }).where(eq(pageSnapshotReads.sourceUrl, "https://example.com/old"));
  await db.update(pageSnapshotReads).set({ readAt: old }).where(eq(pageSnapshotReads.sourceUrl, "https://example.com/orphan"));
  await db.update(pageSnapshots).set({ createdAt: old });
  expect(await prunePageSnapshots(db)).toEqual({ reads: 2, snapshots: 1 });
  expect((await db.select().from(pageSnapshots)).map((row) => row.hash)).toEqual([shared]);
  expect((await db.select().from(pageSnapshotReads)).map((row) => row.snapshotHash)).toEqual([shared]);
  expect(orphan).not.toBe(shared);
});

test("the page snapshot migration is idempotent", async () => {
  const sql = readFileSync(new URL("../../drizzle/20260927120000_page_snapshots/migration.sql", import.meta.url), "utf8");
  const client = new PGlite();
  try {
    for (let run = 0; run < 2; run++) {
      for (const statement of sql.split("--> statement-breakpoint")) await client.exec(statement);
    }
    const result = await client.query("select count(*) as count from page_snapshots");
    expect(result.rows[0]).toEqual({ count: 0 });
  } finally {
    await client.close();
  }
});
