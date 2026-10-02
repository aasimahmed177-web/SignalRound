// Alexandria for the companies the store already holds: every pending company with a
// verified domain, one at a time, firmographics on.
//   pnpm alexandria-backfill                          # 20 companies
//   pnpm alexandria-backfill -- --limit 60
//   pnpm alexandria-backfill -- --limit 400 --max-credits 3000
//   pnpm alexandria-backfill -- --refresh-firmographics --limit 400 --max-credits 2000

import { schema } from "@fireround/core/db";
import { and, eq, sql } from "drizzle-orm";
import { alexandriaBatch, pendingAlexandria, refreshFirmographics } from "../lib/alexandria.ts";
import { openStore } from "../lib/db.ts";
import { getFirecrawl } from "../lib/firecrawl.ts";
import { invalidateScriptEntityPages } from "../lib/script-cache-invalidation.ts";

const { companies, enrichments } = schema;

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const limit = Number(arg("--limit", "20"));
/** Credits the run may spend before it stops; 0 means no cap. */
const maxCredits = Number(arg("--max-credits", "0"));
const refreshOnly = process.argv.includes("--refresh-firmographics");
const handle = await openStore();
const client = getFirecrawl();

const fmt = (s: string, n: number) => s.padEnd(n).slice(0, n);

if (refreshOnly) {
  // The rows written while FullEnrich's terms were unaccepted (or the plan had it off) get
  // their lookup alone; the credit cap is a real stop inside refreshFirmographics.
  const rows = await handle
    .select({ companyId: enrichments.companyId, name: companies.name, domain: companies.domain })
    .from(enrichments)
    .innerJoin(companies, eq(companies.id, enrichments.companyId))
    .where(
      and(eq(enrichments.kind, "alexandria"), sql`${enrichments.data}->'firmographics'->>'status' in ('terms_required', 'off', 'error')`),
    )
    .limit(limit);
  console.log(`${rows.length} alexandria rows pending a firmographics lookup${maxCredits > 0 ? ` (cap ${maxCredits} credits)` : ""}\n`);
  console.log(`${fmt("company", 28)} ${fmt("domain", 24)} firmographics`);
  const res = await refreshFirmographics(handle, client, {
    limit,
    maxCredits: maxCredits > 0 ? maxCredits : undefined,
    // FullEnrich rate-limits a fast loop; a short gap keeps a backfill under the ceiling.
    delayMs: 500,
  });
  const done = new Map(
    (
      await handle
        .select({ companyId: enrichments.companyId, data: enrichments.data })
        .from(enrichments)
        .where(eq(enrichments.kind, "alexandria"))
    ).map((r) => [r.companyId, (r.data as { firmographics?: { status: string } }).firmographics?.status ?? "?"]),
  );
  for (const r of rows) console.log(`${fmt(r.name, 28)} ${fmt(r.domain ?? "", 24)} ${done.get(r.companyId) ?? "?"}`);
  console.log(`\n${res.companies} processed · ${res.matched} matched · ${res.credits} credits`);
  const { closeDb } = await import("@fireround/core/db");
  await invalidateScriptEntityPages();
  await closeDb();
  process.exit(0);
}

const pending = await pendingAlexandria(handle, null, limit);
console.log(
  `${pending.length} companies with a verified domain and no alexandria row${maxCredits > 0 ? ` (cap ${maxCredits} credits)` : ""}\n`,
);

console.log(`${fmt("company", 28)} ${fmt("domain", 24)} ${fmt("yc", 20)} ${fmt("firmographics", 16)} credits`);

let spent = 0;
let processed = 0;
const matched: string[] = [];
for (const c of pending) {
  if (maxCredits > 0 && spent >= maxCredits) {
    console.log(`\nstopping: ${spent} credits reached the --max-credits cap`);
    break;
  }
  await alexandriaBatch(handle, client, [c], { firmographics: true });
  const [row] = await handle
    .select({ data: enrichments.data })
    .from(enrichments)
    .where(and(eq(enrichments.companyId, c.id), eq(enrichments.kind, "alexandria")));
  const e = row?.data as { credits?: number; yc?: { status: string; slug?: string }; firmographics?: { status: string } } | undefined;
  spent += e?.credits ?? 0;
  processed++;
  if (e?.yc?.status === "matched") matched.push(`${c.name} (${e.yc.slug})`);
  const yc = e?.yc?.status === "matched" ? `matched ${e.yc.slug}` : (e?.yc?.status ?? "?");
  const firmo = e?.firmographics?.status ?? "?";
  console.log(`${fmt(c.name, 28)} ${fmt(c.domain, 24)} ${fmt(yc, 20)} ${fmt(firmo, 16)} ${e?.credits ?? 0}`);
}

console.log(`\n${processed} processed · ${matched.length} YC matched${matched.length ? `: ${matched.join(", ")}` : ""} · ${spent} credits`);

const { closeDb } = await import("@fireround/core/db");
await invalidateScriptEntityPages();
await closeDb();
