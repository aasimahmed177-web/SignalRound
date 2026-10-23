// The pure half of corroboration: which search results are worth a read, what the search asks
// for and how far back it looks, and which of a company's own newsroom posts are about the round.
// Acceptance against a stored record and the database-backed run live in the root suite.

import { describe, expect, test, vi } from "vitest";
import { DEFAULT_TIERS } from "../records/resolve.ts";
import type { NativeWebClient as Firecrawl } from "../web/client.ts";
import {
  corroborationQuery,
  corroborationTbs,
  mayBeLate,
  searchCorroboration,
  selectCorroborationUrls,
  selectNewsroomLinks,
} from "./corroborate.ts";

const NOW = new Date("2026-09-04T12:00:00Z");

describe("selectCorroborationUrls", () => {
  const results = [
    { url: "https://blog.example/acme-raises", title: "Acme raises" },
    { url: "https://www.linkedin.com/company/acme", title: "Acme on LinkedIn" },
    { url: "https://techcrunch.com/2026/09/02/acme-series-a/", title: "Acme lands Series A" },
    { url: "https://news.example/acme?utm_source=x", title: "Already read, with tracking" },
    { url: "https://www.prnewswire.com/news-releases/acme-series-a.html", title: "Acme Announces Series A" },
    { url: "https://acme.com/blog/series-a", title: "Our Series A" },
    { url: "https://techcrunch.com/2026/09/02/acme-series-a/?ref=rss", title: "duplicate of the TechCrunch story" },
  ];

  test("prefers the company's own domain, then the wire, then tier, and caps at three", () => {
    const picked = selectCorroborationUrls(results, { knownUrls: ["https://news.example/acme"], companyDomain: "acme.com" });
    expect(picked.map((c) => c.url)).toEqual([
      "https://acme.com/blog/series-a",
      "https://www.prnewswire.com/news-releases/acme-series-a.html",
      "https://techcrunch.com/2026/09/02/acme-series-a/",
    ]);
  });

  test("skips already-known sources and social pages, and dedupes by canonical URL", () => {
    const picked = selectCorroborationUrls(results, { knownUrls: ["https://news.example/acme"], max: 10 });
    const urls = picked.map((c) => c.url);
    expect(urls).not.toContain("https://news.example/acme?utm_source=x");
    expect(urls).not.toContain("https://www.linkedin.com/company/acme");
    expect(urls.filter((u) => u.startsWith("https://techcrunch.com"))).toHaveLength(1);
    // Without a company domain the wire ranks first and acme.com is just another unknown host, ordered by search rank.
    expect(urls).toEqual([
      "https://www.prnewswire.com/news-releases/acme-series-a.html",
      "https://techcrunch.com/2026/09/02/acme-series-a/",
      "https://blog.example/acme-raises",
      "https://acme.com/blog/series-a",
    ]);
  });

  test("layers publisher tier overrides over the defaults", () => {
    const picked = selectCorroborationUrls(results, {
      knownUrls: [],
      tiers: { "blog.example": 1.5 },
      max: 1,
    });
    expect(picked[0]?.url).toBe("https://blog.example/acme-raises");
    expect(DEFAULT_TIERS["prnewswire.com"]).toBe(1);
  });

  test("ranks a release ahead of classified news and an aggregator", () => {
    const picked = selectCorroborationUrls(
      [
        { url: "https://unknown.example/acme", title: "Acme database", kind: "aggregator" },
        { url: "https://news.example/acme-story", title: "Acme funding report", kind: "news" },
        { url: "https://businesswire.com/news/acme-release", title: "Acme announces funding" },
      ],
      { knownUrls: [], max: 3 },
    );
    expect(picked.map((p) => p.url)).toEqual([
      "https://businesswire.com/news/acme-release",
      "https://news.example/acme-story",
      "https://unknown.example/acme",
    ]);
  });
});

