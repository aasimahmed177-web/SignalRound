import { describe, expect, test } from "vitest";
import { type AuditRow, planAuditRepair } from "@/lib/audit-repair";

function row(over: Partial<AuditRow>): AuditRow {
  return {
    id: "example:series_a:2026-09-23",
    company: "Example",
    description: "an operating startup",
    website: null,
    stage: "series_a",
    stageAsWritten: "Series A",
    isExtension: false,
    amountAsWritten: null,
    valuationAsWritten: null,
    financingTotalAsWritten: null,
    amountScope: null,
    announcedOn: "2026-09-23",
    datePrecision: "day",
    dateBasis: "page",
    firstSeenAt: new Date("2026-09-24"),
    pinned: null,
    disposition: "publish",
    evidenceQuotes: [],
    sources: [],
    brand: null,
    profileVerified: false,
    ...over,
  };
}

describe("audit repair proposes only grounded changes", () => {
  test("a fund close and a QIP become rejected with the exact stored sentence", () => {
    for (const [company, quote, reason] of [
      [
        "IIT Madras Unicorn Frontier Fund-I",
        "The IIT Madras Unicorn Frontier Fund-I, set up to provide long-term funding to deep-tech startups, has raised Rs 450 crore in its first funding round.",
        "fund close",
      ],
      [
        "Wheels India Limited",
        "Wheels India raised about ₹250 crore via a qualified institutions placement, issuing 1.2 million shares at ₹2,088 each.",
        "public company",
      ],
    ]) {
      const changes = planAuditRepair(row({ company, evidenceQuotes: [quote] }));
      expect(changes).toContainEqual(
        expect.objectContaining({ kind: "reject", quote, to: "rejected", reason: expect.stringContaining(reason) }),
      );
    }
  });

  test("mixed amount uses the full financing scope, without an invented primary split", () => {
    const quote =
      "Mazama Energy, a superhot geothermal energy developer, closed $135 million in Series B funding and grants, CEO Sriram Vasantharajan tells Axios Pro exclusively.";
    expect(planAuditRepair(row({ company: "Mazama Energy", amountAsWritten: "$135 million", evidenceQuotes: [quote] }))).toContainEqual(
      expect.objectContaining({ kind: "money", from: "$135 million", to: "$135 million", scope: "includes_grants", quote }),
    );
    const hughes =
      "Hughes Precision Manufacturing Pvt. Ltd., one of India’s growing private-sector ammunition manufacturers, has completed an investment round of ₹250+ crore through a combination of primary and secondary investment from a group of marquee ultra-high-net-worth individuals (UHNIs).";
    expect(
      planAuditRepair(row({ company: "Hughes Precision Manufacturing", amountAsWritten: "Rs 250 crore", evidenceQuotes: [hughes] })),
    ).toContainEqual(expect.objectContaining({ kind: "money", scope: "includes_secondary", quote: hughes }));
    const bird =
      "Bird&Be announced an all-equity $13-million USD Series A. BDC's Thrive Fund co-led the round. Bird&Be CEO Samantha Diamond said the round included a small amount of secondary issuances.";
    expect(
      planAuditRepair(row({ company: "Bird&Be", amountAsWritten: "$13 million" }), {
        url: "https://betakit.com/birdbe-series-a",
        markdown: bird,
      }),
    ).toContainEqual(expect.objectContaining({ kind: "money", scope: "includes_secondary", quote: bird }));
    const proxima =
      "Proxima has secured more than €650 million, including €95 million in public grants. Proxima completed this €411 million financing round. The round exceeded its target of matching Bavaria's €400 million public funding contribution.";
    expect(
      planAuditRepair(row({ company: "Proxima", amountAsWritten: "€411 million" }), {
        url: "https://example.com/proxima",
        markdown: proxima,
      }).some((change) => change.kind === "money"),
    ).toBe(false);
  });

  test("a cumulative total loses valuation without losing an isolated new-money amount", () => {
    const quote =
      "Hang Ten Systems today announced an additional $53 million in seed funding led by Xora, a Temasek-backed fund, bringing total funding in the company to $85 million.";
    const changes = planAuditRepair(
      row({
        company: "Hang Ten Systems",
        stage: "seed",
        stageAsWritten: "Seed",
        amountAsWritten: "$53 million",
        valuationAsWritten: "$85 million",
        evidenceQuotes: [quote],
      }),
    );
    expect(changes).toContainEqual(expect.objectContaining({ kind: "valuation", from: "$85 million", to: null, quote }));
    expect(changes).toContainEqual(expect.objectContaining({ kind: "money", from: null, to: "$85 million", scope: "cumulative", quote }));
    expect(changes).toContainEqual(expect.objectContaining({ kind: "extension", to: "true", quote }));
  });

  test("another figure's lifetime total never erases this round's new money or its genuine valuation", () => {
    const quote = "Norm AI raised a $120 million Series C at a $1.2 billion valuation, bringing total funding to $220 million.";
    const changes = planAuditRepair(
      row({
        company: "Norm AI",
        stage: "series_c",
        stageAsWritten: "Series C",
        amountAsWritten: "$120 million",
        valuationAsWritten: "$1.2 billion",
        evidenceQuotes: [quote],
      }),
    );
    expect(changes.some((change) => change.kind === "money" || change.kind === "valuation")).toBe(false);
  });

  test("pinned fields stay fixed, but a dated company post replaces a week marker", () => {
    const page = {
      url: "https://expanse.sh/blog/expanse-raises-5-3m-seed",
      markdown:
        "September 16, 2026 company funding\n# Why we started Expanse, and our $5.3M seed\nToday we're announcing a $5.3M seed round for Expanse.",
    };
    const base = row({ company: "Expanse", stage: "seed", stageAsWritten: "Seed", announcedOn: "2026-09-12", datePrecision: "week" });
    expect(planAuditRepair(base, page)).toContainEqual(expect.objectContaining({ kind: "date", from: "2026-09-12", to: "2026-09-16" }));
    expect(planAuditRepair({ ...base, pinned: { announced_on: "2026-09-12" } }, page).some((c) => c.kind === "date")).toBe(false);
  });

  test("a Form D SAFE uses its filing day, never the first sale as announcement", () => {
    const page = {
      url: "https://www.sec.gov/Archives/edgar/data/2156951/000215695126000001/0002156951-26-000001-index.htm",
      markdown: "Simple Agreement for Future Equity (SAFE)\nFirst sale 2026-09-18\nSigned 2026-09-23",
    };
    const base = row({
      company: "Neurath Inc.",
      stage: "other",
      stageAsWritten: "funding",
      announcedOn: "2026-09-18",
      sources: [{ url: page.url, title: "Neurath Inc. Form D", published: "2026-09-23" }],
    });
    expect(planAuditRepair(base, page)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "stage", to: "convertible", quote: "Simple Agreement for Future Equity (SAFE)" }),
        expect.objectContaining({ kind: "date", from: "2026-09-18", to: "2026-09-23", quote: "2026-09-23" }),
      ]),
    );
  });

  test("a verified company homepage replaces a namesake; otherwise the domain stays empty", () => {
    const source = { url: "https://hellosol.app/here-comes-the-sun", title: "Sol emerged from stealth", published: "2026-09-23" };
    const base = row({
      company: "Sol",
      website: "https://sol.com",
      sources: [source],
      evidenceQuotes: ["Sol emerged from stealth with $4 million in funding."],
    });
    expect(
      planAuditRepair(base, undefined, {
        url: "https://hellosol.app",
        quote: "Sol finds the work promised in email and helps teams finish it.",
      }),
    ).toContainEqual(expect.objectContaining({ kind: "domain", from: "https://sol.com", to: "https://hellosol.app" }));
    const rio = row({
      company: "Rio Health",
      website: "https://riohealth.com",
      brand: "Rio Grande Regional Hospital",
      profileVerified: false,
    });
    expect(planAuditRepair(rio)).toContainEqual(
      expect.objectContaining({ kind: "domain", to: null, quote: "Rio Grande Regional Hospital" }),
    );
    expect(
      planAuditRepair(rio, undefined, { url: "https://rioai.in", quote: "Rio Health – Medicines Delivered in Minutes" }),
    ).toContainEqual(expect.objectContaining({ kind: "domain", from: "https://riohealth.com", to: "https://rioai.in" }));
    expect(
      planAuditRepair({ ...rio, website: null }, undefined, {
        url: "https://rioai.in",
        quote: "Rio Health – Medicines Delivered in Minutes",
      }),
    ).toContainEqual(expect.objectContaining({ kind: "domain", from: null, to: "https://rioai.in" }));
    expect(
      planAuditRepair(
        row({ company: "Anthropic", website: "https://anthropic.com", brand: "Home \\ Anthropic", profileVerified: true }),
      ).some((change) => change.kind === "domain"),
    ).toBe(false);
  });

  test("a page's unrelated extensions, SAFE adjectives and other companies' rounds do not change this row", () => {
    const page = {
      url: "https://news.example.com/today",
      markdown:
        "This page has been blocked by an extension\nSolcoa works with University of Idaho Extension.\nHorizon3 builds a safe autonomous platform.\nLangxi Technology raised nearly RMB200 million in a Pre-A+ round.",
    };
    const changes = planAuditRepair(row({ company: "Solcoa", stage: "series_a", stageAsWritten: "Series A" }), page);
    expect(changes.some((c) => c.kind === "stage" || c.kind === "extension")).toBe(false);
    expect(
      planAuditRepair(row({ company: "Pilgrim", stage: "seed", stageAsWritten: "Seed" }), {
        url: "https://news.example.com/roundup",
        markdown: "Pilgrim is Seed; Kasvu is Series A; Langxi is Pre-A+.",
      }).some((c) => c.kind === "stage"),
    ).toBe(false);
    expect(
      planAuditRepair(row({ company: "Darwinbox", amountAsWritten: "$40 million", announcedOn: "2026-09-24" }), {
        url: "https://news.example.com/darwinbox",
        markdown: "In August 2025, the company closed a $40 million round that was a mix of primary and secondary transactions.",
      }).some((c) => c.kind === "money"),
    ).toBe(false);
    expect(
      planAuditRepair(row({ company: "Gatik", website: "https://gatik.ai" }), undefined, {
        url: "https://archive.gatik.ai",
        quote: "Gatik operates autonomous trucks.",
      }).some((c) => c.kind === "domain"),
    ).toBe(false);
  });
});
