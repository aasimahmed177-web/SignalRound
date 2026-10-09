// A round's sources listed once per page:
//   node scripts/maintenance/dedupe-round-sources.ts           # dry run: every round and the spellings that would come off
//   node scripts/maintenance/dedupe-round-sources.ts --apply   # write
import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";
import { dedupeRoundSources } from "../../lib/source-dupes.ts";

const apply = process.argv.includes("--apply");
const dupes = await dedupeRoundSources(await openStore(), apply);
for (const d of dupes) console.log(`${d.roundId}  keep ${d.keep}  drop ${d.drop.join(", ")}`);
console.log(
  `${dupes.length} duplicate page(s) on ${new Set(dupes.map((d) => d.roundId)).size} round(s) ${apply ? "removed" : "would be removed"}.`,
);
if (apply) await invalidateScriptEntityPages();
await closeDb();
