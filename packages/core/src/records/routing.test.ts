// Stageless rounds, end to end without the network: a page's round that names no stage ("$75 million
// in financing", "a $117m fundraise") is kept, placed by its amount's band, stored as written, and its
// equity half counted when the page splits equity and debt. Money that is not a venture round (a debt
// facility, a fund close, a grant, an offering, a buyout) is dropped, in every lane and in history.

import { describe, expect, test } from "vitest";
import { pageItems } from "../firecrawl/extract.ts";
import { parsePreset } from "../presets/types.ts";
import { HISTORY_STAGES } from "./history.ts";
import { issuerTypeFromEvidence, nonStartupIssuerReason } from "./money-kind.ts";
import { hostOf, windowStartFor } from "./normalize.ts";
import { type ExtractedItem, resolveRounds } from "./resolve.ts";
import {
  amountIsDebt,
  bandForAmount,
  bandsOf,
  groupByPreset,
  isStageless,
  notARound,
  notAStartupRound,
  presetKeeps,
  routePreset,
  STAGE_BANDS,
} from "./routing.ts";
import type { ExtractedRound } from "./schema.ts";
import type { STAGES } from "./stages.ts";

const NOW = new Date("2026-09-24T20:00:00Z");
const WEEK = windowStartFor("week", NOW);

/** The three shipped presets, in list order, as routing reads them. */
const PRESETS = [
  { slug: "series-a-b", stages: ["series_a", "series_b"] as const },
  { slug: "seed", stages: ["pre_seed", "seed"] as const },
  { slug: "growth", stages: ["series_c", "series_d_plus", "growth"] as const },
].map((p) => ({ slug: p.slug, stages: [...p.stages] }));
/** Every stage a shipped preset keeps: what a routing lane (watch, X, a pasted URL) resolves with. */
const ROUTED_STAGES = [...new Set(PRESETS.flatMap((p) => p.stages))];

function round(partial: Partial<ExtractedRound> & { company_name: string; round_type_as_written: string }): ExtractedRound {
  return {
    company_website: null,
    company_description: null,
    amount_as_written: null,
    amount_kind: "round",
    valuation_as_written: null,
    lead_investors: [],
    other_investors: [],
    announced_date: "2026-09-24",
    headquarters: null,
    sector: null,
    evidence_quote: `${partial.company_name} raised ${partial.amount_as_written ?? "an undisclosed amount"}.`,
    source_url: null,
    is_background: false,
    is_rumor: false,
    ...partial,
  };
}

function item(r: ExtractedRound, url: string): ExtractedItem {
  return { round: r, source: { url, host: hostOf(url), published: "2026-09-24" }, page_kind: "article", page_date: "2026-09-24" };
}

const SOLCOA_URL =
  "https://www.businesswire.com/news/home/20260924752270/en/Solcoa-Announces-%2475M-to-Scale-Americas-First-New-Metalmaking-Process-in-80-Years";
/** The release's own paragraph, as Business Wire prints it (September 24, 2026). */
const SOLCOA_MD = `# Solcoa Announces $75M to Scale America's First New Metalmaking Process in 80 Years

ALAMEDA, Calif.--(BUSINESS WIRE)--Sep 24, 2026--

Solcoa Industries today announced $75 million in financing to build Solcoa One, its first commercial rare earth metalmaking plant. The round includes $45 million in equity led by Bain Capital Ventures, with participation from Gigascale Capital, Long Journey, Felicis, Dylan Field, and prominent leaders across defense and technology. It also includes $30 million in debt and equipment financing, anchored by J.P. Morgan. The financing will fund construction and commissioning of Solcoa One.
`;

