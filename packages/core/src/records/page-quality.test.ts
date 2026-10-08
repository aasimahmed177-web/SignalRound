import { describe, expect, test } from "vitest";
import { extractRounds, NOT_ARTICLE_ERROR, pageItems, visibleArticleDate } from "../firecrawl/extract.ts";
import { articleCandidates } from "../firecrawl/sweep.ts";
import { classifyRoundCertainty } from "./certainty.ts";
import { hostOf, isArticleUrl, isCompanyDescription, parseAmount, parseDate, parseStatedDate, stripFurniture } from "./normalize.ts";
import { backgroundByPageShape } from "./page-shape.ts";
import type { ExtractedItem } from "./resolve.ts";
import { cleanRound, datelineLocation, isRumorText, resolveRounds, scrubHeadquarters, trustedWebsite } from "./resolve.ts";
import type { ExtractedRound, PageKind } from "./schema.ts";
import { RoundsPageLenient } from "./schema.ts";

/** The run's clock. Every case below checks that it never becomes a record's date. */
const NOW = new Date("2026-09-04T12:00:00Z");
const RUN_DAY = "2026-09-04";
const WEEK = new Date("2026-08-28T12:00:00Z");
const MONTH = new Date("2026-08-01T12:00:00Z");

function round(partial: Partial<ExtractedRound> & { company_name: string }): ExtractedRound {
  return {
    round_type_as_written: "seed",
    company_website: null,
    company_description: null,
    amount_as_written: "$5M",
    amount_kind: "round",
    valuation_as_written: null,
    lead_investors: [],
    other_investors: [],
    announced_date: null,
    headquarters: null,
    sector: null,
    evidence_quote: `${partial.company_name} raised ${partial.amount_as_written ?? "$5M"} in seed funding.`,
    source_url: null,
    is_background: false,
    is_rumor: false,
    ...partial,
  };
}

function item(r: ExtractedRound, url: string, extra: Partial<ExtractedItem> = {}): ExtractedItem {
  return { round: r, source: { url, host: hostOf(url), published: RUN_DAY }, ...extra };
}

const resolve = (items: ExtractedItem[], windowStart = WEEK) =>
  resolveRounds(items, { stages: ["seed", "series_a"], windowStart, now: NOW });

