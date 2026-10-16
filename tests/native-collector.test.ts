import { describe, expect, test } from "vitest";
import {
  collectNativeSignals,
  companyNameFromHeadline,
  discoverCompanyWebsite,
  extractPublicEmails,
  fundingFacts,
  isFundingItem,
  parseNativeFeed,
} from "../lib/native-collector";

const feed = `<?xml version="1.0"?><rss><channel><item>
  <title>Acme raises $12M Series A to expand</title>
  <link>https://news.example/acme-round</link>
  <pubDate>Thu, 15 Oct 2026 12:00:00 +0000</pubDate>
  <dc:creator>Reporter</dc:creator>
  <description><![CDATA[Acme secured new funding.]]></description>
</item></channel></rss>`;

describe("native collector primitives", () => {
  test("parses RSS funding items", () => {
    const [item] = parseNativeFeed(feed, "https://news.example/feed.xml");
    expect(item).toMatchObject({
      title: "Acme raises $12M Series A to expand",
      url: "https://news.example/acme-round",
      author: "Reporter",
      feedUrl: "https://news.example/feed.xml",
    });
    expect(item && isFundingItem(item)).toBe(true);
  });

  test("extracts deterministic company and funding facts", () => {
    expect(companyNameFromHeadline("Acme raises $12M Series A to expand")).toBe("Acme");
    expect(fundingFacts("Acme raises $12M Series A to expand")).toEqual({ amountAsWritten: "$12M", stageAsWritten: "Series A" });
  });

  test("rejects valuation news and non-financial uses of raise", () => {
    const falsePositives = [
      "Ramp reaches $60B valuation as revenue accelerates",
      "CedarDB says AI agents raise the stakes for database security",
    ];
    for (const title of falsePositives) {
      expect(
        isFundingItem({ title, url: "https://news.example/story", summary: null, author: null, publishedAt: null, feedUrl: "feed" }),
      ).toBe(false);
    }
    expect(companyNameFromHeadline("Former Plaud exec raises $26M for a new app")).toBeNull();
    expect(companyNameFromHeadline("China’s Manus raises over $500M in funding")).toBe("Manus");
  });

  test("resolves the company link and keeps role-based first-party emails only", () => {
    const article = `<a href="https://x.com/acme">X</a><a href="https://acme.test/">Acme website</a>`;
    expect(discoverCompanyWebsite(article, "https://news.example/acme-round", "Acme")).toBe("https://acme.test/");
    expect(
      extractPublicEmails("hello@acme.test founder@acme.test privacy@acme.test", "https://acme.test/contact", "https://acme.test"),
    ).toEqual([{ email: "hello@acme.test", sourceUrl: "https://acme.test/contact" }]);
  });
});

test("collects and normalizes a funding observation without Firecrawl", async () => {
  const pages = new Map([
    ["https://news.example/feed.xml", feed],
    [
      "https://news.example/acme-round",
      `<html><body><h1>Acme raises $12M Series A</h1><a href="https://acme.test/">Acme</a></body></html>`,
    ],
    ["https://acme.test/", `<html><body><a href="/contact">Contact</a></body></html>`],
    ["https://acme.test/contact", `<html><body>Business inquiries: hello@acme.test</body></html>`],
  ]);
  const fetchImpl = async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = pages.get(url);
    return new Response(body ?? "not found", { status: body ? 200 : 404, headers: { "content-type": "text/html" } });
  };
  const [result] = await collectNativeSignals({
    feeds: ["https://news.example/feed.xml"],
    limit: 1,
    since: new Date("2026-10-01T00:00:00Z"),
    fetchImpl: fetchImpl as typeof fetch,
    jinaFallback: false,
  });
  expect(result?.input).toMatchObject({
    channel: "native-web",
    company: "Acme",
    tags: ["funding", "public-contact"],
    metadata: { collector: "signalround-native-v1", company_website: "https://acme.test/" },
  });
  expect(result?.contacts).toEqual([{ email: "hello@acme.test", sourceUrl: "https://acme.test/contact" }]);
});
