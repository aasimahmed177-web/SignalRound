// Apply the current rules to a store built before them:
//   pnpm merge-duplicates
// Rounds that are the same company and stage within 45 days fold into one row, sources that are
// one page with and without tracking parameters fold into one, investors whose names spell one
// firm fold into one id, free-text sectors map onto the vocabulary, and companies left without a
// round go, a borrowed day yields to a surer day among the row's own sources, and a row the read-back
// confirmed while it sat flagged publishes. The persist path applies every rule to new data.

import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { mergeDuplicateRounds } from "../../lib/persist.ts";
import {
  mergeDuplicateSources,
  normalizeSectors,
  reconcileRoundInvestors,
  rejectDirectoryRounds,
  rekeyInvestors,
  removeOrphanCompanies,
  settleDispositions,
  settleStoredDates,
  ungroundAmounts,
} from "../../lib/repair.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const handle = await openStore();
const rounds = await mergeDuplicateRounds(handle);
const srcs = await mergeDuplicateSources(handle);
const inv = await rekeyInvestors(handle);
const sectors = await normalizeSectors(handle);
const orphans = await removeOrphanCompanies(handle);
const amounts = await ungroundAmounts(handle);
const inv2 = await reconcileRoundInvestors(handle);
const dates = await settleStoredDates(handle);
const directories = await rejectDirectoryRounds(handle);
const dispositions = await settleDispositions(handle);
console.log(
  `Merged ${rounds.merged} duplicate round(s) and ${srcs.merged} duplicate source(s), re-keyed ${inv.merged} investor(s), normalized ${sectors.companies} company and ${sectors.rounds} round sector(s), removed ${orphans.removed} orphan compan${orphans.removed === 1 ? "y" : "ies"}, cleared ${amounts.cleared} amount(s) the evidence never stated, folded ${inv2.folded} investor spelling(s) on their rounds, moved ${dates.moved} day(s) to a surer sibling source and sharpened ${dates.sharpened}, rejected ${directories.rejected} round(s) whose only sources are directory pages, and published ${dispositions.published} verified round(s) left flagged before the read-back (${dispositions.reviewed} to review).`,
);
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
