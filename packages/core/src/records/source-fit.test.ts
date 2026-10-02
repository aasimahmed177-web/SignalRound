// The source rule against production's own links (Basecamp Research's Series C, 2026-09-23) and the
// URL shapes behind it: job postings, front pages, search and tag pages, aggregators, roundups.

import { describe, expect, test } from "vitest";
import { isArticleUrl, isJobPostingUrl } from "./normalize.ts";
import { itemSource } from "./resolve.ts";
import {
  companySite,
  isAggregatorUrl,
  isFundingAggregatorUrl,
  linkedSites,
  sourceFit,
  textNamesSubject,
  titleStatesAmount,
  urlNamesSubject,
} from "./source-fit.ts";

const basecamp = { name: "Basecamp Research", domain: "basecamp-research.com" };
const round = { amountValue: 140, amountCurrency: "USD" };
const TECHSTARTUPS =
  "https://techstartups.com/2026/09/23/venture-capital-startup-funding-roundup-september-23-2026-accel-jpmorgan-s32-t-rowe-price-y-combinator-more";

describe("sourceFit: Basecamp Research's Series C", () => {
  test("the job posting, Techmeme's front page, and a Techmeme permalink about Coachella never attach", () => {
    expect(
      sourceFit(
        {
          url: "https://jobs.ashbyhq.com/basecamp-research/5c8e9cb3-f02c-4938-aa8b-8dd4c5fe61ca",
          title: "Executive Assistant and Office Manager",
          evidence: "Basecamp Research just raised a $140M Series C.",
        },
        basecamp,
        round,
      ),
    ).toEqual({ attach: false, reason: "job_posting" });
    expect(sourceFit({ url: "https://techmeme.com/index.html", title: "Techmeme" }, basecamp, round)).toEqual({
      attach: false,
      reason: "not_article",
    });
    expect(
      sourceFit(
        {
          url: "https://www.techmeme.com/260923/p28",
          title: "Coachella promoter Goldenvoice renews its livestreaming partnership with YouTube through 2030",
          // The river lists every story of the hour, so a sentence naming the company is still another story's neighbour.
          evidence: "Basecamp Research raises $140M to advance AI-designed therapeutics",
        },
        basecamp,
        round,
      ),
    ).toEqual({ attach: false, reason: "aggregator" });
  });

  test("a roundup attaches only with an evidence sentence that names the company", () => {
    const title = "Venture Capital & Startup Funding Roundup, September 23, 2026: Accel, JPMorgan, S32, T. Rowe Price, Y Combinator & More";
    expect(sourceFit({ url: TECHSTARTUPS, title }, basecamp, round)).toEqual({ attach: false, reason: "not_about_company" });
    expect(
      sourceFit({ url: TECHSTARTUPS, title, evidence: "Snorkel AI raised $350 million in Series E funding." }, basecamp, round),
    ).toEqual({
      attach: false,
      reason: "not_about_company",
    });
    expect(
      sourceFit(
        { url: TECHSTARTUPS, title, evidence: [null, "London-based Basecamp Research raised $140 million in a Series C round."] },
        basecamp,
        round,
      ),
    ).toEqual({ attach: true, by: "evidence" });
  });

  test("a single story's headline about another round admits no evidence sentence (Sammmm on Entrackr's Demoverse story)", () => {
    const sammmm = { name: "Sammmm", domain: "sammmm.com" };
    const seed = { amountValue: 100, amountCurrency: "INR" };
    const demoverse = {
      url: "https://entrackr.com/snippets/lumikai-leads-600k-pre-seed-round-in-demoverse-12562408",
      title: "Lumikai leads $600K pre-seed round in Demoverse",
      // The page ran the next snippet underneath, and the reading took its sentence.
      evidence: "Mumbai-based teen self-care brand Sammmm raised Rs 10 crore ($1.2 million) in seed funding led by Fireside Ventures.",
    };
    expect(sourceFit(demoverse, sammmm, seed)).toEqual({ attach: false, reason: "not_about_company" });
    // Its own snippet attaches by title, and a headline about many rounds still takes a sentence.
    expect(
      sourceFit(
        {
          ...demoverse,
          url: "https://entrackr.com/snippets/teen-self-care-brand-sammmm-raises-rs-10-cr-in-seed-funding-8674589",
          title: "Teen self-care brand Sammmm raises Rs 10 Cr in seed funding",
        },
        sammmm,
        seed,
      ),
    ).toEqual({ attach: true, by: "title" });
    expect(
      sourceFit(
        {
          ...demoverse,
          url: "https://example.com/2026/09/indian-startups-raised-250m",
          title: "Indian startups raised $250M in September",
        },
        sammmm,
        seed,
      ),
    ).toEqual({ attach: true, by: "evidence" });
  });

  test("the round's own coverage attaches: by title, by URL, by the headline's amount, by the company's site", () => {
    const judge = (url: string, title: string) => sourceFit({ url, title }, basecamp, round);
    expect(
      judge(
        "https://tech.eu/2026/09/23/anthropic-and-nvidia-back-basecamp-research-in-140m-series-c",
        "Anthropic and Nvidia back Basecamp Research in $140M Series C",
      ),
    ).toEqual({ attach: true, by: "title" });
    expect(
      judge(
        "https://pharmaphorum.com/news/ai-specialists-enveda-and-basecamp-rake-cash",
        "AI specialists Enveda and Basecamp rake in the cash",
      ),
    ).toEqual({
      attach: true,
      by: "title",
    });
    // traded.co's deal page for Basecamp was stored under the Snorkel AI headline of the page that linked it.
    expect(
      judge(
        "https://traded.co/vc/deal/basecamp-research-raises-140-million-in-series-c-funding-from-multiple-investors",
        "Snorkel AI Secures $350 Million In Series E Funding At $3.5 Billion Valuation",
      ),
    ).toEqual({ attach: true, by: "url" });
    expect(
      judge(
        "https://www.techtimes.com/articles/327949/20260923/biodiversity-ai-raises-140m-deliver-gene-therapy-without-factories.htm",
        "Biodiversity AI Raises $140M to Deliver Gene Therapy Without Factories",
      ),
    ).toEqual({ attach: true, by: "title_amount" });
    expect(
      judge(
        "https://www.basecamp-research.com/news-research/basecamp-research-raises-140m-to-advance-ai-designed-therapeutics",
        "Basecamp Research raises $140M",
      ),
    ).toEqual({ attach: true, by: "domain" });
    // The company's homepage is not a report of the round either.
    expect(judge("https://www.basecamp-research.com/", "Basecamp Research")).toEqual({ attach: false, reason: "not_article" });
  });
});

