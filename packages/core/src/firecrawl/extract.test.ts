// The two rules the extraction applies per page: a source is titled by the article itself (with
// the URL slug as the tie-breaker when the title names another company), and a round whose
// evidence is not in the page's own text is ungrounded and dropped by the resolver.

import type { Firecrawl } from "firecrawl";
import { describe, expect, test } from "vitest";
import { hostOf, humanizeSlug, urlSlug, windowStartFor } from "../records/normalize.ts";
import { resolveRounds } from "../records/resolve.ts";
import type { ExtractedRound } from "../records/schema.ts";
import {
  articleTitle,
  extractRounds,
  groundingCheck,
  guessedYear,
  mentionsCompany,
  offClock,
  pageDateline,
  pageItems,
  settleOnPage,
  sourceTitle,
  textWritesDay,
  visibleArticleDate,
  websiteOnPage,
  writtenDay,
} from "./extract.ts";

const NOW = new Date("2026-09-04T12:00:00Z");
const OLLIE_URL = "https://www.thesaasnews.com/news/ollie-raises-7-5m-seed";

function round(partial: Partial<ExtractedRound> & { company_name: string; evidence_quote: string }): ExtractedRound {
  return {
    round_type_as_written: "Seed",
    company_website: null,
    company_description: null,
    amount_as_written: null,
    amount_kind: "round",
    valuation_as_written: null,
    lead_investors: [],
    other_investors: [],
    announced_date: "2026-09-03",
    headquarters: null,
    sector: null,
    source_url: null,
    is_background: false,
    is_rumor: false,
    ...partial,
  };
}

const ARTICLE = `Receive funding alerts at TechFundingEvents.com!

![Ollie Raises $7.5M Seed](https://storage.ghost.io/content/images/2026/05/ollie.jpg)

Ollie Raises $7.5M Seed

Ollie, a San Diego-based company that offers a personal AI assistant for everyday life, has raised $7.5 million in a seed funding round. The company is positioning itself as a privacy-focused alternative in the crowded consumer AI market.

## Investors

This funding round was backed by [Khosla Ventures](https://khoslaventures.com/?ref=thesaasnews.com) and AI House.

## Funding Details

Company: Ollie

Raised: $7.5M

Round: Seed
`;

const SIDEBAR = `

## Related

Emberos Raises $5.5M Seed

Emberos, a Los Angeles-based startup that provides an operating system for AI brand management, has raised $5.5 million in a seed funding round.
`;

const OLLIE = round({
  company_name: "Ollie",
  amount_as_written: "$7.5 million",
  evidence_quote:
    "Ollie, a San Diego-based company that offers a personal AI assistant for everyday life, has raised $7.5 million in a seed funding round.",
});
const EMBEROS = round({
  company_name: "Emberos",
  amount_as_written: "$5.5 million",
  evidence_quote:
    "Emberos, a Los Angeles-based startup that provides an operating system for AI brand management, has raised $5.5 million in a seed funding round.",
});

describe("valuation quote grounding", () => {
  test("recovers an announced valuation from the grounded round sentence when the model cites an older figure", () => {
    const own = "Snorkel AI has raised a $350 million Series E at a $3.5 billion valuation.";
    const earlier = "The previous Series D valued Snorkel AI at $1.3 billion.";
    const result = settleOnPage(
      round({
        company_name: "Snorkel AI",
        amount_as_written: "$350 million",
        valuation_as_written: "$3.5 billion",
        valuation_quote: earlier,
        evidence_quote: own,
      }),
      `${own}\n${earlier}`,
    );
    expect(result.valuation_quote).toBe(own);
    expect(result.valuation_as_written).toBe("$3.5 billion");
  });

  test("never recovers a valuation from a quote absent from the captured page", () => {
    const result = settleOnPage(
      round({
        company_name: "Enveda",
        valuation_as_written: "$2 billion",
        valuation_quote: "The round valued Enveda at $2 billion.",
        evidence_quote: "Enveda raised a $311 million Series E at a $2 billion valuation.",
      }),
      "Checking your browser. Verification failed.",
    );
    expect(result.valuation_as_written).toBeNull();
  });
});

