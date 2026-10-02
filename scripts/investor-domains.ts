// Website domains and logos for the investors the store already holds: every investor on a visible
// round with no domain and no search yet, newest rounds first, resolved as the lanes do (a 2-credit
// search and a 5-credit homepage verdict that also reads the logo, more for the hard ones); then the
// investors that already had a domain but no logo read get theirs (one 1-credit branding scrape).
// For the whole directory at once, with a report and a reviewable plan, use `pnpm resolve-investors`.
//   pnpm investor-domains -- --dry-run               # searches, scrapes, and the credits, with no call
//   pnpm investor-domains                            # 50 resolutions, then 50 logo reads from the backlog
//   pnpm investor-domains -- --limit 2000
//   pnpm investor-domains -- --limit 500 --retry-days 30   # also misses checked 30+ days ago
//   pnpm investor-domains -- --limit 2000 --skip-people    # leave bare person-shaped names for later
//   pnpm investor-domains -- --no-logos              # domains only
//   pnpm investor-domains -- --logos-only            # only the logo reads for investors that have a domain
// Fixing bad rows (ids are the investor page's slug, /investors/<id>; comma-separated, quote ids with spaces):
//   pnpm investor-domains -- --clear hsr,archetype        # domain and logo back to null, no search, not re-searched on its own
//   pnpm investor-domains -- --recheck hsr,archetype      # a fresh search for these ids, the new answer replaces the old
// The dry run reads the store and makes no Firecrawl call, so it needs no API key; --clear never calls Firecrawl.

import { closeDb } from "@fireround/core/db";
import { openStore } from "../lib/db.ts";
import { getFirecrawl } from "../lib/firecrawl.ts";
import {
  clearInvestorDomains,
  fetchInvestorLogos,
  type InvestorLogoOutcome,
  pendingInvestorDomains,
  pendingInvestorLogos,
  planInvestorDomains,
  planInvestorLogos,
  resolveInvestorDomains,
} from "../lib/investor-enrich.ts";
import { invalidateScriptEntityPages } from "../lib/script-cache-invalidation.ts";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function ids(flag: string): string[] {
  return arg(flag, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const limit = Number(arg("--limit", "50"));
const retry = arg("--retry-days", "");
const retryAfterDays = retry ? Number(retry) : undefined;
const dryRun = process.argv.includes("--dry-run");
const skipPeople = process.argv.includes("--skip-people");
const noLogos = process.argv.includes("--no-logos");
const logosOnly = process.argv.includes("--logos-only");
const clear = ids("--clear");
const recheck = ids("--recheck");

if (noLogos && logosOnly) {
  console.error("--no-logos and --logos-only together leave nothing to do");
  process.exit(1);
}

const handle = await openStore();

if (clear.length > 0) {
  const before = await clearInvestorDomains(handle, clear);
  for (const r of before) console.log(`cleared ${r.id} (${r.name}): ${r.domain ?? "no domain"} -> null`);
  const missing = clear.filter((id) => !before.some((r) => r.id === id));
  if (missing.length > 0) console.log(`no investor with id: ${missing.join(", ")}`);
  await invalidateScriptEntityPages();
  await closeDb();
  process.exit(0);
}

// A recheck searches exactly the ids given, whatever they hold now, and reads only their logos.
const query = recheck.length > 0 ? { ids: recheck, force: true, limit: recheck.length } : { limit, retryAfterDays, skipPeople };
const logoQuery = recheck.length > 0 ? { ids: recheck, limit: recheck.length } : { limit };
const domains = logosOnly ? null : planInvestorDomains(await pendingInvestorDomains(handle, query));
const backlog = noLogos ? null : planInvestorLogos(await pendingInvestorLogos(handle, logoQuery));

let ceiling = 0;
let expected = 0;
if (domains) {
  const scope =
    recheck.length > 0
      ? `${domains.investors} investors to recheck`
      : `${domains.investors} investors without a domain${retryAfterDays !== undefined ? ` (misses older than ${retryAfterDays} days included)` : ""}` +
        `${skipPeople ? ", person-shaped names left for later" : ""}`;
  console.log(
    `${scope}: ${domains.searches} to resolve (${domains.people} of them person-shaped names, mostly angels), ` +
      `${domains.skipped} people or placeholders with nothing to search for; ` +
      `about ${domains.credits} credits (a search and a homepage verdict each, the logo included), ${domains.maxCredits} at most`,
  );
  ceiling += domains.maxCredits;
  expected += domains.credits;
}
if (backlog) {
  console.log(
    `${backlog.investors} investors with a domain and no logo read yet: ${backlog.scrapes} branding scrapes, ${backlog.credits} credits`,
  );
  ceiling += backlog.credits;
  expected += backlog.credits;
}
console.log(`total: about ${expected} credits, ${ceiling} at most`);

if (dryRun) {
  await invalidateScriptEntityPages();
  await closeDb();
  process.exit(0);
}

const fmt = (s: string, n: number) => s.padEnd(n).slice(0, n);
const printLogos = (outcomes: InvestorLogoOutcome[]) => {
  for (const o of outcomes)
    console.log(`${fmt(o.name, 36)} ${fmt(`logo ${o.outcome}`, 11)} ${fmt(o.domain, 26)} ${o.logo_url ?? o.detail ?? ""}`);
};
const client = getFirecrawl();
let spent = 0;

if (!logosOnly) {
  const r = await resolveInvestorDomains(handle, client, { ...query, logos: !noLogos });
  console.log(`\n${fmt("investor", 36)} ${fmt("outcome", 11)} ${fmt("domain", 26)} detail`);
  for (const o of r.outcomes) console.log(`${fmt(o.name, 36)} ${fmt(o.outcome, 11)} ${fmt(o.domain ?? "", 26)} ${o.detail ?? ""}`);
  if (r.logos) printLogos(r.logos.outcomes);
  spent += r.credits + (r.logos?.credits ?? 0);
  console.log(
    `\n${r.investors} processed · ${r.searched} searched · ${r.resolved} resolved · ${r.skipped} skipped · ${r.errors} errors · ${r.credits} credits` +
      (r.logos ? `\n${r.logos.scraped} logos read · ${r.logos.found} found · ${r.logos.errors} errors · ${r.logos.credits} credits` : ""),
  );
}

if (!noLogos) {
  const l = await fetchInvestorLogos(handle, client, logoQuery);
  if (l.outcomes.length > 0) {
    console.log("\nbacklog logos");
    printLogos(l.outcomes);
  }
  spent += l.credits;
  console.log(
    `\n${l.investors} backlog investors · ${l.scraped} logos read · ${l.found} found · ${l.errors} errors · ${l.credits} credits`,
  );
}

console.log(`\n${spent} credits in all`);
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);
