// The watch-sites lane as a durable run: read each publisher section the preset watches, extract
// the article links not seen before, resolve, read back, persist, record the run, queue and flush deliveries.
// Seen state is the candidates table under monitor id `watch:<host>`, so a page is paid for once.

import type { ExtractedItem, ExtractTarget, FeedRecord, RateTable } from "@fireround/core";
import {
  DEFAULT_TIERS,
  extractionCredits,
  extractRounds,
  fetchRates,
  firecrawlReader,
  hostOf,
  judgeRecords,
  RATE,
  reconcileModel,
  reconcileRecords,
  resolveRounds,
  runWatchSites,
  STAGE_BANDS,
  settleDate,
  windowStartFor,
} from "@fireround/core";
import { measuredCredits } from "@/lib/credits";
import { db } from "@/lib/db";
import { flushDeliveries } from "@/lib/delivery";
import { invalidateEntityPages } from "@/lib/entity-invalidation";
import { getFirecrawl } from "@/lib/firecrawl";
import { type CorroborationTally, corroborateUnstated } from "@/lib/intel";
import { screenWithJev } from "@/lib/jev-shadow";
import { markCandidates, seenWatchCandidate, upsertCandidates, watchMonitorId } from "@/lib/lanes";
import { recordRun } from "@/lib/persist";
import { loadPreset } from "@/lib/presets";
import { reconcileGrownRows } from "@/lib/reconcile";
import { enqueueRouted, persistRouted, routingTable } from "@/lib/routing";
import { loadAliases, loadPublisherTiers } from "@/lib/rules";
import { getCoverage } from "@/lib/settings";
import { newRoundCompanyIdsStep, startCompanyTimelinesStep } from "@/workflows/history";

const BATCH = 12;

export interface WatchSummary {
  runId: string;
  skipped?: string;
  sites: number;
  /** Stage-free searches run. */
  queries: number;
  mapped: number;
  newPages: number;
  rounds: number;
  records: number;
  creditsEstimated: number;
  creditsMeasured: number | null;
  queued: number;
}

/** `withQueries` runs the preset's stage-free searches this check too (lib/lanes.ts watchQueriesDue). */
export async function watchSitesWorkflow(presetSlug: string, runId: string, origin: string, withQueries = true): Promise<WatchSummary> {
  "use workflow";
  // The cron route decided this lane is due (or was forced); the workflow does not ask the plan again.
  const startedAt = new Date().toISOString();
  const before = await creditsStep();
  const gathered = await gatherStep(presetSlug, runId, withQueries);
  const items: ExtractedItem[] = [];
  const okUrls: string[] = [];
  const failedUrls: string[] = [];
  for (let i = 0; i < gathered.candidates.length; i += BATCH) {
    const batch = await extractStep(gathered.candidates.slice(i, i + BATCH));
    items.push(...batch.items);
    okUrls.push(...batch.ok);
    failedUrls.push(...batch.failed);
  }
  const rates = await ratesStep();
  const resolved = await resolveStep(items, presetSlug, rates);
  // The read-back every other lane runs: without it a trend story's passing mention of OpenAI landed
  // as an unjudged "Series A" on the feed.
  const judged = await judgeStep(resolved.kept, rates);
  const records = judged.records;
  const persisted = await persistStep(records, presetSlug, runId);
  if (persisted.insertedIds.length > 0) {
    await startCompanyTimelinesStep(await newRoundCompanyIdsStep(persisted.insertedIds), 3, true);
  }
  // A page's day is not the announcement's (Primo's Sep 22 round from a Sep 25 article, Angle Health's
  // Sep 18 Series C from a Sep 24 newsletter): the rows whose day the company never stated are
  // corroborated and read again with every source before anything is delivered, as the sweep does.
  const corroboration = await corroborateStep([...persisted.insertedIds, ...persisted.changedIds]);
  const rereconciled = await rereconcileStep(corroboration.targets, rates);
  await markStep(okUrls, "extracted");
  await markStep(failedUrls, "failed");
  const after = await creditsStep();
  const creditsEstimated =
    gathered.mapCredits +
    gathered.searchCredits +
    extractionCredits(gathered.candidates.map((c) => c.url)) +
    judged.credits +
    corroboration.corroboration_credits +
    rereconciled.credits;
  const creditsMeasured = measuredCredits(before, after);
  await recordRunStep({
    id: runId,
    presetSlug,
    lane: "watch",
    window: "week",
    startedAt,
    creditsEstimated,
    creditsMeasured,
    counts: {
      sites: gathered.sites,
      mapped: gathered.mapped,
      queries: gathered.queries,
      query_results: gathered.queryResults,
      query_pages: gathered.queryPages,
      search_credits: gathered.searchCredits,
      new_pages: gathered.candidates.length,
      pages_extracted: okUrls.length,
      rounds_extracted: items.length,
      records: records.length,
      inserted: persisted.inserted,
      updated: persisted.updated,
      unchanged: persisted.unchanged,
      unrouted: persisted.unrouted,
      judged: judged.judged,
      judge_confirmed: judged.confirmed,
      judge_corrected: judged.corrected,
      judge_not_news: judged.notNews,
      judge_contradicted: judged.contradicted,
      judge_credits: judged.credits,
      corroborated: corroboration.corroborated,
      corroboration_rejected: corroboration.corroboration_rejected,
      corroboration_credits: corroboration.corroboration_credits,
      newsroom_pages: corroboration.newsroom_pages,
      reconciled_again: rereconciled.reconciled,
      reconcile_credits: rereconciled.credits,
      ...resolved.dropped,
    },
  });
  const queued = await deliverStep(persisted.changedByPreset, origin);
  return {
    runId,
    sites: gathered.sites,
    queries: gathered.queries,
    mapped: gathered.mapped,
    newPages: gathered.candidates.length,
    rounds: items.length,
    records: records.length,
    creditsEstimated,
    creditsMeasured,
    queued,
  };
}

