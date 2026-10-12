// History rounds, durable. A checked dossier's prior round is three steps: the search (a map of the
// company's site, one search, the dossier's cited pages, ranked), the reading (one extraction per
// page, best first, until one states the round), and the read-back with persist. Each is its own
// step, so a retry repeats one move and never pays for the search twice. A round that fails past its
// step's retries is written failed on the ledger with its backoff.
//
// A dossier that passes its check starts companyHistoryWorkflow for its company, which sleeps out a
// failure's backoff and tries again. The backfill works every checked dossier with a prior round
// still to do, a few companies at a time, in fresh runs of twice as many companies as lanes, like the
// dossier backfill. The rules live in lib/history.ts.

import { schema } from "@fireround/core/db";
import { and, eq, inArray } from "drizzle-orm";
import { sleep } from "workflow";
import { start } from "workflow/api";
import { db } from "@/lib/db";
import { backfillChunk, dealLanes } from "@/lib/durable";
import { invalidateEntityPages } from "@/lib/entity-invalidation";
import { getFirecrawl } from "@/lib/firecrawl";
import {
  failPromotion,
  finishPromotion,
  firecrawlHistoryReader,
  type HistoryBackfillParams,
  type HistoryPlan,
  type HistoryReading,
  historyTargets,
  nextHistoryRetry,
  planPromotion,
  queueCompanyHistory,
  readPlan,
  recordCompanyHistoryRun,
} from "@/lib/history";
import {
  addTallies,
  emptyHistoryTally,
  failedOutcome,
  HISTORY_MAX_ATTEMPTS,
  type HistoryTally,
  type PromotionOutcome,
  skippedOutcome,
  tallyPromotion,
} from "@/lib/history-tally";
import { mergeRunCounts, recordRun } from "@/lib/persist";
import { queueCompanyTimeline, TIMELINE_RECHECK_DAYS } from "@/lib/request-research";

/** Put a company's prior rounds on the ledger; the keys due now. */
export async function queueHistoryStep(companyId: string): Promise<string[]> {
  "use step";
  return queueCompanyHistory(await db(), companyId);
}

export async function planStep(companyId: string, key: string, claimer: string, includeRecent = false): Promise<HistoryPlan> {
  "use step";
  return planPromotion(await db(), firecrawlHistoryReader(getFirecrawl()), companyId, key, claimer, new Date(), includeRecent);
}

export async function readStep(plan: HistoryPlan): Promise<HistoryReading> {
  "use step";
  return readPlan(await db(), firecrawlHistoryReader(getFirecrawl()), plan);
}

/** The read-back and persist; throws (and the step retries) when the read-back could not run. */
export async function finishStep(
  plan: HistoryPlan,
  reading: HistoryReading,
  runId: string,
  includeRecent = false,
): Promise<PromotionOutcome> {
  "use step";
  const handle = await db();
  const outcome = await finishPromotion(handle, firecrawlHistoryReader(getFirecrawl()), plan, reading, runId, new Date(), includeRecent);
  await invalidateEntityPages(handle, { companyIds: [plan.companyId], roundIds: outcome.roundId ? [outcome.roundId] : [] });
  return outcome;
}

async function failStep(companyId: string, key: string, error: string, credits: number): Promise<void> {
  "use step";
  const handle = await db();
  await failPromotion(handle, companyId, key, error, credits);
  await invalidateEntityPages(handle, { companyIds: [companyId] });
}

/**
 * One prior round through its three steps. Plain async, called from workflow bodies. A step that
 * fails past its retries writes the round failed (with this attempt's credits) and returns; the
 * caller moves on.
 */
export async function processPrior(companyId: string, key: string, runId: string, includeRecent = false): Promise<PromotionOutcome> {
  let spent = 0;
  try {
    const plan = await planStep(companyId, key, runId, includeRecent);
    if (plan.skip) return skippedOutcome(companyId, key, plan.skip);
    spent = plan.credits;
    const reading = await readStep(plan);
    spent += reading.credits;
    return await finishStep(plan, reading, runId, includeRecent);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await failStep(companyId, key, error, spent);
    return failedOutcome(companyId, key, error, spent);
  }
}

export async function recordCompanyStep(companyId: string, startedAt: string, tally: HistoryTally): Promise<void> {
  "use step";
  await recordCompanyHistoryRun(await db(), companyId, new Date(startedAt), tally);
}

