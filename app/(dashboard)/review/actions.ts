"use server";

import { randomUUID } from "node:crypto";
import { schema } from "@fireround/core/db";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { start } from "workflow/api";
import { dismissAccuracyFlag, reopenAccuracyFlag } from "@/lib/accuracy";
import { type ActionResult, attempt } from "@/lib/action-result";
import { requireDashboard } from "@/lib/dashboard-auth.server";
import { db } from "@/lib/db";
import { loadPreset } from "@/lib/presets";
import { ingestCandidate } from "@/workflows/ingest-candidate";

async function origin(): Promise<string> {
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN;
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

/**
 * Paste an article URL and read it through the monitor path: extract, resolve, persist, the
 * plan's second reading, fan-out. The run row lands first so Runs shows it while it works;
 * its `check:` id is what the ingest's recordCheckStep bumps.
 */
export async function ingestUrl(input: { url: string; presetSlug: string }): Promise<ActionResult<{ value: { runId: string } }>> {
  return attempt(async () => {
    await requireDashboard();
    let url: URL;
    try {
      url = new URL(input.url.trim());
    } catch {
      throw new Error("That is not a URL.");
    }
    if (url.protocol !== "https:") throw new Error("URL must be https.");
    const preset = await loadPreset(input.presetSlug);

    const checkId = randomUUID();
    const runId = `check:${checkId}`;
    const handle = await db();
    await handle
      .insert(schema.runs)
      .values({
        id: runId,
        presetSlug: preset.slug,
        lane: "manual",
        window: null,
        startedAt: new Date(),
        // The row marks the submission, which is already done; the ingest's counts fill in after.
        finishedAt: new Date(),
        counts: { pages_extracted: 0, records: 0 },
      })
      .onConflictDoNothing();
    await start(ingestCandidate, ["manual", url.toString(), preset.slug, await origin(), checkId]);
    revalidatePath("/runs");
    revalidatePath("/review");
    return { runId };
  });
}

/**
 * Dismiss one accuracy flag with a note: a person looked and decided, so the daily check stops asking
 * while the flag stays about the same rounds or fields (a new one opens it again). Admin only, like
 * every write here: the password check runs before the store opens.
 */
export async function dismissAccuracy(input: { companyId: string; rule: string; note: string }): Promise<ActionResult> {
  return attempt(async () => {
    await requireDashboard();
    if (!input?.companyId || !input.rule) throw new Error("Which flag?");
    const note = String(input.note ?? "").trim();
    if (!note) throw new Error("Say why, so the next person knows.");
    if (!(await dismissAccuracyFlag(await db(), input.companyId, input.rule, note))) throw new Error("That flag has cleared or is gone.");
    revalidatePath("/review");
  });
}

/** Undo a dismissal: the flag is open again until the next run keeps or clears it. */
export async function reopenAccuracy(input: { companyId: string; rule: string }): Promise<ActionResult> {
  return attempt(async () => {
    await requireDashboard();
    if (!input?.companyId || !input.rule) throw new Error("Which flag?");
    if (!(await reopenAccuracyFlag(await db(), input.companyId, input.rule))) throw new Error("That flag is not dismissed.");
    revalidatePath("/review");
  });
}
