import { readFile } from "node:fs/promises";
import {
  amountInEvidence,
  DEFAULT_TIERS,
  extractRounds,
  groundingCheck,
  namesCompany,
  normalizeCompanyKey,
  pageSentences,
  parseAmount,
  RoundsPage,
  reconcileModel,
  reconcileRecords,
  resolveRounds,
  STAGES,
  secondhandOnly,
  splitByDisposition,
} from "@fireround/core";
import { closeDb, getDb } from "@fireround/core/db";
import { pageSnapshotReads, pageSnapshots } from "@fireround/core/db/schema";
import type { NativeWebClient } from "@fireround/core/web";
import { generateText, Output } from "ai";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { staleForNews } from "../lib/deliverable.ts";
import { dispositionFor } from "../lib/persist.ts";

interface Expected {
  company: string;
  stage: string | null;
  new_money: number | null;
  round_total: number | null;
  valuation: number | null;
  date: string | null;
  lead: string[];
  currency?: string;
  publish?: boolean;
  round?: boolean;
}
interface Case {
  id: string;
  url: string;
  markdown?: string;
  extract?: Record<string, unknown>;
  expected: Expected;
  page_kind?: "roundup";
  page_date?: string;
}

const args = process.argv.slice(2);
const stored = args.includes("--stored");
const authored = args.includes("--fixture") || args.includes("--assert");
const legacy = args.includes("--legacy");
const modelIndex = args.indexOf("--model");
const modelId = modelIndex < 0 ? null : args[modelIndex + 1];
if (modelIndex >= 0 && !modelId) throw new Error("--model requires a model id");
const caseIndex = args.indexOf("--case");
const caseId = caseIndex < 0 ? null : args[caseIndex + 1];
if (caseIndex >= 0 && !caseId) throw new Error("--case requires a case id");
const fixture = JSON.parse(await readFile(new URL("../evals/pipeline-cases.json", import.meta.url), "utf8")) as { cases: Case[] };
if (!authored) {
  const additional = JSON.parse(await readFile(new URL("../evals/pipeline-new-cases.json", import.meta.url), "utf8")) as typeof fixture;
  fixture.cases.push(...additional.cases);
}
const captured = authored
  ? null
  : (
      JSON.parse(
        await readFile(
          new URL(legacy ? "../evals/pipeline-captures.json" : "../evals/pipeline-quoted-captures.json", import.meta.url),
          "utf8",
        ),
      ) as {
        captures: Record<string, { markdown: string; json: unknown; metadata?: Record<string, unknown> }>;
      }
    ).captures;
if (caseId) {
  fixture.cases = fixture.cases.filter((c) => c.id === caseId);
  if (!fixture.cases.length) throw new Error(`Unknown case: ${caseId}`);
}
const model = modelId ? reconcileModel({ ...process.env, RECONCILE: undefined, RECONCILE_MODEL: modelId }) : null;
if (modelId && !model) throw new Error("Set AI_GATEWAY_API_KEY or a configured provider key for --model");

const quotedPage = z.object({
  page: RoundsPage,
  quotes: z.array(
    z.object({
      company: z.string(),
      fields: z.object({
        company: z.string().nullable(),
        stage: z.string().nullable(),
        new_money: z.string().nullable(),
        round_total: z.string().nullable(),
        valuation: z.string().nullable(),
        date: z.string().nullable(),
        lead: z.string().nullable(),
      }),
    }),
  ),
});

function fixtureExtraction(c: Case): unknown {
  const valuation = c.extract?.valuation_as_written;
  const valuationQuote =
    typeof valuation === "string"
      ? (pageSentences(c.markdown ?? "").find(
          (sentence) =>
            !sentence.startsWith("#") &&
            /\b(?:valuation|valued|worth)\b/i.test(sentence) &&
            amountInEvidence(valuation, sentence) &&
            namesCompany(sentence, c.expected.company),
        ) ??
        pageSentences(c.markdown ?? "").find(
          (sentence) => amountInEvidence(valuation, sentence) && namesCompany(sentence, c.expected.company),
        ) ??
        null)
      : null;
  return {
    page_kind: c.page_kind ?? "article",
    page_date: c.page_date ?? c.expected.date,
    rounds: [
      {
        company_website: null,
        company_description: null,
        amount_kind: "round",
        other_investors: [],
        headquarters: null,
        sector: null,
        source_url: null,
        is_background: false,
        is_rumor: false,
        valuation_quote: valuationQuote,
        ...c.extract,
      },
    ],
  };
}

