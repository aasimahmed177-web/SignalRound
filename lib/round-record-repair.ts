// The round-record repair behind `pnpm repair-round-records`: today's rules for a round's record,
// applied to rows stored before them. Every step but two reads only the store:
//   - a namesake hold the company's own site has since settled lifts (lib/persist.ts lifts it on a new
//     reading; a row no reading reached kept it, as Firecrawl's Series A did);
//   - an investor first seen by its short name shows the fuller spelling its rounds' pages use;
//   - a round whose pages say the valuation was not disclosed records that;
//   - a round's audit fingerprint written under a company id since renamed moves to the new id.
// The two that read the web (Firecrawl credits, no model key): a published round's announcement on
// the company's site or a newswire (lib/primary-source.ts), and a verified homepage's own one-line
// description (siteOneLiner).

import type { Enrichment } from "@fireround/core";
import { acceptableSiteLine, siteOneLiner, thinDescription, titleNamesCompany } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { fullerNameIn } from "./investor-names.ts";
import { listRounds, type PreviousRound, type RoundRow } from "./persist.ts";
import { findPrimarySource, needsPrimarySource, type PrimarySourceOutcome } from "./primary-source.ts";
import { orderSources, primarySourceOf, sourceKind } from "./source-order.ts";
import { undisclosedSentence } from "./valuation-disclosure.ts";

const { fundingRounds, roundSources, investors, roundInvestors, companies, enrichments } = schema;

export const IDENTITY_HOLD = "held for review: same-name company identity is unverified";

export interface HoldLift {
  roundId: string;
  company: string;
  ownPage: string;
  /** Where the row goes: publish when nothing else holds it and its read-back passed, else it stays in review without the note. */
  to: "publish" | "review";
}

export interface NameExpansion {
  investorId: string;
  from: string;
  to: string;
  roundId: string;
}

export interface Undisclosed {
  roundId: string;
  company: string;
  quote: string;
}

export interface Description {
  companyId: string;
  from: string | null;
  to: string;
}

export interface RepairPlan {
  holds: HoldLift[];
  names: NameExpansion[];
  undisclosed: Undisclosed[];
  fingerprints: number;
  primary: PrimarySourceOutcome[];
  descriptions: Description[];
  creditsEstimated: number;
}

interface RoundText {
  text: string;
  /** The page's title, when the text is a page's: a page about the round speaks of "the round" without naming it. */
  title?: string | null;
  url?: string;
}

/** Each round's text the store keeps: its evidence, each link's sentence and title, and the pages read for it. */
async function roundTexts(handle: Db, roundIds: string[]): Promise<Map<string, RoundText[]>> {
  const out = new Map<string, RoundText[]>();
  if (roundIds.length === 0) return out;
  const add = (id: string, text: string | null | undefined, title?: string | null, url?: string) => {
    if (text) out.set(id, [...(out.get(id) ?? []), { text, title, url }]);
  };
  for (let i = 0; i < roundIds.length; i += 100) {
    const ids = roundIds.slice(i, i + 100);
    const [rows, links, pages] = await Promise.all([
      handle
        .select({ id: fundingRounds.id, evidence: fundingRounds.evidenceQuotes })
        .from(fundingRounds)
        .where(inArray(fundingRounds.id, ids)),
      handle
        .select({ id: roundSources.roundId, claims: roundSources.fieldClaims })
        .from(roundSources)
        .where(inArray(roundSources.roundId, ids)),
      handle.execute<{ id: string; markdown: string; title: string | null; url: string }>(sql`
        select rs.round_id as id, p.markdown, s.title, s.url
        from round_sources rs
        join sources s on s.id = rs.source_id
        join page_snapshot_reads r on r.source_url = s.url
        join page_snapshots p on p.hash = r.snapshot_hash
        where rs.round_id in ${ids}`),
    ]);
    for (const r of rows) for (const q of r.evidence) add(r.id, q);
    for (const l of links) {
      const c = l.claims as { evidence?: string | null; title?: string | null } | null;
      add(l.id, c?.evidence, c?.title);
      add(l.id, c?.title);
    }
    for (const p of pages.rows) add(p.id, p.markdown, p.title, p.url);
  }
  return out;
}

