// The company dossier at rest: one enrichments row per company (kind deep_dive), the
// agent's reading kept in data beside the extractor's company row rather than folded
// into it. No dossier is saved unchecked: every dive goes through the dossier check
// (lib/dossier-check.ts) first, and what is stored is the cleaned dossier with the check's
// record beside it (schema version 2). Rows written before the check (version 1) stay
// readable and hidden from visitors until reverifyDossier rewrites or removes them.
//
// A dive is three moves so a durable caller can make each its own step: start the agent,
// wait for it, then check, save, and record the run. runDeepDive does all three inline.

import type { CompanyDossier, DeepDiveOptions, DeepDiveResult, DossierVerification } from "@fireround/core";
import { DEEP_DIVE_MAX_CREDITS, deepDive, parseStoredDossier, startDeepDive } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { type CheckDeps, checkDossier, DossierCheckUnavailable, dossierCheckAvailable } from "./dossier-check.ts";
import { holdLateReports } from "./late-report.ts";
import { recordRun } from "./persist.ts";

const { companies, enrichments } = schema;

export { DEEP_DIVE_MAX_CREDITS };

/**
 * What one dive is priced at before it runs: the agent at effort high plus the check's reads.
 * Measured at effort medium over 68 dives: 82 credits on average, 226 at most. Effort high is
 * priced here at about three times that until the pilot measures it; the cap is DEEP_DIVE_MAX_CREDITS.
 */
export const DEEP_DIVE_CREDITS = 300;
/** The check's reads: up to eight of the dossier's sources and two of our rounds', plus a five-result search when those are thin. */
export const DOSSIER_CHECK_CREDITS = 17;
/** A version 2 row carries the check's record; version 1 rows predate the check. */
export const DOSSIER_SCHEMA_VERSION = 2;

export interface Dossier {
  data: CompanyDossier;
  /** The check's record, or null for a row written before dossiers were checked. */
  verification: DossierVerification | null;
  /** The first URL behind a kept claim, kept as the row's source. */
  source_url: string | null;
  fetched_at: string;
}

function verificationOf(data: unknown, version: number): DossierVerification | null {
  if (version < DOSSIER_SCHEMA_VERSION) return null;
  const v = (data as { verification?: DossierVerification } | null)?.verification;
  return v && typeof v.checked_at === "string" && Array.isArray(v.sources_checked) ? v : null;
}

/** Store a checked dossier. Without a verification it is stored as an unchecked row, which only tests and old callers write. */
export async function saveDossier(
  handle: Db,
  companyId: string,
  dossier: CompanyDossier,
  sourceUrl: string | null,
  now: Date = new Date(),
  verification: DossierVerification | null = null,
): Promise<void> {
  const data = verification ? { ...dossier, verification } : dossier;
  const schemaVersion = verification ? DOSSIER_SCHEMA_VERSION : 1;
  await handle
    .insert(enrichments)
    .values({ companyId, kind: "deep_dive", data, schemaVersion, sourceUrl, fetchedAt: now })
    .onConflictDoUpdate({
      target: [enrichments.companyId, enrichments.kind],
      set: { data, schemaVersion, sourceUrl, fetchedAt: now },
    });
  // The dossier's prior rounds are a lead source: a feed row they show is a late re-report is held.
  await holdLateReports(handle, [companyId]);
}

export async function deleteDossier(handle: Db, companyId: string): Promise<void> {
  await handle.delete(enrichments).where(and(eq(enrichments.companyId, companyId), eq(enrichments.kind, "deep_dive")));
}

export async function getDossier(handle: Db, companyId: string): Promise<Dossier | null> {
  const [row] = await handle
    .select({
      data: enrichments.data,
      schemaVersion: enrichments.schemaVersion,
      sourceUrl: enrichments.sourceUrl,
      fetchedAt: enrichments.fetchedAt,
    })
    .from(enrichments)
    .where(and(eq(enrichments.companyId, companyId), eq(enrichments.kind, "deep_dive")))
    .limit(1);
  if (!row) return null;
  const data = parseStoredDossier(row.data);
  if (!data) return null;
  return {
    data,
    verification: verificationOf(row.data, row.schemaVersion),
    source_url: row.sourceUrl,
    fetched_at: row.fetchedAt.toISOString(),
  };
}

/** A version 2 row with its check's record: what a visitor may read. */
export const verifiedDossierSql = sql`(${enrichments.schemaVersion} >= ${DOSSIER_SCHEMA_VERSION} and ${enrichments.data} -> 'verification' is not null)`;

