// Published rounds with no valuation whose own linked pages state one for this round: the page's reading
// of the round (same company, same amount) gave a valuation, and a sentence on the page states that
// figure as this round's valuation by today's check (valuationSupport). Most were ruled out by an older,
// stricter check, held for review, and published by hand without it. Each becomes a "valuation" record fix
// (lib/repair.ts): the figure as its sentence qualifies it ("$2.6 billion post-money", "£1.1 billion
// pre-money"), with the sentence and the page. A round whose pages say the valuation was not disclosed,
// or whose valuation a person pinned, is left alone. Reads the store only.

import {
  amountInEvidence,
  type ExtractedRound,
  isFundingAggregatorUrl,
  namedNearby,
  normalizeCompanyKey,
  parseAmount,
  type Stage,
  valuationSupport,
  withBasis,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { sql } from "drizzle-orm";
import type { RecordFix } from "./repair.ts";

export type ValuationFix = Extract<RecordFix, { kind: "valuation" }> & { company: string; amount: string };

function sameAmount(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = parseAmount(a);
  const y = parseAmount(b);
  return x.value !== null && y.value !== null && x.currency === y.currency && Math.abs(x.value - y.value) <= 0.01 * y.value;
}

/** The page's sentences, links read as their text. */
function sentences(markdown: string): string[] {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>]/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** The fixes, in round order; `ids` limits the plan to those rounds. */
export async function planValuationRepair(handle: Db, ids?: string[]): Promise<ValuationFix[]> {
  const res = await handle.execute<{
    id: string;
    company: string;
    stage: Stage;
    amount: string;
    announced: string | null;
    total: string | null;
    pages: Array<{ url: string; title: string | null; markdown: string; extraction: { rounds?: ExtractedRound[] } | null }> | null;
  }>(sql`
    select r.id, c.name as company, r.stage, r.amount_as_written as amount, r.announced_on::text as announced,
      r.financing_total_as_written as total,
      (select json_agg(json_build_object('url', s.url, 'title', s.title, 'markdown', p.markdown, 'extraction', p.extraction) order by s.url)
         from round_sources rs join sources s on s.id = rs.source_id
         cross join lateral (
           select ps.markdown, psr.raw_extraction as extraction from page_snapshot_reads psr
           join page_snapshots ps on ps.hash = psr.snapshot_hash
           where psr.source_url in (s.url, s.url || '/') and psr.raw_extraction is not null
           order by psr.read_at desc limit 1
         ) p
         where rs.round_id = r.id) as pages
    from funding_rounds r join companies c on c.id = r.company_id
    where r.disposition = 'publish' and r.valuation_as_written is null and r.amount_as_written is not null
      and r.valuation_disclosed is not false and not coalesce(r.pinned ? 'valuation', false)
      ${
        ids
          ? sql`and r.id in (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``
      }
    order by r.id`);
  const fixes: ValuationFix[] = [];
  for (const r of res.rows) {
    const amount = parseAmount(r.amount).value;
    const context = { company: r.company, stage: r.stage, amount, announced: r.announced, total: parseAmount(r.total).value };
    let found: ValuationFix | null = null;
    for (const p of r.pages ?? []) {
      if (found || isFundingAggregatorUrl(p.url)) continue;
      const read = (p.extraction?.rounds ?? []).find(
        (x) =>
          normalizeCompanyKey(x.company_name ?? "") === normalizeCompanyKey(r.company) &&
          sameAmount(x.amount_as_written, r.amount) &&
          x.valuation_as_written,
      );
      const value = read?.valuation_as_written;
      if (!value) continue;
      const stating = [p.title ?? "", ...sentences(p.markdown)].filter(
        (s) =>
          amountInEvidence(value, s) &&
          valuationSupport(value, s, { ...context, named: namedNearby(s, p.markdown, p.title, r.company) }) === null,
      );
      // A sentence that says pre- or post-money says which valuation it is; a headline seldom does.
      const quote = stating.find((s) => withBasis(value, s) !== value) ?? stating[0];
      if (!quote) continue;
      found = {
        kind: "valuation",
        round: r.id,
        from: null,
        valuation: withBasis(value, quote),
        evidence: p.url,
        quote,
        note: "the round's own linked page states this valuation for the round",
        company: r.company,
        amount: r.amount,
      };
    }
    if (found) fixes.push(found);
  }
  return fixes;
}