describe("naming the company", () => {
  test("a generic word of the name is not the name; an alias and the domain are", () => {
    expect(textNamesSubject("Research firm raises $140M", basecamp)).toBe(false);
    expect(textNamesSubject("Basecamp lands $140M", basecamp)).toBe(true);
    expect(textNamesSubject("A round for basecamp-research.com", basecamp)).toBe(true);
    expect(textNamesSubject("Old Name Bio raises $10M", { name: "New Name", aliases: ["Old Name Bio"] })).toBe(true);
    // A name made only of common words is matched as the whole phrase.
    expect(textNamesSubject("Open Robotics raises $5M", { name: "Open Robotics" })).toBe(true);
    expect(textNamesSubject("Robotics startup raises", { name: "Open Robotics" })).toBe(false);
  });

  test("a slug runs words together and truncates", () => {
    expect(urlNamesSubject("https://example.com/news/basecampresearch-series-c", basecamp)).toBe(true);
    expect(urlNamesSubject("https://example.com/news/snorkel-ai-series-e", basecamp)).toBe(false);
  });

  test("a headline's amount agrees within a tenth and in the same currency", () => {
    expect(titleStatesAmount("Biodiversity AI Raises $140M", round)).toBe(true);
    expect(titleStatesAmount("Startup raises $350 million", round)).toBe(false);
    expect(titleStatesAmount("Startup raises €140M", round)).toBe(false);
    expect(titleStatesAmount("Startup raises $140M", { amountValue: null, amountCurrency: null })).toBe(false);
  });
});

