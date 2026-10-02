// Sending to public subscriptions. Instant subscriptions share the deliveries outbox with the admin
// targets (target `sub:<id>`), so a round is queued in the same step and never posts twice; a burst
// posts a few cards and one "and N more" note. Daily subscriptions get one digest each morning.
// Every post respects the per-subscription daily cap. A channel Slack says is gone (404, 410,
// channel_not_found, invalid_token, no_service) revokes its subscription and forgets the webhook;
// a 429 or a 5xx backs off and retries. Webhook URLs are decrypted only here, only to send.

import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, desc, eq, gt, inArray, like, lte, sql } from "drizzle-orm";
import { acceptsCertainty, deliverableRounds, newsBlocks } from "./deliverable.ts";
import { type DeliveryRow, markDead, markFailed, markSent, rowKey } from "./outbox.ts";
import type { RoundRow } from "./persist.ts";
import { listRounds } from "./persist.ts";
import { listPresets } from "./presets.ts";
import type { SlackMessage } from "./slack-blocks.ts";
import {
  BURST_CARDS,
  DIGEST_HOUR_UTC,
  digestMessage,
  type MessageScope,
  moreMessage,
  roundCard,
  testMessage,
  welcomeMessage,
} from "./slack-messages.ts";
import {
  ALL_PRESETS,
  decryptWebhook,
  listSubscriptions,
  manageToken,
  markDigestSent,
  markTestSent,
  outboxTarget,
  postsLeft,
  publicSlackConfig,
  recordFailure,
  recordPosts,
  revokeSubscription,
  type Subscription,
  subscriptionById,
  subscriptionsByIds,
} from "./slack-subscriptions.ts";
import { trendingRoundIds } from "./trending.ts";

const { deliveries, fundingRounds } = schema;

const POST_TIMEOUT_MS = 15_000;

/** Subscriptions one flush walks; the rest wait for the next flush, their rows still due. */
const FLUSH_SUBSCRIPTIONS = 50;

/** Seconds between two tests from one manage page. */
export const TEST_COOLDOWN_S = 30;

/** What Slack's answer means for the subscription. */
export type PostOutcome = { ok: true } | { ok: false; kind: "revoke" | "retry" | "fail"; code: string };

/**
 * Slack's incoming webhook errors that mean the channel is gone for good: the webhook was removed,
 * the app uninstalled, the channel archived or deleted, the workspace closed. Slack documents
 * these as the response body, with 404, 410, or 403 as the status.
 */
const GONE = new Set(["channel_not_found", "invalid_token", "no_service", "no_team", "team_disabled", "channel_is_archived"]);

/** Slack's body reduced to a code: lowercase words only, so nothing it sends can smuggle a URL into a log. */
function asCode(body: string): string {
  return body
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 48);
}

/** Pure: a webhook response as an outcome. */
export function classifySlackResponse(status: number, body: string): PostOutcome {
  if (status >= 200 && status < 300) return { ok: true };
  const code = asCode(body) || `http_${status}`;
  if (status === 404 || status === 410 || GONE.has(code)) return { ok: false, kind: "revoke", code };
  if (status === 429 || status >= 500) return { ok: false, kind: "retry", code: status === 429 ? "rate_limited" : code };
  return { ok: false, kind: "fail", code };
}

/** One message to one webhook. A timeout or a dropped connection is a retry, never a revoke. */
export async function postToSlack(url: string, message: SlackMessage, fetchImpl: typeof fetch = fetch): Promise<PostOutcome> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return classifySlackResponse(res.status, await res.text().catch(() => ""));
  } catch {
    return { ok: false, kind: "retry", code: "unreachable" };
  }
}

/** Preset slug to name, with `all` as "All rounds". */
export async function presetNames(handle: Db): Promise<Map<string, string>> {
  const presets = await listPresets(handle);
  return new Map([[ALL_PRESETS, "All rounds"], ...presets.map((p) => [p.slug, p.name] as [string, string])]);
}

