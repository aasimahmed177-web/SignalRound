// Remove what the retired firmographics and funding-event providers left in the store (lib/third-party-purge.ts):
//   pnpm purge-third-party-firmographics                    # dry run: the counts, a backup of every row it would touch, and the changes
//   pnpm purge-third-party-firmographics -- --apply         # write, after the same backup
//   --backup-dir <dir>   where the JSON backup goes (default data/backups)
//   --details            print each change, not only the counts
// Safe to run again: a second run finds nothing to do.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";
import { applyPurge, planPurge, purgeCounts } from "../../lib/third-party-purge.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const details = args.includes("--details");
const i = args.indexOf("--backup-dir");
const backupDir = i >= 0 && args[i + 1] ? args[i + 1] : path.join("data", "backups");

const handle = await openStore();
const plan = await planPurge(handle);

mkdirSync(backupDir, { recursive: true });
const backup = path.join(backupDir, `purge-third-party-${new Date().toISOString().replace(/[:.]/g, "-")}${apply ? "" : "-dry"}.json`);
writeFileSync(backup, JSON.stringify({ at: new Date().toISOString(), apply, rows: plan.before }, null, 1));
const rows = Object.values(plan.before).reduce((n, r) => n + r.length, 0);
console.log(`backup: ${rows} rows -> ${backup}`);

if (details) {
  for (const h of plan.hq) console.log(`hq        ${h.id}: ${h.from} -> ${h.to ?? "(none)"}`);
  for (const l of plan.logos) console.log(`logo      ${l.id}: ${l.from} -> ${l.to ?? "(none)"}`);
  for (const d of plan.dossiers) console.log(`dossier   ${d.companyId}: drop ${d.fields.join(", ")}`);
  for (const h of plan.holds)
    console.log(`hold      ${h.id} (${h.disposition}): ${h.from === null ? "notes only" : h.to ? `now ${h.to}` : "lifted"}`);
}
console.log(JSON.stringify(purgeCounts(plan), null, 2));

if (apply) {
  await applyPurge(handle, plan);
  await invalidateScriptEntityPages();
  console.log("applied");
} else {
  console.log("dry run: nothing written (pass --apply to write)");
}
await closeDb();
process.exit(0);