describe("isArticleUrl: the audit's index, directory, and profile URLs", () => {
  test("declines site roots, section indexes, paginated lists, archives, and directory hosts", () => {
    const declined = [
      "https://payloadspace.com/",
      "https://sesamers.com/",
      "https://www.seedtable.com/funding-rounds",
      "https://financialit.net/news/fundraising?page=146",
      "https://www.prnewswire.com/news-releases/financial-services-latest-news/venture-capital-list/",
      "https://privateequitylist.com/blog/top-pre-seed-investors",
      "https://www.windportfolio.com/companies/acme",
      "https://app.dealroom.co/companies/acme",
      "https://www.tipranks.com/private-companies/immediate",
      "https://cryptorank.io/ico/polaris-protocol",
      "https://www.linkedin.com/company/acme",
      "https://www.crunchbase.com/organization/acme",
      "https://tracxn.com/d/companies/acme",
      "https://techcrunch.com/category/startups/",
      "https://example.com/tag/funding/",
      "https://example.com/topic/venture",
      "https://example.com/author/jane/",
      "https://example.com/page/3",
      "https://example.com/news/page/12",
      "https://example.com/news",
      "https://example.com/blog",
      "https://example.com/insights",
      "https://example.com/investors",
      "https://example.com/portfolio",
      "https://example.com/about",
      // A record in a directory of companies or investors, whatever the host: the Blue Lake Capital page that put five old rounds in the feed.
      "https://startupfundraising.com/companies/backed-by/blue-lake-capital",
      "https://example.com/investors/sequoia-capital",
      "https://example.com/portfolio/acme",
      "https://example.com/funds/acme-ventures/portfolio-companies",
      "not a url",
    ];
    for (const url of declined) expect(isArticleUrl(url), url).toBe(false);
  });

  test("keeps article URLs, including two-segment paths under a section and a publisher on a directory's domain", () => {
    const kept = [
      "https://techcrunch.com/2026/09/02/acme-raises-20m/",
      "https://www.businesswire.com/news/home/20260826123456/en/Transfyr-Launches",
      "https://www.prnewswire.com/news-releases/acme-announces-series-a-302123456.html",
      "https://news.crunchbase.com/venture/acme-seed/",
      "https://example.com/news/acme-raises",
      "https://example.com/blog/acme-series-a",
      "https://www.marriottharrison.com/experience/acme-series-a",
      "https://wamda.com/2026/09/remedium-raises-seed",
      "https://www.tipranks.com/news/private-companies/baselayer-secures-35-million-to-build-identity-infrastructure-for-ai-agents",
      "https://cryptorank.io/news/feed/acme-raises-seed",
    ];
    for (const url of kept) expect(isArticleUrl(url), url).toBe(true);
  });

  test("the sweep counts what it declines", () => {
    const candidate = (url: string) => ({ url, queries: ["seed funding"], kinds: ["news" as const] });
    const { kept, notArticle } = articleCandidates([
      candidate("https://techcrunch.com/2026/09/02/acme-raises-20m/"),
      candidate("https://www.seedtable.com/funding-rounds"),
      candidate("https://financialit.net/news/fundraising?page=146"),
    ]);
    expect(kept.map((c) => c.url)).toEqual(["https://techcrunch.com/2026/09/02/acme-raises-20m/"]);
    expect(notArticle).toBe(2);
  });

  test("an article declined only by its title is held for the classifier; a non-article never is", () => {
    const candidate = (url: string, title: string) => ({ url, title, queries: ["seed funding"], kinds: ["news" as const] });
    const { kept, heldByTitle } = articleCandidates([
      candidate("https://techcrunch.com/2026/09/02/acme-raises-20m/", "Acme raises $20M Series A"),
      candidate("https://news.example.com/2026/09/02/seed-tracker/", "Seed Funding Tracker"),
      candidate("https://www.seedtable.com/funding-rounds", "Seed Funding Tracker"),
    ]);
    expect(kept.map((c) => c.url)).toEqual(["https://techcrunch.com/2026/09/02/acme-raises-20m/"]);
    expect(heldByTitle.map((c) => c.url)).toEqual(["https://news.example.com/2026/09/02/seed-tracker/"]);
  });

  test("extractRounds declines a non-article before scraping and reports it", async () => {
    const scraped: string[] = [];
    const client = {
      async scrape(url: string) {
        scraped.push(url);
        return { json: { page_kind: "article", page_date: "2026-09-02", rounds: [] }, markdown: "", metadata: {} };
      },
    };
    const result = await extractRounds(client as never, [
      { url: "https://privateequitylist.com/blog/top-pre-seed-investors" },
      { url: "https://techcrunch.com/2026/09/02/acme/" },
    ]);
    expect(scraped).toEqual(["https://techcrunch.com/2026/09/02/acme/"]);
    expect(result.notArticle).toBe(1);
    expect(result.pages.find((p) => !p.ok)?.error).toBe(NOT_ARTICLE_ERROR);
    expect(result.creditsEstimated).toBeGreaterThan(0);
  });
});

describe("page_kind: what the page is decides whether its rounds are news", () => {
  const source = "https://example.com/some/page";
  const roundsFor = (kind: PageKind) => [
    item(round({ company_name: `Co ${kind}`, announced_date: "2026-09-02" }), source, { page_kind: kind }),
  ];

  test("listing, profile, analysis, and other pages are dropped and counted", () => {
    for (const kind of ["listing", "profile", "analysis", "other"] as const) {
      const { kept, dropped } = resolve(roundsFor(kind));
      expect(kept, kind).toHaveLength(0);
      expect(dropped.nonArticle, kind).toBe(1);
    }
  });

  test("article, press_release, roundup, and newsletter pages keep their rounds", () => {
    for (const kind of ["article", "press_release", "roundup", "newsletter"] as const) {
      const { kept, dropped } = resolve(roundsFor(kind));
      expect(kept, kind).toHaveLength(1);
      expect(dropped.nonArticle, kind).toBe(0);
    }
  });

  test("an X timeline is read post by post whatever the extractor calls the page", () => {
    const post = "https://x.com/crunchbasenews/status/2095868614586905041";
    const { kept, dropped } = resolve([
      item(round({ company_name: "Postco", announced_date: "2026-09-03", source_url: post }), "https://x.com/crunchbasenews", {
        page_kind: "profile",
      }),
    ]);
    expect(kept).toHaveLength(1);
    expect(dropped.nonArticle).toBe(0);
  });

  test("a roundup's headline amount does not make its other rounds background", () => {
    const base = { title: "Acme raises $20M and four other rounds this week", roundsOnPage: 2, amountValue: 3, amountCurrency: "USD" };
    expect(backgroundByPageShape({ ...base, pageKind: "roundup" })).toBe(false);
    expect(backgroundByPageShape({ ...base, pageKind: "newsletter" })).toBe(false);
  });

  test("the lenient page schema reads an extractor result that omits the page fields", () => {
    const parsed = RoundsPageLenient.safeParse({ rounds: [] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ page_kind: null, page_date: null, rounds: [] });
    const bad = RoundsPageLenient.safeParse({ page_kind: "homepage", page_date: 20260902, rounds: [] });
    expect(bad.success).toBe(true);
    if (bad.success) expect([bad.data.page_kind, bad.data.page_date]).toEqual([null, null]);
  });

  test("pageItems carries the page's kind and date onto every item, and nothing when the extractor gave none", () => {
    const src = { url: source, host: "example.com" };
    const withPage = pageItems([round({ company_name: "A" })], src, undefined, { page_kind: "article", page_date: "2026-09-02" });
    expect(withPage[0]).toMatchObject({ page_kind: "article", page_date: "2026-09-02" });
    const without = pageItems([round({ company_name: "A" })], src, undefined);
    expect(without[0]).not.toHaveProperty("page_kind");
    expect(without[0]).not.toHaveProperty("page_date");
  });
});

