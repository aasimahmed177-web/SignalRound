// Re-check the sources corroboration attached before it judged the round:
//   pnpm prune-corroboration              # drop the links, remove the sources left without a round
//   pnpm prune-corroboration -- --dry-run # list what would go, change nothing
// A link goes when the source's title names none of the company's name tokens and its host is
// not the company's domain, unless it is the source the round was first extracted from. The
// rule and the SQL are lib/prune-corroboration.ts.

import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { pruneCorroborationSources } from "../../lib/prune-corroboration.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const dryRun = process.argv.includes("--dry-run");
const handle = await openStore();
const summary = await pruneCorroborationSources(handle, { dryRun });
for (const d of summary.drops)
  console.log(`${dryRun ? "would drop" : "dropped"}  ${d.roundId}  x  ${d.sourceId}  (${d.title ?? "untitled"})`);
console.log(
  `${summary.rounds} round(s) with more than one source, ${summary.checked} link(s) checked, ${summary.drops.length} link(s) ${dryRun ? "would be dropped" : "dropped"}, ${summary.orphans} source row(s) ${dryRun ? "would be left" : "left"} without a round${dryRun ? "" : " and removed"}.`,
);
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
