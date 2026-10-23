import { httpUrl } from "./page.ts";
import type { Document, ScrapeOptions } from "./types.ts";

export interface CrawlOptions {
  limit?: number;
  maxDepth?: number;
  timeout?: number;
}
export interface CrawlResult {
  status: "completed" | "partial" | "failed";
  data: Document[];
  errors: Array<{ url: string; error: string }>;
  attempted: number;
  remaining: number;
  creditsUsed: 0;
}

/** Bounded same-origin breadth-first crawl using the client's public-network transport. */
export async function crawlPages(
  scrape: (url: string, options?: ScrapeOptions) => Promise<Document>,
  raw: string,
  options: CrawlOptions = {},
): Promise<CrawlResult> {
  const seed = httpUrl(raw);
  if (!seed) throw new Error("Enter a public HTTP(S) URL.");
  const limit = options.limit ?? 10;
  const depth = options.maxDepth ?? 2;
  const timeout = options.timeout ?? 45_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("Page limit must be between 1 and 25.");
  if (!Number.isInteger(depth) || depth < 0 || depth > 4) throw new Error("Depth must be between 0 and 4.");
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 90_000) throw new Error("Timeout must be between 1 and 90000 milliseconds.");
  const origin = new URL(seed).origin;
  const queue = [{ url: seed, depth: 0 }];
  const seen = new Set([seed]);
  const result: CrawlResult = { status: "completed", data: [], errors: [], attempted: 0, remaining: 0, creditsUsed: 0 };
  const deadline = Date.now() + timeout;
  while (queue.length && result.attempted < limit && Date.now() < deadline) {
    const next = queue.shift();
    if (!next) break;
    result.attempted++;
    try {
      const page = await scrape(next.url, { formats: ["markdown", "links"], timeout: Math.min(10_000, deadline - Date.now()) });
      const resolved = page.metadata?.sourceURL ?? next.url;
      if (new URL(resolved).origin !== origin) throw new Error("Page redirected outside the selected origin; content omitted.");
      result.data.push(page);
      if (next.depth >= depth) continue;
      for (const link of page.links ?? []) {
        const url = httpUrl(link, resolved);
        if (!url || new URL(url).origin !== origin || seen.has(url)) continue;
        if (/\.(?:pdf|zip|png|jpe?g|gif|webp|svg|mp4|mp3|woff2?)(?:$|\?)/i.test(url)) continue;
        // Cap queued discovery as well as network work on large link directories.
        if (seen.size >= 500) break;
        seen.add(url);
        queue.push({ url, depth: next.depth + 1 });
      }
    } catch (error) {
      result.errors.push({ url: next.url, error: error instanceof Error ? error.message : String(error) });
    }
  }
  result.remaining = queue.length;
  result.status = !result.data.length ? "failed" : result.errors.length || queue.length ? "partial" : "completed";
  return result;
}