describe("dates: the text, then the page, then the URL, then the search result, never the clock", () => {
  test("a numeric date both orders could read takes the order the page, or a fresh page's read time, supports", () => {
    const october8 = new Date("2026-10-08T15:00:00Z");
    const day = (s: string, ctx?: Parameters<typeof parseStatedDate>[1]) => parseStatedDate(s, ctx)?.toISOString().slice(0, 10) ?? null;
    // Veir's Investing.com India byline, read the day it ran, is 8 October.
    expect(day("Published08-10-2026, 07:40 pm", { near: october8 })).toBe("2026-10-08");
    // A US page's 10-08-2026, read the same day, is 8 October too.
    expect(day("10-08-2026", { near: october8 })).toBe("2026-10-08");
    // An old page's read time says nothing about its order: neither reading is near it, so no date.
    expect(day("03-04-2026", { near: october8 })).toBeNull();
    // Both readings after the read: no date rather than a future one.
    expect(day("11-12-2026", { near: october8 })).toBeNull();
    // Another date on the page decides before the clock does.
    expect(day("05-06-2026", { agree: [new Date("2026-05-06T12:00:00Z")], near: october8 })).toBe("2026-05-06");
    // No context at all: a guess either way, so no date.
    expect(day("08-10-2026")).toBeNull();
    // One order only, or the same either way: read as written.
    expect(day("25-09-2026")).toBe("2026-09-25");
    expect(day("09-25-2026")).toBe("2026-09-25");
    expect(day("08.08.2026")).toBe("2026-08-08");
    expect(day("Updated 08-10-2026", { near: october8 })).toBeNull();
    // Slashes: a fresh page's read time chooses, the page's other dates choose first, and otherwise
    // month first. Pro Shop's Variety byline "3/7/2024", read on Oct 5, 2026, is 7 March 2024.
    expect(day("08/10/2026", { near: october8 })).toBe("2026-10-08");
    expect(day("10/08/2026", { near: october8 })).toBe("2026-10-08");
    expect(day("- 3/7/2024 - by Alex Weprin", { near: new Date("2026-10-05T12:00:00Z") })).toBe("2024-03-07");
    expect(day("3/7/2024", { agree: [new Date("2024-07-03T12:00:00Z")], near: new Date("2026-10-05T12:00:00Z") })).toBe("2024-07-03");
    expect(day("25/09/2026")).toBe("2026-09-25");
    // The clock-reading parser uses its own clock the same way.
    expect(parseDate("Published08-10-2026, 07:40 pm", october8)?.toISOString().slice(0, 10)).toBe("2026-10-08");
    expect(parseDate("10-08-2026", october8)?.toISOString().slice(0, 10)).toBe("2026-10-08");
  });

  test("a byline under the headline is read in the page's context", () => {
    const md =
      "# Veir raises $110M Series C for superconducting power tech\n\nPublished08-10-2026, 07:40 pm\n\nInvesting.com - VEIR closed a $110 million Series C.";
    expect(visibleArticleDate(md, { near: new Date("2026-10-08T15:10:00Z") })).toBe("2026-10-08");
    expect(visibleArticleDate(md, { agree: [new Date("2026-08-10T12:00:00Z")], near: new Date("2026-10-08T15:10:00Z") })).toBe(
      "2026-08-10",
    );
  });

  test("parseStatedDate reads absolute dates and refuses anything that needs a clock", () => {
    const day = (s: string | null) => parseStatedDate(s)?.toISOString().slice(0, 10) ?? null;
    expect(day("2026-09-02")).toBe("2026-09-02");
    expect(day("2026-08-26T10:00:00Z")).toBe("2026-08-26");
    expect(day("Sept. 2, 2026")).toBe("2026-09-02");
    expect(day("2 September 2026")).toBe("2026-09-02");
    expect(day("April 6, 2026")).toBe("2026-04-06");
    expect(day("01.02.2021")).toBe("2021-02-01");
    expect(day("today")).toBeNull();
    expect(day("2 days ago")).toBeNull();
    expect(day("this week")).toBeNull();
    expect(day("Aug 13")).toBeNull();
    expect(day("September 2026")).toBeNull();
    expect(day("Updated September 03, 2026")).toBeNull();
    expect(day("")).toBeNull();
    expect(day(null)).toBeNull();
  });

  test("nymcard: a 2021 byline outranks the search result's run-day date, so the round is out of window", () => {
    const { kept, dropped } = resolve([
      item(round({ company_name: "NymCard" }), "https://example.com/nymcard-raises", { page_date: "01.02.2021" }),
    ]);
    expect(kept).toHaveLength(0);
    expect(dropped.outOfWindow).toBe(1);
  });

  test("zsystems: the round's stated date beats the page's 'Updated' stamp and the run day", () => {
    const items = [
      item(round({ company_name: "Zsystems", announced_date: "April 6, 2026" }), "https://example.com/news/zsystems-raises-series-a", {
        page_kind: "article",
        page_date: "Updated September 03, 2026",
      }),
    ];
    const week = resolve(items);
    expect(week.kept).toHaveLength(0);
    expect(week.dropped.outOfWindow).toBe(1);
    const wide = resolveRounds(items, { stages: ["seed"], windowStart: new Date("2026-04-01T12:00:00Z"), now: NOW });
    expect(wide.kept[0]?.announced_date).toBe("2026-04-06");
  });

  test("transfyr: 'today' in the text resolves to the page's own date, not the run's", () => {
    const { kept } = resolve(
      [
        item(
          round({ company_name: "Transfyr", announced_date: "today" }),
          "https://www.businesswire.com/news/home/20260826123456/en/Transfyr",
          {
            page_kind: "press_release",
            page_date: "2026-08-26",
          },
        ),
      ],
      MONTH,
    );
    expect(kept[0]?.announced_date).toBe("2026-08-26");
    expect(kept[0]?.undated).toBe(false);
  });

  test("ipremom: the round's own stated date wins over everything else", () => {
    const { kept } = resolve([
      item(round({ company_name: "iPremom", announced_date: "Announced 2 September 2026" }), "https://example.com/2026/09/03/ipremom", {
        page_date: "2026-09-03",
      }),
    ]);
    expect(kept[0]?.announced_date).toBe("2026-09-02");
  });

  test("a date in the URL outranks the search result's date", () => {
    const { kept } = resolve([item(round({ company_name: "Urlco" }), "https://example.com/2026/09/01/urlco-raises")], MONTH);
    expect(kept[0]?.announced_date).toBe("2026-09-01");
  });

  test("the search result's date is the last rung", () => {
    const r = round({ company_name: "Searchco" });
    const { kept } = resolve([
      { round: r, source: { url: "https://example.com/searchco-raises", host: "example.com", published: "2026-09-02" } },
    ]);
    expect(kept[0]?.announced_date).toBe("2026-09-02");
  });

  test("a round with no date anywhere stays undated rather than taking the run day", () => {
    const r = round({ company_name: "Nodate", announced_date: "recently" });
    const { kept } = resolve([
      { round: r, source: { url: "https://example.com/nodate-raises", host: "example.com" }, page_date: "this week" },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.undated).toBe(true);
    expect(kept[0]?.announced_date).toBeNull();
    expect(kept[0]?.id).toContain("undated");
  });
});

describe("rumors: language that says the money is not in the bank", () => {
  test("isRumorText catches the audit's phrasings and leaves closed rounds alone", () => {
    expect(isRumorText("Newspace is in talks to raise $35-40 million", "Series A")).toBe(true);
    expect(isRumorText("Scoop: Indigo raising $65M", "Series B")).toBe(true);
    expect(isRumorText("Acme is looking to raise a $10M seed", null)).toBe(true);
    expect(isRumorText("Acme seeks $10 million", null)).toBe(true);
    expect(isRumorText("Acme plans to raise $10 million next year", null)).toBe(true);
    expect(isRumorText("Acme has reportedly raised $10 million", null)).toBe(true);
    expect(isRumorText("Acme could raise up to $10 million", null)).toBe(true);
    expect(isRumorText("Acme is in advanced talks with investors", null)).toBe(true);
    expect(isRumorText("Acme raised $10M", "Series A (in talks)")).toBe(true);
    // The 2026-09-25 accuracy audit: a fund weighing a round, a round being closed, people familiar.
    expect(isRumorText("Korea’s National Growth Fund weighs joining Vessl AI’s $150 mn Series C round.", "Series C")).toBe(true);
    expect(isRumorText("The state fund is considering investing in Acme's Series B", null)).toBe(true);
    expect(isRumorText("Moxing Technology is closing a new funding round of about 1 billion yuan", null)).toBe(true);
    expect(isRumorText("Acme is about to complete a new round of financing", null)).toBe(true);
    expect(isRumorText("Acme raised $50 million, according to people familiar with the matter", null)).toBe(true);
    expect(isRumorText("Acme closed its Series A, which was led by Fund One.", "Series A")).toBe(false);
    expect(isRumorText("Fund One considered Acme's team the strongest it had met, and led the $8M seed.", "seed")).toBe(false);
    expect(isRumorText("Acme today announced it has raised $20 million in Series A funding.", "Series A")).toBe(false);
    expect(isRumorText("Acme closed a $5M seed round led by Fund One.", "seed")).toBe(false);
    expect(isRumorText(null, null)).toBe(false);
  });

  test("resolveRounds drops them under rumor even when the extractor said is_rumor false", () => {
    const { kept, dropped } = resolve([
      item(
        round({
          company_name: "Newspace",
          evidence_quote: "Newspace is in talks to raise $35-40 million.",
          amount_as_written: "$35-40 million",
        }),
        "https://example.com/newspace",
      ),
      item(
        round({
          company_name: "Indigo",
          evidence_quote: "Scoop: Indigo raising $65M",
          amount_as_written: "$65M",
          announced_date: "2026-09-02",
        }),
        "https://example.com/indigo",
      ),
      item(round({ company_name: "Closed", announced_date: "2026-09-02" }), "https://example.com/closed"),
    ]);
    expect(kept.map((r) => r.company_name)).toEqual(["Closed"]);
    expect(dropped.rumor).toBe(2);
  });
});

describe("round certainty", () => {
  test("classifies the evidence sentence before the extractor or Jev can call an open round closed", () => {
    expect(classifyRoundCertainty("Modal Labs is nearing a $750 million funding round led by Accel at a $15.75 billion valuation.")).toBe(
      "expected",
    );
    expect(classifyRoundCertainty("Acme is closing in on a $20 million Series A, according to people familiar.")).toBe("expected");
    expect(classifyRoundCertainty("Acme is in discussions over a term sheet for a $20 million Series A.")).toBe("expected");
    expect(classifyRoundCertainty("Acme has reportedly raised $20 million in a Series A.")).toBe("reported");
    expect(classifyRoundCertainty("Acme raised $20 million, according to people familiar with the matter.")).toBe("reported");
    expect(classifyRoundCertainty("Acme raised $20 million, sources say.")).toBe("reported");
    expect(classifyRoundCertainty("Apex Intelligence completed its round, raising nearly US$50 million.")).toBe("announced");
    expect(classifyRoundCertainty("A new registry could raise phone costs for consumers.")).toBe("announced");
    expect(classifyRoundCertainty("The round is said to be a second extension of its Series B round and has already closed.")).toBe(
      "reported",
    );
    expect(classifyRoundCertainty("Acme has closed a $20 million Series A, the company said.")).toBe("announced");
    expect(classifyRoundCertainty("Modal Labs is nearing $750 million.", null, "announced", "announced")).toBe("expected");
    expect(
      classifyRoundCertainty("Blue Origin raises $10 billion in its first outside financing round.", null, "expected", "expected"),
    ).toBe("announced");
  });

  test("an accepted closing supersedes Blue Origin's earlier seeking report in either merge order", () => {
    const sought = round({
      company_name: "Blue Origin",
      round_type_as_written: "growth round",
      amount_as_written: "$10 billion",
      announced_date: "2026-09-24",
      evidence_quote: "Blue Origin is working on a $10 billion funding round that would value the company at $130 billion.",
    });
    const raised = round({
      ...sought,
      evidence_quote: "Blue Origin raises $10 billion in its first outside financing round, valuing the business at about $140 billion.",
      certainty_quote: "Blue Origin seeks $10 billion in funding.",
      certainty_checked: "expected",
    });
    const reports = [
      {
        round: sought,
        source: {
          url: "https://www.wsj.com/business/blue-origin-seeks-10-billion",
          host: "wsj.com",
          title: "Bezos’ Space Venture Blue Origin Seeks $10 Billion in Funding Round",
        },
      },
      {
        round: raised,
        source: {
          url: "https://finance.yahoo.com/news/blue-origin-raises-10-billion",
          host: "finance.yahoo.com",
          title: "Blue Origin raises $10 billion in first outside funding",
        },
      },
    ];
    for (const items of [reports, [...reports].reverse()]) {
      const { kept } = resolveRounds(items, {
        stages: ["growth"],
        windowStart: new Date("2026-09-20T00:00:00Z"),
        now: new Date("2026-09-29T00:00:00Z"),
      });
      expect(kept).toHaveLength(1);
      expect(kept[0].certainty).toBe("announced");
      expect(kept[0].sources).toHaveLength(2);
      expect(kept[0].evidence_quotes).toContain(sought.evidence_quote);
      expect(kept[0].evidence_quotes).toContain(raised.evidence_quote);
    }
  });

  test("keeps tiered press reports with certainty and excludes unranked rumors", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    const modal = round({
      company_name: "Modal Labs",
      round_type_as_written: "growth round",
      amount_as_written: "$750 million",
      evidence_quote: "Modal Labs is nearing a $750 million funding round led by Accel at a $15.75 billion valuation.",
      announced_date: "2026-09-28",
      is_rumor: true,
    });
    const reported = round({
      company_name: "Acme",
      amount_as_written: "$20 million",
      evidence_quote: "Acme has reportedly raised $20 million in a seed round.",
      announced_date: "2026-09-28",
      is_rumor: true,
    });
    const { kept, dropped } = resolveRounds(
      [
        { round: modal, source: { url: "https://techcrunch.com/2026/09/28/modal-nearing-round/", host: "techcrunch.com" } },
        { round: reported, source: { url: "https://techcrunch.com/2026/09/28/acme-raised/", host: "techcrunch.com" } },
        {
          round: { ...modal, company_name: "Unranked", evidence_quote: "Unranked is nearing a $750 million funding round." },
          source: { url: "https://forum.example/unranked-nearing/", host: "forum.example" },
        },
      ],
      { stages: ["seed", "other", "growth"], windowStart: new Date("2026-09-20T00:00:00Z"), now },
    );
    expect(kept.map((record) => [record.company_name, record.certainty])).toEqual([
      ["Modal Labs", "expected"],
      ["Acme", "reported"],
    ]);
    expect(kept[0]?.amount.value).toBe(750);
    expect(kept[0]?.evidence_quotes).toContain(modal.evidence_quote);
    expect(dropped.rumor).toBe(1);
  });

  test("a confirmed reading upgrades an earlier report in the same batch without losing its quote", () => {
    const report = round({
      company_name: "Acme",
      amount_as_written: "$20 million",
      announced_date: "2026-09-28",
      evidence_quote: "Acme has reportedly raised $20 million in seed funding, according to people familiar.",
    });
    const release = round({
      company_name: "Acme",
      amount_as_written: "$20 million",
      announced_date: "2026-09-29",
      evidence_quote: "Acme announced it has closed $20 million in seed funding.",
    });
    const { kept } = resolveRounds(
      [
        { round: report, source: { url: "https://techcrunch.com/2026/09/28/acme-report/", host: "techcrunch.com" } },
        { round: release, source: { url: "https://www.prnewswire.com/news-releases/acme-round-302123456.html", host: "prnewswire.com" } },
      ],
      { stages: ["seed"], windowStart: new Date("2026-09-20T00:00:00Z"), now: new Date("2026-09-30T00:00:00Z") },
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.certainty).toBe("announced");
    expect(kept[0]?.evidence_quotes).toContain(report.evidence_quote);
    expect(kept[0]?.evidence_quotes).toContain(release.evidence_quote);
  });
});