describe("articleTitle", () => {
  test("the Open Graph title first, then the first H1, then the page title, then the fallback", () => {
    const md = "# Ollie Raises $7.5M Seed\n\nBody.";
    expect(
      articleTitle(
        { metadata: { ogTitle: "Ollie Raises $7.5M Seed", title: "Emberos Raises $5.5M Seed - The SaaS News" }, markdown: md },
        "x",
      ),
    ).toBe("Ollie Raises $7.5M Seed");
    expect(articleTitle({ metadata: { title: "Emberos Raises $5.5M Seed - The SaaS News" }, markdown: md }, "x")).toBe(
      "Ollie Raises $7.5M Seed",
    );
    expect(articleTitle({ metadata: { title: "Ollie Raises $7.5M Seed - The SaaS News" }, markdown: "No heading here." })).toBe(
      "Ollie Raises $7.5M Seed - The SaaS News",
    );
    expect(articleTitle({ metadata: {}, markdown: "" }, "Search result title")).toBe("Search result title");
    expect(articleTitle({})).toBeUndefined();
  });

  test("blank metadata and non-string values fall through; a closing-hash H1 is trimmed", () => {
    expect(articleTitle({ metadata: { ogTitle: "  ", title: 42 }, markdown: "## Not an H1\n# Real title ##\n" }, "fb")).toBe("Real title");
  });
});

test("a newsroom day printed below the headline is publication evidence, not a crawl or update stamp", () => {
  expect(
    visibleArticleDate(
      "Announcements\n\n# Anthropic raises $13B Series F at $183B post-money valuation\n\nSep 2, 2025\n\nAnthropic has completed a Series F fundraising of $13 billion.",
    ),
  ).toBe("2025-09-02");
  expect(visibleArticleDate("# Old round remembered\n\nUpdated Sep 25, 2026\n\nThe company raised a seed years ago.")).toBeNull();
});

describe("slug titles", () => {
  test("urlSlug is the last path segment without its extension", () => {
    expect(urlSlug(OLLIE_URL)).toBe("ollie-raises-7-5m-seed");
    expect(urlSlug("https://news.example/2026/09/03/acme-raises-46m-series-b/")).toBe("acme-raises-46m-series-b");
    expect(urlSlug("https://news.example/story.html?x=1")).toBe("story");
    expect(urlSlug("https://news.example/")).toBe("");
    expect(urlSlug("not a url")).toBe("");
  });

  test("humanizeSlug reads a slug as a headline", () => {
    expect(humanizeSlug("ollie-raises-7-5m-seed")).toBe("Ollie raises 7.5M seed");
    expect(humanizeSlug("laters-com-raises-1-5m-seed")).toBe("Laters com raises 1.5M seed");
    expect(humanizeSlug("acme-raises-46m-series-b")).toBe("Acme raises 46M series b");
    expect(humanizeSlug("beta-labs-lands-2-billion-round-1234567")).toBe("Beta labs lands 2 billion round");
    expect(humanizeSlug("148809-crusoe-raises-3b-series-f")).toBe("Crusoe raises 3B series f");
    expect(humanizeSlug("")).toBe("");
  });

  test("mentionsCompany matches on normalized whole words, half the company's words or more", () => {
    expect(mentionsCompany("Emberos Raises $5.5M Seed - The SaaS News", "Ollie")).toBe(false);
    expect(mentionsCompany("Ollie Raises $7.5M Seed", "Ollie, Inc.")).toBe(true);
    expect(mentionsCompany("Laters.com Raises $1.5M Seed", "Laters.com")).toBe(true);
    expect(mentionsCompany("Newspace Research in talks to raise $35-40 million", "NewSpace Research and Technologies")).toBe(true);
    expect(mentionsCompany("Follies of the market", "Ollie")).toBe(false);
    expect(mentionsCompany("Saudi's Rwaj Raises USD 1.2M", "Nayla Finance")).toBe(false);
    expect(mentionsCompany(undefined, "Ollie")).toBe(false);
  });

  test("sourceTitle drops a search title that names another company while the slug names this one, and never uses the slug", () => {
    expect(sourceTitle("Emberos Raises $5.5M Seed - The SaaS News", OLLIE_URL, ["Ollie"])).toBeUndefined();
    expect(sourceTitle(undefined, OLLIE_URL, ["Ollie"])).toBeUndefined();
  });

  test("sourceTitle keeps a title that names the company, or when the slug does not name it either", () => {
    expect(sourceTitle("Ollie Raises $7.5M Seed", OLLIE_URL, ["Ollie"])).toBe("Ollie Raises $7.5M Seed");
    expect(sourceTitle("This week in venture", "https://news.example/this-week-in-venture", ["Ollie"])).toBe("This week in venture");
    expect(sourceTitle("Emberos Raises $5.5M Seed", OLLIE_URL, ["Emberos", "Ollie"])).toBe("Emberos Raises $5.5M Seed");
    expect(sourceTitle("Roundup", OLLIE_URL, [])).toBe("Roundup");
    expect(sourceTitle("Roundup", OLLIE_URL, ["AI Labs"])).toBe("Roundup");
  });

  test("sourceTitle keeps a roundup's own title even when only the slug names the company", () => {
    const title = "The Week's 10 Biggest Funding Rounds: AI Tools And Assistants Lead Sparser Lineup Of Megadeals";
    expect(
      sourceTitle(title, "https://news.crunchbase.com/venture/biggest-funding-rounds-ai-tools-assistants-instinct", ["Instinct"]),
    ).toBe(title);
    const weekly = "Industry Insights: The Week's Top Funding for Robotics, Automation, and Physical AI";
    const listUrl =
      "https://www.automate.org/robotics/industry-insights/robotics-raises-able-labs-easy-aerial-lupin-dental-motion-reframe-systems";
    expect(sourceTitle(weekly, listUrl, ["Able Labs", "Easy Aerial", "Lupin Dental", "Reframe Systems"])).toBe(weekly);
    expect(sourceTitle(undefined, listUrl, ["Able Labs", "Easy Aerial"])).toBeUndefined();
    // A sibling's title of the same shape shares too few words with the slug to be this article's.
    expect(
      sourceTitle("Laters.com Raises $1.5M Seed - The SaaS News", "https://www.thesaasnews.com/news/catch-raises-5m-seed", ["Catch"]),
    ).toBeUndefined();
  });
});

