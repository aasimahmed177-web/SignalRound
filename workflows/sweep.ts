// The sweep as a durable run: search, extract in batches, resolve, persist,
// corroborate, gap-fill and deep-dive per the plan, record the run, queue and flush deliveries. Each step retries on its own;
// the run survives a redeploy mid-way.
//
// One workflow run carries the whole tick: the presets sweep one after another inside it,
// so each job's measured credits (the account's drop during its span) are its own.

import type { Candidate, ExtractedItem, FeedRecord, RateTable, WindowSpec } from "@fireround/core";
import {
  DEFAULT_TIERS,
  extractRounds,
  fetchRates,
  firecrawlReader,
  judgeRecords,
  parseWindow,
  reconcileModel,
  reconcileRecords,
  resolveRounds,
  searchCandidates,
  settleDate,
  sweepResolveOptions,
} from "@fireround/core";
import { estimateSweep } from "@/lib/coverage";
import { measuredCredits } from "@/lib/credits";
import { db } from "@/lib/db";
import { flushDeliveries } from "@/lib/delivery";
import { invalidateEntityPages } from "@/lib/entity-invalidation";
import type { DossierTarget } from "@/lib/intel";
import { type AgentTally, type CorroborationTally, corroborateForPlan, gapFillForPlan, type PersistedIds } from "@/lib/intel";
import { screenWithJev } from "@/lib/jev-shadow";
import { recordReads, sweepMonitorId, unseenCandidates } from "@/lib/lanes";
import { mergeRunCounts, recordRun } from "@/lib/persist";
import { loadPreset } from "@/lib/presets";
import { reconcileGrownRows } from "@/lib/reconcile";
import { enqueueRouted, persistRouted, routingTable } from "@/lib/routing";
import { loadAliases, loadPublisherTiers } from "@/lib/rules";
import { getCoverage } from "@/lib/settings";
import { getWebClient } from "@/lib/web-client";
import { deepDiveTargetsStep, dossierBacklogStep, processDossierTargets } from "@/workflows/dossiers";
import { enrichPending } from "@/workflows/enrich";
import { newRoundCompanyIdsStep, startCompanyTimelinesStep } from "@/workflows/history";

/** Enrichment per sweep is bounded: new records plus a little backlog, never the whole store at once. */
const ENRICH_CAP = 40;
const ENRICH_SLACK = 10;

const BATCH = 12;

export interface SweepSummary {
  runId: string;
  results: number;
  pages: number;
  rounds: number;
  records: number;
  inserted: number;
  updated: number;
  creditsEstimated: number;
  creditsMeasured: number | null;
  queued: number;
}

export interface SweepJob {
  presetSlug: string;
  window: WindowSpec;
  runId: string;
}

/** The tick's jobs, in order: runSweep is plain async (no directive), so the workflow body only stitches steps. */
export async function sweepWorkflow(jobs: SweepJob[], origin: string): Promise<SweepSummary[]> {
  "use workflow";
  const summaries: SweepSummary[] = [];
  const dossierQueue: DossierTarget[] = [];
  for (const job of jobs) {
    const jobStartedAt = new Date().toISOString();
    try {
      summaries.push(await runSweep(job, origin, dossierQueue));
    } catch (err) {
      // One preset's failure must not skip the presets behind it; the failed job still gets a row on /runs.
      await recordRunStep({
        id: job.runId,
        presetSlug: job.presetSlug,
        lane: "sweep",
        window: job.window,
        startedAt: jobStartedAt,
        finished: true,
        creditsMeasured: null,
        counts: {},
        error: String(err).slice(0, 500),
      });
    }
  }
  // The dossier lane runs last, once every preset's rounds are recorded and delivered: a dive at
  // effort high takes minutes, and a new round's delivery should not wait on one. The companies the
  // sweeps queued come first, then (on the Max rung) a few from the backlog of visible companies still
  // without a checked dossier. Each dive and check records its own row on Runs.
  try {
    const queued = [...new Map(dossierQueue.map((t) => [t.companyId, t])).values()];
    const backlog = await dossierBacklogStep(queued.map((t) => t.companyId));
    await processDossierTargets([...queued, ...backlog]);
  } catch {
    // Housekeeping: a failure here must not fail the tick, and the next tick picks the companies up again.
  }
  return summaries;
}

