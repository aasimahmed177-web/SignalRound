import { afterEach, describe, expect, test, vi } from "vitest";
import robots from "../app/robots";
import { getCompany } from "../lib/company";
import { HTML_LIMITED_BOTS } from "../lib/crawlers";
import { canonicalBase, canonicalUrl, siteOrigin } from "../lib/origin";
import { persistRecords, type RoundRow, setDisposition } from "../lib/persist";
import {
  asOfSentence,
  buildSitemap,
  citable,
  companyJsonLd,
  companySearchMeta,
  feedJsonLd,
  fundingSummary,
  jsonLdHtml,
  raisedFigure,
  siteJsonLd,
  sitemapEntities,
  verifiedRaise,
} from "../lib/seo";
import { shareMetadata } from "../lib/share";
import { record, testDb } from "./helpers";

/** Acme: an unpriced seed (angel-led) and a €18M Series A led by Big Fund. Gamma: a seed moved to review, so it never shows. */
async function seed() {
  const db = await testDb();
  const acmeSeed = record({
    company_name: "Acme",
    company_domain: "acme.com",
    company_description: "payments for robots",
    stage: "seed",
    announced_date: "2026-03-01",
    amount: { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null },
    lead_investors: ["Jane Doe"],
  });
  const acmeA = record({
    company_name: "Acme",
    company_domain: "acme.com",
    stage: "series_a",
    announced_date: "2026-08-01",
    amount: { value: 18, currency: "EUR", as_written: "€18M", usd_millions: 20, fx_rate: 1.1, fx_date: "2026-08-01" },
    lead_investors: ["Big Fund"],
    other_investors: ["North Fund"],
  });
  const gamma = record({ company_name: "Gamma", stage: "seed", announced_date: "2026-09-01", lead_investors: ["Hidden Fund"] });
  await persistRecords(db, [acmeSeed, acmeA, gamma], "series-a-b", "run-1");
  await setDisposition(db, acmeSeed.id, "publish");
  await setDisposition(db, acmeA.id, "publish");
  await setDisposition(db, gamma.id, "review");
  return db;
}

describe("sitemapEntities", () => {
  test("lists only companies and investors on visible rounds, each with a timestamp", async () => {
    const db = await seed();
    const { companies, investors } = await sitemapEntities(db);
    expect(companies.map((c) => c.id)).toEqual(["acme.com"]);
    expect(investors.map((i) => i.id).sort()).toEqual(["big", "jane doe", "north"]);
    for (const e of [...companies, ...investors]) expect(Number.isNaN(Date.parse(e.lastModified))).toBe(false);
  });
  test("dates a page by when its latest round joined the record, not by the last write to a row", async () => {
    const db = await seed();
    const page = await getCompany(db, "acme.com");
    if (!page) throw new Error("no page");
    const joined = page.rounds
      .map((r) => new Date(r.first_seen_at).toISOString())
      .sort()
      .at(-1);
    // A later write (a person re-placing the round) moves updatedAt, never the lastmod.
    await setDisposition(db, page.rounds[0].id, "publish");
    const { companies } = await sitemapEntities(db);
    expect(companies[0].lastModified).toBe(joined);
  });
});

describe("buildSitemap", () => {
  const entities = {
    companies: [{ id: "teal health", lastModified: "2026-09-02T00:00:00.000Z" }],
    investors: [{ id: "big fund", lastModified: "2026-09-01T00:00:00.000Z" }],
  };
  test("front door, indexes, then entity pages, absolute and encoded", () => {
    const map = buildSitemap("https://fireround.dev", true, entities);
    expect(map.map((e) => e.url)).toEqual([
      "https://fireround.dev/",
      "https://fireround.dev/feed",
      "https://fireround.dev/overview",
      "https://fireround.dev/companies",
      "https://fireround.dev/investors",
      "https://fireround.dev/news",
      "https://fireround.dev/companies/teal%20health",
      "https://fireround.dev/investors/big-fund",
    ]);
    // The indexes carry the newest entity change.
    expect(map[1].lastModified).toBe("2026-09-02T00:00:00.000Z");
  });
  test("without LANDING the landing page is listed at /home; an empty store still lists the indexes", () => {
    const map = buildSitemap("https://x.test", false, { companies: [], investors: [] });
    expect(map[0].url).toBe("https://x.test/home");
    expect(map).toHaveLength(6);
    expect(map[0].lastModified).toBeUndefined();
  });
});