describe("Solcoa: $75M in financing, $45M of it equity", () => {
  // One read of the release came back as a "Series A" for the whole $75 million: the label is not on the page.
  const extracted = round({
    company_name: "Solcoa Industries",
    round_type_as_written: "Series A",
    amount_as_written: "$75 million",
    lead_investors: ["Bain Capital Ventures"],
    evidence_quote:
      "Solcoa Industries today announced $75 million in financing to build Solcoa One, its first commercial rare earth metalmaking plant.",
  });

  test("the page settles the reading: the label it writes, the equity figure, the debt sentence beside it", () => {
    const [settled] = pageItems([extracted], { url: SOLCOA_URL, host: hostOf(SOLCOA_URL) }, SOLCOA_MD, {
      page_kind: "article",
      page_date: "2026-09-24",
    });
    expect(settled.round.round_type_as_written).toBe("financing");
    expect(settled.round.amount_as_written).toBe("$45 million");
    expect(settled.round.evidence_quote).toContain("$45 million in equity led by Bain Capital Ventures");
    expect(settled.round.debt_quote).toContain("$30 million in debt and equipment financing");
  });

  test("kept under Series A/B by its band, stored as other with the page's label and both sentences", () => {
    const items = pageItems([extracted], { url: SOLCOA_URL, host: hostOf(SOLCOA_URL) }, SOLCOA_MD, {
      page_kind: "article",
      page_date: "2026-09-24",
    });
    const r = resolveRounds(items, { stages: ["series_a", "series_b"], windowStart: WEEK, now: NOW });
    expect(r.kept).toHaveLength(1);
    const rec = r.kept[0];
    expect(rec.stage).toBe("other");
    expect(rec.stage_as_written).toBe("financing");
    expect(rec.amount.usd_millions).toBe(45);
    expect(rec.evidence_quotes.some((q) => q.includes("$30 million in debt"))).toBe(true);
    expect(routePreset(rec, PRESETS, "series-a-b")).toBe("series-a-b");
    // The seed sweep reads the same release: with every band on, its record still files under Series A/B.
    const fromSeed = resolveRounds(items, { stages: ["pre_seed", "seed"], stagelessBands: STAGE_BANDS, windowStart: WEEK, now: NOW });
    expect(routePreset(fromSeed.kept[0], PRESETS, "seed")).toBe("series-a-b");
    // Without the lane's bands the seed preset's own resolve leaves a mid-band round to the preset that keeps it.
    expect(resolveRounds(items, { stages: ["pre_seed", "seed"], windowStart: WEEK, now: NOW }).kept).toHaveLength(0);
  });
});

describe("Parallax: a $117m fundraise", () => {
  test("the extractor's placeholder label becomes the sentence's word", () => {
    const [it] = pageItems(
      [
        round({
          company_name: "Parallax",
          round_type_as_written: "unknown",
          amount_as_written: "$117 million",
          evidence_quote: "Parallax, an AI energy startup, has raised $117 million in funding from Founders Fund and others.",
        }),
      ],
      { url: "https://www.wsj.com/business/energy-oil/x", host: "wsj.com" },
      "Parallax, an AI energy startup, has raised $117 million in funding from Founders Fund and others.",
    );
    expect(it.round.round_type_as_written).toBe("funding");
  });

  test("an article's stageless $117 million round is late band: growth keeps it", () => {
    const url = "https://finance.yahoo.com/technology/articles/3-d-printing-answer-ai-110000268.html";
    const r = resolveRounds(
      [
        item(
          round({
            company_name: "Parallax",
            round_type_as_written: "fundraise",
            amount_as_written: "$117 million",
            lead_investors: ["Founders Fund", "Eclipse", "Lux", "Diffusion", "Greylock", "General Catalyst"],
            evidence_quote: "Parallax has raised $117 million from investors including Founders Fund, Eclipse and Lux.",
          }),
          url,
        ),
      ],
      { stages: ROUTED_STAGES, stagelessBands: STAGE_BANDS, windowStart: WEEK, now: NOW },
    );
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0].stage).toBe("other");
    expect(r.kept[0].stage_as_written).toBe("fundraise");
    expect(routePreset(r.kept[0], PRESETS, null)).toBe("growth");
  });
});

describe("the credit-market rules leave a startup's equity alone", () => {
  test("equity beside a term loan, and a name that only contains a vehicle word, stay rounds", () => {
    expect(
      notARound(
        "financing",
        "Acme raised $45 million in equity financing led by Accel, alongside a $20 million senior secured term loan from Hercules.",
        "$45 million",
        "Acme",
      ),
    ).toBeNull();
    expect(notARound("funding", "Parent Square Inc raised $20 million led by Accel.", "$20 million", "Parent Square Inc")).toBeNull();
    expect(notARound("funding", "Acme Parent LLC raised $20 million.", "$20 million", "Acme Parent LLC")).toBe("financing vehicle");
  });
});