describe("corroboration search shape", () => {
  test("carries the name, the lead, the stage, the amount, and two words of the description", () => {
    expect(
      corroborationQuery({
        company_name: "Ollie",
        stage_as_written: "seed",
        amount_as_written: "$7.5M",
        lead_investors: ["Khosla Ventures"],
        company_description: "Ollie builds an AI assistant for home cooks.",
      }),
    ).toBe('"Ollie" "Khosla" seed $7.5M AI assistant');
  });

  test("works from the name and stage alone, and keeps a multi-word lead whole", () => {
    expect(corroborationQuery({ company_name: "Acme", stage_as_written: "Series A", amount_as_written: null })).toBe('"Acme" Series A');
    expect(
      corroborationQuery({
        company_name: "Acme",
        stage_as_written: "Series A",
        amount_as_written: "$20 million",
        lead_investors: ["Andreessen Horowitz", "Fund One"],
        company_description: null,
      }),
    ).toBe('"Acme" "Andreessen Horowitz" Series A $20 million');
  });

  test("stays under twelve terms, dropping the description first and the name never", () => {
    const query = corroborationQuery({
      company_name: "The Very Long Company Name With Many Words In It",
      stage_as_written: "Series B extension",
      amount_as_written: "$120 million",
      lead_investors: ["General Catalyst"],
      company_description: "Software for hospital operations teams.",
    });
    expect(query.startsWith('"The Very Long Company Name With Many Words In It"')).toBe(true);
    expect(query.split(/\s+/)).toHaveLength(12);
    expect(query).toBe('"The Very Long Company Name With Many Words In It" "General Catalyst"');
  });

  test("uses the last month for undated or recent rounds and a range around older ones", () => {
    expect(corroborationTbs(null, NOW)).toBe("qdr:m");
    expect(corroborationTbs("2026-09-02", NOW)).toBe("qdr:m");
    expect(corroborationTbs("2026-06-10", NOW)).toBe("cdr:1,cd_min:6/7/2026,cd_max:7/10/2026");
  });

  test("a record whose day may be a late page's searches the past year, where its release would be", () => {
    expect(corroborationTbs("2026-09-02", NOW, true)).toBe("qdr:y");
    // Borrowed from a byline, a URL, or a search result, or a list's week: may be late.
    expect(mayBeLate({ announced_date: "2026-09-23", date_basis: "page", date_precision: "week" })).toBe(true);
    expect(mayBeLate({ announced_date: "2026-09-23", date_basis: "url", date_precision: "day" })).toBe(true);
    expect(mayBeLate({ announced_date: "2026-09-23", date_basis: null, date_precision: "day" })).toBe(true);
    // A day a sentence states is the announcement; an undated row has nothing to be late.
    expect(mayBeLate({ announced_date: "2026-09-23", date_basis: "stated", date_precision: "day" })).toBe(false);
    expect(mayBeLate({ announced_date: null, date_basis: "none", date_precision: "unknown" })).toBe(false);
  });
});

