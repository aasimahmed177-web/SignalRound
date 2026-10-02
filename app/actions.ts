"use server";

import { schema } from "@fireround/core/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { type ActionResult, attempt } from "@/lib/action-result";
import { TAG_ROUNDS } from "@/lib/cached";
import { requireDashboard } from "@/lib/dashboard-auth.server";
import { db } from "@/lib/db";
import { invalidateEntityPages } from "@/lib/entity-invalidation";
import { reportRound, setDisposition, setStatus } from "@/lib/persist";
import { saveAlias } from "@/lib/rules";

export async function markSeen(ids: string[]): Promise<ActionResult<{ value: { updated: number } }>> {
  return attempt(async () => {
    await requireDashboard();
    const handle = await db();
    const updated = await setStatus(handle, ids, "seen");
    revalidatePath("/");
    revalidatePath("/feed");
    return { updated };
  });
}

export async function markUnread(ids: string[]): Promise<ActionResult<{ value: { updated: number } }>> {
  return attempt(async () => {
    await requireDashboard();
    const handle = await db();
    const updated = await setStatus(handle, ids, "new");
    revalidatePath("/");
    revalidatePath("/feed");
    return { updated };
  });
}

export async function decide(id: string, disposition: "publish" | "rejected"): Promise<ActionResult> {
  return attempt(async () => {
    await requireDashboard();
    const handle = await db();
    await setDisposition(handle, id, disposition);
    await invalidateEntityPages(handle, { roundIds: [id] });
    revalidatePath("/");
    revalidatePath("/feed");
    revalidatePath("/review");
    revalidateTag(TAG_ROUNDS, "max");
  });
}

/**
 * The review queue's Undo: a record the operator just published or rejected goes back to review,
 * exactly where it came from (the queue lists only `review` rows, so that is the state decide
 * left). Guarded on the disposition the decision set: if a sweep or a report moved the row since,
 * the undo refuses rather than overwrite a newer judgment. A decision writes nothing else (no
 * delivery is queued, no note is added), so resetting the disposition leaves no trace to unwind.
 */
export async function undoDecision(id: string, from: "publish" | "rejected"): Promise<ActionResult> {
  return attempt(async () => {
    await requireDashboard();
    const { fundingRounds } = schema;
    const handle = await db();
    const moved = await handle
      .update(fundingRounds)
      .set({ disposition: "review", updatedAt: new Date() })
      .where(and(eq(fundingRounds.id, id), eq(fundingRounds.disposition, from)))
      .returning({ id: fundingRounds.id });
    if (moved.length === 0) throw new Error("The record changed since the decision; it was left as it is.");
    await invalidateEntityPages(handle, { roundIds: [id] });
    revalidatePath("/");
    revalidatePath("/feed");
    revalidatePath("/review");
    revalidateTag(TAG_ROUNDS, "max");
  });
}

/** A reader saw something wrong in a row: it goes back to review carrying their reason. */
export async function report(id: string, reason: string): Promise<ActionResult> {
  return attempt(async () => {
    await requireDashboard();
    const why = reason.trim();
    if (!why) return;
    const handle = await db();
    await reportRound(handle, id, why);
    await invalidateEntityPages(handle, { roundIds: [id] });
    revalidatePath("/");
    revalidatePath("/feed");
    revalidatePath("/review");
    revalidateTag(TAG_ROUNDS, "max");
  });
}

/** Teach the resolver that `alias` is the same company as `canonical`. Applies on the next run. */
export async function addAlias(alias: string, canonical: string): Promise<ActionResult> {
  return attempt(async () => {
    await requireDashboard();
    await saveAlias(await db(), alias, canonical);
    revalidatePath("/review");
  });
}
