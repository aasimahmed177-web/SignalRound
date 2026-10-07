// Fan-out. New records become outbox rows, one per (record, target); the sender
// walks the outbox with backoff. Slack gets Block Kit through an incoming webhook;
// webhooks get the Standard Webhooks envelope (webhook-id, webhook-timestamp,
// webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">); an email
// target's rows wait and go out together as one digest per cadence window, through Resend.

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, lte, ne, notLike, sql } from "drizzle-orm";
import { acceptsCertainty, deliverableRounds, newsBlocks } from "./deliverable.ts";
import type { DigestCadence, DigestState } from "./digest.ts";
import { digestDue, digestHtml, digestKey, digestSubject, digestText, digestUnsubscribeUrl, parseDigestState } from "./digest.ts";
import { type DeliveryRow, markDead, markFailed, markSent, rowKey } from "./outbox.ts";
import type { RoundRow } from "./persist.ts";
import { listRounds } from "./persist.ts";
import { slackBlocks } from "./slack-blocks.ts";
import { decryptWebhook, revokeSlackTarget, slackWebhookKey } from "./slack-credentials.ts";
import { enqueueSubscriptions, flushSubscriptionDeliveries, postToSlack } from "./slack-delivery.ts";

const { deliveries, deliveryTargets, settings } = schema;

// A hung endpoint must not stall the outbox: flushDeliveries runs inline in the sweep's deliver
// step and in Settings actions, so every send is bounded and a timeout takes the backoff path.
const DELIVERY_TIMEOUT_MS = 15_000;

const RESEND_URL = "https://api.resend.com/emails";

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

