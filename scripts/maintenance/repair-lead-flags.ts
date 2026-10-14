// List rounds whose own pages name a lead the row does not mark, or a firm a later page's lone reading
// took off the round (lib/lead-flag-repair.ts), and write them with --apply. Adds and raises only.
// Dry run by default. Safe to run again.
//   pnpm repair-lead-flags                       # list only
//   pnpm repair-lead-flags -- --ids a,b --apply  # write these rounds

import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { applyLeadFlagRepair, planLeadFlagRepair } from "../../lib/lead-flag-repair.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const apply = process.argv.includes("--apply");
const at = process.argv.indexOf("--ids");
const ids = at >= 0 && process.argv[at + 1] ? process.argv[at + 1].split(",").filter(Boolean) : undefined;
const handle = await openStore();
console.log(apply ? "APPLY: writing." : "DRY RUN: nothing is written. Add --apply to write.");
const plan = await planLeadFlagRepair(handle, ids);
for (const f of plan) {
  console.log(`${f.roundId} (${f.company})`);
  console.log(`  now:   leads ${JSON.stringify(f.from.leads)}, participants ${JSON.stringify(f.from.participants)}`);
  console.log(`  after: leads ${JSON.stringify(f.to.leads)}, participants ${JSON.stringify(f.to.participants)}`);
  if (f.raised.length) console.log(`  raised to lead: ${f.raised.join(", ")}`);
  for (const a of f.added) console.log(`  added as ${a.role}: ${a.name} (${a.page})`);
}
console.log(`\n${plan.length} round(s) to repair.`);
if (apply) {
  const done = await applyLeadFlagRepair(handle, plan);
  console.log(`Repaired ${done.applied.length}.${done.stale.length ? ` Skipped as changed since read: ${done.stale.join(", ")}` : ""}`);
  await invalidateScriptEntityPages();
}
await closeDb();
process.exit(0);
