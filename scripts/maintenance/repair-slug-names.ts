// List companies saved under a slug or a lowercase name ("sandboxaq", "firstdue") whose evidence writes
// a proper name ("SandboxAQ", "First Due"), and give them that name with --apply. Display name and
// name key only: ids and URLs stay. Dry run by default. Safe to run again.
//   pnpm repair-slug-names            # list only
//   pnpm repair-slug-names --apply    # rename

import { closeDb } from "@fireround/core/db";
import { applyCompanyNameRepair, planCompanyNameRepair } from "../../lib/company-name-repair.ts";
import { openStore } from "../../lib/db.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const apply = process.argv.includes("--apply");
const handle = await openStore();
console.log(apply ? "APPLY: writing." : "DRY RUN: nothing is written. Add --apply to write.");
const plan = await planCompanyNameRepair(handle);
for (const r of plan)
  console.log(
    `${r.initialOnly ? "first letter " : "rename       "} ${r.id}: "${r.from}" -> "${r.to}" (${r.count} mention${r.count === 1 ? "" : "s"}${r.example ? `, e.g. ${r.example}` : ""})`,
  );
const strong = plan.filter((r) => !r.initialOnly).length;
console.log(`\n${plan.length} to rename: ${strong} spelled differently, ${plan.length - strong} with only the first letter raised.`);
if (apply) {
  const done = await applyCompanyNameRepair(handle, plan);
  console.log(`Renamed ${done.length}.`);
  await invalidateScriptEntityPages();
}
await closeDb();
process.exit(0);
