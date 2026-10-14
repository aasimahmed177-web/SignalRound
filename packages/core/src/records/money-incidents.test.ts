// The production incidents behind the money rules, pinned: each is the page as it read and what the
// feed must keep. Corgi's September extension took May's $1.3B valuation; FORE Biotherapeutics' extension
// lost its $67.4M and kept the series' $110M total as a valuation; Positron's $875M Series C showed its
// $375M first tranche; Cyera's $12B lost to a "$2.7 billion" because the longer string won the merge;
// Factory's $200M round was visible on a Reddit post alone.

import { describe, expect, test } from "vitest";
import { invariantBreach } from "./invariants.ts";
import { hostOf } from "./normalize.ts";
import { type ExtractedItem, resolveRounds } from "./resolve.ts";
import type { ExtractedRound } from "./schema.ts";
import { secondhandOnly } from "./source-fit.ts";
import {
  namedNearby,
  pickValuation,
  totalIsValuation,
  totalRepeatsAmount,
  unsupportedValuation,
  valuationSupport,
  withBasis,
} from "./valuation.ts";

const NOW = new Date("2026-09-27T12:00:00Z");
function round(p: Partial<ExtractedRound> & { company_name: string; round_type_as_written: string }): ExtractedRound {
  return {
    company_website: null,
    company_description: null,
    amount_as_written: null,
    amount_kind: "round",
    valuation_as_written: null,
    lead_investors: [],
    other_investors: [],
    announced_date: null,
    headquarters: null,
    sector: null,
    evidence_quote: "",
    source_url: null,
    is_background: false,
    is_rumor: false,
    ...p,
  };
}

function read(r: ExtractedRound, url: string, title: string): ExtractedItem {
  return { round: r, source: { url, host: hostOf(url), title }, page_kind: "article", grounded: true };
}

const resolve = (items: ExtractedItem[]) =>
  resolveRounds(items, {
    stages: ["seed", "series_a", "series_b", "series_c", "series_d_plus", "growth"],
    stagelessBands: ["early", "mid", "late"],
    windowStart: new Date("2026-05-01T00:00:00Z"),
    now: NOW,
  }).kept;

describe("Corgi: the extension's valuation is its own, never May's", () => {
  const FORBES = "https://www.forbes.com/sites/corgi-worth-5-billion/";
  const base = {
    company_name: "Corgi",
    round_type_as_written: "Series B extension",
    amount_as_written: "$64 million",
    announced_date: "2026-09-25",
    evidence_quote: "Corgi has raised $64 million in a Series B extension at a $5 billion valuation.",
  };
  const MAY = "The startup announced it was a unicorn in May with a $160 million Series B at a $1.3 billion valuation.";

  test("a valuation quoted from May's round is blank; the article's own $5 billion stands", () => {
    const [borrowed] = resolve([read(round({ ...base, valuation_as_written: "$1.3 billion", valuation_quote: MAY }), FORBES, "Corgi")]);
    expect(borrowed).toMatchObject({ amount: { value: 64 }, valuation_as_written: null });
    const [own] = resolve([
      read(round({ ...base, valuation_as_written: "$5 billion", valuation_quote: base.evidence_quote }), FORBES, "Corgi"),
    ]);
    expect(own).toMatchObject({ valuation_as_written: "$5 billion" });
    expect(own.valuation_claims).toEqual([{ value: "$5 billion", quote: base.evidence_quote, url: FORBES, tier: expect.any(Number) }]);
  });

  test("a valuation with no sentence of its own is blank, and an amount filed as a valuation is never one", () => {
    const [noQuote] = resolve([read(round({ ...base, valuation_as_written: "$5 billion" }), FORBES, "Corgi")]);
    expect(noQuote.valuation_as_written).toBeNull();
    const [asAmount] = resolve([
      read(
        round({ ...base, amount_as_written: "$5 billion", amount_kind: "valuation", evidence_quote: "Corgi is now worth $5 billion." }),
        FORBES,
        "Corgi",
      ),
    ]);
    expect(asAmount).toMatchObject({ valuation_as_written: null, amount: { value: null } });
  });

  test("the stored row's $1.3 billion has no sentence of its own; the headline supports the $5 billion fix", () => {
    const stored = {
      company_name: "Corgi",
      stage: "series_b" as const,
      amount: { value: 64, currency: "USD", as_written: "$64 million", usd_millions: 64, fx_rate: 1, fx_date: null },
      announced_date: "2026-09-25",
      financing_total_as_written: null,
      evidence_quotes: ["Corgi has raised $64 million in a Series B extension.", MAY],
      sources: [{ url: FORBES, host: "forbes.com", title: "Corgi Is Now Worth $5 Billion Thanks To Four Funding Rounds In Five Months" }],
    };
    expect(unsupportedValuation({ ...stored, valuation_as_written: "$1.3 billion" })).toBe("it is stated for another round ($160 million)");
    expect(unsupportedValuation({ ...stored, valuation_as_written: "$5 billion" })).toBeNull();
  });
});