describe("stageless money that is not a venture round is dropped", () => {
  const cases: Array<[string, Partial<ExtractedRound>, string]> = [
    [
      "a debt-only facility",
      {
        round_type_as_written: "financing",
        amount_as_written: "$50 million",
        evidence_quote: "Acme Logistics secured a $50 million credit facility from Silicon Valley Bank to fund its fleet.",
      },
      "debt",
    ],
    [
      "a fund close",
      {
        round_type_as_written: "funding",
        amount_as_written: "$300 million",
        evidence_quote: "Acme Ventures today announced the final close of Fund III at $300 million.",
      },
      "fund close",
    ],
    [
      "a grant",
      {
        round_type_as_written: "grant",
        amount_as_written: "$2 million",
        evidence_quote: "Acme was awarded a $2 million grant from the NSF.",
      },
      "grant or contract",
    ],
    [
      "an IPO",
      {
        round_type_as_written: "initial public offering",
        amount_as_written: "$120 million",
        evidence_quote: "Acme priced its $120 million initial public offering on Nasdaq.",
      },
      "public offering",
    ],
    [
      "a buyout",
      {
        round_type_as_written: "management buyout",
        amount_as_written: "$90 million",
        evidence_quote: "Acme's management team completed a $90 million management buyout backed by Accel-KKR.",
      },
      "acquisition",
    ],
    // Pre-launch audit (September 24, 2026): a credit desk's note on a bond add-on led the landing page.
    [
      "a bond add-on, by its label",
      {
        company_name: "Stonepeak Nile Parent LLC (Air Transport Svcs)",
        round_type_as_written: "add-on",
        amount_as_written: "$125m (up from $100m)",
        evidence_quote:
          "Announced this morning and priced this afternoon in the US high yield new issue market was Stonepeak Nile Parent LLC (Air Transport Svcs) $125m (up from $100m) add-on to its 7.25% 1st lien sr sec notes due 03/15/32, priced 7.25% at 100.",
      },
      "debt",
    ],
    [
      "a bond add-on, by its sentence alone",
      {
        company_name: "Stonepeak Nile Parent LLC (Air Transport Svcs)",
        round_type_as_written: "financing",
        amount_as_written: "$125m",
        evidence_quote:
          "Announced this morning and priced this afternoon in the US high yield new issue market was Stonepeak Nile Parent LLC (Air Transport Svcs) $125m add-on to its 7.25% 1st lien sr sec notes due 03/15/32.",
      },
      "debt",
    ],
    [
      "a secured-notes figure in its own clause",
      {
        round_type_as_written: "financing",
        amount_as_written: "$400 million",
        evidence_quote: "Acme Holdings completed the sale of $400 million of 6.5% senior secured notes, the company said.",
      },
      "debt",
    ],
    [
      "a borrowing entity named as the company",
      {
        company_name: "Acme Bidco Ltd",
        round_type_as_written: "financing",
        amount_as_written: "$60 million",
        evidence_quote: "Acme Bidco Ltd raised $60 million to fund the purchase.",
      },
      "financing vehicle",
    ],
  ];
  for (const [name, partial, reason] of cases) {
    test(name, () => {
      const r = round({ company_name: "Acme", round_type_as_written: "funding", ...partial });
      expect(notARound(r.round_type_as_written, r.evidence_quote, r.amount_as_written, r.company_name)).toBe(reason);
      const res = resolveRounds([item(r, "https://news.example/2026/09/24/acme-news")], {
        stages: ROUTED_STAGES,
        stagelessBands: STAGE_BANDS,
        windowStart: WEEK,
        now: NOW,
      });
      expect(res.kept).toHaveLength(0);
      expect(res.dropped.notARound + res.dropped.otherStage).toBe(1);
    });
  }

  test("public, project, and personal money the live pass read (September 24, 2026)", () => {
    expect(
      notARound(
        "USD730 million, multi-year rolling pipeline",
        "The Asian Infrastructure Investment Bank (AIIB) and the Government of Benin have agreed on a USD730 million, multi-year rolling pipeline.",
        "USD730 million",
        "Asian Infrastructure Investment Bank (AIIB) and Government of Benin",
      ),
    ).not.toBeNull();
    expect(
      notARound("commitment", "Mercuria today announced a $500 million commitment to Project Vault.", "$500 million", "Project Vault"),
    ).not.toBeNull();
    expect(
      notARound(
        "Revitalization project",
        "Governor Kathy Hochul today announced the completion of a $152 million, 341-unit affordable public housing revitalization project in the city of Troy.",
        "$152 million",
        "Troy Housing Authority",
      ),
    ).not.toBeNull();
    expect(notARound("book advance", "The two book advances were for $2 million.", "$2 million", "Skyhorse Publishing")).not.toBeNull();
    // A startup's strategic investment still reads as a round.
    expect(
      notARound("investment", "CellPoint today announces a US$34 million investment from Toscafund.", "US$34 million", "CellPoint"),
    ).toBeNull();
  });

  test("a round with neither a stage nor an amount stays dropped", () => {
    const res = resolveRounds(
      [
        item(
          round({ company_name: "Ande", round_type_as_written: "Funding", evidence_quote: "Ande secures funding from prominent VCs." }),
          "https://news.example/2026/09/24/ande",
        ),
      ],
      { stages: ["series_a", "series_b"], stagelessBands: STAGE_BANDS, windowStart: WEEK, now: NOW },
    );
    expect(res.kept).toHaveLength(0);
    expect(res.dropped.otherStage).toBe(1);
  });

  test("debt beside equity leaves the equity figure the round", () => {
    const e = "The round includes $45 million in equity led by Bain Capital Ventures, plus $30 million in debt.";
    expect(amountIsDebt(e, "$45 million")).toBe(false);
    expect(amountIsDebt(e, "$30 million")).toBe(true);
  });
});