describe("URL shapes", () => {
  test("job postings on boards, jobs subdomains, and careers paths", () => {
    for (const url of [
      "https://jobs.ashbyhq.com/acme/5c8e9cb3",
      "https://boards.greenhouse.io/acme/jobs/123",
      "https://jobs.lever.co/acme/abc",
      "https://acme.com/careers/senior-engineer",
      "https://jobs.acme.com/role/123",
      "https://www.linkedin.com/jobs/view/123",
    ])
      expect(isJobPostingUrl(url), url).toBe(true);
    expect(isJobPostingUrl("https://techcrunch.com/2026/09/23/acme-raises-20m")).toBe(false);
    expect(isArticleUrl("https://acme.com/careers/senior-engineer")).toBe(false);
  });

  test("front pages, search pages, and tag pages are not articles; a dated section under a directory's name is", () => {
    for (const url of [
      "https://techmeme.com/index.html",
      "https://example.com/home",
      "https://example.com/search/acme",
      "https://example.com/search?q=acme",
      "https://example.com/tag/funding",
      "https://example.com/newsroom/subject/funding",
      "https://example.com/companies/acme",
      "https://example.com/events/summit-2026",
      // A startup directory's profile (Sesamers), which lists other companies' rounds beside it.
      "https://www.sesamers.com/startup/biolevate",
    ])
      expect(isArticleUrl(url), url).toBe(false);
    expect(isArticleUrl("https://example.com/companies/2026/07/acme-raises-20m")).toBe(true);
    expect(isArticleUrl("https://example.com/startups/malaysian-deep-tech-startup-nanoskunkworkx-raises-us2m-seed")).toBe(true);
    expect(
      isArticleUrl(
        "https://www.siliconindia.com/startup/startup-funding/firi-raises-3-million-seed-round-led-by-360-one-asset-nwid-55461.html",
      ),
    ).toBe(true);
  });

  test("aggregators by domain, with Y Combinator's own site excepted", () => {
    expect(isAggregatorUrl("https://www.techmeme.com/260923/p28")).toBe(true);
    expect(isAggregatorUrl("https://news.ycombinator.com/item?id=1")).toBe(true);
    expect(isAggregatorUrl("https://news.google.com/articles/abc")).toBe(true);
    expect(isAggregatorUrl("https://www.ycombinator.com/blog/acme")).toBe(false);
    expect(
      sourceFit({ url: "https://news.ycombinator.com/item?id=1", title: "Acme raises $20M (acme.com)" }, { name: "Acme" }).attach,
    ).toBe(true);
  });
});

describe("itemSource titles", () => {
  test("a per-item link to another page takes its slug as the title, not the read page's headline", () => {
    const page = {
      url: "https://traded.co/vc/deal/snorkel-ai-secures-350-million-in-series-e-funding",
      host: "traded.co",
      title: "Snorkel AI Secures $350 Million In Series E Funding At $3.5 Billion Valuation",
    };
    const item = itemSource(
      page,
      "https://traded.co/vc/deal/basecamp-research-raises-140-million-in-series-c-funding",
      "Basecamp Research",
    );
    expect(item.url).toBe("https://traded.co/vc/deal/basecamp-research-raises-140-million-in-series-c-funding");
    expect(item.title).toBe("Basecamp research raises 140 million in series c funding");
    // An anchor on the read page keeps its title; a link with no words in its slug has no title.
    expect(itemSource(page, `${page.url}#basecamp`, "Snorkel AI").title).toBe(page.title);
    expect(itemSource(page, "https://traded.co/vc/deal/8843221", null).title).toBeUndefined();
  });
});

describe("the company's own sites and funding databases", () => {
  test("a sibling shares the label on another suffix or a blog platform; the homepage's links make it the company's own", () => {
    const tldraw = { domain: "tldraw.com" };
    expect(companySite("https://www.tldraw.com/blog/x", tldraw)).toBe("own");
    expect(companySite("https://tldraw.dev/blog/announcing-tldraw-series-a", tldraw)).toBe("sibling");
    expect(companySite("https://tldraw.substack.com/p/tiny-little-seed-round", tldraw)).toBe("sibling");
    expect(companySite("https://other.substack.com/p/tldraw", tldraw)).toBeNull();
    expect(companySite("https://techcrunch.com/tldraw", tldraw)).toBeNull();
    expect(companySite("https://tldraw.dev/blog/x", { ...tldraw, sites: ["tldraw.dev"] })).toBe("own");
    // A two-letter label is too common to claim another suffix.
    expect(companySite("https://x.io/blog", { domain: "x.ai" })).toBeNull();
    expect(
      linkedSites(
        ["https://tldraw.dev/", "https://tldraw.substack.com/", "https://github.com/tldraw/tldraw", "https://www.tldraw.com/pricing"],
        "tldraw.com",
      ),
    ).toEqual(["tldraw.dev", "tldraw.substack.com"]);
  });

  test("databases and profile farms restate rounds, by host or by the shape of a profile path", () => {
    for (const url of [
      "https://trysignalbase.com/news/funding/tldraw-raises-10m",
      "https://startupintros.com/orgs/tldraw",
      "https://www.cbinsights.com/company/tldraw/financials",
      "https://simplify.jobs/c/tldraw",
      "https://example-farm.com/brands/tldraw",
      "https://example-farm.com/who-funded-tldraw",
      "https://example-farm.com/company/tldraw/funding",
      "https://www.crunchbase.com/organization/tldraw",
    ])
      expect(isFundingAggregatorUrl(url), url).toBe(true);
    for (const url of [
      "https://tldraw.dev/blog/announcing-tldraw-series-a",
      "https://techcrunch.com/2025/04/09/tldraw-raises-10m/",
      "https://www.theinformation.com/articles/tldraw",
    ])
      expect(isFundingAggregatorUrl(url), url).toBe(false);
  });
});
