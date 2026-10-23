import { describe, expect, test, vi } from "vitest";
import { NativeWebClient } from "./client.ts";
import { feedDocument, githubDocument, reachReader } from "./reach.ts";
import type { PublicText } from "./transport.ts";

const response = (text: string, url = "https://example.org/feed"): PublicText => ({ text, url, status: 200, contentType: "text/xml" });

describe("adaptive and Agent Reach readers", () => {
  test("normalizes RSS and preserves provenance and published dates", () => {
    const doc = feedDocument(
      response(
        "<rss><channel><title>News</title><item><title>Funding</title><link>https://example.org/round</link><pubDate>2026-10-20</pubDate><description><![CDATA[<b>Real source</b>]]></description></item></channel></rss>",
      ),
    );
    expect(doc?.json).toMatchObject({
      entries: [{ title: "Funding", url: "https://example.org/round", published: "2026-10-20", description: "Real source" }],
    });
    expect(doc?.metadata?.provider).toBe("native:rss-atom");
  });
  test("normalizes Atom alternate links and caps entries", () => {
    const doc = feedDocument(
      response(
        `<feed><title>Updates</title>${'<entry><title>One</title><link rel="self" href="/api"/><link rel="alternate" href="/one"/><summary>Text</summary></entry>'.repeat(110)}</feed>`,
      ),
    );
    expect(doc?.links).toHaveLength(100);
    expect(doc?.links?.[0]).toBe("https://example.org/one");
  });
  test("rejects malformed and entity XML and leaves ordinary HTML alone", () => {
    expect(() => feedDocument(response("<rss><channel></rss>"))).toThrow("Invalid");
    expect(() => feedDocument(response('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>'))).toThrow("entities");
    expect(feedDocument(response("<html><p>Page</p></html>"))).toBeNull();
  });
  test("uses public GitHub API without credentials and excludes lookalike hosts", async () => {
    const read = vi.fn(async (_url: string) =>
      response(
        JSON.stringify({
          full_name: "owner/repo",
          html_url: "https://github.com/owner/repo",
          description: "Source",
          homepage: "https://example.org",
          stargazers_count: 7,
        }),
      ),
    );
    const doc = await githubDocument("https://github.com/owner/repo", read, 1000);
    expect(read.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/owner/repo");
    expect(doc?.json).toMatchObject({ name: "owner/repo", stars: 7 });
    expect(await githubDocument("https://github.com.evil.example/owner/repo", read, 1000)).toBeNull();
    expect(await githubDocument("https://github.com/owner/repo/issues", read, 1000)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
  test("Reader extracts Markdown and marks external provenance", async () => {
    const read = vi.fn(async (_url: string) =>
      response("Title: Page\nURL Source: https://1.1.1.1/\nMarkdown Content:\n# Page\n[Docs](https://example.org/docs)"),
    );
    const doc = await reachReader("https://1.1.1.1/", read, 1000);
    expect(doc.markdown).toContain("# Page");
    expect(doc.links).toEqual(["https://example.org/docs"]);
    expect(doc.metadata?.provider).toBe("agent-reach:jina");
    expect(read.mock.calls[0]?.[0]).toBe("https://r.jina.ai/https://1.1.1.1/");
  });
  test("Reader blocks private URLs, credentials and query disclosure before calling provider", async () => {
    const read = vi.fn();
    for (const url of [
      "http://127.0.0.1/",
      "http://169.254.169.254/",
      "https://user:password@1.1.1.1/",
      "https://1.1.1.1/?token=secret",
      "file:///etc/passwd",
    ])
      await expect(reachReader(url, read, 1000)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  test("Reader reports challenges, empty and unrecognized responses as failures", async () => {
    for (const text of ["Title: Just a moment...\nMarkdown Content: challenge", "Markdown Content: ", "Rate limited"])
      await expect(reachReader("https://1.1.1.1/", async () => response(text), 1000)).rejects.toThrow();
  });
  test("adaptive routes feeds, ordinary reads stay local, extraction still runs", async () => {
    const read = vi.fn(async (url: string) => response("<rss><channel><title>News</title></channel></rss>", url));
    const extract = vi.fn(async () => ({ count: 0 }));
    const client = new NativeWebClient({ read, extract });
    expect((await client.scrape("https://example.org/feed", { adaptive: true })).metadata?.provider).toBe("native:rss-atom");
    expect((await client.scrape("https://example.org/feed")).metadata?.provider).toBe("native:html");
    await client.scrape("https://example.org/feed", { adaptive: true, formats: [{ type: "json", schema: { type: "object" } }] });
    expect(extract).toHaveBeenCalledOnce();
    expect(read.mock.calls.every(([url]) => url === "https://example.org/feed")).toBe(true);
  });
});
