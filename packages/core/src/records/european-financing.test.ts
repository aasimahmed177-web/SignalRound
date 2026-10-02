import { describe, expect, test } from "vitest";
import { financingTotalMatches } from "./financing.ts";
import { cleanInvestors, dedupeInvestorNames, investorMentions } from "./investors.ts";
import { moneyKindFromSentence } from "./money-kind.ts";
import { classifyStage, normalizeInvestorKey, parseAmount } from "./normalize.ts";
import { amountInEvidence, groundInvestorsOnListPage, resolveRounds } from "./resolve.ts";
import type { ExtractedRound } from "./schema.ts";

function resolve(figure: string, evidence: string, label = "seed") {
  const round: ExtractedRound = {
    company_name: "Acme",
    company_website: null,
    company_description: "software startup",
    round_type_as_written: label,
    amount_as_written: figure,
    amount_kind: "round",
    valuation_as_written: null,
    lead_investors: [],
    other_investors: [],
    announced_date: "2026-09-25",
    headquarters: null,
    sector: null,
    evidence_quote: evidence,
    source_url: null,
    is_background: false,
    is_rumor: false,
  };
  return resolveRounds([{ round, source: { url: "https://example.org/acme-financing", host: "example.org" } }], {
    stages: ["seed", "growth", "debt"],
    windowStart: new Date("2026-09-01"),
    now: new Date("2026-09-29"),
  });
}

describe("European monetary figures", () => {
  test.each([
    ["1,7 millones de euros", 1.7],
    ["2,5 Mio. Euro", 2.5],
    ["3,2 M€", 3.2],
    ["dos millones de euros", 2],
    ["veintidós millones de euros", 22],
    ["veinte y dos millones de euros", 22],
    ["treinta y dos millones de euros", 32],
    ["un millón de euros", 1],
    ["drei Millionen Euro", 3],
    ["fünf Millionen Euro", 5],
    ["zwölf Millionen Euro", 12],
    ["einundzwanzig Millionen Euro", 21],
    ["fünfunddreißig Millionen Euro", 35],
    ["deux millions d'euros", 2],
    ["quinze millions d'euros", 15],
    ["dix-sept millions d'euros", 17],
    ["quatre-vingt-dix millions d'euros", 90],
    ["vingt et un millions d'euros", 21],
    ["trente-deux millions d'euros", 32],
    ["soixante et onze millions d'euros", 71],
    ["quatre-vingt-dix-neuf millions d'euros", 99],
    ["due milioni di euro", 2],
    ["dodici milioni di euro", 12],
    ["ventidue milioni di euro", 22],
    ["trentotto milioni di euro", 38],
    ["dois milhões de euros", 2],
    ["três milhões de euros", 3],
    ["um milhão de euros", 1],
    ["vinte e cinco milhões de euros", 25],
    ["€1.250.000", 1.25],
    ["€1.250.000,50", 1.25],
  ])("parses and grounds %s", (figure, value) => {
    expect(parseAmount(figure)).toEqual({ value, currency: "EUR" });
    expect(amountInEvidence(`€${value} million`, `La startup: ${figure}.`)).toBe(true);
    expect(amountInEvidence(figure, `The company raised €${value} million.`)).toBe(true);
    expect(amountInEvidence(figure, `The company raised €${value * 10} million.`)).toBe(false);
    expect(amountInEvidence(figure, "The company announced a round without disclosing its size.")).toBe(false);
  });

  test.each([
    ["$1,700,000", 1.7],
    ["$1,700 million", 1700],
    ["$1,700.5 million", 1700.5],
    ["$1.500 million", 1.5],
    ["$1.5 billion", 1500],
    ["another two million dollars", 2],
  ])("preserves English figure %s", (figure, value) => {
    expect(parseAmount(figure)).toEqual({ value, currency: "USD" });
  });

  test("grounding requires the same monetary magnitude, not a word or an unrelated digit", () => {
    expect(amountInEvidence("dos millones de euros", "Raised €3 million.")).toBe(false);
    expect(amountInEvidence("€1.7 million", "Raised 1,7 millones de euros.")).toBe(true);
    expect(amountInEvidence("€17 million", "Raised 1,7 millones de euros.")).toBe(false);
    expect(amountInEvidence("$10 billion", "Raised $10 million.")).toBe(false);
    expect(amountInEvidence("€2 million", "Founded in 2002 with 2 employees.")).toBe(false);
  });

  test("a plus qualifier preserves the figure and scale for parsing and grounding", () => {
    expect(parseAmount("₹250+ crore")).toEqual({ value: 2500, currency: "INR" });
    expect(amountInEvidence("Rs 250 crore", "Hughes raised ₹250+ crore in primary and secondary investment.")).toBe(true);
    expect(amountInEvidence("Rs 250 million", "Hughes raised ₹250+ crore in primary and secondary investment.")).toBe(false);
  });

  test.each(["ciento veinte millones de euros", "cent vingt millions d'euros", "one hundred twenty million euros"])(
    "does not silently parse the trailing number in an unsupported composite: %s",
    (figure) => {
      expect(parseAmount(figure).value).toBeNull();
      expect(amountInEvidence("€20 million", figure)).toBe(false);
    },
  );

  test.each([
    ["1,7 millones de euros", 1.7],
    ["2,5 Mio. Euro", 2.5],
    ["3,2 M€", 3.2],
    ["dos millones de euros", 2],
    ["drei Millionen Euro", 3],
    ["deux millions d'euros", 2],
    ["due milioni di euro", 2],
    ["dois milhões de euros", 2],
  ])("retains the amount through resolution for %s", (figure, value) => {
    expect(resolve(figure, `Acme raised ${figure} in seed funding.`).kept[0]?.amount).toMatchObject({ value, currency: "EUR" });
  });
});