function scopeFor(sub: Subscription, origin: string, key: string, names: Map<string, string>): MessageScope {
  return {
    origin,
    token: manageToken(sub.id, key),
    presetSlug: sub.presetSlug,
    presetName: names.get(sub.presetSlug) ?? sub.presetSlug,
  };
}

function matchesPreset(sub: Pick<Subscription, "presetSlug">, r: RoundRow): boolean {
  return sub.presetSlug === ALL_PRESETS || sub.presetSlug === r.preset_slug;
}

/** listRounds reads at most 200 ids at a time. */
async function roundsByIds(handle: Db, ids: string[]): Promise<RoundRow[]> {
  const out: RoundRow[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { rows } = await listRounds(handle, { ids: chunk, limit: chunk.length, history: "exclude" });
    out.push(...rows);
  }
  return out;
}

/**
 * Queue the new visible rounds for every active instant subscription whose preset matches. The
 * rows are the ones the caller already read as eligible (published or flagged, never history), and
 * a round first seen before the subscription existed is not news to it.
 */
export async function enqueueSubscriptions(handle: Db, rows: RoundRow[]): Promise<number> {
  const news = await deliverableRounds(handle, rows);
  if (news.length === 0) return 0;
  const subs = await listSubscriptions(handle, { status: "active", cadence: "instant" });
  const values = subs.flatMap((s) =>
    news
      .filter(
        (r) =>
          !r.history &&
          acceptsCertainty(r, s.includeExpected) &&
          matchesPreset(s, r) &&
          new Date(r.first_seen_at).getTime() >= s.createdAt.getTime(),
      )
      .map((r) => ({ roundId: r.id, channel: "slack" as const, target: outboxTarget(s.id) })),
  );
  if (values.length === 0) return 0;
  const inserted = await handle.insert(deliveries).values(values).onConflictDoNothing().returning({ roundId: deliveries.roundId });
  let queued = inserted.length;
  for (const value of values) {
    const round = news.find((r) => r.id === value.roundId);
    if (round?.certainty !== "announced" || !round.reported_on) continue;
    const reopened = await handle
      .update(deliveries)
      .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null, updatedAt: new Date() })
      .where(
        and(
          eq(deliveries.roundId, value.roundId),
          eq(deliveries.channel, value.channel),
          eq(deliveries.target, value.target),
          inArray(deliveries.status, ["sent", "dead_letter"]),
          sql`coalesce(${deliveries.deliveredCertainty}, 'expected') <> 'announced'`,
        ),
      )
      .returning({ roundId: deliveries.roundId });
    queued += reopened.length;
  }
  return queued;
}

export interface SubscriptionFlush {
  sent: number;
  failed: number;
  deadLettered: number;
  posts: number;
  revoked: number;
}

/** The next UTC midnight: when a capped subscription's rows come due again. */
function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5));
}

/**
 * Split a burst under the cap: how many rounds post as cards, and how many the closing note
 * counts. Pure. Five cards at most; the note needs a post of its own; with one post left and
 * several rounds, the note alone covers them all.
 */
export function planBurst(rounds: number, left: number, burst = BURST_CARDS): { cards: number; more: number } {
  if (rounds === 0 || left <= 0) return { cards: 0, more: 0 };
  let cards = Math.min(rounds, burst, left);
  if (rounds > cards && cards + 1 > left) cards = left - 1;
  return { cards, more: rounds - cards };
}

