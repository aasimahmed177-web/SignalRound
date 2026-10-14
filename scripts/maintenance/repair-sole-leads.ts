// List rounds whose one investor is stored as a participant while their pages state the whole round's
// money as coming from it (lib/sole-lead-repair.ts), and raise it to lead with --apply. Dry run by
// default. Safe to run again.
//   pnpm repair-sole-leads                       # list only
//   pnpm repair-sole-leads -- --ids a,b --apply  # write these rounds

import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";
import { applySoleLeadRepair, planSoleLeadRepair } from "../../lib/sole-lead-repair.ts";

const apply = process.argv.includes("--apply");
const at = process.argv.indexOf("--ids");
const ids = at >= 0 && process.argv[at + 1] ? process.argv[at + 1].split(",").filter(Boolean) : undefined;
const handle = await openStore();
console.log(apply ? "APPLY: writing." : "DRY RUN: nothing is written. Add --apply to write.");
const plan = await planSoleLeadRepair(handle, ids);
for (const f of plan) console.log(`${f.roundId} (${f.company}, ${f.amount}): ${f.investor} -> lead (${f.page})`);
console.log(`\n${plan.length} round(s) to repair.`);
if (apply) {
  const done = await applySoleLeadRepair(handle, plan);
  console.log(`Repaired ${done.applied.length}.${done.stale.length ? ` Skipped as changed since read: ${done.stale.join(", ")}` : ""}`);
  await invalidateScriptEntityPages();
}
await closeDb();
process.exit(0);