export function signStandardWebhook(secret: string, msgId: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${msgId}.${timestamp}.${body}`).digest("base64");
  return `v1,${sig}`;
}

export function roundEvent(r: RoundRow): Record<string, unknown> {
  return {
    type: r.status === "updated" ? "round.updated" : "round.created",
    timestamp: new Date().toISOString(),
    data: {
      id: r.id,
      status: r.status,
      certainty: r.certainty,
      company: r.company,
      stage: r.stage,
      stage_as_written: r.stage_as_written,
      amount: r.amount,
      valuation_as_written: r.valuation_as_written,
      announced_on: r.announced_on,
      lead_investors: r.lead_investors,
      other_investors: r.other_investors,
      confidence: r.confidence,
      sources: r.sources.map((s) => s.url),
    },
  };
}

// The Block Kit builder lives in slack-blocks.ts, so the subscription messages can build on it
// without importing the outbox; it is re-exported here for the callers that always read it here.
export type { SlackBlock, SlackButton, SlackMessage, SlackText } from "./slack-blocks.ts";
export { slackBlocks } from "./slack-blocks.ts";

export interface Target {
  id: string;
  channel: "slack" | "webhook" | "email";
  target: string;
  secret: string | null;
  presetSlug: string | null;
  minConfidence: number;
  includeExpected: boolean;
}

function toTarget(t: typeof deliveryTargets.$inferSelect): Target {
  return {
    id: t.id,
    channel: t.channel,
    target: t.target,
    secret: t.secret,
    presetSlug: t.presetSlug,
    minConfidence: Number(t.minConfidence),
    includeExpected: t.includeExpected,
  };
}

export async function enabledTargets(handle: Db): Promise<Target[]> {
  const rows = await handle.select().from(deliveryTargets).where(eq(deliveryTargets.enabled, true));
  return rows.map(toTarget);
}

/** An email target's cadence and last send, under settings key digest:<targetId>. Weekly with no send when no row exists. */
export async function readDigestState(handle: Db, targetId: string): Promise<DigestState> {
  const [row] = await handle
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, digestKey(targetId)))
    .limit(1);
  return parseDigestState(row?.value);
}

export async function writeDigestState(handle: Db, targetId: string, state: DigestState): Promise<void> {
  const value = parseDigestState(state);
  await handle
    .insert(settings)
    .values({ key: digestKey(targetId), value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export async function deleteDigestState(handle: Db, targetId: string): Promise<void> {
  await handle.delete(settings).where(eq(settings.key, digestKey(targetId)));
}

/** Both env values are needed to send; without them the rows wait in the outbox and the row says why. */
export function emailConfig(): { apiKey: string; from: string } | { error: string } {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.DIGEST_FROM;
  if (!apiKey) return { error: "RESEND_API_KEY is not set: the digest waits in the outbox until it is" };
  if (!from) return { error: "DIGEST_FROM is not set: the digest waits in the outbox until it is" };
  return { apiKey, from };
}

async function sendDigest(
  t: Target,
  rounds: RoundRow[],
  cadence: DigestCadence,
  origin: string,
  fetchImpl: typeof fetch,
  config: { apiKey: string; from: string },
): Promise<void> {
  const unsubscribeUrl = digestUnsubscribeUrl(origin, t.id, config.apiKey);
  const scope = { origin, cadence, presetSlug: t.presetSlug, minConfidence: t.minConfidence, unsubscribeUrl };
  const res = await fetchImpl(RESEND_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: config.from,
      to: t.target,
      subject: digestSubject(rounds.length, cadence),
      html: digestHtml(rounds, scope),
      text: digestText(rounds, scope),
      // RFC 8058 one-click: a mail client's Unsubscribe button POSTs to the link and the digest turns off.
      headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** The newest visible round as a one-round digest to one email target, outside the outbox and its cadence. */
export async function sendSampleDigest(
  handle: Db,
  targetId: string,
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ round: string | null; error: string | null }> {
  const [row] = await handle.select().from(deliveryTargets).where(eq(deliveryTargets.id, targetId)).limit(1);
  if (row?.channel !== "email") return { round: null, error: "not an email target" };
  const { rows } = await listRounds(handle, { limit: 200, history: "exclude" });
  const r = (
    await deliverableRounds(
      handle,
      rows.filter((r) => acceptsCertainty(r, row.includeExpected)),
    )
  )[0];
  if (!r) return { round: null, error: null };
  const config = emailConfig();
  if ("error" in config) return { round: r.id, error: config.error };
  const { cadence } = await readDigestState(handle, targetId);
  try {
    await sendDigest(toTarget(row), [r], cadence, origin, fetchImpl, config);
    return { round: r.id, error: null };
  } catch (err) {
    return { round: r.id, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Queue one outbox row per (record, target). Duplicate rows are ignored by the primary key. History
 * rows (earlier rounds promoted from a dossier) are never queued: a 2021 seed is not news today.
 */
export async function enqueueDeliveries(handle: Db, roundIds: string[], presetSlug: string): Promise<number> {
  if (roundIds.length === 0) return 0;
  const targets = (await enabledTargets(handle)).filter((t) => !t.presetSlug || t.presetSlug === presetSlug);
  const rows: RoundRow[] = [];
  for (let i = 0; i < roundIds.length; i += 200) {
    const ids = roundIds.slice(i, i + 200);
    rows.push(...(await listRounds(handle, { ids, limit: ids.length, history: "exclude" })).rows);
  }
  const eligible = await deliverableRounds(handle, rows);
  let queued = 0;
  for (const r of eligible) {
    for (const t of targets) {
      if (r.confidence < t.minConfidence || !acceptsCertainty(r, t.includeExpected)) continue;
      const inserted = await handle
        .insert(deliveries)
        .values({ roundId: r.id, channel: t.channel, target: t.id })
        .onConflictDoNothing()
        .returning({ roundId: deliveries.roundId });
      queued += inserted.length;
      if (inserted.length === 0 && r.certainty === "announced" && r.reported_on) {
        const reopened = await handle
          .update(deliveries)
          .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null, updatedAt: new Date() })
          .where(
            and(
              eq(deliveries.roundId, r.id),
              eq(deliveries.channel, t.channel),
              eq(deliveries.target, t.id),
              inArray(deliveries.status, ["sent", "dead_letter"]),
              sql`coalesce(${deliveries.deliveredCertainty}, 'expected') <> 'announced'`,
            ),
          )
          .returning({ roundId: deliveries.roundId });
        queued += reopened.length;
      }
    }
  }
  // The public Slack subscriptions ride the same outbox, matched on each round's own preset.
  return queued + (await enqueueSubscriptions(handle, eligible));
}

class SlackTargetRevoked extends Error {}

async function send(t: Target, r: RoundRow, origin: string, fetchImpl: typeof fetch): Promise<void> {
  if (t.channel === "slack") {
    const key = slackWebhookKey();
    const url = key ? decryptWebhook(t.target, key) : null;
    if (!url) throw new Error("Slack webhook key missing or credential unreadable");
    const outcome = await postToSlack(url, slackBlocks(r, origin), fetchImpl);
    if (!outcome.ok) {
      if (outcome.kind === "revoke") throw new SlackTargetRevoked(`slack: ${outcome.code}`);
      throw new Error(`slack: ${outcome.code}`);
    }
    return;
  }
  if (t.channel === "webhook") {
    const body = JSON.stringify(roundEvent(r));
    const msgId = `msg_${randomUUID()}`;
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetchImpl(t.target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": msgId,
        "webhook-timestamp": String(ts),
        ...(t.secret ? { "webhook-signature": signStandardWebhook(t.secret, msgId, ts, body) } : {}),
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  throw new Error(`channel ${t.channel} is not wired for sending`);
}

export interface FlushSummary {
  sent: number;
  failed: number;
  deadLettered: number;
}

/** Send every due outbox row. Safe to call repeatedly: sent rows are skipped, failures back off. */
export async function flushDeliveries(handle: Db, origin: string, fetchImpl: typeof fetch = fetch, limit = 100): Promise<FlushSummary> {
  const due = await handle
    .select()
    .from(deliveries)
    // Server clock on both sides: next_attempt_at is a server now() at microsecond precision, and a
    // client Date (milliseconds) can read a row queued in the same millisecond as not yet due.
    .where(
      and(
        inArray(deliveries.status, ["pending", "failed"]),
        lte(deliveries.nextAttemptAt, sql`now()`),
        notLike(deliveries.target, "sub:%"),
        ne(deliveries.channel, "x"),
      ),
    )
    .limit(limit);
  // Subscription rows go through their own sender, which batches a burst per channel; X rows are the X lane's (lib/x-posts.ts).
  const subs = await flushSubscriptionDeliveries(handle, origin, fetchImpl);
  const summary: FlushSummary = { sent: subs.sent, failed: subs.failed, deadLettered: subs.deadLettered };
  if (due.length === 0) return summary;

  const targets = new Map((await enabledTargets(handle)).map((t) => [t.id, t]));
  const rows: RoundRow[] = [];
  const dueIds = [...new Set(due.map((d) => d.roundId))];
  for (let i = 0; i < dueIds.length; i += 200) {
    const ids = dueIds.slice(i, i + 200);
    rows.push(...(await listRounds(handle, { ids, limit: ids.length, includeReview: true, history: "exclude" })).rows);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  // A round the news rule refuses at the moment of sending (merged, held, or no longer news since it was
  // queued, as an email digest waits out its cadence) goes to the dead letters with the reason.
  const blocked = await newsBlocks(handle, rows);
  // An outbox row whose round is history (queued before a merge made it one, or by hand) is never sent.
  const history = new Set(
    (
      await handle
        .select({ id: schema.fundingRounds.id })
        .from(schema.fundingRounds)
        .where(and(inArray(schema.fundingRounds.id, [...new Set(due.map((d) => d.roundId))]), eq(schema.fundingRounds.history, true)))
    ).map((r) => r.id),
  );

  const emailRows = new Map<string, DeliveryRow[]>();
  for (const d of due) {
    if (d.channel === "email") {
      emailRows.set(d.target, [...(emailRows.get(d.target) ?? []), d]);
      continue;
    }
    const t = targets.get(d.target);
    const r = byId.get(d.roundId);
    const refusal =
      blocked.get(d.roundId) ??
      (r && !acceptsCertainty(r, t?.includeExpected ?? false) ? "expected round: target has not opted in" : undefined);
    if (t && r && refusal) {
      await markDead(handle, d, refusal);
      summary.deadLettered++;
      continue;
    }
    if (!t || !r) {
      await markDead(
        handle,
        d,
        !t ? "target disabled or deleted" : history.has(d.roundId) ? "history round: never delivered" : "record missing",
      );
      summary.deadLettered++;
      continue;
    }
    try {
      await send(t, r, origin, fetchImpl);
      await markSent(handle, d, r.certainty);
      summary.sent++;
    } catch (err) {
      if (err instanceof SlackTargetRevoked) {
        await markDead(handle, d, err.message);
        await revokeSlackTarget(handle, t.id);
        targets.delete(t.id);
        summary.deadLettered++;
        continue;
      }
      if (await markFailed(handle, d, err)) summary.deadLettered++;
      else summary.failed++;
    }
  }

  // Email rows travel together: one digest per target once its cadence window has passed, every
  // row it covers marked sent in the same pass. A missing key holds them pending rather than burning attempts.
  for (const [targetId, group] of emailRows) {
    const t = targets.get(targetId);
    if (!t) {
      for (const d of group) await markDead(handle, d, "target disabled or deleted");
      summary.deadLettered += group.length;
      continue;
    }
    const batch: Array<{ d: DeliveryRow; r: RoundRow }> = [];
    for (const d of group) {
      const r = byId.get(d.roundId);
      const refusal =
        blocked.get(d.roundId) ?? (r && !acceptsCertainty(r, t.includeExpected) ? "expected round: target has not opted in" : undefined);
      if (r && refusal) {
        await markDead(handle, d, refusal);
        summary.deadLettered++;
      } else if (r) batch.push({ d, r });
      else {
        await markDead(handle, d, history.has(d.roundId) ? "history round: never delivered" : "record missing");
        summary.deadLettered++;
      }
    }
    if (batch.length === 0) continue;
    const config = emailConfig();
    if ("error" in config) {
      for (const { d } of batch) await handle.update(deliveries).set({ lastError: config.error, updatedAt: new Date() }).where(rowKey(d));
      continue;
    }
    const state = await readDigestState(handle, targetId);
    if (!digestDue(state)) continue;
    const rounds = batch.map((b) => b.r).sort((a, b) => (b.announced_on ?? "").localeCompare(a.announced_on ?? ""));
    try {
      await sendDigest(t, rounds, state.cadence, origin, fetchImpl, config);
      for (const { d, r } of batch) await markSent(handle, d, r.certainty);
      await writeDigestState(handle, targetId, { cadence: state.cadence, lastSentAt: new Date().toISOString() });
      summary.sent += batch.length;
    } catch (err) {
      for (const { d } of batch) {
        if (await markFailed(handle, d, err)) summary.deadLettered++;
        else summary.failed++;
      }
    }
  }
  return summary;
}

export async function deliveryCounts(handle: Db): Promise<Record<string, number>> {
  const rows = await handle
    .select({ status: deliveries.status, count: sql<number>`count(*)::int` })
    .from(deliveries)
    .groupBy(deliveries.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}