describe("FORE Biotherapeutics: new money is the amount, the series total is neither the amount nor a valuation", () => {
  const RELEASE = "https://www.businesswire.com/news/home/fore-biotherapeutics-series-d-2-extension";
  const SENTENCE =
    "FORE Biotherapeutics today announced a $67.4 million extension of its Series D-2 financing, bringing the total Series D-2 raised to $110 million.";

  test("the extension publishes $67.4 million, keeps $110 million as the series total, and no valuation", () => {
    const [r] = resolve([
      read(
        round({
          company_name: "FORE Biotherapeutics",
          round_type_as_written: "Series D-2 extension",
          amount_as_written: "$67.4 million",
          amount_scope: "tranche",
          financing_total_as_written: "$110 million",
          financing_total_quote: SENTENCE,
          valuation_as_written: "$110 million",
          valuation_quote: SENTENCE,
          announced_date: "2026-09-10",
          evidence_quote: SENTENCE,
        }),
        RELEASE,
        "FORE Biotherapeutics Announces $67.4 Million Series D-2 Extension",
      ),
    ]);
    expect(r).toMatchObject({
      amount: { value: 67.4, as_written: "$67.4 million" },
      financing_total_as_written: "$110 million",
      valuation_as_written: null,
    });
    expect(
      valuationSupport("$110 million", SENTENCE, {
        company: "FORE Biotherapeutics",
        stage: "series_d_plus",
        amount: 67.4,
        announced: null,
      }),
    ).toBe("$110 million is a total raised, not a valuation");
  });
});

describe("Positron: one financing announced in tranches is its total", () => {
  const RELEASE = "https://www.prnewswire.com/news-releases/positron-875-million-series-c.html";
  const TOTAL =
    "Positron today announced an $875 million Series C financing, comprising a $375 million Series C and a $500 million Series C-1.";

  test("the $375 million first tranche with the financing's $875 million total publishes $875 million", () => {
    const [r] = resolve([
      read(
        round({
          company_name: "Positron",
          round_type_as_written: "Series C",
          amount_as_written: "$375 million",
          amount_scope: "tranche",
          financing_total_as_written: "$875 million",
          financing_total_quote: TOTAL,
          announced_date: "2026-09-16",
          evidence_quote: TOTAL,
        }),
        RELEASE,
        "Positron Announces $875 Million Series C Financing",
      ),
    ]);
    expect(r).toMatchObject({ amount: { value: 875, as_written: "$875 million" }, amount_scope: "financing_total" });
    expect(r.financing_total_as_written).toBeUndefined();
  });
});

