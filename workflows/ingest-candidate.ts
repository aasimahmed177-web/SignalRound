// A monitor alerted on a URL. Extract it, resolve it, persist it, give the plan its
// second reading (corroborate, gap-fill, deep dive), fan out.
// Steps retry on transient failure; Postgres constraints make re-runs safe.

import type { ExtractedItem, FeedRecord } from "@fireround/core";
import {
  DEFAULT_TIERS,
  extractRounds,
  fetchRates,
  firecrawlReader,
  judgeRecords,
  reconcileModel,
  reconcileRecords,
  resolveRounds,
  STAGE_BANDS,
  settleDate,
  windowStartFor,
} from "@fireround/core";
import { schema } from "@fireround/core/db";
import { and, eq } from "drizzle-orm";
import { FatalError } from "workflow";
import { db } from "@/lib/db";
import { flushDeliveries } from "@/lib/delivery";
import { invalidateEntityPages } from "@/lib/entity-invalidation";
import { type AgentTally, type CorroborationTally, corroborateForPlan, gapFillForPlan, type PersistedIds } from "@/lib/intel";
import { bumpRunCount, ensureCheckRun } from "@/lib/persist";
import { reconcileGrownRows } from "@/lib/reconcile";
import { queueNewsroomHistoryLeads } from "@/lib/request-research";
import { enqueueRouted, persistRouted, routingTable } from "@/lib/routing";
import { loadAliases, loadPublisherTiers } from "@/lib/rules";
import { getCoverage } from "@/lib/settings";
import { getWebClient } from "@/lib/web-client";
import { deepDiveTargetsStep, processDossierTargets } from "@/workflows/dossiers";
import { enrichPending, recordEnrichmentStep } from "@/workflows/enrich";
import { newRoundCompanyIdsStep, startCompanyTimelinesStep } from "@/workflows/history";

export async function ingestCandidate(
  monitorId: string,
  url: string,
  presetSlug: string,
  origin: string,
  checkId: string | null = null,
): Promise<{ records: number; queued: number }> {
  "use workflow";
  const extracted = await extractStep(url, monitorId === "manual" ? "manual" : undefined);
  if (monitorId.startsWith("company:") && (await newsroomHistoryStep(monitorId.slice(8), extracted.items))) {
    await startCompanyTimelinesStep([monitorId.slice(8)], 1, true);
  }
  const resolved = await resolveStep(extracted.items, presetSlug);
  const records = resolved.kept;
  const persisted = await persistStep(records, presetSlug, checkId ? `check:${checkId}` : `monitor:${monitorId}`);
  if (persisted.insertedIds.length > 0 && monitorId.startsWith("company:")) {
    const companyIds = await newRoundCompanyIdsStep(persisted.insertedIds);
    await startCompanyTimelinesStep(companyIds, 3, true);
  }
  const corroboration = await corroborateStep(persisted);
  // A row that gained sources in corroboration is read again with all of them before delivery, as the
  // sweep and the watch lane do: a monitor alert's page-dated row takes its release's day here.
  const rereconciled = await rereconcileStep([...persisted.insertedIds, ...persisted.changedIds]);
  const enrichment =
    persisted.inserted > 0 ? await enrichPending(presetSlug, persisted.inserted, { roundIds: persisted.insertedIds }) : null;
  const gapFill = await gapFillStep(persisted.insertedIds);
  const dossierTargets = await deepDiveTargetsStep(persisted.insertedIds);
  const queued = await deliverStep(persisted.changedByPreset, origin);
  if (checkId) {
    await recordCheckStep(monitorId, checkId, presetSlug, persisted.inserted + persisted.updated, {
      ungrounded: resolved.ungrounded,
      nonArticle: resolved.nonArticle,
      notArticle: extracted.notArticle,
      ...corroboration,
      reconciled_again: rereconciled.reconciled,
      reconcile_credits: rereconciled.credits,
      gap_filled: gapFill.gap_filled,
      // Dived after delivery, below; each dive and check has its own row with its credits.
      dossiers_queued: dossierTargets.length,
      agent_credits: gapFill.agent_credits,
    });
    if (enrichment) await recordEnrichmentStep(`check:${checkId}`, enrichment);
  }
  await markCandidateStep(monitorId, url, "extracted");
  // Last, so the round is delivered first: a dive at effort high takes minutes.
  await processDossierTargets(dossierTargets);
  return { records: persisted.inserted + persisted.updated, queued };
}

async function newsroomHistoryStep(companyId: string, items: ExtractedItem[]): Promise<number> {
  "use step";
  return queueNewsroomHistoryLeads(await db(), companyId, items);
}

/** The check this page came from shows in Runs with its credits and the records its pages produced. */
async function recordCheckStep(
  monitorId: string,
  checkId: string,
  presetSlug: string,
  records: number,
  intel: Record<string, number>,
): Promise<void> {
  "use step";
  const handle = await db();
  await ensureCheckRun(handle, checkId, presetSlug, async () => {
    const check = await getWebClient().getMonitorCheck(monitorId, checkId, { limit: 1 });
    return {
      startedAt: check.startedAt,
      estimatedCredits: check.estimatedCredits,
      actualCredits: check.actualCredits,
      totalPages: check.summary?.totalPages,
    };
  });
  await bumpRunCount(handle, `check:${checkId}`, "pages_extracted", 1);
  await bumpRunCount(handle, `check:${checkId}`, "records", records);
  for (const [key, by] of Object.entries(intel)) await bumpRunCount(handle, `check:${checkId}`, key, by);
}

