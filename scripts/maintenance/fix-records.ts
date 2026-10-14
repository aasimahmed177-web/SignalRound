// Apply hand-checked corrections to stored rows (lib/repair.ts applyRecordFixes), printing each first:
//   pnpm fix-records -- --file fixes.json            # dry run: reads only
//   pnpm fix-records -- --file fixes.json --apply    # write
// The file is a JSON array of fixes: "redate" (a new day with the page that states it, added as a
// source; the id stays; an `amount_as_written` of null also clears a figure that was a total to date),
// "reject" (not a round), "merge" (two rows for one round, the app's merge forced), "domain" (the
// company's own domain, clearing what was read on the wrong one or on none), "restage" (a stage the
// page names), "describe" (a description the company's own page supports, for one that says nothing),
// "investors" (a round's leads and participants as its announcement states them, written as persist
// writes a verified list), "hq" and "sector" (a company's headquarters, or its sector from the
// vocabulary), "certainty" (a round shown as announced that its pages say is still being raised, pinned),
// "valuation" (a valuation in the words of the page and sentence that state it, pinned),
// "site" (a domain the company published on under an earlier name, kept as one of its sites),
// "publish" (a flagged or review row a person checked against a page it cites, published as from the
// review queue),
// "unlink" (a page and its quotes taken off a round they do not belong to, when a second deal was merged in),
// "fold" (a company row with no domain folded into the company it duplicates, by the app's merge),
// and "history_lead" (a missing earlier round queued on the history ledger with the page
// that states it; the history pass reads and verifies it; `requeue` sends a lead that ended without a
// source back to pending with a new page). Every fix but a merge cites the page it rests on, and
// each names what the row holds now, so a row that has moved on is refused, and a fix already in place is
// skipped: running it twice changes nothing.

import { readFile } from "node:fs/promises";
import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { applyRecordFixes, type RecordFix } from "../../lib/repair.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const at = args.indexOf("--file");
const file = at >= 0 ? args[at + 1] : undefined;
if (!file) {
  console.error("--file <fixes.json> is required");
  process.exit(1);
}
const fixes = JSON.parse(await readFile(file, "utf8")) as RecordFix[];

const handle = await openStore();
console.log(apply ? "APPLY: writing." : "DRY RUN: nothing is written. Add --apply to write.");
const result = await applyRecordFixes(handle, fixes, { apply });
for (const line of result.lines) console.log(line);
console.log(
  `\n${fixes.length} fix(es): ${apply ? `${result.applied} applied` : "planned above"}, ${result.skipped} already in place, ${result.refused} refused.`,
);
await invalidateScriptEntityPages();
await closeDb();
process.exit(result.refused > 0 ? 2 : 0);