describe("Cyera: the merge takes the checked, better-sourced valuation, never the longer string", () => {
  const RELEASE = "https://www.cyera.com/press-releases/cyera-raises-600-million-at-12-billion-valuation";
  const REUTERS =
    "https://www.reuters.com/legal/transactional/data-security-firm-cyera-raises-600-million-12-billion-valuation-2026-06-10/";
  const BLOG = "https://www.securityweek-roundup.example/cyera-funding";
  const base = {
    company_name: "Cyera",
    round_type_as_written: "funding round",
    amount_as_written: "$600 million",
    announced_date: "2026-06-10",
  };

  test("a total-funding sentence never becomes a valuation, and $12B stands from the release and Reuters", () => {
    const kept = resolve([
      read(
        round({
          ...base,
          valuation_as_written: "$12B",
          valuation_quote: "Cyera Raises $600 Million at $12 Billion Valuation",
          evidence_quote:
            "Cyera today announced its latest funding round of $600 million, quadrupling the company's valuation to $12 billion.",
        }),
        RELEASE,
        "Cyera Raises $600 Million at $12 Billion Valuation",
      ),
      read(
        round({
          ...base,
          valuation_as_written: "$2.7 billion",
          valuation_quote: "Cyera has raised a total of $2.7 billion since its founding.",
          evidence_quote: "Cyera raised $600 million.",
        }),
        BLOG,
        "Cyera funding",
      ),
      read(
        round({
          ...base,
          valuation_as_written: "$12 billion",
          valuation_quote: "Data security firm Cyera said on Wednesday it has raised $600 million at a $12 billion valuation.",
          evidence_quote: "Data security firm Cyera said on Wednesday it has raised $600 million at a $12 billion valuation.",
        }),
        REUTERS,
        "Data security firm Cyera raises $600 million at $12 billion valuation",
      ),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].valuation_as_written).toMatch(/^\$12/);
    expect(kept[0].valuation_claims?.map((c) => c.url).sort()).toEqual([RELEASE, REUTERS].sort());
  });

  test("between two checked claims, the better source and then the majority win", () => {
    const claim = (value: string, url: string, tier: number) => ({ value, quote: `Cyera is valued at ${value}.`, url, tier });
    expect(pickValuation([claim("$2.7 billion", BLOG, 0.3), claim("$12B", REUTERS, 0.9)])?.value).toBe("$12B");
    expect(
      pickValuation([
        claim("$2.7 billion", BLOG, 0.3),
        claim("$12B", "https://a.example", 0.3),
        claim("$12 billion", "https://b.example", 0.3),
      ])?.value,
    ).toBe("$12B");
    // An unquoted claim (a valuation stored before the rule) never outranks a checked one.
    expect(pickValuation([{ value: "$2.7 billion", quote: null, url: "", tier: 1 }, claim("$12B", BLOG, 0.3)])?.value).toBe("$12B");
  });
});

describe("Factory: a forum post alone never makes a round visible", () => {
  test("a Reddit thread alone is secondhand; the company's post or a publication is not", () => {
    const REDDIT = "https://www.reddit.com/r/singularity/comments/1abc/factory_raises_200m_at_5b/";
    expect(secondhandOnly([REDDIT], {})).toBe(true);
    expect(secondhandOnly([REDDIT, "https://factory.com/news/5-billion-valuation"], {})).toBe(false);
    expect(secondhandOnly([REDDIT, "https://www.reuters.com/business/factory-5-billion"], { "reuters.com": 0.9 })).toBe(false);
    expect(secondhandOnly(["https://news.ycombinator.com/item?id=1"], {})).toBe(true);
    // An unknown host the classifier read as an aggregator or as neither an announcement nor an article is secondhand too.
    const farm = "https://funding-digest.example/factory-200m";
    expect(secondhandOnly([farm], {}, new Map([[farm, "aggregator"]]))).toBe(true);
    expect(secondhandOnly([farm], {}, new Map([[farm, "news"]]))).toBe(false);
  });
});

describe("hard invariants go to Review", () => {
  const usd = (value: number, as_written: string) => ({
    value,
    currency: "USD",
    as_written,
    usd_millions: value,
    fx_rate: 1,
    fx_date: null,
  });
  const r = {
    id: "corgi:series_b:2026-05-28",
    stage: "series_b" as const,
    stage_as_written: "Series B1",
    is_extension: false,
    announced_date: "2026-05-28",
    amount: usd(106, "$106 million"),
    valuation_as_written: "$2.6 billion",
    financing_total_as_written: null,
    amount_scope: null,
  };
  const may7 = {
    id: "corgi:series_b:2026-05-07",
    stage: "series_b",
    stageAsWritten: "Series B",
    isExtension: false,
    announcedOn: "2026-05-07",
  };

  test("Corgi's B1 three weeks after its B is a tranche, not a duplicate; an unlinked second Series B is", () => {
    expect(invariantBreach(r, [may7])).toBeNull();
    expect(invariantBreach({ ...r, stage_as_written: "Series B" }, [may7])).toBe(
      "another Series B on 2026-05-07 within 60 days, with no extension or tranche between them",
    );
    expect(invariantBreach({ ...r, stage_as_written: "Series B" }, [{ ...may7, announcedOn: "2026-01-07" }])).toBeNull();
  });

  test("a valuation below the amount, or an amount at or above its financing total", () => {
    expect(invariantBreach({ ...r, valuation_as_written: "$50 million" }, [])).toBe(
      "the valuation $50 million is below the amount $106 million",
    );
    expect(invariantBreach({ ...r, valuation_as_written: null, financing_total_as_written: "$100 million" }, [])).toBe(
      "the amount $106 million is at or above the financing total $100 million",
    );
  });
});