/** Which of these companies have a dossier, checked or not; `verifiedOnly` counts the checked ones alone. */
export async function companiesWithDossier(handle: Db, companyIds: string[], opts: { verifiedOnly?: boolean } = {}): Promise<Set<string>> {
  if (companyIds.length === 0) return new Set();
  const rows = await handle
    .select({ companyId: enrichments.companyId })
    .from(enrichments)
    .where(
      and(
        eq(enrichments.kind, "deep_dive"),
        inArray(enrichments.companyId, companyIds),
        opts.verifiedOnly ? verifiedDossierSql : undefined,
      ),
    );
  return new Set(rows.map((r) => r.companyId));
}

export type DeepDiveOutcome =
  | { status: "verified"; dossier: Dossier; creditsUsed: number | null; checkCredits: number; seconds: number }
  | { status: "rejected"; dossier: null; reason: string; creditsUsed: number | null; checkCredits: number; seconds: number }
  | { status: "failed"; dossier: null; error: string; creditsUsed: number | null; checkCredits: number; seconds: number };

/** The run id a dive records under; the backlog reads it back to rest a company whose dive failed. */
export function diveRunId(companyId: string, startedAt: Date): string {
  return `deepdive:${companyId}:${startedAt.getTime()}`;
}

async function loadCompany(handle: Db, companyId: string) {
  const [company] = await handle.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) throw new Error("Company not found.");
  return company;
}

/**
 * Start the agent for one company and return its job id. Refuses with DossierCheckUnavailable when
 * no model is configured to check the result: a dossier that could never be saved is not paid for.
 * The run's row is written open at once (finishCompanyDive closes it under the same id), so Runs
 * shows the dive while it works and no other pass starts a second dive on the same company.
 */
export async function startCompanyDive(
  handle: Db,
  client: Firecrawl,
  companyId: string,
  opts: DeepDiveOptions & CheckDeps & { startedAt?: Date } = {},
): Promise<string> {
  if (!dossierCheckAvailable(opts)) throw new DossierCheckUnavailable();
  const company = await loadCompany(handle, companyId);
  const startedAt = opts.startedAt ?? new Date();
  const jobId = await startDeepDive(
    client,
    { company_name: company.name, website: company.website, domain: company.domain, description: company.description },
    { maxCredits: opts.maxCredits, effort: opts.effort },
  );
  await recordRun(handle, {
    id: diveRunId(companyId, startedAt),
    presetSlug: "deep-dive",
    lane: "agent",
    window: null,
    startedAt,
    finishedAt: null,
    creditsEstimated: DEEP_DIVE_CREDITS,
    creditsMeasured: null,
    counts: { companies: 1 },
  });
  return jobId;
}

/**
 * Check what the agent returned, save it when it passes, and record the run either way, so a dive's
 * cost shows on Runs whatever became of it. A dossier about another company (or one the check cannot
 * place) is not saved and any earlier dossier stays. When the check itself cannot run (no model, the
 * gateway down, nothing readable) this throws and saves nothing: a durable caller retries the step,
 * with the agent's result already in hand.
 */
export async function finishCompanyDive(
  handle: Db,
  client: Firecrawl,
  companyId: string,
  result: DeepDiveResult,
  startedAt: Date,
  deps: CheckDeps = {},
): Promise<DeepDiveOutcome> {
  const finished = new Date(startedAt.getTime() + result.seconds * 1000);
  const agentCredits = result.creditsUsed;
  const runBase = {
    id: diveRunId(companyId, startedAt),
    presetSlug: "deep-dive",
    lane: "agent",
    window: null,
    startedAt,
    finishedAt: finished,
    creditsEstimated: DEEP_DIVE_CREDITS,
  };

  if (result.status !== "completed" || !result.dossier) {
    const error = `agent ${result.status}${result.error ? `: ${result.error}` : ""}`.slice(0, 500);
    await recordRun(handle, {
      ...runBase,
      creditsMeasured: agentCredits,
      counts: { companies: 1, agent_credits: agentCredits ?? 0 },
      error,
    });
    return { status: "failed", dossier: null, error, creditsUsed: agentCredits, checkCredits: 0, seconds: result.seconds };
  }

  const check = await checkDossier(handle, client, companyId, result.dossier, deps);
  const v = check.verification;
  // The check's reads are priced at the rate card and added to what the agent reported.
  const creditsMeasured = (agentCredits ?? 0) + v.credits;
  const counts = {
    companies: 1,
    agent_credits: agentCredits ?? 0,
    check_credits: v.credits,
    sources_checked: v.sources_checked.length,
    claims_kept: v.kept,
    claims_dropped: v.dropped.length,
  };
  if (check.status === "rejected") {
    await recordRun(handle, { ...runBase, creditsMeasured, counts, error: `dossier rejected: ${check.reason}` });
    return {
      status: "rejected",
      dossier: null,
      reason: check.reason,
      creditsUsed: agentCredits,
      checkCredits: v.credits,
      seconds: result.seconds,
    };
  }
  const sourceUrl = check.dossier.sources[0] ?? null;
  await saveDossier(handle, companyId, check.dossier, sourceUrl, finished, v);
  await recordRun(handle, { ...runBase, creditsMeasured, counts });
  return {
    status: "verified",
    dossier: { data: check.dossier, verification: v, source_url: sourceUrl, fetched_at: finished.toISOString() },
    creditsUsed: agentCredits,
    checkCredits: v.credits,
    seconds: result.seconds,
  };
}

