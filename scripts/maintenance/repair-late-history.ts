import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { repairLateHistory } from "../../lib/late-history.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const apply = process.argv.includes("--apply");
const changes = await repairLateHistory(await openStore(), apply);
for (const row of changes)
  console.log(`${row.id}  ${row.announcedOn} first seen ${row.firstSeenAt}  ${row.basis}: ${row.source ?? "source not stored"}`);
console.log(`${changes.length} late rounds ${apply ? "moved" : "would move"} to history.`);
await invalidateScriptEntityPages();
await closeDb();
