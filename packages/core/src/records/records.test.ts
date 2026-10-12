import { describe, expect, test } from "vitest";
import { extractionCredits } from "../firecrawl/credits.ts";
import { cleanHeadlineName } from "./brand-name.ts";

test("headline descriptors never become part of the issuer's name", () => {
  expect(cleanHeadlineName("Reykjavík-based 50skills")).toBe("50skills");
  expect(cleanHeadlineName("Neocloud Nscale")).toBe("Nscale");
  expect(cleanHeadlineName("Chicago upstart")).toBe("Chicago upstart");
  expect(cleanHeadlineName("Chicago-based Sol")).toBe("Sol");
});

import { searchQueries, xProfileCandidates } from "../firecrawl/sweep.ts";
import { parsePreset } from "../presets/types.ts";
import { convertToUsd } from "./fx.ts";
import { dedupeInvestorNames } from "./investors.ts";
import {
  canonicalUrl,
  classifyStage,
  cleanText,
  dateFromUrl,
  dollarFromEvidence,
  formatWindow,
  hostOf,
  isBareDollar,
  isDataPointQuote,
  isDirectoryTitle,
  isTableRowQuote,
  monthRange,
  normalizeCompanyKey,
  normalizeInvestorKey,
  parseAmount,
  parseDate,
  parseWindow,
  registrableDomain,
  stageLabel,
  tbsFor,
  windowEndFor,
  windowLabel,
  windowQueryHint,
  windowStartFor,
  withinWindow,
} from "./normalize.ts";
import { backgroundByPageShape, headlineAmount } from "./page-shape.ts";
import type { ExtractedItem } from "./resolve.ts";
import {
  amountInEvidence,
  amountIsRoundTotal,
  dateFromWeekday,
  evidenceNamesAnotherCompany,
  evidenceNamesCompany,
  evidenceSaysExtension,
  evidenceStatesDay,
  firstOfTwoEntities,
  groundInvestorsOnListPage,
  isAlias,
  isGenericCompanyName,
  isListPage,
  isRecountPage,
  itemSource,
  mentionsPastPeriod,
  monthNamedIn,
  ownSiteAmongSources,
  reconcileInvestorLists,
  resolveRounds,
  sameRoundWindow,
  scoreConfidence,
  scrubHeadquarters,
  settleDate,
  slugMayName,
  splitByDisposition,
  surerDate,
  trustedWebsite,
} from "./resolve.ts";
import type { ExtractedRound, FeedRecord } from "./schema.ts";
import { PAGE_KINDS, roundsPageJsonSchema } from "./schema.ts";
import { normalizeSector, SECTOR_GROUPS, SECTORS, sectorLabel, sectorMembers, sectorMenu } from "./sectors.ts";

const NOW = new Date("2026-09-04T12:00:00Z");
const WEEK = windowStartFor("week", NOW);

function round(partial: Partial<ExtractedRound> & { company_name: string; round_type_as_written: string }): ExtractedRound {
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
    evidence_quote: `${partial.company_name} raised ${partial.amount_as_written ?? "an undisclosed amount"}.`,
    source_url: null,
    is_background: false,
    is_rumor: false,
    ...partial,
  };
}

function item(r: ExtractedRound, url: string, published?: string): ExtractedItem {
  return { round: r, source: { url, host: hostOf(url), published } };
}

describe("company keys", () => {
  test("collapses suffixes, punctuation, and case", () => {
    expect(normalizeCompanyKey("Acme, Inc.")).toBe("acme");
    expect(normalizeCompanyKey("ACME Technologies Ltd")).toBe("acme");
    expect(normalizeCompanyKey("Björn & Sons GmbH")).toBe("bjorn and sons");
    expect(normalizeCompanyKey("Autumn")).toBe(normalizeCompanyKey("autumn"));
  });
});

describe("investors: one firm, one entry", () => {
  test("one firm, several spellings; different firms stay apart", () => {
    const same = (a: string, b: string) => expect(normalizeInvestorKey(a), `${a} vs ${b}`).toBe(normalizeInvestorKey(b));
    const apart = (a: string, b: string) => expect(normalizeInvestorKey(a), `${a} vs ${b}`).not.toBe(normalizeInvestorKey(b));
    same("Arm", "Arm Holdings");
    same("M12", "M12 – Microsoft's Venture Fund");
    same("Sequoia", "Sequoia Capital");
    same("Lightspeed", "Lightspeed Venture Partners");
    same("Insight Partners", "Insight Partners (lead)");
    same("Tiger Global", "Tiger Global Management");
    apart("Sequoia Capital", "Sequoia Capital China");
    apart("Founders Fund", "Founders Future");
    apart("General Catalyst", "General Atlantic");
    expect(normalizeInvestorKey("Capital")).toBe("capital");
  });

  test("resolveRounds merges investor spellings across sources and shows the longer one", () => {
    const { kept } = resolveRounds(
      [
        item(
          round({
            company_name: "Chipco",
            round_type_as_written: "Series B",
            amount_as_written: "$300M",
            announced_date: "2026-09-02",
            lead_investors: ["a16z"],
            other_investors: ["Arm", "M12"],
          }),
          "https://news.example/chipco",
        ),
        item(
          round({
            company_name: "Chipco",
            round_type_as_written: "Series B",
            amount_as_written: "$300M",
            announced_date: "2026-09-02",
            lead_investors: ["a16z"],
            other_investors: ["Arm Holdings", "M12 – Microsoft's Venture Fund"],
          }),
          "https://wire.example/chipco",
        ),
      ],
      { stages: ["series_b"], windowStart: WEEK, now: NOW },
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].other_investors).toEqual(["Arm Holdings", "M12 – Microsoft's Venture Fund"]);
  });

  test("leads and participants reconcile across the two lists", () => {
    const r = reconcileInvestorLists(
      ["Carlyle-managed funds", "JPMorganChase's Strategic Investment Group"],
      ["Carlyle Group", "JPMorgan Chase", "Sequoia Capital"],
    );
    expect(r.lead_investors).toHaveLength(2);
    expect(r.other_investors).toEqual(["Sequoia Capital"]);
    expect(reconcileInvestorLists(["Curql"], ["Curql Collective", "Andreessen Horowitz"])).toEqual({
      lead_investors: ["Curql Collective"],
      other_investors: ["Andreessen Horowitz"],
    });
  });

  test("a list assembled from several sources keeps a firm's fullest form and keeps sibling funds apart", () => {
    expect(
      dedupeInvestorNames([
        "Fidelity Management & Research",
        "Fidelity",
        "Sequoia Capital",
        "Sequoia Heritage",
        "Maverick Silicon",
        "Maverick Capital",
      ]),
    ).toEqual(["Fidelity Management & Research", "Sequoia Capital", "Sequoia Heritage", "Maverick Silicon", "Maverick Capital"]);
  });

  test("on a page that lists several rounds an investor must be in the item's own sentence", () => {
    const bled = round({
      company_name: "Candid Health",
      round_type_as_written: "Series C",
      amount_as_written: "$120M",
      evidence_quote: "Candid Health raised $120M in a Series C led by Oak HC/FT, with participation from 8VC.",
      lead_investors: ["Oak HC/FT", "Versant Ventures"],
      other_investors: ["8VC", "Forbion", "Alexandria Venture Investments", "Sanofi Ventures"],
    });
    const grounded = groundInvestorsOnListPage(bled, true);
    expect(grounded.lead_investors).toEqual(["Oak HC/FT"]);
    expect(grounded.other_investors).toEqual(["8VC"]);
    // A single-story page keeps everything: the participants often sit in the next sentence.
    expect(groundInvestorsOnListPage(bled, false).other_investors).toHaveLength(4);
    // Through the resolver: two items on one page, each keeps only what its sentence names.
    const page = { url: "https://roundup.example/week", host: "roundup.example", title: "This week's deals", published: "2026-09-02" };
    const items = [
      { round: bled, source: page, page_kind: "roundup" as const, page_date: "2026-09-02" },
      {
        round: round({
          company_name: "Crystalys",
          round_type_as_written: "Series A",
          amount_as_written: "$50M",
          evidence_quote: "Crystalys raised $50M led by Versant Ventures with Forbion and Sanofi Ventures.",
          lead_investors: ["Versant Ventures"],
          other_investors: ["Forbion", "Sanofi Ventures", "Oak HC/FT"],
        }),
        source: page,
        page_kind: "roundup" as const,
        page_date: "2026-09-02",
      },
    ];
    const r = resolveRounds(items, {
      stages: ["series_a", "series_c"],
      windowStart: WEEK,
      now: NOW,
      rates: { date: "2026-09-02", perUsd: {} },
    });
    const candid = r.kept.find((k) => k.company_name === "Candid Health");
    const crystalys = r.kept.find((k) => k.company_name === "Crystalys");
    expect(candid?.other_investors).toEqual(["8VC"]);
    expect(crystalys?.other_investors.sort()).toEqual(["Forbion", "Sanofi Ventures"]);
  });
});

describe("sources: timelines and per-item links", () => {
  test("a per-item link whose slug names another company is not this round's source; the page is", () => {
    const page = { url: "https://newsletter.example/issue-42", host: "newsletter.example", title: "Issue 42", published: "2026-09-02" };
    // The extractor bound one company's item to another company's permalink on the same site.
    expect(itemSource(page, "https://newsletter.example/together-ai-raises-305m", "Kazimi").url).toBe(page.url);
    expect(itemSource(page, "https://newsletter.example/kazimi-raises-seed", "Kazimi").url).toBe(
      "https://newsletter.example/kazimi-raises-seed",
    );
    // An id-only path says nothing and is trusted; a two-word name needs half its tokens.
    expect(itemSource(page, "https://newsletter.example/p/8843", "Kazimi").url).toBe("https://newsletter.example/p/8843");
    expect(slugMayName("/thyme-care-raises-125m", "Thyme Care")).toBe(true);
    expect(slugMayName("/thyme-raises-125m", "Thyme Care")).toBe(true);
    expect(slugMayName("/owner-lands-240m", "Thyme Care")).toBe(false);
  });

  test("a post on an X profile is the source; an undated item on a timeline is a retrospective and drops", () => {
    const profile = "https://x.com/crunchbasenews";
    const { kept, dropped } = resolveRounds(
      [
        item(
          round({
            company_name: "Postco",
            round_type_as_written: "Series A",
            amount_as_written: "$12M",
            announced_date: "2026-09-03",
            source_url: "https://x.com/crunchbasenews/status/2095868614586905041",
          }),
          profile,
        ),
        // A "biggest rounds of the year" post: no date of its own.
        item(
          round({
            company_name: "Oldco",
            round_type_as_written: "Series B",
            amount_as_written: "$300M",
            source_url: "https://x.com/crunchbasenews/status/1",
          }),
          profile,
        ),
        // An off-site link is a reference to a page we did not read; the page stays the source.
        item(
          round({
            company_name: "Linkco",
            round_type_as_written: "Series A",
            amount_as_written: "$8M",
            announced_date: "2026-09-02",
            source_url: "https://techcrunch.com/2026/09/02/linkco",
          }),
          "https://news.example/roundup",
        ),
      ],
      { stages: ["series_a", "series_b"], windowStart: WEEK, now: NOW },
    );
    expect(dropped.undatedTimeline).toBe(1);
    expect(kept.map((r) => [r.company_name, r.sources[0].url])).toEqual([
      ["Postco", "https://x.com/crunchbasenews/status/2095868614586905041"],
      ["Linkco", "https://news.example/roundup"],
    ]);
    expect(kept[0].sources[0].host).toBe("x.com");
  });

  test("one post naming several rounds is a list: its items are undated even when the extractor dated them", () => {
    const post = "https://x.com/dealroomco/status/2095796459018838434";
    const listed = ["Multiverse", "Origin", "Oratomic"].map((name) =>
      item(
        round({
          company_name: name,
          round_type_as_written: "Series A",
          amount_as_written: "$300M",
          announced_date: "2026-09-04",
          source_url: post,
        }),
        "https://x.com/dealroomco",
      ),
    );
    // Two companies in one post is still an announcement (a co-announcement, a merger).
    const pair = ["Duo One", "Duo Two"].map((name) =>
      item(
        round({
          company_name: name,
          round_type_as_written: "Series A",
          amount_as_written: "$5M",
          announced_date: "2026-09-03",
          source_url: "https://x.com/dealroomco/status/2",
        }),
        "https://x.com/dealroomco",
      ),
    );
    const { kept, dropped } = resolveRounds([...listed, ...pair], { stages: ["series_a"], windowStart: WEEK, now: NOW });
    expect(dropped.undatedTimeline).toBe(3);
    expect(kept.map((r) => r.company_name).sort()).toEqual(["Duo One", "Duo Two"]);
  });

  test("x profiles become candidates and price at the X rate", () => {
    const preset = parsePreset({
      slug: "t",
      name: "t",
      description: "t",
      queries: ["q"],
      goal: "g",
      stages: ["series_a"],
      xAccounts: ["crunchbasenews", "dealroomco"],
    });
    const candidates = xProfileCandidates(preset);
    expect(candidates.map((c) => c.url)).toEqual(["https://x.com/crunchbasenews", "https://x.com/dealroomco"]);
    expect(candidates[0].kinds).toEqual(["x"]);
    expect(extractionCredits(candidates.map((c) => c.url))).toBe(68);
    expect(extractionCredits(["https://news.example/a", "https://x.com/dealroomco"])).toBe(5 + 34);
    expect(extractionCredits(3)).toBe(15);
    expect(() =>
      parsePreset({ slug: "t", name: "t", description: "t", queries: ["q"], goal: "g", stages: ["series_a"], xAccounts: ["@bad"] }),
    ).toThrow();
  });
});

