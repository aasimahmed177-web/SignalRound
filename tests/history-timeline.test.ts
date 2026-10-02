process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import {
  canonicalUrl,
  corroborationQuery,
  dossierSearchQuery,
  historyQuery,
  knownRound,
  matchPriorRound,
  priorAsKnown,
  priorKey,
} from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { describe, expect, test } from "vitest";
import { knownRounds } from "../lib/apollo";
import { requestTally } from "../lib/company-requests";
import { firecrawlHistoryReader, promotePrior, queueCompanyHistory } from "../lib/history";
import { persistRecords } from "../lib/persist";
import { leadsFromCandidate, queueCompanyTimeline, queueFundingSearch, TIMELINE_LEADS, TIMELINE_PAGES } from "../lib/request-research";
import {
  CORGI_A,
  CORGI_B,
  CORGI_B1,
  CORGI_FORM_D,
  CORGI_JULY,
  CORGI_SEPTEMBER,
  corgiCandidates,
  corgiPages,
} from "./corgi-history-fixtures";
import { record, testDb } from "./helpers";
import { dossier, reader } from "./history-fixtures";

const NOW = new Date("2026-09-27T00:00:00Z");
const prior = (stage: string, amount: string | null, date: string | null) => ({
  stage_as_written: stage,
  amount_as_written: amount,
  announced_date: date,
  lead_investors: [],
});

describe("history identity", () => {
  test("similar amounts on different stages are not duplicates without nearby dates", () => {
    const a = priorAsKnown(prior("Series A", "$108M", "2026-01-09"));
    expect(knownRound(priorAsKnown(prior("Series B1", "$106M", "2026-05-28")), [a])).toBe(false);
    expect(knownRound(priorAsKnown(prior("Seed", "$108M", "2026-01")), [a])).toBe(true);
    expect(knownRound(priorAsKnown(prior("Seed", "$108M", null)), [a])).toBe(false);
  });

  test("separate extensions with an undisclosed amount do not disappear into an earlier Series B", () => {
    const b = priorAsKnown(prior("Series B", "$160M", "2026-05-07"));
    const b1 = priorAsKnown(prior("Series B1", "$106M", "2026-05-28"));
    const july = priorAsKnown(prior("Series B extension", null, "2026-07-23"));
    expect(knownRound(b1, [b])).toBe(false);
    expect(knownRound(july, [b, b1])).toBe(false);
    expect(knownRound(priorAsKnown(prior("Series B extension", "$64M", "2026-09-26")), [july])).toBe(false);
    expect(knownRound(priorAsKnown(prior("Series B-2", null, "2026-07-23")), [b1])).toBe(false);
    expect(knownRound(priorAsKnown(prior("Series B-2", "$106M", "2026-06-01")), [b1])).toBe(false);
  });

  test("an incorrect Apollo stage is a note when amount and date identify the announcement", () => {
    const company = { name: "Corgi", nameKey: "corgi", domain: "corgi.insure" };
    const a = record({
      company_name: "Corgi",
      stage: "series_a",
      announced_date: "2026-01-09",
      amount: { value: 108, currency: "USD", as_written: "$108M", usd_millions: 108, fx_rate: 1, fx_date: null },
    });
    expect(matchPriorRound(prior("Seed", "$124M", "2026-01-08"), a, company)).toMatchObject({
      ok: true,
      evidence: expect.arrayContaining(["amount", "stage label differs; announcement wins"]),
    });
    expect(matchPriorRound(prior("Seed", "$130K", "2026-01-08"), a, company)).toEqual({ ok: false, reason: "amount" });
    expect(matchPriorRound(prior("Seed", null, "2026-01-08"), a, company)).toMatchObject({ ok: true });
    expect(matchPriorRound(prior("Seed", "$108M", "2024-01-08"), a, company)).toEqual({ ok: false, reason: "date" });
    expect(matchPriorRound(prior("Series B1", "$106M", null), a, company)).toEqual({ ok: false, reason: "weak" });
  });
});

test("all three recovery queries use the clean brand and the domain fallback", () => {
  for (const [name, expected] of [
    ["Resend · Email for developers", "Resend"],
    ["Home", "resend.com"],
  ]) {
    const company = { name, nameKey: "resend", domain: "resend.com", website: null, description: null, hq: null, sector: null };
    expect(historyQuery(company, prior("Series A", "$18M", "2024"))).toMatch(new RegExp(`^"${expected}"`));
    expect(
      corroborationQuery({ company_name: name, company_domain: company.domain, stage_as_written: "Series A", amount_as_written: "$18M" }),
    ).toMatch(new RegExp(`^"${expected}"`));
    expect(dossierSearchQuery(company)).toBe(`"${expected}" resend.com`);
  }
});