describe("currency prefixes: the dollar sign is not the currency", () => {
  test("prefixed dollars map to their ISO codes and US$ stays USD", () => {
    const cases: Array<[string, number, string]> = [
      ["NZ$2 million", 2, "NZD"],
      ["AU$1.64 million", 1.64, "AUD"],
      ["A$5M", 5, "AUD"],
      ["C$10M", 10, "CAD"],
      ["CA$10M", 10, "CAD"],
      ["S$3M", 3, "SGD"],
      ["SG$3M", 3, "SGD"],
      ["HK$100M", 100, "HKD"],
      ["R$20 million", 20, "BRL"],
      ["NT$1 billion", 1000, "TWD"],
      ["MX$50M", 50, "MXN"],
      ["US$7M", 7, "USD"],
      ["$7M", 7, "USD"],
    ];
    for (const [text, value, currency] of cases) expect(parseAmount(text), text).toEqual({ value, currency });
  });

  test("with two figures the first is the announced one", () => {
    expect(parseAmount("NZ$2 million (AU$1.64 million)")).toEqual({ value: 2, currency: "NZD" });
    expect(parseAmount("$90M (€77.5M)")).toEqual({ value: 90, currency: "USD" });
    expect(parseAmount("€77.5M ($90M)")).toEqual({ value: 77.5, currency: "EUR" });
  });
});

