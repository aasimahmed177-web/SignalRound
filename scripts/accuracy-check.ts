// What the daily accuracy check would flag today, printed and never written:
//   pnpm accuracy-check
//   pnpm accuracy-check -- --top 20 --limit 40 --json
// Reads the companies that matter most (the top 100 by largest round and by total raised, plus every
// $100M round) and runs the rules in packages/core/src/records/accuracy.ts. It only reads, so it is
// safe against production with a read-only session; a store the accuracy migration has not reached
// yet is read without the founders' memory. The flags themselves are kept by /api/cron/accuracy.

import { ACCURACY_TOP_N, compareFlags } from "@fireround/core";
import { closeDb } from "@fireround/core/db";
import { sql } from "drizzle-orm";
import { evaluateAccuracy } from "../lib/accuracy.ts";
import { openStore } from "../lib/db.ts";
import { invalidateScriptEntityPages } from "../lib/script-cache-invalidation.ts";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  const n = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const topN = arg("--top", ACCURACY_TOP_N);
const limit = arg("--limit", 20);
const handle = await openStore();
const [probe] = (await handle.execute<{ t: string | null }>(sql`select to_regclass('accuracy_memory')::text as t`)).rows;
const evaluation = await evaluateAccuracy(handle, { topN, readMemory: Boolean(probe?.t) });

const byRule = new Map<string, { flags: number; high: number }>();
for (const r of evaluation.results) {
  const c = byRule.get(r.flag.rule) ?? { flags: 0, high: 0 };
  c.flags++;
  if (r.flag.severity === "high") c.high++;
  byRule.set(r.flag.rule, c);
}
const rank = new Map(evaluation.checked.map((l, i) => [l.company.id, i]));
const name = new Map(evaluation.checked.map((l) => [l.company.id, l.company.name]));
const top = [...evaluation.results]
  .sort((a, b) => compareFlags(a.flag, b.flag) || (rank.get(a.companyId) ?? 0) - (rank.get(b.companyId) ?? 0))
  .slice(0, limit);

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        companies: evaluation.checked.length,
        flags: evaluation.results.length,
        companiesFlagged: new Set(evaluation.results.map((r) => r.companyId)).size,
        byRule: Object.fromEntries(byRule),
        top: top.map((r) => ({ company: name.get(r.companyId), ...r.flag })),
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `${evaluation.checked.length} companies read, ${evaluation.results.length} flags on ${new Set(evaluation.results.map((r) => r.companyId)).size} of them.`,
  );
  for (const [rule, c] of [...byRule].sort((a, b) => b[1].flags - a[1].flags))
    console.log(`  ${rule}: ${c.flags}${c.high ? ` (${c.high} high)` : ""}`);
  console.log(`\nThe ${top.length} most urgent:`);
  for (const r of top) console.log(`  [${r.flag.severity}] ${name.get(r.companyId)} (${r.flag.rule}): ${r.flag.reason}`);
}
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
