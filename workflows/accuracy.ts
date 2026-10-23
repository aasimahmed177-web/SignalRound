// The daily accuracy check, durable. One step reads the companies that matter most and records the
// flags (DB reads and a few writes, no credits); then, under the caps, the safe remedies: each profile
// refresh is its own step (a few credits, verified before anything is written), and the deep dives
// and the company timelines start as their own workflows, which record their own rows on Runs. The last step
// writes this run's row with its counts. The rules live in packages/core/src/records/accuracy.ts,
// the store side in lib/accuracy.ts; the route is app/api/cron/accuracy.

import { prunePageSnapshots } from "@fireround/core/snapshots";
import { start } from "workflow/api";
import {
  ACCURACY_LANE,
  type AccuracyCounts,
  type AccuracyParams,
  evaluateAccuracy,
  markRemedied,
  planRemedies,
  type RemedyTarget,
  recordAccuracy,
  refreshProfile,
} from "@/lib/accuracy";
import { db } from "@/lib/db";
import { dossierCheckAvailable } from "@/lib/dossier-check";
import { invalidateEntityPages } from "@/lib/entity-invalidation";
import { divesResting } from "@/lib/intel";
import { recordRun } from "@/lib/persist";
import { getCoverage } from "@/lib/settings";
import { getWebClient } from "@/lib/web-client";
import { type DossierOutcome, processDossierTarget } from "@/workflows/dossiers";
import { startCompanyTimelinesStep } from "@/workflows/history";

export interface AccuracySummary extends AccuracyCounts {
  remedies_profile: number;
  profiles_verified: number;
  remedies_dossier: number;
  remedies_history: number;
  remedies_skipped: number;
  remedies_failed: number;
}

export async function accuracyWorkflow(params: AccuracyParams, runId: string): Promise<AccuracySummary> {
  "use workflow";
  const startedAt = new Date().toISOString();
  const checked = await checkStep(params.topN, startedAt);
  const summary: AccuracySummary = {
    ...checked.counts,
    remedies_profile: 0,
    profiles_verified: 0,
    remedies_dossier: 0,
    remedies_history: 0,
    remedies_skipped: 0,
    remedies_failed: 0,
  };
  let credits = 0;
  if (params.remedies) {
    const plan = await planStep(params, checked.order);
    summary.remedies_skipped = plan.skipped;
    for (const t of plan.targets) {
      if (t.remedy === "profile") {
        const r = await profileStep(t);
        summary.remedies_profile++;
        if (r.verified) summary.profiles_verified++;
        if (r.failed) summary.remedies_failed++;
        credits += r.credits;
      } else {
        const r = await dossierStep(t);
        if (r.started) summary.remedies_dossier++;
        else summary.remedies_failed++;
      }
    }
  }
  if (params.remedies) summary.remedies_history = await startCompanyTimelinesStep(checked.order, params.caps.history);
  await recordRunStep(runId, startedAt, credits, summary);
  return summary;
}

/** Evaluate and record: the flags, their clearing, and the dossier founders' memory. */
async function checkStep(topN: number, startedAt: string): Promise<{ counts: AccuracyCounts; order: string[] }> {
  "use step";
  const handle = await db();
  await prunePageSnapshots(handle).catch(() => console.warn("page snapshot retention skipped"));
  const now = new Date(startedAt);
  const evaluation = await evaluateAccuracy(handle, { topN, now });
  const counts = await recordAccuracy(handle, evaluation, now);
  return { counts, order: evaluation.checked.map((l) => l.company.id) };
}

/** The remedies due, under the caps; a dossier waits while its company rests or no model can check it. */
async function planStep(params: AccuracyParams, order: string[]): Promise<{ targets: RemedyTarget[]; skipped: number }> {
  "use step";
  const handle = await db();
  const now = new Date();
  // Without a NativeWebClient key every remedy would fail: none is started, and the flags stay for a person.
  return planRemedies(handle, params, { now, order, resting: await divesResting(handle, now), dossierCheck: dossierCheckAvailable() });
}

/** One profile refresh, verified before anything is written; a failure is noted on the flag and the run moves on. */
async function profileStep(t: RemedyTarget): Promise<{ verified: boolean; credits: number; failed: boolean }> {
  "use step";
  const handle = await db();
  try {
    const plan = await getCoverage(handle);
    const r = await refreshProfile(handle, getWebClient(), t.companyId, { pricingPage: plan.enrichment !== "homepage" });
    await markRemedied(handle, t, r.note);
    await invalidateEntityPages(handle, { companyIds: [t.companyId] });
    return { verified: r.verified, credits: r.credits, failed: false };
  } catch (err) {
    await markRemedied(handle, t, `profile refresh: failed (${err instanceof Error ? err.message : String(err)})`);
    await invalidateEntityPages(handle, { companyIds: [t.companyId] });
    return { verified: false, credits: 0, failed: true };
  }
}

/** Start the company's dive (or its dossier's check) as its own workflow; it records its own row on Runs. */
async function dossierStep(t: RemedyTarget): Promise<{ started: boolean }> {
  "use step";
  const handle = await db();
  const target = { companyId: t.companyId, action: t.action ?? "dive" };
  try {
    await start(accuracyDossierWorkflow, [target]);
    await markRemedied(handle, t, target.action === "reverify" ? "deep dive: the dossier's check started" : "deep dive: started");
    return { started: true };
  } catch (err) {
    await markRemedied(handle, t, `deep dive: not started (${err instanceof Error ? err.message : String(err)})`);
    return { started: false };
  }
}

/**
 * A dive the accuracy check asked for. The plan already checked the rest periods (a failed or
 * rejected dive, one in flight, one in the last two weeks), so it goes past the dossier lane's
 * "already checked" stand-down: a checked dossier that names no founders is dived again.
 */
export async function accuracyDossierWorkflow(target: { companyId: string; action: "dive" | "reverify" }): Promise<DossierOutcome> {
  "use workflow";
  return processDossierTarget(target, { force: true });
}

/** The run's row on Runs (lane accuracy): the counts, and the profile refreshes' credits. The dives and history passes record their own. */
async function recordRunStep(runId: string, startedAt: string, credits: number, summary: AccuracySummary): Promise<void> {
  "use step";
  await recordRun(await db(), {
    id: runId,
    presetSlug: ACCURACY_LANE,
    lane: ACCURACY_LANE,
    window: null,
    startedAt: new Date(startedAt),
    finishedAt: new Date(),
    creditsEstimated: credits,
    creditsMeasured: null,
    counts: { ...summary },
  });
}