/** Send every due subscription row, grouped per subscription. Safe to call repeatedly. */
export async function flushSubscriptionDeliveries(
  handle: Db,
  origin: string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<SubscriptionFlush> {
  const summary: SubscriptionFlush = { sent: 0, failed: 0, deadLettered: 0, posts: 0, revoked: 0 };
  const due = await handle
    .select()
    .from(deliveries)
    .where(
      and(like(deliveries.target, "sub:%"), inArray(deliveries.status, ["pending", "failed"]), lte(deliveries.nextAttemptAt, sql`now()`)),
    )
    .orderBy(deliveries.createdAt)
    .limit(2000);
  if (due.length === 0) return summary;

  const groups = new Map<string, DeliveryRow[]>();
  for (const d of due) groups.set(d.target, [...(groups.get(d.target) ?? []), d]);
  const ids = [...groups.keys()].slice(0, FLUSH_SUBSCRIPTIONS).map((t) => t.slice(4));
  const subs = await subscriptionsByIds(handle, ids);
  const rounds = new Map(
    (await roundsByIds(handle, [...new Set(ids.flatMap((id) => (groups.get(outboxTarget(id)) ?? []).map((d) => d.roundId)))])).map((r) => [
      r.id,
      r,
    ]),
  );
  const blocked = await newsBlocks(handle, [...rounds.values()], now);
  const config = publicSlackConfig();
  const names = await presetNames(handle);

  const dead = async (rows: DeliveryRow[], reason: string) => {
    for (const d of rows) await markDead(handle, d, reason);
    summary.deadLettered += rows.length;
  };

  for (const id of ids) {
    const rows = groups.get(outboxTarget(id)) ?? [];
    const sub = subs.get(id);
    if (!sub) {
      await dead(rows, "subscription removed");
      continue;
    }
    if (sub.status !== "active") {
      await dead(rows, `subscription ${sub.status}`);
      continue;
    }
    if (sub.cadence !== "instant") {
      await dead(rows, "covered by the daily digest");
      continue;
    }
    if (!config) {
      for (const d of rows)
        await handle.update(deliveries).set({ lastError: "SLACK_WEBHOOK_KEY is not set", updatedAt: new Date() }).where(rowKey(d));
      continue;
    }
    const url = decryptWebhook(sub.webhookCiphertext, config.key);
    if (!url) {
      // Another key, or a corrupted row: back off rather than revoke, so restoring the key recovers it.
      for (const d of rows) (await markFailed(handle, d, "webhook_undecryptable")) ? summary.deadLettered++ : summary.failed++;
      await recordFailure(handle, sub.id, "webhook_undecryptable");
      continue;
    }
    const live: Array<{ d: DeliveryRow; r: RoundRow }> = [];
    const missing: DeliveryRow[] = [];
    for (const d of rows) {
      const r = rounds.get(d.roundId);
      const refusal =
        blocked.get(d.roundId) ??
        (r && !acceptsCertainty(r, sub.includeExpected) ? "expected round: subscription has not opted in" : undefined);
      if (r && refusal) await dead([d], refusal);
      else if (r && matchesPreset(sub, r)) live.push({ d, r });
      else missing.push(d);
    }
    if (missing.length) await dead(missing, "record missing, history, or outside the preset");
    if (live.length === 0) continue;

    const left = postsLeft(sub, now);
    if (left <= 0) {
      for (const { d } of live) {
        await handle
          .update(deliveries)
          .set({ nextAttemptAt: nextUtcDay(now), lastError: "daily cap reached", updatedAt: new Date() })
          .where(rowKey(d));
      }
      continue;
    }
    // The largest rounds get the cards; the note counts the rest.
    live.sort(
      (a, b) => (b.r.amount.usd_millions ?? -1) - (a.r.amount.usd_millions ?? -1) || b.r.first_seen_at.localeCompare(a.r.first_seen_at),
    );
    const { cards, more } = planBurst(live.length, left);
    const scope = scopeFor(sub, origin, config.key, names);
    const messages: Array<{ message: SlackMessage; covers: typeof live }> = [
      ...live.slice(0, cards).map((x) => ({ message: roundCard(x.r, scope), covers: [x] })),
      ...(more > 0 ? [{ message: moreMessage(more, scope), covers: live.slice(cards) }] : []),
    ];
    let posted = 0;
    let failure: Extract<PostOutcome, { ok: false }> | null = null;
    const done = new Set<DeliveryRow>();
    for (const m of messages) {
      const outcome = await postToSlack(url, m.message, fetchImpl);
      if (!outcome.ok) {
        failure = outcome;
        break;
      }
      posted++;
      for (const { d, r } of m.covers) {
        await markSent(handle, d, r.certainty);
        done.add(d);
        summary.sent++;
      }
    }
    await recordPosts(handle, sub.id, posted, now);
    summary.posts += posted;
    if (!failure) continue;
    const rest = live.filter((x) => !done.has(x.d)).map((x) => x.d);
    if (failure.kind === "revoke") {
      await dead(rest, `subscription revoked: ${failure.code}`);
      await revokeSubscription(handle, sub.id, failure.code);
      summary.revoked++;
      continue;
    }
    for (const d of rest) (await markFailed(handle, d, `slack: ${failure.code}`)) ? summary.deadLettered++ : summary.failed++;
    await recordFailure(handle, sub.id, failure.code);
  }
  return summary;
}

/** Today's digest hour, UTC: a daily subscription whose last digest is older than this is due. */
export function digestCutoff(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DIGEST_HOUR_UTC));
}