describe("searchCorroboration fallback", () => {
  const input = {
    company_name: "Instinct",
    stage_as_written: "Series C",
    amount_as_written: "$250M",
    announced_date: "2026-09-24",
    lead_investors: ["General Catalyst"],
    company_description: "An AI assistant for teams",
    known_urls: ["https://example.com/instinct-round"],
  };
  const wsj = {
    url: "https://www.wsj.com/tech/ai/the-latest-viral-ai-assistant-rocketing-across-silicon-valley-abc123",
    title: "The latest viral AI assistant rocketing across Silicon Valley",
    description: "Instinct raised $250 million",
    highlights: ["Instinct's AI assistant raised $250 million"],
  };

  test("searches the issuer and the open web specifically for an announcement", async () => {
    const search = vi.fn().mockResolvedValue({ news: [], web: [] });
    await searchCorroboration(
      { search } as unknown as Firecrawl,
      { ...input, company_domain: "instinct.ai" },
      {
        broad: true,
        seekAnnouncement: true,
        maxPages: 0,
        now: NOW,
      },
    );
    expect(search.mock.calls.map(([query]) => query)).toEqual([
      '"Instinct" announces Series C $250M site:instinct.ai',
      '"Instinct" announces Series C $250M',
      '"Instinct" Series C $250M',
      '"Instinct" "General Catalyst" funding',
      '"Instinct" raises',
    ]);
  });

  test("retries company, amount and descriptor after the broad batch yields no selectable page", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce({ news: [], web: [] })
      .mockResolvedValueOnce({ news: [], web: [{ url: input.known_urls[0], title: "Known" }] })
      .mockResolvedValueOnce({ news: [], web: [] })
      .mockResolvedValueOnce({ news: [wsj], web: [] });
    const result = await searchCorroboration({ search } as unknown as Firecrawl, input, { broad: true, now: NOW });

    expect(search.mock.calls.map(([query]) => query)).toEqual([
      '"Instinct" Series C $250M',
      '"Instinct" "General Catalyst" funding',
      '"Instinct" raises',
      '"Instinct" $250M AI assistant',
    ]);
    expect(search.mock.calls.map(([, options]) => options)).toEqual(
      Array(4).fill({
        sources: ["news", "web"],
        tbs: "qdr:y",
        limit: 5,
        highlights: true,
      }),
    );
    expect(result.candidates).toEqual([
      {
        url: wsj.url,
        title: wsj.title,
        published: undefined,
        snippet: "Instinct raised $250 million Instinct's AI assistant raised $250 million",
      },
    ]);
    expect(result.resultCount).toBe(2);
    expect(result.creditsEstimated).toBe(0);
    expect(result.query).toContain('"Instinct" $250M AI assistant');
  });

  test("does not retry when the first batch selects a page", async () => {
    const search = vi.fn().mockResolvedValue({ news: [wsj], web: [] });
    const result = await searchCorroboration({ search } as unknown as Firecrawl, input, { now: NOW });

    expect(search).toHaveBeenCalledExactlyOnceWith('"Instinct" "General Catalyst" Series C $250M AI assistant', {
      sources: ["news", "web"],
      tbs: "qdr:y",
      limit: 5,
      highlights: false,
    });
    expect(result.candidates.map((candidate) => candidate.url)).toEqual([wsj.url]);
    expect(result.creditsEstimated).toBe(0);
  });

  test("does not retry when page extraction was explicitly disabled", async () => {
    const search = vi.fn().mockResolvedValue({ news: [], web: [] });
    const result = await searchCorroboration({ search } as unknown as Firecrawl, input, { broad: true, maxPages: 0, now: NOW });
    expect(search).toHaveBeenCalledTimes(3);
    expect(result.candidates).toEqual([]);
  });
});

describe("selectNewsroomLinks", () => {
  test("keeps the site's posts about a round, ranked by round words and the stage label, never a section index, a tag page, or a known page", () => {
    const links = [
      { url: "https://acme.com/", title: "Acme" },
      { url: "https://acme.com/blog", title: "Blog" },
      { url: "https://acme.com/blog/tag/company", title: "Company" },
      { url: "https://acme.com/careers/engineer", title: "Senior Engineer" },
      { url: "https://acme.com/blog/hello-world", title: "Hello world" },
      { url: "https://acme.com/blog/our-series-a", title: "Announcing our $20M Series A led by Fund One" },
      { url: "https://acme.com/news/acme-raises-20m", title: "Acme raises $20 million" },
      { url: "https://acme.com/blog/product-update", title: "Product update: dashboards" },
      { url: "https://other.example/acme-raises", title: "Acme raises $20M" },
    ];
    const picked = selectNewsroomLinks(links, {
      stage_as_written: "Series A",
      known_urls: ["https://acme.com/news/acme-raises-20m"],
      company_domain: "acme.com",
    });
    expect(picked.map((c) => c.url)).toEqual(["https://acme.com/blog/our-series-a"]);
    const both = selectNewsroomLinks(links, { stage_as_written: "Series A", known_urls: [], company_domain: "acme.com" });
    expect(both.map((c) => c.url)).toEqual(["https://acme.com/blog/our-series-a", "https://acme.com/news/acme-raises-20m"]);
  });
});
