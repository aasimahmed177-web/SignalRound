// Replay stored rounds under the money and visibility rules (lib/money-repair.ts): valuations no
// sentence supports for their round, rows that break an invariant, rows only secondhand pages state.
//   pnpm repair-money                          # dry run: each change and why, nothing written
//   pnpm repair-money -- --reground            # dry run, reading an unsupported valuation's own sources again
//   pnpm repair-money -- --reground --apply    # write them
// Re-ground needs FIRECRAWL_API_KEY and a model key (RECONCILE_MODEL_REPAIR picks its model); it reads
// one row at a time, at most four pages each, with --pause <ms> between rows (1500 by default).

import { firecrawlReader, moneyGenerator, reconcileModel } from "@fireround/core";
import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { getFirecrawl } from "../../lib/firecrawl.ts";
import { type RegroundDeps, replayMoneyRules } from "../../lib/money-repair.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const pauseAt = args.indexOf("--pause");
const pauseMs = pauseAt >= 0 ? Number(args[pauseAt + 1]) : 1500;
let reground: RegroundDeps | undefined;
if (args.includes("--reground")) {
  const model = reconcileModel(process.env, "repair");
  if (!model) {
    console.error("repair-money: --reground needs a model key (AI_GATEWAY_API_KEY or another RECONCILE provider)");
    process.exit(1);
  }
  reground = { read: firecrawlReader(getFirecrawl()), generate: moneyGenerator(model), pauseMs };
  console.log(`re-grounding with ${model.label}, ${pauseMs} ms between rows`);
}
const r = await replayMoneyRules(await openStore(), { apply, reground });
for (const c of r.changes) {
  const v = c.valuation;
  if (v?.action === "blank")
    console.log(`${c.id}  ${c.company}: valuation ${v.from} -> blank (${v.reason})${v.quote ? `: "${v.quote}"` : ""}`);
  if (v?.action === "keep") console.log(`${c.id}  ${c.company}: valuation ${v.from} kept: "${v.claim?.quote}" (${v.claim?.url})`);
  if (v?.action === "correct")
    console.log(`${c.id}  ${c.company}: valuation ${v.from} -> ${v.claim?.value}, flagged: "${v.claim?.quote}" (${v.claim?.url})`);
  if (v?.action === "hold") console.log(`${c.id}  ${c.company}: valuation ${v.from} kept unconfirmed, flagged (${v.reason})`);
  if (v?.action === "hold") console.log(`${c.id}  ${c.company}: valuation ${v.from} kept unconfirmed, flagged (${v.reason})`);
  if (c.review) console.log(`${c.id}  ${c.company}: -> review (${c.review})`);
  if (c.error) console.log(`${c.id}  ${c.company}: left as it is (${c.error})`);
}
const done = apply ? "" : "would be ";
console.log(
  `${r.rows} rounds, ${r.valuations} with a valuation: ${r.valuationsBlanked} ${done}blanked, ${r.toReview} ${done}sent to review.`,
);
if (reground) {
  const g = r.reground;
  console.log(
    `re-ground: ${g.tried} read, ${g.kept} kept with a sentence, ${g.corrected} corrected, ${g.held} held (only a funding database states it), ${g.blanked} blanked, ${g.errors} errors (left as they are).`,
  );
}
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