/**
 * `window` is the spec string ("day", "week", "month", "month-2"), parsed in each step with
 * `parseWindow`; a month is measured from `startedAt`, so search and resolve agree on which
 * calendar month "month-2" names even when the run crosses the first of a month.
 */
async function runSweep(job: SweepJob, origin: string, dossierQueue: DossierTarget[] = []): Promise<SweepSummary> {
  const { presetSlug, window, runId } = job;
  const startedAt = new Date().toISOString();
  // The run row lands before the work does, so /runs shows a RUNNING line while the sweep is in flight.
  await recordRunStep({
    id: runId,
    presetSlug,
    lane: "sweep",
    window,
    startedAt,
    finished: false,
    creditsMeasured: null,
    counts: {},
  });
  const before = await creditsStep();
  const search = await searchStep(presetSlug, window, startedAt);
  const items: ExtractedItem[] = [];
  let pages = 0;
  let extractionCredits = 0;
  let notArticle = search.notArticle;
  for (let i = 0; i < search.candidates.length; i += BATCH) {
    const batch = await extractStep(search.candidates.slice(i, i + BATCH));
    items.push(...batch.items);
    pages += batch.pages;
    extractionCredits += batch.credits;
    notArticle += batch.notArticle;
    await markReadStep(presetSlug, window, batch.okUrls, batch.failedUrls, runId);
  }
  // What the sweep has gathered so far: the running row reads as progress, not zeros.
  await progressStep(runId, {
    search_results: search.results,
    unique_urls: search.candidates.length,
    seen_skipped: search.seenSkipped,
    pages_extracted: pages,
    rounds_extracted: items.length,
  });
  const rates = await ratesStep();
  const resolved = await resolveStep(items, window, rates, startedAt);
  // The second reading: each record against its primary page, with the record in hand. A page that
  // recalls the round as history or is not about a round drops the record here.
  const judged = await judgeStep(resolved.kept, rates);
  const records = judged.records;
  const persisted = await persistStep(records, presetSlug, runId);
  if (persisted.insertedIds.length > 0) {
    await startCompanyTimelinesStep(await newRoundCompanyIdsStep(persisted.insertedIds), 3, true);
  }
  const corroboration = await corroborateStep(persisted);
  // A row that gained sources in corroboration is read again with all of them in view.
  const rereconciled = await rereconcileStep([...persisted.insertedIds, ...persisted.changedIds], rates);
  const gapFill = await gapFillStep(persisted.insertedIds);
  // The companies the rung dives are queued for the end of the tick (sweepWorkflow), after delivery.
  const dossierTargets = await deepDiveTargetsStep(persisted.insertedIds);
  dossierQueue.push(...dossierTargets);
  // New companies get their homepage read now, so the feed shows a logo and a description on first view.
  // Investor logos ride along for the rounds this sweep persisted (and the companies it enriches).
  const enrichment = await enrichPending(presetSlug, Math.min(ENRICH_CAP, persisted.inserted + persisted.updated + ENRICH_SLACK), {
    roundIds: [...persisted.insertedIds, ...persisted.changedIds],
  });
  const after = await creditsStep();
  const creditsEstimated =
    search.credits +
    extractionCredits +
    judged.credits +
    rereconciled.credits +
    corroboration.corroboration_credits +
    gapFill.agent_credits +
    enrichment.credits +
    enrichment.alexandriaCredits +
    enrichment.investorCredits;
  const creditsMeasured = measuredCredits(before, after);
  await recordRunStep({
    id: runId,
    presetSlug,
    lane: "sweep",
    window,
    startedAt,
    finished: true,
    creditsEstimated,
    creditsMeasured,
    counts: {
      search_results: search.results,
      unique_urls: search.candidates.length,
      // Result URLs this preset's sweep read on this window within the ledger's days, not read again.
      seen_skipped: search.seenSkipped,
      pages_extracted: pages,
      rounds_extracted: items.length,
      records: records.length,
      inserted: persisted.inserted,
      updated: persisted.updated,
      unchanged: persisted.unchanged,
      // Records no preset keeps (a stage no preset lists), left out.
      unrouted: persisted.unrouted,
      // Every drop reason as its own count: otherStage, background, rumor, outOfWindow, undatedTimeline, ungrounded, nonArticle, unnamed, unrelatedSource.
      ...resolved.dropped,
      // Result URLs declined before extraction (site roots, section indexes, paginated lists, directory hosts).
      notArticle,
      judged: judged.judged,
      judge_confirmed: judged.confirmed,
      judge_corrected: judged.corrected,
      judge_not_news: judged.notNews,
      judge_contradicted: judged.contradicted,
      judge_credits: judged.credits,
      reconciled_again: rereconciled.reconciled,
      reconcile_credits: rereconciled.credits,
      ...corroboration,
      gap_filled: gapFill.gap_filled,
      // Queued for the end of the tick; each dive and check has its own row with its credits.
      dossiers_queued: dossierTargets.length,
      agent_credits: gapFill.agent_credits,
      enriched: enrichment.companies,
      enrichment_credits: enrichment.credits,
      alexandria: enrichment.alexandria,
      alexandria_credits: enrichment.alexandriaCredits,
      investor_domains: enrichment.investorDomains,
      investor_domains_resolved: enrichment.investorDomainsResolved,
      investor_domain_credits: enrichment.investorDomainCredits,
      investor_logos: enrichment.investorLogos,
      investor_logos_found: enrichment.investorLogosFound,
      investor_logo_credits: enrichment.investorLogoCredits,
    },
  });
  const queued = await deliverStep(persisted.changedByPreset, origin);
  return {
    runId,
    results: search.results,
    pages,
    rounds: items.length,
    records: records.length,
    inserted: persisted.inserted,
    updated: persisted.updated,
    creditsEstimated,
    creditsMeasured,
    queued,
  };
}

