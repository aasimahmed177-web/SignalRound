import { describe, expect, test, vi } from "vitest";
import { NativeWebClient, parseDuckDuckGo, parseHtmlPage, parseSearchPayload } from "./client.ts";
import { searchDateRange } from "./search.ts";
import type { WebStateStore } from "./store.ts";
import type { PublicText } from "./transport.ts";

function memoryStore(): WebStateStore {
  const values = new Map<string, unknown>();
  return {
    async get(key) {
      return structuredClone(values.get(key));
    },
    async put(key, value) {
      values.set(key, structuredClone(value));
    },
    async remove(key) {
      values.delete(key);
    },
    async compareAndSwap(key, expected, value) {
      if (JSON.stringify(values.get(key)) !== JSON.stringify(expected)) return false;
      values.set(key, structuredClone(value));
      return true;
    },
  };
}
const article = `<html><head><title>Acme raises funding</title><meta property="article:published_time" content="2026-10-15"><meta property="og:site_name" content="Acme"><link rel="icon" href="/icon.png"></head><body><nav>Unrelated nav</nav><article><h1>Acme raises $10 million</h1><p>Acme announced its Series A financing, led by Example Ventures. The funding supports expansion of its developer tools business. Read the <a href="/release">official announcement</a> for details.</p></article></body></html>`;
const read = async (url: string): Promise<PublicText> => ({ text: article, url, status: 200, contentType: "text/html" });

describe("native page and search parsing", () => {
  test("preserves readable linked evidence, dates and favicon without navigation", () => {
    const doc = parseHtmlPage(article, "https://acme.example/");
    expect(doc.markdown).toContain("# Acme raises $10 million");
    expect(doc.markdown).toContain("[official announcement](https://acme.example/release)");
    expect(doc.markdown).not.toContain("Unrelated nav");
    expect(doc.links).toEqual(["https://acme.example/release"]);
    expect(doc.metadata?.publishedTime).toBe("2026-10-15");
    expect(doc.metadata?.favicon).toBe("https://acme.example/icon.png");
  });
  test("does not turn text into HTML when converting links", () => {
    const doc = parseHtmlPage(
      '<p><a href="/x">&lt;script&gt;not instructions&lt;/script&gt;</a> quoted evidence</p>',
      "https://example.org/",
    );
    expect(doc.markdown).toContain("<script>not instructions</script>");
    expect(doc.markdown).toContain("quoted evidence");
  });
  test("unwraps search redirects and reports bot challenges", () => {
    expect(
      parseDuckDuckGo(
        '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Facme.example%2F">Acme</a><a class="result__snippet">Funding</a></div>',
      )[0]?.url,
    ).toBe("https://acme.example/");
    expect(() => parseDuckDuckGo('<form id="challenge-form"></form>')).toThrow("blocked");
    expect(() => parseDuckDuckGo("Unexpected provider error")).toThrow("unrecognized");
    expect(parseDuckDuckGo('<div class="no-results">No results</div>')).toEqual([]);
    expect(
      parseDuckDuckGo(
        '<table><tr><td><a class="result-link" href="https://acme.example/">Acme</a></td></tr><tr><td class="result-snippet">Funding announcement</td></tr></table>',
      )[0],
    ).toEqual({ url: "https://acme.example/", title: "Acme", description: "Funding announcement" });
  });
  test("accepts Exa MCP text and rejects opaque provider failures", () => {
    expect(
      parseSearchPayload({
        content: [{ type: "text", text: "Title: Acme funding\nURL: https://acme.example/release\nText: Raises $10m" }],
      })[0]?.title,
    ).toBe("Acme funding");
    expect(parseSearchPayload({ results: [] })).toEqual([]);
    expect(() => parseSearchPayload({ content: [{ text: "Rate limit exceeded" }] })).toThrow("no parseable");
  });
});

