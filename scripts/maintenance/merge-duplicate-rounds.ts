// Fold duplicate rounds into one row with the app's own merge (lib/persist.ts), printing every
// change first:
//   pnpm merge-duplicate-rounds                                  # dry run: every pair the rule finds
//   pnpm merge-duplicate-rounds -- --pair <id>,<id>              # dry run: only this pair (repeatable)
//   pnpm merge-duplicate-rounds -- --apply [--pair <id>,<id>]    # write
// The survivor is the surer row (visible, then confidence, verified, sources, domain, earlier day);
// it gains the other's sources, investors, deliveries, evidence, and first sighting, keeps the surer
// day, and two company rows for one company fold together. `--force` merges a named pair the rule
// does not call one round. Nothing is written without `--apply`.

import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { describeRoundMerge, mergeRoundPairs } from "../../lib/repair.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const force = args.includes("--force");
const pairs: Array<[string, string]> = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--pair") continue;
  const [a, b, ...rest] = (args[i + 1] ?? "").split(",").map((s) => s.trim());
  if (!a || !b || rest.length > 0) {
    console.error(`--pair takes two round ids separated by a comma, got "${args[i + 1] ?? ""}"`);
    process.exit(1);
  }
  pairs.push([a, b]);
}

const handle = await openStore();
console.log(apply ? "APPLY: merging and writing." : "DRY RUN: nothing is written. Add --apply to merge.");
const result = await mergeRoundPairs(handle, { apply, force, pairs: pairs.length > 0 ? pairs : undefined });
for (const m of result.planned) console.log(`\n${describeRoundMerge(m).join("\n")}`);
for (const r of result.refused) console.log(`\nskipped: ${r}`);
console.log(
  apply
    ? `\nMerged ${result.merged} pair(s), and ${result.followUps} more round(s) the company folds brought onto one row.`
    : `\n${result.planned.length} pair(s) would merge.`,
);
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