test("Corgi snippets retain each round and never mistake July's valuation for its raise", () => {
  const company = { name: "Corgi", domain: "corgi.insure" };
  expect(leadsFromCandidate(corgiCandidates[2], company).map((l) => [l.type, l.amount])).toEqual([
    ["Series B1", "$106 million"],
    ["Series B", "$160 million"],
    ["Series A", "$108 million"],
  ]);
  expect(leadsFromCandidate(corgiCandidates[3], company)[0]).toMatchObject({
    type: "second extension of its Series B round",
    amount: null,
    date: "2026-07-23",
  });
  expect(
    leadsFromCandidate({ url: "https://corgi.insure/blog/b2", title: "Corgi raises $80M Series B-2", via: "site" }, company)[0],
  ).toMatchObject({ type: "Series B-2", amount: "$80M" });
});

test("Corgi verifies A and B1 without duplicates and retains July's reported round", async () => {
  const handle = await testDb();
  const current = record({
    company_name: "Corgi",
    company_domain: "corgi.insure",
    stage: "series_b",
    stage_as_written: "Series B extension",
    is_extension: true,
    announced_date: "2026-09-26",
    amount: { value: 64, currency: "USD", as_written: "$64M", usd_millions: 64, fx_rate: 1, fx_date: null },
    sources: [
      { url: CORGI_SEPTEMBER, host: "forbes.com", title: "Corgi Is Now Worth $5 Billion Thanks To Four Funding Rounds In Five Months" },
    ],
    evidence_quotes: ["Corgi has closed another round that pushed the company's valuation up to $5 billion."],
  });
  await persistRecords(handle, [current], "series-a-b", "feed");
  const [stored] = await handle.select().from(schema.fundingRounds);
  const companyId = stored.companyId;
  await handle.insert(schema.companyAliases).values({ companyId, kind: "domain", aliasKey: "corgi.com", alias: "corgi.com" });
  const b = record({
    ...current,
    id: "corgi:series_b:2026-05-07",
    announced_date: "2026-05-07",
    stage_as_written: "Series B",
    is_extension: false,
    amount: { value: 160, currency: "USD", as_written: "$160M", usd_millions: 160, fx_rate: 1, fx_date: null },
    sources: [{ url: CORGI_B, host: "corgi.insure", title: corgiCandidates[1].title }],
  });
  await persistRecords(handle, [b], "series-a-b", "earlier-feed");
  const filing = record({
    ...current,
    id: "corgi:other:2026-09-04",
    stage: "other",
    stage_as_written: "Form D (equity)",
    is_extension: false,
    announced_date: "2026-09-04",
    amount: { value: 16.2, currency: "USD", as_written: "$16.2M", usd_millions: 16.2, fx_rate: 1, fx_date: null },
    evidence_quotes: ["Sale 2026-08-21 (20.0 M Offered, 16.2 M Sold). Filed 2026-09-04 (D)."],
    sources: [{ url: CORGI_FORM_D, host: "aum13f.com", title: "Corgi Insurance Services Inc" }],
  });
  await persistRecords(handle, [filing], "form-d", "filing", { startIn: "review" });
  const apollo = prior("Seed", "$108M", "2026-01-09");
  await handle
    .insert(schema.historyPromotions)
    .values({ companyId, priorKey: priorKey(apollo), prior: apollo, origin: "apollo", status: "no_source", outcome: { reason: "stage" } });
  expect(await knownRounds(handle, companyId)).not.toContainEqual(expect.objectContaining({ stage: "seed" }));
  const { reader: r, calls } = reader({ pages: corgiPages });
  const sites: string[] = [];
  const classified: string[] = [];
  r.search = async (query) => {
    calls.queries.push(query);
    if (query.includes("extension")) return [corgiCandidates[3]];
    if (query.includes("Series A")) return [corgiCandidates[0]];
    return [corgiCandidates[2]];
  };
  r.map = async (site) => {
    sites.push(site);
    return [corgiCandidates[1]];
  };
  r.classify = async (candidates) =>
    candidates.map((c) => {
      classified.push(c.url);
      return { isRound: 0.99, aboutRaise: 0.99, kind: "news", kindConfidence: 0.99, model: "fixture" };
    });
  const recall = await queueCompanyTimeline(handle, r, companyId, NOW);
  expect(recall.queued).toBeGreaterThanOrEqual(3);
  expect(recall.pages).toBeLessThanOrEqual(TIMELINE_PAGES);
  expect(sites).toEqual(expect.arrayContaining(["corgi.insure", "corgi.com"]));
  expect(classified).toContain(CORGI_B1);
  expect(calls.queries).toEqual(
    expect.arrayContaining(['"Corgi" raises', '"Corgi" funding', expect.stringContaining('"another extension"')]),
  );
  const checked: string[] = [];
  const verify = r.verify;
  r.verify = async (...args) => {
    checked.push(...args[0].flatMap((r) => r.sources.map((s) => s.url)));
    return verify(...args);
  };
  for (const key of await queueCompanyHistory(handle, companyId, NOW)) await promotePrior(handle, r, companyId, key, "timeline", NOW);
  const rounds = await handle.select().from(schema.fundingRounds).orderBy(schema.fundingRounds.announcedOn);
  expect(rounds.map((r) => [r.stageAsWritten, r.announcedOn])).toEqual([
    ["Series A", "2026-01-09"],
    ["Series B", "2026-05-07"],
    ["Series B1", "2026-05-28"],
    ["Series B extension", "2026-07-23"],
    ["Form D (equity)", "2026-09-04"],
    ["Series B extension", "2026-09-26"],
  ]);
  expect(checked).toEqual(expect.arrayContaining([CORGI_A, CORGI_B1]));
  expect(checked).toContain(CORGI_JULY);
  expect(rounds.filter((r) => r.history).map((r) => r.announcedOn)).toEqual(["2026-01-09", "2026-05-28", "2026-07-23"]);
  expect(rounds[0].amountUsdMillions).toBeNull();
  const leads = await handle.select().from(schema.historyPromotions).where(eq(schema.historyPromotions.companyId, companyId));
  expect(leads.find((l) => l.prior.announced_date === "2026-07-23")).toMatchObject({
    status: "promoted",
    roundId: "corgi:series_b:2026-07-23",
    prior: { source_url: CORGI_JULY },
    outcome: { verdict: "confirmed" },
  });
  const tally = await requestTally(handle, companyId);
  expect(tally.priors.find((p) => p.label.includes("2026-07-23"))).toMatchObject({ verified: true });
  expect(await queueCompanyTimeline(handle, r, companyId, NOW)).toEqual({ queued: 0, credits: 0, pages: 0 });
  expect(await queueCompanyHistory(handle, companyId, NOW)).toEqual([]);
});