describe("sectors", () => {
  test("free text lands on the vocabulary; canonical values pass through; unknown is other; empty is null", () => {
    const cases: Array<[string, string]> = [
      ["Artificial Intelligence (AI)", "ai"],
      ["Consumer/AI", "consumer"],
      ["AI infrastructure", "ai infrastructure"],
      ["data center", "ai infrastructure"],
      ["Fintech/payments infrastructure", "payments"],
      ["Insurtech/AI", "insurtech"],
      ["D2C Sneakers", "ecommerce"],
      ["Electric Mobility", "mobility"],
      ["nuclear energy", "energy"],
      ["Emergency Healthcare", "healthtech"],
      ["space launch services", "space"],
      ["HR Tech", "hr tech"],
      ["B2B SaaS", "enterprise software"],
      ["spiritual and devotion platform", "consumer"],
      ["Industrial Conglomerates", "manufacturing"],
      ["commodity analytics", "data and analytics"],
      ["Robotics", "robotics"],
      ["quantum computing", "quantum"],
      ["biotech", "biotech"],
      ["collaborative whiteboarding tool", "enterprise software"],
      ["shared docs and wikis for teams", "enterprise software"],
      ["something nobody classifies", "other"],
    ];
    for (const [input, want] of cases) expect(normalizeSector(input), input).toBe(want);
    expect(normalizeSector("")).toBeNull();
    expect(normalizeSector(null)).toBeNull();
    expect(sectorLabel("hr tech")).toBe("HR tech");
    expect(sectorLabel("ai")).toBe("AI");
    expect(sectorLabel(null)).toBe("");
    expect(sectorLabel("climate")).toBe("Climate");
    expect(sectorLabel("software")).toBe("Software");
  });

  test("every sector sits in exactly one group, and a group filter reads its sectors", () => {
    const placed = Object.values(SECTOR_GROUPS).flat();
    expect([...placed].sort()).toEqual([...SECTORS].sort());
    expect(new Set(placed).size).toBe(placed.length);
    expect(sectorMembers("AI")).toEqual(["ai", "ai infrastructure"]);
    expect(sectorMembers("health")).toEqual(["health", "healthtech", "biotech", "medtech"]);
    expect(sectorMembers("ai infrastructure")).toEqual(["ai infrastructure"]);
    expect(sectorMembers("toString")).toEqual(["tostring"]);
    expect(sectorMenu(["energy", "ai", "ai infrastructure", "other"])).toEqual([
      { value: "ai", label: "AI", inset: false },
      { value: "ai infrastructure", label: "AI infrastructure", inset: true },
      { value: "climate", label: "Climate and energy", inset: false },
      { value: "energy", label: "Energy", inset: true },
      { value: "other", label: "Other", inset: false },
    ]);
  });

  test("the extraction schema offers the vocabulary as an enum and the resolver maps anything else onto it", () => {
    const schema = roundsPageJsonSchema as unknown as {
      properties: { rounds: { items: { properties: { sector: { anyOf?: Array<{ enum?: string[] }>; enum?: string[] } } } } };
    };
    const sector = schema.properties.rounds.items.properties.sector;
    const values = sector.enum ?? sector.anyOf?.find((a) => a.enum)?.enum;
    expect(values).toContain("fintech");
    expect(values).toContain("other");
    const { kept } = resolveRounds(
      [
        item(
          round({
            company_name: "Sec Co",
            round_type_as_written: "Series A",
            announced_date: "2026-09-02",
            sector: "Fintech/payments infrastructure" as never,
          }),
          "https://news.example/sec",
        ),
      ],
      { stages: ["series_a"], windowStart: WEEK, now: NOW },
    );
    expect(kept[0].sector).toBe("payments");
  });
});

describe("placeholder text", () => {
  test("placeholders the model writes where the schema asked for null", () => {
    for (const s of [
      "Not stated.",
      "not stated",
      "Not specified",
      "Undisclosed",
      "N/A",
      "n/a",
      "None",
      "null",
      "unknown",
      "  ",
      "-",
      "TBD",
    ]) {
      expect(cleanText(s), s).toBeNull();
    }
    expect(cleanText("  Acme builds robots.  ")).toBe("Acme builds robots.");
    expect(cleanText("Not Boring Capital")).toBe("Not Boring Capital");
    expect(cleanText("Nona")).toBe("Nona");
    expect(cleanText(null)).toBeNull();
  });

  test("resolveRounds nulls placeholder text and drops placeholder investors", () => {
    const { kept } = resolveRounds(
      [
        item(
          round({
            company_name: "Blank Co",
            round_type_as_written: "Series A",
            company_description: "Not stated.",
            amount_as_written: "Undisclosed",
            headquarters: "N/A",
            sector: "unknown" as never,
            valuation_as_written: "Not stated",
            lead_investors: ["Not stated", "Real Fund"],
            other_investors: ["None"],
            announced_date: "2026-09-02",
          }),
          "https://news.example/blank",
        ),
      ],
      { stages: ["series_a"], windowStart: WEEK, now: NOW },
    );
    expect(kept).toHaveLength(1);
    const r = kept[0];
    expect(r.company_description).toBeNull();
    expect(r.amount.as_written).toBeNull();
    expect(r.amount.value).toBeNull();
    expect(r.headquarters).toBeNull();
    expect(r.sector).toBeNull();
    expect(r.valuation_as_written).toBeNull();
    expect(r.lead_investors).toEqual(["Real Fund"]);
    expect(r.other_investors).toEqual([]);
  });
});

describe("stages", () => {
  test("an unlabelled round of any size names no stage: a $40 billion funding round is not a growth round", () => {
    const { kept } = resolveRounds(
      [
        item(
          round({
            company_name: "OpenAI",
            round_type_as_written: "funding round",
            amount_as_written: "$40 billion",
            announced_date: "2026-09-03",
            evidence_quote: "OpenAI raised $40 billion in a funding round led by SoftBank.",
          }),
          "https://news.example/2026/09/03/openai-raises-40-billion",
        ),
      ],
      { stages: ["other", "growth"], windowStart: WEEK, now: NOW },
    );
    expect(kept[0]?.stage).toBe("other");
    expect(kept[0]?.stage_as_written).toBe("funding round");
  });

  test("stageLabel: a label that names no stage reads funding round; a qualified one keeps its words", () => {
    for (const label of ["investment", "Funding", "equity capital raise", "latest round", "unknown", " funding round "])
      expect(stageLabel(label), label).toBe("funding round");
    for (const label of [
      "strategic investment",
      "Form D (equity)",
      "Series A",
      "pre-seed round",
      "token purchase",
      "financing",
      "equity financing round",
    ])
      expect(stageLabel(label), label).toBe(label);
  });

  test("maps labels onto the stage enum", () => {
    expect(classifyStage("Series A")).toEqual({ stage: "series_a", isExtension: false });
    expect(classifyStage("$40M Series A")).toEqual({ stage: "series_a", isExtension: false });
    expect(classifyStage("Series A extension")).toEqual({ stage: "series_a", isExtension: true });
    expect(classifyStage("Series A-1")).toEqual({ stage: "series_a", isExtension: false });
    expect(classifyStage("series b round")).toEqual({ stage: "series_b", isExtension: false });
    expect(classifyStage("Series B2")).toEqual({ stage: "series_b", isExtension: false });
    expect(classifyStage("Series C")).toEqual({ stage: "series_c", isExtension: false });
    expect(classifyStage("Series E")).toEqual({ stage: "series_d_plus", isExtension: false });
    expect(classifyStage("Seed")).toEqual({ stage: "seed", isExtension: false });
    // Pre-Series A is the bridge between seed and A, not a pre-seed.
    expect(classifyStage("pre-Series A")).toEqual({ stage: "bridge", isExtension: false });
    expect(classifyStage("Pre-A")).toEqual({ stage: "pre_a", isExtension: false });
    expect(classifyStage("Form D (SAFE)")).toEqual({ stage: "convertible", isExtension: false });
    expect(classifyStage("Venture debt facility")).toEqual({ stage: "debt", isExtension: false });
    expect(classifyStage("Growth round")).toEqual({ stage: "growth", isExtension: false });
    expect(classifyStage("Series AA")).toEqual({ stage: "other", isExtension: false });
  });
});

