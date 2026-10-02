import { corroborate, DEFAULT_TIERS } from "@fireround/core";
import { closeDb, schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { openStore } from "../../lib/db.ts";
import { staleForNews } from "../../lib/deliverable.ts";
import { getFirecrawl } from "../../lib/firecrawl.ts";
import { earliestReport } from "../../lib/freshness.ts";
import { listRounds, type RoundRow } from "../../lib/persist.ts";
import { investorDomainsForRound, storedVisibilityEvidence } from "../../lib/round-verification.ts";
import { loadPublisherTiers } from "../../lib/rules.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const apply = process.argv.includes("--apply");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Number.POSITIVE_INFINITY;
const offsetArg = process.argv.find((arg) => arg.startsWith("--offset="));
const offset = offsetArg ? Number(offsetArg.split("=")[1]) : 0;
if (!(limit > 0) || !Number.isInteger(offset) || offset < 0) throw new Error("--limit must be positive and --offset nonnegative");
const handle = await openStore();
const client = getFirecrawl();
const tiers = { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
const counts = { checked: 0, hide: 0, redate: 0, history: 0, searchErrors: 0 };
let cursor: string | undefined;

async function checkRow(row: RoundRow): Promise<void> {
  counts.checked++;
  const investorDomains = await investorDomainsForRound(handle, row.id);
  const trusted = await storedVisibilityEvidence(handle, row, investorDomains, tiers);
  let date = row.announced_on;
  let searched = false;
  if (date && !row.pinned?.announced_on) {
    try {
      const result = await corroborate(
        client,
        {
          company_name: row.company.name,
          stage_as_written: row.stage_as_written,
          stage: row.stage,
          amount_as_written: row.amount.as_written,
          announced_date: date,
          company_domain: row.company.domain,
          company_description: row.company.description,
          company_headquarters: row.company.hq,
          lead_investors: row.lead_investors,
          known_urls: row.sources.map((source) => source.url),
          date_basis: row.date_basis,
          date_precision: row.date_precision,
        },
        { broad: true, tiers, maxPages: 6 },
      );
      const earliest = earliestReport(result.readings ?? [], row.company.domain, investorDomains, tiers);
      if (earliest && earliest < date) date = earliest;
      searched = true;
    } catch {
      counts.searchErrors++;
      console.log(`${row.id}: earliest-report search failed; left unchecked`);
    }
  }
  const hide = !trusted;
  const redate = date !== row.announced_on;
  const history =
    date !== null &&
    staleForNews(date, new Date(row.first_seen_at)) &&
    (redate ||
      Boolean(row.pinned?.announced_on) ||
      (row.date_precision === "day" && ["stated", "page", "url"].includes(row.date_basis ?? "")));
  if (hide) counts.hide++;
  if (redate) counts.redate++;
  if (history) counts.history++;
  if (hide || redate || history)
    console.log(`${row.id}: ${hide ? "hide " : ""}${redate ? `re-date ${date} ` : ""}${history ? "history" : ""}`.trim());
  if (apply && (hide || redate || history || searched)) {
    const verification = row.verification ?? { status: "unverified" as const, notes: [], url: null };
    const hold =
      "held for review: source fidelity is not independent confirmation; waiting for a primary source, established publication, or independent corroboration";
    await handle
      .update(schema.fundingRounds)
      .set({
        ...(hide ? { disposition: "review" as const } : {}),
        ...(hide ? { verification: { ...verification, notes: [...new Set([...verification.notes, hold])] } } : {}),
        ...(redate && !row.pinned?.announced_on ? { announcedOn: date, datePrecision: "day", dateBasis: "stated" } : {}),
        ...(searched ? { freshnessCheckedOn: date } : {}),
        ...(history ? { history: true, status: "seen" as const } : {}),
      })
      .where(eq(schema.fundingRounds.id, row.id));
    if (hide && !history) {
      const now = new Date();
      await handle
        .insert(schema.roundVerification)
        .values({ roundId: row.id, nextAttemptAt: now })
        .onConflictDoUpdate({
          target: schema.roundVerification.roundId,
          set: { status: "pending", attempts: 0, nextAttemptAt: now, claimedBy: null },
        });
    }
  }
}

while (counts.checked < limit) {
  const page = await listRounds(handle, {
    limit: Math.min(100, limit - counts.checked),
    offset: cursor ? 0 : offset,
    cursor,
    history: "exclude",
  });
  if (!page.rows.length) break;
  for (let i = 0; i < page.rows.length; i += 10) await Promise.all(page.rows.slice(i, i + 10).map(checkRow));
  if (!page.nextCursor) break;
  cursor = page.nextCursor;
  console.log(`Progress: ${counts.checked} visible rows checked`);
}
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", offset, ...counts }));
await invalidateScriptEntityPages();
await closeDb();