describe("headquarters: a dateline is where the release was issued", () => {
  test("datelineLocation reads the wire and newspaper dateline shapes", () => {
    expect(datelineLocation("SAN FRANCISCO, Sept. 2, 2026 /PRNewswire/ -- Acme today announced")).toBe("SAN FRANCISCO");
    expect(datelineLocation("DENVER--(BUSINESS WIRE)--Acme today announced")).toBe("DENVER");
    expect(datelineLocation("MADRID, 2 September 2026 -- PLD Space raised")).toBe("MADRID");
    expect(datelineLocation("New York, NY (GLOBE NEWSWIRE) Acme raised")).toBe("New York");
    expect(datelineLocation("Acme raised $20M in Series A funding.")).toBeNull();
    expect(datelineLocation(null)).toBeNull();
  });

  test("scrubHeadquarters nulls the dateline city unless the quote says the company is based there", () => {
    expect(scrubHeadquarters("San Francisco", "SAN FRANCISCO, Sept. 2, 2026 /PRNewswire/ -- Acme today announced")).toBeNull();
    expect(scrubHeadquarters("Denver, CO", "DENVER--(BUSINESS WIRE)--Acme today announced the acquisition")).toBeNull();
    expect(scrubHeadquarters("Elche, Spain", "MADRID, 2 September 2026 -- PLD Space raised")).toBe("Elche, Spain");
    expect(scrubHeadquarters("Austin", "AUSTIN, Sept. 2, 2026 /PRNewswire/ -- Austin-based Acme raised")).toBe("Austin");
    expect(scrubHeadquarters("Austin", "AUSTIN, Sept. 2, 2026 /PRNewswire/ -- Acme, headquartered in Austin, raised")).toBe("Austin");
    expect(scrubHeadquarters("London", "Acme raised $20M.")).toBe("London");
    expect(scrubHeadquarters(null, "SAN FRANCISCO, Sept. 2, 2026 /PRNewswire/ --")).toBeNull();
  });

  test("scrubHeadquarters nulls a city the quote gives an investor, not the company (Aqua Medical, P1-18)", () => {
    const parties = { company: "Aqua Medical", investors: ["Relevance Ventures"] };
    const quote =
      "PLEASANTON, Calif., Sept. 24, 2026 /PRNewswire/ -- Aqua Medical, Inc. today announced the closing of a Series B financing led by Nashville, TN-based Relevance Ventures.";
    expect(scrubHeadquarters("Nashville, Tenn.", quote, null, parties)).toBeNull();
    expect(
      scrubHeadquarters("Nashville", "Aqua Medical closed a Series B led by Nashville-based Relevance Ventures.", null, parties),
    ).toBeNull();
    // The company's own city stays, and so does a city both share.
    expect(
      scrubHeadquarters(
        "Nashville",
        "Nashville-based Aqua Medical raised a Series B from Nashville-based Relevance Ventures.",
        null,
        parties,
      ),
    ).toBe("Nashville");
    expect(
      scrubHeadquarters("Austin", "Austin-based Acme raised $5M led by Boston-based Fund One.", null, {
        company: "Acme",
        investors: ["Fund One"],
      }),
    ).toBe("Austin");
  });

  test("resolveRounds applies it to the record", () => {
    const { kept } = resolve([
      item(
        round({
          company_name: "TabaPay",
          headquarters: "Denver",
          announced_date: "2026-09-02",
          evidence_quote: "DENVER--(BUSINESS WIRE)--TabaPay raised $5M in seed funding.",
        }),
        "https://example.com/tabapay",
      ),
    ]);
    expect(kept[0]?.headquarters).toBeNull();
  });
});

