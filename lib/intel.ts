// The plan's intelligence steps after persist: corroborate what just landed, gap-fill what
// is still in review, pick the companies the dossier lane dives or checks. Each function takes the
// resolved CoveragePlan and the ids persist returned, does exactly what the rung says, and
// hands back counts and estimated credits for the run row. Both workflows call these, so the
// gating lives here once; the rungs themselves are docs/coverage.md.

import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import type { NativeWebClient } from "@fireround/core/web";
import { and, eq, gte, inArray, max, sql } from "drizzle-orm";
import { corroborateRecord, RecordGone } from "./corroborate.ts";
import type { CoveragePlan } from "./coverage.ts";
import { verifiedDossierSql } from "./deepdive.ts";
import { GAP_FILL_CREDITS, researchRound } from "./gapfill.ts";
import { listRounds } from "./persist.ts";

const { companies, enrichments, fundingRounds, runs } = schema;

export interface PersistedIds {
  insertedIds: string[];
  changedIds: string[];
  persistedIds: string[];
}

/** Which persisted rows the rung corroborates: new, new and updated, every one, or none. */
export function corroborationTargets(plan: Pick<CoveragePlan, "corroboration">, ids: PersistedIds): string[] {
  switch (plan.corroboration) {
    case "off":
      return [];
    case "new":
      return [...new Set(ids.insertedIds)];
    case "new_and_updated":
      return [...new Set(ids.changedIds)];
    case "all":
      return [...new Set(ids.persistedIds)];
  }
}

async function pool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await work(next);
  });
  await Promise.all(workers);
}

export interface CorroborationTally {
  corroborated: number;
  /** Pages read and turned away: they described a round that was not the record's (the same name on another company, mostly). */
  corroboration_rejected: number;
  corroboration_credits: number;
  /** Pages read off the companies' own sites, found by mapping them. */
  newsroom_pages: number;
}

/**
 * Corroborate the rung's targets and the rows whose day the company never stated, ten at a time. A record
 * whose search finds nothing still counts as corroborated (it was read).
 */
export async function corroborateForPlan(
  handle: Db,
  client: NativeWebClient,
  plan: CoveragePlan,
  ids: PersistedIds,
): Promise<CorroborationTally> {
  const tally: CorroborationTally = { corroborated: 0, corroboration_rejected: 0, corroboration_credits: 0, newsroom_pages: 0 };
  // The rung's targets, and every written row whose day the company never stated whatever the rung: a
  // list's week or a page's byline is not the announcement, and such a row is not delivered on one list.
  const targets = [...new Set([...ids.insertedIds, ...corroborationTargets(plan, ids), ...(await unstatedDays(handle, ids.changedIds))])];
  await pool(targets, 10, async (id) => {
    const outcome = await corroborateRecord(handle, client, id, { broad: true }).catch((error: unknown) => {
      if (error instanceof RecordGone) return null;
      throw error;
    });
    if (!outcome) return;
    tally.corroborated += 1;
    tally.corroboration_rejected += outcome.rejected;
    tally.newsroom_pages += outcome.newsroom;
    tally.corroboration_credits += outcome.creditsEstimated;
  });
  return tally;
}

/**
 * The rows whose day the company never stated: a byline, a URL, a search result, a list's week or
 * month, or none. These are the rows a late page can date as today's (Primo's Sep 22 round from a
 * Sep 25 article, Angle Health's Sep 18 Series C from a Sep 24 newsletter), so every lane corroborates
 * them before it delivers, whatever the rung says about the rest.
 */
export async function unstatedDays(handle: Db, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await handle
    .select({
      id: fundingRounds.id,
      basis: fundingRounds.dateBasis,
      precision: fundingRounds.datePrecision,
      history: fundingRounds.history,
    })
    .from(fundingRounds)
    .where(inArray(fundingRounds.id, unique));
  return rows.filter((r) => !r.history && (r.basis !== "stated" || r.precision !== "day")).map((r) => r.id);
}

