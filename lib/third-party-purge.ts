// Removes what two retired data providers (a firmographics lookup and a company-and-funding-events
// lookup) left in the store, and keeps what public pages state. planPurge reads and decides;
// applyPurge writes the plan. The script (scripts/maintenance/purge-third-party-firmographics.ts)
// backs up every row the plan touches before it applies.
//
//   - Enrichments of the retired kind go; alexandria rows lose their firmographics half and keep YC's.
//   - A company's headquarters or logo that is the provider's value goes, unless a round's evidence,
//     the YC record, or the company's own homepage states it; YC's location or the homepage's logo
//     takes its place where there is one.
//   - A checked dossier's founding year or team size that the check confirmed only from the
//     provider's facts goes, with a dropped entry saying why.
//   - Holds and verification notes that cite the retired lead source are rewritten: a hold another
//     source still supports names that source; otherwise it lifts and the row stays where it is.
//   - Ledger leads from the retired source: promoted ones keep their round and take its own facts as
//     their prior; every other one goes. Its accuracy flags and its backfill's runs go, and run
//     counts lose its keys.

import type { PriorRound } from "@fireround/core";
import { priorKey } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { companyLeads, type HoldCandidate, holdNote, lateReportLead } from "./late-report.ts";
import { type EnrichmentData, toEnrichment } from "./persist.ts";

const { accuracyFlags, companies, enrichments, fundingRounds, historyPromotions, investors, roundInvestors, runs } = schema;

/** The retired kind and origin, as the database still names them. */
const RETIRED = "apollo";
const RETIRED_RULES = ["apollo_total_gap", "apollo_missing_round"];
const RETIRED_RUN_PRESET = "apollo-backfill";
const RETIRED_COUNT_KEYS = sql.raw("array['apollo', 'apollo_matched', 'apollo_credits', 'apollo_leads']");
/** A hold or a note that cites the retired lead source. */
const RETIRED_NOTE = /^held: (?:Apollo|the history ledger \(apollo\)) reports /;
const RETIRED_NOTE_SQL = "held: (Apollo|the history ledger \\(apollo\\)) reports ";
/** Hosts the providers served logos from. */
const PROVIDER_LOGO = /(^|\.)fullenrich\.com$|zenprospect/i;

type Row = Record<string, unknown>;

export interface PurgePlan {
  /** Every row the plan touches, as it is now, by table: the backup. */
  before: Record<string, Row[]>;
  retiredEnrichments: string[];
  firmographics: string[];
  hq: Array<{ id: string; from: string; to: string | null }>;
  logos: Array<{ id: string; from: string; to: string | null }>;
  dossiers: Array<{ companyId: string; fields: string[]; data: Row }>;
  /** `from` is null when only a note cites the retired source; the hold itself is another source's. */
  holds: Array<{ id: string; from: string | null; to: string | null; notes: string[]; disposition: string }>;
  ledgerDeleted: Array<{ companyId: string; priorKey: string; status: string }>;
  ledgerKept: Array<{ companyId: string; priorKey: string; nextKey: string; prior: PriorRound; outcome: Row }>;
  flags: Array<{ companyId: string; rule: string }>;
  runsDeleted: string[];
  runCounts: string[];
}

export function purgeCounts(p: PurgePlan): Record<string, number> {
  return {
    retired_enrichments_deleted: p.retiredEnrichments.length,
    alexandria_firmographics_stripped: p.firmographics.length,
    hq_cleared: p.hq.filter((h) => h.to === null).length,
    hq_replaced_by_yc: p.hq.filter((h) => h.to !== null).length,
    logos_cleared: p.logos.filter((l) => l.to === null).length,
    logos_from_homepage: p.logos.filter((l) => l.to !== null).length,
    dossier_founded_year_dropped: p.dossiers.filter((d) => d.fields.includes("founded_year")).length,
    dossier_headcount_dropped: p.dossiers.filter((d) => d.fields.includes("headcount_estimate")).length,
    holds_lifted: p.holds.filter((h) => h.from !== null && h.to === null).length,
    holds_rewritten: p.holds.filter((h) => h.from !== null && h.to !== null).length,
    notes_only: p.holds.filter((h) => h.from === null).length,
    ledger_deleted: p.ledgerDeleted.length,
    ledger_promoted_kept: p.ledgerKept.length,
    accuracy_flags_deleted: p.flags.length,
    runs_deleted: p.runsDeleted.length,
    run_counts_stripped: p.runCounts.length,
  };
}