/** Namesake holds a page on the company's own site (its domain or one it is known by) has settled. */
export async function planHoldLifts(handle: Db): Promise<HoldLift[]> {
  const res = await handle.execute<{
    id: string;
    company: string;
    url: string;
    status: string | null;
    notes: string[] | null;
    confidence: string;
    amount: string | null;
  }>(sql`
    select distinct on (r.id) r.id, c.name as company, s.url, r.verification->>'status' as status,
      (select array_agg(n) from jsonb_array_elements_text(coalesce(r.verification->'notes', '[]'::jsonb)) n) as notes,
      r.confidence, r.amount_as_written as amount
    from funding_rounds r
    join companies c on c.id = r.company_id
    join round_sources rs on rs.round_id = r.id
    join sources s on s.id = rs.source_id
    where r.disposition = 'review' and r.hold is null
      and r.verification->'notes' ? ${IDENTITY_HOLD}
      and (s.host = c.domain or s.host like '%.' || c.domain
        or exists (select 1 from company_aliases a where a.company_id = c.id and a.kind = 'domain' and (s.host = a.alias_key or s.host like '%.' || a.alias_key)))
    order by r.id, s.url`);
  return res.rows.map((r) => {
    const others = (r.notes ?? []).filter((n) => n.startsWith("held for review:") && n !== IDENTITY_HOLD);
    const passed = (r.status === "confirmed" || r.status === "corrected") && Number(r.confidence) >= 0.75 && Boolean(r.amount);
    return { roundId: r.id, company: r.company, ownPage: r.url, to: others.length === 0 && passed ? "publish" : "review" };
  });
}

/**
 * Investors on these rounds whose shown name a fuller spelling in their rounds' own text replaces, when
 * the investor's own domain confirms that spelling (lib/investor-names.ts); one per investor.
 */
export async function planNameExpansions(handle: Db, roundIds: string[]): Promise<NameExpansion[]> {
  if (roundIds.length === 0) return [];
  const links = await handle
    .select({ roundId: roundInvestors.roundId, investorId: investors.id, name: investors.name, domain: investors.domain })
    .from(roundInvestors)
    .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
    .where(inArray(roundInvestors.roundId, roundIds));
  const texts = await roundTexts(handle, [...new Set(links.map((l) => l.roundId))]);
  const byInvestor = new Map<string, NameExpansion[]>();
  for (const l of links) {
    const fuller = fullerNameIn(
      l.name,
      (texts.get(l.roundId) ?? []).map((t) => t.text),
      l.domain,
    );
    if (fuller)
      byInvestor.set(l.investorId, [
        ...(byInvestor.get(l.investorId) ?? []),
        { investorId: l.investorId, from: l.name, to: fuller, roundId: l.roundId },
      ]);
  }
  // Rounds that disagree on the confirmed spelling leave the name as it is.
  return [...byInvestor.values()].flatMap((list) => (new Set(list.map((e) => e.to)).size === 1 && list[0] ? [list[0]] : []));
}

/** How many of a round's pages the web step reads for a withheld valuation, when the store's text says nothing. */
const VALUATION_PAGES = 2;

/**
 * Rounds with no valuation whose own text says it was not disclosed, and the sentence that says so.
 * With a client, a round the store's text is silent on has up to two of its write-ups read (one credit
 * each): pages the store has no copy of, about this round by their title, an established outlet's first.
 */
