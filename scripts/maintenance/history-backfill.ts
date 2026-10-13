// A company's funding history from hand-checked leads, through the same lanes as everything else:
//   pnpm history-backfill -- --file history.json            # dry run: reads only
//   pnpm history-backfill -- --file history.json --apply    # write
// The file names the companies to add by their homepage and the fixes to apply (the `pnpm fix-records`
// format: a missing round is a "history_lead" with the page that states it; "merge", "redate",
// "reject", "restage" and "investors" correct rows already there):
//   { "companies": [{ "homepage": "https://www.example.com" }], "fixes": [ ... ] }
// A company not stored yet is added only when its homepage passes the identity check a company request
// runs, and is named by its brand. Then every lead due for each company the file names is worked by the
// history lane (lib/history.ts promotePrior): the search, the page reads, the read-back, and persist. A
// lead becomes a round only when a page states it; the row is history, dated and valued by its pages,
// and published or flagged by the same rules as any other. The dry run prints what would be added and
// queued and the leads already due, and reads no page.
// With --corroborate, each flagged or review row of those companies (none a person holds) then gets the
// corroboration lane's second reading (lib/corroborate.ts: the wire and the company's newsroom, one
// search, the best pages), and a row that gained sources is read back with all of them in view, as the
// verification lane does: the row publishes when its sources together confirm it, and stays flagged or
// in review when they do not.
// Needs FIRECRAWL_API_KEY and a model key for the read-back (the same as the history lane), and
// DATABASE_URL. Idempotent: a company already stored is not read again, a lead already on the ledger
// is not queued twice, and a lead already worked is not worked again.

import { readFile } from "node:fs/promises";
import { DEFAULT_TIERS, fetchRates, registrableDomain } from "@fireround/core";
import { closeDb, schema } from "@fireround/core/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { corroborateModel, corroborateRecord } from "../../lib/corroborate.ts";
import { openStore } from "../../lib/db.ts";
import { getFirecrawl } from "../../lib/firecrawl.ts";
import { due, firecrawlHistoryReader, promotePrior, queueCompanyHistory } from "../../lib/history.ts";
import { reconcileGrownRows } from "../../lib/reconcile.ts";
import { applyRecordFixes, type RecordFix } from "../../lib/repair.ts";
import { companyFromHomepage, readBrand } from "../../lib/request-research.ts";
import { loadPublisherTiers } from "../../lib/rules.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const { companies, fundingRounds, historyPromotions } = schema;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const corroborating = args.includes("--corroborate");
const at = args.indexOf("--file");
const file = at >= 0 ? args[at + 1] : undefined;
if (!file) {
  console.error("--file <history.json> is required");
  process.exit(1);
}
const plan = JSON.parse(await readFile(file, "utf8")) as { companies?: Array<{ homepage: string }>; fixes?: RecordFix[] };
const fixes = plan.fixes ?? [];

const handle = await openStore();
console.log(apply ? "APPLY: writing." : "DRY RUN: nothing is written. Add --apply to write.");
let refused = 0;
const touched = new Set<string>();
/** Companies the dry run would add: their leads can only be queued once they are stored. */
const adding = new Set<string>();

for (const { homepage } of plan.companies ?? []) {
  const domain = registrableDomain(homepage);
  if (!domain) {
    console.log(`refuse company ${homepage}: not a website`);
    refused++;
    continue;
  }
  const [stored] = await handle
    .select({ id: companies.id })
    .from(companies)
    .where(or(eq(companies.domain, domain), eq(companies.id, domain)))
    .limit(1);
  if (!apply) {
    console.log(
      stored
        ? `company ${domain}: stored as ${stored.id}`
        : `company ${domain}: would read ${homepage} and add it if the identity check passes`,
    );
    if (stored) touched.add(stored.id);
    else adding.add(domain);
    continue;
  }
  const client = getFirecrawl();
  const brand = stored ? null : await readBrand(client, homepage);
  const identity = await companyFromHomepage(handle, client, { domain, url: homepage, sites: brand?.sites ?? [] });
  if (identity.status === "refused") {
    console.log(`refuse company ${domain}: ${homepage} did not pass the identity check`);
    refused++;
    continue;
  }
  const [row] = await handle.select({ name: companies.name }).from(companies).where(eq(companies.id, identity.companyId));
  console.log(
    `company ${domain}: ${identity.fresh ? "profile verified and saved" : "already verified"} as ${identity.companyId} (${row?.name})`,
  );
  touched.add(identity.companyId);
}

const later = fixes.filter((fix) => "company" in fix && adding.has(fix.company));
for (const fix of later)
  if (fix.kind === "history_lead")
    console.log(
      `history_lead ${fix.company}: ${[fix.stage_as_written, fix.amount_as_written, fix.announced_date].filter(Boolean).join(" ")} -> ledger once the company is added (${fix.evidence})`,
    );
const fixed = await applyRecordFixes(
  handle,
  fixes.filter((fix) => !later.includes(fix)),
  { apply },
);
for (const line of fixed.lines) console.log(line);
refused += fixed.refused;
console.log(
  `\n${fixes.length} fix(es): ${later.length ? `${later.length} wait for their company, ` : ""}${apply ? `${fixed.applied} applied` : "planned above"}, ${fixed.skipped} already in place, ${fixed.refused} refused.`,
);
for (const fix of fixes) if ("company" in fix) touched.add(fix.company);