describe("routing by amount", () => {
  test("the bands meet at $10M and $80M", () => {
    expect(bandForAmount(9.99)).toBe("early");
    expect(bandForAmount(10)).toBe("mid");
    expect(bandForAmount(79.9)).toBe("mid");
    expect(bandForAmount(80)).toBe("late");
    expect(bandsOf(["pre_seed", "seed"])).toEqual(["early"]);
    expect(bandsOf(["series_c", "series_d_plus", "growth"])).toEqual(["late"]);
    // Listing bridge keeps pre-Series rounds without claiming the early band's unlabelled rounds.
    expect(bandsOf(["series_a", "series_b", "bridge"])).toEqual(["mid"]);
  });

  test("a pre-Series round routes to the Series A and B preset once it lists bridge, and unlabelled small rounds stay with seed", () => {
    const withBridge = PRESETS.map((p) => (p.slug === "series-a-b" ? { ...p, stages: [...p.stages, "bridge" as const] } : p));
    const rec = (stage: (typeof STAGES)[number], usd: number | null) => ({ stage, amount: { usd_millions: usd } });
    expect(routePreset(rec("bridge", 5), withBridge, "seed")).toBe("series-a-b");
    expect(routePreset(rec("bridge", 5), PRESETS, "seed")).toBeNull();
    expect(routePreset(rec("other", 4), withBridge, "series-a-b")).toBe("seed");
  });

  test("a lettered round goes by its stage, a stageless one by its band; the lane's own preset first", () => {
    const rec = (stage: (typeof STAGES)[number], usd: number | null) => ({ stage, amount: { usd_millions: usd } });
    expect(routePreset(rec("series_c", 20), PRESETS, "seed")).toBe("growth");
    expect(routePreset(rec("other", 4), PRESETS, "growth")).toBe("seed");
    expect(routePreset(rec("undisclosed", 45), PRESETS, "growth")).toBe("series-a-b");
    expect(routePreset(rec("other", 117), PRESETS, "series-a-b")).toBe("growth");
    // A custom topic preset that keeps the round keeps what it found; it never takes another lane's.
    const topic = { slug: "climate", stages: ["seed" as const] };
    expect(routePreset(rec("other", 3), [...PRESETS, topic], "climate")).toBe("climate");
    expect(routePreset(rec("other", 3), [...PRESETS, topic], "series-a-b")).toBe("seed");
    // Debt is no preset's round.
    expect(routePreset(rec("debt", 50), PRESETS, "series-a-b")).toBeNull();
    expect(presetKeeps({ stages: ["seed"] }, "other", null)).toBe(false);
    const { groups, unrouted } = groupByPreset([rec("other", 4), rec("other", 45), rec("debt", 5)], PRESETS, null);
    expect([...groups.keys()]).toEqual(["seed", "series-a-b"]);
    expect(unrouted).toBe(1);
  });

  test("the series-a-b preset runs the stage-free searches that measured real rounds, the wires on their own domains", () => {
    const p = parsePreset({
      slug: "t",
      name: "t",
      description: "t",
      queries: ["q"],
      goal: "g",
      stages: ["series_a"],
      watchQueries: ['"has raised" million led by', { q: "raises million funding led by", includeDomains: ["businesswire.com"] }],
    });
    expect(p.watchQueries).toHaveLength(2);
    expect(() => parsePreset({ ...p, watchQueries: [{ q: 1 }] })).toThrow();
  });
});

