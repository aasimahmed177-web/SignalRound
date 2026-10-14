// Starling's £50 million extension from Goldman Sachs (April 2021) arrived six weeks after its £272 million
// Series D, read as a Series D tranche of a £322 million total. It was taken for the Series D itself, and
// its amount replaced the first close's.

import type { FeedRecord } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { describe, expect, test } from "vitest";
import { isSameRound, persistRecords } from "../lib/persist";
import { record, testDb } from "./helpers";

const gbp = (value: number, fx = 1.38): FeedRecord["amount"] => ({
  value,
  currency: "GBP",
  as_written: `£${value} million`,
  usd_millions: Math.round(value * fx * 1000) / 1000,
  fx_rate: fx,
  fx_date: null,
});

const seriesD = record({
  company_name: "Starling Bank",
  company_domain: "starlingbank.com",
  stage: "series_d_plus",
  stage_as_written: "Series D",
  amount: gbp(272),
  announced_date: "2021-03-08",
  lead_investors: ["Fidelity Management & Research Company"],
  sources: [{ url: "https://www.starlingbank.com/news/starling-announces-272m-funding-round-march-2021", host: "starlingbank.com" }],
});

const extension = record({
  company_name: "Starling Bank",
  company_domain: "starlingbank.com",
  stage: "series_d_plus",
  stage_as_written: "Series D",
  amount: gbp(50),
  amount_scope: "tranche",
  financing_total_as_written: "£322 million",
  financing_total_quote: "This takes the total raised in the Series D round to £322 million.",
  announced_date: "2021-04-19",
  lead_investors: ["Goldman Sachs Growth Equity"],
  sources: [{ url: "https://www.starlingbank.com/news/goldman-sachs-invests-50m-in-starling-bank", host: "starlingbank.com" }],
});

describe("an extension read as a tranche of its series", () => {
  test("is its own round beside the series' first close, which keeps its amount", async () => {
    const db = await testDb();
    await persistRecords(db, [seriesD], "growth", "run-1");
    await persistRecords(db, [extension], "growth", "history-1", { history: true });
    const rows = (await db.select().from(schema.fundingRounds)).sort((a, b) => String(a.announcedOn).localeCompare(String(b.announcedOn)));
    expect(rows.map((r) => [r.announcedOn, r.amountAsWritten])).toEqual([
      ["2021-03-08", "£272 million"],
      ["2021-04-19", "£50 million"],
    ]);
  });
});

describe("two closes of one financing", () => {
  const first = { stage: "series_d_plus", announcedOn: "2021-03-08", amountValue: 272, amountCurrency: "GBP", amountUsdMillions: 375 };
  const second = {
    stage: "series_d_plus",
    announcedOn: "2021-04-19",
    amountValue: 50,
    amountCurrency: "GBP",
    amountUsdMillions: 69,
    financingTotalAsWritten: "£322 million",
  };

  test("are two rounds when one states the total both add up to", () => {
    expect(isSameRound(first, second)).toBe(false);
    expect(isSameRound(second, first)).toBe(false);
  });

  test("a close reported twice is still one round", () => {
    expect(isSameRound(second, { ...second, announcedOn: "2021-04-20", financingTotalAsWritten: null })).toBe(true);
  });
});

describe("separate closes of one series are not merged", () => {
  const usd = (stage: string, written: string, on: string, m: number, extra: object = {}) => ({
    stage,
    stageAsWritten: written,
    announcedOn: on,
    datePrecision: "day",
    amountValue: m,
    amountCurrency: "USD",
    amountUsdMillions: m,
    ...extra,
  });

  test("Grab: Yamaha's $150 million five weeks after Hyundai's $250 million in the Series H", () => {
    expect(isSameRound(usd("series_d_plus", "Series H", "2018-11-06", 250), usd("series_d_plus", "Series H", "2018-12-13", 150))).toBe(
      false,
    );
  });

  test("SpaceX: August's $250 million, dated to its month, beside June's $1.68 billion of a stated $2 billion", () => {
    const june = usd("other", "funding round", "2022-06-13", 1680, { financingTotalAsWritten: "$2 billion" });
    const august = usd("other", "equity round", "2022-07-01", 250, { datePrecision: "month" });
    expect(isSameRound(june, august)).toBe(false);
  });

  test("PhonePe: Walmart's $200 million a month after a $100 million tranche, and two $100 million tranches with different totals", () => {
    const feb = usd("other", "additional funding tranche", "2023-02-14", 100, { financingTotalAsWritten: "$450 million" });
    expect(isSameRound(feb, usd("other", "additional funding", "2023-03-17", 200))).toBe(false);
    const apr = usd("other", "additional funding", "2023-04-12", 100, { financingTotalAsWritten: "$750 million" });
    const may = usd("other", "additional funding", "2023-05-22", 100, { financingTotalAsWritten: "$850 million" });
    expect(isSameRound(apr, may)).toBe(false);
  });

  test("Razorpay: a $2.5 million seed and a $9 million Series A announced the same day", () => {
    expect(isSameRound(usd("seed", "seed", "2015-10-27", 2.5), usd("series_a", "Series A", "2015-10-27", 9))).toBe(false);
  });

  test("one round reported twice still matches: a day later with the same figure, or relabelled with a close figure", () => {
    expect(isSameRound(usd("series_d_plus", "Series H", "2018-11-06", 250), usd("series_d_plus", "Series H", "2018-11-07", 250))).toBe(
      true,
    );
    expect(isSameRound(usd("seed", "seed", "2015-10-27", 9), usd("series_a", "Series A", "2015-10-28", 9.2))).toBe(true);
    expect(isSameRound(usd("series_b", "Series B", "2026-09-01", 100), usd("series_b", "Series B", "2026-09-20", 104))).toBe(true);
  });
});
