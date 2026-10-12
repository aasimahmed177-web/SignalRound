// Retitle the sources a store titled from their URL slug before a slug stopped being a title:
//   pnpm retitle-sources              # rewrite
//   pnpm retitle-sources -- --dry-run # count and list, change nothing
// A source whose title is its own slug read as a headline ("Oxford nanopore liverpool university ai
// matter machine v73fc9jlg") takes the headline of the page as last read (its h1, articleTitle in core)
// when that headline carries most of the slug's words.
// A source with no read page keeps its title and is listed. Filings (sec.gov) are not articles and are
// titled when rendered, so they are left alone.

import { articleTitle, humanizeSlug, urlSlug } from "@fireround/core";
import { closeDb, schema } from "@fireround/core/db";
import { desc, eq, inArray, notInArray } from "drizzle-orm";
import { openStore } from "../../lib/db.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const { sources, pageSnapshotReads, pageSnapshots } = schema;
const dryRun = process.argv.includes("--dry-run");

const handle = await openStore();
const rows = await handle
  .select({ id: sources.id, url: sources.url, title: sources.title })
  .from(sources)
  .where(notInArray(sources.host, ["sec.gov", "www.sec.gov"]));
const slugTitled = rows.filter((r) => r.title && r.title === humanizeSlug(urlSlug(r.url)));

const wordsOf = (value: string) => value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const renders = (headline: string, slugTitle: string) => {
  const own = new Set(wordsOf(headline));
  const slug = wordsOf(slugTitle).filter((w) => w.length > 2);
  return slug.length > 0 && slug.filter((w) => own.has(w)).length >= 0.5 * slug.length;
};

let rewritten = 0;
const unread: string[] = [];
for (const s of slugTitled) {
  const [read] = await handle
    .select({ markdown: pageSnapshots.markdown })
    .from(pageSnapshotReads)
    .innerJoin(pageSnapshots, eq(pageSnapshots.hash, pageSnapshotReads.snapshotHash))
    .where(inArray(pageSnapshotReads.sourceUrl, [s.url, `${s.url}/`]))
    .orderBy(desc(pageSnapshotReads.readAt))
    .limit(1);
  const headline = read
    ? articleTitle({ markdown: read.markdown })
        ?.replace(/^[*_]+|[*_]+$/g, "")
        .trim()
    : undefined;
  // The headline is this article's only when it carries most of the slug's words; a site's furniture
  // (a banner's "A message from ..." as the first heading) does not.
  const next = headline && renders(headline, s.title as string) ? headline : undefined;
  if (!next || next === s.title) {
    unread.push(s.url);
    continue;
  }
  rewritten++;
  console.log(`${dryRun ? "would retitle" : "retitled"} ${s.url}\n  ${JSON.stringify(s.title)} -> ${JSON.stringify(next)}`);
  if (!dryRun) await handle.update(sources).set({ title: next }).where(eq(sources.id, s.id));
}
for (const url of unread) console.log(`no headline on record: ${url}`);
console.log(
  `${dryRun ? "Would rewrite" : "Rewrote"} ${rewritten} of ${slugTitled.length} slug-titled source(s); ${unread.length} have no headline on record.`,
);
if (!dryRun) await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