/** Corroborate the rows unstatedDays names among these ids, ten at a time: the pre-delivery read for a lane whose rung would not. */
export async function corroborateUnstated(
  handle: Db,
  client: NativeWebClient,
  ids: string[],
): Promise<CorroborationTally & { targets: string[] }> {
  const targets = ids;
  const tally: CorroborationTally = { corroborated: 0, corroboration_rejected: 0, corroboration_credits: 0, newsroom_pages: 0 };
  await pool(targets, 10, async (id) => {
    const outcome = await corroborateRecord(handle, client, id, { broad: true }).catch((error: unknown) => {
      if (error instanceof RecordGone) return null;
      throw error;
    });
    if (!outcome) return;
    tally.corroborated += 1;
    tally.corroboration_rejected += outcome.rejected;
    tally.newsroom_pages += outcome.newsroom;
    tally.corroboration_credits += outcome.creditsEstimated;
  });
  return { ...tally, targets };
}

export interface AgentTally {
  gap_filled: number;
  deep_dives: number;
  agent_credits: number;
}

/** At the auto rung, every new record still in review gets one gap-fill run. Serial: agent runs are heavy. */
export async function gapFillForPlan(handle: Db, client: NativeWebClient, plan: CoveragePlan, insertedIds: string[]): Promise<AgentTally> {
  const tally: AgentTally = { gap_filled: 0, deep_dives: 0, agent_credits: 0 };
  if (plan.agent.gapFill !== "auto" || insertedIds.length === 0) return tally;
  const { rows } = await listRounds(handle, { ids: insertedIds, includeReview: true, limit: insertedIds.length });
  for (const row of rows.filter((r) => r.disposition === "review")) {
    const outcome = await researchRound(handle, client, row.id);
    tally.gap_filled += 1;
    tally.agent_credits += outcome.creditsUsed ?? GAP_FILL_CREDITS;
  }
  return tally;
}

/** A company the dossier lane works on: dive it (no dossier yet, or one a newer round has outdated), or check the dossier it has (one written before the check). */
export interface DossierTarget {
  companyId: string;
  action: "dive" | "reverify";
}

/** How long a company whose dive failed rests before an automatic pass dives it again. */
export const DIVE_COOLDOWN_DAYS = 7;
/** A dive the check rejected (another company, or one it could not place) is likely to be rejected again: it rests longer. */
export const REJECTED_COOLDOWN_DAYS = 30;
/** An open dive row younger than this is a dive still working (the durable wait gives up after about half an hour). */
export const DIVE_IN_FLIGHT_MINUTES = 60;

/**
 * Companies an automatic pass leaves alone for now: a dive failed in the last week, the check
 * rejected one in the last month, or one is still working (its row open), so two passes never
 * pay for the same company at once.
 */
export async function divesResting(handle: Db, now: Date = new Date()): Promise<Set<string>> {
  const day = 86_400_000;
  const rows = await handle
    .select({ id: runs.id, error: runs.error, startedAt: runs.startedAt, finishedAt: runs.finishedAt })
    .from(runs)
    .where(and(eq(runs.presetSlug, "deep-dive"), gte(runs.startedAt, new Date(now.getTime() - REJECTED_COOLDOWN_DAYS * day))));
  const out = new Set<string>();
  for (const r of rows) {
    const age = now.getTime() - new Date(r.startedAt).getTime();
    const resting = r.error
      ? r.error.startsWith("dossier rejected") || age <= DIVE_COOLDOWN_DAYS * day
      : r.finishedAt === null && age <= DIVE_IN_FLIGHT_MINUTES * 60_000;
    // The run id is deepdive:<company id>:<epoch ms>; a company id may itself hold a colon.
    if (resting) out.add(r.id.replace(/^deepdive:/, "").replace(/:\d+$/, ""));
  }
  return out;
}

/**
 * Every company with a dossier row, and where it stands: checked and current, checked but outdated
 * by a round first recorded after it was written (it cannot know the round, and its "why it
 * matters" and total read from before it), or written before the check. Only a feed round that is
 * not history counts: history rows are promoted out of the dossier itself, so they never outdate it.
 */
export type DossierState = "verified" | "stale" | "legacy";

