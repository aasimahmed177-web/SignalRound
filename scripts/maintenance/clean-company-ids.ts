// Give every company a clean id, which is its page's URL (lib/company-renames.ts): its verified domain,
// else its name hyphenated, numbered when taken. The old id redirects to the new one for good.
//   pnpm clean-company-ids                       # dry run: every rename and the counts, nothing written
//   pnpm clean-company-ids -- --json <file>      # also write the plan as JSON
//   pnpm clean-company-ids -- --apply            # back up every row it touches, then rename
//   --backup-dir <dir>   where the JSON backup goes (default data/backups)
// Safe to run again: a second run finds only what was skipped.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb } from "@fireround/core/db";
import { applyRenames, loadRenamePlan, renameBackup } from "../../lib/company-renames.ts";
import { openStore } from "../../lib/db.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const backupDir = flag("--backup-dir") ?? path.join("data", "backups");

const handle = await openStore();
const plan = await loadRenamePlan(handle);
for (const r of plan) console.log(`${r.from}  ->  ${r.to}  (${r.basis}; ${r.published} published of ${r.rounds} rounds)`);
const by = (basis: string) => plan.filter((r) => r.basis === basis).length;
console.log(
  `${plan.length} companies to rename: ${by("domain")} to their verified domain, ${by("name")} to their name, ${by("numbered")} to a numbered name; ${plan.filter((r) => r.published > 0).length} have published rounds (${plan.reduce((n, r) => n + r.published, 0)} rounds).`,
);
const json = flag("--json");
if (json) writeFileSync(json, JSON.stringify(plan, null, 1));

if (apply && plan.length > 0) {
  mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `clean-company-ids-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const rows = await renameBackup(
    handle,
    plan.map((r) => r.from),
  );
  writeFileSync(backup, JSON.stringify({ at: new Date().toISOString(), plan, rows }, null, 1));
  console.log(`backup: ${Object.values(rows).reduce((n, r) => n + r.length, 0)} rows -> ${backup}`);
  const done = await applyRenames(handle, plan);
  console.log(`renamed ${done.renamed}; skipped ${done.skipped.length} (new id taken since the plan, or the company is gone; run again)`);
  await invalidateScriptEntityPages();
}
await closeDb();
process.exit(0);
