import { describe, expect, test } from "vitest";
import { parseHtmlPage } from "./page.ts";

const source = "https://example.org/news/round";

describe("HTML page metadata provenance", () => {
  test.each(["name", "property"])("ignores reserved and prototype keys from meta %s", (attribute) => {
    const reserved = [
      "sourceURL",
      "url",
      "statusCode",
      "title",
      "credits",
      "creditsUsed",
      "provider",
      "fetchedAt",
      "prototype",
      ...Object.getOwnPropertyNames(Object.prototype),
    ];
    const keys = reserved.flatMap((key) => [key, key.toUpperCase(), ` ${key} `]);
    const html = `<title>Actual page title</title>${keys.map((key) => `<meta ${attribute}="${key}" content="spoofed">`).join("")}`;
    const metadata = parseHtmlPage(html, source).metadata;
    expect(metadata).toMatchObject({ sourceURL: source, url: source, statusCode: 200, title: "Actual page title" });
    expect(Object.getPrototypeOf(metadata)).toBe(Object.prototype);
    for (const key of keys) {
      expect(metadata?.[key]).not.toBe("spoofed");
      if (!["sourceURL", "url", "statusCode", "title"].includes(key)) expect(Object.hasOwn(metadata ?? {}, key)).toBe(false);
    }
  });

  test("preserves SEO fields, publication dates and branding without trusting og:url as source identity", () => {
    const doc = parseHtmlPage(
      `<title> Page title </title>
       <meta name="description" content="Summary"><meta property="og:title" content="Social title">
       <meta property="og:description" content="Social summary"><meta property="og:site_name" content="Example">
       <meta property="og:url" content="https://elsewhere.example/story">
       <meta property="article:published_time" content="2026-10-22"><meta property="article:modified_time" content="2026-10-23">
       <meta name="theme-color" content="#123456"><meta name="robots" content="index,follow">
       <link rel="icon" href="/favicon.ico"><body><p>Story</p></body>`,
      source,
    );
    expect(doc.metadata).toMatchObject({
      sourceURL: source,
      url: source,
      title: "Page title",
      description: "Summary",
      ogTitle: "Social title",
      ogSiteName: "Example",
      "og:url": "https://elsewhere.example/story",
      publishedTime: "2026-10-22",
      modifiedTime: "2026-10-23",
      robots: "index,follow",
      favicon: "https://example.org/favicon.ico",
    });
    expect(doc.branding).toMatchObject({ brandName: "Example", colors: { primary: "#123456" } });
  });

  test("keeps relative source links and readable text while rejecting unsupported link schemes and credentials", () => {
    const doc = parseHtmlPage(
      `<meta name="url" content="https://spoofed.example/"><body><h1>Funding</h1>
       <p><a href="../about#team">About</a> <a href="../about">Again</a></p>
       <a href="mailto:hello@example.org">Email</a><a href="javascript:alert(1)">Bad</a>
       <a href="https://user:password@example.org/">Private</a><script>hidden script</script></body>`,
      source,
    );
    expect(doc.links).toEqual(["https://example.org/about"]);
    expect(doc.markdown).toContain("# Funding");
    expect(doc.markdown).toContain("[About](https://example.org/about)");
    expect(doc.markdown).not.toContain("hidden script");
  });
});
