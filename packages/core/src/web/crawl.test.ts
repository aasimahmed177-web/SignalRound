import { expect, test, vi } from "vitest";
import { crawlPages } from "./crawl.ts";

test("crawl deduplicates fragments, stays on origin and respects depth", async () => {
  const scrape = vi.fn(async (url: string) => ({
    markdown: url,
    links: url.endsWith("/a") ? ["https://example.com/deep"] : ["/a#one", "/a#two", "https://other.com/x", "/file.pdf"],
    metadata: { sourceURL: url },
  }));
  const result = await crawlPages(scrape, "https://example.com/", { maxDepth: 1 });
  expect(scrape.mock.calls.map(([url]) => url)).toEqual(["https://example.com/", "https://example.com/a"]);
  expect(result.status).toBe("completed");
});
test("failures consume the attempt budget and expose partial results", async () => {
  const scrape = vi.fn(async (url: string) => {
    if (url.endsWith("/bad")) throw new Error("Blocked");
    return { markdown: "real content", links: ["/bad", "/later"], metadata: { sourceURL: url } };
  });
  const result = await crawlPages(scrape, "https://example.com/", { limit: 2 });
  expect(result).toMatchObject({ status: "partial", attempted: 2, remaining: 1, creditsUsed: 0 });
  expect(result.errors[0]?.error).toBe("Blocked");
});
test("rejects invalid inputs before reading and omits off-origin redirects", async () => {
  const scrape = vi.fn(async () => ({ markdown: "outside", metadata: { sourceURL: "https://other.com/" } }));
  await expect(crawlPages(scrape, "file:///etc/passwd")).rejects.toThrow();
  await expect(crawlPages(scrape, "https://example.com", { limit: NaN })).rejects.toThrow();
  expect(scrape).not.toHaveBeenCalled();
  expect(await crawlPages(scrape, "https://example.com")).toMatchObject({ status: "failed", data: [] });
});