/** The page's rounds, and whether the URL was declined unread as a non-article (a monitor alerts on section pages too). */
async function extractStep(url: string, query?: string): Promise<{ items: ExtractedItem[]; notArticle: number }> {
  "use step";
  const result = await extractRounds(getWebClient(), [{ url, query }], { concurrency: 1, maxAge: 0 });
  const page = result.pages[0];
  if (page && !page.ok && /\b4\d\d\b/.test(page.error ?? "")) throw new FatalError(`unrecoverable scrape: ${page.error}`);
  return { items: result.items, notArticle: result.notArticle };
}

/**
 * The kept records, and the drops that show on the check's run row: rounds the page's own text
 * never stated, and rounds read off a listing, profile, or analysis page. Every stage a preset keeps,
 * and a stageless round of any size: persist files each under the preset that keeps it, the
 * monitor's or the pasting admin's own first, so a pasted Series C or an unlabelled $75M financing
 * lands whichever preset was picked.
 */
async function resolveStep(
  items: ExtractedItem[],
  _presetSlug: string,
): Promise<{ kept: FeedRecord[]; ungrounded: number; nonArticle: number }> {
  "use step";
  const handle = await db();
  const [aliases, publisherTiers, rates, table] = await Promise.all([
    loadAliases(handle),
    loadPublisherTiers(),
    fetchRates("latest").catch(() => null),
    routingTable(handle),
  ]);
  const now = new Date();
  // The monitor already applied a 24h recency window; allow a week here so a dated article from the weekend still lands.
  const r = resolveRounds(items, {
    stages: table.stages,
    stagelessBands: STAGE_BANDS,
    windowStart: windowStartFor("week", now),
    now,
    rates,
    aliases,
    publisherTiers,
  });
  // The judge, as in the sweep: a record whose page is history or another company's does not land.
  const plan = await getCoverage(await db());
  if (!plan.judge || r.kept.length === 0) return { kept: r.kept, ungrounded: r.dropped.ungrounded, nonArticle: r.dropped.nonArticle };
  const model = reconcileModel(process.env, "feed");
  const judged = model
    ? await reconcileRecords(r.kept, firecrawlReader(getWebClient()), model, { rates, tiers: { ...DEFAULT_TIERS, ...publisherTiers } })
    : await judgeRecords(getWebClient(), r.kept, { rates, tiers: { ...DEFAULT_TIERS, ...publisherTiers } });
  const records = model ? judged.records : judged.records.map((x) => settleDate(x));
  return {
    kept: records.filter((x) => x.verification?.status !== "not_news"),
    ungrounded: r.dropped.ungrounded,
    nonArticle: r.dropped.nonArticle,
  };
}

/** Each record under the preset that keeps it, the candidate's own preset first. */
async function persistStep(
  records: FeedRecord[],
  presetSlug: string,
  runId: string,
): Promise<{ inserted: number; updated: number; changedByPreset: Record<string, string[]> } & PersistedIds> {
  "use step";
  const handle = await db();
  const s = await persistRouted(handle, records, presetSlug, runId);
  if (s.persistedIds.length) await invalidateEntityPages(handle, { roundIds: s.persistedIds });
  return {
    inserted: s.inserted,
    updated: s.updated,
    changedIds: s.changedIds,
    insertedIds: s.insertedIds,
    persistedIds: s.persistedIds,
    changedByPreset: s.changedByPreset,
  };
}

/**
 * The plan's second reading of what just landed. Corroboration first (a second source may lift a
 * row out of review before the agent is asked), then gap-fill for what is still in review. The deep
 * dive runs after delivery, a few steps per company (workflows/dossiers.ts). Each is its own step so a
 * retry repeats one play; the merges are idempotent (never overwrite, upsert the dossier).
 */
async function corroborateStep(ids: PersistedIds): Promise<CorroborationTally> {
  "use step";
  const handle = await db();
  const plan = await getCoverage(handle);
  const result = await corroborateForPlan(handle, getWebClient(), plan, ids);
  await invalidateEntityPages(handle, { roundIds: ids.persistedIds });
  return result;
}

async function rereconcileStep(ids: string[]): Promise<{ reconciled: number; credits: number }> {
  "use step";
  const model = reconcileModel(process.env, "feed");
  if (!model || ids.length === 0) return { reconciled: 0, credits: 0 };
  const handle = await db();
  const plan = await getCoverage(handle);
  if (!plan.judge) return { reconciled: 0, credits: 0 };
  const [rates, tiers] = await Promise.all([fetchRates("latest").catch(() => null), loadPublisherTiers()]);
  const result = await reconcileGrownRows(handle, getWebClient(), model, [...new Set(ids)], {
    rates,
    tiers: { ...DEFAULT_TIERS, ...tiers },
  });
  await invalidateEntityPages(handle, { roundIds: ids });
  return result;
}

async function gapFillStep(insertedIds: string[]): Promise<AgentTally> {
  "use step";
  const handle = await db();
  const plan = await getCoverage(handle);
  const result = await gapFillForPlan(handle, getWebClient(), plan, insertedIds);
  if (insertedIds.length) await invalidateEntityPages(handle, { roundIds: insertedIds });
  return result;
}

async function deliverStep(changedByPreset: Record<string, string[]>, origin: string): Promise<number> {
  "use step";
  if (Object.keys(changedByPreset).length === 0) return 0;
  const handle = await db();
  const queued = await enqueueRouted(handle, changedByPreset);
  if (queued > 0) await flushDeliveries(handle, origin);
  return queued;
}

async function markCandidateStep(monitorId: string, url: string, status: string): Promise<void> {
  "use step";
  const handle = await db();
  await handle
    .update(schema.candidates)
    .set({ status })
    .where(and(eq(schema.candidates.monitorId, monitorId), eq(schema.candidates.url, url)));
}