/** Remaining credits before and after; the difference is the run's cost. Same ceiling as the sweep: the account is shared. */
async function creditsStep(): Promise<number | null> {
  "use step";
  try {
    return (await getFirecrawl().getCreditUsage()).remainingCredits;
  } catch {
    return null;
  }
}

/**
 * Every watch site of the preset: one section read each, then each stage-free search; the unseen
 * article links become candidates, written as pending rows before extraction so a retry of a later
 * step never re-reads a page this run already paid for.
 */
async function gatherStep(
  presetSlug: string,
  runId: string,
  withQueries = true,
): Promise<{
  candidates: ExtractTarget[];
  sites: number;
  mapped: number;
  mapCredits: number;
  queries: number;
  queryResults: number;
  queryPages: number;
  searchCredits: number;
}> {
  "use step";
  const [preset, handle] = await Promise.all([loadPreset(presetSlug), db()]);
  const r = await runWatchSites(getFirecrawl(), withQueries ? preset : { ...preset, watchQueries: [] }, {
    seen: (url) => seenWatchCandidate(handle, watchMonitorId(hostOf(url)), url),
    markSeen: (host, urls) => upsertCandidates(handle, watchMonitorId(host), urls, "pending", runId),
  });
  // Jev reads the searches' results; beside storing its verdicts, it may add an article the title rule alone declined.
  const rescued = await screenWithJev(
    handle,
    { lane: "watch", runId, presetSlug },
    r.queries.flatMap((q) => q.screened),
  );
  const extra: ExtractTarget[] = [];
  for (const t of r.queries.flatMap((q) => q.heldByTitle)) {
    if (!rescued.has(t.url) || extra.some((e) => e.url === t.url) || r.candidates.some((c) => c.url === t.url)) continue;
    if (await seenWatchCandidate(handle, watchMonitorId(hostOf(t.url)), t.url)) continue;
    extra.push(t);
  }
  for (const [host, urls] of Map.groupBy(extra, (t) => hostOf(t.url))) {
    await upsertCandidates(
      handle,
      watchMonitorId(host),
      urls.map((t) => t.url),
      "pending",
      runId,
    );
  }
  return {
    candidates: [...r.candidates, ...extra],
    sites: r.sites.length,
    mapped: r.sites.reduce((n, s) => n + s.articles, 0),
    mapCredits: r.sites.length * RATE.mapCall,
    queries: r.queries.length,
    queryResults: r.queries.reduce((n, q) => n + q.results, 0),
    queryPages: r.queries.reduce((n, q) => n + q.targets.length, 0) + extra.length,
    searchCredits: r.searchCredits,
  };
}

async function extractStep(candidates: ExtractTarget[]): Promise<{ items: ExtractedItem[]; ok: string[]; failed: string[] }> {
  "use step";
  const r = await extractRounds(getFirecrawl(), candidates, { concurrency: 20 });
  return {
    items: r.items,
    ok: r.pages.filter((p) => p.ok).map((p) => p.url),
    failed: r.pages.filter((p) => !p.ok).map((p) => p.url),
  };
}

async function ratesStep(): Promise<RateTable | null> {
  "use step";
  return fetchRates("latest").catch(() => null);
}

