import { describe, expect, test } from "vitest";
import robots from "../app/robots";
import { getCompany } from "../lib/company";
import { persistRecords, setDisposition } from "../lib/persist";
import { buildSitemap, companyJsonLd, jsonLdHtml, siteJsonLd, sitemapEntities } from "../lib/seo";
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

describe("companyJsonLd", () => {
  test("an Organization with each visible round as an InvestAction on it, never a grant", async () => {
    const db = await seed();
    const page = await getCompany(db, "acme.com");
    if (!page) throw new Error("no page");
    const ld = companyJsonLd(page, "https://fireround.dev");
    expect(ld["@context"]).toBe("https://schema.org");
    const [org, a, seedRound] = ld["@graph"];
    expect(org).toMatchObject({
      "@type": "Organization",
      "@id": "https://fireround.dev/companies/acme.com#organization",
      name: "Acme",
      url: "https://acme.com",
      description: "Payments for robots",
      mainEntityOfPage: "https://fireround.dev/companies/acme.com",
    });
    expect(ld["@graph"]).toHaveLength(3);
    expect(JSON.stringify(ld)).not.toContain("Grant");
    expect(a).toMatchObject({
      "@type": "InvestAction",
      name: "Acme Series A",
      object: { "@id": "https://fireround.dev/companies/acme.com#organization" },
      startTime: "2026-08-01",
      price: 18_000_000,
      priceCurrency: "EUR",
    });
    expect("agent" in a && a.agent?.map((f) => f.name)).toEqual(["Big Fund", "North Fund"]);
    expect("price" in seedRound ? seedRound.price : undefined).toBeUndefined();
    // A person-shaped name with no firm domain reads as a Person.
    expect("agent" in seedRound && seedRound.agent).toEqual([{ "@type": "Person", name: "Jane Doe" }]);
  });
});

describe("siteJsonLd", () => {
  test("the site is published by Firecrawl's Organization node", () => {
    const ld = siteJsonLd("https://fireround.dev", "d");
    const [site, org] = ld["@graph"];
    expect(site).toMatchObject({ "@type": "WebSite", name: "Fireround", url: "https://fireround.dev/" });
    expect(site.publisher).toEqual({ "@id": org["@id"] });
    expect(org).toMatchObject({ "@type": "Organization", name: "Firecrawl" });
  });
});

test("jsonLdHtml cannot close its script tag", () => {
  const html = jsonLdHtml({ description: "</script><script>alert(1)</script>" });
  expect(html).not.toContain("<");
  expect(JSON.parse(html).description).toBe("</script><script>alert(1)</script>");
});

test("robots.txt keeps crawlers off admin, API, and token paths and names the sitemap", () => {
  const r = robots();
  const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
  expect(rule.disallow).toEqual(expect.arrayContaining(["/api/", "/feeds/", "/slack/manage/", "/presets", "/review", "/settings"]));
  expect(rule.allow).toContain("/api/v1/openapi.json");
  expect(r.sitemap).toMatch(/\/sitemap\.xml$/);
});