describe("groundingCheck", () => {
  test("a quote present in the page passes", () => {
    expect(groundingCheck(OLLIE, ARTICLE)).toBe(true);
  });

  test("a quote absent from the page fails", () => {
    expect(groundingCheck(EMBEROS, ARTICLE)).toBe(false);
    expect(groundingCheck({ evidence_quote: "" }, ARTICLE)).toBe(false);
  });

  test("whitespace, punctuation, case, and markdown links do not matter", () => {
    const quote = "This funding round was backed by Khosla Ventures and AI House";
    expect(groundingCheck({ evidence_quote: `  ${quote.toUpperCase()}!!  ` }, ARTICLE)).toBe(true);
    expect(
      groundingCheck(
        {
          evidence_quote:
            "Ollie,   a San Diego based company that offers a personal AI assistant for everyday life; has raised $7.5 million in a seed funding round",
        },
        ARTICLE,
      ),
    ).toBe(true);
  });

  test("a short quote passes when 85 percent of its tokens appear in order", () => {
    // 10 of 11 tokens in order ("today" is not on the page), the page's own words between them.
    expect(groundingCheck({ evidence_quote: "Ollie has raised 7.5 million in a seed round today" }, ARTICLE)).toBe(true);
    // 10 of 12 is under the bar.
    expect(groundingCheck({ evidence_quote: "Ollie has raised roughly 7.5 million in a seed round today" }, ARTICLE)).toBe(false);
    // Common words in order are not a match on their own.
    expect(groundingCheck({ evidence_quote: "Zeta raised million in seed funding" }, ARTICLE)).toBe(false);
  });

  test("a roundup passes each of its rounds on its own sentence", () => {
    const page = `${ARTICLE}\n${SIDEBAR}`;
    expect(groundingCheck(OLLIE, page)).toBe(true);
    expect(groundingCheck(EMBEROS, page)).toBe(true);
  });
});

