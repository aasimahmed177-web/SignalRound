// Rounds whose pages name a lead or an investor the row lost to one of two mistakes since fixed:
//   - a lead marker that described its firms in two kinds ("led by a handful of hedge funds and P/E
//     firms including Park West, Franklin Templeton, ...") read every firm it named as a participant:
//     a linked participant such a paragraph names after "including" is raised to lead;
//   - a later page on a round, read and confirmed alone, replaced the investors the round's other
//     pages named (Impulse Space's Series C lost Linse Capital and every participant): on a round whose
//     last verdict read fewer pages than the round links, a firm another page's reading gave this round,
//     which that page names as investing and the last-read page does not name at all, comes back with
//     the role that page states. A firm the last-read page names was left off on purpose and stays off.
// Nothing is removed. Reads the store only.

import {
  cleanRound,
  type ExtractedRound,
  investorKeyForMerge,
  investorMentions,
  leadOfAnotherRound,
  normalizeCompanyKey,
  parseAmount,
  type SourceText,
  type Stage,
  samePageKey,
  statedLeads,
  statedRole,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { eq, sql } from "drizzle-orm";
import { planRoundInvestors, syncRoundInvestors } from "./persist.ts";

const { investors, roundInvestors } = schema;

interface Linked {
  name: string;
  role: string;
}

export interface LeadFlagFix {
  roundId: string;
  company: string;
  from: { leads: string[]; participants: string[] };
  to: { leads: string[]; participants: string[] };
  raised: string[];
  added: Array<{ name: string; role: "lead" | "participant"; page: string }>;
}

const BATCH = 200;
/** A lead marker whose firms are described in two kinds before "including": "led by hedge funds and P/E firms including". */
const DESCRIBED_IN_TWO_KINDS = /\b(?:co-)?led\s+by\s+((?:(?:[a-z][\w-]*|[A-Z]{1,3}\/[A-Z]{1,3})\s+)+)including\s/g;

/** Whether a paragraph on the pages states the firm as a lead from a marker DESCRIBED_IN_TWO_KINDS matches onward. */
function ledAmongTwoKinds(name: string, pages: SourceText[]): boolean {
  return pages.some((p) =>
    p.markdown
      .split(/\n+/)
      .some((paragraph) =>
        [...paragraph.matchAll(DESCRIBED_IN_TWO_KINDS)].some(
          (m) => /\b(?:and|or)\b|\//.test(m[1] ?? "") && statedRole(name, [paragraph.slice(m.index)]) === "lead",
        ),
      ),
  );
}

function sameAmount(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = parseAmount(a);
  const y = parseAmount(b);
  return x.value !== null && y.value !== null && x.currency === y.currency && Math.abs(x.value - y.value) <= 0.005 * y.value;
}

function lists(linked: Linked[]): { leads: string[]; participants: string[] } {
  return {
    leads: linked.filter((l) => l.role === "lead").map((l) => l.name),
    participants: linked.filter((l) => l.role !== "lead").map((l) => l.name),
  };
}

/** The fixes, in round order; `ids` limits the plan to those rounds. */
export async function planLeadFlagRepair(handle: Db, ids?: string[]): Promise<LeadFlagFix[]> {
  const fixes: LeadFlagFix[] = [];
  for (let after = ""; ; ) {
    const res = await handle.execute<{
      id: string;
      company: string;
      stage: Stage;
      stage_as_written: string | null;
      amount: string | null;
      verified: { url: string | null; read: number } | null;
      linked: Linked[] | null;
      pages: Array<{
        url: string;
        host: string;
        title: string | null;
        markdown: string;
        extraction: { rounds?: ExtractedRound[] } | null;
      }> | null;
    }>(sql`
      select r.id, c.name as company, r.stage, r.stage_as_written, r.amount_as_written as amount,
        case when r.verification->>'status' in ('confirmed', 'corrected')
          then json_build_object('url', r.verification->>'url', 'read', (r.verification->>'sources_listed')::int) end as verified,
        (select json_agg(json_build_object('name', i.name, 'role', ri.role) order by ri.role, i.name)
           from round_investors ri join investors i on i.id = ri.investor_id where ri.round_id = r.id) as linked,
        (select json_agg(json_build_object('url', s.url, 'host', s.host, 'title', s.title, 'markdown', p.markdown, 'extraction', p.extraction) order by s.url)
           from round_sources rs join sources s on s.id = rs.source_id
           cross join lateral (
             select ps.markdown, psr.raw_extraction as extraction from page_snapshot_reads psr
             join page_snapshots ps on ps.hash = psr.snapshot_hash
             where psr.source_url in (s.url, s.url || '/') order by psr.read_at desc limit 1
           ) p
           where rs.round_id = r.id) as pages
      from funding_rounds r join companies c on c.id = r.company_id
      where r.disposition <> 'rejected' and r.id > ${after}
        ${
          ids
            ? sql`and r.id in (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `,
              )})`
            : sql``
        }
      order by r.id limit ${BATCH}`);
    for (const r of res.rows) {
      const pages: SourceText[] = (r.pages ?? []).map((p) => ({
        url: p.url,
        host: p.host,
        title: p.title ?? undefined,
        markdown: p.markdown,
      }));
      if (pages.length === 0) continue;
      const linked = r.linked ?? [];
      const round = { stage: r.stage, stage_as_written: r.stage_as_written, amount_as_written: r.amount };
      const raised = linked.filter((l) => l.role !== "lead" && ledAmongTwoKinds(l.name, pages)).map((l) => l.name);
      const added: LeadFlagFix["added"] = [];
      const lastRead =
        r.verified && r.verified.read < pages.length
          ? pages.find((p) => samePageKey(p.url) === samePageKey(r.verified?.url ?? ""))
          : undefined;
      if (lastRead && r.amount) {
        const has = new Set(linked.map((l) => investorKeyForMerge(l.name)));
        for (const p of r.pages ?? []) {
          if (p.url === lastRead.url) continue;
          const page = pages.find((x) => x.url === p.url) as SourceText;
          const text = `${page.title ?? ""}\n${page.markdown}`;
          for (const x of p.extraction?.rounds ?? []) {
            if (normalizeCompanyKey(x.company_name ?? "") !== normalizeCompanyKey(r.company) || !sameAmount(x.amount_as_written, r.amount))
              continue;
            const read = cleanRound(x);
            for (const name of [...read.lead_investors, ...read.other_investors]) {
              const key = investorKeyForMerge(name);
              if (!key || has.has(key) || statedRole(name, [text]) === "unattributed") continue;
              if (investorMentions(`${lastRead.title ?? ""}\n${lastRead.markdown}`)(name)) continue;
              has.add(key);
              const lead =
                read.lead_investors.includes(name) &&
                statedLeads([{ name, source: p.url }], pages, round).leads.length > 0 &&
                !leadOfAnotherRound(text, name, round);
              added.push({ name, role: lead ? "lead" : "participant", page: p.url });
            }
          }
        }
      }
      if (raised.length === 0 && added.length === 0) continue;
      const set = planRoundInvestors(
        linked,
        [...raised, ...added.filter((a) => a.role === "lead").map((a) => a.name)],
        added.filter((a) => a.role === "participant").map((a) => a.name),
      );
      const from = lists(linked);
      const to = { leads: set.lead_investors, participants: set.other_investors };
      const shown = new Set([...to.leads, ...to.participants]);
      const kept = added.filter((a) => shown.has(a.name) && !linked.some((l) => l.name === a.name));
      if (raised.length === 0 && kept.length === 0) continue;
      fixes.push({ roundId: r.id, company: r.company, from, to, raised, added: kept });
    }
    if (res.rows.length < BATCH) break;
    after = res.rows[res.rows.length - 1]?.id ?? after;
  }
  return fixes;
}

/**
 * Write the fixes, each in its own transaction after re-reading the round's links: a round whose links
 * changed since the plan was read is skipped and returned as stale.
 */
export async function applyLeadFlagRepair(handle: Db, fixes: LeadFlagFix[]): Promise<{ applied: string[]; stale: string[] }> {
  const applied: string[] = [];
  const stale: string[] = [];
  for (const f of fixes) {
    const done = await handle.transaction(async (tx) => {
      const now = await tx
        .select({ name: investors.name, role: roundInvestors.role })
        .from(roundInvestors)
        .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
        .where(eq(roundInvestors.roundId, f.roundId))
        .orderBy(roundInvestors.role, investors.name);
      if (JSON.stringify(lists(now)) !== JSON.stringify(f.from)) return false;
      await syncRoundInvestors(tx as unknown as Db, f.roundId, f.to.leads, f.to.participants);
      return true;
    });
    (done ? applied : stale).push(f.roundId);
  }
  return { applied, stale };
}
