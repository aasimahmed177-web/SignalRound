import { readFile, writeFile } from "node:fs/promises";
import { extractRounds, generateReconciliation, reconcileModel, reconcileRecords, resolveRounds, STAGES } from "@fireround/core";
import type { Firecrawl } from "firecrawl";

const selected = new Set([
  "fore-d2",
  "positron-c",
  "cyera-extension",
  "tldraw-seed-extension",
  "tldraw-a",
  "axya-split",
  "axya-release",
  "nscale-convertible",
  "hubble-c",
  "biolevate-a",
  "zeliq-seed-extension",
  "lightfield-a",
  "profound-d",
  "snorkel-e",
  "ema-b",
  "cloudnc-b-extension",
  "neurophos-old",
  "enveda-e",
  "slice-down-round",
  "rightway-roundup",
]);
const cases = (
  JSON.parse(await readFile(new URL("../evals/pipeline-cases.json", import.meta.url), "utf8")) as {
    cases: Array<{
      id: string;
      url: string;
      expected: { company: string; new_money: number | null; date: string | null; currency?: string };
    }>;
  }
).cases.filter((c) => selected.has(c.id));
const captures = (
  JSON.parse(await readFile(new URL("../evals/pipeline-captures.json", import.meta.url), "utf8")) as {
    captures: Record<string, { markdown: string; json: unknown }>;
  }
).captures;
const prices = Object.fromEntries(
  (
    (await (await fetch("https://ai-gateway.vercel.sh/v1/models")).json()) as {
      data: Array<{ id: string; pricing: { input: string; output: string } }>;
    }
  ).data.map((m) => [m.id, { input: Number(m.pricing.input), output: Number(m.pricing.output) }]),
);
const path = new URL("../evals/reports/readback-results.json", import.meta.url);
const results = JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as Record<
  string,
  Record<
    string,
    { amount: number | null; currency: string | null; date: string | null; ms: number; failed: boolean; input: number; output: number }
  >
>;
const models = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
for (const id of models) {
  const model = reconcileModel({ ...process.env, RECONCILE: undefined, RECONCILE_MODEL: id });
  if (!model) throw new Error("AI_GATEWAY_API_KEY required");
  results[id] ??= {};
  for (const c of cases) {
    if (results[id][c.id] && !process.argv.includes("--refresh")) continue;
    const capture = captures[c.id];
    const extraction = await extractRounds(
      { scrape: async () => ({ markdown: capture.markdown, json: capture.json, metadata: {} }) } as unknown as Firecrawl,
      [{ url: c.url }],
      { now: new Date("2026-09-27T12:00:00Z") },
    );
    const resolved = resolveRounds(extraction.items, {
      stages: [...STAGES],
      windowStart: new Date("2025-01-01T00:00:00Z"),
      now: new Date("2026-12-31T00:00:00Z"),
    });
    const record = resolved.kept.find((r) => r.company_name.toLowerCase().includes(c.expected.company.toLowerCase().split(" ")[0]));
    if (!record) {
      process.stderr.write(`${id} ${c.id}: no input record\n`);
      continue;
    }
    const started = performance.now();
    const usage = { input: 0, output: 0 };
    const read = await reconcileRecords(
      [record],
      async () => [{ url: c.url, host: new URL(c.url).host, markdown: capture.markdown }],
      model,
      {
        rates: null,
        concurrency: 1,
        generate: async (prompt) => {
          const result = await generateReconciliation(model, prompt, { maxRetries: 1, zeroDataRetention: true });
          usage.input += result.usage.input;
          usage.output += result.usage.output;
          if (!result.output) throw new Error("No structured read-back");
          return result.output;
        },
      },
    );
    const output = read.records[0];
    results[id][c.id] = {
      amount: output?.amount.value ?? null,
      currency: output?.amount.currency ?? null,
      date: output?.announced_date ?? null,
      ms: Math.round(performance.now() - started),
      failed: read.failed > 0,
      input: usage.input,
      output: usage.output,
    };
    await writeFile(path, `${JSON.stringify(results)}\n`);
    process.stderr.write(`${id} ${c.id}: ${read.failed ? "failed" : "read"}\n`);
  }
}
for (const id of models) {
  const entries = results[id];
  let money = 0;
  let dates = 0;
  let moneyTotal = 0;
  let dateTotal = 0;
  let failed = 0;
  let ms = 0;
  let cost = 0;
  for (const c of cases) {
    const entry = entries[c.id];
    if (!entry) continue;
    failed += Number(entry.failed);
    ms += entry.ms;
    const price = prices[id];
    cost += entry.input * (price?.input ?? 0) + entry.output * (price?.output ?? 0);
    moneyTotal++;
    dateTotal++;
    if (entry.amount === c.expected.new_money && (entry.amount === null || entry.currency === (c.expected.currency ?? "USD"))) money++;
    if (entry.date === c.expected.date) dates++;
  }
  console.log(
    `${id}: money ${money}/${moneyTotal}, date ${dates}/${dateTotal}, failures ${failed}, ${(ms / Object.keys(entries).length / 1000).toFixed(1)} sec/page, $${(cost / Object.keys(entries).length).toFixed(4)}/page`,
  );
}
