// The money replay on stored rows shaped like production's incidents (2026-09-27), written as the
// old rules left them: what the dry run lists, and what applying it writes.

import type { FeedRecord, MoneyReading } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq, sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { replayMoneyRules } from "../lib/money-repair";
import { persistRecords } from "../lib/persist";
import { record, testDb } from "./helpers";

const usd = (value: number, as_written: string) => ({ value, currency: "USD", as_written, usd_millions: value, fx_rate: 1, fx_date: null });

async function stored(handle: Awaited<ReturnType<typeof testDb>>, r: FeedRecord, set: { valuation?: string; disposition?: string } = {}) {
  await persistRecords(handle, [r], "late", `run-${r.id}`);
  if (set.valuation) await handle.execute(sql`update funding_rounds set valuation_as_written = ${set.valuation} where id = ${r.id}`);
  if (set.disposition) await handle.execute(sql`update funding_rounds set disposition = ${set.disposition} where id = ${r.id}`);
}

test("the dry run lists the incidents' bad valuations and a Reddit-only row, keeps what a sentence supports, and applying writes it", async () => {
  const handle = await testDb();
  const confirmed = { verification: { status: "confirmed" as const, notes: [], url: null }, confidence: 0.9 };
  await stored(
    handle,
    record({
      company_name: "Corgi",
      stage: "series_b",
      stage_as_written: "Series B extension",
      is_extension: true,
      announced_date: "2026-09-25",
      amount: usd(64, "$64 million"),
      evidence_quotes: [
        "Corgi has raised $64 million in a Series B extension.",
        "The startup announced it was a unicorn in May with a $160 million Series B at a $1.3 billion valuation.",
      ],
      sources: [
        {
          url: "https://www.forbes.com/sites/corgi-5-billion/",
          host: "forbes.com",
          title: "Corgi Is Now Worth $5 Billion Thanks To Four Funding Rounds In Five Months",
        },
      ],
      ...confirmed,
    }),
    { valuation: "$1.3 billion" },
  );
  await stored(
    handle,
    record({
      company_name: "FORE Biotherapeutics",
      stage: "series_d_plus",
      stage_as_written: "Series D-2 extension",
      is_extension: true,
      announced_date: "2026-09-10",
      amount: usd(67.4, "$67.4 million"),
      evidence_quotes: [
        "FORE Biotherapeutics today announced a $67.4 million extension of its Series D-2 financing, bringing the total Series D-2 raised to $110 million.",
      ],
      sources: [
        {
          url: "https://www.businesswire.com/news/fore-d-2",
          host: "businesswire.com",
          title: "FORE Biotherapeutics Announces Series D-2 Extension",
        },
      ],
      ...confirmed,
    }),
    { valuation: "$110 million" },
  );
  await stored(
    handle,
    record({
      company_name: "Cyera",
      stage: "growth",
      stage_as_written: "funding round",
      announced_date: "2026-06-10",
      amount: usd(600, "$600 million"),
      evidence_quotes: ["Data security firm Cyera said on Wednesday it has raised $600 million at a $12 billion valuation."],
      sources: [
        {
          url: "https://www.reuters.com/cyera-600m",
          host: "reuters.com",
          title: "Data security firm Cyera raises $600 million at $12 billion valuation",
        },
      ],
      ...confirmed,
    }),
    { valuation: "$2.7 billion" },
  );
  await stored(
    handle,
    record({
      company_name: "Acme",
      announced_date: "2026-09-02",
      amount: usd(50, "$50M"),
      evidence_quotes: ["Acme raised $50M at a $500 million valuation."],
      sources: [{ url: "https://techcrunch.com/acme", host: "techcrunch.com", title: "Acme raises $50M" }],
      ...confirmed,
    }),
    { valuation: "$500 million" },
  );
  await stored(
    handle,
    record({
      company_name: "Factory",
      stage: "growth",
      stage_as_written: "funding round",
      announced_date: "2026-09-15",
      amount: usd(200, "$200M"),
      sources: [
        { url: "https://www.reddit.com/r/singularity/comments/1abc/factory/", host: "reddit.com", title: "Factory raises $200M at $5B" },
      ],
      ...confirmed,
    }),
    { disposition: "publish" },
  );

  const dry = await replayMoneyRules(handle);
  expect(dry).toMatchObject({ rows: 5, valuations: 4, valuationsBlanked: 3, toReview: 1 });
  expect(Object.fromEntries(dry.changes.map((c) => [c.company, c.valuation?.reason ?? c.review]))).toEqual({
    Corgi: "it is stated for another round ($160 million)",
    "FORE Biotherapeutics": "$110 million is a total raised, not a valuation",
    Cyera: "no sentence states it",
    Factory: "only funding databases, profile pages, or forums state it",
  });
  // A dry run writes nothing.
  const [corgi] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.stageAsWritten, "Series B extension"));
  expect(corgi.valuationAsWritten).toBe("$1.3 billion");

  await replayMoneyRules(handle, { apply: true });
  const rows = await handle.select().from(schema.fundingRounds);
  const by = (company: string) => rows.find((r) => r.companyId.startsWith(company.toLowerCase().split(" ")[0])) as (typeof rows)[number];
  expect(by("Corgi")).toMatchObject({ valuationAsWritten: null, disposition: "review" });
  expect(by("FORE")).toMatchObject({ valuationAsWritten: null });
  expect(by("Cyera")).toMatchObject({ valuationAsWritten: null });
  expect(by("Acme")).toMatchObject({ valuationAsWritten: "$500 million" });
  expect(by("Factory")).toMatchObject({ disposition: "review" });
  expect((await replayMoneyRules(handle)).changes).toEqual([]);
});