export async function planUndisclosed(
  handle: Db,
  rows: Pick<RoundRow, "id" | "company" | "stage" | "valuation_as_written" | "valuation_disclosed" | "sources">[],
  client?: Firecrawl | null,
): Promise<{ list: Undisclosed[]; credits: number }> {
  const open = rows.filter((r) => !r.valuation_as_written && r.valuation_disclosed === null);
  const texts = await roundTexts(
    handle,
    open.map((r) => r.id),
  );
  const list: Undisclosed[] = [];
  let credits = 0;
  for (const r of open) {
    const stored = texts.get(r.id) ?? [];
    let quote = stored.map((t) => undisclosedSentence(t.text, r.company.name, t.title, r.stage)).find((q) => q !== null) ?? null;
    if (!quote && client) {
      const read = new Set(stored.flatMap((t) => (t.url ? [t.url] : [])));
      const pages = r.sources
        .filter((s) => !read.has(s.url) && titleNamesCompany(s.title, r.company.name))
        .filter((s) => sourceKind(s.url, [r.company.domain ?? ""]) !== "company")
        .slice(0, VALUATION_PAGES);
      for (const page of pages) {
        try {
          const doc = await client.scrape(page.url, { formats: ["markdown"], onlyMainContent: true, timeout: 30_000 });
          credits += 1;
          quote = undisclosedSentence(doc.markdown ?? "", r.company.name, page.title, r.stage);
        } catch {}
        if (quote) break;
      }
    }
    if (quote) list.push({ roundId: r.id, company: r.company.name, quote: quote.slice(0, 300) });
  }
  return { list, credits };
}

/** Rounds whose passed audit was fingerprinted under a company id since renamed (lib/company-ids.ts). */
export async function countStaleFingerprints(handle: Db): Promise<number> {
  const res = await handle.execute<{ n: number }>(sql`
    select count(*)::int as n from funding_rounds r join company_folds f on f.renamed and f.into_id = r.company_id
    where r.audit_facts is not null and r.audit_facts = round_audit_facts_as(r, f.from_id)`);
  return Number(res.rows[0]?.n ?? 0);
}

/** A verified homepage's own line, read again (one credit a company) for companies whose profile predates it. */
async function planDescriptions(handle: Db, client: Firecrawl, companyIds: string[]): Promise<{ list: Description[]; credits: number }> {
  if (companyIds.length === 0) return { list: [], credits: 0 };
  const rows = await handle
    .select({ id: companies.id, name: companies.name, description: companies.description, data: enrichments.data })
    .from(companies)
    .innerJoin(enrichments, and(eq(enrichments.companyId, companies.id), eq(enrichments.kind, "profile")))
    .where(inArray(companies.id, companyIds));
  const list: Description[] = [];
  let credits = 0;
  for (const r of rows) {
    const e = r.data as Partial<Enrichment>;
    if (!e.profile || !e.company_website || e.website_source === "parked" || e.website_source === "unverified") continue;
    let line = e.site_description ?? null;
    if (line === null && !("site_description" in e)) {
      try {
        const home = await client.scrape(e.company_website, { formats: ["markdown"], onlyMainContent: true, timeout: 30_000 });
        credits += 1;
        line = siteOneLiner(home.metadata as Parameters<typeof siteOneLiner>[0], r.name);
      } catch {
        continue;
      }
    }
    // A line stored under an earlier, looser rule is held to today's.
    if (line && acceptableSiteLine(line, r.name) && line !== r.description && thinDescription(r.description))
      list.push({ companyId: r.id, from: r.description, to: line });
  }
  return { list, credits };
}

export interface PlanOptions {
  /** Round ids to plan for; every published round when absent. */
  ids?: string[];
  limit?: number;
  /** Run the two steps that read the web (Firecrawl credits). */
  client?: Firecrawl | null;
  tiers?: Record<string, number>;
}

/** The published rounds the repair works on, read with today's code. */
export async function repairRows(handle: Db, opts: Pick<PlanOptions, "ids" | "limit">): Promise<RoundRow[]> {
  const ids =
    opts.ids ??
    (
      await handle
        .select({ id: fundingRounds.id })
        .from(fundingRounds)
        .where(inArray(fundingRounds.disposition, ["publish", "flagged"]))
        .orderBy(sql`${fundingRounds.announcedOn} desc nulls last`, fundingRounds.id)
        .limit(opts.limit ?? 100_000)
    ).map((r) => r.id);
  const out: RoundRow[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    out.push(...(await listRounds(handle, { ids: chunk, limit: chunk.length, includeReview: true, certainty: "all" })).rows);
  }
  return out;
}

