// The outbox's row bookkeeping, shared by the target sender (delivery.ts) and the subscription
// sender (slack-delivery.ts): sent, dead-lettered, or failed with the backoff schedule.

import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq } from "drizzle-orm";

const { deliveries } = schema;

/** Minutes before each retry; a row that fails past the last step is dead-lettered. */
export const BACKOFF_MINUTES = [0, 5, 30, 120, 300, 600, 600, 600];

export type DeliveryRow = typeof deliveries.$inferSelect;

export function rowKey(d: DeliveryRow) {
  return and(eq(deliveries.roundId, d.roundId), eq(deliveries.channel, d.channel), eq(deliveries.target, d.target));
}

export async function markSent(
  handle: Db,
  d: DeliveryRow,
  certainty: "announced" | "reported" | "expected" | "unconfirmed" = "announced",
): Promise<void> {
  await handle
    .update(deliveries)
    .set({ status: "sent", deliveredCertainty: certainty, attempts: d.attempts + 1, lastError: null, updatedAt: new Date() })
    .where(rowKey(d));
}

export async function markDead(handle: Db, d: DeliveryRow, reason: string): Promise<void> {
  await handle.update(deliveries).set({ status: "dead_letter", lastError: reason, updatedAt: new Date() }).where(rowKey(d));
}

/** One more failed attempt: back off, or dead-letter once the schedule is spent. Returns true when dead. */
export async function markFailed(handle: Db, d: DeliveryRow, err: unknown): Promise<boolean> {
  const attempts = d.attempts + 1;
  const dead = attempts >= BACKOFF_MINUTES.length;
  const next = new Date(Date.now() + (BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)] ?? 600) * 60_000);
  await handle
    .update(deliveries)
    .set({
      status: dead ? "dead_letter" : "failed",
      attempts,
      nextAttemptAt: next,
      lastError: err instanceof Error ? err.message : String(err),
      updatedAt: new Date(),
    })
    .where(rowKey(d));
  return dead;
}