// The re-ground dry run on the production copy (2026-09-27) blanked valuations that were right, on
// matching that was too strict. Each case is shaped on the string the log showed.
describe("the re-ground's false blanks: figures, conversions, the company, the basis, and the tier", () => {
  const round = (company: string, amount: number | null, stage: "growth" | "series_f" = "growth") => ({
    company,
    stage: stage === "series_f" ? ("series_d_plus" as const) : stage,
    amount,
    announced: null,
  });

  test("a figure written with separators, crore, Rs or INR, a currency after it, a hyphen, or in words is the same figure", () => {
    expect(valuationSupport("₹1930 crore", "Mokobara is now valued at ₹1,930 crore after the round.", round("Mokobara", null))).toBeNull();
    expect(
      valuationSupport("Rs 120 crore", "TimBuckDo raised the round at a valuation of Rs 120 crore.", round("TimBuckDo", null)),
    ).toBeNull();
    expect(
      valuationSupport("Rs 42 crore", "Creedom is valued at around INR 42 crore after the funding.", round("Creedom", null)),
    ).toBeNull();
    expect(valuationSupport("11.7B€", "Mistral AI is now valued at €11.7 billion.", round("Mistral AI", null))).toBeNull();
    expect(valuationSupport("$500M", "Xirang Kaiwu is valued at roughly 500 million US dollars.", round("Xirang Kaiwu", null))).toBeNull();
    expect(valuationSupport("$1.5B", "Temporal is now valued at $1.5-billion.", round("Temporal", null))).toBeNull();
  });

  test("Gecko Robotics and Quantexa: an earlier round recalled after 'from' or a dash does not take the valuation off this one", () => {
    const gecko =
      "The Series D funding round doubled the company’s valuation to $1.25 billion from $625 million since its previous round of funding, a $173 million Series C in December 2023, valuing the company at $633 million.";
    const geckoRound = { ...round("Gecko Robotics", 125, "series_f"), announced: "2025-06-12", named: true };
    expect(valuationSupport("$1.25 billion", gecko, geckoRound)).toBeNull();
    // The Series C's valuation, governed by "valuing the company at" right after that round's figure, is not this round's.
    expect(valuationSupport("$633 million", gecko, geckoRound)).toBe("it is stated for another round ($173 million)");
    // This round's own figure before the phrase still governs it.
    expect(
      valuationSupport("$500 million", "Acme raised $50 million in a Series D in June 2025, valuing the company at $500 million.", {
        ...geckoRound,
        company: "Acme",
        amount: 50,
      }),
    ).toBeNull();
    const quantexa =
      "The funding, a Series F, values Quantexa at $2.6 billion post-money — a significant jump from its last valuation of $1.8 billion in 2023.";
    expect(valuationSupport("$2.6 billion", quantexa, round("Quantexa", 175, "series_f"))).toBeNull();
    expect(valuationSupport("$1.8 billion", quantexa, round("Quantexa", 175, "series_f"))).not.toBeNull();
    // A phrase tied to another round before any dash or earlier figure still is.
    expect(
      valuationSupport("$97 million", "Helcim was valued at $97 million at its Series B in 2024.", round("Helcim", 20)),
    ).not.toBeNull();
  });

  test("Alan: a currency conversion in parentheses is the same figure, and 'brings its valuation to' is a valuation", () => {
    const alan2021 = "Alan raised €185 million ($220 million) at a valuation of €1.4 billion ($1.7 billion).";
    expect(valuationSupport("€1.4 billion", alan2021, round("Alan", 185))).toBeNull();
    expect(valuationSupport("$1.7 billion", alan2021, round("Alan", 185))).toBeNull();
    const alan2024 = "Alan raised €173 million in a Series F, which brings its valuation to €4 billion.";
    expect(valuationSupport("€4 billion", alan2024, round("Alan", 173, "series_f"))).toBeNull();
    // A running total is still a total.
    expect(valuationSupport("€500 million", "The round brings the total Alan has raised to €500 million.", round("Alan", 173))).toBe(
      "€500 million is a total raised, not a valuation",
    );
  });

  test("the company named by what it is, by the sentence before, or by the headline over the lead paragraph", () => {
    expect(
      valuationSupport("$900 million", "The Australian medical scribe startup is valued at $900 million.", round("Heidi", null)),
    ).toBeNull();
    const harvey =
      "# Harvey raises $300 million\n\nLegal AI startup Harvey has raised $300 million in a Series D. It is now valued at $3 billion.";
    expect(namedNearby("It is now valued at $3 billion.", harvey, null, "Harvey")).toBe(true);
    expect(valuationSupport("$3 billion", "It is now valued at $3 billion.", { ...round("Harvey", 300), named: true })).toBeNull();
    const nscale =
      "# Nscale raises $1.1 billion\n\nThe round values it at $14.6 billion, making it one of Europe's most valuable AI infrastructure businesses to date.";
    expect(namedNearby("The round values it at $14.6 billion", nscale, null, "Nscale")).toBe(true);
    // Neither the headline nor the quote's paragraph names the company: no.
    const elsewhere = "# AI infrastructure funding roundup\n\nRival Fluidstack raised $200 million last month. It is valued at $2 billion.";
    expect(namedNearby("It is valued at $2 billion.", elsewhere, null, "Nscale")).toBe(false);
    expect(valuationSupport("$2 billion", "It is valued at $2 billion.", round("Nscale", null))).toBe(
      "its sentence does not name the company",
    );
  });

  test("Wonder: pre-money stays on the figure", () => {
    expect(withBasis("$9 billion", "Wonder raised $600 million at a $9 billion pre-money valuation.")).toBe("$9 billion pre-money");
    expect(withBasis("$9 billion", "Wonder raised $600 million at a $9 billion valuation.")).toBe("$9 billion");
    expect(withBasis("$9 billion post-money", "at a $9 billion post-money valuation")).toBe("$9 billion post-money");
  });
});