describe("pageItems and the ungrounded count", () => {
  const source = { url: OLLIE_URL, host: hostOf(OLLIE_URL), title: "Emberos Raises $5.5M Seed - The SaaS News", published: "2026-09-03" };

  test("a two-round page whose second round lives in the sidebar keeps one and drops one as ungrounded", () => {
    const items = pageItems([OLLIE, EMBEROS], source, ARTICLE);
    expect(items.map((i) => i.grounded)).toEqual([true, false]);
    const { kept, dropped } = resolveRounds(items, { stages: ["seed"], windowStart: windowStartFor("week", NOW), now: NOW });
    expect(dropped.ungrounded).toBe(1);
    expect(kept.map((r) => r.company_name)).toEqual(["Ollie"]);
    // The sidebar round does not get a say in the title: only the grounded companies are checked, and
    // the sibling's search title goes without the slug taking its place.
    expect(kept[0].sources[0].title).toBeUndefined();
  });

  test("a roundup's rounds share the page's own title", () => {
    const page = `${ARTICLE}\n${SIDEBAR}`;
    const items = pageItems(
      [OLLIE, EMBEROS],
      { ...source, url: "https://news.example/weekly-ollie-emberos", title: "This week in seed" },
      page,
    );
    expect(items.map((i) => i.grounded)).toEqual([true, true]);
    expect(items.map((i) => i.source.title)).toEqual(["This week in seed", "This week in seed"]);
  });

  test("without markdown nothing is judged", () => {
    const items = pageItems([OLLIE, EMBEROS], source, undefined);
    expect(items.every((i) => i.grounded === undefined)).toBe(true);
    expect(resolveRounds(items, { stages: ["seed"], windowStart: windowStartFor("week", NOW), now: NOW }).dropped.ungrounded).toBe(0);
  });

  test("a website the page never names is the extractor's guess and goes: Creem's pages linked creem.io, not creem.com", () => {
    // The Recursive's article links the company as creem.io; the extractor wrote the name plus .com, a rock magazine's domain.
    const page =
      "Tallinn-based Creem, a billing and monetisation platform targeting AI-native software companies, has raised €5 million in seed funding. [Creem](https://www.creem.io/about?ref=therecursive.com) was founded in 2024.";
    const creem = round({
      company_name: "Creem",
      company_website: "https://www.creem.com/",
      evidence_quote:
        "Tallinn-based Creem, a billing and monetisation platform targeting AI-native software companies, has raised €5 million in seed funding.",
    });
    const url = "https://www.therecursive.com/tallinn-based-creem-raises-eur5m";
    expect(websiteOnPage("https://www.creem.com/", page)).toBe(false);
    expect(websiteOnPage("https://creem.io", page)).toBe(true);
    const [guessed] = pageItems([creem], { url, host: hostOf(url) }, page);
    expect(guessed?.round.company_website).toBeNull();
    const [linked] = pageItems([{ ...creem, company_website: "https://www.creem.io" }], { url, host: hostOf(url) }, page);
    expect(linked?.round.company_website).toBe("https://www.creem.io");
    // Without the page's text there is nothing linking the proposed domain to this company.
    const [unread] = pageItems([creem], { url, host: hostOf(url) }, undefined);
    expect(unread?.round.company_website).toBeNull();
  });
});