export async function dossierStates(handle: Db, companyIds: string[]): Promise<Map<string, DossierState>> {
  if (companyIds.length === 0) return new Map();
  const [dossiers, newest] = await Promise.all([
    handle
      .select({ companyId: enrichments.companyId, fetchedAt: enrichments.fetchedAt, verified: sql<boolean>`${verifiedDossierSql}` })
      .from(enrichments)
      .where(and(eq(enrichments.kind, "deep_dive"), inArray(enrichments.companyId, companyIds))),
    handle
      .select({ companyId: fundingRounds.companyId, firstSeen: max(fundingRounds.firstSeenAt) })
      .from(fundingRounds)
      .where(
        and(
          inArray(fundingRounds.companyId, companyIds),
          inArray(fundingRounds.disposition, ["publish", "flagged"]),
          eq(fundingRounds.history, false),
        ),
      )
      .groupBy(fundingRounds.companyId),
  ]);
  const latest = new Map(newest.map((r) => [r.companyId, r.firstSeen ? new Date(r.firstSeen).getTime() : 0]));
  return new Map(
    dossiers.map((d): [string, DossierState] => {
      if (!d.verified) return [d.companyId, "legacy"];
      return [d.companyId, (latest.get(d.companyId) ?? 0) > new Date(d.fetchedAt).getTime() ? "stale" : "verified"];
    }),
  );
}

/**
 * Which of the new records' companies the rung works on: none, those over the threshold, or all.
 * A company with a current checked dossier is skipped, one with an unchecked dossier is checked (no
 * new agent run), one resting after a failed dive waits, and the rest are dived: no dossier yet, or
 * one the round just recorded has outdated.
 */
export async function deepDiveTargets(
  handle: Db,
  plan: CoveragePlan,
  insertedIds: string[],
  now: Date = new Date(),
): Promise<DossierTarget[]> {
  if (plan.agent.deepDive === "manual" || insertedIds.length === 0) return [];
  const { rows } = await listRounds(handle, { ids: insertedIds, includeReview: true, limit: insertedIds.length });
  const eligible = rows.filter((r) =>
    plan.agent.deepDive === "all" ? true : r.amount.usd_millions !== null && r.amount.usd_millions >= plan.agent.deepDiveMinUsdMillions,
  );
  const companyIds = [...new Set(eligible.map((r) => r.company.id))];
  const [states, resting] = await Promise.all([dossierStates(handle, companyIds), divesResting(handle, now)]);
  return companyIds.flatMap((companyId): DossierTarget[] => {
    const state = states.get(companyId);
    if (state === "verified") return [];
    if (state === "legacy") return [{ companyId, action: "reverify" }];
    return resting.has(companyId) ? [] : [{ companyId, action: "dive" }];
  });
}

/** The companies a visitor can reach (a publish or flagged round), each with its newest round's day and when it was first seen. */
async function visibleCompanies(handle: Db): Promise<Array<{ id: string; latest: string | null; firstSeen: Date }>> {
  const rows = await handle
    .select({
      id: companies.id,
      latest: sql<string | null>`max(${fundingRounds.announcedOn})`,
      firstSeen: companies.firstSeenAt,
    })
    .from(companies)
    .innerJoin(fundingRounds, eq(fundingRounds.companyId, companies.id))
    .where(inArray(fundingRounds.disposition, ["publish", "flagged"]))
    .groupBy(companies.id, companies.firstSeenAt);
  return rows.map((r) => ({ id: r.id, latest: r.latest, firstSeen: new Date(r.firstSeen) }));
}

export interface DossierCoverage {
  /** Companies with a publish or flagged round. */
  visible: number;
  verified: number;
  /** Checked, but a round recorded since has outdated them: queued for a fresh dive. */
  stale: number;
  /** Dossiers written before the check: stored, hidden from visitors until checked. */
  unchecked: number;
  missing: number;
  /** Missing, but resting after a failed or rejected dive. */
  resting: number;
}

export async function dossierCoverage(handle: Db, now: Date = new Date()): Promise<DossierCoverage> {
  const visible = await visibleCompanies(handle);
  const ids = visible.map((c) => c.id);
  const [states, resting] = await Promise.all([dossierStates(handle, ids), divesResting(handle, now)]);
  const verified = ids.filter((id) => states.get(id) === "verified").length;
  const stale = ids.filter((id) => states.get(id) === "stale").length;
  const unchecked = ids.filter((id) => states.get(id) === "legacy").length;
  const missingIds = ids.filter((id) => !states.has(id));
  return {
    visible: ids.length,
    verified,
    stale,
    unchecked,
    missing: missingIds.length,
    resting: missingIds.filter((id) => resting.has(id)).length,
  };
}