describe("dates and windows", () => {
  test("parseDate handles ISO, prose, and relative dates", () => {
    expect(parseDate("2026-09-02", NOW)?.toISOString().slice(0, 10)).toBe("2026-09-02");
    expect(parseDate("Sep 1, 2026", NOW)?.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(parseDate("2 days ago", NOW)?.toISOString().slice(0, 10)).toBe("2026-09-02");
    expect(parseDate("not a date", NOW)).toBeNull();
    expect(parseDate(null, NOW)).toBeNull();
  });
  test("a source's published text becomes YYYY-MM-DD on the record, or nothing", () => {
    const dated = (published?: string) =>
      resolveRounds(
        [
          item(
            round({ company_name: "Datey", round_type_as_written: "Series A", announced_date: "2026-09-02" }),
            "https://news.example/datey",
            published,
          ),
        ],
        { stages: ["series_a"], windowStart: WEEK, now: NOW },
      ).kept[0]?.sources[0]?.published;
    expect(dated("9 hours ago")).toBe("2026-09-04");
    expect(dated("2026-09-03T13:20:00.000Z")).toBe("2026-09-03");
    expect(dated("Sep 1, 2026")).toBe("2026-09-01");
    expect(dated("no date here")).toBeUndefined();
    expect(dated(undefined)).toBeUndefined();
  });
  test("dateFromUrl and window helpers", () => {
    expect(dateFromUrl("https://techcrunch.com/2026/09/02/hiddenlayer-nabs-100m/")?.toISOString().slice(0, 10)).toBe("2026-09-02");
    expect(dateFromUrl("https://x.example/funding-digest-2026-08-14")?.toISOString().slice(0, 10)).toBe("2026-08-14");
    expect(dateFromUrl("https://x.example/article-302864996.html")).toBeNull();
    expect(tbsFor("day")).toBe("sbd:1,qdr:d");
    expect(WEEK.toISOString().slice(0, 10)).toBe("2026-08-28");
    expect(withinWindow(new Date("2026-09-01"), WEEK, NOW)).toBe(true);
    expect(withinWindow(new Date("2026-08-20"), WEEK, NOW)).toBe(false);
  });
});

describe("month windows", () => {
  const day = (d: Date | undefined) => d?.toISOString().slice(0, 10);

  test("parseWindow reads day, week, month, and month-N; formatWindow writes them back", () => {
    expect(parseWindow("day")).toBe("day");
    expect(parseWindow("week")).toBe("week");
    expect(parseWindow("month")).toEqual({ kind: "month", back: 0 });
    expect(parseWindow("month-0")).toEqual({ kind: "month", back: 0 });
    expect(parseWindow("month-1")).toEqual({ kind: "month", back: 1 });
    expect(parseWindow("month-12")).toEqual({ kind: "month", back: 12 });
    for (const bad of ["", "months", "month-", "month--1", "month-1.5", "Month", "year", "month-x"]) {
      expect(() => parseWindow(bad), bad).toThrow(/unknown window/);
    }
    expect(formatWindow("day")).toBe("day");
    expect(formatWindow({ kind: "month", back: 0 })).toBe("month");
    expect(formatWindow({ kind: "month", back: 2 })).toBe("month-2");
    for (const spec of ["day", "week", "month", "month-1", "month-7"]) expect(formatWindow(parseWindow(spec))).toBe(spec);
  });

  test("monthRange is the UTC calendar month, back N months, as [start, end)", () => {
    const sep = monthRange(0, NOW);
    expect([day(sep.start), day(sep.end)]).toEqual(["2026-09-01", "2026-10-01"]);
    const jul = monthRange(2, NOW);
    expect([day(jul.start), day(jul.end)]).toEqual(["2026-07-01", "2026-08-01"]);
    // A year boundary: nine months before September is December of the year before.
    const dec = monthRange(9, NOW);
    expect([day(dec.start), day(dec.end)]).toEqual(["2025-12-01", "2026-01-01"]);
    // From January, one month back is December.
    const fromJan = monthRange(1, new Date("2026-01-15T00:00:00Z"));
    expect([day(fromJan.start), day(fromJan.end)]).toEqual(["2025-12-01", "2026-01-01"]);
    // February is 28 days here and its end is March 1, whatever the day of the anchor.
    const feb = monthRange(1, new Date("2026-03-31T23:59:59Z"));
    expect([day(feb.start), day(feb.end)]).toEqual(["2026-02-01", "2026-03-01"]);
    expect((feb.end.getTime() - feb.start.getTime()) / 86_400_000).toBe(28);
    // A leap February.
    const leap = monthRange(0, new Date("2028-02-10T00:00:00Z"));
    expect((leap.end.getTime() - leap.start.getTime()) / 86_400_000).toBe(29);
    // The anchor's UTC month counts, not the local one: 23:30 UTC on the 31st is still that month.
    expect(day(monthRange(0, new Date("2026-08-31T23:30:00Z")).start)).toBe("2026-08-01");
  });

  test("windowStartFor and windowEndFor bound a month; day and week run to now with no end", () => {
    const m2 = parseWindow("month-2");
    expect(day(windowStartFor(m2, NOW))).toBe("2026-07-01");
    expect(day(windowEndFor(m2, NOW))).toBe("2026-08-01");
    expect(day(windowStartFor(parseWindow("month"), NOW))).toBe("2026-09-01");
    expect(day(windowEndFor(parseWindow("month"), NOW))).toBe("2026-10-01");
    expect(windowEndFor("day", NOW)).toBeUndefined();
    expect(windowEndFor("week", NOW)).toBeUndefined();
    expect(day(windowStartFor("day", NOW))).toBe("2026-09-03");
  });

  test("tbs: the month to date is qdr:m, a past month falls back to the year plus a month hint in the query", () => {
    expect(tbsFor("week")).toBe("sbd:1,qdr:w");
    expect(tbsFor(parseWindow("month"))).toBe("sbd:1,qdr:m");
    expect(tbsFor(parseWindow("month-1"))).toBe("qdr:y");
    expect(tbsFor(parseWindow("month-6"))).toBe("qdr:y");
    expect(windowQueryHint("week", NOW)).toBeNull();
    expect(windowQueryHint(parseWindow("month"), NOW)).toBeNull();
    expect(windowQueryHint(parseWindow("month-2"), NOW)).toBe("July 2026");
    expect(windowQueryHint(parseWindow("month-9"), NOW)).toBe("December 2025");
    const preset = parsePreset({
      slug: "t",
      name: "T",
      description: "",
      goal: "",
      stages: ["series_a"],
      queries: ["series A funding", "raises Series B"],
    });
    expect(searchQueries(preset, "week", NOW)).toEqual(["series A funding", "raises Series B"]);
    expect(searchQueries(preset, parseWindow("month-2"), NOW)).toEqual(["series A funding July 2026", "raises Series B July 2026"]);
  });

  test("windowLabel names a past month, and shows day, week, and month as written", () => {
    expect(windowLabel("day", NOW)).toBe("day");
    expect(windowLabel("week", NOW)).toBe("week");
    expect(windowLabel(parseWindow("month"), NOW)).toBe("month");
    expect(windowLabel(parseWindow("month-2"), NOW)).toBe("Jul 2026");
    expect(windowLabel(parseWindow("month-9"), NOW)).toBe("Dec 2025");
  });

  test("withinWindow with an exclusive end, and resolveRounds keeping only the month's announcements", () => {
    const jul = monthRange(2, NOW);
    expect(withinWindow(new Date("2026-07-01"), jul.start, NOW, jul.end)).toBe(true);
    expect(withinWindow(new Date("2026-07-31T23:00:00Z"), jul.start, NOW, jul.end)).toBe(true);
    expect(withinWindow(new Date("2026-08-01"), jul.start, NOW, jul.end)).toBe(false);
    // The day of slack before the start still applies; the end is exact.
    expect(withinWindow(new Date("2026-06-30T12:00:00Z"), jul.start, NOW, jul.end)).toBe(true);
    expect(withinWindow(new Date("2026-06-29"), jul.start, NOW, jul.end)).toBe(false);

    const rounds = (name: string, date: string) =>
      item(round({ company_name: name, round_type_as_written: "Series A", announced_date: date }), `https://news.example/${name}`);
    const { kept, dropped } = resolveRounds(
      [rounds("Junely", "2026-06-15"), rounds("Julyco", "2026-07-15"), rounds("Lastday", "2026-07-31"), rounds("Augusta", "2026-08-01")],
      { stages: ["series_a"], windowStart: jul.start, windowEnd: jul.end, now: NOW },
    );
    expect(kept.map((r) => r.company_name).sort()).toEqual(["Julyco", "Lastday"]);
    expect(dropped.outOfWindow).toBe(2);
    // Without an end, the same month start keeps everything since July.
    const open = resolveRounds([rounds("Julyco", "2026-07-15"), rounds("Augusta", "2026-08-01")], {
      stages: ["series_a"],
      windowStart: jul.start,
      now: NOW,
    });
    expect(open.kept).toHaveLength(2);
  });
});

describe("urls and domains", () => {
  test("hostOf, registrableDomain, canonicalUrl", () => {
    expect(hostOf("https://www.Example.com/a")).toBe("example.com");
    expect(registrableDomain("https://news.crunchbase.com/x")).toBe("crunchbase.com");
    expect(registrableDomain("regentcraft.com")).toBe("regentcraft.com");
    expect(registrableDomain(null)).toBeNull();
    expect(canonicalUrl("https://a.example/post?utm_source=x&id=1#top")).toBe("https://a.example/post?id=1");
    expect(canonicalUrl("https://www.marketwatch.com/story/x-b64c1b60?mod=markets")).toBe(
      canonicalUrl("https://www.marketwatch.com/story/x-b64c1b60"),
    );
    expect(canonicalUrl("https://a.example/p?ncid=abc&guce_referrer=x&keep=1")).toBe("https://a.example/p?keep=1");
    // Google's result-tracking id: The Times' article arrived as nine sources, one per search.
    expect(canonicalUrl("https://www.thetimes.co.uk/article/matter-machine-v73fc9jlg?srsltid=AU7gw4XBEAeE")).toBe(
      "https://www.thetimes.com/article/matter-machine-v73fc9jlg",
    );
    // A search engine's click id and a publisher's own switches are the same article too.
    expect(canonicalUrl("https://www.wsj.com/tech/ai/story-88ef9f0a?eafs_enabled=false")).toBe(
      "https://www.wsj.com/tech/ai/story-88ef9f0a",
    );
    expect(canonicalUrl("https://a.example/p?srsltid=AfmBOo&feedref=rss&ocid=x&smid=tw&utm=1&id=7")).toBe("https://a.example/p?id=7");
  });

  test("canonicalUrl names the publisher's main host for an article served under another", () => {
    const same = (alias: string, main: string) => expect(canonicalUrl(alias), alias).toBe(canonicalUrl(main));
    same(
      "https://www.thetimes.co.uk/business/article/matter-machine-v73fc9jlg",
      "https://www.thetimes.com/business/article/matter-machine-v73fc9jlg",
    );
    same(
      "https://m.economictimes.com/tech/funding/x/articleshow/134545702.cms",
      "https://economictimes.indiatimes.com/tech/funding/x/articleshow/134545702.cms",
    );
    same("https://uk.finance.yahoo.com/news/roblox-ceo-050002563.html", "https://finance.yahoo.com/news/roblox-ceo-050002563.html");
    same("https://ae.marketscreener.com/news/relay-ce785ad3d98af121", "https://www.marketscreener.com/news/relay-ce785ad3d98af121");
    same(
      "https://www.prnewswire.co.uk/news-releases/signsplit-302897779.html",
      "https://www.prnewswire.com/news-releases/signsplit-302897779.html",
    );
    same("https://securitybrief.com.au/story/cyera", "https://securitybrief.asia/story/cyera");
    expect(canonicalUrl("https://securitybrief.asia/story/cyera")).toBe("https://securitybrief.news/story/cyera");
    // Another publisher on a lookalike host, and a host that only ends like an alias, stay as they are.
    expect(canonicalUrl("https://www.thetimes.co.za/news/x")).toBe("https://www.thetimes.co.za/news/x");
    expect(canonicalUrl("https://notthetimes.co.uk/x")).toBe("https://notthetimes.co.uk/x");
    expect(canonicalUrl("https://news.yahoo.com/x")).toBe("https://news.yahoo.com/x");
  });
});

describe("money", () => {
  test("parseAmount reads currencies and units", () => {
    expect(parseAmount("$46 million")).toEqual({ value: 46, currency: "USD" });
    expect(parseAmount("€15M")).toEqual({ value: 15, currency: "EUR" });
    expect(parseAmount("US$26 million (AU$36 million)")).toEqual({ value: 26, currency: "USD" });
    expect(parseAmount("another two million dollars")).toEqual({ value: 2, currency: "USD" });
    expect(parseAmount("fifteen million euros")).toEqual({ value: 15, currency: "EUR" });
    expect(parseAmount("Rs 24 crore")).toEqual({ value: 240, currency: "INR" });
    expect(parseAmount("RMB 3 billion")).toEqual({ value: 3000, currency: "CNY" });
    expect(parseAmount("46000000")).toEqual({ value: 46, currency: null });
    expect(parseAmount("$10 million (37,500,000 SAR)")).toEqual({ value: 10, currency: "USD" });
    expect(parseAmount("$9094")).toEqual({ value: null, currency: "USD" });
    expect(parseAmount(null)).toEqual({ value: null, currency: null });
  });

  test("currency words count as indicators, so the earliest one still wins", () => {
    expect(parseAmount("150 million US dollars (about 1.01 billion yuan)")).toEqual({ value: 150, currency: "USD" });
    expect(parseAmount("40 million euros")).toEqual({ value: 40, currency: "EUR" });
    expect(parseAmount("12 million pounds")).toEqual({ value: 12, currency: "GBP" });
    expect(parseAmount("500 million rupees")).toEqual({ value: 500, currency: "INR" });
    expect(parseAmount("1.01 billion yuan (150 million dollars)")).toEqual({ value: 1010, currency: "CNY" });
  });

  test("a code glued to or trailing the figure names the currency", () => {
    expect(parseAmount("USD1.6m")).toEqual({ value: 1.6, currency: "USD" });
    expect(parseAmount("$53 million CAD")).toEqual({ value: 53, currency: "CAD" });
    expect(parseAmount("$10 million (37,500,000 SAR)")).toEqual({ value: 10, currency: "USD" });
  });

  test("a bare dollar stays USD on a national press site without a matching explicit marker", () => {
    expect(isBareDollar("$46 million")).toBe(true);
    expect(isBareDollar("US$46 million")).toBe(false);
    expect(isBareDollar("$53 million CAD")).toBe(false);
    expect(isBareDollar("46 million dollars")).toBe(false);
    expect(dollarFromEvidence("$5 million", parseAmount("$5 million"), "Australian startup raised $5 million")).toEqual({
      value: 5,
      currency: "USD",
    });
    expect(dollarFromEvidence("$5 million", parseAmount("$5 million"), "New Zealand startup raised NZ$5 million")).toEqual({
      value: 5,
      currency: "NZD",
    });
    expect(dollarFromEvidence("US$5 million", parseAmount("US$5 million"), "Australian startup raised US$5 million")).toEqual({
      value: 5,
      currency: "USD",
    });
    expect(dollarFromEvidence("$5 million", parseAmount("$5 million"), "Australian startup raised A$6 million")).toEqual({
      value: 5,
      currency: "USD",
    });
  });

  test("an extension's figure is the round total, not the extension", () => {
    expect(evidenceSaysExtension("Quantum Motion extends Series C, expands $160m round")).toBe(true);
    expect(evidenceSaysExtension("Frenos raised $1.52 million in a seed extension round")).toBe(true);
    expect(evidenceSaysExtension("Acme raised $20M in Series A funding")).toBe(false);
    expect(evidenceSaysExtension("Firelight raised a $10M seed round to expand into new markets")).toBe(false);
    expect(evidenceSaysExtension("Quaise Energy expands its Series B with a $35M extension")).toBe(true);
    expect(evidenceSaysExtension("Acme extends the round to $200M")).toBe(true);
    expect(evidenceSaysExtension("Customers treat Henry as an extension of their team during Series A funding.")).toBe(false);
    expect(evidenceSaysExtension("This new funding mentions the previous Series A funding round and extension.")).toBe(false);
    expect(amountIsRoundTotal("Quantum Motion extends Series C, expands $160m round")).toBe(true);
    expect(amountIsRoundTotal("bringing the Series B round to $200M")).toBe(true);
    expect(amountIsRoundTotal("Frenos raised $1.52 million in a seed extension round")).toBe(false);
  });

  test("text the parser cannot read as money is not shown as the amount", () => {
    const { kept } = resolveRounds(
      [
        item(
          round({ company_name: "Noise Co", round_type_as_written: "Series B", amount_as_written: "$9,094", announced_date: "2026-09-03" }),
          "https://news.example/noise",
        ),
        item(
          round({
            company_name: "Words Co",
            round_type_as_written: "Series A",
            amount_as_written: "seven figures",
            announced_date: "2026-09-03",
          }),
          "https://news.example/words",
        ),
        item(
          round({
            company_name: "Fine Co",
            round_type_as_written: "Series A",
            amount_as_written: "Rs 24 crore",
            announced_date: "2026-09-03",
          }),
          "https://news.example/fine",
        ),
      ],
      { stages: ["series_a", "series_b"], windowStart: WEEK, now: NOW },
    );
    const byName = Object.fromEntries(kept.map((r) => [r.company_name, r.amount]));
    expect(byName["Noise Co"]).toMatchObject({ value: null, as_written: null });
    expect(byName["Words Co"]).toMatchObject({ value: null, as_written: null });
    expect(byName["Fine Co"]).toMatchObject({ value: 240, currency: "INR", as_written: "Rs 24 crore" });
  });

  test("an amount the evidence does not state is not the round's", () => {
    expect(amountInEvidence("$10 billion", "a16z is excited to co-lead its Series A.")).toBe(false);
    expect(amountInEvidence("$46 million", "Acme raised $46 million in Series A funding led by X.")).toBe(true);
    expect(amountInEvidence("$1.5 billion", "Acme closed a $1.5B round.")).toBe(true);
    expect(amountInEvidence("€15M", "Acme has raised €15 million.")).toBe(true);
    expect(amountInEvidence("$155 million", "Acme raised $15 million.")).toBe(false);
    expect(amountInEvidence(null, "no amount at all")).toBe(true);
    // Through the resolver: the record keeps its round but carries no amount.
    const kept = resolveRounds(
      [
        {
          round: round({
            company_name: "Volta",
            round_type_as_written: "Series A",
            amount_as_written: "$10 billion",
            amount_kind: "round",
            evidence_quote: "a16z is excited to co-lead its Series A.",
            announced_date: "2026-08-04",
          }),
          source: { url: "https://a16z.com/investing-in-volta/", host: "a16z.com", title: "Investing in Volta", published: "2026-08-04" },
          page_kind: "article",
          page_date: "2026-08-04",
        },
      ],
      {
        stages: ["series_a"],
        windowStart: new Date("2026-08-01T00:00:00Z"),
        now: new Date("2026-08-05T12:00:00Z"),
        rates: { date: "2026-08-05", perUsd: {} },
      },
    ).kept;
    expect(kept).toHaveLength(1);
    expect(kept[0].amount.value).toBeNull();
    expect(kept[0].amount.as_written).toBeNull();
  });

  test("convertToUsd uses a dated rate and never guesses", () => {
    const rates = { date: "2026-09-02", perUsd: { EUR: 0.9, INR: 83 } };
    expect(convertToUsd(15, "EUR", rates)).toEqual({ usd_millions: 16.667, fx_rate: 0.9, fx_date: "2026-09-02" });
    expect(convertToUsd(46, "USD", rates)).toEqual({ usd_millions: 46, fx_rate: 1, fx_date: "2026-09-02" });
    expect(convertToUsd(15, "EUR", null)).toEqual({ usd_millions: null, fx_rate: null, fx_date: null });
    expect(convertToUsd(15, "XYZ", rates)).toEqual({ usd_millions: null, fx_rate: null, fx_date: null });
  });
});

describe("announced dates: precision and which day stands", () => {
  const base = { company_name: "Acme", round_type_as_written: "Series A", amount_as_written: "$20M", announced_date: null };
  const at = (kind: "roundup" | "newsletter" | "article", title: string, own: string | null = null) =>
    resolveRounds(
      [
        {
          round: round({ ...base, announced_date: own }),
          source: { url: "https://news.example/x", host: "news.example", title, published: "2026-09-01" },
          page_kind: kind,
          page_date: "2026-09-01",
        },
      ],
      { stages: ["series_a"], windowStart: WEEK, now: NOW, rates: { date: "2026-09-02", perUsd: {} } },
    ).kept[0];

  /** Resolver options for the August window the settlement cases run in. */
  const augustOpts = {
    stages: ["series_a" as const, "series_b" as const],
    windowStart: new Date("2026-08-01T00:00:00Z"),
    now: new Date("2026-09-01T12:00:00Z"),
    rates: { date: "2026-09-01", perUsd: {} },
  };

  /** Resolver options for the early-September window the page-day cases run in. */
  const septemberOpts = {
    stages: ["series_a" as const, "series_b" as const],
    windowStart: new Date("2026-08-01T00:00:00Z"),
    now: new Date("2026-09-06T12:00:00Z"),
    rates: { date: "2026-09-06", perUsd: {} },
  };

  test("a date borrowed from a roundup is a week, from a monthly list a month, from an article a day", () => {
    expect(at("roundup", "The week's biggest rounds").date_precision).toBe("week");
    expect(at("newsletter", "Deals you need to know").date_precision).toBe("week");
    expect(at("roundup", "August's biggest funding rounds").date_precision).toBe("month");
    expect(at("article", "Acme raises $20M Series A").date_precision).toBe("day");
  });

  test("a stated date is a day on an article, and on a list at most the list's week", () => {
    expect(at("article", "Acme raises $20M", "2026-08-30").date_precision).toBe("day");
    // A roundup's, digest's, or listicle's item days are the issue's or invented (the 2026-09-25 audit's
    // "169 VCs leading rounds" gave each round a day): never the announcement.
    expect(at("roundup", "The week's biggest rounds", "2026-08-30").date_precision).toBe("week");
  });

  test("digests, newsletters, columns, boards, and listicles are lists, by title, address, or host", () => {
    // The 2026-09-25 store audit's shapes: each dated its rows by its issue or its bucket.
    const lists = [
      { url: "https://startupcorners.com/digest/funding-digest-2026-07-29", title: "Top Startup Funding Rounds: July 29, 2026" },
      {
        url: "https://news.crunchbase.com/venture/unicorn-board-grows-40-companies-fintech-robotics-ai-july-2026",
        title: "Unicorn board grows 40 companies",
      },
      { url: "https://www.ctvc.co/how-founders-are-raising-in-2026-311", title: "How founders are raising in 2026 #311" },
      {
        url: "https://www.startupmag.co.uk/funding/uk-startup-funding-report-04-09-2026",
        title: "UK Startup Funding Report: £2978.4m raised",
      },
      {
        url: "https://www.automate.org/robotics/industry-insights/robotics-raises-eight-knot-embra-ai-logibot",
        title: "Robotics raises eight knot embra ai logibot",
      },
      {
        url: "https://bebeez.eu/2026/09/22/italys-angels-incubators-and-venture-capital-weekly-roundup-news",
        title: "Italy's angels & incubators weekly roundup",
      },
      { url: "https://www.the-founders-corner.com/p/the-169-vcs-leading-rounds-right", title: "The 169 VCs Leading Rounds Right Now" },
      { url: "https://newsletter.failory.com/p/from-rival-to-referral", title: "From Rival to Referral" },
      { url: "https://news.crunchbase.com/venture/biggest-funding-rounds-ai-tools", title: "The Week's 10 Biggest Funding Rounds" },
    ];
    for (const page of lists) expect(isListPage(page), page.url).toBe(true);
    // Single stories stay articles.
    expect(
      isListPage({ url: "https://www.startupmag.co.uk/funding/solarsub-2026-pre-seed-funding", title: "SolarSub raises £1.3m pre-seed" }),
    ).toBe(false);
    expect(isListPage({ url: "https://bebeez.eu/2026/09/24/verda-raises-189-million", title: "Verda raises $189 million" })).toBe(false);
    expect(isListPage({ url: "https://news.example/acme", title: "Acme raises $20M Series A" }, "article", 1)).toBe(false);
    expect(isListPage({ url: "https://news.example/acme", title: "Acme" }, "article", 3)).toBe(true);
  });

  test("a profile, an interview, or a Q&A recounts rounds: its day is an upper bound, not the announcement", () => {
    const profile = {
      url: "https://www.bizjournals.com/sanfrancisco/news/2026/09/25/executive-profile-assort-ceo-jon-wang.html",
      title: "Assort Health, Jon Wang's healthcare AI startup, hits $1.2B valuation in three years",
    };
    expect(isRecountPage(profile)).toBe(true);
    expect(isRecountPage({ url: "https://news.example/podcast/ep-12-acme", title: "Acme's founder" })).toBe(true);
    expect(isRecountPage({ url: "https://news.example/2026/09/25/acme-raises-20m", title: "Acme raises $20M" })).toBe(false);
    const assort = round({
      company_name: "Assort Health",
      round_type_as_written: "funding",
      amount_as_written: "$120M",
      evidence_quote: "S.F.'s Assort Health scales to $1.2B valuation with $120M funding",
    });
    const kept = resolveRounds(
      [{ round: assort, source: { ...profile, host: "bizjournals.com" }, page_kind: "article", page_date: "2026-09-25" }],
      {
        stages: ["other"],
        windowStart: new Date("2026-09-24T00:00:00Z"),
        now: new Date("2026-09-25T15:00:00Z"),
        rates: { date: "2026-09-25", perUsd: {} },
      },
    ).kept[0];
    expect(kept).toMatchObject({ announced_date: "2026-09-25", date_precision: "week", date_basis: "page" });
  });

  test("a list's day is an upper bound: a wire day after it never settles the round", () => {
    const week: FeedRecord = {
      ...at("roundup", "The week's biggest rounds"),
      announced_date: "2026-09-01",
      date_precision: "week",
      date_basis: "page",
    };
    const wire = (day: string) => ({
      url: `https://www.businesswire.com/news/home/${day.replaceAll("-", "")}000000/en/acme`,
      host: "businesswire.com",
    });
    expect(settleDate({ ...week, sources: [...week.sources, wire("2026-08-27")] }).announced_date).toBe("2026-08-27");
    expect(settleDate({ ...week, sources: [...week.sources, wire("2026-09-04")] }).announced_date).toBe("2026-09-01");
  });

  test("a page with no date of its own is undated, not dated to the run: a result day of today, a social post", () => {
    const opts = {
      stages: ["series_a" as const],
      windowStart: new Date("2026-09-18T00:00:00Z"),
      now: new Date("2026-09-25T15:00:00Z"),
      rates: { date: "2026-09-25", perUsd: {} },
    };
    const acme = round({ ...base, evidence_quote: "Acme raised $20M in a Series A." });
    const read = (url: string, published?: string, pageDate?: string) =>
      resolveRounds([{ ...item(acme, url, published), ...(pageDate ? { page_date: pageDate } : {}) }], opts).kept[0];
    // An index or an evergreen page a search engine calls fresh: undated.
    expect(read("https://www.financialit.net/news/fundraising-news/acme-raises", "9 hours ago")?.undated).toBe(true);
    // A result day before the run is the last rung, as before.
    expect(read("https://www.financialit.net/news/fundraising-news/acme-raises", "2026-09-22")).toMatchObject({
      announced_date: "2026-09-22",
      date_basis: "result",
    });
    // An Instagram repost is dated only by a day its text states.
    expect(read("https://www.instagram.com/p/Cx123/", "2026-09-22", "2026-09-22")?.undated).toBe(true);
    const stated = round({
      ...base,
      evidence_quote: "On September 21, 2026, Acme raised $20M in a Series A.",
      announced_date: "2026-09-21",
    });
    expect(resolveRounds([item(stated, "https://www.instagram.com/p/Cx124/")], opts).kept[0]?.announced_date).toBe("2026-09-21");
  });

  test("confidence and surerDate credit a day over a week and a week over a month or unknown", () => {
    const day = at("article", "Acme raises $20M");
    const week = at("roundup", "The week's biggest rounds");
    const month = at("roundup", "August's biggest funding rounds");
    expect(day.confidence).toBeGreaterThan(week.confidence);
    expect(week.confidence).toBeGreaterThan(month.confidence);
    expect(surerDate({ undated: false, date_precision: "week" }, { undated: false, date_precision: "day" })).toBe(true);
    expect(surerDate({ undated: false, date_precision: "day" }, { undated: false, date_precision: "week" })).toBe(false);
    expect(surerDate({ undated: true, date_precision: "unknown" }, { undated: false, date_precision: "week" })).toBe(true);
    expect(surerDate({ undated: false, date_precision: "day" }, { undated: true, date_precision: "unknown" })).toBe(false);
  });

  test("weekday phrases resolve against the page's date", () => {
    const page = new Date("2026-09-03T00:00:00Z"); // a Thursday
    expect(dateFromWeekday("RenoFi announced Tuesday that it closed a $20M Series B.", page)?.toISOString().slice(0, 10)).toBe(
      "2026-09-01",
    );
    expect(dateFromWeekday("Acme said on Thursday it raised $5M.", page)?.toISOString().slice(0, 10)).toBe("2026-09-03");
    expect(dateFromWeekday("Acme raised $5M.", page)).toBeNull();
    expect(dateFromWeekday("Acme announced Tuesday.", null)).toBeNull();
  });

  test("a past period in the sentence is history", () => {
    const windowStart = new Date("2026-08-01T00:00:00Z");
    expect(mentionsPastPeriod("which the Tysons startup announced closed in June 2025", windowStart)).toBe(true);
    expect(mentionsPastPeriod("raised a $3M seed round this spring, is joining Kalshi", windowStart)).toBe(true);
    expect(mentionsPastPeriod("Acme raised $20M in a round announced in August 2026", windowStart)).toBe(false);
    expect(mentionsPastPeriod("Acme raised $20M today", windowStart)).toBe(false);
  });

  test("the release date among the sources beats a republisher's borrowed date; a stated date stands", () => {
    const make = (over: Partial<FeedRecord>): FeedRecord => ({
      ...resolveRounds(
        [
          {
            round: round({ company_name: "Rundoo", round_type_as_written: "Series A", amount_as_written: "$20M", announced_date: null }),
            source: {
              url: "https://fortune.com/2026/08/20/term-sheet-wednesday/",
              host: "fortune.com",
              title: "Term Sheet",
              published: "2026-08-20",
            },
            page_kind: "newsletter",
            page_date: "2026-08-20",
          },
        ],
        {
          stages: ["series_a"],
          windowStart: new Date("2026-08-01T00:00:00Z"),
          now: new Date("2026-08-21T12:00:00Z"),
          rates: { date: "2026-08-21", perUsd: {} },
        },
      ).kept[0],
      ...over,
    });
    const r = make({});
    expect(r.announced_date).toBe("2026-08-20");
    expect(r.date_precision).toBe("week");
    r.sources.push({
      url: "https://www.businesswire.com/news/home/20260819537737/en/Rundoo-Raises",
      host: "www.businesswire.com",
      title: "Rundoo Raises $20M",
    });
    const settledR = settleDate(r);
    expect(settledR.announced_date).toBe("2026-08-19");
    expect(settledR.date_precision).toBe("day");
    expect(settledR.date_basis).toBe("url");
    expect(settledR.id).toBe("rundoo:series_a:2026-08-19");
    // The company's own newsroom counts as a release host; a random blog does not.
    const own = make({ company_domain: "rundoo.com" });
    own.sources.push({ url: "https://rundoo.com/blog/2026/08/18/series-a", host: "rundoo.com", title: "Our Series A" });
    const settledOwn = settleDate(own);
    expect(settledOwn.announced_date).toBe("2026-08-18");
    const blog = make({});
    blog.sources.push({ url: "https://someblog.example/2026/08/18/rundoo", host: "someblog.example", title: "Rundoo" });
    const settledBlog = settleDate(blog);
    expect(settledBlog.announced_date).toBe("2026-08-20");
    // A stated date stands whatever the sources carry (a wire URL carries the upload day, not always the
    // release day); a borrowed date yields, and a release more than 21 days earlier is another event.
    const stated = make({ date_basis: "stated", announced_date: "2026-08-20", date_precision: "day" });
    stated.sources.push({ url: "https://www.businesswire.com/news/home/20260819537737/en/x", host: "www.businesswire.com", title: "x" });
    const settledStated = settleDate(stated);
    expect(settledStated.announced_date).toBe("2026-08-20");
    const statedFar = make({ date_basis: "stated", announced_date: "2026-08-20", date_precision: "day" });
    statedFar.sources.push({ url: "https://www.businesswire.com/news/home/20260810537737/en/x", host: "www.businesswire.com", title: "x" });
    const settledStatedFar = settleDate(statedFar);
    expect(settledStatedFar.announced_date).toBe("2026-08-20");
    // A month-dated round takes the wire day inside its month, either side of the stamp.
    const monthly = make({ announced_date: "2026-07-01", date_precision: "month", date_basis: "page" });
    monthly.sources.push({
      url: "https://www.globenewswire.com/news-release/2026/07/21/x/en/Ant.html",
      host: "www.globenewswire.com",
      title: "x",
    });
    const settledMonthly = settleDate(monthly);
    expect(settledMonthly.announced_date).toBe("2026-07-21");
    expect(settledMonthly.date_precision).toBe("day");
    const old = make({});
    old.sources.push({
      url: "https://www.prnewswire.com/news-releases/rundoo-2026-06-01-3001.html",
      host: "www.prnewswire.com",
      title: "x",
    });
    const settledOld = settleDate(old);
    expect(settledOld.announced_date).toBe("2026-08-20");
  });

  test("the earliest day that fits wins, not the earliest overall: Bluecore's Sep 8 over a republisher's Sep 22", () => {
    // A trade site republished Bluecore's release on Sep 22 ("today announced"), and the row took its byline.
    // TechCrunch's dated story (Sep 8) and the company's own post sit in the sources, and so does a Fortune
    // feature from Aug 29 that only mentions the company: 24 days back, too far to be this round, it used to
    // hide the other two, so the row kept Sep 22.
    const bluecore: FeedRecord = {
      id: "bluecore-energy:seed:2026-09-22",
      company_key: "bluecore energy",
      company_name: "Bluecore Energy",
      company_domain: "bluecore.energy",
      company_website: "https://www.bluecore.energy",
      company_description: null,
      stage: "seed",
      stage_as_written: "seed",
      is_extension: false,
      amount: { value: 50, currency: "USD", as_written: "$50 million", usd_millions: 50, fx_rate: 1, fx_date: "2026-09-22" },
      valuation_as_written: null,
      lead_investors: ["Silverton Partners"],
      other_investors: [],
      announced_date: "2026-09-22",
      date_precision: "day",
      date_basis: "page",
      headquarters: null,
      sector: null,
      evidence_quotes: ["Bluecore Energy today announced the close of a $50 million seed financing."],
      sources: [
        {
          url: "https://www.ajot.com/news/bluecore-energy-raises-50-million-seed-round",
          host: "www.ajot.com",
          title: "Bluecore Energy raises $50 million seed round",
        },
        {
          url: "https://fortune.com/2026/08/29/offshore-nuclear-barges-power-ports-data-centers-california-banned",
          host: "fortune.com",
          title: "Offshore nuclear barges could power ports and data centers",
        },
        {
          url: "https://techcrunch.com/2026/09/08/nuclear-startup-bluecore-energy-raises-50m-seed-round",
          host: "techcrunch.com",
          title: "Nuclear startup Bluecore Energy raises $50M seed round",
        },
      ],
      confidence: 0.9,
      status: "new",
      undated: false,
    };
    const settled = settleDate(bluecore);
    expect(settled.announced_date).toBe("2026-09-08");
    expect(settled.date_basis).toBe("url");
    // With only the far feature beside it, the byline stays: 24 days back is another event.
    const featureOnly = settleDate({ ...bluecore, sources: bluecore.sources.slice(0, 2) });
    expect(featureOnly.announced_date).toBe("2026-09-22");
  });

  test("a first-of-month stamp on a page dated later in the month is a month, then a wire day inside it", () => {
    const opts = {
      stages: ["series_a" as const],
      windowStart: new Date("2026-07-01T00:00:00Z"),
      now: new Date("2026-07-25T12:00:00Z"),
      rates: { date: "2026-07-25", perUsd: {} },
    };
    // The extractor wrote 2026-07-01 for a round the page dates only to July.
    const stamped = resolveRounds(
      [
        {
          round: round({
            company_name: "Ant International",
            round_type_as_written: "Series A",
            amount_as_written: "$20M",
            announced_date: "2026-07-01",
          }),
          source: {
            url: "https://scmp.com/tech/ant-international-raises",
            host: "scmp.com",
            title: "Ant International raises $20M",
            published: "2026-07-22",
          },
          page_kind: "article",
          page_date: "2026-07-22",
        },
      ],
      opts,
    ).kept[0];
    expect(stamped.date_precision).toBe("month");
    expect(stamped.announced_date).toBe("2026-07-01");
    stamped.sources.push({
      url: "https://www.globenewswire.com/news-release/2026/07/21/x/en/Ant.html",
      host: "www.globenewswire.com",
      title: "x",
    });
    const settledStamped = settleDate(stamped);
    expect(settledStamped.announced_date).toBe("2026-07-21");
  });

  test("a stale page is an old story: a March page cannot carry an August round, dated or not", () => {
    const stale = resolveRounds(
      [
        {
          round: round({ company_name: "RenoFi", round_type_as_written: "Series B", amount_as_written: "$20M", announced_date: null }),
          source: {
            url: "https://www.housingwire.com/articles/renofi-raises/",
            host: "housingwire.com",
            title: "RenoFi raises",
            published: "2026-03-05",
          },
          page_kind: "article",
          page_date: "2026-08-20",
        },
      ],
      augustOpts,
    );
    expect(stale.kept).toHaveLength(0);
    expect(stale.dropped.outOfWindow).toBe(1);
    // Whatever the extractor wrote for a date.
    const dated = resolveRounds(
      [
        {
          round: round({
            company_name: "RenoFi",
            round_type_as_written: "Series B",
            amount_as_written: "$20M",
            announced_date: "2026-08-30",
          }),
          source: {
            url: "https://www.housingwire.com/articles/renofi-raises/",
            host: "housingwire.com",
            title: "RenoFi raises",
            published: "2026-03-06",
          },
          page_kind: "article",
          page_date: "2026-03-06",
        },
      ],
      septemberOpts,
    );
    expect(dated.kept).toHaveLength(0);
    expect(dated.dropped.outOfWindow).toBe(1);
  });

  test("an extracted day that is a weekly's own dateline, with no day in the sentence, is a week", () => {
    const weekly = resolveRounds(
      [
        {
          round: round({
            company_name: "Hadrius",
            round_type_as_written: "Series A",
            amount_as_written: "$20M",
            announced_date: "2026-07-18",
            evidence_quote: "Hadrius raised $20M in a Series A led by Acme Ventures.",
          }),
          source: {
            url: "https://fintech.global/2026/07/18/investors-turn-up-the-heat-this-week/",
            host: "fintech.global",
            title: "Investors turn up the heat with almost $1.4bn raised in fintech this week",
            published: "2026-07-18",
          },
          page_kind: "article",
          page_date: "2026-07-18",
        },
      ],
      { ...septemberOpts, windowStart: new Date("2026-07-01T00:00:00Z") },
    ).kept[0];
    expect(weekly.date_precision).toBe("week");
    expect(weekly.date_basis).toBe("page");
  });

  test("a republisher's byline copied into the date on a single story is the page's day, and can move", () => {
    const article = resolveRounds(
      [
        {
          round: round({
            company_name: "Gimlet Labs",
            round_type_as_written: "Series A",
            amount_as_written: "$41M",
            announced_date: "2026-09-05",
            evidence_quote: "Gimlet Labs raised $41M in a Series A led by Maverick Silicon.",
          }),
          source: {
            url: "https://wowtale.example/gimlet-labs-raises",
            host: "wowtale.example",
            title: "Gimlet Labs raises $41M",
            published: "2026-09-05",
          },
          page_kind: "article",
          page_date: "2026-09-05",
        },
      ],
      septemberOpts,
    ).kept[0];
    expect(article.date_precision).toBe("day");
    expect(article.date_basis).toBe("page");
    article.sources.push({
      url: "https://siliconangle.com/2026/09/04/gimlet-labs-raises-41m/",
      host: "siliconangle.com",
      title: "Gimlet Labs raises $41M",
      published: "2026-09-04",
    });
    const settledArticle = settleDate(article);
    expect(settledArticle.announced_date).toBe("2026-09-04");
  });

  test("a sentence that names the day keeps the stated basis; a weekday or 'today' inherits the page's doubt", () => {
    const stated = resolveRounds(
      [
        {
          round: round({
            company_name: "Acme",
            round_type_as_written: "Series A",
            amount_as_written: "$5M",
            announced_date: "2026-09-05",
            evidence_quote: "Acme announced on September 5 that it raised $5M.",
          }),
          source: { url: "https://wowtale.example/acme", host: "wowtale.example", title: "Acme raises", published: "2026-09-05" },
          page_kind: "article",
          page_date: "2026-09-05",
        },
      ],
      septemberOpts,
    ).kept[0];
    expect(stated.date_basis).toBe("stated");
    expect(evidenceStatesDay("announced on September 5")).toBe(true);
    expect(evidenceStatesDay("announced Tuesday")).toBe(false);
    expect(evidenceStatesDay("announced this morning")).toBe(false);
    expect(evidenceStatesDay("raised $5M in a Series A")).toBe(false);
    // A stated day inside the sources' span stands (a Sunday announcement reported Monday).
    const plausible = {
      ...stated,
      announced_date: "2026-09-04",
      sources: [{ url: "https://wowtale.example/acme", host: "wowtale.example", title: "Acme raises", published: "2026-09-05" }],
    };
    const settledPlausible = settleDate(plausible);
    expect(settledPlausible.announced_date).toBe("2026-09-04");
  });

  test("a stated day after every page that reports it is impossible; the earliest page's day stands in", () => {
    const impossible = resolveRounds(
      [
        {
          round: round({
            company_name: "Mara",
            round_type_as_written: "Series A",
            amount_as_written: "$10M",
            announced_date: "2026-09-04",
            evidence_quote: "Mara announced on September 4 a $10M Series A.",
          }),
          source: {
            url: "https://siliconangle.com/2026/08/26/mara-raises/",
            host: "siliconangle.com",
            title: "Mara raises $10M",
            published: "2026-08-26",
          },
          page_kind: "article",
          page_date: "2026-08-26",
        },
      ],
      septemberOpts,
    ).kept[0];
    // The resolver settles it on the spot: the page it was read from is dated nine days before the "stated" day.
    expect(impossible.announced_date).toBe("2026-08-26");
    expect(impossible.date_basis).toBe("page");
  });
});

describe("websites and headquarters", () => {
  test("a source on the company's own host is its website", () => {
    expect(
      ownSiteAmongSources({
        company_key: "conveo",
        sources: [
          { url: "https://techcrunch.com/2026/09/02/conveo-raises", host: "techcrunch.com" },
          { url: "https://www.conveo.ai/blog/series-a", host: "www.conveo.ai" },
        ],
      }),
    ).toBe("https://conveo.ai");
    expect(
      ownSiteAmongSources({ company_key: "thyme care", sources: [{ url: "https://thymecare.com/news/series-d", host: "thymecare.com" }] }),
    ).toBe("https://thymecare.com");
    expect(
      ownSiteAmongSources({ company_key: "conveo", sources: [{ url: "https://linkedin.com/company/conveo", host: "linkedin.com" }] }),
    ).toBeNull();
    expect(
      ownSiteAmongSources({ company_key: "conveo", sources: [{ url: "https://techcrunch.com/x", host: "techcrunch.com" }] }),
    ).toBeNull();
  });

  test("a shortlink or a blog post is no homepage", () => {
    expect(trustedWebsite("https://pr.report/pq6y", [])).toBeNull();
    expect(trustedWebsite("https://acme.com/blog-post-slug", [])).toBeNull();
    expect(trustedWebsite("https://acme.com/en", [])).toBe("https://acme.com/en");
    expect(trustedWebsite("https://acme.com/", [])).toBe("https://acme.com/");
  });

  test("a dateline city is not the headquarters unless the quote says the company is based there", () => {
    // The page's dateline is a second opinion on where the release was issued.
    expect(scrubHeadquarters("Denver, Colorado", "TabaPay closed a $155 million financing.", "DENVER")).toBeNull();
    expect(scrubHeadquarters("Mountain View, California", "TabaPay closed a $155 million financing.", "DENVER")).toBe(
      "Mountain View, California",
    );
    expect(scrubHeadquarters("Denver, Colorado", "Denver-based TabaPay closed a $155 million financing.", "DENVER")).toBe(
      "Denver, Colorado",
    );
  });
});

describe("roundups and list pages", () => {
  /** Resolver options for the August window the roundup cases run in. */
  const augustOpts = {
    stages: ["series_a" as const, "series_b" as const],
    windowStart: new Date("2026-08-01T00:00:00Z"),
    now: new Date("2026-09-01T12:00:00Z"),
    rates: { date: "2026-09-01", perUsd: {} },
  };

  test("a page that states three rounds is a roundup whatever the model called it", () => {
    const page = { url: "https://news.example/weekly", host: "news.example", title: "This week's deals", published: "2026-09-04" };
    const items = ["Alpha", "Beta", "Gamma"].map((name) => ({
      round: round({ company_name: name, round_type_as_written: "Seed", amount_as_written: "$5M", announced_date: null }),
      source: page,
      page_kind: "article" as const,
      page_date: "2026-09-04",
    }));
    const kept = resolveRounds(items, { stages: ["seed"], windowStart: WEEK, now: NOW, rates: { date: "2026-09-04", perUsd: {} } }).kept;
    expect(kept).toHaveLength(3);
    expect(new Set(kept.map((k) => k.date_precision))).toEqual(new Set(["week"]));
  });

  test("a weekly roundup by title or URL is a week whatever the model said, even with a day in its URL", () => {
    const kept = resolveRounds(
      [
        {
          round: round({
            company_name: "Regent Craft",
            round_type_as_written: "Series B",
            amount_as_written: "$140M",
            announced_date: null,
          }),
          source: {
            url: "https://www.axios.com/pro/climate-deals/2026/08/29/energy-and-climate-deals-week-of-aug-24",
            host: "axios.com",
            title: "Energy and climate deals: week of Aug 24",
            published: "2026-08-30",
          },
          page_kind: "article",
          page_date: "2026-08-29",
        },
      ],
      { ...augustOpts, stages: ["series_b"] },
    ).kept;
    expect(kept[0].announced_date).toBe("2026-08-29");
    expect(kept[0].date_precision).toBe("week");
  });

  test("'the week's' and 'this week:' in a title are weekly", () => {
    for (const title of ["The Week\u2019s 10 Biggest Funding Rounds: Crusoe and Fluidstack", "This week: SportsStack raises a pre-seed"]) {
      const k = resolveRounds(
        [
          {
            round: round({ company_name: "Acme", round_type_as_written: "Series A", amount_as_written: "$5M", announced_date: null }),
            source: { url: "https://news.example/2026/08/29/x", host: "news.example", title, published: "2026-08-29" },
            page_kind: "article",
            page_date: "2026-08-29",
          },
        ],
        augustOpts,
      ).kept[0];
      expect(k.date_precision).toBe("week");
    }
  });

  test("a roundup's day yields to a dated article from a ranked publisher on the same record", () => {
    const roundup = {
      url: "https://www.ctvc.co/how-founders-are-raising-in-2026-311",
      host: "ctvc.co",
      title: "How founders are raising in 2026",
      published: "2026-08-31",
    };
    const r = resolveRounds(
      [
        {
          round: round({ company_name: "Airbound", round_type_as_written: "Series B", amount_as_written: "$50M", announced_date: null }),
          source: roundup,
          page_kind: "newsletter",
          page_date: "2026-08-31",
        },
      ],
      { ...augustOpts, stages: ["series_b"] },
    ).kept[0];
    expect(r.date_precision).toBe("week");
    // The judge confirmed the roundup's day; a TechCrunch article dated Aug 24 sits beside it.
    r.sources.push({
      url: "https://techcrunch.com/2026/08/24/airbound-raises-50m/",
      host: "techcrunch.com",
      title: "Airbound raises $50M",
      published: "2026-08-24",
    });
    const settledR = settleDate(r);
    expect(settledR.announced_date).toBe("2026-08-24");
    expect(settledR.date_precision).toBe("day");
  });

  test("a second weekly roundup with a day in its URL is not a sibling that settles anything", () => {
    const roundup = {
      url: "https://www.ctvc.co/how-founders-are-raising-in-2026-311",
      host: "ctvc.co",
      title: "How founders are raising in 2026",
      published: "2026-08-31",
    };
    const r2 = resolveRounds(
      [
        {
          round: round({ company_name: "Regent", round_type_as_written: "Series B", amount_as_written: "$140M", announced_date: null }),
          source: roundup,
          page_kind: "newsletter",
          page_date: "2026-08-31",
        },
      ],
      { ...augustOpts, stages: ["series_b"] },
    ).kept[0];
    r2.sources.push({
      url: "https://www.axios.com/pro/climate-deals/2026/08/29/energy-and-climate-deals-week-of-aug-24",
      host: "axios.com",
      title: "Energy and climate deals: week of Aug 24",
      published: "2026-08-30",
    });
    const settledR2 = settleDate(r2);
    expect(settledR2.announced_date).toBe("2026-08-31");
    expect(settledR2.date_precision).toBe("week");
  });

  test("on a list page the evidence must name the item's own company", () => {
    // Two companies on one page; the second company's sentence stored under the first grounds nothing.
    const page = {
      url: "https://vccircle.example/two-deals",
      host: "vccircle.example",
      title: "Two early-stage deals",
      published: "2026-08-20",
    };
    const two = resolveRounds(
      [
        {
          round: round({
            company_name: "Creedom",
            round_type_as_written: "Series A",
            amount_as_written: "$3M",
            evidence_quote: "Guickly raised $2M from Neon Fund and Kartheeswaran KK.",
            lead_investors: ["Neon Fund"],
            announced_date: "2026-08-20",
          }),
          source: page,
          page_kind: "article",
          page_date: "2026-08-20",
        },
        {
          round: round({
            company_name: "Guickly",
            round_type_as_written: "Series A",
            amount_as_written: "$2M",
            evidence_quote: "Guickly raised $2M from Neon Fund and Kartheeswaran KK.",
            lead_investors: ["Neon Fund"],
            announced_date: "2026-08-20",
          }),
          source: page,
          page_kind: "article",
          page_date: "2026-08-20",
        },
      ],
      augustOpts,
    );
    expect(two.kept.map((k) => k.company_name)).toEqual(["Guickly"]);
    expect(two.dropped.ungrounded).toBe(1);
    // A sentence that names no one ("the company raised") on a list page grounds its own item, but the
    // page is no source for it: neither its title, its URL, nor the sentence names Creedom (sourceFit).
    const pronoun = resolveRounds(
      [
        {
          round: round({
            company_name: "Creedom",
            round_type_as_written: "Series A",
            amount_as_written: "$3M",
            evidence_quote: "The company raised $3M in a Series A led by Acme Ventures.",
            lead_investors: ["Acme Ventures"],
            announced_date: "2026-08-20",
          }),
          source: page,
          page_kind: "article",
          page_date: "2026-08-20",
        },
        {
          round: round({
            company_name: "Guickly",
            round_type_as_written: "Series A",
            amount_as_written: "$2M",
            evidence_quote: "Guickly raised $2M from Neon Fund.",
            lead_investors: ["Neon Fund"],
            announced_date: "2026-08-20",
          }),
          source: page,
          page_kind: "article",
          page_date: "2026-08-20",
        },
      ],
      augustOpts,
    );
    expect(pronoun.kept.map((k) => k.company_name)).toEqual(["Guickly"]);
    expect(pronoun.dropped.ungrounded).toBe(0);
    expect(pronoun.dropped.unrelatedSource).toBe(1);
    expect(evidenceNamesAnotherCompany("Guickly raised $2M", "Creedom", ["Creedom", "Guickly"])).toBe(true);
    expect(evidenceNamesAnotherCompany("The company raised $3M", "Creedom", ["Creedom", "Guickly"])).toBe(false);
    expect(evidenceNamesCompany("Thyme Care raised $125M", "Thyme Care")).toBe(true);
    expect(evidenceNamesCompany("Guickly raised $2M", "Creedom")).toBe(false);
  });

  test("a job posting that states the round is no source; a kept link carries the sentence read off its page", () => {
    const posting = {
      url: "https://jobs.ashbyhq.com/creedom/5c8e9cb3-f02c-4938-aa8b-8dd4c5fe61ca",
      host: "jobs.ashbyhq.com",
      title: "Executive Assistant and Office Manager",
      published: "2026-08-20",
    };
    const release = {
      url: "https://wire.example/creedom-raises-3m-series-a",
      host: "wire.example",
      title: "Creedom raises $3M Series A",
      published: "2026-08-20",
    };
    const item = (source: typeof posting) => ({
      round: round({
        company_name: "Creedom",
        round_type_as_written: "Series A",
        amount_as_written: "$3M",
        evidence_quote: "Creedom raised $3M in a Series A led by Acme Ventures.",
        lead_investors: ["Acme Ventures"],
        announced_date: "2026-08-20",
      }),
      source,
      page_kind: "article" as const,
      page_date: "2026-08-20",
    });
    const result = resolveRounds([item(posting), item(release)], augustOpts);
    expect(result.dropped.nonArticle + result.dropped.unrelatedSource).toBe(1);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.sources.map((s) => s.url)).toEqual([release.url]);
    expect(result.kept[0]?.sources[0]?.evidence).toBe("Creedom raised $3M in a Series A led by Acme Ventures.");
  });

  test("directories, rankings, and trackers are not articles, and a table row is not a sentence", () => {
    expect(isDirectoryTitle("Top 50 EdTech Companies to Watch in 2026")).toBe(true);
    expect(isDirectoryTitle("Seed Funding Tracker")).toBe(true);
    expect(isDirectoryTitle("Startup Funding Database")).toBe(true);
    expect(isDirectoryTitle("A database of AI startups and their rounds")).toBe(true);
    expect(isDirectoryTitle("PlanetScale raises $30M Series B for its database service")).toBe(false);
    expect(isDirectoryTitle("Neon raises $46M for its serverless Postgres database")).toBe(false);
    expect(isDirectoryTitle("Angel investors in Berlin")).toBe(true);
    expect(isDirectoryTitle("List of Funded Seed Stage Startups (2026)")).toBe(true);
    expect(isDirectoryTitle("Companies Backed by Blue Lake Capital: Funding Raised")).toBe(true);
    expect(isDirectoryTitle("Portfolio companies of Sequoia Capital")).toBe(true);
    expect(isDirectoryTitle("Investments by Andreessen Horowitz in 2026")).toBe(true);
    expect(isDirectoryTitle("Acme raises $20M Series A led by Sequoia")).toBe(false);
    expect(isDirectoryTitle("AI Startup Directory 2026")).toBe(true);
    expect(isDirectoryTitle("Fintech Funding Tracker: every round this year")).toBe(true);
    expect(isDirectoryTitle("Top investors in climate tech")).toBe(true);
    expect(isDirectoryTitle("Fitness tracker maker Whoop raises $200M")).toBe(false);
    expect(isDirectoryTitle("LMArena, the AI leaderboard, raises $100M seed")).toBe(false);
    expect(isDirectoryTitle("Identity startup secures $12M to replace Active Directory")).toBe(false);
    expect(isDirectoryTitle("Acme raises $3M seed from angel investors")).toBe(false);
    expect(isDirectoryTitle("Top investors back Acme in $40M Series B")).toBe(false);
    expect(isDirectoryTitle("The best-funded HR-tech startups in the Netherlands in 2026")).toBe(true);
    expect(isDirectoryTitle("Europe's most funded AI companies")).toBe(true);
    expect(isDirectoryTitle("Europe's best-funded AI startup raises $600M Series C")).toBe(false);
    // A table row is not a sentence: a directory's cell about a round that happened some time.
    expect(isTableRowQuote("$93M raised · Series C1 · Seoul, South Korea")).toBe(true);
    expect(isTableRowQuote("Acme | Series A | $20M | 2026-09-02")).toBe(true);
    expect(isTableRowQuote("Acme raised $20M in a Series A led by Sequoia, the company said Tuesday.")).toBe(false);
    expect(
      isTableRowQuote(
        "Acme, a Seoul-based fintech · raised $20M in a Series A led by Sequoia Capital and Index Ventures on Tuesday · to expand",
      ),
    ).toBe(false);
    expect(isDirectoryTitle("The Week's 10 Biggest Funding Rounds")).toBe(false);
    expect(isDirectoryTitle("Acme raises $20M Series A")).toBe(false);
  });

  test("a verbless data point is not a sentence: a trend story's list of the year's biggest rounds is not news", () => {
    // The quotes the extractor took off two Sep 23 trend stories about 2026's jumbo Series A rounds.
    expect(isDataPointQuote("Xpeng Robotics -- $900M Series A")).toBe(true);
    expect(isDataPointQuote("a $900 million financing for China-based Xpeng Robotics")).toBe(true);
    expect(isDataPointQuote("for instance, it includes a $1.2 billion round for Silicon Valley-based River AI")).toBe(true);
    expect(isDataPointQuote("Mind Robotics -- ~$500M Series A: industrial robotics-focused startup.")).toBe(true);
    expect(isDataPointQuote("Kelluu’s €15 million Series A")).toBe(true);
    // A report of a round says who raised it, however it says so.
    expect(isDataPointQuote("Fearn, a San Francisco-based AI-powered patent law firm, raised $5.5 million in seed funding.")).toBe(false);
    expect(isDataPointQuote("Berlin-based F13 emerged from stealth with $5 million in pre-seed funding.")).toBe(false);
    expect(isDataPointQuote("London-based Big Picture Bio has launched with £2.2 million in funding.")).toBe(false);
    expect(isDataPointQuote("the company recently came out of stealth with $26 million in seed funding.")).toBe(false);
    expect(isDataPointQuote("The quarter's largest deal was a $600 million Series D round by True Anomaly.")).toBe(false);
    // No figure, no data point: a description the extractor quoted says nothing either way.
    expect(isDataPointQuote("Firi is a beauty-focused quick-commerce platform offering skincare and haircare.")).toBe(false);
    // A passing mention in the same story, with no verb, no figure, and no round named, became an
    // OpenAI "Series A" and an Anthropic one; it is not a sentence about a round either.
    expect(isDataPointQuote("megarounds for Silicon Valley-based OpenAI")).toBe(true);
    expect(isDataPointQuote("megarounds for Silicon Valley-based Anthropic")).toBe(true);
    // A verbless quote that names the round says too little to call, and a label is not evidence.
    expect(isDataPointQuote("Ibtikar Fund's undisclosed seed investment in Churn Solution")).toBe(false);
    expect(isDataPointQuote("Series A")).toBe(false);

    const opts = {
      stages: ["series_a" as const],
      windowStart: new Date("2026-09-16T00:00:00Z"),
      now: new Date("2026-09-23T20:00:00Z"),
      rates: { date: "2026-09-23", perUsd: {} },
    };
    const trend = (company: string, quote: string, url: string, title: string): ExtractedItem => ({
      round: round({ company_name: company, round_type_as_written: "Series A", amount_as_written: "$900M", evidence_quote: quote }),
      source: { url, host: hostOf(url), title, published: "2026-09-23" },
      page_kind: "article",
      page_date: "2026-09-23",
    });
    const read = resolveRounds(
      [
        trend(
          "Xpeng Robotics",
          "a $900 million financing for China-based Xpeng Robotics",
          "https://news.crunchbase.com/venture/megaround-seriesa-ai-chips-robotics-2026",
          "Jumbo-Sized Series A Rounds Are On The Rise",
        ),
        trend(
          "Xpeng Robotics",
          "Xpeng Robotics -- $900M Series A",
          "https://valueaddvc.com/pulse/jumbo-series-a-100m-rounds-2026",
          "Jumbo-Sized Series A Rounds Keep Getting Bigger",
        ),
        // The same bullet on a weekly roundup is this week's round and stays.
        trend(
          "Acme Robotics",
          "Acme Robotics -- $900M Series A",
          "https://news.crunchbase.com/venture/biggest-funding-rounds-robotics",
          "The Week's 10 Biggest Funding Rounds",
        ),
      ],
      opts,
    );
    expect(read.kept.map((k) => k.company_name)).toEqual(["Acme Robotics"]);
    expect(read.dropped.nonArticle).toBe(2);
  });

  test("a directory source drops the round; a monthly list is dated to the month it names", () => {
    const opts = {
      stages: ["series_a" as const],
      windowStart: new Date("2026-07-01T00:00:00Z"),
      now: new Date("2026-07-25T12:00:00Z"),
      rates: { date: "2026-07-25", perUsd: {} },
    };
    // A June list read in July stays out of July.
    const listed = resolveRounds(
      [
        {
          round: round({ company_name: "Dir Co", round_type_as_written: "Series A", amount_as_written: "$5M", announced_date: null }),
          source: {
            url: "https://evalyze.example/investors/angels",
            host: "evalyze.example",
            title: "Top angel investors in fintech",
            published: "2026-07-20",
          },
        },
        {
          round: round({ company_name: "June Co", round_type_as_written: "Series A", amount_as_written: "$5M", announced_date: null }),
          source: {
            url: "https://alleywatch.example/june-2026-nyc-funding",
            host: "alleywatch.example",
            title: "The 10 Largest NYC Tech Startup Funding Rounds of June 2026",
            published: "2026-07-01",
          },
          page_kind: "roundup",
          page_date: "2026-07-01",
        },
      ],
      opts,
    );
    expect(listed.kept).toHaveLength(0);
    expect(listed.dropped.nonArticle).toBe(1);
    expect(listed.dropped.outOfWindow).toBe(1);
    expect(monthNamedIn("The Complete July 2026 Startup Funding Roundup")?.toISOString().slice(0, 10)).toBe("2026-07-31");
    expect(monthNamedIn("This week's rounds")).toBeNull();
  });
});

