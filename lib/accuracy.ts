// The daily accuracy check at the store. The rules are pure (packages/core/src/records/accuracy.ts);
// this file loads what the store holds about the companies that matter most, keeps the flags in
// accuracy_flags (new, still open, dismissed, cleared), remembers each dossier's founders between
// runs, and starts the safe remedies under a cap: a profile refresh for a company with no verified
// homepage, and a deep dive for one with no checked dossier or no founders. Every remedy's result
// still passes its own lane's check; everything else waits for a person in Review. Admin only:
// nothing public reads the flags.

import type { AccuracyCompany, AccuracyFlag, AccuracyRemedy, AccuracyRound, CompanySize, FounderMemory } from "@fireround/core";
import {
  ACCURACY_TOP_N,
  accuracyFlags,
  advanceFounderMemory,
  compareFlags,
  parseStoredDossier,
  planFlagChanges,
  prominentCompanyIds,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import type { NativeWebClient } from "@fireround/core/web";
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { DOSSIER_SCHEMA_VERSION } from "./deepdive.ts";
import { enrichBatch, isVerified } from "./enrich.ts";

const { accuracyFlags: flagsTable, accuracyMemory, companies, enrichments, fundingRounds, runs } = schema;

const VISIBLE = ["publish", "flagged"] as const;
const DAY = 86_400_000;

/** A remedy started for a flag waits this long before the run may start it again. */
export const REMEDY_REST_DAYS = 7;
/** A company dived in this window (whatever came of it) is not dived again for its dossier. */
export const DOSSIER_REST_DAYS = 14;
/**
 * How many times the run starts a flag's remedy before leaving it to a person: a homepage search that
 * found nothing three weeks running will not find it on the fourth, and a dive that came back with no
 * founders once (a subsidiary, a spin-off) is a few hundred credits each time it is repeated.
 */
export const MAX_REMEDY_ATTEMPTS: Record<string, number> = {
  no_domain: 3,
  dossier_missing: 2,
  dossier_no_founders: 1,
};

/** The run row's preset column and lane: the check owns both. */
export const ACCURACY_LANE = "accuracy";

export interface AccuracyParams {
  /** How many companies each ranking contributes (largest round, total raised). */
  topN: number;
  /** Start the safe remedies; off, the run only reads and records flags. */
  remedies: boolean;
  /** Remedies per run, per kind: a profile refresh is a few credits, a dive a few hundred; `history` caps the company timelines started. */
  caps: Record<AccuracyRemedy | "history", number>;
}

export const ACCURACY_DEFAULTS: AccuracyParams = { topN: ACCURACY_TOP_N, remedies: true, caps: { profile: 5, dossier: 2, history: 3 } };

/** The route's params from a query string or a JSON body; an error names the bad one. Pure. */
export function parseAccuracyParams(input: Record<string, unknown>): AccuracyParams | { error: string } {
  const int = (key: string, fallback: number, min: number, max: number): number | { error: string } => {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return { error: `${key} must be a whole number from ${min} to ${max}` };
    return n;
  };
  const topN = int("topN", ACCURACY_DEFAULTS.topN, 1, 1000);
  const profile = int("profile", ACCURACY_DEFAULTS.caps.profile, 0, 50);
  const dossier = int("dossier", ACCURACY_DEFAULTS.caps.dossier, 0, 20);
  const history = int("history", ACCURACY_DEFAULTS.caps.history, 0, 50);
  for (const v of [topN, profile, dossier, history]) if (typeof v === "object") return v;
  const raw = input.remedies;
  const remedies = raw === undefined || raw === null || raw === "" ? true : !["0", "false", false].includes(raw as string);
  return { topN: topN as number, remedies, caps: { profile: profile as number, dossier: dossier as number, history: history as number } };
}

/** Each visible company's largest round and total, the scope's input. */
export async function companySizes(handle: Db): Promise<CompanySize[]> {
  const rows = await handle
    .select({
      id: fundingRounds.companyId,
      largest: sql<string | null>`max(${fundingRounds.amountUsdMillions})`,
      total: sql<string | null>`sum(${fundingRounds.amountUsdMillions})`,
    })
    .from(fundingRounds)
    .where(inArray(fundingRounds.disposition, [...VISIBLE]))
    .groupBy(fundingRounds.companyId);
  return rows.map((r) => ({
    id: r.id,
    largest: r.largest === null ? null : Number(r.largest),
    total: r.total === null ? null : Number(r.total),
  }));
}

/** A json_agg column: parsed by some drivers, a string from others. */
function jsonList(value: unknown): Array<string | null> {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** The dossier's own moment: its check's time when checked, else when it was fetched. */
function dossierMoment(data: unknown, fetchedAt: Date): string {
  const checked = (data as { verification?: { checked_at?: unknown } } | null)?.verification?.checked_at;
  return typeof checked === "string" ? checked : fetchedAt.toISOString();
}

export interface LoadedCompany {
  company: AccuracyCompany;
  size: CompanySize;
  /** The memory row after this dossier, when it should be written. */
  memoryWrite: FounderMemory | null;
}

/** Everything the rules read about these companies, in six queries rather than six per company. */
export async function loadAccuracyCompanies(
  handle: Db,
  sizes: CompanySize[],
  opts: { readMemory?: boolean } = {},
): Promise<LoadedCompany[]> {
  const ids = sizes.map((s) => s.id);
  if (ids.length === 0) return [];
  const [rows, rounds, enrichmentRows, memoryRows] = await Promise.all([
    handle
      .select({
        id: companies.id,
        name: companies.name,
        domain: companies.domain,
        description: companies.description,
        logoUrl: companies.logoUrl,
      })
      .from(companies)
      .where(inArray(companies.id, ids)),
    handle
      .select({
        id: fundingRounds.id,
        companyId: fundingRounds.companyId,
        stage: fundingRounds.stage,
        stageAsWritten: fundingRounds.stageAsWritten,
        usd: fundingRounds.amountUsdMillions,
        amountAsWritten: fundingRounds.amountAsWritten,
        announcedOn: fundingRounds.announcedOn,
        datePrecision: fundingRounds.datePrecision,
        verification: sql<string | null>`${fundingRounds.verification}->>'status'`,
        confidence: fundingRounds.confidence,
        firstSeenAt: fundingRounds.firstSeenAt,
        history: fundingRounds.history,
        leads: sql<number>`(select count(*)::int from round_investors ri where ri.round_id = funding_rounds.id and ri.role = 'lead')`,
        titles: sql<
          Array<string | null>
        >`(select coalesce(json_agg(coalesce(rs.field_claims->>'title', s.title)), '[]'::json) from round_sources rs join sources s on s.id = rs.source_id where rs.round_id = funding_rounds.id)`,
      })
      .from(fundingRounds)
      .where(and(inArray(fundingRounds.companyId, ids), inArray(fundingRounds.disposition, [...VISIBLE]))),
    handle
      .select({
        companyId: enrichments.companyId,
        kind: enrichments.kind,
        data: enrichments.data,
        schemaVersion: enrichments.schemaVersion,
        fetchedAt: enrichments.fetchedAt,
      })
      .from(enrichments)
      .where(and(inArray(enrichments.companyId, ids), inArray(enrichments.kind, ["profile", "deep_dive"]))),
    opts.readMemory === false ? Promise.resolve([]) : handle.select().from(accuracyMemory).where(inArray(accuracyMemory.companyId, ids)),
  ]);

  const group = <T extends { companyId: string }>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of list) m.set(x.companyId, [...(m.get(x.companyId) ?? []), x]);
    return m;
  };
  const roundsBy = group(rounds);
  const enrichBy = group(enrichmentRows);
  const memoryBy = new Map(memoryRows.map((m) => [m.companyId, m]));
  const sizeBy = new Map(sizes.map((s) => [s.id, s]));

  return rows.map((row): LoadedCompany => {
    const e = enrichBy.get(row.id) ?? [];
    const profile = e.find((x) => x.kind === "profile");
    const diveRow = e.find((x) => x.kind === "deep_dive");
    const dossier = diveRow ? parseStoredDossier(diveRow.data) : null;
    const checked =
      !!diveRow && diveRow.schemaVersion >= DOSSIER_SCHEMA_VERSION && !!(diveRow.data as { verification?: unknown } | null)?.verification;
    const founders = (dossier?.founders ?? []).map((f) => f.name).filter(Boolean);

    let previousFounders: string[] | null = null;
    let memoryWrite: FounderMemory | null = null;
    if (diveRow && dossier) {
      const stored = memoryBy.get(row.id);
      const memory: FounderMemory | null = stored
        ? {
            dossierAt: stored.dossierAt?.toISOString() ?? null,
            founders: stored.founders,
            previousFounders: stored.previousFounders ?? null,
          }
        : null;
      const next = advanceFounderMemory(memory, { at: new Date(dossierMoment(diveRow.data, diveRow.fetchedAt)).toISOString(), founders });
      previousFounders = next.previous;
      if (next.changed) memoryWrite = next.memory;
    }

    const company: AccuracyCompany = {
      id: row.id,
      name: row.name,
      domain: row.domain,
      domainVerified: !!row.domain && !!profile && isVerified(profile.data as Parameters<typeof isVerified>[0]),
      description: row.description,
      logoUrl: row.logoUrl,
      rounds: (roundsBy.get(row.id) ?? []).map(
        (r): AccuracyRound => ({
          id: r.id,
          stage: r.stage,
          stageAsWritten: r.stageAsWritten,
          amountUsdMillions: r.usd === null ? null : Number(r.usd),
          amountAsWritten: r.amountAsWritten,
          announcedOn: r.announcedOn,
          datePrecision: r.datePrecision,
          verification: r.verification,
          confidence: Number(r.confidence),
          firstSeenAt: new Date(r.firstSeenAt).toISOString(),
          history: r.history,
          sourceTitles: jsonList(r.titles),
          leadCount: Number(r.leads),
        }),
      ),
      dossier: diveRow && dossier ? { checked, founders } : null,
      previousFounders,
    };
    return { company, size: sizeBy.get(row.id) ?? { id: row.id, largest: null, total: null }, memoryWrite };
  });
}

