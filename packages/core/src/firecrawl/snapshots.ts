import { and, eq, lt, notExists, sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { pageSnapshotReads, pageSnapshots } from "../db/schema.ts";

export const MAX_SNAPSHOT_BYTES = 128 * 1024;
export const SNAPSHOT_RETENTION_DAYS = 90;

/** A complete main-content read, never a truncated page that would change replay semantics. */
export async function savePageSnapshot(url: string, markdown: string | undefined, rawExtraction?: unknown): Promise<string | null> {
  "use step";
  if (!markdown || Buffer.byteLength(markdown, "utf8") > MAX_SNAPSHOT_BYTES) return null;
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(markdown))).toString("hex");
  try {
    const { getDb } = await import("../db/index.ts");
    const db = await getDb();
    await db.insert(pageSnapshots).values({ hash, markdown }).onConflictDoNothing();
    await db
      .insert(pageSnapshotReads)
      .values({ sourceUrl: url, snapshotHash: hash, ...(rawExtraction === undefined ? {} : { rawExtraction }) })
      .onConflictDoUpdate({
        target: [pageSnapshotReads.sourceUrl, pageSnapshotReads.snapshotHash],
        set: { readAt: sql`now()`, ...(rawExtraction === undefined ? {} : { rawExtraction }) },
      });
    return hash;
  } catch {
    return null;
  }
}

/** Daily retention: remove stale URL readings, then only snapshots no reading still references. */
export async function prunePageSnapshots(db: Db, days = SNAPSHOT_RETENTION_DAYS): Promise<{ reads: number; snapshots: number }> {
  if (!Number.isInteger(days) || days < 1) throw new Error("retention must be a positive integer in days");
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const reads = await db
    .delete(pageSnapshotReads)
    .where(lt(pageSnapshotReads.readAt, cutoff))
    .returning({ hash: pageSnapshotReads.snapshotHash });
  const snapshots = await db
    .delete(pageSnapshots)
    .where(
      and(
        lt(pageSnapshots.createdAt, cutoff),
        notExists(
          db
            .select({ hash: pageSnapshotReads.snapshotHash })
            .from(pageSnapshotReads)
            .where(eq(pageSnapshotReads.snapshotHash, pageSnapshots.hash)),
        ),
      ),
    )
    .returning({ hash: pageSnapshots.hash });
  return { reads: reads.length, snapshots: snapshots.length };
}
