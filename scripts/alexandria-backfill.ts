// Alexandria for the companies the store already holds: every pending company with a
// verified domain, one at a time.
//   pnpm alexandria-backfill                          # 20 companies
//   pnpm alexandria-backfill -- --limit 60
//   pnpm alexandria-backfill -- --limit 400 --max-credits 3000

import { schema } from "@fireround/core/db";
import { and, eq } from "drizzle-orm";
import { alexandriaBatch, pendingAlexandria } from "../lib/alexandria.ts";
import { openStore } from "../lib/db.ts";
import { getFirecrawl } from "../lib/firecrawl.ts";
import { invalidateScriptEntityPages } from "../lib/script-cache-invalidation.ts";

const { enrichments } = schema;

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const limit = Number(arg("--limit", "20"));
/** Credits the run may spend before it stops; 0 means no cap. */
const maxCredits = Number(arg("--max-credits", "0"));
const handle = await openStore();
const client = getFirecrawl();

const fmt = (s: string, n: number) => s.padEnd(n).slice(0, n);

const pending = await pendingAlexandria(handle, null, limit);
console.log(
  `${pending.length} companies with a verified domain and no alexandria row${maxCredits > 0 ? ` (cap ${maxCredits} credits)` : ""}\n`,
);

console.log(`${fmt("company", 28)} ${fmt("domain", 24)} ${fmt("yc", 20)} credits`);

let spent = 0;
let processed = 0;
const matched: string[] = [];
for (const c of pending) {
  if (maxCredits > 0 && spent >= maxCredits) {
    console.log(`\nstopping: ${spent} credits reached the --max-credits cap`);
    break;
  }
  await alexandriaBatch(handle, client, [c]);
  const [row] = await handle
    .select({ data: enrichments.data })
    .from(enrichments)
    .where(and(eq(enrichments.companyId, c.id), eq(enrichments.kind, "alexandria")));
  const e = row?.data as { credits?: number; yc?: { status: string; slug?: string } } | undefined;
  spent += e?.credits ?? 0;
  processed++;
  if (e?.yc?.status === "matched") matched.push(`${c.name} (${e.yc.slug})`);
  const yc = e?.yc?.status === "matched" ? `matched ${e.yc.slug}` : (e?.yc?.status ?? "?");
  console.log(`${fmt(c.name, 28)} ${fmt(c.domain, 24)} ${fmt(yc, 20)} ${e?.credits ?? 0}`);
}

console.log(`\n${processed} processed · ${matched.length} YC matched${matched.length ? `: ${matched.join(", ")}` : ""} · ${spent} credits`);

const { closeDb } = await import("@fireround/core/db");
await invalidateScriptEntityPages();
await closeDb();