/** Everything the repair would do, written nowhere. With a client, the web steps run read-only (their credits are spent). */
export async function planRepair(handle: Db, rows: RoundRow[], opts: PlanOptions = {}): Promise<RepairPlan> {
  const ids = rows.map((r) => r.id);
  const [holds, names, undisclosed, fingerprints] = await Promise.all([
    planHoldLifts(handle),
    planNameExpansions(handle, ids),
    planUndisclosed(handle, rows, opts.client),
    countStaleFingerprints(handle),
  ]);
  const plan: RepairPlan = {
    holds,
    names,
    undisclosed: undisclosed.list,
    fingerprints,
    primary: [],
    descriptions: [],
    creditsEstimated: undisclosed.credits,
  };
  if (!opts.client) return plan;
  for (const row of rows.filter(needsPrimarySource)) {
    const outcome = await findPrimarySource(handle, opts.client, row, { apply: false, tiers: opts.tiers });
    plan.primary.push(outcome);
    plan.creditsEstimated += outcome.creditsEstimated;
  }
  const described = await planDescriptions(handle, opts.client, [...new Set(rows.map((r) => r.company.id))]);
  plan.descriptions = described.list;
  plan.creditsEstimated += described.credits;
  return plan;
}

/** Every row the plan would touch, for the backup taken before writing. */
export async function repairBackup(handle: Db, plan: RepairPlan): Promise<Record<string, unknown[]>> {
  const roundIds = [
    ...new Set([
      ...plan.holds.map((h) => h.roundId),
      ...plan.undisclosed.map((u) => u.roundId),
      ...plan.primary.filter((p) => p.confirmed).map((p) => p.roundId),
    ]),
  ];
  const investorIds = plan.names.map((n) => n.investorId);
  const companyIds = plan.descriptions.map((d) => d.companyId);
  const [rounds, links, inv, comps, profiles, renamed] = await Promise.all([
    roundIds.length ? handle.select().from(fundingRounds).where(inArray(fundingRounds.id, roundIds)) : [],
    roundIds.length ? handle.select().from(roundSources).where(inArray(roundSources.roundId, roundIds)) : [],
    investorIds.length ? handle.select().from(investors).where(inArray(investors.id, investorIds)) : [],
    companyIds.length ? handle.select().from(companies).where(inArray(companies.id, companyIds)) : [],
    companyIds.length
      ? handle
          .select()
          .from(enrichments)
          .where(and(inArray(enrichments.companyId, companyIds), eq(enrichments.kind, "profile")))
      : [],
    handle.execute(sql`
      select r.id, r.audit_facts from funding_rounds r join company_folds f on f.renamed and f.into_id = r.company_id
      where r.audit_facts is not null and r.audit_facts = round_audit_facts_as(r, f.from_id)`),
  ]);
  return {
    funding_rounds: rounds,
    round_sources: links,
    investors: inv,
    companies: comps,
    enrichments: profiles,
    audit_fingerprints: renamed.rows,
  };
}