/**
 * Remaining credits on the account, read before and after the run; the difference is what
 * the run cost. CEILING: the account is shared, so a monitor check or another sweep running
 * at the same time lands in this number too. Per-request billing would need NativeWebClient to
 * return credits on each response, which /search and /scrape do not.
 */
async function creditsStep(): Promise<number | null> {
  "use step";
  try {
    return (await getWebClient().getCreditUsage()).remainingCredits;
  } catch {
    return null;
  }
}

/**
 * The coverage rung is the ceiling on sources and X accounts; the preset can be narrower. Article
 * URLs this preset's sweep read on this window within its ledger's days are left out (lib/lanes.ts):
 * X timelines are always read, since their newest posts change.
 */
async function searchStep(
  presetSlug: string,
  window: WindowSpec,
  startedAt: string,
): Promise<{ candidates: Candidate[]; results: number; credits: number; notArticle: number; seenSkipped: number }> {
  "use step";
  const [preset, handle] = await Promise.all([loadPreset(presetSlug), db()]);
  const plan = await getCoverage(handle);
  const r = await searchCandidates(getWebClient(), preset, parseWindow(window), {
    sources: plan.sources,
    xAccountsMax: plan.xAccountsMax,
    now: new Date(startedAt),
  });
  // Jev reads the same results; beside storing its verdicts, it may add an article the title rule alone declined.
  const rescued = await screenWithJev(handle, { lane: "sweep", runId: null, presetSlug }, r.screened);
  const read = [...r.candidates, ...r.heldByTitle.filter((c) => rescued.has(c.url))];
  const candidates = await unseenCandidates(handle, read, presetSlug, window, new Date(startedAt));
  return {
    candidates,
    results: r.resultCount,
    credits: r.creditsEstimated,
    notArticle: r.dropped.notArticle,
    seenSkipped: read.length - candidates.length,
  };
}