async function inputFor(c: Case): Promise<{ markdown: string; json: unknown; metadata: Record<string, unknown> }> {
  let markdown = authored ? (c.markdown ?? "") : (captured?.[c.id]?.markdown ?? "");
  let json = authored ? fixtureExtraction(c) : captured?.[c.id]?.json;
  let metadata = authored ? {} : (captured?.[c.id]?.metadata ?? {});
  if (!markdown || !json) throw new Error(`No captured NativeWebClient markdown and JSON for ${c.id}`);
  if (stored) {
    const db = await getDb();
    const [read] = await db
      .select({ markdown: pageSnapshots.markdown, json: pageSnapshotReads.rawExtraction })
      .from(pageSnapshotReads)
      .innerJoin(pageSnapshots, eq(pageSnapshotReads.snapshotHash, pageSnapshots.hash))
      .where(and(eq(pageSnapshotReads.sourceUrl, c.url), isNotNull(pageSnapshotReads.rawExtraction)))
      .orderBy(desc(pageSnapshotReads.readAt))
      .limit(1);
    if (!read?.json) throw new Error(`No captured markdown and NativeWebClient JSON for ${c.id}: ${c.url}`);
    markdown = read.markdown;
    json = read.json;
    if (markdown !== captured?.[c.id]?.markdown) metadata = {};
  }
  if (!model) return { markdown, json, metadata };
  const result = await generateText({
    model: model.model,
    output: Output.object({ schema: quotedPage }),
    prompt:
      `Read this funding article and extract its funding rounds. For each stated field, copy a supporting verbatim quote. ` +
      `Return null for an unstated field. Do not treat older rounds, cumulative funding, debt, or valuation as new equity.\n\n${markdown}`,
    maxRetries: 1,
  });
  const output = await result.output;
  if (!output) throw new Error(`No structured output for ${c.id}`);
  for (const round of output.page.rounds) {
    const cited = output.quotes.find((entry) => norm(entry.company) === norm(round.company_name));
    if (!cited) throw new Error(`${c.id}: no field citations for ${round.company_name}`);
    for (const [field, stated] of [
      ["company", true],
      ["stage", !!round.round_type_as_written],
      ["new_money", !!round.amount_as_written],
      ["valuation", !!round.valuation_as_written],
      ["date", !!round.announced_date],
      ["lead", round.lead_investors.length > 0],
    ] as const) {
      if (stated && !cited.fields[field]) throw new Error(`${c.id}: missing ${field} quote for ${round.company_name}`);
    }
  }
  for (const cited of output.quotes) {
    for (const [field, quote] of Object.entries(cited.fields)) {
      if (quote && !groundingCheck({ evidence_quote: quote }, markdown)) {
        throw new Error(`${c.id}: ungrounded ${field} quote for ${cited.company}`);
      }
    }
  }
  return { markdown, json: output.page, metadata };
}

function sameCompany(actual: string, expected: string): boolean {
  const a = normalizeCompanyKey(actual);
  const b = normalizeCompanyKey(expected);
  return a === b || (a.length >= 5 && (b.startsWith(`${a} `) || b.endsWith(` ${a}`)));
}

const fields = ["company", "stage", "new_money", "round_total", "valuation", "date", "lead"] as const;
type Field = (typeof fields)[number];
type Counts = { tp: number; fp: number; fn: number; abstained: number; tn: number };
const scores = Object.fromEntries(fields.map((f) => [f, { tp: 0, fp: 0, fn: 0, abstained: 0, tn: 0 }])) as Record<Field, Counts>;
const norm = (v: unknown): string =>
  String(v)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const equal = (f: Field, a: unknown, b: unknown): boolean => {
  if (f === "lead") {
    const left = (a as string[]).map(norm).sort();
    const right = (b as string[]).map(norm).sort();
    return JSON.stringify(left) === JSON.stringify(right);
  }
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= Math.max(0.01, 0.01 * b);
  return f === "company" ? norm(a) === norm(b) : a === b;
};
function score(f: Field, predicted: unknown, expected: unknown): void {
  const s = scores[f];
  const absent = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  if (absent(predicted)) {
    if (absent(expected)) s.tn++;
    else {
      s.fn++;
      s.abstained++;
    }
  } else if (absent(expected)) s.fp++;
  else if (equal(f, predicted, expected)) s.tp++;
  else {
    s.fp++;
    s.fn++;
  }
}

