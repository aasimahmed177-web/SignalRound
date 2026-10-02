// The one command: run a preset's sweep and persist the records.
//   pnpm sweep                       # series-a-b, last week
//   pnpm sweep -- --preset series-a-b --window day
//   pnpm sweep -- --window month-2       # one past calendar month (0 is the month to date)
// Prints the rate-card estimate beside the credits measured on the account.

import { randomUUID } from "node:crypto";
import { fetchRates, formatWindow, parseWindow, sweep } from "@fireround/core";
import { closeDb } from "@fireround/core/db";
import { openStore } from "../lib/db.ts";
import { getFirecrawl } from "../lib/firecrawl.ts";
import { persistRecords, recordRun } from "../lib/persist.ts";
import { loadPreset } from "../lib/presets.ts";
import { invalidateScriptEntityPages } from "../lib/script-cache-invalidation.ts";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const presetSlug = arg("--preset", "series-a-b");
const window = parseWindow(arg("--window", "week"));
const preset = await loadPreset(presetSlug);
const client = getFirecrawl();
const handle = await openStore();
const runId = randomUUID();
const startedAt = new Date();

const before = await client.getCreditUsage().catch(() => null);
const rates = await fetchRates("latest").catch(() => null);
console.log(
  `Sweep "${preset.name}" (${formatWindow(window)}): ${preset.queries.length} queries x ${preset.sources.join("+")}, ${preset.limit} per source`,
);

let pagesDone = 0;
const result = await sweep(client, preset, {
  window,
  resolve: { rates },
  onPage: (p) => {
    pagesDone++;
    process.stdout.write(p.ok ? (p.rounds ? `+${p.rounds} ` : ". ") : "x ");
  },
});
console.log();

const summary = await persistRecords(handle, result.kept, preset.slug, runId);
const after = await client.getCreditUsage().catch(() => null);
const measured = before && after ? before.remainingCredits - after.remainingCredits : null;

await recordRun(handle, {
  id: runId,
  presetSlug: preset.slug,
  lane: "sweep",
  window: formatWindow(window),
  startedAt,
  finishedAt: new Date(),
  creditsEstimated: result.creditsEstimated,
  creditsMeasured: measured,
  counts: {
    search_results: result.search.resultCount,
    unique_urls: result.search.candidates.length,
    pages_extracted: pagesDone,
    rounds_extracted: result.extraction.items.length,
    records: result.kept.length,
    inserted: summary.inserted,
    updated: summary.updated,
    unchanged: summary.unchanged,
    ...result.dropped,
  },
});

const dated = result.kept.filter((r) => !r.undated);
console.log(
  `${result.search.resultCount} results -> ${result.search.candidates.length} pages -> ${result.extraction.items.length} rounds -> ${dated.length} dated records (${result.kept.length - dated.length} to review); dropped ${result.dropped.otherStage} other stages, ${result.dropped.background} background, ${result.dropped.rumor} rumors, ${result.dropped.outOfWindow} out of window, ${result.dropped.ungrounded} ungrounded.`,
);
console.log(`Persisted: ${summary.inserted} new, ${summary.updated} updated, ${summary.unchanged} unchanged.`);
console.log(`Credits: ${result.creditsEstimated} estimated${measured !== null ? `, ${measured} measured` : ""}. Run ${runId}.`);
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
