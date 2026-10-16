"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, attempt } from "@/lib/action-result";
import { requireDashboard } from "@/lib/dashboard-auth.server";
import { db } from "@/lib/db";
import { SIGNAL_STATUSES, type SignalStatus, setSignalStatus } from "@/lib/signals";

export async function changeSignalStatus(id: string, status: SignalStatus): Promise<ActionResult> {
  return attempt(async () => {
    await requireDashboard();
    if (!id || !SIGNAL_STATUSES.includes(status)) throw new Error("That signal decision is not valid.");
    await setSignalStatus(await db(), id, status);
    revalidatePath("/signals");
  });
}
