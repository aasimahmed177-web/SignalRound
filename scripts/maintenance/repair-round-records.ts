// Apply today's round-record rules to stored rows (lib/round-record-repair.ts): lift namesake holds the
// company's own site has settled, show investors' fuller names, record withheld valuations, move audit
// fingerprints of renamed companies, and, with --web, find published rounds' announcements on the
// company's site or a newswire and read verified homepages' own one-line descriptions.
//   pnpm repair-round-records                              # dry run over every published round, store only
//   pnpm repair-round-records -- --web --limit 20          # dry run, reading the web (NativeWebClient credits)
//   pnpm repair-round-records -- --ids a,b --show <id>     # these rounds; print one round's API row before and after
//   pnpm repair-round-records -- --web --apply             # back up every row it touches, then write
//   --backup-dir <dir>   where the JSON backup goes (default data/backups)
//   --json <file>        write the plan as JSON
// Web reads use native transport; structured extraction needs a configured model key.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_TIERS } from "@fireround/core";
import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { publicRound } from "../../lib/public-view.ts";
import { applyRepair, planRepair, previewRow, repairBackup, repairRows } from "../../lib/round-record-repair.ts";
import { loadPublisherTiers } from "../../lib/rules.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";
import { getWebClient } from "../../lib/web-client.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const apply = args.includes("--apply");
const web = args.includes("--web");
const ids = flag("--ids")?.split(",").filter(Boolean);
const limit = flag("--limit") ? Number(flag("--limit")) : undefined;
const show = flag("--show");

const handle = await openStore();
const tiers = { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
const client = web ? getWebClient() : null;
const rows = await repairRows(handle, { ids, limit });
const plan = await planRepair(handle, rows, { client, tiers });

const done = apply ? "" : "would ";
for (const h of plan.holds) console.log(`hold     ${h.roundId}  ${h.company}: namesake hold settled by ${h.ownPage}; ${done}go to ${h.to}`);
for (const n of plan.names) console.log(`investor ${n.investorId}: "${n.from}" ${done}show as "${n.to}" (spelled so on ${n.roundId})`);
for (const u of plan.undisclosed) console.log(`value    ${u.roundId}  ${u.company}: valuation not disclosed: "${u.quote}"`);
for (const p of plan.primary)
  console.log(
    `primary  ${p.roundId}: ${p.confirmed ? `${done}attach ${p.confirmed}` : `none (${p.reason})`}${p.candidates.length ? ` [read: ${p.candidates.join(", ")}]` : ""}`,
  );
for (const d of plan.descriptions) console.log(`describe ${d.companyId}: ${JSON.stringify(d.from)} -> ${JSON.stringify(d.to)}`);
console.log(
  `${rows.length} rounds: ${plan.holds.length} holds to lift (${plan.holds.filter((h) => h.to === "publish").length} to publish), ${plan.names.length} investor names, ${plan.undisclosed.length} withheld valuations, ${plan.fingerprints} audit fingerprints to move` +
    (web
      ? `, ${plan.primary.filter((p) => p.confirmed).length} of ${plan.primary.length} rounds without an announcement found one, ${plan.descriptions.length} descriptions; about ${plan.creditsEstimated} credits read`
      : "; --web for announcements and descriptions"),
);
const json = flag("--json");
if (json) writeFileSync(json, JSON.stringify(plan, null, 1));

if (show) {
  const [before] = await repairRows(handle, { ids: [show] });
  if (before) {
    const lifted = await repairRows(handle, { ids: plan.holds.filter((h) => h.to === "publish").map((h) => h.roundId) });
    console.log(JSON.stringify({ before: publicRound(before), after: publicRound(previewRow(before, plan, lifted)) }, null, 2));
  }
}

if (apply) {
  const backupDir = flag("--backup-dir") ?? path.join("data", "backups");
  mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `repair-round-records-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const before = await repairBackup(handle, plan);
  writeFileSync(backup, JSON.stringify({ at: new Date().toISOString(), plan, rows: before }, null, 1));
  console.log(`backup: ${Object.values(before).reduce((n, r) => n + r.length, 0)} rows -> ${backup}`);
  console.log(JSON.stringify(await applyRepair(handle, plan, { client, tiers })));
  await invalidateScriptEntityPages();
}
await closeDb();
process.exit(0);