export interface AccuracyEvaluation {
  /** The companies checked, biggest first. */
  checked: LoadedCompany[];
  results: Array<{ companyId: string; flag: AccuracyFlag }>;
}

/**
 * Read-only: the scope, what the store holds about it, and every flag the rules raise now.
 * `readMemory: false` skips the founders' memory, for a store the migration has not reached yet.
 */
export async function evaluateAccuracy(
  handle: Db,
  opts: { topN?: number; now?: Date; readMemory?: boolean } = {},
): Promise<AccuracyEvaluation> {
  const now = opts.now ?? new Date();
  const sizes = await companySizes(handle);
  const scope = new Set(prominentCompanyIds(sizes, opts.topN ?? ACCURACY_TOP_N));
  const order = prominentCompanyIds(sizes, opts.topN ?? ACCURACY_TOP_N);
  const loaded = await loadAccuracyCompanies(
    handle,
    sizes.filter((s) => scope.has(s.id)),
    { readMemory: opts.readMemory },
  );
  const rank = new Map(order.map((id, i) => [id, i]));
  loaded.sort((a, b) => (rank.get(a.company.id) ?? 0) - (rank.get(b.company.id) ?? 0));
  const results = loaded.flatMap((l) => accuracyFlags(l.company, now).map((flag) => ({ companyId: l.company.id, flag })));
  return { checked: loaded, results };
}

