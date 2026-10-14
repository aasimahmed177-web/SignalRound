// Rounds whose one linked investor is stored as a participant while the round's pages state the whole
// round's money as coming from it ("a $150 million investment with PSG", "$13 million in Series A
// funding from venture capital firm Index Ventures"): such a firm is the round's lead (soleInvestor).
// A round with two or more linked investors, or with a lead already, is left alone. Reads the store only.

import { soleInvestor } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, sql } from "drizzle-orm";

const { roundInvestors } = schema;

export interface SoleLeadFix {
  roundId: string;
  company: string;
  investorId: string;
  investor: string;
  amount: string;
  page: string;
}

/** The fixes, in round order; `ids` limits the plan to those rounds. */
export async function planSoleLeadRepair(handle: Db, ids?: string[]): Promise<SoleLeadFix[]> {
  const res = await handle.execute<{
    id: string;
    company: string;
    amount: string;
    investor_id: string;
    investor: string;
    pages: Array<{ url: string; title: string | null; markdown: string }> | null;
  }>(sql`
    select r.id, c.name as company, r.amount_as_written as amount, i.id as investor_id, i.name as investor,
      (select json_agg(json_build_object('url', s.url, 'title', s.title, 'markdown', p.markdown) order by s.url)
         from round_sources rs join sources s on s.id = rs.source_id
         cross join lateral (
           select ps.markdown from page_snapshot_reads psr join page_snapshots ps on ps.hash = psr.snapshot_hash
           where psr.source_url in (s.url, s.url || '/') order by psr.read_at desc limit 1
         ) p
         where rs.round_id = r.id) as pages
    from funding_rounds r
    join companies c on c.id = r.company_id
    join round_investors ri on ri.round_id = r.id and ri.role <> 'lead'
    join investors i on i.id = ri.investor_id
    where r.disposition <> 'rejected' and r.amount_as_written is not null
      and (select count(*) from round_investors x where x.round_id = r.id) = 1
      ${
        ids
          ? sql`and r.id in (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``
      }
    order by r.id`);
  return res.rows.flatMap((r) => {
    const page = (r.pages ?? []).find((p) => soleInvestor(r.investor, [`${p.title ?? ""}\n${p.markdown}`], r.amount));
    return page
      ? [{ roundId: r.id, company: r.company, investorId: r.investor_id, investor: r.investor, amount: r.amount, page: page.url }]
      : [];
  });
}

/**
 * Raise each fix's investor to lead, in its own transaction after re-reading the round's links: a round
 * whose links are no longer that one participant is skipped and returned as stale.
 */
export async function applySoleLeadRepair(handle: Db, fixes: SoleLeadFix[]): Promise<{ applied: string[]; stale: string[] }> {
  const applied: string[] = [];
  const stale: string[] = [];
  for (const f of fixes) {
    const done = await handle.transaction(async (tx) => {
      const now = await tx
        .select({ investorId: roundInvestors.investorId, role: roundInvestors.role })
        .from(roundInvestors)
        .where(eq(roundInvestors.roundId, f.roundId));
      if (now.length !== 1 || now[0]?.investorId !== f.investorId || now[0]?.role === "lead") return false;
      await tx
        .update(roundInvestors)
        .set({ role: "lead" })
        .where(and(eq(roundInvestors.roundId, f.roundId), eq(roundInvestors.investorId, f.investorId)));
      return true;
    });
    (done ? applied : stale).push(f.roundId);
  }
  return { applied, stale };
}
