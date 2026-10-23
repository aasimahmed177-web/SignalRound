// Which links on a publisher's section page count as articles, and what one watch of a section
// yields: unseen articles in page order under the watch query, priced at one read. The preset run
// and the candidates ledger live in the root suite.

import { describe, expect, test } from "vitest";
import type { NativeWebClient as Firecrawl } from "../web/client.ts";
import { RATE } from "./credits.ts";
import { isArticleLink, WATCH_READ_CREDITS, watchSiteCandidates } from "./watch.ts";

const SECTION = "https://techcrunch.com/category/venture/";

const LINKS = [
  "https://techcrunch.com/category/venture/",
  "https://techcrunch.com/category/venture/page/2/",
  "https://techcrunch.com/category/venture/feed/",
  "https://techcrunch.com/tag/series-a/",
  "https://techcrunch.com/author/marina-temkin/",
  "https://techcrunch.com/2026/09/04/acme-raises-46m-series-b/",
  "https://techcrunch.com/2026/09/04/acme-raises-46m-series-b/?utm_source=feed",
  "https://techcrunch.com/2026/09/03/beta-labs-lands-seed-round/",
  "https://techcrunch.com/video/founders-on-stage/",
  "https://techcrunch.com/newsletters/",
  "https://techcrunch.com/events/disrupt-2026/",
  "https://www.techcrunch.com/2026/09/02/gamma-closes-series-a/",
  "https://x.com/techcrunch",
  "https://news.crunchbase.com/venture/delta-raises-10m/",
  "mailto:tips@techcrunch.com",
];

function fakeClient(links: string[], calls: string[] = []): Firecrawl {
  return {
    scrape: async (url: string) => {
      calls.push(url);
      return { links };
    },
  } as unknown as Firecrawl;
}

describe("isArticleLink", () => {
  test("keeps dated paths, long slugs, and news segments on the same publisher", () => {
    expect(isArticleLink("https://techcrunch.com/2026/09/04/acme-raises-46m-series-b/", SECTION)).toBe(true);
    expect(isArticleLink("https://www.techcrunch.com/2026/09/02/gamma-closes-series-a/", SECTION)).toBe(true);
    expect(isArticleLink("https://techcrunch.com/startups/acme-raises-forty-six-million/", SECTION)).toBe(true);
    expect(isArticleLink("https://news.crunchbase.com/venture/delta-raises-10m/", "https://news.crunchbase.com/sections/venture/")).toBe(
      true,
    );
    expect(
      isArticleLink(
        "https://www.prnewswire.com/news-releases/acme-closes-46-million-series-b-302456789.html",
        "https://www.prnewswire.com/news-releases/financial-services-latest-news/financing-agreements-list/",
      ),
    ).toBe(true);
  });

  test("drops the section itself, listings, taxonomies, feeds, media, and other hosts", () => {
    for (const url of [
      SECTION,
      "https://techcrunch.com/category/venture",
      "https://techcrunch.com/category/venture/page/2/",
      "https://techcrunch.com/category/venture/feed/",
      "https://techcrunch.com/tag/series-a/",
      "https://techcrunch.com/author/marina-temkin/",
      "https://techcrunch.com/video/founders-on-stage/",
      "https://techcrunch.com/newsletters/",
      "https://techcrunch.com/events/disrupt-2026/",
      "https://techcrunch.com/",
      "https://techcrunch.com/about",
      // Long slugs at the site root are evergreen pages, seen live on Crunchbase News and EU-Startups.
      "https://techcrunch.com/unicorn-company-list",
      "https://techcrunch.com/secure-your-tickets",
      "https://techcrunch.com/startup-jobs/post-a-job",
      "https://techcrunch.com/wp-content/uploads/2026/09/hero.jpg",
      "https://news.crunchbase.com/venture/delta-raises-10m/",
      "https://x.com/techcrunch",
      "mailto:tips@techcrunch.com",
      "not a url",
    ]) {
      expect(isArticleLink(url, SECTION), url).toBe(false);
    }
  });
});

