import { describe, expect, test } from "vitest";
import { implausibleReading, onlyFromLists, type StoredRound, stageRegression } from "./plausibility.ts";

const OPENAI: StoredRound[] = [
  { stage: "other", announcedOn: "2024-10-02", amountUsdMillions: 6600, verified: true },
  { stage: "other", announcedOn: "2025-03-31", amountUsdMillions: 40000, verified: true },
];

const reading = (over: Partial<Parameters<typeof implausibleReading>[0]> = {}) => ({
  stage: "series_a" as const,
  stage_as_written: "Series A",
  announced_date: "2026-09-23",
  date_precision: "day" as const,
  sources: [{ url: "https://news.crunchbase.com/venture/megaround-seriesa-ai-chips-robotics-2026", host: "news.crunchbase.com" }],
  amount: { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null },
  ...over,
});

describe("stageRegression", () => {
  test("the OpenAI case: a Series A after verified billion-dollar rounds falls below them", () => {
    expect(stageRegression(reading(), OPENAI)?.amountUsdMillions).toBe(40000);
  });

  test("a later stage, an earlier verified round, or an unverified one is no regression", () => {
    const known: StoredRound[] = [{ stage: "series_c", announcedOn: "2025-01-10", amountUsdMillions: 80, verified: true }];
    expect(stageRegression(reading({ stage: "series_b" }), known)?.stage).toBe("series_c");
    expect(stageRegression(reading({ stage: "series_d_plus" }), known)).toBeNull();
    expect(stageRegression(reading({ stage: "series_c" }), known)).toBeNull();
    // A round after the reading's day is not before it; an unverified one is not the company's history.
    expect(stageRegression(reading({ announced_date: "2024-06-01" }), known)).toBeNull();
    expect(stageRegression(reading(), [{ ...known[0], verified: false } as StoredRound])).toBeNull();
    // Debt and "other" readings have no rank to fall below anything.
    expect(stageRegression(reading({ stage: "debt" }), OPENAI)).toBeNull();
  });
});

describe("implausibleReading", () => {
  test("no amount and below verified history: review, with the reason", () => {
    expect(implausibleReading(reading(), OPENAI)).toBe("a Series A with no amount after a verified other round of $40000M on 2025-03-31");
  });

  test("a stated figure stands on its own: Groq's real Series A after its lettering restarted", () => {
    const groq: StoredRound[] = [{ stage: "series_d_plus", announcedOn: "2024-08-05", amountUsdMillions: 640, verified: true }];
    const withAmount = reading({
      amount: { value: 350, currency: "USD", as_written: "$350 million", usd_millions: 350, fx_rate: 1, fx_date: "2026-09-01" },
    });
    expect(implausibleReading(withAmount, groq)).toBeNull();
    expect(implausibleReading(reading(), groq)).not.toBeNull();
  });

  test("no amount and known only from a weekly or monthly list: review; a dated article is not held", () => {
    expect(onlyFromLists(reading({ date_precision: "week" }))).toBe(true);
    expect(implausibleReading(reading({ date_precision: "week" }), [])).toBe("a Series A with no amount, known only from a list");
    expect(implausibleReading(reading({ date_precision: "month" }), [])).not.toBeNull();
    expect(implausibleReading(reading(), [])).toBeNull();
    const twoSources = reading({
      date_precision: "week",
      sources: [
        { url: "https://a.example/week", host: "a.example" },
        { url: "https://acme.com/news/series-a", host: "acme.com" },
      ],
    });
    expect(implausibleReading(twoSources, [])).toBeNull();
  });
});
