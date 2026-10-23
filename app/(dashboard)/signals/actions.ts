"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, attempt } from "@/lib/action-result";
import { requireDashboard } from "@/lib/dashboard-auth.server";
import { db } from "@/lib/db";
import { discoverNativeSignals } from "@/lib/native-discovery";
import { ingestSignal, parseSignalInput, SIGNAL_STATUSES, type SignalStatus, setSignalStatus } from "@/lib/signals";

export async function discoverSignals(
  query: string,
): Promise<ActionResult<{ value: { stored: number; contacts: number; warnings: string[] } }>> {
  return attempt(async () => {
    await requireDashboard();
    if (typeof query !== "string" || query.length > 240) throw new Error("Use a search or website URL under 240 characters.");
    const handle = await db();
    const { observations, warnings } = await discoverNativeSignals(query.trim());
    for (const observation of observations) await ingestSignal(handle, parseSignalInput(observation.input));
    revalidatePath("/signals");
    return {
      stored: observations.length,
      contacts: observations.reduce((sum, observation) => sum + observation.contacts.length, 0),
      warnings,
    };
  });
}

export async function changeSignalStatus(id: string, status: SignalStatus): Promise<ActionResult> {
  return attempt(async () => {
    await requireDashboard();
    if (!id || !SIGNAL_STATUSES.includes(status)) throw new Error("That signal decision is not valid.");
    await setSignalStatus(await db(), id, status);
    revalidatePath("/signals");
  });
}
