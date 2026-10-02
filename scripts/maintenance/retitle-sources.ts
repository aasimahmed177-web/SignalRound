// Retitle the sources a store wrote before titles came from the page itself:
//   pnpm retitle-sources              # rewrite
//   pnpm retitle-sources -- --dry-run # count and list, change nothing
// A source whose title names none of the companies its rounds are about, while its URL slug
// names one, was titled from a search result that belonged to a sibling article. The slug is
// the article's own, so it becomes the title, humanized (`sourceTitle` in core). The extraction
// path applies the same rule to new data. Filings (sec.gov) are not articles and are titled
// when rendered, so they are left alone.

import { sourceTitle } from "@fireround/core";
import { closeDb, schema } from "@fireround/core/db";
import { eq, notInArray } from "drizzle-orm";
import { openStore } from "../../lib/db.ts";
import { FILING_HOSTS } from "../../lib/news.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const { sources, roundSources, fundingRounds, companies } = schema;
const dryRun = process.argv.includes("--dry-run");

const handle = await openStore();
const rows = await handle
  .select({ id: sources.id, url: sources.url, title: sources.title, company: companies.name })
  .from(sources)
  .innerJoin(roundSources, eq(roundSources.sourceId, sources.id))
  .innerJoin(fundingRounds, eq(fundingRounds.id, roundSources.roundId))
  .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
  .where(notInArray(sources.host, [...FILING_HOSTS]));

const bySource = new Map<string, { url: string; title: string | null; companies: string[] }>();
for (const r of rows) {
  const entry = bySource.get(r.id) ?? { url: r.url, title: r.title, companies: [] };
  entry.companies.push(r.company);
  bySource.set(r.id, entry);
}

let rewritten = 0;
for (const [id, s] of bySource) {
  const next = sourceTitle(s.title ?? undefined, s.url, s.companies);
  if (next === undefined || next === (s.title ?? undefined)) continue;
  rewritten++;
  console.log(`${dryRun ? "would retitle" : "retitled"} ${s.url}\n  ${JSON.stringify(s.title)} -> ${JSON.stringify(next)}`);
  if (!dryRun) await handle.update(sources).set({ title: next }).where(eq(sources.id, id));
}
console.log(`${dryRun ? "Would rewrite" : "Rewrote"} ${rewritten} of ${bySource.size} source title(s).`);
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