describe("isArticleLink on publishers that file stories at the root or under a topic", () => {
  test("LatamList, BetaKit, Tech Funding News, e27, and Startup Daily story URLs are articles", () => {
    const cases: Array<[string, string]> = [
      [
        "https://latamlist.com/nuvia-raises-1-8m-to-expand-ai-sales-agents-across-latin-america/",
        "https://latamlist.com/category/startup-news/funding/",
      ],
      ["https://latamlist.com/ng-cash-raises-15m-from-blockchain-capital/", "https://latamlist.com/category/startup-news/funding/"],
      ["https://betakit.com/axya-closes-17-million-series-a-to-modernize-manufacturing-procurement/", "https://betakit.com/"],
      [
        "https://betakit.com/with-new-funding-astrus-prepares-to-automate-one-of-the-biggest-bottlenecks-in-chip-design/",
        "https://betakit.com/",
      ],
      [
        "https://techfundingnews.com/neuralink-alums-precision-neuroscience-raises-250m-to-advance-brain-computer-interfaces/",
        "https://techfundingnews.com/category/funding/",
      ],
      ["https://e27.co/life-lab-resources-grabs-us1m-to-turn-food-waste-into-aquaculture-feed-20260924/", "https://e27.co/news/"],
      [
        "https://www.startupdaily.net/topic/funding/dementia-biotech-kinoxis-raises-6-75-million-with-a-2-5m-grant-as-cherry-on-top/",
        "https://www.startupdaily.net/topic/funding/",
      ],
    ];
    for (const [url, site] of cases) expect(isArticleLink(url, site), url).toBe(true);
  });

  test("their listings, taxonomy terms, and evergreen root pages are not", () => {
    const cases: Array<[string, string]> = [
      ["https://latamlist.com/category/startup-news/funding/", "https://latamlist.com/"],
      ["https://latamlist.com/author/araceli/", "https://latamlist.com/category/startup-news/funding/"],
      ["https://www.startupdaily.net/topic/funding/", "https://www.startupdaily.net/"],
      ["https://www.startupdaily.net/topic/funding/page/75/", "https://www.startupdaily.net/topic/funding/"],
      ["https://www.startupdaily.net/tag/news/", "https://www.startupdaily.net/topic/funding/"],
      ["https://techfundingnews.com/category/deep-tech/", "https://techfundingnews.com/category/funding/"],
      ["https://techfundingnews.com/contact-us/", "https://techfundingnews.com/category/funding/"],
      ["https://techfundingnews.com/privacy-policy-and-cookie-terms/", "https://techfundingnews.com/category/funding/"],
      ["https://betakit.com/how-founders-are-rethinking-capital-in-the-ai-era/", "https://betakit.com/"],
      ["https://e27.co/category/cybersecurity", "https://e27.co/news/"],
      ["https://techcrunch.com/tag/series-a-funding-rounds/", SECTION],
    ];
    for (const [url, site] of cases) expect(isArticleLink(url, site), url).toBe(false);
  });

  test("a day at the end of a slug ages the link like a dated path", async () => {
    const now = new Date("2026-09-25T12:00:00Z");
    const links = [
      "https://e27.co/singapore-now-captures-78-per-cent-of-seas-startup-funding-raised-20260801/",
      "https://e27.co/life-lab-resources-grabs-us1m-to-turn-food-waste-into-aquaculture-feed-20260924/",
    ];
    const r = await watchSiteCandidates(fakeClient(links), "https://e27.co/news/", { seen: () => false, now });
    expect(r.targets.map((t) => t.url)).toEqual([
      "https://e27.co/life-lab-resources-grabs-us1m-to-turn-food-waste-into-aquaculture-feed-20260924",
    ]);
  });
});

describe("watchSiteCandidates", () => {
  test("reads the section once, keeps unseen articles in page order under the watch query, and prices one credit", async () => {
    const calls: string[] = [];
    const r = await watchSiteCandidates(fakeClient(LINKS, calls), SECTION, {
      seen: () => false,
      now: new Date("2026-09-05T12:00:00Z"),
    });
    expect(calls).toEqual([SECTION]);
    expect(r.host).toBe("techcrunch.com");
    expect(r.linked).toBe(LINKS.length);
    // The utm variant dedupes onto its canonical URL.
    expect(r.articles).toBe(3);
    expect(r.targets).toEqual([
      { url: "https://techcrunch.com/2026/09/04/acme-raises-46m-series-b", query: "watch:techcrunch.com" },
      { url: "https://techcrunch.com/2026/09/03/beta-labs-lands-seed-round", query: "watch:techcrunch.com" },
      { url: "https://www.techcrunch.com/2026/09/02/gamma-closes-series-a", query: "watch:techcrunch.com" },
    ]);
    expect(r.creditsEstimated).toBe(WATCH_READ_CREDITS);
    expect(WATCH_READ_CREDITS).toBe(RATE.mapCall);
  });

  test("drops seen URLs (async lookup) and caps at the limit", async () => {
    const seen = new Set(["https://techcrunch.com/2026/09/04/acme-raises-46m-series-b"]);
    const r = await watchSiteCandidates(fakeClient(LINKS), SECTION, {
      seen: async (u) => seen.has(u),
      limit: 1,
      now: new Date("2026-09-05T12:00:00Z"),
    });
    expect(r.targets.map((t) => t.url)).toEqual(["https://techcrunch.com/2026/09/03/beta-labs-lands-seed-round"]);
  });

  test("a URL dated older than the age window is skipped before extraction (a pinned feature is not news)", async () => {
    const now = new Date("2026-09-04T12:00:00Z");
    const links = [
      "https://tech.eu/2026/05/08/europes-tech-funding-cools-in-april/",
      "https://tech.eu/2026/09/03/acme-raises-series-a/",
      "https://tech.eu/investment/undated-acme-raises-series-a/",
    ];
    const r = await watchSiteCandidates(fakeClient(links), "https://tech.eu/category/investment/", { seen: () => false, now });
    expect(r.articles).toBe(2);
    expect(r.targets.map((t) => t.url)).toEqual([
      "https://tech.eu/2026/09/03/acme-raises-series-a",
      "https://tech.eu/investment/undated-acme-raises-series-a",
    ]);
    const wide = await watchSiteCandidates(fakeClient(links), "https://tech.eu/category/investment/", {
      seen: () => false,
      now,
      maxAgeDays: 365,
    });
    expect(wide.articles).toBe(3);
  });

  test("an empty or missing links list yields no targets", async () => {
    const client = { scrape: async () => ({}) } as unknown as Firecrawl;
    const r = await watchSiteCandidates(client, SECTION, { seen: () => false });
    expect(r).toMatchObject({ linked: 0, articles: 0, targets: [] });
  });
});