/**
 * One company's due prior rounds, one after another, and its row on Runs. `budget` is what the
 * caller may still spend: a round is not started once this company's rounds have spent it.
 */
export async function processCompanyHistory(
  companyId: string,
  runId: string,
  budget = Number.POSITIVE_INFINITY,
  includeRecent = false,
): Promise<HistoryTally> {
  const startedAt = new Date().toISOString();
  const keys = await queueHistoryStep(companyId);
  let tally: HistoryTally = { ...emptyHistoryTally(), companies: 1 };
  if (keys.length === 0) return tally;
  for (const key of keys) {
    if (tally.credits >= budget) {
      tally = { ...tally, skipped_budget: tally.skipped_budget + 1 };
      continue;
    }
    tally = tallyPromotion(tally, await processPrior(companyId, key, runId, includeRecent));
  }
  await recordCompanyStep(companyId, startedAt, tally);
  return tally;
}

async function nextRetryStep(companyId: string): Promise<string | null> {
  "use step";
  return nextHistoryRetry(await db(), companyId);
}

/**
 * How long a forced timeline (a new round just landed) waits before it searches. The lane that landed
 * the round enriches next, and enrichment folds a new company into the row that already owns its
 * domain: in the week to October 11, 2026, 309 timelines read a company that was folded within 15 minutes of the start.
 * After the wait, a folded company is gone and its timeline costs nothing.
 */
export const TIMELINE_SETTLE = "15m";

/**
 * A newly checked dossier's prior rounds. A failure waits out its backoff (1 hour, 6 hours, a day)
 * in a durable sleep and is tried again, HISTORY_MAX_ATTEMPTS tries in all.
 */
export async function companyHistoryWorkflow(companyId: string, includeRecent = false, forceTimeline = false): Promise<HistoryTally> {
  "use workflow";
  if (forceTimeline) await sleep(TIMELINE_SETTLE);
  await timelineStep(companyId, forceTimeline);
  return processCompanyHistoryWithRetries(companyId, includeRecent);
}

export async function timelineStep(companyId: string, force = false): Promise<void> {
  "use step";
  await queueCompanyTimeline(await db(), firecrawlHistoryReader(getFirecrawl()), companyId, new Date(), force);
}

export async function startCompanyTimelinesStep(companyIds: string[], limit: number, force = false): Promise<number> {
  "use step";
  if (!process.env.FIRECRAWL_API_KEY || limit <= 0 || companyIds.length === 0) return 0;
  const handle = await db();
  const rows = await handle
    .select()
    .from(schema.runs)
    .where(
      inArray(
        schema.runs.id,
        companyIds.map((id) => `history-timeline:${id}`),
      ),
    );
  const now = Date.now();
  const resting = new Set(
    rows
      .filter((r) =>
        r.finishedAt
          ? !force && r.finishedAt.getTime() > now - TIMELINE_RECHECK_DAYS * 86_400_000
          : r.startedAt.getTime() > now - 30 * 60_000,
      )
      .map((r) => r.id),
  );
  const due = [...new Set(companyIds)].filter((id) => !resting.has(`history-timeline:${id}`)).slice(0, limit);
  for (const id of due) await start(companyHistoryWorkflow, force ? [id, false, true] : [id]);
  return due.length;
}

/** The companies a new non-history round just landed for, for a forced timeline refresh. */
export async function newRoundCompanyIdsStep(roundIds: string[]): Promise<string[]> {
  "use step";
  if (roundIds.length === 0) return [];
  const rows = await (await db())
    .select({ companyId: schema.fundingRounds.companyId })
    .from(schema.fundingRounds)
    .where(and(inArray(schema.fundingRounds.id, roundIds), eq(schema.fundingRounds.history, false)));
  return [...new Set(rows.map((row) => row.companyId))];
}

/**
 * A request does not wait out a failed round's backoff: when one is due again later, the company's
 * own pass takes over the retries, recovering recent rounds as the request would.
 */
export async function scheduleHistoryRetryStep(companyId: string): Promise<boolean> {
  "use step";
  if (!(await nextHistoryRetry(await db(), companyId))) return false;
  await start(companyHistoryWorkflow, [companyId, true]);
  return true;
}

