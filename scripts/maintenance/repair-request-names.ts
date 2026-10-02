// Give companies a request created with a homepage tagline in their name ("Resend · Email for
// developers") their clean name. Display name only: ids and URLs stay. Safe to run again.
//   pnpm repair-request-names

import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { repairRequestCompanyNames } from "../../lib/request-research.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const renamed = await repairRequestCompanyNames(await openStore());
for (const r of renamed) console.log(`${r.id}: "${r.from}" -> "${r.to}"`);
console.log(`${renamed.length} renamed`);
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