describe("background rounds: history a page recalls beside its news", () => {
  test("one company, two rounds, one single-story page: the earlier stage is the history the page recalled", () => {
    const page = {
      url: "https://sdtimes.com/orchestra-launches",
      host: "sdtimes.com",
      title: "Orchestra launches agentic control plane",
      published: "2026-09-01",
    };
    const items = [
      {
        round: round({
          company_name: "Orchestra",
          round_type_as_written: "seed",
          amount_as_written: "$3.3 million",
          announced_date: "2026-09-01",
        }),
        source: page,
        page_kind: "article" as const,
        page_date: "2026-09-01",
      },
      {
        round: round({
          company_name: "Orchestra",
          round_type_as_written: "pre-seed",
          amount_as_written: "$1.3 million",
          announced_date: null,
        }),
        source: page,
        page_kind: "article" as const,
        page_date: "2026-09-01",
      },
    ];
    const r = resolveRounds(items, {
      stages: ["seed", "pre_seed"],
      windowStart: WEEK,
      now: NOW,
      rates: { date: "2026-09-02", perUsd: {} },
    });
    expect(r.kept.map((k) => k.stage)).toEqual(["seed"]);
    expect(r.dropped.background).toBe(1);
    // A roundup naming both rounds of one company keeps both (it lists rounds by design).
    const roundup = { url: "https://news.example/weekly", host: "news.example", title: "This week's rounds", published: "2026-09-01" };
    const listed = resolveRounds(
      [
        {
          round: round({ company_name: "Orchestra", round_type_as_written: "seed", amount_as_written: "$3.3M", announced_date: null }),
          source: roundup,
          page_kind: "roundup" as const,
          page_date: "2026-09-01",
        },
        {
          round: round({ company_name: "Orchestra", round_type_as_written: "pre-seed", amount_as_written: "$1.3M", announced_date: null }),
          source: roundup,
          page_kind: "roundup" as const,
          page_date: "2026-09-01",
        },
        {
          round: round({ company_name: "Other Co", round_type_as_written: "Series A", amount_as_written: "$5M", announced_date: null }),
          source: roundup,
          page_kind: "roundup" as const,
          page_date: "2026-09-01",
        },
      ],
      { stages: ["seed", "pre_seed", "series_a"], windowStart: WEEK, now: NOW, rates: { date: "2026-09-02", perUsd: {} } },
    );
    expect(listed.kept).toHaveLength(3);
  });

  test("a stealth launch's seed rides on its Series A as a prior round, and the history lane keeps it as a record", () => {
    const page = {
      url: "https://www.nooon.studio/news/parallax-comes-out-of-stealth-and-raises-117m",
      host: "nooon.studio",
      title: "Parallax comes out of stealth and raises $117M",
      published: "2026-09-03",
    };
    const at = (r: ExtractedRound) => ({ round: r, source: page, page_kind: "article" as const, page_date: "2026-09-03" });
    const seriesA = at(
      round({
        company_name: "Parallax",
        round_type_as_written: "Series A",
        amount_as_written: "$75M",
        lead_investors: ["Greylock", "General Catalyst"],
        announced_date: "2026-09-03",
        evidence_quote: "Greylock and General Catalyst led the $75M Series A.",
      }),
    );
    const seed = round({
      company_name: "Parallax",
      round_type_as_written: "seed",
      amount_as_written: "$42M",
      lead_investors: ["Eclipse", "Lux Capital"],
      evidence_quote: "Eclipse and Lux Capital co-led the $42M seed, with Founders Fund and Valor.",
    });
    const opts = { stages: ["seed" as const, "series_a" as const], windowStart: WEEK, now: NOW, rates: { date: "2026-09-02", perUsd: {} } };
    const prior = {
      stage_as_written: "seed",
      amount_as_written: "$42M",
      announced_date: null,
      lead_investors: ["Eclipse", "Lux Capital"],
      source_url: page.url,
    };
    // Dropped as the earlier stage on a single-story page, or read by the extractor as history: either way it is no news.
    for (const s of [seed, { ...seed, is_background: true }]) {
      const r = resolveRounds([seriesA, at(s)], opts);
      expect(r.kept.map((k) => k.stage)).toEqual(["series_a"]);
      expect(r.dropped.background).toBe(1);
      expect(r.kept[0]?.earlier_rounds).toEqual([prior]);
      const history = resolveRounds([seriesA, at(s)], { ...opts, keepEarlierRounds: true });
      expect(history.kept.map((k) => k.stage).sort()).toEqual(["seed", "series_a"]);
      expect(history.dropped.background).toBe(0);
    }
    // A round recalled with no later round of the company kept beside it stays background, carried by nothing.
    const alone = resolveRounds([at({ ...seed, is_background: true })], { ...opts, keepEarlierRounds: true });
    expect(alone.kept).toEqual([]);
    expect(alone.dropped.background).toBe(1);
    // A page that is no stealth launch recalls the seed, which had its own announcement: background, and no lead.
    const recap = { ...page, title: "Parallax raises $75M Series A" };
    const recalled = resolveRounds(
      [seriesA, at(seed)].map((i) => ({ ...i, source: recap })),
      { ...opts, keepEarlierRounds: true },
    );
    expect(recalled.kept.map((k) => [k.stage, k.earlier_rounds])).toEqual([["series_a", undefined]]);
    // So is a seed the launch page dates to a day of its own, months before.
    const dated = resolveRounds([seriesA, at({ ...seed, announced_date: "2026-03-02" })], opts);
    expect(dated.kept[0]?.earlier_rounds).toBeUndefined();
  });

  test("a single-story page's headline states what it reports; a round far from that amount is background", () => {
    const title = "AI Unicorn Secures $3.7 Billion New Financing Round, Driving Total Valuation to $33.6 Billion";
    expect(headlineAmount(title)).toEqual({ value: 3700, currency: "USD" });
    expect(headlineAmount("Acme raises 40 million euros")).toEqual({ value: 40, currency: "EUR" });
    expect(headlineAmount("Acme raises a Series B")).toBeNull();
    expect(backgroundByPageShape({ title, roundsOnPage: 2, amountValue: 150, amountCurrency: "USD" })).toBe(true);
    expect(
      backgroundByPageShape({
        title: "Heidi raises $340 million",
        roundsOnPage: 1,
        amountValue: 100,
        amountCurrency: "USD",
        additionalFinancing: { value: 240, currency: "USD" },
      }),
    ).toBe(false);
    expect(
      backgroundByPageShape({
        title,
        roundsOnPage: 2,
        amountValue: 150,
        amountCurrency: "USD",
        additionalFinancing: { value: 240, currency: "USD" },
      }),
    ).toBe(true);
    expect(backgroundByPageShape({ title, roundsOnPage: 2, amountValue: 3500, amountCurrency: "USD" })).toBe(false);
    // Roundups report many rounds by design; a list is a list whatever its title says.
    expect(
      backgroundByPageShape({
        title: "Weekly funding roundup: $3.7B for one AI lab",
        roundsOnPage: 2,
        amountValue: 20,
        amountCurrency: "USD",
      }),
    ).toBe(false);
    expect(backgroundByPageShape({ title, roundsOnPage: 5, amountValue: 20, amountCurrency: "USD" })).toBe(false);
    // Different currencies are not compared, and a round with no amount is left to the extractor's flag.
    expect(backgroundByPageShape({ title, roundsOnPage: 2, amountValue: 150, amountCurrency: "EUR" })).toBe(false);
    expect(backgroundByPageShape({ title, roundsOnPage: 2, amountValue: null, amountCurrency: null })).toBe(false);
    // Through the resolver: the smaller mention on the same article is dropped as background.
    const { kept, dropped } = resolveRounds(
      [
        {
          round: round({
            company_name: "Wonderful",
            round_type_as_written: "Series B",
            amount_as_written: "150 million US dollars (about 1.01 billion yuan)",
            announced_date: "2026-09-04",
          }),
          source: { url: "https://eu.36kr.com/en/p/ai-unicorn", host: "eu.36kr.com", title, published: "2026-09-04" },
        },
        {
          round: round({
            company_name: "Zhipu",
            round_type_as_written: "Series D",
            amount_as_written: "$3.7 billion",
            announced_date: "2026-09-04",
          }),
          source: { url: "https://eu.36kr.com/en/p/ai-unicorn", host: "eu.36kr.com", title, published: "2026-09-04" },
        },
      ],
      { stages: ["series_b", "series_d_plus"], windowStart: WEEK, now: NOW, rates: { date: "2026-09-02", perUsd: {} } },
    );
    expect(dropped.background).toBe(1);
    expect(kept.map((r) => r.company_key)).toEqual(["zhipu"]);
  });
});