// The second re-ground dry run on the production copy (2026-09-27): what was still blanked wrongly.
describe("the second re-ground's false blanks", () => {
  test("Proxima Fusion: 'a €411 million, or $468 million,' is one figure in two currencies, not another round", () => {
    expect(
      valuationSupport(
        "$2.7 billion",
        "Proxima Fusion raised a €411 million, or $468 million, funding round at a $2.7 billion valuation.",
        {
          company: "Proxima Fusion",
          stage: "series_a",
          amount: 411,
          announced: null,
        },
      ),
    ).toBeNull();
    // Two figures in one currency joined by "or" are still two figures.
    expect(
      valuationSupport("$2.7 billion", "Acme weighed raising $100 million or $150 million at a $2.7 billion valuation.", {
        company: "Acme",
        stage: "series_a",
        amount: 411,
        announced: null,
      }),
    ).toBe("it is stated for another round ($150 million)");
  });

  test("Impulse Space: Reuters' sentence states the stored $5.4 billion (the blank was the model's other quote, not the matcher)", () => {
    expect(
      valuationSupport("$5.4 billion", "The extension valued the company at $5.4 billion, according to a source close to the company.", {
        company: "Impulse Space",
        stage: "series_d_plus",
        amount: 300,
        announced: "2026-09-16",
      }),
    ).toBeNull();
  });

  test("a company named by its distinctive word, by any sentence of the quote's paragraph, or by the headline", () => {
    const round = (company: string) => ({ company, stage: "growth" as const, amount: null, announced: null });
    expect(valuationSupport("$465 million", "Heidi is now valued at $465 million.", round("Heidi Health"))).toBeNull();
    expect(
      valuationSupport(
        "just over $1 billion",
        "Precision is now valued at just over $1 billion.",
        round("Precision Neuroscience Corporation"),
      ),
    ).toBeNull();
    expect(valuationSupport("$14.6 billion", "Nscale is valued at $14.6 billion.", round("Neocloud Nscale"))).toBeNull();
    expect(
      valuationSupport("approximately $1.02 billion", "Space Labs is valued at approximately $1.02 billion.", round("Space Labs d.o.o.")),
    ).toBeNull();
    const caddi =
      "# Manufacturing startups raise big rounds\n\nThe round values it at $450 million. CADDi, the Tokyo-based procurement platform, raised $75 million from existing backers.";
    expect(namedNearby("The round values it at $450 million.", caddi, null, "CADDi")).toBe(true);
    const harvey =
      "# Harvey raises $300 million at a $3 billion valuation\n\nThe legal AI market is heating up.\n\nInvestors now value it at $3 billion, according to people familiar.";
    expect(namedNearby("Investors now value it at $3 billion, according to people familiar.", harvey, null, "Harvey")).toBe(true);
  });
});

