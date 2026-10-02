// The public Add to Slack. Any visitor to a public demo can connect a channel of their own: the
// same OAuth v2 flow as the admin install (lib/slack.ts, the one `incoming-webhook` scope), but the
// channel becomes a subscription (not a delivery target), so the visitor gets no other write. Only
// what delivery needs is kept: workspace and channel names and ids, the webhook encrypted with
// SLACK_WEBHOOK_KEY, the preset and cadence, and the hash of a manage token. Sending lives in
// lib/slack-delivery.ts; the messages in lib/slack-messages.ts.

import { createHash, createHmac, hkdfSync, randomUUID } from "node:crypto";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { slackOAuthConfig } from "./slack.ts";
import { encryptWebhook } from "./slack-credentials.ts";

export { decryptWebhook, encryptWebhook } from "./slack-credentials.ts";

const { slackSubscriptions, deliveries } = schema;

export type Cadence = "instant" | "daily";
export type SubscriptionStatus = "active" | "paused" | "revoked";

export const CADENCES: readonly Cadence[] = ["instant", "daily"];

/** Every preset mixed: the default, and the public feed's own name for it. */
export const ALL_PRESETS = "all";

/** Active subscriptions the instance accepts in total, unless SLACK_SUBSCRIPTION_CAP says otherwise. */
export const DEFAULT_SUBSCRIPTION_CAP = 500;

/** Channels one workspace may connect: plenty for a team, too few to farm. */
export const TEAM_CHANNEL_CAP = 20;

/** Posts one subscription receives per UTC day, cards, digests, tests, and the welcome together. */
export const DAILY_POST_CAP = 50;

export const SLACK_CONNECT_PATH = "/api/slack/connect";
export const SLACK_CONNECTED_PATH = "/api/slack/connected";
export const SLACK_MANAGE_PATH = "/slack/manage";
/** The public install's own page: the button with its pickers, and where a failed install lands. */
export const SLACK_PAGE_PATH = "/slack";

/** Its own cookie, apart from the admin install's, and sent only to the public callback. */
export const SLACK_CONNECT_COOKIE = "fireround_slack_connect";

export interface PublicSlackConfig {
  clientId: string;
  clientSecret: string;
  /** SLACK_WEBHOOK_KEY: the material both keys (webhook encryption, manage tokens) derive from. */
  key: string;
}

/**
 * The public install needs the Slack app and a key to encrypt webhooks with. Without the key it is
 * off, never on with plaintext webhooks: a stolen database would otherwise post to every channel.
 * A key shorter than 32 characters is treated as unset, so a placeholder cannot slip through.
 */
export function publicSlackConfig(): PublicSlackConfig | null {
  const app = slackOAuthConfig();
  const key = process.env.SLACK_WEBHOOK_KEY?.trim();
  if (!app || !key || key.length < 32) return null;
  return { ...app, key };
}

/** What is missing, for the refusal page and Settings; empty when the public install is on. */
export function publicSlackMissing(): string[] {
  const missing: string[] = [];
  if (!process.env.SLACK_CLIENT_ID?.trim()) missing.push("SLACK_CLIENT_ID");
  if (!process.env.SLACK_CLIENT_SECRET?.trim()) missing.push("SLACK_CLIENT_SECRET");
  const key = process.env.SLACK_WEBHOOK_KEY?.trim();
  if (!key || key.length < 32) missing.push("SLACK_WEBHOOK_KEY");
  return missing;
}

export function subscriptionCap(): number {
  const n = Number(process.env.SLACK_SUBSCRIPTION_CAP);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SUBSCRIPTION_CAP;
}

/** Where a public install that did not finish lands: the Slack page, with a reason code. */
export function slackPageUrl(origin: string, error?: string): string {
  const url = new URL(SLACK_PAGE_PATH, origin);
  if (error) url.searchParams.set("error", error);
  return url.toString();
}

export function slackConnectedRedirectUri(origin: string): string {
  return `${origin}${SLACK_CONNECTED_PATH}`;
}

