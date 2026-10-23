import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { load } from "cheerio";
import { httpUrl } from "./page.ts";
import { readPublicText } from "./transport.ts";
import type { SearchOptions, SearchResultNews } from "./types.ts";

const exec = promisify(execFile);
export type SearchProvider = (query: string, options: SearchOptions) => Promise<SearchResultNews[]>;

/** Search dates are discovery hints; unknown dates must still be checked on the article before publication. */
export function searchDateRange(tbs: string | undefined, now = new Date()): { from: Date; to: Date; duckFilter: string } | null {
  const custom = /cd_min:(\d{1,2})\/(\d{1,2})\/(\d{4}),cd_max:(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(tbs ?? "");
  if (custom) {
    const date = (year: string, month: string, day: string) =>
      new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00.000Z`);
    const from = date(custom[3] ?? "", custom[1] ?? "", custom[2] ?? "");
    const last = date(custom[6] ?? "", custom[4] ?? "", custom[5] ?? "");
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(last.getTime()) || from > last) throw new Error("Invalid search date range");
    return {
      from,
      to: new Date(last.getTime() + 86_400_000),
      duckFilter: `${from.toISOString().slice(0, 10)}..${last.toISOString().slice(0, 10)}`,
    };
  }
  const relative = /qdr:([dwmy])/.exec(tbs ?? "")?.[1];
  if (!relative) return null;
  const days = relative === "d" ? 1 : relative === "w" ? 7 : relative === "m" ? 31 : 366;
  return { from: new Date(now.getTime() - days * 86_400_000), to: now, duckFilter: relative };
}

export function withinSearchDate(hit: SearchResultNews, tbs?: string): boolean {
  const range = searchDateRange(tbs);
  if (!range || !hit.date) return true;
  const date = Date.parse(hit.date);
  return !Number.isFinite(date) || (date >= range.from.getTime() && date <= range.to.getTime());
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Both Exa's structured results and MCP text blocks are accepted, but unreadable output is an error. */
export function parseSearchPayload(payload: unknown): SearchResultNews[] {
  const root = record(payload);
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.results)
      ? root.results
      : Array.isArray(root?.data)
        ? root.data
        : null;
  if (list)
    return list.flatMap((item) => {
      const row = record(item);
      const url = typeof row?.url === "string" ? httpUrl(row.url) : null;
      if (!row || !url) return [];
      return [
        {
          url,
          title: typeof row.title === "string" ? row.title : undefined,
          description: String(row.content ?? row.text ?? row.description ?? ""),
          date:
            typeof row.publishedDate === "string"
              ? row.publishedDate
              : typeof row.published_date === "string"
                ? row.published_date
                : undefined,
        },
      ];
    });
  if (root?.structuredContent) return parseSearchPayload(root.structuredContent);
  const content = Array.isArray(root?.content)
    ? root.content
        .map((item) => record(item)?.text)
        .filter((v): v is string => typeof v === "string")
        .join("\n")
    : typeof payload === "string"
      ? payload
      : "";
  if (content.trim().startsWith("{") || content.trim().startsWith("[")) {
    try {
      return parseSearchPayload(JSON.parse(content));
    } catch {
      /* Parse formatted search output below. */
    }
  }
  const hits: SearchResultNews[] = [];
  for (const block of content.split(/(?=^Title:)/m)) {
    const url = httpUrl(/^URL:\s*(\S+)/m.exec(block)?.[1] ?? "");
    if (url)
      hits.push({
        url,
        title: /^Title:\s*(.+)/m.exec(block)?.[1],
        description: /^(?:Text|Content):\s*([\s\S]*)/m.exec(block)?.[1]?.slice(0, 4000),
        date: /^Published Date:\s*(.+)/m.exec(block)?.[1],
      });
  }
  if (!hits.length) throw new Error("Search provider returned no parseable results; check its configuration or rate limit");
  return hits;
}

export function parseDuckDuckGo(html: string): SearchResultNews[] {
  const $ = load(html);
  if (/anomaly-modal|bots use DuckDuckGo|challenge-form/i.test(html))
    throw new Error("DuckDuckGo blocked automated search; configure SEARXNG_URL or Agent Reach search");
  const hits: SearchResultNews[] = [];
  $(".result").each((_, element) => {
    const anchor = $(element).find(".result__a").first();
    const raw = anchor.attr("href");
    if (!raw) return;
    const wrapped = new URL(raw, "https://html.duckduckgo.com/");
    const url = httpUrl(wrapped.searchParams.get("uddg") ?? wrapped.toString());
    if (!url || new URL(url).hostname.endsWith("duckduckgo.com")) return;
    hits.push({ url, title: anchor.text().trim(), description: $(element).find(".result__snippet").text().trim() });
  });
  if (!hits.length)
    $("a.result-link").each((index, element) => {
      const anchor = $(element);
      const raw = anchor.attr("href");
      if (!raw) return;
      const wrapped = new URL(raw, "https://lite.duckduckgo.com/");
      const url = httpUrl(wrapped.searchParams.get("uddg") ?? wrapped.toString());
      if (!url || new URL(url).hostname.endsWith("duckduckgo.com")) return;
      hits.push({ url, title: anchor.text().trim(), description: $(".result-snippet").eq(index).text().trim() });
    });
  if (!hits.length && !$(".no-results").length && !/No results found for/i.test($("body").text()))
    throw new Error("DuckDuckGo returned an unrecognized search page");
  return hits;
}

export const nativeSearch: SearchProvider = async (query, options) => {
  if (!query.trim() || query.length > 2000) throw new Error("Search query must be between 1 and 2000 characters");
  const domains = (list: string[] | undefined) => (list ?? []).filter((domain) => /^[a-z\d.-]+\.[a-z]{2,}$/i.test(domain));
  const included = domains(options.includeDomains);
  query = [
    query,
    included.length ? `(${included.map((domain) => `site:${domain}`).join(" OR ")})` : "",
    ...domains(options.excludeDomains).map((domain) => `-site:${domain}`),
  ]
    .filter(Boolean)
    .join(" ");
  const limit = Math.max(1, Math.min(options.limit ?? 10, 40));
  const provider =
    process.env.NATIVE_SEARCH_PROVIDER ??
    (process.env.SEARXNG_URL ? "searxng" : process.env.AGENT_REACH_MCPORTER ? "agent-reach" : "duckduckgo");
  if (provider === "searxng") {
    if (!process.env.SEARXNG_URL) throw new Error("SEARXNG_URL is required for the searxng search provider");
    const url = new URL("search", `${process.env.SEARXNG_URL.replace(/\/$/, "")}/`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const sources = options.sources?.map((s) => (typeof s === "string" ? s : s.type)) ?? ["web"];
    url.searchParams.set("categories", sources.includes("news") ? "general,news" : "general");
    const period = /qdr:([dwmy])/.exec(options.tbs ?? "")?.[1];
    if (period) url.searchParams.set("time_range", period === "d" ? "day" : period === "m" || period === "w" ? "month" : "year");
    const response = await readPublicText(url.toString(), {
      timeoutMs: options.timeout ?? 20_000,
      maxBytes: 2_000_000,
      trustedOrigin: new URL(process.env.SEARXNG_URL).origin,
    });
    return parseSearchPayload(JSON.parse(response.text))
      .filter((hit) => withinSearchDate(hit, options.tbs))
      .slice(0, limit);
  }
  if (provider === "agent-reach") {
    // An operator-configured executable; query text is an argument, never a shell program.
    const binary = process.env.AGENT_REACH_MCPORTER ?? "mcporter";
    const { stdout } = await exec(binary, ["call", "exa.web_search_exa", `query=${query}`, `numResults=${limit}`, "--output", "json"], {
      timeout: options.timeout ?? 30_000,
      maxBuffer: 2_000_000,
    });
    let payload: unknown = stdout;
    try {
      payload = JSON.parse(stdout);
    } catch {
      /* Some mcporter versions output plain text. */
    }
    return parseSearchPayload(payload)
      .filter((hit) => withinSearchDate(hit, options.tbs))
      .slice(0, limit);
  }
  if (provider !== "duckduckgo") throw new Error(`Unknown native search provider: ${provider}`);
  const url = new URL("https://lite.duckduckgo.com/lite/");
  url.searchParams.set("q", query);
  const range = searchDateRange(options.tbs);
  if (range) url.searchParams.set("df", range.duckFilter);
  return parseDuckDuckGo((await readPublicText(url.toString(), { timeoutMs: options.timeout ?? 20_000, maxBytes: 2_000_000 })).text).slice(
    0,
    limit,
  );
};