/** Await every due history pass inside a caller's durable workflow. */
export async function processCompanyHistoryWithRetries(companyId: string, includeRecent = false): Promise<HistoryTally> {
  const runId = `history:${companyId}:${Date.now()}`;
  let tally = await processCompanyHistory(companyId, runId, Number.POSITIVE_INFINITY, includeRecent);
  for (let pass = 1; pass < HISTORY_MAX_ATTEMPTS; pass++) {
    const next = await nextRetryStep(companyId);
    if (!next) break;
    await sleep(new Date(next));
    tally = addTallies(tally, await processCompanyHistory(companyId, runId, Number.POSITIVE_INFINITY, includeRecent));
  }
  return tally;
}

/**
 * The hook a checked dossier calls: queue its prior rounds and, when any is due, start the company's
 * own pass. The caller does not wait on the searches.
 */
export async function queueCompanyHistoryStep(companyId: string): Promise<boolean> {
  "use step";
  const due = await queueCompanyHistory(await db(), companyId);
  if (due.length === 0) return false;
  await start(companyHistoryWorkflow, [companyId]);
  return true;
}

/** What a backfill run hands to the next: the day it began, the companies still to work, and the counts so far. */
export interface HistoryCarry {
  startedAt: string;
  targets: string[];
  tally: HistoryTally;
}

/**
 * The backfill: every checked dossier with a prior round still to do, newest round first,
 * `concurrency` companies at a time. No company starts once the credits spent reach
 * `maxTotalCredits`. A run works backfillChunk(concurrency) companies (twice the lanes), then starts a fresh run with the rest and
 * its counts. The parent row on Runs (lane history) carries the running counts; each company also
 * records its own row with its credits. A failed round is left on its backoff for the next run.
 */
export async function backfillHistoryWorkflow(params: HistoryBackfillParams, runId: string, carry?: HistoryCarry): Promise<HistoryTally> {
  "use workflow";
  const startedAt = carry?.startedAt ?? new Date().toISOString();
  const targets = carry?.targets ?? (await historyTargetsStep(params));
  let tally = carry?.tally ?? emptyHistoryTally();
  if (!carry) await parentRunStep(runId, startedAt, tally, false);
  const batch = targets.slice(0, backfillChunk(params.concurrency));
  const rest = targets.slice(backfillChunk(params.concurrency));
  await Promise.all(
    dealLanes(batch, params.concurrency).map(async (lane) => {
      for (const companyId of lane) {
        if (tally.credits >= params.maxTotalCredits) {
          tally = { ...tally, skipped_budget: tally.skipped_budget + 1 };
          continue;
        }
        const company = await processCompanyHistory(companyId, runId, params.maxTotalCredits - tally.credits);
        tally = addTallies(tally, company);
        await progressStep(runId, tally);
      }
    }),
  );
  // Past the ceiling nothing more is started: the companies left are counted, not carried.
  if (tally.credits >= params.maxTotalCredits) {
    tally = { ...tally, skipped_budget: tally.skipped_budget + rest.length };
  } else if (rest.length > 0) {
    await continueBackfillStep(params, runId, { startedAt, targets: rest, tally });
    return tally;
  }
  await parentRunStep(runId, startedAt, tally, true);
  return tally;
}

async function historyTargetsStep(params: HistoryBackfillParams): Promise<string[]> {
  "use step";
  return historyTargets(await db(), { limit: params.limit });
}

/** Start the next backfill run with what is left. The parent row stays open until the last run closes it. */
async function continueBackfillStep(params: HistoryBackfillParams, runId: string, carry: HistoryCarry): Promise<void> {
  "use step";
  await mergeRunCounts(await db(), runId, { ...carry.tally });
  await start(backfillHistoryWorkflow, [params, runId, carry]);
}

/** The parent row: open when the backfill starts, closed with its counts when it ends. Credits sit in counts, since each company's row carries them. */
async function parentRunStep(runId: string, startedAt: string, tally: HistoryTally, finished: boolean): Promise<void> {
  "use step";
  await recordRun(await db(), {
    id: runId,
    presetSlug: "history-backfill",
    lane: "history",
    window: null,
    startedAt: new Date(startedAt),
    finishedAt: finished ? new Date() : null,
    creditsEstimated: null,
    creditsMeasured: null,
    counts: { ...tally },
  });
}

async function progressStep(runId: string, tally: HistoryTally): Promise<void> {
  "use step";
  await mergeRunCounts(await db(), runId, { ...tally });
}