describe("extractRounds", () => {
  function fakeClient(doc: Record<string, unknown>, calls: Array<Record<string, unknown>> = []): Firecrawl {
    return {
      scrape: async (_url: string, options: Record<string, unknown>) => {
        calls.push(options);
        return doc;
      },
    } as unknown as Firecrawl;
  }

  test("checks Firecrawl field quotes before a money or investor claim reaches the resolver", async () => {
    const doc = {
      markdown: ARTICLE,
      metadata: { title: "Ollie Raises $7.5M Seed" },
      json: {
        page_kind: "article",
        page_date: "2026-09-03",
        rounds: [
          {
            ...OLLIE,
            amount_as_written: "$9 million",
            amount_scope: "round",
            financing_total_as_written: null,
            financing_total_quote: null,
            valuation_quote: null,
            debt_quote: null,
            other_investors: ["Invented Ventures"],
            field_quotes: {
              company: OLLIE.evidence_quote,
              website: null,
              description: null,
              stage: OLLIE.evidence_quote,
              amount: OLLIE.evidence_quote,
              financing_total: null,
              valuation: null,
              date: "2026-09-03",
              headquarters: null,
              sector: null,
              lead_investors: [],
              other_investors: [{ name: "Invented Ventures", quote: "This funding round was backed by Khosla Ventures and AI House." }],
            },
          },
        ],
      },
    };
    const result = await extractRounds(fakeClient(doc), [{ url: OLLIE_URL }], { now: NOW });
    expect(result.items[0].round).toMatchObject({ amount_as_written: null, amount_kind: "unknown", other_investors: [] });
    expect(result.items[0].grounded).toBe(true);
  });

  test("asks for markdown beside the json format, titles the source from the page, and flags the sidebar round", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = fakeClient(
      {
        markdown: ARTICLE,
        json: { rounds: [OLLIE, EMBEROS] },
        metadata: { title: "Emberos Raises $5.5M Seed - The SaaS News", ogTitle: "Ollie Raises $7.5M Seed", cacheState: "miss" },
      },
      calls,
    );
    const result = await extractRounds(client, [{ url: OLLIE_URL, title: "Emberos Raises $5.5M Seed - The SaaS News", query: "seed" }]);
    const formats = calls[0].formats as unknown[];
    expect(formats).toContain("markdown");
    expect(formats.some((f) => typeof f === "object" && f !== null && (f as { type: string }).type === "json")).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].source.title).toBe("Ollie Raises $7.5M Seed");
    expect(result.items.map((i) => i.grounded)).toEqual([true, false]);
    expect(result.pages[0]).toMatchObject({ ok: true, rounds: 2, ungrounded: 1, cached: false });
    expect(result.creditsEstimated).toBe(5);
  });

  test("the page's own headline stands even when it does not name the company and the slug does", async () => {
    const headline = "AI university spin-out led by former Oxford Nanopore boss raises £4m";
    const client = fakeClient({
      markdown: `# ${headline}\n\nMatter Machine raised £4 million in a pre-Series A round.`,
      json: {
        rounds: [
          round({
            company_name: "Matter Machine",
            round_type_as_written: "pre-Series A",
            amount_as_written: "£4 million",
            evidence_quote: "Matter Machine raised £4 million in a pre-Series A round.",
          }),
        ],
      },
      metadata: { ogTitle: headline },
    });
    const url =
      "https://www.thetimes.com/business/companies-markets/article/oxford-nanopore-liverpool-university-ai-matter-machine-v73fc9jlg";
    const result = await extractRounds(client, [{ url, title: "Oxford nanopore liverpool university ai matter machine" }]);
    expect(result.items[0]?.source.title).toBe(headline);
  });

  test("an X timeline keeps its label as the title", async () => {
    const client = fakeClient({ markdown: "posts", json: { rounds: [] }, metadata: { ogTitle: "Crunchbase News (@crunchbasenews) / X" } });
    const result = await extractRounds(client, [{ url: "https://x.com/crunchbasenews", title: "@crunchbasenews on X" }]);
    expect(result.pages[0]).toMatchObject({ ok: true, rounds: 0, ungrounded: 0 });
    expect(result.items).toHaveLength(0);
  });
});

describe("pageDateline", () => {
  test("reads the dateline city off the top of a wire release, and nothing off an article without one", () => {
    expect(pageDateline("# TabaPay Closes $155 Million\n\nDENVER, Sept. 2, 2026 /PRNewswire/ -- TabaPay today announced...")).toBe(
      "DENVER",
    );
    expect(pageDateline("**SAN FRANCISCO, Calif., September 3, 2026** -- Acme raised...")).toBe("SAN FRANCISCO");
    expect(pageDateline("Acme raised $20M today, the company said on Tuesday.")).toBeNull();
    expect(pageDateline(undefined)).toBeNull();
  });
});

