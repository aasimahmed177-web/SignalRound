// List published rounds with no valuation whose own linked pages state one for the round
// (lib/valuation-repair.ts), and write the ones a person picked as pinned valuation fixes with --apply
// (lib/repair.ts, the "valuation" record fix). Dry run by default. Safe to run again.
//   pnpm repair-valuations                       # list only
//   pnpm repair-valuations -- --ids a,b --apply  # write these rounds

import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { applyRecordFixes } from "../../lib/repair.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";
import { planValuationRepair } from "../../lib/valuation-repair.ts";

const apply = process.argv.includes("--apply");
const at = process.argv.indexOf("--ids");
const ids = at >= 0 && process.argv[at + 1] ? process.argv[at + 1].split(",").filter(Boolean) : undefined;
if (apply && !ids) {
  console.error("--apply needs --ids: write only the rounds a person checked");
  process.exit(1);
}
const handle = await openStore();
console.log(apply ? "APPLY: writing." : "DRY RUN: nothing is written. Add --ids and --apply to write.");
const plan = await planValuationRepair(handle, ids);
for (const f of plan) console.log(`${f.round} (${f.company}, ${f.amount}): valuation ${f.valuation}\n  "${f.quote}" (${f.evidence})`);
console.log(`\n${plan.length} round(s) to repair.`);
if (apply) {
  const result = await applyRecordFixes(
    handle,
    plan.map(({ company: _company, amount: _amount, ...fix }) => fix),
    { apply },
  );
  console.log(`Repaired ${result.applied}, already in place ${result.skipped}, refused ${result.refused}.`);
  await invalidateScriptEntityPages();
}
await closeDb();
process.exit(0);