const normal = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Whether text names a place: its first segment ("Antwerp" in "Antwerp, Belgium") as whole words. */
function names(text: string, place: string): boolean {
  const city = normal(place.split(",")[0] ?? "");
  return city.length > 1 && ` ${normal(text)} `.includes(` ${city} `);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export async function planPurge(handle: Db): Promise<PurgePlan> {
  const plan: PurgePlan = {
    before: {},
    retiredEnrichments: [],
    firmographics: [],
    hq: [],
    logos: [],
    dossiers: [],
    holds: [],
    ledgerDeleted: [],
    ledgerKept: [],
    flags: [],
    runsDeleted: [],
    runCounts: [],
  };
  const keep = (table: string, rows: object[]) => {
    if (rows.length > 0) plan.before[table] = [...(plan.before[table] ?? []), ...(rows as Row[])];
  };

  const enrichmentRows = await handle
    .select()
    .from(enrichments)
    .where(inArray(enrichments.kind, [RETIRED, "alexandria", "profile", "deep_dive"]));
  const byCompany = new Map<string, Map<string, (typeof enrichmentRows)[number]>>();
  for (const e of enrichmentRows) byCompany.set(e.companyId, (byCompany.get(e.companyId) ?? new Map()).set(e.kind, e));
  const matched = <T>(v: unknown): T | null => ((v as { status?: string } | undefined)?.status === "matched" ? (v as T) : null);
  const alexandriaOf = (id: string) => byCompany.get(id)?.get("alexandria")?.data as { yc?: unknown; firmographics?: unknown } | undefined;
  const firmographicsOf = (id: string) => matched<{ hq?: string | null; logo_url?: string | null }>(alexandriaOf(id)?.firmographics);
  const retiredOf = (id: string) =>
    matched<{ hq?: string | null; country?: string | null; logo_url?: string | null }>(
      (byCompany.get(id)?.get(RETIRED)?.data as { apollo?: unknown } | undefined)?.apollo,
    );
  const ycOf = (id: string) =>
    matched<{ location?: string | null; year_founded?: number | null; team_size?: number | null }>(alexandriaOf(id)?.yc);

  const retired = enrichmentRows.filter((e) => e.kind === RETIRED);
  plan.retiredEnrichments = retired.map((e) => e.companyId);
  keep("enrichments", retired);
  const withFirmographics = enrichmentRows.filter(
    (e) => e.kind === "alexandria" && typeof e.data === "object" && e.data !== null && "firmographics" in e.data,
  );
  plan.firmographics = withFirmographics.map((e) => e.companyId);
  keep("enrichments", withFirmographics);

  // Headquarters and logos the providers filled.
  const companyRows = await handle.select().from(companies);
  const evidence = new Map<string, string>();
  const evidenceRows = await handle.execute(sql`
    select f.company_id, string_agg(f.evidence_quotes::text || ' ' || coalesce((
      select string_agg(rs.field_claims::text, ' ') from round_sources rs where rs.round_id = f.id), ''), ' ') as text
    from funding_rounds f group by f.company_id`);
  for (const r of (evidenceRows as unknown as { rows: Array<{ company_id: string; text: string | null }> }).rows)
    evidence.set(r.company_id, r.text ?? "");
  for (const c of companyRows) {
    const fe = firmographicsOf(c.id);
    const ap = retiredOf(c.id);
    const yc = ycOf(c.id);
    const profile = byCompany.get(c.id)?.get("profile")?.data as (EnrichmentData & { logo_url?: string | null }) | undefined;
    let touched = false;
    if (c.hq) {
      const hq = c.hq;
      const theirs = [fe?.hq, ap?.hq, ap?.hq && ap.country ? `${ap.hq}, ${ap.country}` : null].filter((h): h is string => Boolean(h));
      const stated =
        names(evidence.get(c.id) ?? "", hq) || names(yc?.location ?? "", hq) || names(JSON.stringify(profile?.profile ?? {}), hq);
      if (theirs.some((h) => normal(h) === normal(hq)) && !stated) {
        plan.hq.push({ id: c.id, from: hq, to: yc?.location ?? null });
        touched = true;
      }
    }
    if (c.logoUrl) {
      const theirs = [fe?.logo_url, ap?.logo_url].filter(Boolean);
      if (PROVIDER_LOGO.test(hostOf(c.logoUrl)) || theirs.includes(c.logoUrl)) {
        const own = toEnrichment(profile)?.verified ? (profile?.logo_url ?? null) : null;
        plan.logos.push({ id: c.id, from: c.logoUrl, to: own && !PROVIDER_LOGO.test(hostOf(own)) ? own : null });
        touched = true;
      }
    }
    if (touched) keep("companies", [c]);
  }

  // A checked dossier's founding year or team size the check confirmed only from the provider's facts:
  // no page citation, or the YC page's citation for a figure YC does not give, while the provider matched.
  for (const [companyId, kinds] of byCompany) {
    const dive = kinds.get("deep_dive");
    if (!dive || !firmographicsOf(companyId)) continue;
    const data = dive.data as Row & { verification?: { citations?: Record<string, string>; dropped?: Row[] } };
    if (!data.verification) continue;
    const citations = data.verification.citations ?? {};
    const yc = ycOf(companyId);
    const fields: string[] = [];
    for (const field of ["founded_year", "headcount_estimate"] as const) {
      const value = data[field];
      if (value === null || value === undefined || value === "") continue;
      const cited = citations[field];
      const ycPage = Boolean(cited && /(^|\.)ycombinator\.com$/i.test(hostOf(cited)));
      const ycSays =
        field === "founded_year" ? yc?.year_founded === value : Boolean(yc?.team_size && String(value).includes(String(yc.team_size)));
      if (cited && (!ycPage || ycSays)) continue;
      fields.push(field);
    }
    if (fields.length === 0) continue;
    const nextCitations = { ...citations };
    const dropped = [...(data.verification.dropped ?? [])];
    const next: Row = { ...data };
    for (const field of fields) {
      dropped.push({ field, item: String(data[field]), reason: "confirmed only by a retired provider's facts" });
      delete nextCitations[field];
      next[field] = null;
    }
    next.verification = { ...data.verification, citations: nextCitations, dropped };
    plan.dossiers.push({ companyId, fields, data: next });
    keep("enrichments", [dive]);
  }

  // Ledger leads from the retired source.
  const ledger = await handle.select().from(historyPromotions).where(eq(historyPromotions.origin, RETIRED));
  keep("history_promotions", ledger);
  const promoted = ledger.filter((l) => l.status === "promoted" && l.roundId).map((l) => l.roundId as string);
  const rounds = promoted.length ? await handle.select().from(fundingRounds).where(inArray(fundingRounds.id, promoted)) : [];
  const leadsBy = new Map<string, string[]>();
  if (promoted.length) {
    const rows = await handle
      .select({ roundId: roundInvestors.roundId, name: investors.name })
      .from(roundInvestors)
      .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
      .where(and(inArray(roundInvestors.roundId, promoted), eq(roundInvestors.role, "lead")));
    for (const r of rows) leadsBy.set(r.roundId, [...(leadsBy.get(r.roundId) ?? []), r.name]);
  }
  const taken = new Set(
    (
      await handle
        .select({ companyId: historyPromotions.companyId, key: historyPromotions.priorKey })
        .from(historyPromotions)
        .where(sql`${historyPromotions.origin} <> ${RETIRED}`)
    ).map((r) => `${r.companyId} ${r.key}`),
  );
  for (const l of ledger) {
    const round = l.status === "promoted" ? rounds.find((r) => r.id === l.roundId) : undefined;
    // The round's own facts, as the page that verified it states them; another lead on the same key stands for it instead.
    const prior: PriorRound | null = round
      ? {
          stage_as_written: round.stageAsWritten,
          amount_as_written: round.amountAsWritten,
          announced_date: round.announcedOn,
          lead_investors: leadsBy.get(round.id) ?? [],
          ...(l.sourceUrl ? { source_url: l.sourceUrl } : {}),
        }
      : null;
    const nextKey = prior ? priorKey(prior) : "";
    if (!prior || taken.has(`${l.companyId} ${nextKey}`)) {
      plan.ledgerDeleted.push({ companyId: l.companyId, priorKey: l.priorKey, status: l.status });
      continue;
    }
    taken.add(`${l.companyId} ${nextKey}`);
    const o = (l.outcome ?? {}) as Row;
    // Already the round's own facts (a run before this one wrote them): nothing to do.
    const done =
      l.priorKey === nextKey &&
      (l.prior as PriorRound).source_url === prior.source_url &&
      Object.keys(o).every((k) => ["verdict", "disposition", "merged"].includes(k));
    if (done) continue;
    plan.ledgerKept.push({
      companyId: l.companyId,
      priorKey: l.priorKey,
      nextKey,
      prior,
      outcome: { verdict: o.verdict ?? null, disposition: o.disposition ?? null, merged: o.merged ?? null },
    });
  }

  // Holds and notes that cite the retired lead source, judged again on what remains.
  const held = await handle
    .select()
    .from(fundingRounds)
    .where(sql`${fundingRounds.hold} ~ ${`^${RETIRED_NOTE_SQL}`} or ${fundingRounds.verification}::text ~ ${RETIRED_NOTE_SQL}`);
  keep("funding_rounds", held);
  for (const r of held) {
    const notes = ((r.verification as { notes?: string[] } | null)?.notes ?? []).filter((n) => !RETIRED_NOTE.test(n));
    if (!r.hold || !RETIRED_NOTE.test(r.hold)) {
      plan.holds.push({ id: r.id, from: null, to: r.hold, notes, disposition: r.disposition });
      continue;
    }
    const leads = (await companyLeads(handle, r.companyId)).filter(
      (l) => !l.origin.includes(`(${RETIRED})`) && l.origin !== `round ${r.id}`,
    );
    const candidate: HoldCandidate = {
      id: r.id,
      stage: r.stage,
      announcedOn: r.announcedOn,
      dateBasis: r.dateBasis,
      amountUsdMillions: r.amountUsdMillions === null ? null : Number(r.amountUsdMillions),
      history: r.history,
    };
    const lead = lateReportLead(candidate, leads);
    const to = lead ? holdNote(candidate, lead) : null;
    plan.holds.push({ id: r.id, from: r.hold, to, notes: to ? [...notes, to] : notes, disposition: r.disposition });
  }

  const flags = await handle.select().from(accuracyFlags).where(inArray(accuracyFlags.rule, RETIRED_RULES));
  plan.flags = flags.map((f) => ({ companyId: f.companyId, rule: f.rule }));
  keep("accuracy_flags", flags);

  const runRows = await handle
    .select()
    .from(runs)
    .where(sql`${runs.presetSlug} = ${RETIRED_RUN_PRESET} or ${runs.counts} ?| ${RETIRED_COUNT_KEYS}`);
  plan.runsDeleted = runRows.filter((r) => r.presetSlug === RETIRED_RUN_PRESET).map((r) => r.id);
  plan.runCounts = runRows.filter((r) => r.presetSlug !== RETIRED_RUN_PRESET).map((r) => r.id);
  keep("runs", runRows);
  return plan;
}

/** Write the plan, one short statement at a time. */
export async function applyPurge(handle: Db, plan: PurgePlan): Promise<void> {
  const now = new Date();
  if (plan.retiredEnrichments.length) await handle.delete(enrichments).where(eq(enrichments.kind, RETIRED));
  for (const id of plan.firmographics)
    await handle
      .update(enrichments)
      .set({ data: sql`${enrichments.data} - 'firmographics'` })
      .where(and(eq(enrichments.companyId, id), eq(enrichments.kind, "alexandria")));
  for (const h of plan.hq) await handle.update(companies).set({ hq: h.to, updatedAt: now }).where(eq(companies.id, h.id));
  for (const l of plan.logos) await handle.update(companies).set({ logoUrl: l.to, updatedAt: now }).where(eq(companies.id, l.id));
  for (const d of plan.dossiers)
    await handle
      .update(enrichments)
      .set({ data: d.data })
      .where(and(eq(enrichments.companyId, d.companyId), eq(enrichments.kind, "deep_dive")));
  for (const l of plan.ledgerDeleted)
    await handle
      .delete(historyPromotions)
      .where(and(eq(historyPromotions.companyId, l.companyId), eq(historyPromotions.priorKey, l.priorKey)));
  // Through a parking key first, so one kept lead never collides with another's old key on the way.
  const parked = (l: PurgePlan["ledgerKept"][number]) => `purge:${l.priorKey}`;
  for (const l of plan.ledgerKept)
    await handle
      .update(historyPromotions)
      .set({ priorKey: parked(l) })
      .where(and(eq(historyPromotions.companyId, l.companyId), eq(historyPromotions.priorKey, l.priorKey)));
  for (const l of plan.ledgerKept)
    await handle
      .update(historyPromotions)
      .set({ priorKey: l.nextKey, prior: l.prior, outcome: l.outcome, updatedAt: now })
      .where(and(eq(historyPromotions.companyId, l.companyId), eq(historyPromotions.priorKey, parked(l))));
  for (const h of plan.holds) {
    const [r] = await handle.select({ verification: fundingRounds.verification }).from(fundingRounds).where(eq(fundingRounds.id, h.id));
    if (!r) continue;
    const current = (r.verification as { status: string; notes: string[]; url: string | null } | null) ?? {
      status: "unverified",
      notes: [],
      url: null,
    };
    const verification = { ...current, notes: h.notes };
    await handle.update(fundingRounds).set({ hold: h.to, verification, updatedAt: now }).where(eq(fundingRounds.id, h.id));
  }
  if (plan.flags.length) await handle.delete(accuracyFlags).where(inArray(accuracyFlags.rule, RETIRED_RULES));
  if (plan.runsDeleted.length) await handle.delete(runs).where(inArray(runs.id, plan.runsDeleted));
  for (const id of plan.runCounts)
    await handle
      .update(runs)
      .set({ counts: sql`${runs.counts} - ${RETIRED_COUNT_KEYS}` })
      .where(eq(runs.id, id));
}