// The third re-ground dry run on the production copy (2026-09-27): a valuation phrase governs its figure
// whatever else the sentence states. The quotes are the log's; the amounts are placeholders the rules
// only need to differ from the valuation.
describe("a figure a valuation phrase governs is this round's valuation", () => {
  const round = (company: string, amount: number | null, stage: "growth" | "series_a" | "series_b" | "series_c" = "growth") => ({
    company,
    stage,
    amount,
    announced: null,
  });

  test("the log's quotes pass", () => {
    const helcim =
      "The financing brings Helcim's total equity raised to $100 million since its 2022 Series A and lifts the company's valuation to $250 million, up from $97 million at its Series B in 2024.";
    expect(valuationSupport("$250 million CAD", helcim, round("Helcim", 40, "series_c"))).toBeNull();
    expect(valuationSupport("$97 million", helcim, round("Helcim", 40, "series_c"))).toBe(
      "it is an earlier valuation (up from $97 million)",
    );
    expect(
      valuationSupport(
        "$465 million",
        "This round values Heidi at $465 million and brings total funding to nearly $100 million.",
        round("Heidi Health", 65, "series_b"),
      ),
    ).toBeNull();
    expect(
      valuationSupport(
        "$120M",
        "This brings our total funding to over $20M and values Factory at $120M.",
        round("Factory", 15, "series_a"),
      ),
    ).toBeNull();
    expect(
      valuationSupport(
        "$7 billion",
        "The food hall company, which completed its acquisition of Grubhub for $650 million about four months ago, is now valued at over $7 billion, Bloomberg reports.",
        round("Wonder", 600),
      ),
    ).toBeNull();
    expect(
      valuationSupport(
        "Rs 700 crore",
        "According to a report, Mokobara is now valued at around Rs 700 crore or $84.5 million (post-money), having raised a total of $23.6 million to date.",
        round("Mokobara", 12, "series_b"),
      ),
    ).toBeNull();
    expect(
      valuationSupport(
        "around $6 billion",
        "TechCrunch reported the round was split between €468 million in equity and €132 million in debt, and valued the company at around $6 billion",
        round("Mistral", 600, "series_b"),
      ),
    ).toBeNull();
    // Shaped on the log's PR Newswire extension release; the exact sentence was not in the log I had.
    expect(
      valuationSupport(
        "more than $1.3 billion",
        "Higgsfield AI today announced a $130 million extension of its Series A, bringing its valuation to more than $1.3 billion.",
        round("Higgsfield", 80, "series_a"),
      ),
    ).toBeNull();
  });

  test("the correct blanks stay blank: totals, and a value that is not a valuation", () => {
    expect(
      valuationSupport(
        "125 million euros ($145 million)",
        "HyImpulse has now raised a total of 125 million euros ($145 million).",
        round("HyImpulse", 45),
      ),
    ).toBe("125 million euros is a total raised, not a valuation");
    expect(
      valuationSupport(
        "nearly RMB300 million",
        "The round brings Langxi Technology's total funding to nearly RMB300 million.",
        round("Langxi Technology", 100),
      ),
    ).toBe("RMB300 million is a total raised, not a valuation");
    expect(valuationSupport("$90 million", "The round brings Ajaib's total funding to $90 million.", round("Ajaib", 65))).toBe(
      "$90 million is a total raised, not a valuation",
    );
    expect(valuationSupport("$140 million", "The new funding brings Ema's total raised to $140 Million.", round("Ema", 50))).toBe(
      "$140 Million is a total raised, not a valuation",
    );
    expect(
      valuationSupport("more than $65 million", "The round brings NG.CASH's total funding to more than $65 Million.", round("NG.CASH", 20)),
    ).toBe("$65 Million is a total raised, not a valuation");
    expect(
      valuationSupport(
        "approximately $60 million in equity funding; more than $100 million including its credit facility",
        "Light raised approximately $60 million in equity funding.",
        round("Light", 60, "series_a"),
      ),
    ).toBe("not a valuation figure");
    // A phrase tied to another round does not govern: Corgi's May valuation stays blank.
    expect(
      valuationSupport("$1.3 billion", "Corgi was valued at $1.3 billion at its Series B in May.", {
        company: "Corgi",
        stage: "series_b",
        amount: 64,
        announced: "2026-09-25",
      }),
    ).not.toBeNull();
  });
});