describe("company names and aliases", () => {
  test("a paywalled preview's 'Valley startup' or a list of companies is no company", () => {
    expect(isGenericCompanyName("Valley startup")).toBe(true);
    expect(isGenericCompanyName("Chicago upstart")).toBe(true);
    expect(isGenericCompanyName("The company")).toBe(true);
    expect(isGenericCompanyName("Phoenix Startup Inc")).toBe(false);
    expect(isGenericCompanyName("Acme, Beta, Gamma, Delta and Epsilon")).toBe(true);
    expect(isGenericCompanyName("Procter & Gamble")).toBe(false);
  });

  test("a capitalised name ending in Company is a company; a described one is not", () => {
    expect(isGenericCompanyName("Bangalore Watch Company")).toBe(false);
    expect(isGenericCompanyName("KHOY Company")).toBe(false);
    expect(isGenericCompanyName("Zari Company")).toBe(false);
    expect(isGenericCompanyName("The Company")).toBe(true);
    expect(isGenericCompanyName("a watch company")).toBe(true);
    expect(isGenericCompanyName("Indian watch company")).toBe(true);
  });

  test("a two-entity subject of one brand is the first; an ampersand brand is one entity", () => {
    expect(firstOfTwoEntities("AusperBio Therapeutics and Ausper Biopharma")).toBe("AusperBio Therapeutics");
    expect(firstOfTwoEntities("Procter & Gamble")).toBe("Procter & Gamble");
    expect(firstOfTwoEntities("Ben & Jerry's")).toBe("Ben & Jerry's");
  });

  test("isAlias needs shared domain for short single tokens", () => {
    const base = {
      id: "",
      company_name: "",
      company_website: null,
      company_description: null,
      stage: "series_a" as const,
      stage_as_written: "",
      is_extension: false,
      amount: { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null },
      valuation_as_written: null,
      lead_investors: [],
      other_investors: [],
      announced_date: null,
      date_precision: "unknown" as const,
      headquarters: null,
      sector: null,
      evidence_quotes: [],
      sources: [],
      confidence: 0,
      status: "new" as const,
      undated: true,
    };
    expect(
      isAlias({ ...base, company_key: "light", company_domain: null }, { ...base, company_key: "light field", company_domain: null }),
    ).toBe(false);
    expect(
      isAlias(
        { ...base, company_key: "light", company_domain: "light.com" },
        { ...base, company_key: "light field", company_domain: "light.com" },
      ),
    ).toBe(true);
  });
});