describe("descriptions and furniture", () => {
  test("isCompanyDescription refuses use-of-funds and news clauses", () => {
    expect(isCompanyDescription("expands into additional international markets")).toBe(false);
    expect(isCompanyDescription("plans to hire 40 engineers")).toBe(false);
    expect(isCompanyDescription("will use the funds to scale")).toBe(false);
    expect(isCompanyDescription("The funding will accelerate growth")).toBe(false);
    expect(isCompanyDescription("to expand its platform")).toBe(false);
    expect(isCompanyDescription("raised $5M to build robots")).toBe(false);
    expect(isCompanyDescription("Acme is a payments platform for SMEs.")).toBe(true);
    expect(isCompanyDescription("A fintech for SMEs")).toBe(true);
    expect(isCompanyDescription("Payments infrastructure for marketplaces")).toBe(true);
    expect(isCompanyDescription("Expansion-stage logistics software")).toBe(true);
  });

  test("stripFurniture removes UI strings, including a splice into a name", () => {
    expect(stripFurniture("RwajDealroom has a profile for this one. raised $1M")).toBe("Rwaj raised $1M");
    expect(stripFurniture("RwajDealroom has a profile for this one.")).toBe("Rwaj");
    expect(stripFurniture("Acme raised $1M. Read more")).toBe("Acme raised $1M.");
    expect(stripFurniture("Dealroom has a profile for this one.")).toBeNull();
    expect(stripFurniture("Subscribers Inc")).toBe("Subscribers Inc");
    expect(stripFurniture(null)).toBeNull();
  });

  test("cleanRound reads lead language in the round's label when the quote has none (Ando, P1-18)", () => {
    const cleaned = cleanRound(
      round({
        company_name: "Ando",
        round_type_as_written: "pre-seed round led by Accel and seed round led by Index and Emergence",
        evidence_quote: "Ando has emerged from stealth with 20 million dollars in combined pre-seed and seed funding.",
        lead_investors: ["Accel", "Index Ventures", "Emergence"],
      }),
    );
    expect(cleaned.lead_investors).toEqual(["Accel", "Index Ventures", "Emergence"]);
    // Without lead language anywhere, the leads are still participants.
    const plain = cleanRound(
      round({
        company_name: "Ando",
        round_type_as_written: "seed",
        evidence_quote: "Ando raised $20M from Accel.",
        lead_investors: ["Accel"],
      }),
    );
    expect(plain.lead_investors).toEqual([]);
  });

  test("cleanRound drops a use-of-funds description and strips furniture from the name, the quote, and the investors", () => {
    const cleaned = cleanRound(
      round({
        company_name: "RwajDealroom has a profile for this one.",
        company_description: "expands into additional international markets",
        evidence_quote: "RwajDealroom has a profile for this one. raised $1M in seed funding.",
        lead_investors: ["Fund OneRead more"],
      }),
    );
    expect(cleaned.company_name).toBe("Rwaj");
    expect(cleaned.company_description).toBeNull();
    expect(cleaned.evidence_quote).toBe("Rwaj raised $1M in seed funding.");
    expect(cleaned.lead_investors).toEqual(["Fund One"]);
    expect(cleanRound(round({ company_name: "Acme", company_description: "Acme is a payments platform." })).company_description).toBe(
      "Acme is a payments platform.",
    );
  });
});

