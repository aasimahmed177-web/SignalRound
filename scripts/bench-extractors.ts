import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  classifyStage,
  dedupeInvestorNames,
  groundQuotedPage,
  normalizeCompanyKey,
  parseAmount,
  QuotedPage,
  RoundsPageLenient,
  readQuotedPage,
  reconcileModel,
} from "@fireround/core";

type Expected = {
  company: string;
  stage: string | null;
  new_money: number | null;
  round_total: number | null;
  valuation: number | null;
  date: string | null;
  lead: string[];
  currency?: string;
  investors?: string[];
  valuation_basis?: string | null;
  round?: boolean;
};
type Case = { id: string; expected: Expected };
type Capture = { url: string; markdown: string; json: unknown; ms: number; metadata?: Record<string, unknown> };
type Observation = { page: unknown; quoted?: unknown; ms: number; input: number; output: number; error?: string };
const cases = (JSON.parse(await readFile(new URL("../evals/pipeline-cases.json", import.meta.url), "utf8")) as { cases: Case[] }).cases;
if (!process.argv.includes("--original-only")) {
  const additional = JSON.parse(
    await readFile(new URL("../evals/pipeline-new-cases.json", import.meta.url), "utf8").catch(() => '{"cases":[]}'),
  ) as { cases: Case[] };
  cases.push(...additional.cases);
}
const baseline = (
  JSON.parse(await readFile(new URL("../evals/pipeline-captures.json", import.meta.url), "utf8")) as {
    captures: Record<string, Capture>;
  }
).captures;
const pairedQuoted = process.argv.includes("--quoted") || process.argv.includes("--paired-quoted");
const quotedCaptures = pairedQuoted
  ? (
      JSON.parse(await readFile(new URL("../evals/pipeline-quoted-captures.json", import.meta.url), "utf8")) as {
        captures: Record<string, Capture & { sameMarkdown: boolean }>;
      }
    ).captures
  : null;
const captures = process.argv.includes("--quoted") && quotedCaptures ? quotedCaptures : baseline;
const ids = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const prices = Object.fromEntries(
  (
    (await (await fetch("https://ai-gateway.vercel.sh/v1/models")).json()) as {
      data: Array<{ id: string; pricing: { input: string; output: string } }>;
    }
  ).data.map((m) => [m.id, { input: Number(m.pricing.input), output: Number(m.pricing.output) }]),
);
const path = new URL("../evals/reports/extractor-results.json", import.meta.url);
await mkdir(new URL("../evals/reports/", import.meta.url), { recursive: true });
const results = JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as Record<string, Record<string, Observation>>;

for (const id of process.argv.includes("--score-only") ? [] : ids) {
  const model = reconcileModel({ ...process.env, RECONCILE: undefined, RECONCILE_MODEL: id });
  if (!model) throw new Error("Set AI_GATEWAY_API_KEY for model comparison");
  results[id] ??= {};
  const observations = results[id];
  for (let start = 0; start < cases.length; start += 3) {
    await Promise.all(
      cases.slice(start, start + 3).map(async (c) => {
        const capture = captures[c.id];
        if (!capture || (observations[c.id] && !process.argv.includes("--refresh"))) return;
        const start = performance.now();
        try {
          const { page, quoted, usage } = await readQuotedPage(capture.markdown, model);
          observations[c.id] = {
            page,
            quoted,
            ms: Math.round(performance.now() - start),
            ...usage,
            ...(!page ? { error: "grounding rejected" } : {}),
          };
          process.stderr.write(`${id} ${c.id}: ${page ? "grounded" : "rejected"}\n`);
        } catch (error) {
          observations[c.id] = {
            page: null,
            ms: Math.round(performance.now() - start),
            input: 0,
            output: 0,
            error: error instanceof Error ? error.message : String(error),
          };
          process.stderr.write(`${id} ${c.id}: failed\n`);
        }
      }),
    );
    await writeFile(path, `${JSON.stringify(results)}\n`);
  }
}

const fields = ["company", "stage", "new_money", "round_total", "valuation", "valuation_basis", "date", "lead", "investors"] as const;
type Field = (typeof fields)[number];
const norm = (v: unknown) =>
  String(v)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const absent = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);