/** Pure: whether a daily subscription is due its digest. Never before the hour, once a day after it. */
export function digestDueFor(sub: Pick<Subscription, "lastDigestAt" | "createdAt">, now: Date): boolean {
  const cutoff = digestCutoff(now);
  if (now < cutoff) return false;
  return (sub.lastDigestAt ?? sub.createdAt) < cutoff;
}

/**
 * The visible, non-history rounds first seen after `since`, newest first, that are still news at `now`:
 * a round found today but announced more than NEWS_WINDOW_DAYS ago is left out of the digest's newly
 * found rounds (lib/deliverable.ts), as every other channel leaves it out.
 */
async function roundsSince(handle: Db, since: Date, now: Date): Promise<RoundRow[]> {
  const ids = await handle
    .select({ id: fundingRounds.id })
    .from(fundingRounds)
    .where(
      and(
        gt(fundingRounds.firstSeenAt, since),
        inArray(fundingRounds.disposition, ["publish", "flagged"]),
        eq(fundingRounds.history, false),
      ),
    )
    .orderBy(desc(fundingRounds.firstSeenAt))
    .limit(600);
  return deliverableRounds(
    handle,
    await roundsByIds(
      handle,
      ids.map((r) => r.id),
    ),
    now,
  );
}

/** The trending rounds, best first, read once per pass. */
async function trendingRounds(handle: Db, now: Date, limit = 30): Promise<RoundRow[]> {
  const ids = await trendingRoundIds(handle, now, limit);
  const order = new Map(ids.map((id, i) => [id, i]));
  return (await roundsByIds(handle, ids)).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export interface DigestSummary {
  sent: number;
  skipped: number;
  failed: number;
  revoked: number;
}

/**
 * The morning pass: every active daily subscription due its digest gets one, built from the rounds
 * first seen since its last digest (a day, at most two) and the trending rounds under its preset.
 * A quiet day posts nothing but still counts as done. A failure that is not a revoke leaves it due,
 * so the next cron call tries again.
 */
export async function sendDailyDigests(
  handle: Db,
  origin: string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<DigestSummary> {
  const summary: DigestSummary = { sent: 0, skipped: 0, failed: 0, revoked: 0 };
  const config = publicSlackConfig();
  if (!config || now < digestCutoff(now)) return summary;
  const due = (await listSubscriptions(handle, { status: "active", cadence: "daily" })).filter((s) => digestDueFor(s, now)).slice(0, 200);
  if (due.length === 0) return summary;
  const floor = new Date(now.getTime() - 48 * 3_600_000);
  const [recent, trending, names] = await Promise.all([roundsSince(handle, floor, now), trendingRounds(handle, now), presetNames(handle)]);
  for (const sub of due) {
    const lastWindow = sub.lastDigestAt && sub.lastDigestAt > floor ? sub.lastDigestAt : new Date(now.getTime() - 24 * 3_600_000);
    const rounds = recent.filter(
      (r) => acceptsCertainty(r, sub.includeExpected) && matchesPreset(sub, r) && new Date(r.first_seen_at) > lastWindow,
    );
    const message = digestMessage(
      { rounds, trending: trending.filter((r) => acceptsCertainty(r, sub.includeExpected) && matchesPreset(sub, r)), now },
      scopeFor(sub, origin, config.key, names),
    );
    if (!message || postsLeft(sub, now) <= 0) {
      await markDigestSent(handle, sub.id, now);
      summary.skipped++;
      continue;
    }
    const url = decryptWebhook(sub.webhookCiphertext, config.key);
    if (!url) {
      await recordFailure(handle, sub.id, "webhook_undecryptable");
      summary.failed++;
      continue;
    }
    const outcome = await postToSlack(url, message, fetchImpl);
    if (outcome.ok) {
      await markDigestSent(handle, sub.id, now);
      await recordPosts(handle, sub.id, 1, now);
      summary.sent++;
    } else if (outcome.kind === "revoke") {
      await revokeSubscription(handle, sub.id, outcome.code);
      summary.revoked++;
    } else {
      await recordFailure(handle, sub.id, outcome.code);
      summary.failed++;
    }
  }
  return summary;
}

/** The newest visible round under a preset, for the test message. */
async function newestFor(handle: Db, presetSlug: string): Promise<RoundRow | null> {
  const { rows } = await listRounds(handle, {
    limit: 1,
    history: "exclude",
    ...(presetSlug === ALL_PRESETS ? {} : { preset: presetSlug }),
  });
  return rows[0] ?? null;
}

/** Trending under a preset, else the newest: what the welcome shows. */
export async function welcomeRounds(
  handle: Db,
  presetSlug: string,
  now: Date,
  includeExpected = false,
): Promise<{ trending: RoundRow[]; latest: RoundRow[] }> {
  const trending = (await trendingRounds(handle, now))
    .filter((r) => acceptsCertainty(r, includeExpected))
    .filter((r) => presetSlug === ALL_PRESETS || r.preset_slug === presetSlug)
    .slice(0, 3);
  if (trending.length) return { trending, latest: [] };
  const { rows } = await listRounds(handle, {
    limit: 3,
    history: "exclude",
    ...(presetSlug === ALL_PRESETS ? {} : { preset: presetSlug }),
  });
  return { trending: [], latest: rows.filter((r) => acceptsCertainty(r, includeExpected)) };
}

/** A one-off post (the welcome, a test) and what it did to the subscription. */
async function postOnce(handle: Db, sub: Subscription, message: SlackMessage, fetchImpl: typeof fetch, now: Date): Promise<PostOutcome> {
  const config = publicSlackConfig();
  if (!config) return { ok: false, kind: "fail", code: "not_configured" };
  if (postsLeft(sub, now) <= 0) return { ok: false, kind: "fail", code: "daily_cap" };
  const url = decryptWebhook(sub.webhookCiphertext, config.key);
  if (!url) return { ok: false, kind: "fail", code: "webhook_undecryptable" };
  const outcome = await postToSlack(url, message, fetchImpl);
  if (outcome.ok) await recordPosts(handle, sub.id, 1, now);
  else if (outcome.kind === "revoke") await revokeSubscription(handle, sub.id, outcome.code);
  else await recordFailure(handle, sub.id, outcome.code);
  return outcome;
}

/** The message right after install: connected to #channel, what arrives, today's trending three. */
export async function sendWelcome(
  handle: Db,
  subId: string,
  origin: string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<PostOutcome> {
  const config = publicSlackConfig();
  const sub = await subscriptionById(handle, subId);
  if (!config || !sub) return { ok: false, kind: "fail", code: "not_configured" };
  const [picks, names] = await Promise.all([welcomeRounds(handle, sub.presetSlug, now, sub.includeExpected), presetNames(handle)]);
  const message = welcomeMessage({ channel: sub.channelName, cadence: sub.cadence, ...picks }, scopeFor(sub, origin, config.key, names));
  return postOnce(handle, sub, message, fetchImpl, now);
}

/** The manage page's Send a test: the newest round as a card, at most once per cooldown. */
export async function sendTest(
  handle: Db,
  sub: Subscription,
  origin: string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<PostOutcome> {
  const config = publicSlackConfig();
  if (!config) return { ok: false, kind: "fail", code: "not_configured" };
  if (sub.status !== "active") return { ok: false, kind: "fail", code: `subscription_${sub.status}` };
  if (sub.lastTestAt && now.getTime() - sub.lastTestAt.getTime() < TEST_COOLDOWN_S * 1000)
    return { ok: false, kind: "fail", code: "cooldown" };
  await markTestSent(handle, sub.id, now);
  const [r, names] = await Promise.all([newestFor(handle, sub.presetSlug), presetNames(handle)]);
  return postOnce(
    handle,
    sub,
    testMessage(r && acceptsCertainty(r, sub.includeExpected) ? r : null, scopeFor(sub, origin, config.key, names)),
    fetchImpl,
    now,
  );
}

/**
 * The welcome and a morning digest for "all rounds", built from the live store exactly as a channel
 * would get them, for the Slack page to draw. The manage token is a placeholder: the page renders
 * the previews inert, so no link in them goes anywhere.
 */
export async function slackPreviews(
  handle: Db,
  origin: string,
  now: Date = new Date(),
): Promise<{ welcome: SlackMessage; digest: SlackMessage | null }> {
  const scope: MessageScope = { origin, token: "preview", presetSlug: ALL_PRESETS, presetName: "All rounds" };
  const [picks, recent, trending] = await Promise.all([
    welcomeRounds(handle, ALL_PRESETS, now),
    roundsSince(handle, new Date(now.getTime() - 24 * 3_600_000), now),
    trendingRounds(handle, now),
  ]);
  return {
    welcome: welcomeMessage({ channel: "deals", cadence: "instant", ...picks }, scope),
    digest: digestMessage(
      { rounds: recent.filter((r) => acceptsCertainty(r, false)), trending: trending.filter((r) => acceptsCertainty(r, false)), now },
      scope,
    ),
  };
}

/**
 * A failed post, as a sentence for the manage page. Codes come from classifySlackResponse (already
 * reduced to lowercase words) or from this module, so nothing Slack sends is printed as prose.
 */
export function postFailureMessage(outcome: Extract<PostOutcome, { ok: false }>): string {
  switch (outcome.code) {
    case "cooldown":
      return `Wait ${TEST_COOLDOWN_S} seconds between tests.`;
    case "daily_cap":
      return "This channel has had its posts for today. The count resets at midnight UTC.";
    case "not_configured":
      return "Add to Slack is switched off on this site right now.";
    case "webhook_undecryptable":
      return "The channel's webhook could not be read. Add Fireround to the channel again.";
    case "rate_limited":
      return "Slack asked Fireround to slow down. Try again in a minute.";
    case "unreachable":
      return "Could not reach Slack. Try again in a minute.";
    case "subscription_paused":
      return "This channel is paused. Resume it to send a test.";
    case "subscription_revoked":
      return "This channel is unsubscribed.";
  }
  if (outcome.kind === "revoke")
    return `Slack says the channel's webhook is gone (${outcome.code}), so the subscription has ended. Add Fireround again to reconnect.`;
  return `Slack refused the message (${outcome.code}).`;
}
