// Corroborate the backlog: rows that hold no page from the company's own site get a second reading
// (the site mapped for its release, one search, the best pages extracted), newest first, up to a limit.
// Sweeps corroborate what they write; this exists to bring a store built before a rule up to it.

import { DEFAULT_TIERS, fetchRates } from "@fireround/core";
import { corroborateModel, corroborateRecord, promoteCheckedRound } from "@/lib/corroborate";
import { db } from "@/lib/db";
import { enqueueDeliveries } from "@/lib/delivery";
import { invalidateEntityPages } from "@/lib/entity-invalidation";
import { listRounds, recordRun } from "@/lib/persist";
import { grownRows, reconcileGrownRows } from "@/lib/reconcile";
import {
  claimRoundVerification,
  completeRoundVerification,
  evidenceComplete,
  finishRoundVerification,
  investorDomainsForRound,
  seedRoundVerification,
} from "@/lib/round-verification";
import { loadPublisherTiers } from "@/lib/rules";
import { getCoverage } from "@/lib/settings";
import { getWebClient } from "@/lib/web-client";

const BATCH = 6;

export async function corroborateBacklogWorkflow(
  presetSlug: string,
  runId: string,
  limit: number,
): Promise<{ corroborated: number; newsroom: number; credits: number }> {
  "use workflow";
  const startedAt = new Date().toISOString();
  const ids = await backlogStep(presetSlug, limit);
  let corroborated = 0;
  let newsroom = 0;
  let credits = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const r = await corroborateStep(ids.slice(i, i + BATCH));
    corroborated += r.corroborated;
    newsroom += r.newsroom;
    credits += r.credits;
  }
  await recordStep(runId, presetSlug, startedAt, credits, { corroborated, newsroom_pages: newsroom });
  return { corroborated, newsroom, credits };
}

/** Rows of this preset with no source on the company's own domain, newest first. */
export async function backlogStep(presetSlug: string, limit: number): Promise<string[]> {
  "use step";
  const handle = await db();
  const out: string[] = [];
  let cursor: string | undefined;
  while (out.length < limit) {
    const page = await listRounds(handle, { preset: presetSlug, includeReview: true, limit: 200, cursor });
    for (const row of page.rows) {
      if (row.disposition === "rejected") continue;
      const own = row.company.domain;
      if (own && row.sources.some((s) => s.host.replace(/^www\./, "").endsWith(own))) continue;
      out.push(row.id);
      if (out.length >= limit) break;
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

export async function corroborateStep(
  ids: string[],
  scheduled = false,
  claimer?: string,
): Promise<{ corroborated: number; newsroom: number; credits: number }> {
  "use step";
  const handle = await db();
  const client = getWebClient();
  let newsroom = 0;
  let credits = 0;
  const grew: string[] = [];
  const spent = new Map<string, number>();
  const tiers = { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
  for (const id of ids) {
    try {
      let unreadSources = false;
      if (scheduled) {
        const { rows } = await listRounds(handle, { ids: [id], includeReview: true, certainty: "all", limit: 1 });
        if (!rows[0]) continue;
        unreadSources = grownRows(rows).length > 0;
        const investorDomains = await investorDomainsForRound(handle, id);
        if (
          rows[0].certainty !== "unconfirmed" &&
          evidenceComplete(rows[0], investorDomains, tiers) &&
          !unreadSources &&
          rows[0].freshness_checked_on === rows[0].announced_on
        ) {
          await promoteCheckedRound(handle, id, investorDomains, tiers);
          await completeRoundVerification(handle, id, new Date(), claimer);
          continue;
        }
      }
      const outcome = await corroborateRecord(handle, client, id, { broad: scheduled, tiers });
      newsroom += outcome.newsroom;
      credits += outcome.creditsEstimated;
      spent.set(id, outcome.creditsEstimated);
      if ((outcome.added.sources > 0 || unreadSources) && !outcome.reviewConflict) grew.push(id);
    } catch (error) {
      if (!scheduled) throw error;
      const { rows } = await listRounds(handle, { ids: [id], includeReview: true, certainty: "all", limit: 1 });
      if (rows[0])
        await finishRoundVerification(
          handle,
          rows[0],
          0,
          await investorDomainsForRound(handle, id),
          tiers,
          new Date(),
          error instanceof Error ? error.name : "unknown",
          claimer,
        );
    }
  }
  // A row that gained sources is read again with all of them in view, as in the sweep.
  const model = corroborateModel();
  if (model && grew.length > 0) {
    const plan = await getCoverage(handle);
    if (plan.judge) {
      const rates = await fetchRates("latest").catch(() => null);
      const r = await reconcileGrownRows(handle, client, model, grew, { rates, tiers });
      credits += r.credits;
    }
  }
  if (scheduled) for (const id of grew) await promoteCheckedRound(handle, id, await investorDomainsForRound(handle, id), tiers);
  if (scheduled)
    for (const [id, cost] of spent) {
      const { rows } = await listRounds(handle, { ids: [id], includeReview: true, certainty: "all", limit: 1 });
      if (rows[0])
        await finishRoundVerification(handle, rows[0], cost, await investorDomainsForRound(handle, id), tiers, new Date(), null, claimer);
    }
  for (const id of ids) {
    const { rows } = await listRounds(handle, { ids: [id], includeReview: true, certainty: "all", limit: 1 });
    const row = rows[0];
    if (
      row?.certainty === "announced" &&
      row.reported_on &&
      row.freshness_checked_on === row.announced_on &&
      ["confirmed", "corrected"].includes(row.verification?.status ?? "") &&
      Math.max(row.verification?.sources_seen ?? 0, row.verification?.sources_listed ?? 0) >= row.sources.length
    ) {
      await enqueueDeliveries(handle, [id], row.preset_slug);
    }
  }
  if (ids.length) await invalidateEntityPages(handle, { roundIds: ids });
  return { corroborated: ids.length, newsroom, credits };
}

/** Capped follow-up independent of sweep cadence. Claims survive restarts and expire after an hour. */
export async function verifyRoundsWorkflow(runId: string, limit = 12): Promise<{ checked: number; credits: number }> {
  "use workflow";
  const startedAt = new Date().toISOString();
  const ids = await claimDueStep(runId, limit);
  let credits = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const result = await corroborateStep(ids.slice(i, i + BATCH), true, runId);
    credits += result.credits;
  }
  await recordStep(runId, "verification", startedAt, credits, { checked: ids.length });
  return { checked: ids.length, credits };
}

async function claimDueStep(runId: string, limit: number): Promise<string[]> {
  "use step";
  const handle = await db();
  await seedRoundVerification(handle);
  return claimRoundVerification(handle, runId, Math.min(40, Math.max(1, limit)));
}

async function recordStep(
  runId: string,
  presetSlug: string,
  startedAt: string,
  credits: number,
  counts: Record<string, number>,
): Promise<void> {
  "use step";
  const handle = await db();
  await recordRun(handle, {
    id: runId,
    presetSlug,
    lane: "corroborate",
    startedAt: new Date(startedAt),
    finishedAt: new Date(),
    creditsEstimated: credits,
    counts,
  });
}
