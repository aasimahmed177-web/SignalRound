import type { ExtractedRound } from "@fireround/core";
import { describe, expect, test } from "vitest";
import { financingChange, regroundedChange, type SourceMoneyReading, sourceSentenceDecision } from "../lib/financing-repair.ts";

function row(company: string, amount: string, quote: string) {
  return {
    id: "test",
    company,
    amount,
    currency: "USD",
    value: "100",
    usd: "100",
    total: null,
    quotes: [quote],
    pinned: null,
    disposition: "publish" as const,
    announced: "2026-09-24",
  };
}

function reading(company: string, amount: string | null, quote: string, label: string): SourceMoneyReading {
  const round: ExtractedRound = {
    company_name: company,
    company_website: null,
    company_description: null,
    round_type_as_written: label,
    amount_as_written: amount,
    amount_kind: "round",
    valuation_as_written: null,
    lead_investors: [],
    other_investors: [],
    announced_date: null,
    headquarters: null,
    sector: null,
    evidence_quote: quote,
    money_kind_quote: quote,
    source_url: null,
    is_background: false,
    is_rumor: false,
  };
  return { round, url: "https://example.org/press/financing", published: "2026-09-24", markdown: quote };
}

describe("visible financing replay", () => {
  test("a Singapore-based company's bare dollar repairs a mistaken SGD label to USD", () => {
    const stored = {
      ...row(
        "dtcpay",
        "$25 million",
        "Dtcpay, a Singapore-based stablecoin payment technology provider, has closed its Series A funding round at $25 million",
      ),
      currency: "SGD",
    };
    expect(financingChange(stored)?.currency?.to).toBe("USD");
    expect(financingChange({ ...stored, currency: "USD" })).toBeNull();
  });

  test("only an explicitly combined amount becomes a financing total", () => {
    expect(financingChange(row("Ando", "$20 million", "Ando raised $20 million across its pre-seed and seed rounds."))?.amount).toEqual({
      from: "$20 million",
      to: null,
      total: "$20 million",
    });
    expect(financingChange(row("Parallax", "$117 million", "Parallax raised $117 million."))).toBeNull();
  });

  test.each([
    ["Parallax", "$117 million", "$75 million", "Parallax raised a $75 million Series A round."],
    ["Neocloud Nscale", "$3.36 billion", "$2.36 billion", "Nscale closed a $2.36 billion convertible financing round."],
    ["L-Nutra Inc.", "$83.5 million", "$36.5 million", "L-Nutra Inc. announced a $36.5 million investment in its Series D funding round."],
  ])("%s: original release proves new money rather than stored aggregate", (company, stored, fresh, quote) => {
    const result = regroundedChange(
      row(company, stored, `${company} raised ${stored}.`),
      reading(company === "Neocloud Nscale" ? "Nscale" : company, fresh, quote, "Series A"),
    );
    expect(result?.amount).toEqual({ from: stored, to: fresh, total: stored });
  });

  test("a secondary-only follow-on goes to Review, never an undisclosed round", () => {
    const quote = "Darwinbox investors sold $40 million of existing shares in a secondary transaction.";
    expect(
      regroundedChange(row("Darwinbox", "$40 million", "Darwinbox raised $40 million."), reading("Darwinbox", null, quote, "follow-on"))
        ?.review,
    ).toBe(true);
  });

  test("Nscale's initial closing, not the future commitment, is the new-money amount", () => {
    const source =
      "Nscale announced a $3.36bn convertible financing. The financing consists of an initial $2.36bn tranche at closing and an additional $1bn commitment from NVIDIA with funding expected in November.";
    const stored = row("Neocloud Nscale", "$3.36 billion", "Nscale raised $3.36 billion.");
    const reread = sourceSentenceDecision(stored, source, "https://example.org/press/nscale", "2026-09-24");
    expect(reread?.round.amount_as_written).toBe("$2.36bn");
    expect(reread && regroundedChange(stored, reread)?.amount?.to).toBe("$2.36bn");
  });

  test("Parallax's investor announcement names a separate $75M Series A after its $117M lifetime total", () => {
    const stored = { ...row("Parallax", "$117 million", "Parallax has raised $117 million."), stage: "other" };
    const text =
      "Parallax is emerging from stealth with $117 million in funding to date, and Eclipse co-led the $42M seed. Greylock and General Catalyst led the company's $75M Series A.";
    const reread = sourceSentenceDecision(stored, text, "https://investor.example/blog/round", "2026-09-24");
    expect(reread?.round.amount_as_written).toBe("$75M");
    expect(reread && regroundedChange(stored, reread)?.amount?.to).toBe("$75M");
    expect(reread && regroundedChange(stored, reread)?.stage?.to).toBe("series_a");
  });

  test("Reapit's own planned spending goes to Review even when the extractor calls it funding", () => {
    const source = "Reapit today unveiled its vision for estate agency and is investing an additional £20M+ into its technology.";
    const stored = row("Reapit", "£20 million", "Reapit raised £20 million from its investor.");
    const reread = sourceSentenceDecision(stored, source, "https://example.org/press/reapit", "2026-09-24");
    expect(reread && regroundedChange(stored, reread)?.review).toBe(true);
  });

  test("Noxtua's approximate majority-stake transaction stays in Review without a primary split", () => {
    const source =
      "Noxtua announces 100 million EURO Series C. C.H.BECK becomes the new majority shareholder in Noxtua. Noxtua has closed its Series C funding round totaling more than 100 million EURO.";
    const stored = row("Noxtua", "€100M", "Noxtua raises €100M Series C.");
    const reread = sourceSentenceDecision(stored, source, "https://example.org/press/noxtua", "2026-09-24");
    expect(reread && regroundedChange(stored, reread)?.review).toBe(true);
  });

  test("Thri5's official US dollar figure corrects a same-number Canadian dollar report", () => {
    const stored = { ...row("Thri5", "C$5.4m ($3.9m)", "Thri5 raised C$5.4m ($3.9m)."), currency: "CAD" };
    const source = reading("Thri5", "US$5.4 million", "Thri5 announced that it raised US$5.4 million in Seed financing.", "Seed");
    expect(regroundedChange(stored, source)?.amount).toEqual({ from: stored.amount, to: "US$5.4 million", total: null });
  });

  test.each([
    ["Aron", "Storm Ventures", "Menlo Ventures"],
    ["Bonbon Mobility", "Tasco", "GenAI Fund"],
    ["Parallax", "Greylock", "Eclipse Capital"],
    ["Raindrop", "Lightspeed Venture Partners", "CRV"],
  ])("%s: a grounded lead beats a participant list", (company, actualLead, priorLead) => {
    const stored = {
      ...row(company, "$15 million", `${company} raised $15 million in a seed round.`),
      leadNames: [priorLead],
      otherNames: [actualLead],
    };
    const source = reading(company, "$15 million", `${company} raised $15 million in a seed round.`, "seed");
    source.round.lead_investors = [actualLead];
    source.round.lead_evidence = [`${company} raised a $15 million seed round led by ${actualLead}, with participation from ${priorLead}.`];
    expect(regroundedChange(stored, source)?.leads?.to).toEqual([actualLead]);
  });

  test("EUCLYD's release names Samsung Catalyst Fund, not a nearby investor alias", () => {
    const stored = {
      ...row("EUCLYD", "€200 million", "EUCLYD raised €200 million Series A."),
      leadNames: ["Samsung Ventures"],
      otherNames: ["Samsung Catalyst Fund", "Innovation Industries"],
    };
    const source = reading("EUCLYD", "€200 million", "EUCLYD raised €200 million Series A.", "Series A");
    source.round.lead_investors = ["Samsung Catalyst Fund", "Innovation Industries"];
    source.round.lead_evidence = ["Innovation Industries and Samsung Catalyst Fund co-led EUCLYD's €200 million Series A."];
    expect(regroundedChange(stored, source)?.leads?.to).toEqual(["Samsung Catalyst Fund", "Innovation Industries"]);
  });

  test("Aron's seed lead is Storm, while the earlier pre-seed lead does not cross rounds", () => {
    const stored = { ...row("Aron", "$6.0M", "Aron raised a $6 million seed round."), stage: "seed", leadNames: [] };
    const source = reading("Aron Inc.", "$8 million", "Aron launched with $8 million in funding.", "Seed");
    source.round.lead_investors = ["Menlo Ventures", "Storm Ventures"];
    source.round.lead_evidence = [
      "The first was led by Menlo Ventures while the second, a $6 million seed investment, was led by Storm Ventures.",
    ];
    const change = regroundedChange(stored, source);
    expect(change?.leads?.to).toEqual(["Storm Ventures"]);
    expect(change?.amount).toBeUndefined();
  });

  test("Notey's 2015 seed article cannot change a 2026 seed row", () => {
    const stored = { ...row("Notey", "$3M", "Notey has closed a $3M seed round."), announced: "2026-09-22", stage: "seed" };
    const old = reading("Notey", "$1 million", "Notey raised $1 million in seed funding.", "seed");
    old.published = "2015-09-22";
    expect(regroundedChange(stored, old)).toBeNull();
    old.published = "2026-09-22";
    old.url = "https://example.org/2015/09/22/notey-seed";
    expect(regroundedChange(stored, old)).toBeNull();
  });

  test("Micro1's gross run rate is not new round money despite a same-date article", () => {
    const stored = { ...row("Micro1", "$100 million", "Micro1 raised a fresh round of more than $100 million."), stage: "other" };
    const gross = reading("Micro1", "$500 million", "Micro1 is on track to reach $500 million in gross run rate.", "funding");
    gross.round.money_kind = "primary";
    expect(regroundedChange(stored, gross)?.amount).toBeUndefined();
  });

  test("Apate's cumulative US$11.4 million is not its A$11.4 million seed amount", () => {
    const stored = { ...row("Apate.AI", "A$11.4 million", "Apate.AI raised A$11.4 million in seed funding."), stage: "seed" };
    const aggregate = reading("Apate.AI", "US$11.4 million", "Apate.AI has now raised US$11.4 million in total.", "seed");
    expect(regroundedChange(stored, aggregate)?.amount).toBeUndefined();
  });

  test("Félix's $200 million combined financing never replaces $87 million primary equity", () => {
    const stored = { ...row("Félix", "$87 million", "A16z led an $87 million equity investment."), stage: "series_c" };
    const combined = reading("Félix", "$200 million", "Félix secured $200 million in Series C funding.", "Series C");
    combined.markdown = `${combined.round.evidence_quote} A16z led an $87 million equity investment. General Catalyst committed $113 million in debt to fund Félix's growth.`;
    expect(regroundedChange(stored, combined)?.amount).toBeUndefined();
    combined.markdown = "US-based cross-border paytech Félix has scored $200 million in a mix of equity and debt.";
    expect(regroundedChange(stored, combined)?.amount).toBeUndefined();
  });

  test("a near-date source at another stage and an undated source both abstain", () => {
    const stored = { ...row("Notey", "$3M", "Notey closed a $3M seed round."), stage: "seed" };
    const other = reading("Notey", "$5M", "Notey raised $5M in a Series A round.", "Series A");
    expect(regroundedChange(stored, other)).toBeNull();
    other.round.round_type_as_written = "seed";
    other.published = null;
    expect(regroundedChange(stored, other)).toBeNull();
  });

  test("a reread cannot improve a stale visible row even if the old source and announced dates agree", () => {
    const stored = {
      ...row("Purplle", "₹1,500 crore", "Purplle raised ₹1,500 crore."),
      stage: "series_d_plus",
      announced: "2024-10-14",
      firstSeen: "2026-09-06",
    };
    const old = reading("Purplle", "₹1,500 crore", "Purplle raised ₹1,500 crore in Series F funding led by ADIA.", "Series F");
    old.published = "2024-10-14";
    old.round.lead_investors = ["ADIA"];
    old.round.lead_evidence = [old.round.evidence_quote];
    expect(regroundedChange(stored, old)).toBeNull();
  });

  test.each([
    ["Helcim", "$53 million CAD", "$53 million", "Helcim closed a $53 million CAD Series C funding round.", "Series C"],
    ["Ultimarii", "$13 million CAD", "$13 million", "Ultimarii closed a Series A round worth more than $13 million CAD.", "Series A"],
    ["Axya", "$17 million CAD", "$17 million", "Axya announced a $17 million CAD Series A funding round.", "Series A"],
    ["OpenDebt", "AUD$2 million", "$2 million", "OpenDebt completed an AUD$2 million pre-seed funding round.", "pre-seed"],
  ])("%s: the source's explicit currency cannot be stripped into a new USD amount", (company, current, stripped, quote, stage) => {
    const stored = { ...row(company, current, `${company} raised ${current}.`), stage: "other" };
    const source = reading(company, stripped, quote, stage);
    expect(regroundedChange(stored, source)?.amount).toBeUndefined();
  });

  test("an explicit singular lead outranks prior participants in an amount-specific sentence", () => {
    const stored = { ...row("MIND", "$72.0M", "MIND raised $72 million Series B."), stage: "series_b", leadNames: [] };
    const source = reading(
      "MIND",
      "$72 million",
      "MIND raised $72 million Series B, led by Crosspoint Capital Partners and existing investors YL Ventures and Paladin Capital Group.",
      "Series B",
    );
    source.round.lead_investors = ["Crosspoint Capital Partners", "YL Ventures", "Paladin Capital Group"];
    source.round.lead_evidence = [source.round.evidence_quote, "Crosspoint Capital Partners is the lead investor in this round."];
    expect(regroundedChange(stored, source)?.leads?.to).toEqual(["Crosspoint Capital Partners"]);
  });

  test("a lead sentence from another round cannot attach without the stored amount", () => {
    const stored = {
      ...row("Together AI", "$800 million", "Together AI raised $800 million in a Series C."),
      stage: "series_c",
      leadNames: [],
    };
    const source = reading(
      "Together AI",
      "$800 million",
      "Together AI raised $800 million from a group of investors including Salesforce Ventures.",
      "Series C",
    );
    source.round.lead_investors = ["Salesforce Ventures"];
    source.round.lead_evidence = ["The earlier financing was led by Salesforce Ventures."];
    expect(regroundedChange(stored, source)?.leads).toBeUndefined();
  });

  test("a Series G extension does not inherit the earlier round's lead", () => {
    const stored = {
      ...row("Cyera", "$400 million", "Cyera raised $400 million from Goldman Sachs in a Series G extension."),
      stage: "series_d_plus",
      isExtension: true,
      leadNames: [],
    };
    const source = reading(
      "Cyera",
      "$400 million",
      "Cyera announced a $400 million extension from Goldman Sachs to its Series G, led by Evolution Equity.",
      "Series G extension",
    );
    source.round.lead_investors = ["Evolution Equity"];
    source.round.lead_evidence = [source.round.evidence_quote];
    expect(regroundedChange(stored, source)?.leads).toBeUndefined();
  });

  test("an incomplete co-lead list cannot replace all Temporal Series E leads", () => {
    const stored = {
      ...row("Temporal Technologies", "$550.0M", "Temporal raised $550M Series E."),
      stage: "series_d_plus",
      leadNames: ["Lightspeed", "Wellington Management", "Goldman Sachs Alternatives", "Tiger Global Management"],
    };
    const source = reading(
      "Temporal Technologies",
      "$550M",
      "Temporal raised a $550M Series E co-led by Lightspeed, with Wellington Management, Growth Equity at Goldman Sachs Alternatives, and Tiger Global.",
      "Series E",
    );
    source.round.lead_investors = ["Lightspeed"];
    source.round.lead_evidence = [source.round.evidence_quote];
    expect(regroundedChange(stored, source)?.leads).toBeUndefined();
  });
});
