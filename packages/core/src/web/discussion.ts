import { load } from "cheerio";
import { readPublicText } from "./transport.ts";

/** Public HN thread plus a bounded breadth-first comment sample. No login/session access. */
export async function readDiscussion(raw: string, limit = 20, read = readPublicText) {
  const url = new URL(raw);
  if (
    url.hostname !== "news.ycombinator.com" ||
    url.pathname !== "/item" ||
    url.username ||
    url.password ||
    url.port ||
    !["https:", "http:"].includes(url.protocol)
  )
    throw new Error(
      "Structured discussion reads currently support Hacker News item URLs. Other public forums can use Scrape or Reader; authenticated social adapters are not configured.",
    );
  const id = url.searchParams.get("id");
  if (!id || !/^\d{1,12}$/.test(id)) throw new Error("Supply a valid Hacker News item ID.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("Choose 1–25 comments.");
  const signal = AbortSignal.timeout(45_000);
  const items: Array<{ id: number; parent: number | null; title: string; text: string; sourceURL: string }> = [];
  const errors: Array<{ id: string; error: string }> = [];
  const queue = [id];
  const seen = new Set<string>();
  while (queue.length && seen.size < limit + 1) {
    const next = queue.shift();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    try {
      const response = await read(`https://hacker-news.firebaseio.com/v0/item/${next}.json`, {
        signal,
        timeoutMs: 8000,
        maxBytes: 500_000,
      });
      const row = JSON.parse(response.text);
      if (!row || row.deleted || row.dead) continue;
      if (typeof row.id !== "number" || String(row.id) !== next) throw new Error("Unrecognized discussion response.");
      items.push({
        id: row.id,
        parent: typeof row.parent === "number" ? row.parent : null,
        title: typeof row.title === "string" ? row.title : "",
        text: load(typeof row.text === "string" ? row.text : "")
          .text()
          .slice(0, 15_000),
        sourceURL: `https://news.ycombinator.com/item?id=${row.id}`,
      });
      for (const kid of Array.isArray(row.kids) ? row.kids.slice(0, 100) : []) {
        if (Number.isSafeInteger(kid) && kid > 0 && queue.length < 200 && !seen.has(String(kid))) queue.push(String(kid));
      }
    } catch (error) {
      errors.push({ id: next, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    status: !items.length ? "failed" : errors.length || queue.length ? "partial" : "completed",
    provider: "native:hacker-news-api",
    fetchedAt: new Date().toISOString(),
    items,
    errors,
    remainingDiscovered: queue.length,
    note: "Bounded comment sample, not the complete discussion. Posts are unverified statements, not established facts.",
    creditsUsed: 0,
  };
}
