import { describe, expect, test } from "vitest";
import { summarizeWebResult } from "../lib/web-result-summary";

describe("web result summary", () => {
  test("counts local extraction matches and preserves truncation", () => {
    expect(
      summarizeWebResult({ mode: "extract", result: { items: ["Heading"], provider: "scrapling-local", truncated: true } }),
    ).toMatchObject({ status: "partial", count: 1, unit: "matches", provider: "scrapling-local" });
  });
  test.each([null, [], {}, { mode: "search", result: { web: "bad", news: [] } }])(
    "does not claim malformed responses succeeded: %j",
    (value) => {
      expect(summarizeWebResult(value).status).toBe("failed");
    },
  );
  test("counts web and news search results, including empty results", () => {
    expect(summarizeWebResult({ mode: "search", result: { web: [{}], news: [{}, {}] } })).toMatchObject({ status: "completed", count: 3 });
    expect(summarizeWebResult({ mode: "search", result: { web: [], news: [] } })).toMatchObject({ status: "completed", count: 0 });
  });
  test("retains crawl partial status and failed status", () => {
    expect(summarizeWebResult({ mode: "crawl", result: { data: [{}], remaining: 2 } }).status).toBe("partial");
    expect(summarizeWebResult({ mode: "crawl", result: { status: "failed", data: [], errors: [{}] } }).status).toBe("failed");
  });
  test("surfaces feed truncation and provider from metadata", () => {
    expect(
      summarizeWebResult({
        mode: "adaptive",
        result: { markdown: "feed", json: { entries: [{}, {}] }, metadata: { provider: "native:rss-atom", truncated: true } },
      }),
    ).toMatchObject({ status: "partial", count: 2, unit: "feed entries", provider: "native:rss-atom" });
  });
  test("surfaces map truncation, audit omissions and discussion errors", () => {
    expect(summarizeWebResult({ mode: "map", result: { links: ["https://example.com"], truncated: true } }).status).toBe("partial");
    expect(summarizeWebResult({ mode: "audit", result: { pages: [{}], omittedUrls: ["https://example.com"] } }).status).toBe("partial");
    expect(
      summarizeWebResult({ mode: "discussion", result: { items: [{}], errors: [{}], provider: "native:github-issues-api" } }),
    ).toMatchObject({ status: "partial", count: 1, provider: "native:github-issues-api" });
  });
  test("counts browser frames without claiming full journey coverage", () => {
    expect(summarizeWebResult({ mode: "browser", result: { status: "partial", frames: [{}, {}] } })).toMatchObject({
      status: "partial",
      count: 2,
      unit: "frames",
    });
  });
});