describe("Plus Partners and PLUS Capital are distinct investors", () => {
  test("identity keys and mention matching preserve each firm's name", () => {
    expect(normalizeInvestorKey("Plus Partners")).toBe("plus partners");
    expect(normalizeInvestorKey("PLUS Capital LLC")).toBe("plus capital");
    expect(normalizeInvestorKey("Plus Partners Fund")).toBe("plus partners");
    const mentions = investorMentions("The round was led by Plus Partners.");
    expect(mentions("Plus Partners")).toBe(true);
    expect(mentions("PLUS Capital")).toBe(false);
  });

  test("a grounded list-page investor must name the firm, not merely share Plus", () => {
    const round = {
      evidence_quote: "Acme raised €3 million in a round led by Plus Partners.",
      lead_investors: ["Plus Partners", "PLUS Capital"],
      other_investors: ["PLUS Capital"],
    } as ExtractedRound;
    expect(groundInvestorsOnListPage(round, true)).toMatchObject({ lead_investors: ["Plus Partners"], other_investors: [] });
  });

  test("deduplication and cleaning keep both firms when both participated", () => {
    const names = ["Plus Partners", "PLUS Capital"];
    expect(dedupeInvestorNames(names)).toEqual(names);
    expect(
      cleanInvestors({
        lead_investors: names,
        other_investors: [],
        evidence: "The €3 million round was co-led by Plus Partners and PLUS Capital.",
        amount_as_written: "€3 million",
      }).lead_investors,
    ).toEqual(names);
  });
});

describe("financing total amount agreement", () => {
  const tranche = { amountValue: 40, amountCurrency: "EUR", financingTotalAsWritten: "100 millones de euros" };

  test.each([95, 100, 105])("matches amount %s to the other reading's total in either direction", (amountValue) => {
    const total = { amountValue, amountCurrency: "EUR" };
    expect(financingTotalMatches(tranche, total)).toBe(true);
    expect(financingTotalMatches(total, tranche)).toBe(true);
  });

  test("rejects incompatible currencies, missing amounts, and figures outside tolerance", () => {
    expect(financingTotalMatches(tranche, { amountValue: 94, amountCurrency: "EUR" })).toBe(false);
    expect(financingTotalMatches(tranche, { amountValue: 106, amountCurrency: "EUR" })).toBe(false);
    expect(financingTotalMatches(tranche, { amountValue: 100, amountCurrency: "USD" })).toBe(false);
    expect(financingTotalMatches(tranche, {})).toBe(false);
    expect(financingTotalMatches({ financingTotalAsWritten: "$0 million" }, { amountUsdMillions: 0 })).toBe(false);
  });

  test("uses a USD amount for an explicitly dollar-denominated total", () => {
    expect(financingTotalMatches({ financingTotalAsWritten: "$185 million" }, { amountUsdMillions: 180 })).toBe(true);
    expect(financingTotalMatches({ financingTotalAsWritten: "185 million" }, { amountUsdMillions: 180 })).toBe(false);
  });
});

describe("growth capital lending facilities", () => {
  test.each([
    ["growth capital facility", "Acme secured a $185m growth capital facility.", "$185m"],
    ["multi-year facility", "Acme secured up to $185m over a multi-year facility.", "$185m"],
  ])("classifies %s as debt rather than growth equity", (label, sentence, figure) => {
    expect(classifyStage(label).stage).toBe("debt");
    expect(moneyKindFromSentence(sentence, figure)).toBe("debt");
    expect(resolve(figure, sentence, label).kept[0]?.stage).toBe("debt");
    expect(resolve(figure, sentence, "growth").kept).toHaveLength(0);
  });

  test("does not turn ordinary growth capital into debt", () => {
    expect(classifyStage("growth capital").stage).toBe("growth");
    expect(moneyKindFromSentence("Acme raised $185m in a growth equity round.", "$185m")).toBe("primary");
  });
});