describe("the history lane meets the same rules", () => {
  const historyOpts = {
    stages: HISTORY_STAGES.filter((s) => !isStageless(s)),
    stagelessBands: STAGE_BANDS,
    windowStart: new Date("2000-01-01T00:00:00Z"),
    now: NOW,
  };
  const at = (url: string, day: string, r: ExtractedRound): ExtractedItem => ({
    round: { ...r, announced_date: day },
    source: { url, host: hostOf(url), published: day },
    page_kind: "article",
    page_date: day,
  });

  test("a management buyout, a listed company's public offering, and a flagship fund close do not promote", () => {
    const res = resolveRounds(
      [
        at(
          "https://www.prnewswire.com/news-releases/reapit-management-team-completes-management-buyout-backed-by-accel-kkr-300532911.html",
          "2017-10-09",
          round({
            company_name: "Reapit",
            round_type_as_written: "management buyout",
            amount_as_written: "£60 million",
            evidence_quote: "Reapit Ltd has announced that its management team has partnered with Accel-KKR to purchase the business.",
          }),
        ),
        at(
          "https://ir.prenetics.com/news-releases/news-release-details/prenetics-announces-oversubscribed-approximately-48-million",
          "2025-10-27",
          round({
            company_name: "Prenetics",
            round_type_as_written: "public offering",
            amount_as_written: "approximately $48 million",
            evidence_quote:
              "Prenetics Global Limited (NASDAQ: PRE) today announced the successful pricing of a public offering of 2,992,596 Class A ordinary shares.",
          }),
        ),
        at(
          "https://www.bvp.com/news/bessemer-venture-partners-closes-4-6-billion",
          "2022-09-08",
          round({
            company_name: "Bessemer Venture Partners",
            round_type_as_written: "flagship fund BVP XII",
            amount_as_written: "$3.85 billion",
            evidence_quote:
              "Bessemer Venture Partners today announced the close of $4.6 billion in new capital across two funds, $3.85 billion for its twelfth flagship fund, BVP XII.",
          }),
        ),
      ],
      historyOpts,
    );
    expect(res.kept).toHaveLength(0);
    expect(res.dropped.notARound).toBe(3);
  });

  test("a real stageless earlier round still promotes: an unlabelled $103M, a strategic $2B, a spin-out's $10M", () => {
    const res = resolveRounds(
      [
        at(
          "https://temporal.io/blog/temporal-series-b",
          "2022-02-16",
          round({
            company_name: "Temporal Technologies",
            round_type_as_written: "$103M round of financing",
            amount_as_written: "$103M",
            evidence_quote: "Today Temporal Technologies announced the $103M round of financing led by Index Ventures.",
          }),
        ),
        at(
          "https://www.cnbc.com/2023/10/27/google-commits-to-invest-2-billion-in-openai-competitor-anthropic.html",
          "2023-10-27",
          round({
            company_name: "Anthropic",
            round_type_as_written: "investment",
            amount_as_written: "$2 billion",
            evidence_quote: "Google agreed to invest up to $2 billion in Anthropic, CNBC has confirmed.",
          }),
        ),
        at(
          "https://f2.ai/blog/launch-announcement",
          "2025-09-16",
          round({
            company_name: "F2",
            round_type_as_written: "equity round",
            amount_as_written: "$10 Million",
            evidence_quote:
              "To accelerate this vision, F2 has spun out of Arc with an oversubscribed $10M round, backed by nearly 50 of Arc's long-time investors, and the spin-out brings Arc and F2's combined capital raised to nearly $200 million.",
          }),
        ),
      ],
      historyOpts,
    );
    expect(res.kept.map((r) => r.company_name).sort()).toEqual(["Anthropic", "F2", "Temporal Technologies"]);
  });
});

