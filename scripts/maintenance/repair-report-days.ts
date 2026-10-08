import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { repairStaleReportDays } from "../../lib/freshness.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const apply = process.argv.includes("--apply");
const changes = await repairStaleReportDays(await openStore(), apply);
for (const row of changes) console.log(`${row.id}  ${row.from} -> ${row.to}${row.backToFeed ? "  back to the feed" : ""}`);
console.log(`${changes.length} rounds ${apply ? "re-dated" : "would be re-dated"} to their release's day.`);
if (apply) await invalidateScriptEntityPages();
await closeDb();
