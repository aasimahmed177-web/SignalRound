// Take sources off stored rounds when the page is not about the round (docs/data-quality.md, "A source is about its round"):
//   pnpm prune-unrelated-sources                          # dry run on stored data: each round, the links that would go and why
//   pnpm prune-unrelated-sources -- --read-pages          # also read (one NativeWebClient scrape each) the pages nothing stored ties to the company
//   pnpm prune-unrelated-sources -- --read-pages --apply  # write: detach, record the sentence on kept roundups, remove orphaned sources
//   pnpm prune-unrelated-sources -- --round <id>[,<id>]   # only those rounds
//   --page-cache <file>  where page reads are kept (default data/prune-sources-pages.json), so a rerun or the apply spends nothing
// A round's last source never goes; the round is listed as held for review instead. Safe to run again.
// The rule is lib/prune-sources.ts over sourceFit in core.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb } from "@fireround/core/db";
import { openStore } from "../../lib/db.ts";
import { describeSourcePrune, type PageReader, pruneUnrelatedSources } from "../../lib/prune-sources.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";
import { getWebClient } from "../../lib/web-client.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const readPages = args.includes("--read-pages");
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const roundIds = flag("--round")?.split(",").filter(Boolean);
const cachePath = flag("--page-cache") ?? path.join("data", "prune-sources-pages.json");

/** Page text by URL; null records a page that could not be read, so it is not paid for twice. */
const cache: Record<string, string | null> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
const cached: PageReader = async (url) => cache[url] ?? null;

const handle = await openStore();

if (readPages) {
  // A first pass on stored data and the cache names the pages still unread; they are read in parallel, then the real pass runs.
  const wanted = new Set<string>();
  await pruneUnrelatedSources(handle, {
    roundIds,
    readPage: async (url) => {
      if (url in cache) return cache[url];
      wanted.add(url);
      return null;
    },
  });
  const urls = [...wanted];
  if (urls.length) console.error(`reading ${urls.length} page(s) with NativeWebClient (about ${urls.length} credit(s))`);
  const client = getWebClient();
  for (let i = 0; i < urls.length; i += 10) {
    await Promise.all(
      urls.slice(i, i + 10).map(async (url) => {
        try {
          const doc = await client.scrape(url, { formats: ["markdown"], onlyMainContent: true, timeout: 60_000 });
          cache[url] = doc.markdown?.trim() ? doc.markdown : null;
        } catch {
          cache[url] = null;
        }
      }),
    );
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache));
  }
}

const reading = readPages || Object.keys(cache).length > 0;
const summary = await pruneUnrelatedSources(handle, { apply, roundIds, readPage: reading ? cached : undefined });
for (const a of summary.audits) for (const line of describeSourcePrune(a, apply)) console.log(line);

const detached = summary.audits.reduce((n, a) => n + a.detach.length, 0);
const held = summary.audits.filter((a) => a.held.length).length;
const unverified = summary.audits.reduce((n, a) => n + a.unverified.length, 0);
const evidenced = summary.audits.reduce((n, a) => n + a.evidenced.length, 0);
const reasons = Object.entries(summary.byReason)
  .sort((a, b) => b[1] - a[1])
  .map(([r, n]) => `${r} ${n}`)
  .join(", ");
console.log(
  `${summary.rounds} round(s), ${summary.links} link(s) read. ${detached} link(s) on ${summary.audits.filter((a) => a.detach.length).length} round(s) ${apply ? "detached" : "would be detached"}${reasons ? ` (${reasons})` : ""}; ${summary.orphans} source row(s) ${apply ? "removed" : "would be removed"} as linked to no round; ${held} round(s) held for review (every source would go); ${evidenced} link(s) ${apply ? "kept with" : "would keep"} the sentence read off the page; ${unverified} link(s) unverified${reading ? " (the page read could not settle it; each line gives why)" : " (add --read-pages to read them)"}.${apply ? "" : " Nothing was written; add --apply to write."}`,
);
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