describe("the 2026-09-25 store audit's non-startups are not rounds", () => {
  test("a listed company, a share offering, and a fund, whatever the stage label", () => {
    expect(
      notARound(
        "investment",
        "Ault & Company has invested $55 million of capital directly into Hyperscale Data, Inc., an NYSE American listed company through the purchase of convertible preferred stock.",
        "$55 million",
        "Hyperscale Data, Inc.",
      ),
    ).toBe("listed company");
    expect(
      notAStartupRound(
        "Series D",
        "Eco5Tech completed its closed series D share offering, allocating all 5.4 million shares amid strong investor demand.",
        "Eco5Tech S.A.",
      ),
    ).toBe("securities offering");
    expect(
      notAStartupRound("pre-seed", "Fortum is now a limited partner in Norrsken Evolve’s €62 million pre-seed fund.", "Norrsken Evolve"),
    ).toBe("fund close");
    expect(notAStartupRound("Series A", "Acme (Nasdaq: ACME) raised $20 million.", "Acme")).toBe("listed company");
    // BSE-listed Prime Industries, 2026-09-25 accuracy audit.
    expect(
      notAStartupRound(
        "Funding",
        "Preferential issue raised ₹11.86 crore at ₹42 per share, increasing authorized capital to ₹40 crore.",
        "Prime Industries",
      ),
    ).toBe("securities offering");
    expect(notAStartupRound(null, "The board approved a preferential allotment of 2.8 million shares to the promoters.", "Acme")).toBe(
      "securities offering",
    );
    expect(
      notAStartupRound(
        "Anchor investment",
        "AceVector has raised nearly $20 million (Rs 189 crore) from anchor investors ahead of its initial public offering (IPO), Entrackr reported.",
        "AceVector",
      ),
    ).toBe("securities offering");
    expect(notAStartupRound(null, "AceVector raises Rs 189 crore via anchor book", "AceVector")).toBe("securities offering");
    expect(notAStartupRound("seed", "Acme raised $3M in a seed round led by Fund One.", "Acme")).toBeNull();
    expect(notAStartupRound("Series A", "Acme's $12M Series A was anchored by Fund One, its anchor investor.", "Acme")).toBeNull();
  });

  test("an investor named as the company, a signed financing deal, and a projects headline", () => {
    expect(
      notARound(
        "investment",
        "the Office of the President of the Republic of Paraguay and J.P. Morgan Natural Capital announced an investment of approximately USD 200 million to develop a large-scale sustainable forestry platform in Paraguay.",
        "approximately USD 200 million",
        "J.P. Morgan Natural Capital",
      ),
    ).toBe("investor named as the company");
    const exergy =
      "Exergy, an Africa-focused integrated energy investor, and Mercuria, a global energy and commodities group, have signed a US$250 million financing deal in Lusaka.";
    expect(notARound("financing deal", exergy, "US$250 million", "Exergy")).toBe("investor named as the company");
    expect(
      notARound("financing deal", exergy.replace("an Africa-focused integrated energy investor, ", ""), "US$250 million", "Exergy"),
    ).toBe("financing agreement");
    expect(
      notARound(
        "funding",
        "Voltco raised $30 million.",
        "$30 million",
        "Voltco",
        "Mercuria And Voltco Sign Deal To Accelerate African Power Projects",
      ),
    ).toBe("project financing");
  });

  test("a startup whose investors are listed, or which a fund backs, is still a round", () => {
    expect(notAStartupRound("Series B", "Acme raised $40 million led by Nasdaq-listed Tencent.", "Acme")).toBeNull();
    expect(notAStartupRound("Series A", "Acme raised $10 million from the Acme Climate Fund and others.", "Acme")).toBeNull();
    expect(notAStartupRound("seed", "Acme, a startup backed by investor Sequoia, raised $5 million in seed funding.", "Acme")).toBeNull();
    expect(notARound("funding", "Acme, a startup backed by investor Sequoia, raised $5 million.", "$5 million", "Acme")).toBeNull();
    expect(notARound("funding", "Acme raised $20 million led by Goldman Sachs Asset Management.", "$20 million", "Acme")).toBeNull();
  });
});