describe("native web orchestration", () => {
  test("structured scraping uses the supplied page and schema, propagating model failure", async () => {
    const extract = vi.fn(async () => ({ company: "Acme" }));
    const client = new NativeWebClient({ read, extract });
    const schema = { type: "object", properties: { company: { type: "string" } } };
    const page = await client.scrape("https://acme.example/", {
      formats: ["markdown", { type: "json", schema, prompt: "Identify the company" }],
    });
    expect(page.json).toEqual({ company: "Acme" });
    expect(extract).toHaveBeenCalledWith(expect.stringContaining("Acme raises"), schema, "Identify the company");
    const failed = new NativeWebClient({
      read,
      extract: async () => {
        throw new Error("No model configured");
      },
    });
    await expect(failed.scrape("https://acme.example/", { formats: [{ type: "json", schema }] })).rejects.toThrow("No model configured");
  });
  test("search does not fabricate a second source or hide provider errors", async () => {
    const client = new NativeWebClient({
      search: async () => [{ url: "https://acme.example/", title: "Acme" }, { url: "https://acme.example/" }],
    });
    const result = await client.search("Acme", { sources: ["web", "news"] });
    expect(result.web).toHaveLength(1);
    expect(result.news).toEqual([]);
    await expect(
      new NativeWebClient({
        search: async () => {
          throw new Error("Provider unavailable");
        },
      }).search("Acme"),
    ).rejects.toThrow("Provider unavailable");
  });
  test("enforces domain exclusions and dated result windows after provider search", async () => {
    const client = new NativeWebClient({
      search: async () => [
        { url: "https://news.acme.example/new", date: "2026-10-15" },
        { url: "https://acme.example/old", date: "2024-01-01" },
        { url: "https://acme.example/undated" },
        { url: "https://excluded.acme.example/new", date: "2026-10-15" },
        { url: "https://notacme.example/new", date: "2026-10-15" },
      ],
    });
    const result = await client.search("Acme", {
      includeDomains: ["acme.example"],
      excludeDomains: ["excluded.acme.example"],
      tbs: "cdr:1,cd_min:10/14/2026,cd_max:10/16/2026",
    });
    expect(result.web.map((hit) => hit.url)).toEqual(["https://news.acme.example/new", "https://acme.example/undated"]);
    expect(searchDateRange("cdr:1,cd_min:10/14/2026,cd_max:10/16/2026")?.duckFilter).toBe("2026-10-14..2026-10-16");
  });
  test("research is resumable across client instances and keeps the fetched evidence", async () => {
    const store = memoryStore();
    const extract = vi.fn(async (_text: string, schema: object) =>
      "properties" in schema && schema.properties && typeof schema.properties === "object" && "queries" in schema.properties
        ? { queries: ["Acme funding"] }
        : { company: "Acme", source_url: "https://acme.example/" },
    );
    const options = { read, extract, store, search: async () => [{ url: "https://acme.example/" }] };
    const started = await new NativeWebClient(options).startAgent({ prompt: "Research Acme", schema: { type: "object" } });
    const resumed = new NativeWebClient(options);
    const result = await resumed.getAgentStatus(started.id);
    expect(result.status).toBe("completed");
    expect(result.sources).toEqual(["https://acme.example/"]);
    expect(extract.mock.calls[1]?.[0]).toContain("Source URL: https://acme.example/");
    expect(await new NativeWebClient(options).getAgentStatus(started.id)).toEqual(result);
    expect(extract).toHaveBeenCalledTimes(2);
  });
  test("failed research stays failed and cancellation survives a new process", async () => {
    const store = memoryStore();
    const options = {
      store,
      extract: async () => {
        throw new Error("Missing model");
      },
    };
    const client = new NativeWebClient(options);
    const job = await client.startAgent({ prompt: "Research Acme", schema: {} });
    expect(await client.getAgentStatus(job.id)).toMatchObject({ status: "failed", error: "Missing model" });
    const other = await client.startAgent({ prompt: "Research Example", schema: {} });
    expect(await client.cancelAgent(other.id)).toBe(true);
    expect(await new NativeWebClient(options).getAgentStatus(other.id)).toMatchObject({ status: "failed", error: "Research cancelled" });
  });
  test("monitor state and seen URLs survive a new client, with include/exclude rules", async () => {
    const store = memoryStore();
    const options = { store, search: async () => [{ url: "https://acme.example/release" }, { url: "https://unrelated.example/post" }] };
    const client = new NativeWebClient(options);
    const monitor = await client.createMonitor({
      targets: [{ type: "search", queries: ["Acme funding"], includeDomains: ["acme.example"] }],
    });
    expect(monitor.id).toMatch(/^native-monitor:/);
    const first = await client.runMonitor(monitor.id);
    expect(first.pages).toEqual([{ url: "https://acme.example/release", status: "new" }]);
    const resumed = new NativeWebClient(options);
    expect((await resumed.runMonitor(monitor.id)).pages?.[0]?.status).toBe("unchanged");
    expect(await resumed.getMonitorCheck(monitor.id, first.id)).toEqual(first);
  });
});
