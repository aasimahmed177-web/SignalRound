// Start the data over, keeping the configuration:
//   pnpm reset-data -- --yes
// Rounds, sources, investors, companies, enrichments, signal observations, the candidates ledger, deliveries, and runs go;
// coverage, feed tokens, delivery targets, and monitors stay. Run it before a backfill through a
// corrected pipeline, so history lands through the rules you have now rather than the ones you had.
import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { resetData } from "../../lib/repair.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

if (!process.argv.includes("--yes")) {
  console.log("This deletes every round, company, source, investor, enrichment, signal, delivery, and run. Re-run with --yes to do it.");
  // A refused dry stop is the expected path, not a failure: exit 1 would make pnpm print ELIFECYCLE under it.
  process.exit(0);
}
const handle = await openStore();
const gone = await resetData(handle);
console.log(
  `Removed ${gone.rounds} rounds, ${gone.companies} companies, ${gone.sources} sources, ${gone.signals} signals. Configuration kept.`,
);
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