describe("a financing total is never the valuation its sentence states", () => {
  test.each([
    ["$1.9B", "at a $1.9B valuation"],
    ["US$18bn", "valuing the company at US$18bn"],
    ["USD 1.4 billion", "The fintech’s valuation now stands at USD 1.4 billion."],
    ["$7.1 billion", "Clay raised a $115 million Series D at a $7.1 billion valuation on September 9, 2026."],
    ["$800M", "$800M Valuation"],
    ["$3.7 billion", "raises its valuation to $3.7 billion, up from $1.8 billion three months ago."],
    ["Rs 35 crore", "The Dough Therapy raised Rs 5.25 crore in a seed funding round at a valuation of Rs 35 crore."],
    ["€13.2 million (SEK 150 million)", "at a €13.2 million (SEK 150 million) valuation"],
  ])("%s is a valuation", (total, quote) => {
    expect(totalIsValuation(total, quote)).toBe(true);
  });

  test.each([
    [
      "roughly $835M",
      "Oxide Computer announced a $445M Series D led by Eclipse at a $6B valuation, bringing total funding to roughly $835M.",
    ],
    [
      "$500 million",
      "SiMa.ai today announced $150 million in Series C financing, bringing the total capital raised to $500 million and valuing the company at $1.45 billion.",
    ],
    ["$300 million", "It brings total funding to $300 million at a $1.6 billion valuation, one year after our $70 million Series B."],
    ["$185 million", "Total fundraising now stands at $185 million with a current valuation of $570 million."],
    [
      "$498.5 million",
      "This most recent round of funding brings Databricks’ total amount raised to $498.5 million and raises the company’s valuation to $2.75 billion.",
    ],
    ["€411M ($468M)", "raised €411M ($468M) in funding, at €2.4 Billion ($2.7 Billion) valuation"],
  ])("%s is money raised", (total, quote) => {
    expect(totalIsValuation(total, quote)).toBe(false);
  });
});

describe("a financing total that only repeats the round's amount is not a total", () => {
  test.each([
    [
      "$1 billion at a $22 billion valuation",
      "$1 billion",
      "Kalshi today announced a $1 billion Series F round at a $22 billion valuation",
    ],
    [
      "$400 million",
      "$400 million",
      "We’re announcing new funding to accelerate our work at Chai: $400 million at a $3.8 billion valuation.",
    ],
    ["$700 million", "$700 million", "FieldAI Raises $700 Million At $10 Billion Valuation Led By CEO Ali Agha"],
    ["$200 million", "$200M", "Type One Energy raises $200 million in Series B financing for fusion technology."],
  ])("%s repeats %s", (total, amount, quote) => {
    expect(totalRepeatsAmount(total, amount, quote, "round")).toBe(true);
  });

  test.each([
    ["€75 million", "€75 million", "the round has a total volume of €75 million", "round"],
    ["nearly $52 million", "$52 million", "nearly $52 million in combined seed and Series A financing.", "round"],
    ["$117 million", "$117 million", "Parallax came out of stealth this week with $117 million in funding to date.", "round"],
    ["$10 million", "$10 million", "bringing total capital raised to $10 million", "round"],
    ["$19 million", "$19 million", "raised about $19 million in financing across two seed rounds", "round"],
    ["$20 million", "$20m", "Ando has launched out of stealth with $20 million in pre-seed and seed funding", "round"],
    [
      "more than $48 million",
      "$48 million",
      "The company is backed by more than $48 million from investors including UPMC Enterprises.",
      "round",
    ],
    ["£4 million disclosed external funding", "£4 million", "£4 million disclosed external funding", "round"],
    ["$20 million", "$20 million", "Precision AI has raised a $20 million in Seed round of equity and grant funding.", "combined_rounds"],
    ["€4 million", "$4 million", "raised €4 million", "round"],
    ["$835 million", "$445 million", "bringing total funding to roughly $835M", "round"],
  ] as const)("%s beside %s stays", (total, amount, quote, scope) => {
    expect(totalRepeatsAmount(total, amount, quote, scope)).toBe(false);
  });
});