describe("resolveRounds", () => {
  test("dedupes by company and stage, fills gaps, keeps every source, drops the rest", () => {
    const { kept, dropped } = resolveRounds(
      [
        item(
          round({ company_name: "Acme Inc.", round_type_as_written: "Series A", amount_as_written: "$20M", announced_date: "2026-09-02" }),
          "https://news.example/acme-1",
        ),
        item(
          round({
            company_name: "ACME",
            round_type_as_written: "$20M Series A",
            lead_investors: ["Fund One"],
            company_website: "https://acme.com",
          }),
          "https://wire.example/acme-2",
          "2026-09-02",
        ),
        item(
          round({ company_name: "Beta Labs", round_type_as_written: "Seed", announced_date: "2026-09-01" }),
          "https://news.example/beta",
        ),
        item(
          round({ company_name: "Gamma", round_type_as_written: "Series B", announced_date: "2026-07-01" }),
          "https://news.example/gamma",
        ),
        item(
          round({ company_name: "OldCo", round_type_as_written: "Series A", is_background: true }),
          "https://news.example/newco",
          "2026-09-02",
        ),
        item(
          round({ company_name: "Talks Inc", round_type_as_written: "Series A", is_rumor: true, announced_date: "2026-09-03" }),
          "https://news.example/talks",
        ),
        item(round({ company_name: "Delta", round_type_as_written: "Series B" }), "https://news.example/delta"),
      ],
      { stages: ["series_a", "series_b"], windowStart: WEEK, now: NOW, rates: { date: "2026-09-02", perUsd: {} } },
    );
    expect(dropped).toEqual({
      otherStage: 1,
      notARound: 0,
      background: 1,
      rumor: 1,
      outOfWindow: 1,
      undatedTimeline: 0,
      ungrounded: 0,
      nonArticle: 0,
      unnamed: 0,
      unrelatedSource: 0,
    });
    expect(kept).toHaveLength(2);
    const acme = kept.find((r) => r.company_key === "acme");
    expect(acme).toBeDefined();
    expect(acme?.stage).toBe("series_a");
    expect(acme?.amount.value).toBe(20);
    expect(acme?.amount.usd_millions).toBe(20);
    expect(acme?.lead_investors).toEqual(["Fund One"]);
    expect(acme?.company_domain).toBe("acme.com");
    expect(acme?.sources).toHaveLength(2);
    expect(acme?.undated).toBe(false);
    expect(acme?.id).toBe("acme:series_a:2026-09-02");
    const delta = kept.find((r) => r.company_key === "delta");
    expect(delta?.undated).toBe(true);
  });

  test("dates from the URL, scrubs article and social URLs posing as websites, keeps totals out of amount", () => {
    const { kept, dropped } = resolveRounds(
      [
        item(round({ company_name: "Stale", round_type_as_written: "Series A" }), "https://digest.example/funding-digest-2026-08-14"),
        item(
          round({
            company_name: "Fresh",
            round_type_as_written: "Series B",
            company_website: "https://news.example/2026/09/03/fresh-raises",
            amount_as_written: "$120M",
            amount_kind: "total_funding",
          }),
          "https://news.example/2026/09/03/fresh-raises",
        ),
        item(
          round({
            company_name: "Social",
            round_type_as_written: "Series A",
            company_website: "https://www.linkedin.com/company/social",
            announced_date: "2026-09-03",
          }),
          "https://a.example/s",
        ),
      ],
      { stages: ["series_a", "series_b"], windowStart: WEEK, now: NOW },
    );
    expect(dropped.outOfWindow).toBe(1);
    const fresh = kept.find((r) => r.company_key === "fresh");
    expect(fresh?.announced_date).toBe("2026-09-03");
    expect(fresh?.company_website).toBeNull();
    expect(fresh?.amount.value).toBeNull();
    expect(fresh?.amount.as_written).toBeNull();
    const social = kept.find((r) => r.company_key === "social");
    expect(social?.company_website).toBeNull();
  });

  test("merges the same company under two names when amounts agree; keeps different deals apart", () => {
    const { kept } = resolveRounds(
      [
        item(
          round({
            company_name: "REGENT",
            round_type_as_written: "Series B",
            amount_as_written: "$120m",
            announced_date: "2026-08-31",
            company_website: "https://www.regentcraft.com/",
          }),
          "https://a.example/1",
        ),
        item(
          round({
            company_name: "Regent Craft",
            round_type_as_written: "Series B",
            amount_as_written: "around $120m",
            announced_date: "2026-08-29",
            company_website: "https://regentcraft.com/",
          }),
          "https://b.example/2",
        ),
        item(
          round({
            company_name: "Light",
            round_type_as_written: "Series A",
            amount_as_written: "$46 million",
            announced_date: "2026-09-01",
          }),
          "https://c.example/3",
        ),
        item(
          round({
            company_name: "Light Field",
            round_type_as_written: "Series A",
            amount_as_written: "$8 million",
            announced_date: "2026-09-01",
          }),
          "https://d.example/4",
        ),
      ],
      { stages: ["series_a", "series_b"], windowStart: WEEK, now: NOW },
    );
    const b = kept.filter((r) => r.stage === "series_b");
    expect(b).toHaveLength(1);
    expect(b[0].company_name).toBe("Regent Craft");
    expect(b[0].sources).toHaveLength(2);
    expect(b[0].company_domain).toBe("regentcraft.com");
    expect(kept.filter((r) => r.stage === "series_a")).toHaveLength(2);
  });

  test("reviewer aliases resolve before dedupe", () => {
    const { kept } = resolveRounds(
      [
        item(
          round({ company_name: "Hidden Layer", round_type_as_written: "Series B", announced_date: "2026-09-02" }),
          "https://a.example/1",
        ),
        item(
          round({ company_name: "HiddenLayer", round_type_as_written: "Series B", announced_date: "2026-09-02" }),
          "https://b.example/2",
        ),
      ],
      { stages: ["series_b"], windowStart: WEEK, now: NOW, aliases: { "hidden layer": "hiddenlayer" } },
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].sources).toHaveLength(2);
  });
});