let duplicates = 0;
let falseNew = 0;
let unlabelledRounds = 0;
let missedNew = 0;
let acceptedForVerification = 0;
let predictedNew = 0;
let expectedNew = 0;
let readBackGrounded = 0;
let readBackChecked = 0;
const axyaItems: Awaited<ReturnType<typeof extractRounds>>["items"] = [];
const details: string[] = [];
for (const c of fixture.cases) {
  const input = await inputFor(c).catch((error: unknown) => {
    if (stored || !model) throw error;
    details.push(`${c.id}: extraction failed (${error instanceof Error ? error.message : String(error)})`);
    for (const field of fields) score(field, field === "lead" ? [] : null, c.expected.round === false ? null : c.expected[field]);
    if (c.expected.publish) {
      expectedNew++;
      missedNew++;
    }
    return null;
  });
  if (!input) continue;
  const doc = { json: input.json, markdown: input.markdown, metadata: { title: c.id, ...input.metadata } };
  const extraction = await extractRounds({ scrape: async () => doc } as unknown as NativeWebClient, [{ url: c.url }], {
    now: authored ? new Date(`${c.expected.date ?? "2026-09-26"}T12:00:00Z`) : new Date("2026-09-27T12:00:00Z"),
  });
  if (!extraction.pages[0]?.ok) throw new Error(`${c.id}: extraction failed: ${extraction.pages[0]?.error}`);
  if (c.id === "axya-split" || c.id === "axya-release") axyaItems.push(...extraction.items);
  const year = Number((c.expected.date ?? "2026-09-26").slice(0, 4));
  const resolved = resolveRounds(extraction.items, {
    stages: [...STAGES],
    windowStart: new Date(`${year - 1}-01-01T00:00:00Z`),
    now: new Date(`${year + 1}-01-01T00:00:00Z`),
  });
  const record = resolved.kept.find((r) => sameCompany(r.company_name, c.expected.company));
  const otherRecords = resolved.kept.length - (record ? 1 : 0);
  if (otherRecords > 0) unlabelledRounds += otherRecords;
  let scoredRecord = record;
  let eligible = false;
  let ready = false;
  if (record) {
    const read = async () => [{ url: c.url, host: new URL(c.url).host, markdown: input.markdown }];
    if (model) {
      const result = await reconcileRecords([record], read, model, { rates: null, concurrency: 1 });
      if (result.failed) details.push(`${c.id}: read-back failed`);
      else details.push(`${c.id}: read-back ${result.records[0]?.verification?.status ?? "unknown"}`);
      scoredRecord = result.failed ? undefined : result.records[0];
    } else {
      readBackChecked++;
      if (record.evidence_quotes.every((q) => groundingCheck({ evidence_quote: q }, input.markdown))) readBackGrounded++;
    }
    const replay = resolveRounds([...extraction.items, ...extraction.items], {
      stages: [...STAGES],
      windowStart: new Date(`${year - 1}-01-01T00:00:00Z`),
      now: new Date(`${year + 1}-01-01T00:00:00Z`),
    });
    duplicates += Math.max(0, replay.kept.length - resolved.kept.length);
    const current = resolveRounds(extraction.items, {
      stages: [...STAGES],
      windowStart: new Date("2026-09-20T00:00:00Z"),
      now: new Date("2026-09-27T12:00:00Z"),
    });
    const currentRecord = current.kept.find((r) => sameCompany(r.company_name, c.expected.company));
    const now = new Date("2026-09-27T12:00:00Z");
    ready =
      currentRecord !== undefined &&
      dispositionFor(currentRecord, {
        secondhand: secondhandOnly(
          currentRecord.sources.map((s) => s.url),
          DEFAULT_TIERS,
        ),
      }) !== "review" &&
      !staleForNews(currentRecord.announced_date, now);
    if (ready && c.expected.publish) acceptedForVerification++;
    eligible = model
      ? currentRecord !== undefined &&
        (scoredRecord?.verification?.status === "confirmed" || scoredRecord?.verification?.status === "corrected") &&
        splitByDisposition(scoredRecord ? [scoredRecord] : []).publish.length > 0
      : currentRecord !== undefined && splitByDisposition([currentRecord]).publish.length > 0;
  }
  if (eligible) predictedNew++;
  if (c.expected.publish) expectedNew++;
  if (eligible && c.expected.publish === false) falseNew++;
  if (!eligible && c.expected.publish === true) missedNew++;
  const predicted: Expected = {
    company: scoredRecord?.company_name ?? "",
    stage: scoredRecord?.stage ?? null,
    new_money: scoredRecord?.amount.value ?? null,
    // A mixed financing (primary with secondary or grants) publishes no new money, only its total.
    round_total: scoredRecord?.is_extension
      ? null
      : (scoredRecord?.amount.value ??
        (scoredRecord?.amount_scope?.startsWith("includes_") ? parseAmount(scoredRecord.financing_total_as_written).value : null)),
    valuation: parseAmount(scoredRecord?.valuation_as_written).value,
    date: scoredRecord?.announced_date ?? null,
    lead: scoredRecord?.lead_investors ?? [],
  };
  for (const f of fields) {
    const value =
      f === "new_money" && predicted.new_money !== null && scoredRecord?.amount.currency !== (c.expected.currency ?? "USD")
        ? NaN
        : predicted[f];
    score(f, value, c.expected.round === false ? null : c.expected[f]);
  }
  details.push(
    `${c.id}: ${record ? `${record.stage}, ${record.amount.as_written ?? "abstained"}` : JSON.stringify(resolved.dropped)}; extra_rounds=${otherRecords}; confidence=${record?.confidence ?? "none"}, candidate=${eligible}, accepted_for_verification=${ready}, expected=${c.expected.publish ?? "unlabelled"}${c.expected.valuation ? `, valuation=${record?.valuation_as_written ?? "abstained"}, ruled_out=${record?.valuation_ruled_out ?? false}` : ""}`,
  );
}
if (axyaItems.length === 2) {
  const pair = resolveRounds(axyaItems, {
    stages: [...STAGES],
    windowStart: new Date("2026-09-01T00:00:00Z"),
    now: new Date("2026-09-27T12:00:00Z"),
  });
  duplicates += Math.max(0, pair.kept.length - 1);
  details.push(`axya cross-source event: ${pair.kept.length} record(s)`);
}
await closeDb();
console.log(
  `${fixture.cases.length} cases; extractor: ${model ? model.label : authored ? "authored fixture JSON" : legacy ? "legacy NativeWebClient JSON" : "quote-required NativeWebClient JSON"}; markdown: ${stored ? "production-copy snapshots" : authored ? "fixture excerpts" : "captured snapshots"}`,
);
console.log("Field             precision  recall  abstentions  tp/fp/fn/tn");
for (const field of fields) {
  const s = scores[field];
  const p = s.tp + s.fp ? (s.tp / (s.tp + s.fp)).toFixed(2) : "n/a";
  const r = s.tp + s.fn ? (s.tp / (s.tp + s.fn)).toFixed(2) : "n/a";
  console.log(`${field.padEnd(17)} ${p.padEnd(10)} ${r.padEnd(7)} ${String(s.abstained).padEnd(12)} ${s.tp}/${s.fp}/${s.fn}/${s.tn}`);
}
console.log(
  `event duplicate outputs: ${duplicates}; accepted for verification: ${acceptedForVerification}/${expectedNew} expected-new; ${model ? "verified publications" : "pre-verification publish candidates"}: ${predictedNew}/${expectedNew} expected; false-new: ${falseNew}; below raw publish threshold: ${missedNew}; unlabelled extra rounds: ${unlabelledRounds}`,
);
console.log(
  model
    ? "Model read-back ran on fixture markdown."
    : `Deterministic read-back grounding: ${readBackGrounded}/${readBackChecked}; no model verification run.`,
);
console.log(details.join("\n"));
if (args.includes("--assert")) {
  if (stored || model || caseId || !authored) throw new Error("--assert requires --fixture on the complete deterministic set");
  const minimum: Record<Field, number> = {
    company: 39,
    stage: 37,
    new_money: 30,
    round_total: 29,
    valuation: 9,
    date: 38,
    lead: 33,
  };
  for (const field of fields) if (scores[field].tp < minimum[field]) throw new Error(`${field} fell below fixture baseline`);
  if (duplicates || falseNew) throw new Error(`event dedupe or false-new guard regressed: ${duplicates} duplicates, ${falseNew} false-new`);
}
