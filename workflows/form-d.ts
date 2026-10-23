// The SEC Form D lane as a durable run: search EDGAR for the window's filings, read each unseen
// one, keep the venture-shaped placements, resolve, persist under the "form-d" preset slug,
// record the run, queue and flush deliveries. No NativeWebClient credits. Seen state is the candidates
// table under monitor id `formd`, keyed by the filing's index URL.

import type { ExtractedItem, FeedRecord, FormDSpan, RateTable } from "@fireround/core";
import { fetchRates, formDResolveStart, formDSpanChunks, resolveRounds, runFormD } from "@fireround/core";
import { db } from "@/lib/db";
import { enqueueDeliveries, flushDeliveries } from "@/lib/delivery";
import { invalidateEntityPages } from "@/lib/entity-invalidation";
import { FORM_D_MONITOR_ID, formDWindow, seenCandidate, upsertCandidates } from "@/lib/lanes";
import { persistRecords, recordRun } from "@/lib/persist";
import { loadAliases, loadPublisherTiers } from "@/lib/rules";
import { getCoverage } from "@/lib/settings";

/** Records from this lane carry this preset slug; a delivery target scoped to a preset does not receive them unless it names this one. */
export const FORM_D_PRESET_SLUG = "form-d";

export interface FormDSummary {
  runId: string;
  skipped?: string;
  hits: number;
  kept: number;
  records: number;
  queued: number;
}

type Fetched = Awaited<ReturnType<typeof fetchStep>>;

/**
 * Without `span`, the filing window is the plan's cadence (the last two days, or three hours). A
 * backfill passes the span it wants (ISO start and end), read a week of filings a step; the
 * resolve window then follows the span, so a July filing is dated July and kept.
 */
export async function formDWorkflow(runId: string, origin: string, span?: FormDSpan): Promise<FormDSummary> {
  "use workflow";
  const startedAt = new Date().toISOString();
  // The cron route decided this lane is due (or was forced); the plan is read only for the filing window.
  const window = span ?? (await planStep(startedAt));
  const fetched: Fetched = { hits: 0, fetched: 0, kept: 0, requests: 0, skipped: {}, items: [], handled: [] };
  for (const chunk of formDSpanChunks(window)) {
    const part = await fetchStep(chunk.start, chunk.end);
    fetched.hits += part.hits;
    fetched.fetched += part.fetched;
    fetched.kept += part.kept;
    fetched.requests += part.requests;
    for (const [k, v] of Object.entries(part.skipped)) fetched.skipped[k] = (fetched.skipped[k] ?? 0) + v;
    fetched.items.push(...part.items);
    fetched.handled.push(...part.handled);
  }
  const rates = await ratesStep();
  const resolved = await resolveStep(fetched.items, rates, formDResolveStart(window).toISOString());
  const records = resolved.kept;
  const persisted = await persistStep(records, runId);
  await markStep(fetched.handled, runId);
  await recordRunStep({
    id: runId,
    startedAt,
    window: span ? `${span.start.slice(0, 10)}..${span.end.slice(0, 10)}` : null,
    counts: {
      hits: fetched.hits,
      fetched: fetched.fetched,
      kept: fetched.kept,
      rounds_extracted: fetched.kept,
      records: records.length,
      inserted: persisted.inserted,
      updated: persisted.updated,
      unchanged: persisted.unchanged,
      edgar_requests: fetched.requests,
      ...Object.fromEntries(Object.entries(fetched.skipped).map(([k, v]) => [`skipped_${k}`, v])),
      ...resolved.dropped,
    },
  });
  const queued = await deliverStep(persisted.changedIds, origin);
  return { runId, hits: fetched.hits, kept: fetched.kept, records: records.length, queued };
}

/** The filing-date window the rung's cadence reads, as ISO strings. */
async function planStep(startedAt: string): Promise<FormDSpan> {
  "use step";
  const plan = await getCoverage(await db());
  const window = formDWindow(plan.formD.cadence, new Date(startedAt));
  return { start: window.start.toISOString(), end: window.end.toISOString() };
}

/** Search and read, skipping filings already in the ledger. Returns the kept items and every filing URL read. */
async function fetchStep(
  startIso: string,
  endIso: string,
): Promise<{
  hits: number;
  fetched: number;
  kept: number;
  requests: number;
  skipped: Record<string, number>;
  items: ExtractedItem[];
  handled: string[];
}> {
  "use step";
  const handle = await db();
  const r = await runFormD(new Date(startIso), new Date(endIso), {
    seen: (url) => seenCandidate(handle, FORM_D_MONITOR_ID, url),
  });
  return {
    hits: r.hits,
    fetched: r.fetched,
    kept: r.kept,
    requests: r.requests,
    skipped: { ...r.skipped },
    items: r.items,
    handled: r.handled,
  };
}

async function ratesStep(): Promise<RateTable | null> {
  "use step";
  return fetchRates("latest").catch(() => null);
}

/**
 * A Form D never names its round, so every item here classifies as `other` (see classifyStage);
 * the lane keeps that stage on purpose, and the reader sees the label "Form D (equity)".
 */
async function resolveStep(
  items: ExtractedItem[],
  rates: RateTable | null,
  windowStartIso: string,
): Promise<{ kept: FeedRecord[]; dropped: Record<string, number> }> {
  "use step";
  const [aliases, publisherTiers] = await Promise.all([db().then(loadAliases), loadPublisherTiers()]);
  const now = new Date();
  const r = resolveRounds(items, { stages: ["other"], windowStart: new Date(windowStartIso), now, rates, aliases, publisherTiers });
  return { kept: r.kept, dropped: { ...r.dropped } };
}

async function persistStep(
  records: FeedRecord[],
  runId: string,
): Promise<{ inserted: number; updated: number; unchanged: number; changedIds: string[] }> {
  "use step";
  const handle = await db();
  // A filing proves a sale, not a venture round: every Form D record starts in review.
  const summary = await persistRecords(handle, records, FORM_D_PRESET_SLUG, runId, { startIn: "review" });
  if (summary.persistedIds.length) await invalidateEntityPages(handle, { roundIds: summary.persistedIds });
  return summary;
}

/** Every filing read this run is seen, kept or skipped: the next check does not read it again. */
async function markStep(urls: string[], runId: string): Promise<void> {
  "use step";
  const handle = await db();
  await upsertCandidates(handle, FORM_D_MONITOR_ID, urls, "extracted", runId);
}

/** `window` is the backfill span as "YYYY-MM-DD..YYYY-MM-DD", null on a scheduled check. */
async function recordRunStep(run: { id: string; startedAt: string; window: string | null; counts: Record<string, number> }): Promise<void> {
  "use step";
  const handle = await db();
  await recordRun(handle, {
    id: run.id,
    presetSlug: FORM_D_PRESET_SLUG,
    lane: "formd",
    window: run.window,
    startedAt: new Date(run.startedAt),
    finishedAt: new Date(),
    creditsEstimated: 0,
    creditsMeasured: 0,
    counts: run.counts,
  });
}

async function deliverStep(roundIds: string[], origin: string): Promise<number> {
  "use step";
  const handle = await db();
  const queued = await enqueueDeliveries(handle, roundIds, FORM_D_PRESET_SLUG);
  if (queued > 0) await flushDeliveries(handle, origin);
  return queued;
}