const AS_OF = new Date("2026-10-13T12:00:00Z");

describe("companyJsonLd", () => {
  test("the page with its dated summary, the Organization, and each verified round as an InvestAction on it, never a grant", async () => {
    const db = await seed();
    const page = await getCompany(db, "acme.com");
    if (!page) throw new Error("no page");
    const ld = companyJsonLd(page, "https://fireround.dev", AS_OF);
    expect(ld["@context"]).toBe("https://schema.org");
    const [webPage, org, a, seedRound] = ld["@graph"];
    expect(webPage).toMatchObject({
      "@type": "WebPage",
      "@id": "https://fireround.dev/companies/acme.com",
      name: "Acme funding rounds and investors",
      description:
        "As of 13 Oct 2026, Acme has raised at least $20M across 2 verified rounds on record (1 with no disclosed amount; amounts in other currencies converted to USD); latest: €18M Series A led by Big Fund, announced 1 Aug 2026.",
      about: { "@id": "https://fireround.dev/companies/acme.com#organization" },
    });
    expect(org).toMatchObject({
      "@type": "Organization",
      "@id": "https://fireround.dev/companies/acme.com#organization",
      name: "Acme",
      url: "https://acme.com",
      description: "Payments for robots",
      mainEntityOfPage: { "@id": "https://fireround.dev/companies/acme.com" },
    });
    expect(ld["@graph"]).toHaveLength(4);
    expect(JSON.stringify(ld)).not.toContain("Grant");
    expect(a).toMatchObject({
      "@type": "InvestAction",
      name: "Acme Series A",
      description: "€18M Series A led by Big Fund, announced 1 Aug 2026.",
      actionStatus: "https://schema.org/CompletedActionStatus",
      object: { "@id": "https://fireround.dev/companies/acme.com#organization" },
      startTime: "2026-08-01",
      price: 18_000_000,
      priceCurrency: "EUR",
      subjectOf: [{ "@type": "WebPage", url: "https://reuters.com/acme", name: "Acme raises $20M" }],
    });
    // The leads are the agents; the rest of the syndicate participated.
    expect("agent" in a && a.agent?.map((f) => f.name)).toEqual(["Big Fund"]);
    expect("participant" in a && a.participant?.map((f) => f.name)).toEqual(["North Fund"]);
    expect("price" in seedRound ? seedRound.price : undefined).toBeUndefined();
    // A person-shaped name with no firm domain reads as a Person.
    expect("agent" in seedRound && seedRound.agent).toEqual([{ "@type": "Person", name: "Jane Doe" }]);
  });

  test("flagged, expected, and unverified rows never appear, and a company with none carries no summary", async () => {
    const db = await testDb();
    const rows = [
      record({ company_name: "Beta", stage: "seed", announced_date: "2026-05-01" }),
      record({ company_name: "Beta", stage: "series_a", announced_date: "2026-07-01", certainty: "expected" }),
      record({ company_name: "Beta", stage: "series_b", announced_date: "2026-09-01" }),
    ];
    await persistRecords(db, rows, "series-a-b", "run-1");
    await setDisposition(db, rows[0].id, "flagged");
    await setDisposition(db, rows[1].id, "publish");
    await setDisposition(db, rows[2].id, "flagged");
    const page = await getCompany(db, "beta");
    if (!page) throw new Error("no page");
    expect(page.rounds).toHaveLength(3);
    expect(page.rounds.filter(citable)).toHaveLength(0);
    const ld = companyJsonLd(page, "https://fireround.dev", AS_OF);
    expect(ld["@graph"].map((n) => n["@type"])).toEqual(["WebPage", "Organization"]);
    expect("description" in ld["@graph"][0]).toBe(false);
    expect(fundingSummary("Beta", page.rounds)).toBeNull();
  });
});