export interface AccuracyCounts {
  companies_checked: number;
  flags_new: number;
  flags_open: number;
  flags_dismissed: number;
  flags_reopened: number;
  flags_cleared: number;
  flags_high: number;
}

/**
 * Write one evaluation: each flag seen is inserted or refreshed (new, still open, still dismissed,
 * or reopened when a dismissal no longer covers it), each open or dismissed flag not seen clears,
 * and each dossier's founders move along in memory. Idempotent for one evaluation.
 */
export async function recordAccuracy(handle: Db, evaluation: AccuracyEvaluation, now: Date = new Date()): Promise<AccuracyCounts> {
  const stored = await handle
    .select({
      companyId: flagsTable.companyId,
      rule: flagsTable.rule,
      subjects: flagsTable.subjects,
      clearedAt: flagsTable.clearedAt,
      dismissedAt: flagsTable.dismissedAt,
      dismissedSubjects: flagsTable.dismissedSubjects,
    })
    .from(flagsTable);
  const plan = planFlagChanges(stored, evaluation.results);
  const counts: AccuracyCounts = {
    companies_checked: evaluation.checked.length,
    flags_new: 0,
    flags_open: 0,
    flags_dismissed: 0,
    flags_reopened: 0,
    flags_cleared: plan.clears.length,
    flags_high: 0,
  };
  for (const w of plan.writes) {
    const f = w.flag;
    const common = { severity: f.severity, reason: f.reason, subjects: f.subjects, remedy: f.remedy, lastSeenAt: now };
    if (w.state === "new") {
      counts.flags_new++;
      await handle
        .insert(flagsTable)
        .values({ companyId: w.companyId, rule: f.rule, ...common, firstSeenAt: now })
        .onConflictDoUpdate({
          target: [flagsTable.companyId, flagsTable.rule],
          set: {
            ...common,
            firstSeenAt: now,
            clearedAt: null,
            dismissedAt: null,
            dismissedNote: null,
            dismissedSubjects: null,
            remediedAt: null,
            remedyNote: null,
            remedyAttempts: 0,
          },
        });
    } else if (w.state === "reopened") {
      counts.flags_reopened++;
      await handle
        .update(flagsTable)
        .set({ ...common, dismissedAt: null, dismissedNote: null, dismissedSubjects: null })
        .where(and(eq(flagsTable.companyId, w.companyId), eq(flagsTable.rule, f.rule)));
    } else {
      if (w.state === "dismissed") counts.flags_dismissed++;
      await handle
        .update(flagsTable)
        .set(common)
        .where(and(eq(flagsTable.companyId, w.companyId), eq(flagsTable.rule, f.rule)));
    }
    if (w.state !== "dismissed") {
      counts.flags_open++;
      if (f.severity === "high") counts.flags_high++;
    }
  }
  for (const c of plan.clears) {
    await handle
      .update(flagsTable)
      .set({ clearedAt: now })
      .where(and(eq(flagsTable.companyId, c.companyId), eq(flagsTable.rule, c.rule), isNull(flagsTable.clearedAt)));
  }
  for (const l of evaluation.checked) {
    if (!l.memoryWrite) continue;
    const m = l.memoryWrite;
    const values = {
      dossierAt: m.dossierAt ? new Date(m.dossierAt) : null,
      founders: m.founders,
      previousFounders: m.previousFounders,
      updatedAt: now,
    };
    await handle
      .insert(accuracyMemory)
      .values({ companyId: l.company.id, ...values })
      .onConflictDoUpdate({ target: accuracyMemory.companyId, set: values });
  }
  return counts;
}