test("re-ground mode keeps a valuation its own sources state, corrects one they state differently, blanks one they do not, and leaves a row it could not read", async () => {
  const handle = await testDb();
  const confirmed = { verification: { status: "confirmed" as const, notes: [], url: null }, confidence: 0.9 };
  const row = (name: string, valuation: string, url: string) =>
    stored(
      handle,
      record({
        company_name: name,
        announced_date: "2026-09-02",
        amount: usd(100, "$100 million"),
        evidence_quotes: [`${name} raised $100 million.`],
        sources: [{ url, host: new URL(url).hostname, title: `${name} raises $100 million` }],
        ...confirmed,
      }),
      { valuation },
    );
  await row("Keepco", "$8 billion", "https://techcrunch.com/keepco");
  await row("Fixco", "$3 billion", "https://techcrunch.com/fixco");
  await row("Blankco", "$2 billion", "https://techcrunch.com/blankco");
  await row("Errco", "$1 billion", "https://unreadable.example/errco");
  await row("Holdco", "$6 billion", "https://multiples.vc/companies/holdco");
  const pages: Record<string, string> = {
    "https://techcrunch.com/keepco": "Keepco has raised $100 million at an $8 billion valuation, the company said.",
    "https://techcrunch.com/fixco": "Fixco raised $100 million at a $4 billion valuation.",
    "https://techcrunch.com/blankco": "Blankco raised $100 million from new investors.",
    "https://multiples.vc/companies/holdco": "Holdco raised $100 million at a $6 billion valuation.",
  };
  const read = async (sources: Array<{ url: string; host: string; title?: string }>) =>
    sources.flatMap((s) => (pages[s.url] ? [{ url: s.url, host: s.host, title: s.title, markdown: pages[s.url] }] : []));
  const none = { stated: false, value: null, source: null, quote: null };
  const answers: Record<string, MoneyReading> = {
    Keepco: {
      amount: none,
      financing_total: none,
      valuation: {
        stated: true,
        value: "$8 billion",
        source: "https://techcrunch.com/keepco",
        quote: "Keepco has raised $100 million at an $8 billion valuation",
      },
    },
    Fixco: {
      amount: none,
      financing_total: none,
      valuation: {
        stated: true,
        value: "$4 billion",
        source: "https://techcrunch.com/fixco",
        quote: "Fixco raised $100 million at a $4 billion valuation.",
      },
    },
    Blankco: { amount: none, financing_total: none, valuation: none },
    Holdco: {
      amount: none,
      financing_total: none,
      valuation: {
        stated: true,
        value: "$6 billion",
        source: "https://multiples.vc/companies/holdco",
        quote: "Holdco raised $100 million at a $6 billion valuation.",
      },
    },
  };
  const prompts: string[] = [];
  const generate = async (prompt: string) => {
    prompts.push(prompt);
    const name = Object.keys(answers).find((n) => prompt.includes(`"company":"${n}"`)) as string;
    return answers[name];
  };

  const dry = await replayMoneyRules(handle, { reground: { read, generate } });
  expect(dry.reground).toEqual({ tried: 5, kept: 1, corrected: 1, held: 1, blanked: 1, errors: 1 });
  expect(Object.fromEntries(dry.changes.map((c) => [c.company, c.valuation?.action ?? c.error]))).toEqual({
    Keepco: "keep",
    Fixco: "correct",
    Blankco: "blank",
    Errco: "no source could be read",
    Holdco: "hold",
  });
  // The read is blind: the prompt never carries the stored figure.
  expect(prompts.some((p) => p.includes("$3 billion"))).toBe(false);

  await replayMoneyRules(handle, { apply: true, reground: { read, generate } });
  const rows = await handle.select().from(schema.fundingRounds);
  const by = (name: string) => rows.find((r) => r.companyId === name.toLowerCase()) as (typeof rows)[number];
  expect(by("Keepco")).toMatchObject({ valuationAsWritten: "$8 billion", disposition: "review" });
  expect(by("Keepco").valuationClaims?.[0]?.quote).toContain("$8 billion valuation");
  expect(by("Fixco")).toMatchObject({ valuationAsWritten: "$4 billion", disposition: "review" });
  expect(by("Blankco")).toMatchObject({ valuationAsWritten: null });
  expect(by("Errco")).toMatchObject({ valuationAsWritten: "$1 billion" });
  expect(by("Holdco")).toMatchObject({ valuationAsWritten: "$6 billion", valuationClaims: null });
  expect((by("Holdco").verification as { notes: string[] }).notes.join(" ")).toContain("unconfirmed: only a funding database states it");
});

