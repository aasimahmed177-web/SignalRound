// Judge the stored X posts again under today's relevance rule (lib/prune-trending.ts):
//   pnpm prune-trending-posts                          # dry run: every relevant post the rule would drop
//   pnpm prune-trending-posts -- --sql <file>          # also write the reviewed SQL: a backup table, then the update
//   pnpm prune-trending-posts -- --apply               # mark them irrelevant
// Only demotes, and the rows stay: "On X", the buzz meter, and the Trending score stop counting them.

import { writeFile } from "node:fs/promises";
import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { applyTrendingPrune, planTrendingPrune } from "../../lib/prune-trending.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const sqlAt = args.indexOf("--sql");
const sqlFile = sqlAt >= 0 ? args[sqlAt + 1] : undefined;

const handle = await openStore();
console.log(apply ? "APPLY: writing." : "DRY RUN: nothing is written. Add --apply to write.");
const { checked, demote } = await planTrendingPrune(handle);
for (const d of demote) console.log(`${apply ? "dropped" : "would drop"}  ${d.roundId}  @${d.handle ?? "?"}  ${d.snippet.slice(0, 110)}`);
const rounds = new Set(demote.map((d) => d.roundId)).size;
console.log(
  `\n${checked} relevant post(s) checked, ${demote.length} across ${rounds} round(s) ${apply ? "marked irrelevant" : "would be marked irrelevant"}.`,
);
if (sqlFile) {
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const keys = demote.map((d) => `(${quote(d.roundId)}, ${quote(d.postKey)})`).join(",\n  ");
  const where = demote.length ? `(round_id, post_key) in (\n  ${keys}\n)` : "false";
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  await writeFile(
    sqlFile,
    `-- pnpm prune-trending-posts: ${demote.length} stored X post(s) today's relevance rule does not keep.\n` +
      `-- Back up first, then demote. The rows stay; only relevant goes to false.\nbegin;\n` +
      `create table trending_posts_backup_${stamp} as select * from trending_posts where ${where};\n` +
      `update trending_posts set relevant = false where ${where};\ncommit;\n`,
  );
  console.log(`SQL written to ${sqlFile}`);
}
if (apply) console.log(`${await applyTrendingPrune(handle, demote)} row(s) updated.`);
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
