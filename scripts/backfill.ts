// The historical backfill from a terminal, against a running app (local or deployed):
//   pnpm backfill --months 3            # prints the rate-card estimate and stops
//   pnpm backfill --months 3 --yes      # starts it: one month sweep per preset per month, plus Form D over the span
// Talks to GET /api/cron/sweep?backfill=N on BASE_URL (default http://localhost:3000) with
// CRON_SECRET from .env as the bearer when set, so the same command works against Vercel.

export {};

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface EstimateResponse {
  ok: boolean;
  backfill: number;
  windows: string[];
  presets: string[];
  formD: { start: string; end: string };
  estimate: { low: number; high: number; lines: Array<{ label: string; low: number; high: number }> };
}

interface StartResponse {
  ok: boolean;
  runs: Array<{ preset: string; window: string; runId: string }>;
  lanes: Array<{ lane: string; preset: string | null; runId: string }>;
}

const months = Number(arg("--months", "3"));
if (!Number.isInteger(months) || months < 1) {
  console.error("--months must be a whole number of months, 1 or more.");
  process.exit(2);
}
const base = arg("--base-url", process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const yes = process.argv.includes("--yes");
const headers: Record<string, string> = process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {};

async function get<T>(query: string): Promise<T> {
  const res = await fetch(`${base}/api/cron/sweep?${query}`, { headers });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${res.status} ${body.error ?? "request failed"}`);
  return body;
}

const range = (low: number, high: number) => (low === high ? String(low) : `${low} to ${high}`);

const est = await get<EstimateResponse>(`backfill=${months}&estimate=1`);
const span = `${est.formD.start.slice(0, 10)} to ${est.formD.end.slice(0, 10)}`;
console.log(`Backfill ${months} ${months === 1 ? "month" : "months"} on ${base}`);
console.log(`  Sweeps: ${est.windows.join(", ")} for ${est.presets.join(", ")} (${est.windows.length * est.presets.length} runs)`);
console.log(`  Form D: EDGAR filings ${span} (one run, weekly pages, no credits)`);
console.log("  Estimate (rate card; a month sweep costs about a week sweep, the same results per query plus the pages):");
for (const line of est.estimate.lines) console.log(`    ${line.label}: ${range(line.low, line.high)}`);
console.log(`    Total: ${range(est.estimate.low, est.estimate.high)} credits`);

if (!yes) {
  console.log("\nNothing started. Add --yes to spend the credits.");
  process.exit(0);
}

const started = await get<StartResponse>(`backfill=${months}`);
console.log(`\nStarted ${started.runs.length} sweeps and ${started.lanes.length} lane run(s):`);
for (const r of started.runs) console.log(`  sweep ${r.preset} ${r.window}  ${r.runId}`);
for (const l of started.lanes) console.log(`  ${l.lane}${l.preset ? ` ${l.preset}` : ""}  ${l.runId}`);
console.log(`\nWatch them on ${base}/runs.`);
