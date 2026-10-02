// Benchmark reconciling models against the hand-verified golden set:
//   pnpm bench-reconcile -- openai/gpt-6-luna meta/muse-spark-1.3-contributor
// Each golden company's stored row is fetched from the running app (http://localhost:3000), its pages are
// read once through Firecrawl, and every model sees the identical prompt. Scores are against the verified
// facts in evals/golden-rounds.json, per field; agreement between models, latency, tokens, and cost per
// record follow. Needs AI_GATEWAY_API_KEY (or another provider key, with RECONCILE_PROVIDER) and
// FIRECRAWL_API_KEY. Writes evals/reports/<date>/bench-reconcile.md (gitignored).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { FeedRecord, ReconcileModel } from "@fireround/core";
import {
  applyReconciliation,
  dedupeInvestorNames,
  fetchRates,
  firecrawlReader,
  generateReconciliation,
  reconcileModel,
  reconcilePrompt,
  sourcesToRead,
} from "@fireround/core";
import Firecrawl from "firecrawl";
import type { RoundRow } from "../lib/persist.ts";
import { recordFromRow } from "../lib/reconcile.ts";

interface Money {
  value: number;
  currency: string;
}
interface GoldenCase {
  name: string;
  date?: string;
  month?: string;
  stage?: string;
  stage_not?: string;
  amount?: Money | null;
  leads?: string[];
  leads_include?: string[];
  leads_exclude?: string[];
  participants_include?: string[];
  absent?: string[];
}

const APP = process.env.BENCH_APP ?? "http://localhost:3000";
const modelIds = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (modelIds.length === 0) {
  console.error("usage: pnpm bench-reconcile -- <model-id> [<model-id> ...]");
  process.exit(2);
}
const firecrawlKey = process.env.FIRECRAWL_API_KEY;
if (!firecrawlKey) throw new Error("FIRECRAWL_API_KEY is not set");

const golden = JSON.parse(await readFile(new URL("../evals/golden-rounds.json", import.meta.url), "utf8")) as { cases: GoldenCase[] };
const rates = await fetchRates().catch(() => null);
const client = new Firecrawl({ apiKey: firecrawlKey });
const read = firecrawlReader(client);

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
async function findRow(name: string): Promise<RoundRow | null> {
  const res = await fetch(`${APP}/api/v1/rounds?limit=50&include_review=true&q=${encodeURIComponent(name)}`);
  if (!res.ok) return null;
  const { data } = (await res.json()) as { data: RoundRow[] };
  const key = norm(name);
  const exact = data.find((r) => norm(r.company.name) === key);
  const prefix = data.find((r) => norm(r.company.name).startsWith(key) || key.startsWith(norm(r.company.name)));
  return exact ?? prefix ?? null;
}

/** Two names are one investor when the dedupe folds them (aliases, suffixes, one-edit typos). */
const same = (a: string, b: string) => {
  if (dedupeInvestorNames([a, b]).length === 1) return true;
  // "BDC Growth Venture Fund" is inside "Business Development Bank's (BDC) Growth Venture Fund" once the noise is out.
  const na = norm(a)
    .replace(/\b(?:the|of|and|s)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const nb = norm(b)
    .replace(/\b(?:the|of|and|s)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na));
};
const has = (list: string[], name: string) => list.some((n) => same(n, name));
const setEqual = (a: string[], b: string[]) => a.length === b.length && a.every((n) => has(b, n)) && b.every((n) => has(a, n));

type Check = "ok" | "wrong" | "unscored";
interface Score {
  date: Check;
  stage: Check;
  amount: Check;
  leads: Check;
  participants: Check;
}