/** Carry the plan out. The web steps attach what their read-only pass confirmed, reading the page again (its credits again). */
export async function applyRepair(
  handle: Db,
  plan: RepairPlan,
  opts: { client?: Firecrawl | null; tiers?: Record<string, number> } = {},
): Promise<Record<string, number>> {
  const done = { holds: 0, names: 0, undisclosed: 0, fingerprints: 0, primary: 0, descriptions: 0 };
  for (const h of plan.holds) {
    const lifted = await handle
      .update(fundingRounds)
      .set({
        verification: sql`jsonb_set(${fundingRounds.verification}, '{notes}', (select coalesce(jsonb_agg(n), '[]'::jsonb) from jsonb_array_elements(${fundingRounds.verification}->'notes') n where n #>> '{}' <> ${IDENTITY_HOLD}))`,
        ...(h.to === "publish" ? { disposition: "publish" as const } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(fundingRounds.id, h.roundId),
          eq(fundingRounds.disposition, "review"),
          sql`${fundingRounds.verification}->'notes' ? ${IDENTITY_HOLD}`,
        ),
      )
      .returning({ id: fundingRounds.id });
    done.holds += lifted.length;
  }
  for (const n of plan.names) {
    const renamed = await handle
      .update(investors)
      .set({ name: n.to })
      .where(and(eq(investors.id, n.investorId), eq(investors.name, n.from)))
      .returning({ id: investors.id });
    done.names += renamed.length;
  }
  for (const u of plan.undisclosed) {
    const set = await handle
      .update(fundingRounds)
      .set({ valuationDisclosed: false })
      .where(and(eq(fundingRounds.id, u.roundId), sql`${fundingRounds.valuationAsWritten} is null`))
      .returning({ id: fundingRounds.id });
    done.undisclosed += set.length;
  }
  const fingerprints = await handle.execute(sql`
    update funding_rounds r set audit_facts = round_audit_facts(r) from company_folds f
    where f.renamed and f.into_id = r.company_id and r.audit_facts is not null and r.audit_facts = round_audit_facts_as(r, f.from_id)`);
  done.fingerprints = Number((fingerprints as { rowCount?: number }).rowCount ?? 0);
  for (const d of plan.descriptions) {
    await handle.execute(
      sql`update enrichments set data = jsonb_set(data, '{site_description}', to_jsonb(${d.to}::text)) where company_id = ${d.companyId} and kind = 'profile'`,
    );
    const set = await handle
      .update(companies)
      .set({ description: d.to, updatedAt: new Date() })
      .where(
        and(eq(companies.id, d.companyId), d.from === null ? sql`${companies.description} is null` : eq(companies.description, d.from)),
      )
      .returning({ id: companies.id });
    done.descriptions += set.length;
  }
  if (opts.client) {
    const confirmed = plan.primary.filter((p) => p.confirmed).map((p) => p.roundId);
    for (const row of confirmed.length ? await repairRows(handle, { ids: confirmed }) : []) {
      if (!needsPrimarySource(row)) continue;
      const outcome = await findPrimarySource(handle, opts.client, row, { apply: true, tiers: opts.tiers });
      if (outcome.attached) done.primary++;
    }
  }
  return done;
}

/**
 * A round as it would read once the plan is applied: the confirmed announcement among its sources and
 * first, the fuller investor names, the valuation's disclosure, the company's own line, and the
 * earlier rounds a lifted hold makes visible. For the dry run's before and after; nothing is written.
 */
export function previewRow(row: RoundRow, plan: RepairPlan, lifted: RoundRow[] = []): RoundRow {
  const names = new Map(plan.names.map((n) => [n.from, n.to]));
  const rename = (list: string[]) => list.map((n) => names.get(n) ?? n);
  const confirmed = plan.primary.find((p) => p.roundId === row.id)?.confirmed;
  const domains = [row.company.domain].filter((d): d is string => Boolean(d));
  const withPage = confirmed
    ? [
        ...row.sources,
        { url: confirmed, title: null, host: new URL(confirmed).hostname, published: row.announced_on, query: "corroborate" },
      ]
    : row.sources;
  const ordered = orderSources(withPage, domains);
  const description = plan.descriptions.find((d) => d.companyId === row.company.id)?.to;
  const earlier: PreviousRound[] = lifted
    .filter(
      (l) => l.company.id === row.company.id && l.id !== row.id && l.announced_on && row.announced_on && l.announced_on < row.announced_on,
    )
    .map((l) => ({
      id: l.id,
      stage: l.stage,
      stage_as_written: l.stage_as_written,
      amount: { as_written: l.amount.as_written, usd_millions: l.amount.usd_millions },
      announced_on: l.announced_on,
      lead_investors: rename(l.lead_investors),
      url: l.primary_source?.url ?? l.sources[0]?.url ?? null,
    }));
  return {
    ...row,
    company: description ? { ...row.company, description } : row.company,
    lead_investors: rename(row.lead_investors),
    other_investors: rename(row.other_investors),
    sources: ordered,
    primary_source: primarySourceOf(ordered, domains),
    valuation_disclosed: plan.undisclosed.some((u) => u.roundId === row.id) ? false : row.valuation_disclosed,
    previous_rounds: [...earlier, ...row.previous_rounds.map((p) => ({ ...p, lead_investors: rename(p.lead_investors) }))].sort((a, b) =>
      (b.announced_on ?? "").localeCompare(a.announced_on ?? ""),
    ),
  };
}