async function extractStep(candidates: Candidate[]): Promise<{
  items: ExtractedItem[];
  pages: number;
  credits: number;
  notArticle: number;
  okUrls: string[];
  failedUrls: string[];
}> {
  "use step";
  const r = await extractRounds(getWebClient(), candidates, { concurrency: 20 });
  // X timelines stay off the ledger: the sweep reads them every time.
  const x = new Set(candidates.filter((c) => c.kinds.includes("x")).map((c) => c.url));
  const pagesRead = r.pages.filter((p) => !x.has(p.url));
  return {
    items: r.items,
    pages: r.pages.filter((p) => p.ok).length,
    credits: r.creditsEstimated,
    notArticle: r.notArticle,
    okUrls: pagesRead.filter((p) => p.ok).map((p) => p.url),
    failedUrls: pagesRead.filter((p) => !p.ok).map((p) => p.url),
  };
}

/** The batch's pages on the preset's ledger for the window, dated now; a month window keeps none. */
async function markReadStep(presetSlug: string, window: WindowSpec, okUrls: string[], failedUrls: string[], runId: string): Promise<void> {
  "use step";
  if (window !== "day" && window !== "week") return;
  await recordReads(await db(), sweepMonitorId(presetSlug, window), okUrls, failedUrls, runId);
}

async function ratesStep(): Promise<RateTable | null> {
  "use step";
  return fetchRates("latest").catch(() => null);
}

async function resolveStep(
  items: ExtractedItem[],
  window: WindowSpec,
  rates: RateTable | null,
  startedAt: string,
): Promise<{ kept: FeedRecord[]; dropped: Record<string, number> }> {
  "use step";
  const handle = await db();
  const [aliases, publisherTiers, table] = await Promise.all([loadAliases(handle), loadPublisherTiers(), routingTable(handle)]);
  const now = new Date();
  const parsed = parseWindow(window);
  const anchor = new Date(startedAt);
  // Every stage a preset keeps, and a stageless round of any size: persist files each record under the
  // preset that keeps it (this sweep's first), so a Series A the seed sweep read lands under Series A and
  // B instead of being dropped as another stage after its page was paid for and marked read. The day
  // window resolves over three days, so an article that surfaces late still lands, late.
  const r = resolveRounds(items, {
    ...sweepResolveOptions(table.stages, parsed, anchor),
    now,
    rates,
    aliases,
    publisherTiers,
  });
  return { kept: r.kept, dropped: { ...r.dropped } };
}

/**
 * The judge on the plan: every record the resolver kept is read back against its primary page, and a
 * record whose page turns out to be history or another company's does not reach the store. Off the
 * plan, records pass through unjudged (they land flagged, never published).
 */
async function judgeStep(
  records: FeedRecord[],
  rates: RateTable | null,
): Promise<{
  records: FeedRecord[];
  judged: number;
  confirmed: number;
  corrected: number;
  notNews: number;
  contradicted: number;
  credits: number;
}> {
  "use step";
  const plan = await getCoverage(await db());
  if (!plan.judge || records.length === 0)
    return { records, judged: 0, confirmed: 0, corrected: 0, notNews: 0, contradicted: 0, credits: 0 };
  const tiers = await loadPublisherTiers();
  // With a model configured, the cross-source read replaces the single-page judge: every source of the
  // record together, each field cited to the page that states it. Without one, the judge and the
  // sibling-date rule do what they can from one page.
  const model = reconcileModel(process.env, "feed");
  const r = model
    ? await reconcileRecords(records, firecrawlReader(getWebClient()), model, { rates, tiers: { ...DEFAULT_TIERS, ...tiers } })
    : await judgeRecords(getWebClient(), records, { rates, tiers: { ...DEFAULT_TIERS, ...tiers } });
  const settled = model ? r.records : r.records.map((x) => settleDate(x));
  return {
    records: settled.filter((x) => x.verification?.status !== "not_news"),
    judged: r.judged,
    confirmed: r.confirmed,
    corrected: r.corrected,
    notNews: r.notNews,
    contradicted: r.contradicted,
    credits: r.creditsEstimated,
  };
}