function score(c: GoldenCase, r: FeedRecord): Score {
  const s: Score = { date: "unscored", stage: "unscored", amount: "unscored", leads: "unscored", participants: "unscored" };
  if (c.date) {
    if (!r.announced_date) s.date = "wrong";
    else if (r.date_precision === "day") s.date = r.announced_date === c.date ? "ok" : "wrong";
    else {
      // A week or month stamp is right when the true day falls in the period it covers.
      const stamp = Date.parse(`${r.announced_date}T00:00:00Z`);
      const truth = Date.parse(`${c.date}T00:00:00Z`);
      const days = (stamp - truth) / 86_400_000;
      s.date =
        r.date_precision === "week"
          ? days >= 0 && days <= 7
            ? "ok"
            : "wrong"
          : r.announced_date.slice(0, 7) === c.date.slice(0, 7)
            ? "ok"
            : "wrong";
    }
  } else if (c.month) {
    s.date = r.announced_date?.slice(0, 7) === c.month ? "ok" : "wrong";
  }
  if (c.stage) s.stage = r.stage === c.stage ? "ok" : "wrong";
  else if (c.stage_not) s.stage = r.stage === c.stage_not ? "wrong" : "ok";
  if (c.amount === null) s.amount = r.amount.value === null ? "ok" : "wrong";
  else if (c.amount) {
    const v = r.amount.value;
    const cur = r.amount.currency;
    s.amount =
      v !== null && cur === c.amount.currency && Math.abs(v - c.amount.value) <= 0.05 * Math.max(v, c.amount.value) ? "ok" : "wrong";
  }
  const leadChecks: boolean[] = [];
  if (c.leads) leadChecks.push(setEqual(r.lead_investors, c.leads));
  if (c.leads_include) leadChecks.push(c.leads_include.every((n) => has(r.lead_investors, n)));
  if (c.leads_exclude) leadChecks.push(c.leads_exclude.every((n) => !has(r.lead_investors, n)));
  if (leadChecks.length) s.leads = leadChecks.every(Boolean) ? "ok" : "wrong";
  const partChecks: boolean[] = [];
  if (c.participants_include) partChecks.push(c.participants_include.every((n) => has(r.other_investors, n)));
  if (c.absent) partChecks.push(c.absent.every((n) => !has(r.other_investors, n) && !has(r.lead_investors, n)));
  if (partChecks.length) s.participants = partChecks.every(Boolean) ? "ok" : "wrong";
  return s;
}

function modelFor(id: string): ReconcileModel {
  // The bench names its models; RECONCILE=off in the app's env is about the pipeline, not this run.
  const m = reconcileModel({ ...process.env, RECONCILE: undefined, RECONCILE_MODEL: id });
  if (!m) throw new Error("no model key: set AI_GATEWAY_API_KEY (or OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY)");
  return m;
}

interface Run {
  ms: number;
  input: number;
  output: number;
  record: FeedRecord | null;
  error: string | null;
  cost: number;
}

/** Gateway list prices per token, from the catalog, so cost is a number and not a guess. */
async function prices(): Promise<Record<string, { input: number; output: number }>> {
  try {
    const res = await fetch("https://ai-gateway.vercel.sh/v1/models");
    const { data } = (await res.json()) as { data: Array<{ id: string; pricing?: { input?: string; output?: string } }> };
    return Object.fromEntries(data.map((m) => [m.id, { input: Number(m.pricing?.input ?? 0), output: Number(m.pricing?.output ?? 0) }]));
  } catch {
    return {};
  }
}

const price = await prices();
const models = modelIds.map((id) => ({ id, model: modelFor(id), runs: new Map<string, Run>() }));

const cases: Array<{ c: GoldenCase; record: FeedRecord; prompt: string; pages: number }> = [];
const missing: string[] = [];
for (const c of golden.cases) {
  const row = await findRow(c.name);
  if (!row) {
    missing.push(c.name);
    continue;
  }
  const record = recordFromRow(row);
  const pages = await read(sourcesToRead(record));
  if (pages.length === 0) {
    missing.push(`${c.name} (no readable page)`);
    continue;
  }
  cases.push({ c, record, prompt: reconcilePrompt(record, pages), pages: pages.length });
  process.stderr.write(`read ${c.name}: ${pages.length} page(s)\n`);
}