function prediction(json: unknown, expected: Expected, metadata?: Record<string, unknown>): Partial<Record<Field, unknown>> {
  const page = RoundsPageLenient.safeParse(json);
  if (!page.success) return {};
  const r = page.data.rounds.find((round) => normalizeCompanyKey(round.company_name) === normalizeCompanyKey(expected.company));
  if (!r) return {};
  const amount = parseAmount(r.amount_as_written);
  const valuation = parseAmount(r.valuation_as_written);
  const published = metadata?.publishedTime ?? metadata?.["article:published_time"];
  return {
    company: r.company_name,
    stage: classifyStage(r.round_type_as_written).stage,
    new_money: amount.currency === (expected.currency ?? "USD") ? amount.value : Number.NaN,
    round_total:
      parseAmount(r.financing_total_as_written).value ?? (classifyStage(r.round_type_as_written).isExtension ? null : amount.value),
    valuation: valuation.value,
    valuation_basis: /post.money/i.test(r.valuation_quote ?? "") ? "post" : /pre.money/i.test(r.valuation_quote ?? "") ? "pre" : null,
    date: r.announced_date ?? (typeof published === "string" ? published.slice(0, 10) : page.data.page_date),
    lead: r.lead_investors,
    investors: r.other_investors,
  };
}
for (const [id, entries] of [
  [process.argv.includes("--quoted") ? "firecrawl-json-with-quotes" : "firecrawl-json", null],
  ...ids.map((id) => [id, results[id]] as const),
] as const) {
  const scores = Object.fromEntries(fields.map((f) => [f, { tp: 0, fp: 0, fn: 0, abstain: 0, tn: 0, unscored: 0 }])) as Record<
    Field,
    { tp: number; fp: number; fn: number; abstain: number; tn: number; unscored: number }
  >;
  let pages = 0;
  let failed = 0;
  let totalMs = 0;
  let totalCost = 0;
  for (const c of cases) {
    const capture = captures[c.id];
    if (!capture || (quotedCaptures && !process.argv.includes("--quoted-all") && !quotedCaptures[c.id]?.sameMarkdown)) continue;
    const quotedPage = process.argv.includes("--quoted") ? QuotedPage.safeParse(capture.json) : null;
    const result = entries
      ? entries[c.id]
      : {
          page: quotedPage ? (quotedPage.success ? groundQuotedPage(quotedPage.data, capture.markdown) : null) : capture.json,
          ms: capture.ms,
          input: 0,
          output: 0,
        };
    if (!result) continue;
    pages++;
    const page = result.quoted ? groundQuotedPage(QuotedPage.parse(result.quoted), capture.markdown) : result.page;
    if (!page) failed++;
    totalMs += result.ms;
    const p = prices[id] ?? { input: 0, output: 0 };
    totalCost += result.input * p.input + result.output * p.output;
    const got = prediction(page, c.expected, capture.metadata);
    for (const field of fields) {
      const score = scores[field];
      if ((field === "investors" && !c.expected.investors) || (field === "valuation_basis" && !Object.hasOwn(c.expected, field))) {
        score.unscored++;
        continue;
      }
      const want = c.expected.round === false ? (field === "lead" || field === "investors" ? [] : null) : c.expected[field];
      const have = got[field];
      if (absent(have)) {
        if (absent(want)) score.tn++;
        else {
          score.fn++;
          score.abstain++;
        }
      } else if (absent(want)) score.fp++;
      else {
        const same =
          typeof want === "number" && typeof have === "number"
            ? Number.isFinite(have) && Math.abs(have - want) <= Math.max(0.01, want * 0.01)
            : Array.isArray(want) && Array.isArray(have)
              ? want.length === have.length &&
                want.every((v) => have.some((h) => norm(h) === norm(v) || dedupeInvestorNames([String(h), String(v)]).length === 1))
              : norm(have) === norm(want);
        if (same) score.tp++;
        else {
          score.fp++;
          score.fn++;
        }
      }
    }
  }
  console.log(
    `\n${id}: ${pages} paired pages, ${failed} rejected/failed, ${(totalMs / pages / 1000).toFixed(1)} sec/page, $${(totalCost / pages).toFixed(4)} model/page plus Firecrawl scrape`,
  );
  for (const field of fields) {
    const s = scores[field];
    if (s.unscored === pages) continue;
    const precision = s.tp + s.fp ? (s.tp / (s.tp + s.fp)).toFixed(2) : "n/a";
    const recall = s.tp + s.fn ? (s.tp / (s.tp + s.fn)).toFixed(2) : "n/a";
    console.log(
      `${field.padEnd(16)} ${precision.padEnd(5)} ${recall.padEnd(5)} ${String(s.abstain).padEnd(3)} ${s.tp}/${s.fp}/${s.fn}/${s.tn} (${s.unscored} unlabeled)`,
    );
  }
}
