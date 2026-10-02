// Bring stored investors under today's name hygiene (lib/investor-repair.ts):
//   pnpm repair-investors             # dry run: every drop, merge, and orphan, with the rounds each touches
//   pnpm repair-investors -- --apply  # write
//   pnpm repair-investors -- --decisions held.json [--apply]   # with a person's decisions on held cases carried out first
// A description of investors ("executives from OpenAI", "some business angels") comes off its rounds;
// a spelling today's key folds into another firm ("a16z's Speedrun accelerator" into "a16z speedrun",
// "Wells Fargo & Co" out of "wells fargo and") moves its links there; a name whose shown form changes
// under display hygiene ("Eli Lilly (NYSE: LLY)", "Arm Holdings Inc") is renamed; a row no round links to goes.

import { readFileSync } from "node:fs";
import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { applyInvestorRepair, type InvestorDecision, planInvestorRepair } from "../../lib/investor-repair.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const apply = process.argv.includes("--apply");
const at = process.argv.indexOf("--decisions");
const decisions = at >= 0 && process.argv[at + 1] ? (JSON.parse(readFileSync(process.argv[at + 1], "utf8")) as InvestorDecision[]) : [];
const handle = await openStore();
console.log(apply ? "APPLY: writing." : "DRY RUN: nothing is written. Add --apply to write.");
const plan = await planInvestorRepair(handle, decisions);
for (const d of decisions) console.log(`decide ${d.kind} ${JSON.stringify(d.from)} (${d.id}): ${d.reason} [${d.evidence}]`);
for (const x of plan.stale)
  console.log(`stale  ${x.id}: expected ${JSON.stringify(x.expected)}, found ${JSON.stringify(x.found)}; skipped`);
for (const d of plan.drop)
  console.log(`drop   ${JSON.stringify(d.name)} (${d.id}): off ${d.rounds.length} round(s): ${d.rounds.join(", ")}`);
for (const m of plan.merge)
  console.log(`merge  ${JSON.stringify(m.name)} (${m.id}) -> ${JSON.stringify(m.intoName)} (${m.into}): ${m.rounds.length} round(s)`);
for (const r of plan.rename)
  console.log(`rename ${JSON.stringify(r.name)} (${r.id}) -> ${JSON.stringify(r.to)}${r.domain ? `, website ${r.domain}` : ""}`);
for (const c of plan.conflicts)
  console.log(
    `hold   ${JSON.stringify(c.name)} (${c.id}): its new key ${c.into} is ${JSON.stringify(c.intoName)}, another firm by its words`,
  );
console.log(
  `\n${plan.drop.length} to drop, ${plan.merge.length} to merge, ${plan.rename.length} to rename, ${plan.orphans.length} orphan row(s) to remove, ` +
    `${plan.conflicts.length} held for a person.`,
);
if (apply) {
  const done = await applyInvestorRepair(handle, plan);
  console.log(`Dropped ${done.dropped}, merged ${done.merged}, renamed ${done.renamed}, removed ${done.orphans} orphan row(s).`);
}
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
