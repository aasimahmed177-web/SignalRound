import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { repairReleaseDays } from "../../lib/late-history.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const apply = process.argv.includes("--apply");
const changes = await repairReleaseDays(await openStore(), apply);
for (const row of changes)
  console.log(`${row.id}  ${row.from ?? "undated"} -> ${row.to}${row.backToFeed ? "  back to the feed" : ""}\n  ${row.quote}`);
console.log(`${changes.length} rounds ${apply ? "re-dated" : "would be re-dated"} to their wire release's day.`);
if (apply) await invalidateScriptEntityPages();
await closeDb();
