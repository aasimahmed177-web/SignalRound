// The judge's verdict is applied by a pure function, so every correction it can make is tested
// without a network: a stated stage or amount replaces the record's, an unstated amount leaves, a
// stated day outranks a borrowed one, the page's leads are the leads, non-investors leave, and a
// page that recalls the round as history marks the record not news.

import type { Firecrawl } from "firecrawl";
import { describe, expect, test } from "vitest";
import type { FeedRecord } from "../records/schema.ts";
import { applyVerdict, judgePrompt, judgeRecords, primarySource, type Verdict } from "./judge.ts";

const RATES = { date: "2026-09-02", perUsd: { EUR: 0.86, GBP: 0.74 } };

function record(over: Partial<FeedRecord> = {}): FeedRecord {
  return {
    id: "acme:series_a:2026-09-02",
    company_key: "acme",
    company_name: "Acme",
    company_domain: "acme.com",
    company_website: "https://acme.com",
    company_description: "an invoicing platform",
    stage: "series_a",
    stage_as_written: "Series A",
    is_extension: false,
    amount: { value: 20, currency: "USD", as_written: "$20M", usd_millions: 20, fx_rate: 1, fx_date: "2026-09-02" },
    valuation_as_written: null,
    lead_investors: ["Sequoia Capital"],
    other_investors: ["Index Ventures", "Plaid"],
    announced_date: "2026-09-02",
    date_precision: "day",
    date_basis: "page",
    headquarters: "New York, USA",
    sector: "fintech",
    evidence_quotes: ["Acme raised $20M in Series A funding led by Sequoia Capital."],
    sources: [
      { url: "https://newsletter.example/issue", host: "newsletter.example", title: "Issue 12", query: "corroborate" },
      { url: "https://techcrunch.com/2026/09/02/acme", host: "techcrunch.com", title: "Acme raises $20M", query: "acme series a" },
    ],
    confidence: 0.8,
    undated: false,
    ...over,
  } as FeedRecord;
}

const CONFIRMING: Verdict = {
  is_announcement: "yes",
  company_matches: true,
  stage: { stated: true, page_value: "Series A" },
  amount: { stated: true, page_value: "$20 million" },
  announced_date: { stated: true, page_value: "2026-09-02" },
  investors: { page_leads: ["Sequoia Capital"], page_participants: ["Index Ventures", "Plaid"], not_this_round: [] },
  notes: "matches",
};