describe("confidence", () => {
  test("scores and routes records", () => {
    const { kept } = resolveRounds(
      [
        item(
          round({
            company_name: "Wired",
            round_type_as_written: "Series A",
            amount_as_written: "$46 million",
            lead_investors: ["Matrix"],
            announced_date: "2026-09-01",
          }),
          "https://www.prnewswire.com/x",
        ),
        item(
          round({
            company_name: "Wired",
            round_type_as_written: "Series A",
            amount_as_written: "$46 million",
            lead_investors: ["Matrix"],
            announced_date: "2026-09-01",
          }),
          "https://techcrunch.com/2026/09/01/wired",
        ),
        item(round({ company_name: "Thin", round_type_as_written: "Series B" }), "https://unknown.example/credentials"),
      ],
      { stages: ["series_a", "series_b"], windowStart: WEEK, now: NOW },
    );
    const wired = kept.find((r) => r.company_key === "wired");
    const thin = kept.find((r) => r.company_key === "thin");
    expect(wired?.confidence).toBeGreaterThanOrEqual(0.75);
    expect(thin?.confidence).toBeLessThan(0.5);
    const buckets = splitByDisposition(kept);
    expect(buckets.publish.map((r) => r.company_key)).toEqual(["wired"]);
    expect(buckets.review.map((r) => r.company_key)).toEqual(["thin"]);
    if (wired) expect(scoreConfidence(wired, {})).toBeLessThan(wired.confidence);
  });
});