/**
 * Every stage a preset keeps, and a stageless round of any size, inside a week window: a publisher's
 * funding section lists seed, Series A, and growth rounds alike, and persist files each under the preset
 * that keeps it (a section page lists this week's articles, and an older one was seen on an earlier check).
 */
async function resolveStep(
  items: ExtractedItem[],
  _presetSlug: string,
  rates: RateTable | null,
): Promise<{ kept: FeedRecord[]; dropped: Record<string, number> }> {
  "use step";
  const handle = await db();
  const [aliases, publisherTiers, table] = await Promise.all([loadAliases(handle), loadPublisherTiers(), routingTable(handle)]);
  const now = new Date();
  const r = resolveRounds(items, {
    stages: table.stages,
    stagelessBands: STAGE_BANDS,
    windowStart: windowStartFor("week", now),
    now,
    rates,
    aliases,
    publisherTiers,
  });
  return { kept: r.kept, dropped: { ...r.dropped } };
}

/**
 * The read-back, as in the sweep: with a model configured, every source of the record read together;
 * without one, the judge reads the primary page. A record whose page is history or another company's
 * does not reach the store. Off the plan, records pass through unjudged and land flagged, never published.
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
  const tiers = { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
  const model = reconcileModel(process.env, "feed");
  const r = model
    ? await reconcileRecords(records, firecrawlReader(getFirecrawl()), model, { rates, tiers })
    : await judgeRecords(getFirecrawl(), records, { rates, tiers });
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

/** Each record under the preset that keeps it, this lane's own first. */
async function persistStep(
  records: FeedRecord[],
  presetSlug: string,
  runId: string,
): Promise<{
  inserted: number;
  updated: number;
  unchanged: number;
  unrouted: number;
  changedByPreset: Record<string, string[]>;
  insertedIds: string[];
  changedIds: string[];
}> {
  "use step";
  const handle = await db();
  const s = await persistRouted(handle, records, presetSlug, runId);
  if (s.persistedIds.length) await invalidateEntityPages(handle, { roundIds: s.persistedIds });
  return {
    inserted: s.inserted,
    updated: s.updated,
    unchanged: s.unchanged,
    unrouted: s.unrouted,
    changedByPreset: s.changedByPreset,
    insertedIds: s.insertedIds,
    changedIds: s.changedIds,
  };
}

async function corroborateStep(ids: string[]): Promise<CorroborationTally & { targets: string[] }> {
  "use step";
  const handle = await db();
  const result = await corroborateUnstated(handle, getFirecrawl(), ids);
  if (ids.length) await invalidateEntityPages(handle, { roundIds: ids });
  return result;
}

/** A row that gained sources in corroboration is read again with all of them in view, as in the sweep. */
async function rereconcileStep(ids: string[], rates: RateTable | null): Promise<{ reconciled: number; credits: number }> {
  "use step";
  const model = reconcileModel(process.env, "feed");
  if (!model || ids.length === 0) return { reconciled: 0, credits: 0 };
  const handle = await db();
  const plan = await getCoverage(handle);
  if (!plan.judge) return { reconciled: 0, credits: 0 };
  const tiers = await loadPublisherTiers();
  const result = await reconcileGrownRows(handle, getFirecrawl(), model, [...new Set(ids)], {
    rates,
    tiers: { ...DEFAULT_TIERS, ...tiers },
  });
  await invalidateEntityPages(handle, { roundIds: ids });
  return result;
}

/** Candidate rows are keyed by host, so the URLs are grouped back onto their monitor ids. */
async function markStep(urls: string[], status: "extracted" | "failed"): Promise<void> {
  "use step";
  if (urls.length === 0) return;
  const handle = await db();
  const byHost = new Map<string, string[]>();
  for (const url of urls) {
    const host = hostOf(url);
    byHost.set(host, [...(byHost.get(host) ?? []), url]);
  }
  for (const [host, list] of byHost) await markCandidates(handle, watchMonitorId(host), list, status);
}

async function recordRunStep(run: {
  id: string;
  presetSlug: string;
  lane: string;
  window: string;
  startedAt: string;
  creditsEstimated: number;
  creditsMeasured: number | null;
  counts: Record<string, number>;
}): Promise<void> {
  "use step";
  const handle = await db();
  await recordRun(handle, { ...run, startedAt: new Date(run.startedAt), finishedAt: new Date() });
}

async function deliverStep(changedByPreset: Record<string, string[]>, origin: string): Promise<number> {
  "use step";
  const handle = await db();
  const queued = await enqueueRouted(handle, changedByPreset);
  if (queued > 0) await flushDeliveries(handle, origin);
  return queued;
}