/** A preset slug as a subscription stores it: a known slug, else every preset. */
export function normalizePreset(raw: string | null | undefined, known: readonly string[]): string {
  const slug = raw?.trim().toLowerCase() ?? "";
  return /^[a-z0-9-]{1,64}$/.test(slug) && known.includes(slug) ? slug : ALL_PRESETS;
}

export function normalizeCadence(raw: string | null | undefined): Cadence {
  return raw === "daily" ? "daily" : "instant";
}

/**
 * The state cookie's value: the random state, then the preset and cadence the visitor picked, so
 * the callback knows what to subscribe without trusting the query Slack echoes back. A state is
 * base64url and a slug is [a-z0-9-], so a dot separates them unambiguously.
 */
export function connectCookieValue(state: string, preset: string, cadence: Cadence): string {
  return `${state}.${preset}.${cadence}`;
}

export function parseConnectCookie(value: string | undefined | null): { state: string; preset: string; cadence: Cadence } | null {
  const m = value?.match(/^([A-Za-z0-9_-]{32,})\.([a-z0-9-]{1,64})\.(instant|daily)$/);
  return m ? { state: m[1], preset: m[2], cadence: m[3] as Cadence } : null;
}

// Keys. One secret in the environment, two purposes, so each gets its own key through HKDF: a
// leaked manage link says nothing about the encryption key, and the reverse.

function derive(material: string, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(material, "utf8"), Buffer.from("fireround"), Buffer.from(info), 32));
}

/**
 * A subscription's manage token: an HMAC of its id under the manage key. Derived rather than
 * stored, so every message can carry the link while the table keeps only its hash; the same
 * channel installed again keeps its id and so its link.
 */
