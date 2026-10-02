// The Apollo backfill, durable: every visible company with a verified domain and no apollo row,
// looked up ten to a call, each call its own step, until the credit ceiling. It writes enrichment
// rows (and a verified logo where a company has none) and queues the funding events the store lacks
// on the history ledger as leads; it never searches them. The history backfill
// (app/api/cron/history-rounds) does, with its own concurrency and ceiling. The rules live in
// lib/apollo.ts; the route is app/api/cron/backfill-apollo.

import { type ApolloBackfillParams, type ApolloCompany, apolloBatch, pendingApollo } from "@/lib/apollo";
import { db } from "@/lib/db";
import { getFirecrawl } from "@/lib/firecrawl";
import { recordRun } from "@/lib/persist";

/** Domains per step: one bulk call. */
const PER_STEP = 10;

export interface ApolloBackfillTally {
  companies: number;
  matched: number;
  leads: number;
  credits: number;
  /** Companies left unasked because the ceiling was reached. */
  skipped_budget: number;
}

export async function backfillApolloWorkflow(params: ApolloBackfillParams, runId: string): Promise<ApolloBackfillTally> {
  "use workflow";
  const startedAt = new Date().toISOString();
  const targets = await targetsStep(params.limit);
  let tally: ApolloBackfillTally = { companies: 0, matched: 0, leads: 0, credits: 0, skipped_budget: 0 };
  await runStep(runId, startedAt, tally, false);
  for (let i = 0; i < targets.length; i += PER_STEP) {
    if (tally.credits >= params.maxCredits) {
      tally = { ...tally, skipped_budget: targets.length - i };
      break;
    }
    const r = await batchStep(targets.slice(i, i + PER_STEP), params.leads);
    tally = {
      ...tally,
      companies: tally.companies + r.companies,
      matched: tally.matched + r.matched,
      leads: tally.leads + r.leads,
      credits: tally.credits + r.credits,
    };
    await runStep(runId, startedAt, tally, false);
  }
  await runStep(runId, startedAt, tally, true);
  return tally;
}

async function targetsStep(limit: number | null): Promise<ApolloCompany[]> {
  "use step";
  return pendingApollo(await db(), null, limit ?? 100_000);
}

async function batchStep(
  batch: ApolloCompany[],
  leads: boolean,
): Promise<{ companies: number; matched: number; leads: number; credits: number }> {
  "use step";
  const r = await apolloBatch(await db(), getFirecrawl(), batch, { leads });
  return { companies: r.companies, matched: r.matched, leads: r.leads, credits: r.credits };
}

/** The run row (lane enrich): open while the backfill works, closed with its counts and credits. */
async function runStep(runId: string, startedAt: string, tally: ApolloBackfillTally, finished: boolean): Promise<void> {
  "use step";
  await recordRun(await db(), {
    id: runId,
    presetSlug: "apollo-backfill",
    lane: "enrich",
    window: null,
    startedAt: new Date(startedAt),
    finishedAt: finished ? new Date() : null,
    creditsEstimated: tally.credits,
    creditsMeasured: null,
    counts: {
      apollo: tally.companies,
      apollo_matched: tally.matched,
      apollo_leads: tally.leads,
      apollo_credits: tally.credits,
      skipped_budget: tally.skipped_budget,
    },
  });
}