for (const m of models) {
  for (const { c, record, prompt } of cases) {
    const t0 = performance.now();
    try {
      const { output: out, usage } = await generateReconciliation(m.model, prompt, { maxRetries: 1 });
      const input = usage.input;
      const output = usage.output;
      const p = price[m.id] ?? { input: 0, output: 0 };
      const applied = out ? applyReconciliation(record, out, { rates, verifier: m.model.label, sourcesSeen: record.sources.length }) : null;
      m.runs.set(c.name, {
        ms: performance.now() - t0,
        input,
        output,
        record: applied,
        error: out ? null : "no output",
        cost: input * p.input + output * p.output,
      });
    } catch (error) {
      m.runs.set(c.name, {
        ms: performance.now() - t0,
        input: 0,
        output: 0,
        record: null,
        error: error instanceof Error ? error.message : String(error),
        cost: 0,
      });
    }
    process.stderr.write(`${m.id} ${c.name}: ${m.runs.get(c.name)?.error ?? "ok"} ${Math.round(m.runs.get(c.name)?.ms ?? 0)}ms\n`);
  }
}

// Scores.
const fields: Array<keyof Score> = ["date", "stage", "amount", "leads", "participants"];
const lines: string[] = [];
lines.push("# Reconciling models against the golden set", "");
lines.push(
  `${cases.length} of ${golden.cases.length} golden companies were in the store and readable${missing.length ? `; not found: ${missing.join(", ")}` : ""}.`,
  "",
);
lines.push(
  "Every model saw the same prompt: the stored record plus up to four of its sources' page text, fetched once through Firecrawl. Scores are against the verified facts in evals/golden-rounds.json; a field a case does not fix is unscored. A week or month stamp counts as right when the true day falls in the period it covers.",
  "",
);

// Baseline: the stored row as the Firecrawl-only pipeline left it.
const baselineScores = cases.map(({ c, record }) => score(c, record));
const tally = (scores: Score[]) => {
  const out: Record<string, { ok: number; wrong: number }> = {};
  for (const f of fields) out[f] = { ok: scores.filter((s) => s[f] === "ok").length, wrong: scores.filter((s) => s[f] === "wrong").length };
  const fully = scores.filter((s) => fields.every((f) => s[f] !== "wrong")).length;
  return { out, fully };
};
const rows: string[] = [];
const header = [
  "Model",
  ...fields.map((f) => `${f} right/scored`),
  "no field wrong",
  "median ms",
  "input tok/rec",
  "output tok/rec",
  "$/record",
  "$/1000 records",
  "errors",
];
rows.push(`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`);
const base = tally(baselineScores);
const verifiers = cases.reduce<Record<string, number>>((m, { record }) => {
  const k = record.verification?.verifier ?? "judge";
  m[k] = (m[k] ?? 0) + 1;
  return m;
}, {});
const baselineLabel = `stored row as verified (${Object.entries(verifiers)
  .map(([k, n]) => `${n} ${k}`)
  .join(", ")})`;
rows.push(
  `| ${baselineLabel} | ${fields.map((f) => `${base.out[f].ok}/${base.out[f].ok + base.out[f].wrong}`).join(" | ")} | ${base.fully}/${cases.length} | | | | | | |`,
);
for (const m of models) {
  const runs = cases.map(({ c }) => m.runs.get(c.name)!);
  const scores = cases.map(
    ({ c }, i) =>
      (runs[i].record
        ? score(c, runs[i].record)
        : { date: "wrong", stage: "wrong", amount: "wrong", leads: "wrong", participants: "wrong" }) as Score,
  );
  const t = tally(scores);
  const ms = runs.map((r) => r.ms).sort((a, b) => a - b);
  const median = ms[Math.floor(ms.length / 2)] ?? 0;
  const n = Math.max(1, runs.length);
  const input = runs.reduce((a, r) => a + r.input, 0) / n;
  const output = runs.reduce((a, r) => a + r.output, 0) / n;
  const cost = runs.reduce((a, r) => a + r.cost, 0) / n;
  rows.push(
    `| ${m.id} | ${fields.map((f) => `${t.out[f].ok}/${t.out[f].ok + t.out[f].wrong}`).join(" | ")} | ${t.fully}/${cases.length} | ${Math.round(median)} | ${Math.round(input)} | ${Math.round(output)} | $${cost.toFixed(4)} | $${(cost * 1000).toFixed(2)} | ${runs.filter((r) => r.error).length} |`,
  );
}
lines.push(...rows, "");