describe("an undated page is not dated to its crawl", () => {
  const now = new Date("2026-09-25T15:00:00Z");
  const day = new Date("2026-09-25T12:00:00Z");

  test("textWritesDay reads the common ways a page writes a day", () => {
    for (const text of [
      "2026-09-25",
      "September 25, 2026",
      "Sept. 25, 2026",
      "25 September 2026",
      "Sep 25",
      "09/25/2026",
      "25.09.2026",
      "25th of September",
    ])
      expect(textWritesDay(`Posted ${text} by staff`, day), text).toBe(true);
    expect(textWritesDay("Posted September 24, 2026", day)).toBe(false);
    expect(textWritesDay("Acme raised $5M today.", day)).toBe(false);
  });

  test("offClock drops a day on the scrape's own day that the page never writes, and nothing else", () => {
    // antidote.me's 2017 press page, stamped with the time it rendered.
    expect(offClock("2026-09-25T14:58:00Z", "Antidote raises $11.5 million. Press contacts.", now)).toBeNull();
    expect(offClock("2026-09-25", "SAN FRANCISCO, Sept. 25, 2026 /PRNewswire/ -- Acme today announced...", now)).toBe("2026-09-25");
    expect(offClock("2026-09-18", "Acme raised $5M.", now)).toBe("2026-09-18");
    expect(offClock("2026-09-25", undefined, now)).toBe("2026-09-25");
    expect(offClock(null, "text", now)).toBeNull();
  });

  test("offClock drops a day after the scrape, which no page was published on", () => {
    expect(offClock("2026-09-28", "On September 24, QibiTech announced it has raised ¥600 million.", now)).toBeNull();
    // A day ahead of UTC (a Tokyo dateline) is still inside the slack.
    expect(offClock("2026-09-26", "TOKYO, Sept. 26, 2026 -- Acme raised ¥600 million.", now)).toBe("2026-09-26");
  });

  test("extractRounds takes the clock's day off the metadata, the page date, and a round's date", async () => {
    const client = {
      scrape: async () => ({
        markdown: "# Fundraising News\n\nAntidote raised $11.5 million in a Series B.",
        json: {
          page_kind: "article",
          page_date: "2026-09-25",
          rounds: [
            {
              company_name: "Antidote",
              round_type_as_written: "Series B",
              amount_as_written: "$11.5 million",
              announced_date: "2026-09-25",
              evidence_quote: "Antidote raised $11.5 million in a Series B.",
              company_website: null,
              company_description: null,
              amount_kind: "round",
              valuation_as_written: null,
              lead_investors: [],
              other_investors: [],
              headquarters: null,
              sector: "healthtech",
              source_url: null,
              is_background: false,
              is_rumor: false,
            },
          ],
        },
        metadata: { title: "Fundraising News", publishedTime: "2026-09-25T14:58:00Z" },
      }),
    } as unknown as Firecrawl;
    const result = await extractRounds(
      client,
      [{ url: "https://www.financialit.net/news/fundraising-news/antidote-raises-115-million-series-b", title: "Fundraising News" }],
      { now },
    );
    expect(result.items[0]?.round.announced_date).toBeNull();
    expect(result.items[0]?.page_date).toBeUndefined();
    expect(result.items[0]?.source.published).toBeUndefined();
  });
  test("extractRounds leaves a page undated when the extractor dates it days after the scrape", async () => {
    const markdown =
      "On September 30, QibiTech, the developer of the software HATS, announced that it has raised a total of approximately ¥600 million through a third-party allotment in its Series B round.";
    const client = {
      scrape: async () => ({
        markdown,
        json: {
          page_kind: "article",
          page_date: "2026-10-04",
          rounds: [
            {
              company_name: "QibiTech",
              round_type_as_written: "Series B",
              amount_as_written: "¥600 million",
              announced_date: null,
              evidence_quote: markdown,
              company_website: null,
              company_description: null,
              amount_kind: "round",
              valuation_as_written: null,
              lead_investors: [],
              other_investors: [],
              headquarters: null,
              sector: null,
              source_url: null,
              is_background: false,
              is_rumor: false,
            },
          ],
        },
        metadata: {},
      }),
    } as unknown as Firecrawl;
    const result = await extractRounds(
      client,
      [{ url: "https://thebridge.jp/en/2026/10/qibitech-raises-approximately-600-million-in-series-b" }],
      { now: new Date("2026-10-01T20:00:00Z") },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.page_date).toBeUndefined();
  });

  test("guessedYear drops a year the page never gives, and keeps one it writes or its own day carries", () => {
    const october2 = new Date("2026-10-02T12:00:00Z");
    // The Supabase story: the page writes "October 2, 2026"; the extractor answered 2023.
    const story = "# Supabase Raises $150 Million\n\nOctober 2, 2026\n\nSupabase has raised $150 million in new funding led by GIC.";
    expect(guessedYear("2023-10-06", story, october2, now)).toBeNull();
    expect(guessedYear("2026-10-02", story, october2, now)).toBe("2026-10-02");
    // A page with no year at all and no day of its own: the year is the extractor's.
    expect(guessedYear("2023-10-01", "Revnu raises $3M to grow in Manchester.", null, now)).toBeNull();
    // A genuine 2023 story writes its day with the year, whatever the page's other dates.
    expect(guessedYear("2023-10-09", "Oct. 9, 2023 — Pixelgen closes its Series A. Updated 2026.", october2, now)).toBe("2023-10-09");
    // The round's own sentence names the year of an earlier round on a newer page.
    expect(guessedYear("2023-05-01", story, october2, now, "Supabase raised its Series B in 2023.")).toBe("2023-05-01");
    // A day without its year on the page counts when the page's own day is in the same year.
    expect(guessedYear("2026-09-30", "Acme closed the round on September 30.", october2, now)).toBe("2026-09-30");
    expect(guessedYear(null, story, october2, now)).toBeNull();
    expect(guessedYear("2023-10-06", undefined, october2, now)).toBe("2023-10-06");
  });

  test("extractRounds holds the extractor's year to the page's own day", async () => {
    const client = {
      scrape: async () => ({
        markdown:
          "# Supabase Raises $150 Million, Acquires Turso\n\nOctober 2, 2026\n\nSupabase has raised $150 million in new funding led by GIC.",
        json: {
          page_kind: "article",
          page_date: "2023-10-06",
          rounds: [
            {
              company_name: "Supabase",
              round_type_as_written: "Funding round",
              amount_as_written: "$150 million",
              announced_date: "2023-10-06",
              evidence_quote: "Supabase has raised $150 million in new funding led by GIC.",
              company_website: null,
              company_description: null,
              amount_kind: "round",
              valuation_as_written: null,
              lead_investors: ["GIC"],
              other_investors: [],
              headquarters: null,
              sector: "developer tools",
              source_url: null,
              is_background: false,
              is_rumor: false,
            },
          ],
        },
        metadata: { title: "Supabase Raises $150 Million" },
      }),
    } as unknown as Firecrawl;
    const result = await extractRounds(
      client,
      [{ url: "https://www.citybiz.co/article/913344/supabase-raises-150-million-acquires-turso", title: "Supabase Raises $150 Million" }],
      { now: new Date("2026-10-02T15:25:00Z") },
    );
    expect(result.items[0]?.round.announced_date).toBeNull();
    expect(result.items[0]?.page_date).toBe("2026-10-02");
  });

  test("writtenDay keeps a day the page writes, a month's first day when it names the month, and nothing else", () => {
    const now = new Date("2026-10-10T01:00:00Z");
    expect(writtenDay("2026-10-06", "KONST raised $30 million in Series B funding led by ADATA Technology.", now)).toBeNull();
    expect(writtenDay("2026-10-06", "TAIPEI, Oct. 6, 2026 /PRNewswire/ -- KONST today announced...", now)).toBe("2026-10-06");
    expect(writtenDay("2026-10-06", "The round closed on 6 October.", now)).toBe("2026-10-06");
    expect(writtenDay("2026-09-01", "Acme raised $5M in September.", now)).toBe("2026-09-01");
    expect(writtenDay("2026-09-02", "Acme raised $5M in September.", now)).toBeNull();
    expect(writtenDay("2026-10-06", undefined, now)).toBe("2026-10-06");
    expect(writtenDay(null, "text", now)).toBeNull();
  });

  test("extractRounds: a day the extractor gave that the page never writes yields to the search result's day", async () => {
    const markdown =
      "# KONST Raises $30 Million Series B Led by ADATA\n\nKONST, a Taipei-based AI compute operator, has raised $30 million in Series B funding led by ADATA Technology.";
    const client = {
      scrape: async () => ({
        markdown,
        json: {
          page_kind: "article",
          page_date: "2026-10-06",
          rounds: [
            {
              company_name: "KONST",
              round_type_as_written: "Series B",
              amount_as_written: "$30 million",
              announced_date: "2026-10-06",
              evidence_quote:
                "KONST, a Taipei-based AI compute operator, has raised $30 million in Series B funding led by ADATA Technology.",
              company_website: null,
              company_description: null,
              amount_kind: "round",
              valuation_as_written: null,
              lead_investors: ["ADATA Technology"],
              other_investors: [],
              headquarters: "Taipei",
              sector: "ai infrastructure",
              source_url: null,
              is_background: false,
              is_rumor: false,
            },
          ],
        },
        metadata: { title: "KONST Raises $30 Million Series B Led by ADATA" },
      }),
    } as unknown as Firecrawl;
    const result = await extractRounds(
      client,
      [
        {
          url: "https://www.citybiz.co/article/917050/konst-raises-30-million-series-b",
          title: "KONST Raises $30 Million",
          published: "2026-10-09",
        },
      ],
      { now: new Date("2026-10-10T01:00:00Z") },
    );
    expect(result.items[0]?.round.announced_date).toBeNull();
    expect(result.items[0]?.page_date).toBeUndefined();
    expect(result.items[0]?.source.published).toBe("2026-10-09");
  });
});