/** A remedy the run is about to start for one flag. */
export interface RemedyTarget {
  companyId: string;
  rule: string;
  remedy: AccuracyRemedy;
  /** For a dossier: dive (none, or no founders) or reverify (a dossier written before the check). */
  action?: "dive" | "reverify";
}

/** Companies dived in the last `days`, whatever came of it: their dossier rests. */
export async function recentlyDived(handle: Db, now: Date, days = DOSSIER_REST_DAYS): Promise<Set<string>> {
  const rows = await handle
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.presetSlug, "deep-dive"), gte(runs.startedAt, new Date(now.getTime() - days * DAY))));
  return new Set(rows.map((r) => r.id.replace(/^deepdive:/, "").replace(/:\d+$/, "")));
}

/**
 * The remedies this run may start: open flags (not dismissed, not cleared) that name one, whose
 * remedy has rested a week since it last started, the biggest companies' first, each kind under its
 * cap. A dossier also waits when the company was dived in the last two weeks, is resting after a
 * failed or rejected dive, or when no model is configured to check what a dive returns.
 */
export async function planRemedies(
  handle: Db,
  params: Pick<AccuracyParams, "caps">,
  opts: { now?: Date; order?: string[]; resting?: Set<string>; dossierCheck?: boolean } = {},
): Promise<{ targets: RemedyTarget[]; skipped: number }> {
  const now = opts.now ?? new Date();
  const open = await handle
    .select({
      companyId: flagsTable.companyId,
      rule: flagsTable.rule,
      severity: flagsTable.severity,
      remedy: flagsTable.remedy,
      subjects: flagsTable.subjects,
      attempts: flagsTable.remedyAttempts,
    })
    .from(flagsTable)
    .where(
      and(
        isNull(flagsTable.clearedAt),
        isNull(flagsTable.dismissedAt),
        isNotNull(flagsTable.remedy),
        sql`(${flagsTable.remediedAt} is null or ${flagsTable.remediedAt} < ${new Date(now.getTime() - REMEDY_REST_DAYS * DAY)})`,
      ),
    );
  const rank = new Map((opts.order ?? []).map((id, i) => [id, i]));
  open.sort(
    (a, b) => (rank.get(a.companyId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.companyId) ?? Number.MAX_SAFE_INTEGER) || compareFlags(a, b),
  );
  const dived = await recentlyDived(handle, now);
  const resting = opts.resting ?? new Set<string>();
  const used: Record<AccuracyRemedy, number> = { profile: 0, dossier: 0 };
  const seen = new Set<string>();
  const targets: RemedyTarget[] = [];
  let skipped = 0;
  for (const f of open) {
    const remedy = f.remedy as AccuracyRemedy;
    if (!(remedy in used)) continue;
    // One remedy of a kind per company: two dossier flags on one company are one dive.
    const key = `${remedy}\u0000${f.companyId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (f.attempts >= (MAX_REMEDY_ATTEMPTS[f.rule] ?? 1)) {
      skipped++;
      continue;
    }
    if (remedy === "dossier" && (opts.dossierCheck === false || dived.has(f.companyId) || resting.has(f.companyId))) {
      skipped++;
      continue;
    }
    if (used[remedy] >= params.caps[remedy]) {
      skipped++;
      continue;
    }
    used[remedy]++;
    const action =
      remedy === "dossier" ? (f.rule === "dossier_missing" && f.subjects.includes("unchecked") ? "reverify" : "dive") : undefined;
    targets.push({ companyId: f.companyId, rule: f.rule, remedy, ...(action ? { action } : {}) });
  }
  return { targets, skipped };
}

/** Note what the run started for a flag, so it rests before the next try and Review can say what happened. */
export async function markRemedied(
  handle: Db,
  t: Pick<RemedyTarget, "companyId" | "rule">,
  note: string,
  now: Date = new Date(),
): Promise<void> {
  await handle
    .update(flagsTable)
    .set({ remediedAt: now, remedyNote: note.slice(0, 300), remedyAttempts: sql`${flagsTable.remedyAttempts} + 1` })
    .where(and(eq(flagsTable.companyId, t.companyId), eq(flagsTable.rule, t.rule)));
}

/** Dismiss a flag with a person's note: it stays quiet while it is about the same things. */
export async function dismissAccuracyFlag(
  handle: Db,
  companyId: string,
  rule: string,
  note: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await handle
    .update(flagsTable)
    .set({ dismissedAt: now, dismissedNote: note.trim().slice(0, 500) || null, dismissedSubjects: sql`${flagsTable.subjects}` })
    .where(and(eq(flagsTable.companyId, companyId), eq(flagsTable.rule, rule), isNull(flagsTable.clearedAt)))
    .returning({ rule: flagsTable.rule });
  return rows.length > 0;
}

/** Undo a dismissal: the flag is open again until the next run clears or keeps it. */
export async function reopenAccuracyFlag(handle: Db, companyId: string, rule: string): Promise<boolean> {
  const rows = await handle
    .update(flagsTable)
    .set({ dismissedAt: null, dismissedNote: null, dismissedSubjects: null })
    .where(and(eq(flagsTable.companyId, companyId), eq(flagsTable.rule, rule), isNotNull(flagsTable.dismissedAt)))
    .returning({ rule: flagsTable.rule });
  return rows.length > 0;
}

export type AccuracyView = "open" | "dismissed" | "cleared";

export interface AccuracyFlagRow {
  rule: string;
  severity: string;
  reason: string;
  remedy: string | null;
  first_seen_at: string;
  last_seen_at: string;
  cleared_at: string | null;
  dismissed_at: string | null;
  dismissed_note: string | null;
  remedied_at: string | null;
  remedy_note: string | null;
  remedy_attempts: number;
  /** The run has tried its remedy as often as it will; the flag waits for a person. */
  remedy_exhausted: boolean;
}

export interface AccuracyCompanyRow {
  id: string;
  name: string;
  domain: string | null;
  logo_url: string | null;
  largest_usd_millions: number | null;
  total_usd_millions: number | null;
  flags: AccuracyFlagRow[];
}

/** Cleared flags stay listed this long, so a reviewer sees what the store fixed on its own. */
export const CLEARED_LISTED_DAYS = 7;

/** The Review page's read: companies with flags in the view, most urgent first, and the counts for each view. */
export async function listAccuracy(
  handle: Db,
  view: AccuracyView,
  now: Date = new Date(),
): Promise<{
  companies: AccuracyCompanyRow[];
  counts: Record<AccuracyView, number>;
  lastRun: { started_at: string; counts: Record<string, number> | null } | null;
}> {
  const clearedSince = new Date(now.getTime() - CLEARED_LISTED_DAYS * DAY);
  const where =
    view === "open"
      ? and(isNull(flagsTable.clearedAt), isNull(flagsTable.dismissedAt))
      : view === "dismissed"
        ? and(isNull(flagsTable.clearedAt), isNotNull(flagsTable.dismissedAt))
        : gte(flagsTable.clearedAt, clearedSince);
  const [rows, countRows, [last]] = await Promise.all([
    handle
      .select({
        companyId: flagsTable.companyId,
        name: companies.name,
        domain: companies.domain,
        logoUrl: companies.logoUrl,
        rule: flagsTable.rule,
        severity: flagsTable.severity,
        reason: flagsTable.reason,
        remedy: flagsTable.remedy,
        firstSeenAt: flagsTable.firstSeenAt,
        lastSeenAt: flagsTable.lastSeenAt,
        clearedAt: flagsTable.clearedAt,
        dismissedAt: flagsTable.dismissedAt,
        dismissedNote: flagsTable.dismissedNote,
        remediedAt: flagsTable.remediedAt,
        remedyNote: flagsTable.remedyNote,
        remedyAttempts: flagsTable.remedyAttempts,
        largest: sql<
          string | null
        >`(select max(f.amount_usd_millions) from funding_rounds f where f.company_id = accuracy_flags.company_id and f.disposition in ('publish', 'flagged'))`,
        total: sql<
          string | null
        >`(select sum(f.amount_usd_millions) from funding_rounds f where f.company_id = accuracy_flags.company_id and f.disposition in ('publish', 'flagged'))`,
      })
      .from(flagsTable)
      .innerJoin(companies, eq(companies.id, flagsTable.companyId))
      .where(where),
    handle
      .select({
        open: sql<number>`count(*) filter (where ${flagsTable.clearedAt} is null and ${flagsTable.dismissedAt} is null)::int`,
        dismissed: sql<number>`count(*) filter (where ${flagsTable.clearedAt} is null and ${flagsTable.dismissedAt} is not null)::int`,
        cleared: sql<number>`count(*) filter (where ${flagsTable.clearedAt} >= ${clearedSince})::int`,
      })
      .from(flagsTable),
    handle
      .select({ startedAt: runs.startedAt, counts: runs.counts })
      .from(runs)
      .where(eq(runs.lane, ACCURACY_LANE))
      .orderBy(desc(runs.startedAt))
      .limit(1),
  ]);
  const byCompany = new Map<string, AccuracyCompanyRow>();
  for (const r of rows) {
    let c = byCompany.get(r.companyId);
    if (!c) {
      c = {
        id: r.companyId,
        name: r.name,
        domain: r.domain,
        logo_url: r.logoUrl,
        largest_usd_millions: r.largest === null ? null : Number(r.largest),
        total_usd_millions: r.total === null ? null : Number(r.total),
        flags: [],
      };
      byCompany.set(r.companyId, c);
    }
    c.flags.push({
      rule: r.rule,
      severity: r.severity,
      reason: r.reason,
      remedy: r.remedy,
      first_seen_at: r.firstSeenAt.toISOString(),
      last_seen_at: r.lastSeenAt.toISOString(),
      cleared_at: r.clearedAt?.toISOString() ?? null,
      dismissed_at: r.dismissedAt?.toISOString() ?? null,
      dismissed_note: r.dismissedNote,
      remedied_at: r.remediedAt?.toISOString() ?? null,
      remedy_note: r.remedyNote,
      remedy_attempts: r.remedyAttempts,
      remedy_exhausted: !!r.remedy && r.remedyAttempts >= (MAX_REMEDY_ATTEMPTS[r.rule] ?? 1),
    });
  }
  const list = [...byCompany.values()];
  for (const c of list) c.flags.sort((a, b) => compareFlags(a, b));
  const worst = (c: AccuracyCompanyRow) => Math.min(...c.flags.map((f) => ({ high: 0, medium: 1, low: 2 })[f.severity as "high"] ?? 3));
  list.sort((a, b) => worst(a) - worst(b) || (b.largest_usd_millions ?? 0) - (a.largest_usd_millions ?? 0) || a.name.localeCompare(b.name));
  const counts = countRows[0] ?? { open: 0, dismissed: 0, cleared: 0 };
  return {
    companies: list,
    counts: { open: Number(counts.open), dismissed: Number(counts.dismissed), cleared: Number(counts.cleared) },
    lastRun: last ? { started_at: last.startedAt.toISOString(), counts: (last.counts as Record<string, number> | null) ?? null } : null,
  };
}

/** The open flag count for the Review chip. */
export async function openAccuracyCount(handle: Db): Promise<number> {
  const [row] = await handle
    .select({ n: sql<number>`count(*)::int` })
    .from(flagsTable)
    .where(and(isNull(flagsTable.clearedAt), isNull(flagsTable.dismissedAt)));
  return Number(row?.n ?? 0);
}

/**
 * The profile remedy: run the enrichment step once for a company with no verified homepage, the same
 * read the sweep and Refresh profile make (the company's own pages among its sources first, a search
 * grounded in what the record says, then the name's own search), verified against the homepage
 * before anything is written. Unlike Refresh profile it clears nothing first: a read that verifies
 * nothing leaves the row as it was.
 */
export async function refreshProfile(
  handle: Db,
  client: NativeWebClient,
  companyId: string,
  opts: { pricingPage: boolean },
): Promise<{ verified: boolean; website: string | null; credits: number; note: string }> {
  const [c] = await handle
    .select({
      id: companies.id,
      name: companies.name,
      website: companies.website,
      domain: companies.domain,
      description: companies.description,
      hq: companies.hq,
      sector: companies.sector,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!c) return { verified: false, website: null, credits: 0, note: "profile refresh: the company is gone" };
  const website = c.website ?? (c.domain ? `https://${c.domain}` : null);
  const r = await enrichBatch(
    handle,
    client,
    [{ id: c.id, name: c.name, website, description: c.description, hq: c.hq, sector: c.sector }],
    opts,
  );
  const e = r.enrichments[0];
  const verified = !!e && isVerified(e);
  const note = verified
    ? `profile refresh: verified ${e.company_website}`
    : `profile refresh: no homepage verified${e?.error ? ` (${e.error})` : ""}`;
  return { verified, website: e?.company_website ?? null, credits: r.credits, note };
}