describe("citable", () => {
  test("published, verified, and announced or reported", async () => {
    const db = await seed();
    const page = await getCompany(db, "acme.com");
    if (!page) throw new Error("no page");
    const [round] = page.rounds;
    expect(citable(round)).toBe(true);
    expect(citable({ ...round, certainty: "reported" })).toBe(true);
    expect(citable({ ...round, certainty: "expected" })).toBe(false);
    expect(citable({ ...round, certainty: "unconfirmed" })).toBe(false);
    expect(citable({ ...round, disposition: "flagged" })).toBe(false);
    expect(citable({ ...round, verification: null })).toBe(false);
    // An earlier round promoted from a checked dossier was verified against its own announcement.
    expect(citable({ ...round, verification: null, history: true })).toBe(true);
  });
});

describe("fundingSummary and companySearchMeta", () => {
  test("a reported latest round says reported; a total in billions keeps two places", async () => {
    const db = await testDb();
    const rows = [
      record({
        company_name: "Ramp",
        company_domain: "ramp.com",
        stage: "series_c",
        announced_date: "2021-08-24",
        lead_investors: ["Founders Fund"],
      }),
      record({
        company_name: "Ramp",
        company_domain: "ramp.com",
        stage: "other",
        stage_as_written: "funding round",
        announced_date: "2026-10-09",
        certainty: "reported",
        amount: { value: 1850, currency: "USD", as_written: "$1.85B", usd_millions: 1850, fx_rate: 1, fx_date: "2026-10-09" },
        lead_investors: ["Dragoneer", "Thrive Capital"],
      }),
    ];
    await persistRecords(db, rows, "series-a-b", "run-1");
    for (const r of rows) await setDisposition(db, r.id, "publish");
    const page = await getCompany(db, "ramp.com");
    if (!page) throw new Error("no page");
    const summary = fundingSummary("Ramp", page.rounds);
    if (!summary) throw new Error("no summary");
    expect(asOfSentence(summary, AS_OF)).toBe(
      "As of 13 Oct 2026, Ramp has raised $1.87B across 2 verified rounds on record; latest: $1.85B funding round led by Dragoneer and Thrive Capital, reported 9 Oct 2026.",
    );
    const meta = companySearchMeta(page, "fallback");
    expect(meta.title).toBe("Ramp funding rounds and investors");
    expect(meta.description).toBe(
      "How much has Ramp raised? Ramp has raised $1.87B across 2 verified rounds on record; latest: $1.85B funding round led by Dragoneer and Thrive Capital, reported 9 Oct 2026.",
    );
  });

  test("the rounds the page lists but the total leaves out are named after it, and the total counts only the verified ones", async () => {
    const db = await testDb();
    const rows = [
      record({ company_name: "Delta", stage: "seed", announced_date: "2026-01-10" }),
      record({ company_name: "Delta", stage: "series_a", announced_date: "2026-05-01" }),
      record({ company_name: "Delta", stage: "series_b", announced_date: "2026-09-01", certainty: "expected" }),
    ];
    await persistRecords(db, rows, "series-a-b", "run-1");
    await setDisposition(db, rows[0].id, "publish");
    await setDisposition(db, rows[1].id, "flagged");
    await setDisposition(db, rows[2].id, "publish");
    const page = await getCompany(db, "delta");
    if (!page) throw new Error("no page");
    const raise = verifiedRaise(page.rounds);
    expect(raise.cited.map((r) => r.stage)).toEqual(["seed"]);
    expect(raise.usdMillions).toBe(20);
    expect(raisedFigure(raise.usdMillions)).toBe("$20M");
    expect(fundingSummary("Delta", page.rounds)?.raised).toBe(
      "Delta has raised $20M across 1 verified round on record, plus 1 round still being checked and 1 expected raise not yet closed",
    );
    expect(raisedFigure(2650)).toBe("$2.65B");
  });

  test("no disclosed amount says so instead of a total", () => {
    const seedOnly = {
      disposition: "publish",
      certainty: "announced",
      history: false,
      verification: { status: "confirmed", notes: [], url: null },
      stage: "seed",
      stage_as_written: "seed",
      is_extension: false,
      amount: { value: null, currency: null, as_written: null, usd_millions: null },
      lead_investors: [],
      announced_on: "2026-03-01",
      date_precision: "month",
    } as unknown as RoundRow;
    expect(fundingSummary("Acme", [seedOnly])).toEqual({
      raised: "Acme has 1 verified round on record, none with a disclosed amount",
      latest: "seed round, announced Mar 2026",
    });
  });
});

