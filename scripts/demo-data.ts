// Fill an empty store with fictional sample rounds, so the dashboard has something to show before a
// NativeWebClient key or a first sweep:
//   pnpm demo-data
// It refuses a store that already has rounds, so it never mixes into real data. Clear the samples before
// your first real sweep with `pnpm reset-data -- --yes`. The samples are in lib/demo-data.ts.
import { closeDb } from "@fireround/core/db";
import { openStore } from "../lib/db.ts";
import { seedSampleData } from "../lib/demo-data.ts";
import { invalidateScriptEntityPages } from "../lib/script-cache-invalidation.ts";

const handle = await openStore();
const seeded = await seedSampleData(handle);
if (!seeded) {
  console.log("The store already has rounds; sample data only goes into an empty store. `pnpm reset-data -- --yes` starts it over.");
} else {
  console.log(
    `Added ${seeded.published + seeded.review} fictional sample rounds (${seeded.published} published, ${seeded.review} in Review) and 3 discovery signals. Start the app with \`pnpm dev\` and open http://localhost:3000.`,
  );
  console.log("Before your first real sweep, clear them with `pnpm reset-data -- --yes`.");
  await invalidateScriptEntityPages();
}
await closeDb();
process.exit(0);