test("company recall is bounded and claims prevent concurrent discovery calls", async () => {
  const handle = await testDb();
  await handle.insert(schema.companies).values({ id: "acme", name: "Acme", nameKey: "acme", domain: "acme.com" });
  const { reader: r, calls } = reader({
    search: Array.from({ length: 100 }, (_, i) => ({
      url: `https://acme.com/blog/round-${i}`,
      title: `Acme raises $${i + 1}M Series A`,
      published: `${2000 + (i % 25)}-01-01`,
      via: "search",
    })),
  });
  const results = await Promise.all([queueCompanyTimeline(handle, r, "acme", NOW), queueCompanyTimeline(handle, r, "acme", NOW)]);
  expect(results.filter((r) => r.credits > 0)).toHaveLength(1);
  expect(calls.extract).toBeLessThanOrEqual(TIMELINE_PAGES);
  expect((await handle.select().from(schema.historyPromotions)).length).toBeLessThanOrEqual(TIMELINE_LEADS);
  expect(calls.search).toBeLessThanOrEqual(7);
});

test("a company folded away mid-search ends its leads instead of failing the run", async () => {
  const handle = await testDb();
  await handle.insert(schema.companies).values({ id: "corgi", name: "Corgi", nameKey: "corgi", domain: "corgi.insure" });
  const { reader: r } = reader({ search: [corgiCandidates[2]] });
  r.classify = async (candidates) => {
    await handle.delete(schema.companies).where(eq(schema.companies.id, "corgi"));
    return candidates.map(() => ({ isRound: 0.99, aboutRaise: 0.99, kind: "news", kindConfidence: 0.99, model: "fixture" }));
  };
  expect(await queueFundingSearch(handle, r, "corgi", NOW)).toMatchObject({ queued: 0 });
  expect(await handle.select().from(schema.historyPromotions)).toEqual([]);
});