async function rereconcileStep(ids: string[], rates: RateTable | null): Promise<{ reconciled: number; credits: number }> {
  "use step";
  const model = reconcileModel(process.env, "feed");
  if (!model || ids.length === 0) return { reconciled: 0, credits: 0 };
  const handle = await db();
  const plan = await getCoverage(handle);
  if (!plan.judge) return { reconciled: 0, credits: 0 };
  const tiers = await loadPublisherTiers();
  const result = await reconcileGrownRows(handle, getWebClient(), model, [...new Set(ids)], {
    rates,
    tiers: { ...DEFAULT_TIERS, ...tiers },
  });
  await invalidateEntityPages(handle, { roundIds: ids });
  return result;
}

/** Each record under the preset that keeps it: this sweep's first, else the preset whose stage or band holds it. */
async function persistStep(
  records: FeedRecord[],
  presetSlug: string,
  runId: string,
): Promise<
  { inserted: number; updated: number; unchanged: number; unrouted: number; changedByPreset: Record<string, string[]> } & PersistedIds
> {
  "use step";
  const handle = await db();
  const summary = await persistRouted(handle, records, presetSlug, runId);
  if (summary.persistedIds.length) await invalidateEntityPages(handle, { roundIds: summary.persistedIds });
  return summary;
}

/**
 * The plan's second reading of what just landed. Corroboration first (a second source may lift a
 * row out of review before the agent is asked), then gap-fill for what is still in review. The deep
 * dive runs at the end of the tick, a few steps per company (workflows/dossiers.ts). Each is its own
 * step so a retry repeats one play; the merges are idempotent (never overwrite, upsert the dossier).
 */
async function corroborateStep(ids: PersistedIds): Promise<CorroborationTally> {
  "use step";
  const handle = await db();
  const plan = await getCoverage(handle);
  const result = await corroborateForPlan(handle, getWebClient(), plan, ids);
  await invalidateEntityPages(handle, { roundIds: ids.persistedIds });
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

/**
 * Upserts the run's row. `finished: false` is the row a sweep writes when it starts: finished_at
 * stays null (the RUNNING mark on /runs) and the estimate is the run's price on the rate card,
 * since nothing has been measured yet.
 */
async function recordRunStep(run: {
  id: string;
  presetSlug: string;
  lane: string;
  window: string;
  startedAt: string;
  finished: boolean;
  creditsEstimated?: number;
  creditsMeasured: number | null;
  counts: Record<string, number>;
  error?: string;
}): Promise<void> {
  "use step";
  const handle = await db();
  const { finished, ...rest } = run;
  let creditsEstimated = run.creditsEstimated ?? 0;
  if (!finished) {
    try {
      const [preset, plan] = await Promise.all([loadPreset(run.presetSlug, handle), getCoverage(handle)]);
      creditsEstimated = estimateSweep(preset, plan, parseWindow(run.window)).creditsHigh;
    } catch {
      creditsEstimated = run.creditsEstimated ?? 0;
    }
  }
  await recordRun(handle, {
    ...rest,
    creditsEstimated,
    startedAt: new Date(run.startedAt),
    finishedAt: finished ? new Date() : null,
  });
}

/** Mid-run progress: merges counters into the row the start wrote, leaving the estimate and timing alone. */
async function progressStep(runId: string, counts: Record<string, number>): Promise<void> {
  "use step";
  await mergeRunCounts(await db(), runId, counts);
}

async function deliverStep(changedByPreset: Record<string, string[]>, origin: string): Promise<number> {
  "use step";
  const handle = await db();
  const queued = await enqueueRouted(handle, changedByPreset);
  if (queued > 0) await flushDeliveries(handle, origin);
  return queued;
}