test("re-ground reads an 'another round' blank again too, retries a read that grounds nothing, and every blank carries its sentence", async () => {
  const handle = await testDb();
  const evidence = "Wonderco raised $600 million, months after a $650 million round at a $7 billion valuation.";
  await stored(
    handle,
    record({
      company_name: "Wonderco",
      stage: "growth",
      stage_as_written: "funding round",
      announced_date: "2025-05-06",
      amount: usd(600, "$600 million"),
      evidence_quotes: [evidence],
      sources: [{ url: "https://techcrunch.com/wonderco", host: "techcrunch.com", title: "Wonderco raises $600M" }],
      verification: { status: "confirmed", notes: [], url: null },
      confidence: 0.9,
    }),
    { valuation: "$7 billion" },
  );
  const deterministic = await replayMoneyRules(handle);
  expect(deterministic.changes[0].valuation).toMatchObject({
    action: "blank",
    reason: "it is stated for another round ($650 million)",
    quote: evidence,
  });

  const page = "Wonderco raised $600 million at a $7 billion valuation, the company said.";
  const none = { stated: false, value: null, source: null, quote: null };
  let calls = 0;
  const found = await replayMoneyRules(handle, {
    reground: {
      read: async (sources) => sources.map((s) => ({ url: s.url, host: s.host, title: s.title, markdown: page })),
      // The first read grounds nothing; the retry cites the sentence.
      generate: async () =>
        ++calls === 1
          ? { amount: none, financing_total: none, valuation: none }
          : {
              amount: none,
              financing_total: none,
              valuation: {
                stated: true,
                value: "$7 billion",
                source: "https://techcrunch.com/wonderco",
                quote: "Wonderco raised $600 million at a $7 billion valuation",
              },
            },
    },
  });
  expect(calls).toBe(2);
  expect(found.reground).toMatchObject({ tried: 1, kept: 1, blanked: 0 });
});

test("re-ground holds a page's figure that breaks a hard rule instead of taking it as a correction", async () => {
  const handle = await testDb();
  await stored(
    handle,
    record({
      company_name: "Typoco",
      announced_date: "2025-10-20",
      amount: usd(200, "$200 million"),
      evidence_quotes: ["Typoco closed a $200 million investment."],
      sources: [{ url: "https://siliconangle.com/typoco", host: "siliconangle.com", title: "Typoco closes $200M" }],
      verification: { status: "confirmed", notes: [], url: null },
      confidence: 0.9,
    }),
    { valuation: "$6.5 billion" },
  );
  const page = "Typoco is now worth $6.5 million, up from $3.5 billion following another round in July.";
  const none = { stated: false, value: null, source: null, quote: null };
  const out = await replayMoneyRules(handle, {
    reground: {
      read: async (sources) => sources.map((s) => ({ url: s.url, host: s.host, title: s.title, markdown: page })),
      generate: async () => ({
        amount: none,
        financing_total: none,
        valuation: {
          stated: true,
          value: "$6.5 million",
          source: "https://siliconangle.com/typoco",
          quote: "Typoco is now worth $6.5 million",
        },
      }),
    },
  });
  expect(out.changes[0].valuation).toMatchObject({ action: "hold" });
  expect(out.reground).toMatchObject({ corrected: 0, held: 1 });
});