/**
 * One dive, inline: start, wait, check, save. A check that cannot run is recorded as a failed run
 * rather than thrown, since nothing here retries. The durable path is workflows/dossiers.ts.
 */
export async function runDeepDive(
  handle: Db,
  client: Firecrawl,
  companyId: string,
  opts: DeepDiveOptions & CheckDeps & { now?: Date } = {},
): Promise<DeepDiveOutcome> {
  if (!dossierCheckAvailable(opts)) throw new DossierCheckUnavailable();
  const company = await loadCompany(handle, companyId);
  const started = opts.now ?? new Date();
  const result = await deepDive(
    client,
    { company_name: company.name, website: company.website, domain: company.domain, description: company.description },
    { maxCredits: opts.maxCredits, effort: opts.effort },
  );
  try {
    return await finishCompanyDive(handle, client, companyId, result, started, opts);
  } catch (err) {
    const error = `dossier check failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
    await recordRun(handle, {
      id: diveRunId(companyId, started),
      presetSlug: "deep-dive",
      lane: "agent",
      window: null,
      startedAt: started,
      finishedAt: new Date(started.getTime() + result.seconds * 1000),
      creditsEstimated: DEEP_DIVE_CREDITS,
      creditsMeasured: result.creditsUsed,
      counts: { companies: 1, agent_credits: result.creditsUsed ?? 0 },
      error,
    });
    return { status: "failed", dossier: null, error, creditsUsed: result.creditsUsed, checkCredits: 0, seconds: result.seconds };
  }
}

export type ReverifyOutcome =
  | { status: "verified"; checkCredits: number; kept: number; dropped: number }
  | { status: "removed"; reason: string; checkCredits: number }
  | { status: "none"; checkCredits: 0 };

/**
 * Check a dossier already on the store, with no new agent run: rewrite it cleaned, or delete it when
 * the check says it is about another company (or cannot place it). The dive's own date stays on the
 * row; the check's date is in its record. Throws, and changes nothing, when the check cannot run.
 */
export async function reverifyDossier(handle: Db, client: Firecrawl, companyId: string, deps: CheckDeps = {}): Promise<ReverifyOutcome> {
  const [row] = await handle
    .select({ data: enrichments.data, fetchedAt: enrichments.fetchedAt })
    .from(enrichments)
    .where(and(eq(enrichments.companyId, companyId), eq(enrichments.kind, "deep_dive")))
    .limit(1);
  const stored = row ? parseStoredDossier(row.data) : null;
  if (!row || !stored) return { status: "none", checkCredits: 0 };
  const started = deps.now ?? new Date();
  const check = await checkDossier(handle, client, companyId, stored, { ...deps, now: started });
  const v = check.verification;
  const runBase = {
    id: `dossiercheck:${companyId}:${started.getTime()}`,
    presetSlug: "dossier-check",
    lane: "agent",
    window: null,
    startedAt: started,
    finishedAt: new Date(),
    creditsEstimated: DOSSIER_CHECK_CREDITS,
    creditsMeasured: v.credits,
    counts: { companies: 1, sources_checked: v.sources_checked.length, claims_kept: v.kept, claims_dropped: v.dropped.length },
  };
  if (check.status === "rejected") {
    await deleteDossier(handle, companyId);
    await recordRun(handle, { ...runBase, error: `dossier rejected: ${check.reason}; removed` });
    return { status: "removed", reason: check.reason, checkCredits: v.credits };
  }
  await saveDossier(handle, companyId, check.dossier, check.dossier.sources[0] ?? null, row.fetchedAt, v);
  await recordRun(handle, runBase);
  return { status: "verified", checkCredits: v.credits, kept: v.kept, dropped: v.dropped.length };
}
