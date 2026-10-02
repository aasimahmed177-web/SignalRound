"use server";

// The manage page's writes. A visitor holds no password, so each action is gated by the manage
// token in its first argument instead: a malformed token or a switched-off install is refused
// before the store opens, and an unknown one after a single indexed lookup of its hash. Only a
// PublicError's sentence reaches the visitor; any other failure reads as one generic line. Each
// action touches only the one subscription the token names; none reaches a delivery target, a
// preset, or anything else the demo keeps read-only.

import { headers } from "next/headers";
import { type ActionResult, attemptPublic, PublicError } from "@/lib/action-result";
import { db } from "@/lib/db";
import { publicOrigin } from "@/lib/origin";
import { listPresets } from "@/lib/presets";
import { postFailureMessage, sendTest } from "@/lib/slack-delivery";
import {
  isTokenShaped,
  manageToken,
  normalizeCadence,
  normalizePreset,
  publicSlackConfig,
  revokeSubscription,
  type Subscription,
  subscriptionByToken,
  updateSubscription,
} from "@/lib/slack-subscriptions";
import { tokenEquals } from "@/lib/tokens";

const INVALID = "This manage link is not valid. Use the Manage link on any message Fireround posted in the channel.";

/**
 * The subscription a token names, or a throw. The token must also still derive from the current
 * key, so rotating SLACK_WEBHOOK_KEY retires every old link (and every webhook) together.
 */
async function authorize(token: unknown): Promise<{ handle: Awaited<ReturnType<typeof db>>; sub: Subscription }> {
  if (typeof token !== "string" || !isTokenShaped(token)) throw new PublicError(INVALID);
  const config = publicSlackConfig();
  if (!config) throw new PublicError("Add to Slack is switched off on this site right now.");
  const handle = await db();
  const sub = await subscriptionByToken(handle, token);
  if (!sub || !tokenEquals(manageToken(sub.id, config.key), token)) throw new PublicError(INVALID);
  return { handle, sub };
}

function live(sub: Subscription): void {
  if (sub.status === "revoked") throw new PublicError("This channel is unsubscribed. Add Fireround to it again to reconnect.");
}

/** Change the preset and the cadence. An unknown preset falls back to every round, never an error. */
export async function saveSubscription(
  token: string,
  input: { preset: string; cadence: string; includeExpected?: boolean },
): Promise<ActionResult> {
  const r = await attemptPublic(async () => {
    const { handle, sub } = await authorize(token);
    live(sub);
    const known = (await listPresets(handle)).map((p) => p.slug);
    const presetSlug = normalizePreset(input?.preset, known);
    const cadence = normalizeCadence(input?.cadence);
    await updateSubscription(handle, sub.id, {
      ...(presetSlug !== sub.presetSlug ? { presetSlug } : {}),
      ...(cadence !== sub.cadence ? { cadence } : {}),
      ...(input.includeExpected !== undefined && input.includeExpected !== sub.includeExpected
        ? { includeExpected: input.includeExpected === true }
        : {}),
    });
  });
  return r.ok ? { ok: true } : r;
}

/** Pause or resume. A paused channel gets nothing and its queue is dropped; resuming starts fresh. */
export async function setSubscriptionPaused(token: string, paused: boolean): Promise<ActionResult> {
  const r = await attemptPublic(async () => {
    const { handle, sub } = await authorize(token);
    live(sub);
    await updateSubscription(handle, sub.id, { status: paused === true ? "paused" : "active" });
  });
  return r.ok ? { ok: true } : r;
}

/** Post the newest round under the preset as a test, at most once per cooldown. */
export async function sendSubscriptionTest(token: string): Promise<ActionResult> {
  const r = await attemptPublic(async () => {
    const { handle, sub } = await authorize(token);
    live(sub);
    const outcome = await sendTest(handle, sub, publicOrigin(await headers()));
    if (!outcome.ok) throw new PublicError(postFailureMessage(outcome));
  });
  return r.ok ? { ok: true } : r;
}

/** End the subscription: revoked, the webhook forgotten, the queue dropped. The page stays, saying so. */
export async function unsubscribe(token: string): Promise<ActionResult> {
  const r = await attemptPublic(async () => {
    const { handle, sub } = await authorize(token);
    if (sub.status !== "revoked") await revokeSubscription(handle, sub.id, "unsubscribed");
  });
  return r.ok ? { ok: true } : r;
}