const reader = apply ? firecrawlHistoryReader(getFirecrawl()) : null;
let credits = 0;
for (const companyId of touched) {
  if (!reader) {
    const now = new Date();
    const rows = await handle.select().from(historyPromotions).where(eq(historyPromotions.companyId, companyId));
    const waiting = rows.filter((r) => due(r, now));
    console.log(`\n${companyId}: ${waiting.length} lead(s) due now, plus the leads queued above`);
    for (const r of waiting) console.log(`  ${r.priorKey} (${r.origin}, ${r.status})`);
    continue;
  }
  const runId = `history-backfill:${companyId}:${Date.now()}`;
  const keys = await queueCompanyHistory(handle, companyId);
  console.log(`\n${companyId}: ${keys.length} lead(s) due`);
  for (const key of keys) {
    const outcome = await promotePrior(handle, reader, companyId, key, runId);
    credits += outcome.credits;
    const [ledger] = await handle
      .select({ outcome: historyPromotions.outcome, sourceUrl: historyPromotions.sourceUrl })
      .from(historyPromotions)
      .where(and(eq(historyPromotions.companyId, companyId), eq(historyPromotions.priorKey, key)));
    const [round] = outcome.roundId
      ? await handle
          .select({
            stage: fundingRounds.stageAsWritten,
            amount: fundingRounds.amountAsWritten,
            on: fundingRounds.announcedOn,
            valuation: fundingRounds.valuationAsWritten,
          })
          .from(fundingRounds)
          .where(eq(fundingRounds.id, outcome.roundId))
      : [];
    console.log(
      `  ${key}: ${outcome.status}${outcome.roundId ? ` -> ${outcome.roundId} (${outcome.disposition}${outcome.merged ? ", merged" : ""})` : ""}${outcome.reason ? `: ${outcome.reason}` : ""} [${outcome.credits} credits]`,
    );
    if (round)
      console.log(`    ${round.stage}, ${round.amount ?? "no amount"}, ${round.on ?? "undated"}, valuation ${round.valuation ?? "none"}`);
    if (ledger?.sourceUrl) console.log(`    page: ${ledger.sourceUrl}`);
    const tried = (ledger?.outcome as { tried?: Array<{ url: string; result: string }> } | null)?.tried ?? [];
    if (outcome.status !== "promoted") for (const t of tried) console.log(`    tried ${t.url}: ${t.result}`);
  }
}
if (apply) console.log(`\nHistory lane: about ${credits} credits.`);

if (corroborating) {
  const shown = {
    id: fundingRounds.id,
    disposition: fundingRounds.disposition,
    confidence: fundingRounds.confidence,
    valuation: fundingRounds.valuationAsWritten,
  };
  const rows = await handle
    .select(shown)
    .from(fundingRounds)
    .where(
      and(
        inArray(fundingRounds.companyId, [...touched]),
        inArray(fundingRounds.disposition, ["flagged", "review"]),
        isNull(fundingRounds.hold),
      ),
    );
  console.log(`\nCorroboration: ${rows.length} flagged or review row(s)`);
  if (!apply) for (const r of rows) console.log(`  ${r.id} (${r.disposition}, confidence ${r.confidence})`);
  if (apply && rows.length > 0) {
    const client = getFirecrawl();
    const tiers = { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
    const grew: string[] = [];
    let spent = 0;
    for (const r of rows) {
      const outcome = await corroborateRecord(handle, client, r.id, { tiers }).catch((err: unknown) => {
        console.log(`  ${r.id}: not corroborated: ${err instanceof Error ? err.message : err}`);
        return null;
      });
      if (!outcome) continue;
      spent += outcome.creditsEstimated;
      if (outcome.added.sources > 0 && !outcome.reviewConflict) grew.push(r.id);
      console.log(
        `  ${r.id}: +${outcome.added.sources} source(s), ${outcome.disposition.before} -> ${outcome.disposition.after}${outcome.contradictions.length ? `; held: ${outcome.contradictions.join("; ")}` : ""}`,
      );
    }
    const model = corroborateModel();
    if (model && grew.length > 0) {
      const read = await reconcileGrownRows(handle, client, model, grew, { rates: await fetchRates("latest").catch(() => null), tiers });
      spent += read.credits;
    }
    for (const after of await handle
      .select(shown)
      .from(fundingRounds)
      .where(
        inArray(
          fundingRounds.id,
          rows.map((r) => r.id),
        ),
      )) {
      const before = rows.find((r) => r.id === after.id);
      console.log(
        `  ${after.id}: ${before?.disposition} -> ${after.disposition}, confidence ${before?.confidence} -> ${after.confidence}, valuation ${after.valuation ?? "none"}`,
      );
    }
    console.log(`Corroboration: about ${spent} credits.`);
  }
}
if (apply) await invalidateScriptEntityPages().catch((err) => console.log(`Cache: ${err instanceof Error ? err.message : err}`));
await closeDb();
process.exit(refused > 0 ? 2 : 0);
