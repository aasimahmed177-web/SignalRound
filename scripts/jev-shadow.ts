// The rules against Jev on the live feed's search results, from the verdicts the sweep and the watch
// store in shadow (lib/jev-shadow.ts): how often they agree, per lane, and the results where they differ.
//   pnpm jev-shadow [days=7]

import { closeDb } from "@fireround/core/db";
import { openStore } from "../lib/db.ts";
import { compareShadow } from "../lib/jev-shadow.ts";

const days = Number(process.argv[2] ?? 7);
const c = await compareShadow(await openStore(), days);
console.log(`last ${days} days: ${c.total} results, rules and Jev agree on ${c.agree}`);
for (const [lane, l] of Object.entries(c.byLane))
  console.log(`  ${lane}: ${l.total} results, agree ${l.agree}, rules keep ${l.rulesKept}, Jev keeps ${l.jevKept}`);
const show = (label: string, rows: typeof c.rulesOnly) => {
  console.log(`${label} (${rows.length}):`);
  for (const r of rows.slice(0, 25))
    console.log(`  [${r.lane}] about=${r.aboutRaise.toFixed(2)} kind=${r.kind} | ${r.title ?? ""} | ${r.url}`);
};
show("rules keep, Jev would drop", c.rulesOnly);
show("Jev would keep, rules drop", c.jevOnly);
await closeDb();
process.exit(0);