test("a failed timeline claim is retryable rather than suppressing the company for a week", async () => {
  const handle = await testDb();
  await handle.insert(schema.companies).values({ id: "acme", name: "Acme", nameKey: "acme", domain: "acme.com" });
  const { reader: r } = reader();
  r.search = async () => {
    throw new Error("search unavailable");
  };
  await expect(queueCompanyTimeline(handle, r, "acme", NOW)).rejects.toThrow("search unavailable");
  r.search = async () => [];
  expect(await queueCompanyTimeline(handle, r, "acme", NOW)).toMatchObject({ credits: 9 });
  const [run] = await handle.select().from(schema.runs).where(eq(schema.runs.id, "history-timeline:acme"));
  expect(run.finishedAt).not.toBeNull();
});

test("a new announcement revives a failed search even when the dossier repeats the hint", async () => {
  const handle = await testDb();
  await handle.insert(schema.companies).values({ id: "corgi", name: "Corgi", nameKey: "corgi", domain: "corgi.insure" });
  const p = { ...prior("Series B1", "$106 million", "2026-05-28"), source_url: "https://corgi.insure/blog/old-link" };
  await handle.insert(schema.enrichments).values({ companyId: "corgi", kind: "deep_dive", data: dossier([p]) });
  await handle.insert(schema.historyPromotions).values({ companyId: "corgi", priorKey: priorKey(p), prior: p, status: "no_source" });
  const { reader: r } = reader({ search: [corgiCandidates[2]] });
  expect(await queueFundingSearch(handle, r, "corgi", NOW)).toMatchObject({ queued: 3 });
  const rows = await handle.select().from(schema.historyPromotions);
  expect(rows.find((r) => r.priorKey === priorKey(p))).toMatchObject({ status: "pending", prior: { source_url: CORGI_B1 } });
  expect(await queueFundingSearch(handle, r, "corgi", NOW)).toMatchObject({ queued: 0 });
});

test("earlier rounds named only inside a feed article are leads, and require their own announcement", async () => {
  const handle = await testDb();
  const b1 = record({
    company_name: "Corgi",
    company_domain: "corgi.insure",
    stage: "series_b",
    stage_as_written: "Series B1",
    announced_date: "2026-05-28",
    amount: { value: 106, currency: "USD", as_written: "$106M", usd_millions: 106, fx_rate: 1, fx_date: null },
    evidence_quotes: [corgiPages[CORGI_B1][0].round.evidence_quote],
    sources: [{ url: CORGI_B1, host: "techcrunch.com", title: "Corgi announces $106M raise" }],
  });
  await persistRecords(handle, [b1], "series-a-b", "feed");
  const { reader: r } = reader({
    pages: {
      ...corgiPages,
      [canonicalUrl(CORGI_B1)]: [
        ...corgiPages[CORGI_B1],
        {
          ...corgiPages[CORGI_A][0],
          source: corgiPages[CORGI_B1][0].source,
          round: { ...corgiPages[CORGI_A][0].round, is_background: true },
        },
      ],
    },
  });
  expect(await queueCompanyTimeline(handle, r, "corgi.insure", NOW)).toMatchObject({ queued: 1 });
  const [key] = await queueCompanyHistory(handle, "corgi.insure", NOW);
  expect(key).toBe("series a||2026-01-09");
  r.search = async () => [corgiCandidates[0]];
  const verified = r.verify;
  r.verify = async (...args) => {
    expect(args[0][0].sources.map((s) => s.url)).toEqual([CORGI_A]);
    return verified(...args);
  };
  expect(await promotePrior(handle, r, "corgi.insure", key, "history", NOW)).toMatchObject({ status: "promoted" });
  const [ledger] = await handle.select().from(schema.historyPromotions);
  expect(ledger.sourceUrl).toBe(CORGI_A);
});

test("the history reader requests and preserves query-relevant highlights", async () => {
  const client = {
    search: async (_query: string, options: { highlights?: boolean }) => {
      expect(options.highlights).toBe(true);
      return {
        web: [{ url: CORGI_B1, title: "Corgi raises $106M", description: "Series B1", highlights: "Earlier $108 million Series A" }],
      };
    },
  } as unknown as Firecrawl;
  const found = await firecrawlHistoryReader(client).search("Corgi funding", 10);
  expect(found[0].description).toBe("Series B1 Earlier $108 million Series A");
});
