// Take investors off stored rounds when the round's own verification says the sources do not place
// them in it, and clear leads it says did not lead:
//   pnpm prune-unsupported-investors            # dry run: each round, the links it would remove, the leads it would clear, the evidence
//   pnpm prune-unsupported-investors -- --apply # write the changes
//   pnpm prune-unsupported-investors -- --round <id>[,<id>]   # only those rounds
// Reads only what the store holds: no model call, no Firecrawl call. Safe to run again: a removed
// link is gone and a cleared lead is a participant, so a second run finds nothing. The rule is
// lib/prune-investors.ts.

import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { describeInvestorPrune, pruneUnsupportedInvestors } from "../../lib/prune-investors.ts";
import { loadPublisherTiers } from "../../lib/rules.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const apply = process.argv.includes("--apply");
const roundArg = process.argv.indexOf("--round");
const roundIds = roundArg >= 0 ? (process.argv[roundArg + 1] ?? "").split(",").filter(Boolean) : undefined;

const handle = await openStore();
const summary = await pruneUnsupportedInvestors(handle, { apply, tiers: await loadPublisherTiers(), roundIds });
for (const p of [...summary.prunes, ...summary.held]) for (const line of describeInvestorPrune(p)) console.log(line);
const moved = summary.prunes.filter((p) => p.nextDisposition !== p.disposition).length;
console.log(
  `${summary.checked} verified round(s) read, ${summary.prunes.length} with investors the verification rejects: ${summary.removed.participant} participant link(s) and ${summary.removed.lead} lead link(s) ${apply ? "removed" : "would be removed"}, ${summary.demoted} lead(s) ${apply ? "cleared" : "would be cleared"}, ${moved} row(s) ${apply ? "moved" : "would move"} disposition, ${summary.held.length} round(s) left alone because their own evidence names the firm.${apply ? "" : " Nothing was written; add --apply to write."}`,
);
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