describe("schema", () => {
  test("emits a JSON Schema Firecrawl can consume", () => {
    const s = roundsPageJsonSchema as { type: string; properties: Record<string, unknown>; required?: string[] };
    expect(s.type).toBe("object");
    expect(Object.keys(s.properties)).toEqual(["page_kind", "page_date", "rounds"]);
    expect(s.required).toEqual(["page_kind", "page_date", "rounds"]);
    expect((s.properties.page_kind as { enum: string[] }).enum).toEqual([...PAGE_KINDS]);
    const items = (s.properties.rounds as { items: { properties: Record<string, unknown>; required: string[] } }).items;
    expect(items.required).toContain("evidence_quote");
    expect(items.required).toContain("field_quotes");
    expect(items.required).toContain("is_background");
    expect(items.required).toContain("is_rumor");
    expect((items.properties.amount_kind as { enum: string[] }).enum).toEqual(["round", "total_funding", "valuation", "unknown"]);
  });
});

describe("same round: the window two sightings must fall in", () => {
  test("is 45 days on the same stage, a week across stages, and stage-only when a side is undated", () => {
    expect(sameRoundWindow({ stage: "seed", announced_date: "2026-09-01" }, { stage: "seed", announced_date: "2026-10-10" })).toBe(true);
    expect(sameRoundWindow({ stage: "seed", announced_date: "2026-09-01" }, { stage: "seed", announced_date: "2026-10-20" })).toBe(false);
    expect(sameRoundWindow({ stage: "seed", announced_date: "2026-09-01" }, { stage: "series_a", announced_date: "2026-09-07" })).toBe(
      true,
    );
    expect(sameRoundWindow({ stage: "seed", announced_date: "2026-09-01" }, { stage: "series_a", announced_date: "2026-09-09" })).toBe(
      false,
    );
    expect(sameRoundWindow({ stage: "seed", announced_date: null }, { stage: "seed", announced_date: "2026-09-09" })).toBe(true);
    expect(sameRoundWindow({ stage: "seed", announced_date: null }, { stage: "pre_seed", announced_date: "2026-09-09" })).toBe(false);
  });
});
