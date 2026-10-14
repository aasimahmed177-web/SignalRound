// Rows the "reported later" mark froze in review take the disposition their stored facts give
// (lib/late-history.ts settleReportedLater). A dry run by default:
//   node --env-file-if-exists=.env scripts/maintenance/settle-reported-later.ts           # what would move
//   node --env-file-if-exists=.env scripts/maintenance/settle-reported-later.ts --apply   # write
import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { settleReportedLater } from "../../lib/late-history.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const apply = process.argv.includes("--apply");
const changes = await settleReportedLater(await openStore(), apply);
for (const row of changes) console.log(`${row.id}  review -> ${row.to}`);
const count = (to: string) => changes.filter((c) => c.to === to).length;
console.log(`${changes.length} rows ${apply ? "settled" : "would settle"}: ${count("publish")} publish, ${count("flagged")} flagged.`);
if (apply) await invalidateScriptEntityPages();
await closeDb();
