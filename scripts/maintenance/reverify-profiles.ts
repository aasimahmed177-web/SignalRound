// Clear every stored profile that never passed the identity check:
//   pnpm reverify-profiles
// Profiles written before the check may describe a namesake (a dog food company under an AI
// assistant's record). Each such profile row goes, with the logo and any website and domain the
// old ungrounded search guessed, so the next sweep or Enrich pass redoes the company grounded in
// its record and verified against the homepage before anything is written.

import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { clearProfilesAcceptedOnNameAlone, clearUnverifiedProfiles } from "../../lib/enrich.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

// --name-alone: also clear profiles the check accepted when the record had no description, whose
// sentence then became the company's description (the next pass gets the evidence and headline instead).
const nameAlone = process.argv.includes("--name-alone");

const handle = await openStore();
const { cleared } = await clearUnverifiedProfiles(handle);
console.log(`Cleared ${cleared} unverified profile${cleared === 1 ? "" : "s"}; the next enrichment redoes them.`);
if (nameAlone) {
  const r = await clearProfilesAcceptedOnNameAlone(handle);
  console.log(`Cleared ${r.cleared} profile${r.cleared === 1 ? "" : "s"} accepted on the name alone.`);
}
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