export function manageToken(id: string, material: string): string {
  return createHmac("sha256", derive(material, "slack-manage")).update(`manage:${id}`).digest("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A token as the manage route receives it: 43 base64url characters, else not worth a query. */
export function isTokenShaped(token: string | null | undefined): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function manageUrl(origin: string, token: string): string {
  return `${origin}${SLACK_MANAGE_PATH}/${token}`;
}

export function unsubscribeUrl(origin: string, token: string): string {
  return `${manageUrl(origin, token)}?unsubscribe=1`;
}

// The store.

export interface Subscription {
  id: string;
  teamId: string;
  teamName: string | null;
  channelId: string;
  channelName: string | null;
  presetSlug: string;
  includeExpected: boolean;
  cadence: Cadence;
  status: SubscriptionStatus;
  failureCount: number;
  lastError: string | null;
  lastSentAt: Date | null;
  lastDigestAt: Date | null;
  lastTestAt: Date | null;
  postsDay: string | null;
  postsToday: number;
  createdAt: Date;
  /** Encrypted; decrypt only at the moment of sending. */
  webhookCiphertext: string | null;
}

type Row = typeof slackSubscriptions.$inferSelect;

function toSubscription(r: Row): Subscription {
  return {
    id: r.id,
    teamId: r.teamId,
    teamName: r.teamName,
    channelId: r.channelId,
    channelName: r.channelName,
    presetSlug: r.presetSlug,
    includeExpected: r.includeExpected,
    cadence: normalizeCadence(r.cadence),
    status: r.status === "paused" || r.status === "revoked" ? r.status : "active",
    failureCount: r.failureCount,
    lastError: r.lastError,
    lastSentAt: r.lastSentAt,
    lastDigestAt: r.lastDigestAt,
    lastTestAt: r.lastTestAt,
    postsDay: r.postsDay,
    postsToday: r.postsToday,
    createdAt: r.createdAt,
    webhookCiphertext: r.webhookCiphertext,
  };
}

/** "#deals" from Slack's "#deals" or "deals"; a DM keeps its "@". */
export function channelLabel(name: string | null): string {
  if (!name) return "your channel";
  return name.startsWith("#") || name.startsWith("@") ? name : `#${name}`;
}

export interface SubscribeInput {
  webhookUrl: string;
  teamId: string;
  botUserId?: string | null;
  userId?: string | null;
  teamName: string | null;
  channelId: string;
  channelName: string | null;
  presetSlug: string;
  cadence: Cadence;
}

export class SubscribeRefused extends Error {
  constructor(readonly code: "full" | "team_full") {
    super(code === "full" ? "subscriptions are full" : "this workspace has too many channels connected");
    this.name = "SubscribeRefused";
  }
}

/**
 * Create the subscription, or update the one this (team, channel) already has: a fresh webhook,
 * the new picks, active again, failures cleared. Refuses a new channel past the instance cap or the
 * per-workspace cap; a reinstall always passes, since it adds nothing. Returns the manage token.
 */
export async function upsertSubscription(
  handle: Db,
  input: SubscribeInput,
  material: string,
  caps: { total?: number; team?: number } = {},
): Promise<{ id: string; token: string; created: boolean }> {
  const [existing] = await handle
    .select({ id: slackSubscriptions.id })
    .from(slackSubscriptions)
    .where(and(eq(slackSubscriptions.teamId, input.teamId), eq(slackSubscriptions.channelId, input.channelId)))
    .limit(1);
  if (!existing) {
    const [counts] = await handle
      .select({
        total: sql<number>`count(*) filter (where ${slackSubscriptions.status} <> 'revoked')::int`,
        team: sql<number>`count(*) filter (where ${slackSubscriptions.status} <> 'revoked' and ${slackSubscriptions.teamId} = ${input.teamId})::int`,
      })
      .from(slackSubscriptions);
    if ((counts?.total ?? 0) >= (caps.total ?? subscriptionCap())) throw new SubscribeRefused("full");
    if ((counts?.team ?? 0) >= (caps.team ?? TEAM_CHANNEL_CAP)) throw new SubscribeRefused("team_full");
  }
  const id = existing?.id ?? randomUUID();
  const token = manageToken(id, material);
  const webhookCiphertext = encryptWebhook(input.webhookUrl, material);
  const fields = {
    teamName: input.teamName,
    botUserId: input.botUserId ?? null,
    userId: input.userId ?? null,
    channelName: input.channelName,
    webhookCiphertext,
    presetSlug: input.presetSlug,
    cadence: input.cadence,
    status: "active" as const,
    failureCount: 0,
    lastError: null,
    updatedAt: new Date(),
  };
  const [row] = await handle
    .insert(slackSubscriptions)
    .values({ id, teamId: input.teamId, channelId: input.channelId, manageTokenHash: hashToken(token), ...fields })
    .onConflictDoUpdate({ target: [slackSubscriptions.teamId, slackSubscriptions.channelId], set: fields })
    .returning({ id: slackSubscriptions.id });
  // A race between two installs of one channel keeps whichever id won the insert; its token follows.
  const finalId = row?.id ?? id;
  return { id: finalId, token: finalId === id ? token : manageToken(finalId, material), created: !existing };
}

export async function subscriptionById(handle: Db, id: string): Promise<Subscription | null> {
  const [row] = await handle.select().from(slackSubscriptions).where(eq(slackSubscriptions.id, id)).limit(1);
  return row ? toSubscription(row) : null;
}

export async function subscriptionsByIds(handle: Db, ids: string[]): Promise<Map<string, Subscription>> {
  if (ids.length === 0) return new Map();
  const rows = await handle.select().from(slackSubscriptions).where(inArray(slackSubscriptions.id, ids));
  return new Map(rows.map((r) => [r.id, toSubscription(r)]));
}

/** The subscription a manage link names, or null for a malformed or unknown token. */
export async function subscriptionByToken(handle: Db, token: string | null | undefined): Promise<Subscription | null> {
  if (!isTokenShaped(token)) return null;
  const [row] = await handle
    .select()
    .from(slackSubscriptions)
    .where(eq(slackSubscriptions.manageTokenHash, hashToken(token)))
    .limit(1);
  return row ? toSubscription(row) : null;
}

export async function listSubscriptions(
  handle: Db,
  where: { status?: SubscriptionStatus; cadence?: Cadence } = {},
): Promise<Subscription[]> {
  const conds = [
    ...(where.status ? [eq(slackSubscriptions.status, where.status)] : []),
    ...(where.cadence ? [eq(slackSubscriptions.cadence, where.cadence)] : []),
  ];
  const rows = await handle
    .select()
    .from(slackSubscriptions)
    .where(conds.length ? and(...conds) : undefined);
  return rows.map(toSubscription);
}

/** Change what an active or paused subscription receives. A revoked one stays revoked: reinstall to return. */
export async function updateSubscription(
  handle: Db,
  id: string,
  patch: { presetSlug?: string; includeExpected?: boolean; cadence?: Cadence; status?: "active" | "paused" },
): Promise<void> {
  const set: Partial<Row> = { updatedAt: new Date() };
  if (patch.presetSlug !== undefined) set.presetSlug = patch.presetSlug;
  if (patch.includeExpected !== undefined) set.includeExpected = patch.includeExpected;
  if (patch.cadence !== undefined) {
    set.cadence = patch.cadence;
    // A switch to daily starts its window now, so the first digest does not repeat what just posted.
    if (patch.cadence === "daily") set.lastDigestAt = new Date();
  }
  if (patch.status !== undefined) set.status = patch.status;
  await handle
    .update(slackSubscriptions)
    .set(set)
    .where(and(eq(slackSubscriptions.id, id), inArray(slackSubscriptions.status, ["active", "paused"])));
  if (patch.status === "paused" || patch.cadence === "daily") await dropQueued(handle, id);
}

/** The outbox's key for a subscription: rows share the deliveries table with the admin targets. */
export function outboxTarget(id: string): string {
  return `sub:${id}`;
}

async function dropQueued(handle: Db, id: string): Promise<void> {
  await handle.delete(deliveries).where(and(eq(deliveries.target, outboxTarget(id)), inArray(deliveries.status, ["pending", "failed"])));
}

/**
 * End a subscription: revoked, the webhook forgotten, anything queued dropped. `reason` is a short
 * code (unsubscribed, channel_not_found, ...), the only trace kept of why.
 */
export async function revokeSubscription(handle: Db, id: string, reason: string): Promise<void> {
  await handle
    .update(slackSubscriptions)
    .set({ status: "revoked", webhookCiphertext: null, lastError: reason.slice(0, 64), updatedAt: new Date() })
    .where(eq(slackSubscriptions.id, id));
  await dropQueued(handle, id);
}

export interface SubscriptionCounts {
  active: number;
  paused: number;
  revoked: number;
  instant: number;
  daily: number;
  workspaces: number;
  queued: number;
}

/** What Settings shows an admin: counts only, never a workspace, a channel, or a webhook. */
export async function subscriptionCounts(handle: Db): Promise<SubscriptionCounts> {
  const [row] = await handle
    .select({
      active: sql<number>`count(*) filter (where ${slackSubscriptions.status} = 'active')::int`,
      paused: sql<number>`count(*) filter (where ${slackSubscriptions.status} = 'paused')::int`,
      revoked: sql<number>`count(*) filter (where ${slackSubscriptions.status} = 'revoked')::int`,
      instant: sql<number>`count(*) filter (where ${slackSubscriptions.status} = 'active' and ${slackSubscriptions.cadence} = 'instant')::int`,
      daily: sql<number>`count(*) filter (where ${slackSubscriptions.status} = 'active' and ${slackSubscriptions.cadence} = 'daily')::int`,
      workspaces: sql<number>`count(distinct ${slackSubscriptions.teamId}) filter (where ${slackSubscriptions.status} <> 'revoked')::int`,
    })
    .from(slackSubscriptions);
  const [queued] = await handle
    .select({ n: sql<number>`count(*)::int` })
    .from(deliveries)
    .where(and(like(deliveries.target, "sub:%"), inArray(deliveries.status, ["pending", "failed"])));
  return {
    active: row?.active ?? 0,
    paused: row?.paused ?? 0,
    revoked: row?.revoked ?? 0,
    instant: row?.instant ?? 0,
    daily: row?.daily ?? 0,
    workspaces: row?.workspaces ?? 0,
    queued: queued?.n ?? 0,
  };
}

/** YYYY-MM-DD in UTC: the day the post cap counts. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Posts still allowed today under the daily cap. */
export function postsLeft(sub: Pick<Subscription, "postsDay" | "postsToday">, now: Date, cap = DAILY_POST_CAP): number {
  return Math.max(0, cap - (sub.postsDay === utcDay(now) ? sub.postsToday : 0));
}

/** Record `n` posts that reached Slack: the day's count, the last send, and a clean failure streak. */
export async function recordPosts(handle: Db, id: string, n: number, now: Date): Promise<void> {
  if (n <= 0) return;
  const day = utcDay(now);
  await handle
    .update(slackSubscriptions)
    .set({
      postsToday: sql`case when ${slackSubscriptions.postsDay} = ${day} then ${slackSubscriptions.postsToday} + ${n} else ${n} end`,
      postsDay: day,
      lastSentAt: now,
      failureCount: 0,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(slackSubscriptions.id, id));
}

/** A failed post that did not end the subscription: one more in the streak, and why. */
export async function recordFailure(handle: Db, id: string, code: string): Promise<void> {
  await handle
    .update(slackSubscriptions)
    .set({ failureCount: sql`${slackSubscriptions.failureCount} + 1`, lastError: code.slice(0, 64), updatedAt: new Date() })
    .where(eq(slackSubscriptions.id, id));
}

export async function markDigestSent(handle: Db, id: string, now: Date): Promise<void> {
  await handle.update(slackSubscriptions).set({ lastDigestAt: now, updatedAt: now }).where(eq(slackSubscriptions.id, id));
}

export async function markTestSent(handle: Db, id: string, now: Date): Promise<void> {
  await handle.update(slackSubscriptions).set({ lastTestAt: now, updatedAt: now }).where(eq(slackSubscriptions.id, id));
}

/** Active and paused subscriptions: what the total cap counts. */
export async function liveSubscriptionCount(handle: Db): Promise<number> {
  const [row] = await handle
    .select({ n: sql<number>`count(*)::int` })
    .from(slackSubscriptions)
    .where(inArray(slackSubscriptions.status, ["active", "paused"]));
  return row?.n ?? 0;
}

/**
 * Every way the public install can end short of a subscription, as a code on /slack?error= and a
 * sentence there. The page renders only these sentences, so a crafted link cannot put words on it.
 */
const CONNECT_ERRORS: Record<string, string> = {
  not_configured: "Add to Slack is not switched on for this site yet. The /feed command below works without it.",
  rate_limited: "Too many installs from here in a short while. Wait a few minutes and try again.",
  access_denied: "You cancelled on Slack's screen, so nothing was connected.",
  state_mismatch: "The install could not be verified (it may have expired or started in another browser). Start again.",
  no_code: "Slack came back without an install code. Start again.",
  unreachable: "Could not reach Slack to finish the install. Try again.",
  bad_response: "Slack answered with an error while finishing the install. Try again.",
  no_webhook: "Slack finished without a channel to post to. Start again and pick a channel.",
  full: "Fireround has reached its limit of connected channels for now. The /feed command below still works.",
  team_full: "This workspace already has the most channels Fireround connects. Remove one from its manage page first.",
  save_failed: "Slack connected, but the subscription could not be saved. Try again in a minute.",
};

export function connectErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  if (Object.hasOwn(CONNECT_ERRORS, code)) return CONNECT_ERRORS[code];
  return "The install did not finish. Start again from Add to Slack.";
}
