// What a verified homepage gives that profiles read before it was kept: the company's LinkedIn page
// (from the homepage's links) and, for a company with no logo, the logo its branding shows. Each
// verified homepage still missing one is read once more for its links and branding (one credit); the
// LinkedIn page is kept on the profile row (null when the homepage links none, so it is not asked
// again), and a logo fills an empty one only.
//   pnpm backfill-homepage-facts                    # dry run: reads the homepages, writes nothing, prints the counts
//   pnpm backfill-homepage-facts -- --apply         # write (reuses the dry run's reads from the cache)
//   --limit <n>        companies at most (default all)
//   --cache <file>     where homepage reads are kept between runs (default data/homepage-facts.json)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findLinkedinPage, homepageLogo, linkedinFromLinks, mapLimit, registrableDomain } from "@fireround/core";
import { closeDb, schema } from "@fireround/core/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { openStore } from "../../lib/db.ts";
import { getFirecrawl } from "../../lib/firecrawl.ts";
import { type EnrichmentData, toEnrichment } from "../../lib/persist.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const { companies, enrichments } = schema;
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const limit = Number(flag("--limit") ?? Number.POSITIVE_INFINITY);
const cachePath = flag("--cache") ?? path.join("data", "homepage-facts.json");
/** What each homepage read gave, by URL; null records a homepage that could not be read. */
const cache: Record<string, { links: string[]; logo: string | null } | null> = existsSync(cachePath)
  ? JSON.parse(readFileSync(cachePath, "utf8"))
  : {};

const handle = await openStore();
const rows = await handle
  .select({ id: companies.id, name: companies.name, logo: companies.logoUrl, data: enrichments.data })
  .from(enrichments)
  .innerJoin(companies, eq(companies.id, enrichments.companyId))
  .where(and(eq(enrichments.kind, "profile"), sql`(not (${enrichments.data} ? 'linkedin_url') or ${companies.logoUrl} is null)`));
const due = rows
  .filter((r) => toEnrichment(r.data as EnrichmentData)?.verified)
  .map((r) => ({ ...r, homepage: (r.data as EnrichmentData).company_website as string, asked: "linkedin_url" in (r.data as object) }))
  .slice(0, limit);
const unread = due.filter((r) => !(r.homepage in cache));
console.log(
  `${due.length} verified homepages missing a LinkedIn read or a logo; ${unread.length} to read (about ${unread.length} credits)`,
);

const client = getFirecrawl();
await mapLimit(unread, 8, async (r) => {
  try {
    const home = await client.scrape(r.homepage, { formats: ["links", "branding"], onlyMainContent: false, timeout: 45_000 });
    cache[r.homepage] = { links: home.links ?? [], logo: homepageLogo(home, r.homepage) };
  } catch {
    cache[r.homepage] = null;
  }
});
mkdirSync(path.dirname(cachePath), { recursive: true });
writeFileSync(cachePath, JSON.stringify(cache));

let linkedin = 0;
let logos = 0;
let unreadable = 0;
for (const r of due) {
  const read = cache[r.homepage];
  if (!read) {
    unreadable++;
    continue;
  }
  if (!r.asked) {
    const domain = registrableDomain(r.homepage);
    const url =
      linkedinFromLinks(read.links, { name: r.name, homepage: r.homepage }) ??
      (domain ? (await findLinkedinPage(client, { name: r.name, domain })).url : null);
    if (url) linkedin++;
    if (apply)
      await handle
        .update(enrichments)
        .set({ data: sql`${enrichments.data} || ${JSON.stringify({ linkedin_url: url })}::jsonb` })
        .where(and(eq(enrichments.companyId, r.id), eq(enrichments.kind, "profile")));
  }
  if (!r.logo && read.logo) {
    logos++;
    if (apply)
      await handle
        .update(companies)
        .set({ logoUrl: read.logo, updatedAt: new Date() })
        .where(and(eq(companies.id, r.id), isNull(companies.logoUrl)));
  }
}
console.log(
  `${linkedin} LinkedIn pages found (of ${due.filter((r) => !r.asked).length} asked), ${logos} logos for companies without one, ${unreadable} homepages unreadable (left for a later run)`,
);
console.log(apply ? "applied" : "dry run: nothing written (pass --apply to write)");
if (apply) await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