/**
 * What the backfill works through: every visible company's unchecked dossier first (a check, no
 * agent run), then the visible companies with none or an outdated one (a dive), each group newest
 * round first.
 * `limit` caps each group, so a pilot of five checks five and dives five. Companies resting after
 * a failed dive are left out.
 */
export async function backfillTargets(
  handle: Db,
  opts: { limit?: number | null; reverifyOnly?: boolean; now?: Date } = {},
): Promise<DossierTarget[]> {
  const visible = (await visibleCompanies(handle)).sort(
    (a, b) => (b.latest ?? "").localeCompare(a.latest ?? "") || b.firstSeen.getTime() - a.firstSeen.getTime() || a.id.localeCompare(b.id),
  );
  const ids = visible.map((c) => c.id);
  const [states, resting] = await Promise.all([dossierStates(handle, ids), divesResting(handle, opts.now)]);
  const cap = (list: string[]) => (opts.limit ? list.slice(0, opts.limit) : list);
  const reverify = cap(ids.filter((id) => states.get(id) === "legacy")).map((companyId) => ({ companyId, action: "reverify" as const }));
  if (opts.reverifyOnly) return reverify;
  const dive = cap(ids.filter((id) => (!states.has(id) || states.get(id) === "stale") && !resting.has(id))).map((companyId) => ({
    companyId,
    action: "dive" as const,
  }));
  return [...reverify, ...dive];
}

/**
 * The Max rung's backlog: visible companies still without a current checked dossier, oldest
 * first, `limit` a sweep. An unchecked dossier is checked rather than dived again; companies this sweep already
 * works on, or resting after a failed dive, are skipped.
 */
export async function dossierBacklog(handle: Db, limit: number, exclude: string[] = [], now: Date = new Date()): Promise<DossierTarget[]> {
  if (limit <= 0) return [];
  const visible = (await visibleCompanies(handle)).sort(
    (a, b) => a.firstSeen.getTime() - b.firstSeen.getTime() || a.id.localeCompare(b.id),
  );
  const skip = new Set(exclude);
  const ids = visible.map((c) => c.id).filter((id) => !skip.has(id));
  const [states, resting] = await Promise.all([dossierStates(handle, ids), divesResting(handle, now)]);
  const out: DossierTarget[] = [];
  for (const id of ids) {
    if (out.length >= limit) break;
    const state = states.get(id);
    if (state === "verified") continue;
    if (state === "legacy") out.push({ companyId: id, action: "reverify" });
    else if (!resting.has(id)) out.push({ companyId: id, action: "dive" });
  }
  return out;
}

export interface DossierBackfillParams {
  /** Per group: at most this many checks and this many dives. Null for all. */
  limit: number | null;
  concurrency: number;
  /** No new dive starts once the credits spent reach this. */
  maxTotalCredits: number;
  /** Check dossiers written before the check; never dive. */
  reverifyOnly: boolean;
}

export const BACKFILL_DEFAULTS = { concurrency: 20, maxTotalCredits: 250_000 } as const;

/** The backfill route's params from a query string or a JSON body; an error names the bad one. Pure. */
export function parseBackfillParams(input: Record<string, unknown>): DossierBackfillParams | { error: string } {
  const int = (key: string, fallback: number | null, min: number, max: number): number | null | { error: string } => {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return { error: `${key} must be a whole number from ${min} to ${max}` };
    return n;
  };
  const limit = int("limit", null, 1, 10_000);
  const concurrency = int("concurrency", BACKFILL_DEFAULTS.concurrency, 1, 100);
  const maxTotalCredits = int("maxTotalCredits", BACKFILL_DEFAULTS.maxTotalCredits, 0, 10_000_000);
  for (const v of [limit, concurrency, maxTotalCredits]) if (v !== null && typeof v === "object") return v;
  const flag = input.reverifyOnly;
  const reverifyOnly = flag === true || flag === 1 || flag === "1" || flag === "true";
  return { limit: limit as number | null, concurrency: concurrency as number, maxTotalCredits: maxTotalCredits as number, reverifyOnly };
}