// Agreement between the first two models.
if (models.length >= 2) {
  const [a, b] = models;
  let agreeDate = 0;
  let agreeLeads = 0;
  let agreeAmount = 0;
  let both = 0;
  for (const { c } of cases) {
    const ra = a.runs.get(c.name)?.record;
    const rb = b.runs.get(c.name)?.record;
    if (!ra || !rb) continue;
    both++;
    if (ra.announced_date === rb.announced_date && ra.date_precision === rb.date_precision) agreeDate++;
    if (setEqual(ra.lead_investors, rb.lead_investors)) agreeLeads++;
    if (ra.amount.value === rb.amount.value && ra.amount.currency === rb.amount.currency) agreeAmount++;
  }
  lines.push(
    `## Agreement between ${a.id} and ${b.id}`,
    "",
    `On the ${both} records both answered: same date and precision ${agreeDate}, same lead set ${agreeLeads}, same amount ${agreeAmount}.`,
    "",
  );
}

// Per-case detail.
lines.push("## Per case", "");
const detailHeader = ["Company", "truth", "stored row", ...models.map((m) => m.id)];
lines.push(`| ${detailHeader.join(" | ")} |`, `|${detailHeader.map(() => "---").join("|")}|`);
const show = (r: FeedRecord | null) =>
  r
    ? `${r.announced_date ?? "undated"}/${r.date_precision} · ${r.stage} · ${r.amount.as_written ?? "no amount"} · leads: ${r.lead_investors.join(", ") || "none"}`
    : "error";
const truth = (c: GoldenCase) =>
  [
    c.date ?? c.month,
    c.stage ?? (c.stage_not ? `not ${c.stage_not}` : undefined),
    c.amount === null ? "undisclosed" : c.amount ? `${c.amount.value}M ${c.amount.currency}` : undefined,
    c.leads ? `leads: ${c.leads.join(", ")}` : c.leads_include ? `leads incl. ${c.leads_include.join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
for (const { c, record } of cases) {
  const cells = models.map((m) => {
    const run = m.runs.get(c.name);
    const s = run?.record ? score(c, run.record) : null;
    const flags = s
      ? fields
          .filter((f) => s[f] === "wrong")
          .map((f) => `WRONG ${f}`)
          .join(", ")
      : (run?.error ?? "error");
    return `${show(run?.record ?? null)}${flags ? ` **[${flags}]**` : ""}`;
  });
  const sb = score(c, record);
  const baseFlags = fields
    .filter((f) => sb[f] === "wrong")
    .map((f) => `WRONG ${f}`)
    .join(", ");
  lines.push(`| ${c.name} | ${truth(c)} | ${show(record)}${baseFlags ? ` **[${baseFlags}]**` : ""} | ${cells.join(" | ")} |`);
}
lines.push("");

const day = new Date().toISOString().slice(0, 10);
const dir = new URL(`../evals/reports/${day}/`, import.meta.url);
await mkdir(dir, { recursive: true });
const file = new URL("bench-reconcile.md", dir);
await writeFile(file, `${lines.join("\n")}\n`);
console.log(lines.slice(0, rows.length + 8).join("\n"));
console.log(`\nWritten to ${file.pathname}`);