describe("issuer of the financing, not merely its money kind", () => {
  const options = {
    stages: ROUTED_STAGES,
    stagelessBands: STAGE_BANDS,
    windowStart: new Date("2026-09-20"),
    now: new Date("2026-09-27T20:00:00Z"),
  };
  test.each([
    [
      "IIT Madras Unicorn Frontier Fund-I",
      "The IIT Madras Unicorn Frontier Fund-I, set up to provide long-term funding to deep-tech startups, has raised Rs 450 crore in its first funding round.",
      "The IIT Madras Unicorn Frontier Fund-I, set up to provide long-term funding to deep-tech startups, has raised Rs 450 crore in its first funding round.",
      "fund",
      "fund close, not an operating company's financing",
      "https://www.newindianexpress.com/cities/chennai/2026/Sep/27/iit-m-deep-tech-fund-raises-rs-450-cr-in-1st-close",
    ],
    [
      "Wheels India Limited",
      "Shares of Wheels India Ltd ended at ₹2,186.85, down by ₹53.85, or 2.40%, on the BSE.",
      "Wheels India Ltd on Thursday, September 24, launched a Rs 250 crore Qualified Institutional Placement (QIP) at an indicative issue price of Rs 2,088 per share, with a discount of up to 4.3%.",
      "listed_company",
      "public company securities offering",
      "https://www.cnbctv18.com/market/stocks/wheels-india-share-price-launches-rs-250-crore-qip-at-indicative-price-of-rs-2088-per-share-19998043.htm",
    ],
    [
      "State Startup Mission",
      "a government programme supporting startups",
      "State Startup Mission announced its ₹250 crore fund for startups.",
      "government_program",
      "government programme, not a startup round",
      "https://example.com/public-scheme",
    ],
  ] as const)("rejects %s with its issuer reason", (company, line, evidence, issuer, reason, sourceUrl) => {
    expect(issuerTypeFromEvidence(company, line, evidence, "funding")).toBe(issuer);
    const result = resolveRounds(
      [
        item(
          round({
            company_name: company,
            company_description: null,
            issuer_quote: line,
            issuer_type: issuer,
            issuer_checked: issuer,
            round_type_as_written: "funding",
            amount_as_written: issuer === "fund" ? "Rs 450 crore" : "Rs 250 crore",
            evidence_quote: evidence,
          }),
          sourceUrl,
        ),
      ],
      options,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.dropped.notARound).toBe(1);
    expect(result.rejected).toEqual([{ company_name: company, source_url: sourceUrl, disposition: "rejected", reason }]);
  });

  test("a startup financed by a fund is still an operating-company round", () => {
    const evidence = "Acme, a medical startup, raised $5 million led by Unicorn Frontier Fund-I.";
    expect(issuerTypeFromEvidence("Acme", "a medical startup", evidence, "seed")).toBe("operating_company");
    expect(nonStartupIssuerReason(issuerTypeFromEvidence("Acme", "a medical startup", evidence, "seed"))).toBeNull();
    const result = resolveRounds(
      [
        item(
          round({
            company_name: "Acme",
            company_description: "a medical startup",
            issuer_checked: "operating_company",
            round_type_as_written: "seed",
            amount_as_written: "$5 million",
            evidence_quote: evidence,
          }),
          "https://example.com/acme-funding",
        ),
      ],
      options,
    );
    expect(result.kept).toHaveLength(1);
    expect(result.rejected).toEqual([]);
    expect(
      issuerTypeFromEvidence(
        "Eapro Global Ltd",
        "an Indian operating company",
        "Eapro Global Ltd raised Rs 40 crore in a funding round as the company prepares for a proposed initial public offering in FY28.",
        "funding round",
      ),
    ).toBe("operating_company");
  });

  test("Jev independently vetoes an otherwise ambiguous issuer while rules still veto a false positive Jev vote", () => {
    const evidence = "Harbor Investment announced ₹250 crore in funding.";
    const base = round({
      company_name: "Harbor Investment",
      round_type_as_written: "funding",
      amount_as_written: "₹250 crore",
      evidence_quote: evidence,
    });
    const modelVeto = resolveRounds([item({ ...base, issuer_checked: "fund" }, "https://example.com/harbor")], options);
    expect(modelVeto.rejected[0]?.reason).toBe("fund close, not an operating company's financing");
    const rulesVeto = resolveRounds(
      [
        item(
          {
            ...base,
            company_name: "Wheels India",
            evidence_quote: "Wheels India completed a ₹250 crore QIP.",
            issuer_checked: "operating_company",
          },
          "https://example.com/wheels",
        ),
      ],
      options,
    );
    expect(rulesVeto.rejected[0]?.reason).toBe("public company securities offering");
  });
});