describe("website hygiene: a homepage on the company's own domain", () => {
  test("trustedWebsite refuses source domains, deep paths, queries, and social or directory hosts", () => {
    expect(trustedWebsite("https://www.wamda.com/2026/09/remedium", ["wamda.com"])).toBeNull();
    expect(trustedWebsite("https://wamda.com", ["wamda.com"])).toBeNull();
    expect(trustedWebsite("https://wamda.com", ["techcrunch.com", "wamda.com"])).toBeNull();
    expect(trustedWebsite("https://backbone.com/blog/announcing-our-seed", [])).toBeNull();
    expect(trustedWebsite("https://acme.com/?ref=newsletter", [])).toBeNull();
    expect(trustedWebsite("https://linkedin.com/company/acme", [])).toBeNull();
    expect(trustedWebsite("https://www.crunchbase.com/organization/acme", [])).toBeNull();
    expect(trustedWebsite("https://acme.com", ["techcrunch.com"])).toBe("https://acme.com");
    expect(trustedWebsite("https://acme.com/en", [])).toBe("https://acme.com/en");
    expect(trustedWebsite("acme.com", [])).toBe("acme.com");
    expect(trustedWebsite(null, [])).toBeNull();
  });

  test("the record-level pass checks the website against every source, not only the one that carried it", () => {
    const { kept } = resolve([
      item(
        round({ company_name: "Remedium", company_website: "https://www.wamda.com", announced_date: "2026-09-02" }),
        "https://techcrunch.com/2026/09/02/remedium/",
      ),
      item(
        round({ company_name: "Remedium", company_website: null, announced_date: "2026-09-02" }),
        "https://www.wamda.com/2026/09/remedium-raises",
      ),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.company_website).toBeNull();
    expect(kept[0]?.company_domain).toBeNull();
  });

  test("an announcement post is not a homepage", () => {
    const { kept } = resolve([
      item(
        round({ company_name: "Backbone", company_website: "https://backbone.com/blog/announcing-our-seed", announced_date: "2026-09-02" }),
        "https://example.com/backbone",
      ),
    ]);
    expect(kept[0]?.company_website).toBeNull();
    expect(kept[0]?.company_domain).toBeNull();
  });
});
