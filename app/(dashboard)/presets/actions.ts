"use server";

import { randomUUID } from "node:crypto";
import { createPresetMonitor, parsePreset, runMonitorNow, slugifyPresetName } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { revalidatePath, updateTag } from "next/cache";
import { headers } from "next/headers";
import { start } from "workflow/api";
import { ZodError } from "zod";
import { type ActionResult, attempt } from "@/lib/action-result";
import { TAG_PRESETS } from "@/lib/cached";
import { estimateSweep as estimate, type SweepEstimate } from "@/lib/coverage";
import { requireDashboard } from "@/lib/dashboard-auth.server";
import { db } from "@/lib/db";
import { getFirecrawl } from "@/lib/firecrawl";
import { bumpRunCount } from "@/lib/persist";
import { deleteCustomPreset, isCustomPreset, listPresets, loadPreset, saveCustomPreset } from "@/lib/presets";
import { getCoverage } from "@/lib/settings";
import { enrichWorkflow } from "@/workflows/enrich";
import { ingestCandidate } from "@/workflows/ingest-candidate";
import { sweepWorkflow } from "@/workflows/sweep";

async function origin(): Promise<string> {
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN;
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

/**
 * The rate-card estimate, as a server action for the presets page. The estimate itself is
 * lib/coverage.ts. Guarded because any exported server function is callable by POST from any page,
 * and a preset's queries and the rung are operator configuration.
 */
export async function estimateSweep(presetSlug: string): Promise<SweepEstimate> {
  await requireDashboard();
  const [preset, plan] = await Promise.all([loadPreset(presetSlug), db().then(getCoverage)]);
  return estimate(preset, plan);
}

export async function startSweep(presetSlug: string, window: "day" | "week"): Promise<ActionResult<{ value: { runId: string } }>> {
  return attempt(async () => {
    await requireDashboard();
    const runId = randomUUID();
    await start(sweepWorkflow, [[{ presetSlug, window, runId }], await origin()]);
    revalidatePath("/runs");
    return { runId };
  });
}

export async function startEnrich(presetSlug: string, limit = 50): Promise<ActionResult<{ value: { runId: string } }>> {
  return attempt(async () => {
    await requireDashboard();
    const runId = randomUUID();
    await start(enrichWorkflow, [presetSlug, runId, limit]);
    revalidatePath("/runs");
    return { runId };
  });
}

export async function createMonitor(
  presetSlug: string,
): Promise<ActionResult<{ value: { monitorId: string; estimatedCreditsPerMonth: number | null } }>> {
  return attempt(async () => {
    await requireDashboard();
    const handle = await db();
    // The monitor's cadence is the coverage rung's, not the preset file's.
    const [preset, plan] = await Promise.all([loadPreset(presetSlug), getCoverage(handle)]);
    const bearer = process.env.WEBHOOK_BEARER_TOKEN;
    const monitor = await createPresetMonitor(getFirecrawl(), preset, {
      webhookUrl: `${await origin()}/api/webhooks/firecrawl`,
      webhookHeaders: bearer ? { authorization: `Bearer ${bearer}` } : undefined,
      schedule: plan.monitorSchedule,
    });
    await handle
      .insert(schema.presetMonitors)
      .values({ presetSlug, monitorId: monitor.id, estimatedCreditsPerMonth: monitor.estimatedCreditsPerMonth ?? null })
      .onConflictDoUpdate({
        target: schema.presetMonitors.presetSlug,
        set: { monitorId: monitor.id, estimatedCreditsPerMonth: monitor.estimatedCreditsPerMonth ?? null },
      });
    revalidatePath("/presets");
    return { monitorId: monitor.id, estimatedCreditsPerMonth: monitor.estimatedCreditsPerMonth ?? null };
  });
}

/**
 * Trigger a check and ingest its alerts directly. Webhooks do the same in
 * production; this path makes the monitor useful on a laptop with no public URL.
 */
export async function runMonitorCheck(
  presetSlug: string,
): Promise<ActionResult<{ value: { checkId: string; alerted: number; started: number; credits: number | null } }>> {
  return attempt(async () => {
    await requireDashboard();
    const handle = await db();
    const [row] = await handle.select().from(schema.presetMonitors).where(eq(schema.presetMonitors.presetSlug, presetSlug)).limit(1);
    if (!row) throw new Error("No monitor for this preset yet.");
    const client = getFirecrawl();
    const appOrigin = await origin();
    const check = await runMonitorNow(client, row.monitorId);
    const detail = await client.getMonitorCheck(row.monitorId, check.id, { limit: 100 });
    const alerted = (detail.pages ?? []).filter((p) => p.status === "new");
    // The run row exists before any ingest starts; each ingest then adds its page and records to it.
    await handle
      .insert(schema.runs)
      .values({
        id: `check:${check.id}`,
        presetSlug,
        lane: "monitor",
        window: "24h",
        startedAt: check.startedAt ? new Date(check.startedAt) : new Date(),
        finishedAt: new Date(),
        creditsEstimated: check.estimatedCredits ?? null,
        creditsMeasured: check.actualCredits ?? null,
        counts: { search_results: check.summary.totalPages, alerted: alerted.length, pages_extracted: 0, records: 0 },
      })
      .onConflictDoNothing();
    let started = 0;
    for (const p of alerted) {
      const inserted = await handle
        .insert(schema.candidates)
        .values({ monitorId: row.monitorId, url: p.url, checkId: check.id, judgeReason: p.judgment?.reason ?? null })
        .onConflictDoNothing()
        .returning({ url: schema.candidates.url });
      if (inserted.length === 0) continue;
      await start(ingestCandidate, [row.monitorId, p.url, presetSlug, appOrigin, check.id]);
      started++;
    }
    await bumpRunCount(handle, `check:${check.id}`, "started", started);
    revalidatePath("/presets");
    revalidatePath("/runs");
    return { checkId: check.id, alerted: alerted.length, started, credits: check.actualCredits ?? null };
  });
}

export async function deleteMonitor(presetSlug: string): Promise<ActionResult> {
  return attempt(async () => {
    await requireDashboard();
    const handle = await db();
    const [row] = await handle.select().from(schema.presetMonitors).where(eq(schema.presetMonitors.presetSlug, presetSlug)).limit(1);
    if (!row) return;
    await getFirecrawl().deleteMonitor(row.monitorId);
    await handle.delete(schema.presetMonitors).where(eq(schema.presetMonitors.presetSlug, presetSlug));
    revalidatePath("/presets");
  });
}

/** What the form edits; everything else on a Preset keeps its default (or, on update, its stored value). */
export interface PresetInput {
  name: string;
  description: string;
  stages: string[];
  queries: string[];
  goal: string;
  xAccounts: string[];
  watchSites: string[];
}

export type PresetResult = ActionResult<{ slug: string }>;

/** Zod's message is JSON; the form wants one line per field. */
function describe(err: unknown): string {
  if (err instanceof ZodError) return err.issues.map((i) => `${i.path.join(".") || "preset"}: ${i.message}`).join("; ");
  return err instanceof Error ? err.message : String(err);
}

/** Every page that lists presets: the switcher, feed filters, runs, settings, and the cards, and the shared cached list they read. */
function revalidatePresetLists(): void {
  for (const p of ["/presets", "/", "/feed", "/runs", "/settings"]) revalidatePath(p);
  updateTag(TAG_PRESETS);
}

/** A slug from the name, suffixed until it is free of both file and custom presets. */
function freeSlug(name: string, taken: Set<string>): string {
  const base = slugifyPresetName(name) || "preset";
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

export async function createPreset(input: PresetInput): Promise<PresetResult> {
  try {
    await requireDashboard();
    const handle = await db();
    const existing = await listPresets(handle);
    const slug = freeSlug(input.name, new Set(existing.map((p) => p.slug)));
    const last = existing.reduce((max, p) => Math.max(max, p.order), 0);
    const preset = parsePreset({ ...input, slug, order: last + 10 });
    await saveCustomPreset(handle, preset);
    revalidatePresetLists();
    return { ok: true, slug };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

/** The slug and order stay: rounds, runs, and the monitor row hang off the slug. */
export async function updatePreset(slug: string, input: PresetInput): Promise<PresetResult> {
  try {
    await requireDashboard();
    if (!(await isCustomPreset(slug))) return { ok: false, error: `${slug} is a file preset; edit presets/${slug}.json.` };
    const handle = await db();
    const current = await loadPreset(slug, handle);
    const preset = parsePreset({ ...current, ...input, slug });
    await saveCustomPreset(handle, preset);
    revalidatePresetLists();
    return { ok: true, slug };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

/** Removes the preset and its monitor. Rounds written under the slug stay: they are data, not configuration. */
export async function deletePreset(slug: string): Promise<ActionResult> {
  return attempt(async () => {
    await requireDashboard();
    if (!(await isCustomPreset(slug))) throw new Error(`${slug} is a file preset; remove presets/${slug}.json instead.`);
    const m = await deleteMonitor(slug);
    if (!m.ok) throw new Error(m.error);
    await deleteCustomPreset(await db(), slug);
    revalidatePresetLists();
  });
}
