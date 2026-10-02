import { describe, expect, test } from "vitest";
import { groundQuotedPage, QuotedPage } from "./reader.ts";

const markdown =
  "# Atlas raises $15 million Series A\nSeptember 24, 2026\nAtlas raised $15 million Series A led by Acme Ventures, with participation from Beta Capital. The company was valued at $90 million post-money.";
const sentence = "Atlas raised $15 million Series A led by Acme Ventures, with participation from Beta Capital.";
const page = QuotedPage.parse({
  page_kind: "press_release",
  page_date: "2026-09-24",
  rounds: [
    {
      company_name: "Atlas",
      company_website: null,
      company_description: null,
      round_type_as_written: "Series A",
      amount_as_written: "$15 million",
      amount_kind: "round",
      amount_scope: "round",
      financing_total_as_written: null,
      financing_total_quote: null,
      valuation_as_written: "$90 million",
      valuation_quote: "The company was valued at $90 million post-money.",
      debt_quote: null,
      lead_investors: ["Acme Ventures"],
      other_investors: ["Beta Capital"],
      announced_date: "2026-09-24",
      headquarters: null,
      sector: null,
      evidence_quote: sentence,
      source_url: null,
      is_background: false,
      is_rumor: false,
      field_quotes: {
        company: sentence,
        website: null,
        description: null,
        stage: sentence,
        amount: sentence,
        financing_total: null,
        valuation: "The company was valued at $90 million post-money.",
        date: "September 24, 2026",
        headquarters: null,
        sector: null,
        lead_investors: [{ name: "Acme Ventures", quote: sentence }],
        other_investors: [{ name: "Beta Capital", quote: sentence }],
      },
    },
  ],
});

describe("groundQuotedPage", () => {
  test("keeps grounded claims with separate investor citations", () => {
    const result = groundQuotedPage(page, markdown);
    expect(result?.rounds[0]).toMatchObject({
      company_name: "Atlas",
      amount_as_written: "$15 million",
      valuation_as_written: "$90 million",
      lead_investors: ["Acme Ventures"],
      other_investors: ["Beta Capital"],
    });
    expect(result?.rounds[0]).not.toHaveProperty("field_quotes");
  });

  test("abstains on unsupported money and investors without losing a supported round", () => {
    const candidate = structuredClone(page);
    candidate.rounds[0].amount_as_written = "$50 million";
    candidate.rounds[0].field_quotes.amount = sentence;
    candidate.rounds[0].other_investors = ["Invented Capital"];
    candidate.rounds[0].field_quotes.other_investors = [{ name: "Invented Capital", quote: sentence }];
    expect(groundQuotedPage(candidate, markdown)?.rounds[0]).toMatchObject({
      amount_as_written: null,
      amount_kind: "unknown",
      other_investors: [],
    });
  });

  test("rejects an ungrounded round evidence sentence", () => {
    const candidate = structuredClone(page);
    candidate.rounds[0].evidence_quote = "Atlas supposedly raised billions according to this fabricated sentence";
    expect(groundQuotedPage(candidate, markdown)?.rounds).toEqual([]);
  });

  test("a participant cannot become a lead just because another investor led the same sentence", () => {
    const candidate = structuredClone(page);
    candidate.rounds[0].lead_investors = ["Beta Capital"];
    candidate.rounds[0].field_quotes.lead_investors = [{ name: "Beta Capital", quote: "with participation from Beta Capital." }];
    expect(groundQuotedPage(candidate, markdown)?.rounds[0].lead_investors).toEqual([]);
  });
});