describe("applyVerdict", () => {
  test("a record the page confirms is confirmed and unchanged", () => {
    const r = applyVerdict(record(), CONFIRMING, "https://techcrunch.com/2026/09/02/acme", { rates: RATES });
    expect(r.verification?.status).toBe("confirmed");
    expect(r.amount.as_written).toBe("$20M");
    expect(r.lead_investors).toEqual(["Sequoia Capital"]);
    expect(r.other_investors).toEqual(["Index Ventures", "Plaid"]);
  });

  test("an unstated amount leaves; a differently stated amount, stage, and date replace the record's", () => {
    const r = applyVerdict(
      record(),
      {
        ...CONFIRMING,
        stage: { stated: true, page_value: "Seed" },
        amount: { stated: true, page_value: "$3.3 million" },
        announced_date: { stated: true, page_value: "2026-09-01" },
        notes: "the record carried the earlier pre-seed",
      },
      "u",
      { rates: RATES },
    );
    expect(r.verification?.status).toBe("corrected");
    expect(r.stage).toBe("seed");
    expect(r.stage_as_written).toBe("Seed");
    expect(r.amount.as_written).toBe("$3.3 million");
    expect(r.amount.usd_millions).toBe(3.3);
    expect(r.announced_date).toBe("2026-09-01");
    expect(r.date_precision).toBe("day");
    expect(r.verification?.notes.join(" | ")).toContain("stage Series A read as Seed");
    const gone = applyVerdict(record(), { ...CONFIRMING, amount: { stated: false, page_value: null } }, "u", { rates: RATES });
    expect(gone.amount.as_written).toBeNull();
    expect(gone.amount.usd_millions).toBeNull();
    expect(gone.verification?.status).toBe("corrected");
  });

  test("the page's lists correct the record's: a lead the page names joins, a lead it calls a participant is demoted, a name it places outside the round leaves, a name it never mentions stays", () => {
    const r = applyVerdict(
      record({
        lead_investors: ["Cincinnati Children's"],
        other_investors: ["Plaid", "Sazze Partners", "Stonebridge Ventures", "500 Global", "Acme Angels"],
      }),
      {
        ...CONFIRMING,
        investors: {
          page_leads: ["Sazze Partners"],
          page_participants: ["Cincinnati Children's", "Stonebridge"],
          not_this_round: ["Plaid", "500 Global"],
        },
        notes: "Sazze led; Plaid is where an angel works; 500 Global is an earlier backer",
      },
      "u",
      { rates: RATES },
    );
    expect(r.lead_investors).toEqual(["Sazze Partners"]);
    // Acme Angels is not on the page: unknown, so it keeps its seat (Xsight's Fidelity was removed for being absent).
    expect(r.other_investors.sort()).toEqual(["Acme Angels", "Cincinnati Children's", "Stonebridge Ventures"]);
    expect(r.verification?.status).toBe("corrected");
    const notes = r.verification?.notes.join(" | ") ?? "";
    expect(notes).toContain("not investors in this round: Plaid, 500 Global");
    expect(notes).toContain("not leads: Cincinnati Children's");
    // A page that names no investors at all leaves the record's lists alone rather than emptying them.
    const silent = applyVerdict(
      record(),
      { ...CONFIRMING, investors: { page_leads: [], page_participants: [], not_this_round: [] } },
      "u",
      { rates: RATES },
    );
    // A lead the page never mentions stays a lead; the page's silence is not a demotion.
    const absentLead = applyVerdict(
      record({ lead_investors: ["Fidelity"], other_investors: ["Sequoia Capital"] }),
      { ...CONFIRMING, investors: { page_leads: [], page_participants: ["Sequoia Capital"], not_this_round: [] } },
      "u",
      { rates: RATES },
    );
    expect(absentLead.lead_investors).toEqual(["Fidelity"]);
    expect(absentLead.verification?.status).toBe("confirmed");
    expect(silent.lead_investors).toEqual(["Sequoia Capital"]);
    expect(silent.other_investors).toEqual(["Index Ventures", "Plaid"]);
  });

  test("the page's names pass investor hygiene before they merge: a managed-funds phrase lands as the firm, a placeholder not at all", () => {
    const r = applyVerdict(
      record(),
      {
        ...CONFIRMING,
        investors: { page_leads: [], page_participants: ["funds managed by Acme Capital", "undisclosed investors"], not_this_round: [] },
      },
      "u",
      { rates: RATES },
    );
    expect(r.other_investors).toContain("Acme Capital");
    expect(r.other_investors).not.toContain("funds managed by Acme Capital");
    expect(r.other_investors).not.toContain("undisclosed investors");
  });

  test("a page that recalls the round as history, or is not about a round, marks the record not news; a namesake contradicts", () => {
    expect(applyVerdict(record(), { ...CONFIRMING, is_announcement: "history" }, "u", { rates: RATES }).verification?.status).toBe(
      "not_news",
    );
    expect(applyVerdict(record(), { ...CONFIRMING, is_announcement: "not_a_round" }, "u", { rates: RATES }).verification?.status).toBe(
      "not_news",
    );
    expect(applyVerdict(record(), { ...CONFIRMING, company_matches: false }, "u", { rates: RATES }).verification?.status).toBe(
      "contradicted",
    );
  });

  test("a list page's own date handed back is no sharpening; a different day the page states for the round is; an amount within 5 percent is not a correction", () => {
    // The record took the roundup's date at week precision; the judge echoing that date says nothing new.
    const echoed = applyVerdict(
      record({ date_precision: "week", date_basis: "page" }),
      { ...CONFIRMING, amount: { stated: true, page_value: "$20.5M" } },
      "https://newsletter.example/issue",
      { rates: RATES },
    );
    expect(echoed.date_precision).toBe("week");
    expect(echoed.announced_date).toBe("2026-09-02");
    expect(echoed.amount.as_written).toBe("$20M");
    expect(echoed.verification?.status).toBe("confirmed");
    // A page dated the same day as the list is the list or its echo: no sharpening (Chai's month became a list's last day).
    const sameDay = applyVerdict(
      record({ date_precision: "week", date_basis: "page" }),
      CONFIRMING,
      "https://techcrunch.com/2026/09/02/acme",
      { rates: RATES },
    );
    expect(sameDay.date_precision).toBe("week");
    expect(sameDay.verification?.status).toBe("confirmed");
    // A release dated inside the week, stating its own day for the round, is the round's day.
    const fromRelease = applyVerdict(
      record({
        date_precision: "week",
        date_basis: "page",
        sources: [
          { url: "https://newsletter.example/issue", host: "newsletter.example", title: "Deals of the week", published: "2026-09-02" },
          { url: "https://techcrunch.com/2026/09/01/acme", host: "techcrunch.com", title: "Acme raises", published: "2026-09-01" },
        ],
      }),
      { ...CONFIRMING, announced_date: { stated: true, page_value: "2026-09-01" } },
      "https://techcrunch.com/2026/09/01/acme",
      { rates: RATES },
    );
    expect(fromRelease.date_precision).toBe("day");
    expect(fromRelease.announced_date).toBe("2026-09-01");
    expect(fromRelease.verification?.notes).toEqual(["date 2026-09-02 read as 2026-09-01"]);
    // A weekly or monthly list states no round's day, whatever it hands back.
    const fromList = applyVerdict(
      record({
        date_precision: "month",
        announced_date: "2026-07-31",
        date_basis: "page",
        sources: [
          {
            url: "https://blog.example/july-2026-startup-funding-roundup",
            host: "blog.example",
            title: "The Complete July 2026 Startup Funding Roundup",
            published: "2026-07-31",
          },
        ],
      }),
      { ...CONFIRMING, announced_date: { stated: true, page_value: "2026-07-31" } },
      "https://blog.example/july-2026-startup-funding-roundup",
      { rates: RATES },
    );
    expect(fromList.date_precision).toBe("month");
    expect(fromList.announced_date).toBe("2026-07-31");
    // A day the page states for the round itself, different from the page's date, is the announcement day.
    const r = applyVerdict(
      record({ date_precision: "week", date_basis: "page" }),
      { ...CONFIRMING, announced_date: { stated: true, page_value: "2026-08-28" } },
      "u",
      { rates: RATES },
    );
    expect(r.date_precision).toBe("day");
    expect(r.announced_date).toBe("2026-08-28");
    expect(r.verification?.status).toBe("corrected");
    expect(r.verification?.notes).toEqual(["date 2026-09-02 read as 2026-08-28"]);
    // A bare dollar remains USD even when the source is Australian; a prior local-dollar label is corrected.
    const au = applyVerdict(
      record({
        amount: { value: 16, currency: "AUD", as_written: "$16 million", usd_millions: 10.4, fx_rate: 1.54, fx_date: "2026-09-02" },
        sources: [{ url: "https://www.smartcompany.com.au/pearler", host: "www.smartcompany.com.au", title: "Pearler raises" }],
      }),
      { ...CONFIRMING, amount: { stated: true, page_value: "$16 million" } },
      "https://www.smartcompany.com.au/pearler",
      { rates: RATES },
    );
    expect(au.amount.currency).toBe("USD");
    expect(au.verification?.status).toBe("corrected");
  });

  test("primarySource skips corroboration sources; the prompt carries the record", () => {
    expect(primarySource(record())).toBe("https://techcrunch.com/2026/09/02/acme");
    expect(primarySource(record({ sources: [] }))).toBeNull();
    expect(judgePrompt(record())).toContain('"stage":"Series A"');
  });
});

describe("judgeRecords", () => {
  test("reads each record's primary page with the json format, tallies verdicts, and marks unreadable pages skipped", async () => {
    const calls: string[] = [];
    const client = {
      scrape: async (url: string) => {
        calls.push(url);
        if (url.includes("broken")) throw new Error("timeout");
        return { json: { ...CONFIRMING, amount: { stated: false, page_value: null } } };
      },
    } as unknown as Firecrawl;
    const records = [
      record(),
      record({
        id: "beta:seed:2026-09-01",
        company_name: "Beta",
        sources: [{ url: "https://broken.example/x", host: "broken.example", title: "x" }],
      }),
      record({ id: "gamma:seed:2026-09-01", company_name: "Gamma", sources: [] }),
    ];
    const r = await judgeRecords(client, records, { rates: RATES });
    expect(calls).toEqual(["https://techcrunch.com/2026/09/02/acme", "https://broken.example/x"]);
    expect(r.judged).toBe(1);
    expect(r.corrected).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.creditsEstimated).toBe(10);
    expect(r.records.map((x) => x.verification?.status)).toEqual(["corrected", "skipped", "skipped"]);
    expect(r.records[0].amount.as_written).toBeNull();
  });
});