describe("feedJsonLd", () => {
  test("a Dataset published by Firecrawl, downloadable from the API and the public feeds", () => {
    const ld = feedJsonLd("https://fireround.dev", "https://fireround.dev", {
      "application/rss+xml": [{ url: "/feeds/public/all.rss", title: "Fireround: all rounds (RSS)" }],
    });
    expect(ld).toMatchObject({ "@type": "Dataset", url: "https://fireround.dev/feed", isAccessibleForFree: true });
    expect(ld.description.length).toBeGreaterThan(50);
    expect(ld.creator["@id"]).toBe("https://fireround.dev/#organization");
    expect(ld.distribution.map((d) => d.contentUrl)).toEqual([
      "https://fireround.dev/api/v1/rounds",
      "https://fireround.dev/api/v1/rounds?format=csv",
      "https://fireround.dev/feeds/public/all.rss",
    ]);
    expect(feedJsonLd("https://x.test", "https://x.test", undefined).distribution).toHaveLength(2);
  });
});

describe("canonical base", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  test("SITE_URL moves every canonical, path included; unset, canonicals stay on this deployment", () => {
    vi.stubEnv("APP_ORIGIN", "https://fireround.dev");
    vi.stubEnv("SITE_URL", "");
    expect(canonicalUrl("/companies/ramp")).toBe("https://fireround.dev/companies/ramp");
    vi.stubEnv("SITE_URL", "https://www.firecrawl.dev/funding/");
    expect(canonicalBase()).toBe("https://www.firecrawl.dev/funding");
    expect(canonicalUrl("/companies/ramp")).toBe("https://www.firecrawl.dev/funding/companies/ramp");
    expect(shareMetadata({ title: "t", description: "d", canonical: "/feed" }).alternates?.canonical).toBe(
      "https://www.firecrawl.dev/funding/feed",
    );
    // The API and the MCP server stay where they are served.
    expect(siteOrigin()).toBe("https://fireround.dev");
  });
});

test("answer engines' crawlers get metadata in <head>; Next's own list stays, and Googlebot keeps streaming", () => {
  for (const ua of [
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.3; +https://openai.com/gptbot)",
    "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
    "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  ]) {
    expect(HTML_LIMITED_BOTS.test(ua), ua).toBe(true);
  }
  expect(HTML_LIMITED_BOTS.test("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(false);
  expect(HTML_LIMITED_BOTS.test("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36")).toBe(
    false,
  );
});

describe("siteJsonLd", () => {
  test("the site identifies SignalRound as publisher", () => {
    const ld = siteJsonLd("https://fireround.dev", "d");
    const [site, org] = ld["@graph"];
    expect(site).toMatchObject({ "@type": "WebSite", name: "SignalRound", url: "https://fireround.dev/" });
    expect(site.publisher).toEqual({ "@id": org["@id"] });
    expect(org).toMatchObject({ "@type": "Organization", name: "SignalRound" });
  });
});

test("jsonLdHtml cannot close its script tag", () => {
  const html = jsonLdHtml({ description: "</script><script>alert(1)</script>" });
  expect(html).not.toContain("<");
  expect(JSON.parse(html).description).toBe("</script><script>alert(1)</script>");
});

test("robots.txt keeps crawlers off admin, API, and token paths and names the sitemap", () => {
  const r = robots();
  const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
  // One rule for every agent, answer engines' crawlers included: nothing singles them out.
  expect(rules.map((x) => x.userAgent)).toEqual(["*"]);
  const [rule] = rules;
  expect(rule.allow).toContain("/");
  expect(rule.disallow).toEqual(expect.arrayContaining(["/api/", "/feeds/", "/slack/manage/", "/presets", "/review", "/settings"]));
  expect(rule.allow).toContain("/api/v1/openapi.json");
  expect(r.sitemap).toMatch(/\/sitemap\.xml$/);
});
