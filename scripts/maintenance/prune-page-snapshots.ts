import { closeDb, getDb } from "@fireround/core/db";
import { prunePageSnapshots } from "@fireround/core/snapshots";

const days = Number(process.env.SNAPSHOT_RETENTION_DAYS ?? 90);
const { reads, snapshots } = await prunePageSnapshots(await getDb(), days);
console.log(`pruned ${reads} stale reads and ${snapshots} unreferenced snapshots older than ${days} days`);
await closeDb();