describe("audited stage details", () => {
  test("the dated company post beats a week-of marker on that same single-story page", () => {
    const evidence = "Today we're announcing a $5.3M seed round for Expanse, led by Crane Venture Partners.";
    const result = resolveRounds(
      [
        {
          ...item(
            round({
              company_name: "Expanse",
              round_type_as_written: "seed",
              amount_as_written: "$5.3M",
              evidence_quote: evidence,
              announced_date: "week of September 12, 2026",
            }),
            "https://expanse.sh/blog/expanse-raises-5-3m-seed",
          ),
          page_date: "2026-09-16",
          visible_article_date: true,
        },
      ],
      { stages: ROUTED_STAGES, windowStart: new Date("2026-09-01"), now: NOW },
    );
    expect(result.kept[0]).toMatchObject({ announced_date: "2026-09-16", date_precision: "day", date_basis: "page" });
  });

  test("a company's named round extension is not a standalone growth round", () => {
    const first =
      "Harvey today announced that Teachers' Venture Growth (TVG), the late-stage venture and growth investment platform of Ontario Teachers' Pension Plan (Ontario Teachers’), has completed a US$50 million investment in the company.";
    const next =
      "The investment is an extension of the recent round co-led by Diffusion and Lightspeed Venture Partners, and brings the total amount raised to US$600 million.";
    const [extracted] = pageItems(
      [round({ company_name: "Harvey", round_type_as_written: "investment", amount_as_written: "US$50 million", evidence_quote: first })],
      {
        url: "https://www.harvey.ai/blog/harvey-announces-investment-from-ontario-teachers-pension-plan-and-deepens-its-commitment-to-canada",
        host: "www.harvey.ai",
        title: "Harvey Announces Investment",
      },
      `${first} ${next}`,
      { page_kind: "press_release", page_date: "2026-09-24" },
    );
    expect(extracted.round.extension_quote).toBe(next);
    const result = resolveRounds([extracted], { stages: ROUTED_STAGES, stagelessBands: STAGE_BANDS, windowStart: WEEK, now: NOW });
    expect(result.kept[0]?.is_extension).toBe(true);
  });

  test("a private credit provider's own explanation makes strategic growth financing debt", () => {
    const evidence =
      "MCO (MyComplianceOffice), a leading provider of compliance management software for the financial services industry, today announced it has received strategic growth financing from Accel-KKR Credit Partners.";
    const debt =
      "Accel-KKR Credit Partners is a private credit fund managed by Accel-KKR, a global software-focused investment firm headquartered in Silicon Valley.";
    const [extracted] = pageItems(
      [round({ company_name: "MCO", round_type_as_written: "strategic growth financing", evidence_quote: evidence })],
      {
        url: "https://www.accel-kkr.com/mco-mycomplianceoffice-announces-strategic-growth-financing-from-accel-kkr-credit-partners/",
        host: "www.accel-kkr.com",
      },
      `${evidence}\n${debt}`,
      { page_kind: "press_release", page_date: "2026-09-23" },
    );
    expect(extracted.round.debt_quote).toBe(debt);
    const result = resolveRounds([extracted], { stages: ["debt"], windowStart: WEEK, now: NOW });
    expect(result.kept[0]?.stage).toBe("debt");
  });
});
