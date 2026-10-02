import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { CoveragePlan, CoverageSetting } from "./coverage.ts";
import { parseCoverageSetting, resolveCoverage } from "./coverage.ts";
import { newWebhookSecret, writeDigestState } from "./delivery.ts";
import type { DigestCadence } from "./digest.ts";
import { encryptWebhook, slackWebhookKey, slackWebhookTeam } from "./slack-credentials.ts";

const { feedTokens, deliveryTargets, presetMonitors, settings } = schema;

const COVERAGE_KEY = "coverage";

/** The stored rung and overrides; Lite with nothing on top when no row exists. */
export async function getCoverageSetting(handle: Db): Promise<CoverageSetting> {
  const [row] = await handle.select({ value: settings.value }).from(settings).where(eq(settings.key, COVERAGE_KEY)).limit(1);
  return parseCoverageSetting(row?.value);
}

export async function setCoverageSetting(handle: Db, setting: CoverageSetting): Promise<void> {
  const value = parseCoverageSetting(setting);
  await handle
    .insert(settings)
    .values({ key: COVERAGE_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

/** The plan every lane reads: the rung with its overrides applied. */
export async function getCoverage(handle: Db): Promise<CoveragePlan> {
  return resolveCoverage(await getCoverageSetting(handle));
}

export interface FeedTokenRow {
  token_hash: string;
  label: string | null;
  preset_slug: string | null;
  include_expected: boolean;
  created_at: string;
  revoked_at: string | null;
}

export async function listFeedTokens(handle: Db): Promise<FeedTokenRow[]> {
  const rows = await handle.select().from(feedTokens).orderBy(desc(feedTokens.createdAt));
  return rows.map((r) => ({
    token_hash: r.tokenHash,
    label: r.label,
    preset_slug: r.presetSlug,
    include_expected: r.includeExpected,
    created_at: r.createdAt.toISOString(),
    revoked_at: r.revokedAt?.toISOString() ?? null,
  }));
}

/** Returns the plaintext token exactly once. */
export async function mintFeedToken(handle: Db, label: string, presetSlug: string | null, includeExpected = false): Promise<string> {
  const token = randomBytes(16).toString("base64url");
  await handle
    .insert(feedTokens)
    .values({ tokenHash: createHash("sha256").update(token).digest("hex"), label, presetSlug, includeExpected });
  return token;
}

export async function revokeFeedToken(handle: Db, tokenHash: string): Promise<void> {
  await handle.update(feedTokens).set({ revokedAt: new Date() }).where(eq(feedTokens.tokenHash, tokenHash));
}

export interface TargetRow {
  id: string;
  channel: "slack" | "webhook" | "email";
  target: string;
  label: string | null;
  preset_slug: string | null;
  min_confidence: number;
  include_expected: boolean;
  enabled: boolean;
  created_at: string;
}

export async function listTargets(handle: Db): Promise<TargetRow[]> {
  const rows = await handle.select().from(deliveryTargets).orderBy(desc(deliveryTargets.createdAt));
  return rows.map((t) => ({
    id: t.id,
    channel: t.channel,
    target: t.target,
    label: t.label,
    preset_slug: t.presetSlug,
    min_confidence: Number(t.minConfidence),
    include_expected: t.includeExpected,
    enabled: t.enabled,
    created_at: t.createdAt.toISOString(),
  }));
}

/** Returns the signing secret (webhooks only) exactly once. */
export async function createTarget(
  handle: Db,
  input: {
    channel: "slack" | "webhook";
    target: string;
    label?: string;
    presetSlug?: string | null;
    minConfidence?: number;
    includeExpected?: boolean;
    slackTeamId?: string | null;
    slackBotUserId?: string | null;
    slackUserId?: string | null;
  },
): Promise<{ id: string; secret: string | null }> {
  const id = randomUUID();
  const secret = input.channel === "webhook" ? newWebhookSecret() : null;
  let target = input.target;
  if (input.channel === "slack") {
    const key = slackWebhookKey();
    if (!key) throw new Error("Set SLACK_WEBHOOK_KEY to at least 32 characters before adding Slack targets.");
    target = encryptWebhook(target, key);
  }
  await handle.insert(deliveryTargets).values({
    id,
    channel: input.channel,
    target,
    slackTeamId: input.channel === "slack" ? (input.slackTeamId ?? slackWebhookTeam(input.target)) : null,
    slackBotUserId: input.channel === "slack" ? input.slackBotUserId : null,
    slackUserId: input.channel === "slack" ? input.slackUserId : null,
    label: input.label ?? null,
    secret,
    presetSlug: input.presetSlug ?? null,
    minConfidence: (input.minConfidence ?? 0.5).toFixed(2),
    includeExpected: input.includeExpected === true,
  });
  return { id, secret };
}

/** An email address that receives one digest per cadence window; the cadence lives under settings key digest:<id>. */
export async function createEmailTarget(
  handle: Db,
  input: {
    target: string;
    label?: string;
    presetSlug?: string | null;
    minConfidence?: number;
    includeExpected?: boolean;
    cadence: DigestCadence;
  },
): Promise<{ id: string; secret: null }> {
  const id = randomUUID();
  await handle.insert(deliveryTargets).values({
    id,
    channel: "email",
    target: input.target,
    label: input.label ?? null,
    secret: null,
    presetSlug: input.presetSlug ?? null,
    minConfidence: (input.minConfidence ?? 0.5).toFixed(2),
    includeExpected: input.includeExpected === true,
  });
  await writeDigestState(handle, id, { cadence: input.cadence, lastSentAt: null });
  return { id, secret: null };
}

export async function getTarget(handle: Db, id: string): Promise<TargetRow | null> {
  const [t] = await handle.select().from(deliveryTargets).where(eq(deliveryTargets.id, id)).limit(1);
  if (!t) return null;
  return {
    id: t.id,
    channel: t.channel,
    target: t.target,
    label: t.label,
    preset_slug: t.presetSlug,
    min_confidence: Number(t.minConfidence),
    include_expected: t.includeExpected,
    enabled: t.enabled,
    created_at: t.createdAt.toISOString(),
  };
}

export async function setTargetEnabled(handle: Db, id: string, enabled: boolean): Promise<void> {
  await handle.update(deliveryTargets).set({ enabled, updatedAt: new Date() }).where(eq(deliveryTargets.id, id));
}

export async function setTargetExpected(handle: Db, id: string, includeExpected: boolean): Promise<void> {
  await handle.update(deliveryTargets).set({ includeExpected, updatedAt: new Date() }).where(eq(deliveryTargets.id, id));
}

export async function deleteTarget(handle: Db, id: string): Promise<void> {
  await handle.delete(deliveryTargets).where(eq(deliveryTargets.id, id));
}

/** Queue the newest visible record to one target and flush, so a new Slack hook or endpoint can be verified. */
export async function queueTestDelivery(handle: Db, targetId: string): Promise<string | null> {
  const [t] = await handle.select().from(deliveryTargets).where(eq(deliveryTargets.id, targetId)).limit(1);
  if (!t) return null;
  const [latest] = await handle
    .select({ id: schema.fundingRounds.id })
    .from(schema.fundingRounds)
    .where(and(inArray(schema.fundingRounds.disposition, ["publish", "flagged"]), eq(schema.fundingRounds.history, false)))
    .orderBy(desc(schema.fundingRounds.firstSeenAt))
    .limit(1);
  if (!latest) return null;
  await handle
    .insert(schema.deliveries)
    .values({ roundId: latest.id, channel: t.channel, target: t.id, status: "pending", nextAttemptAt: sql`now()` })
    .onConflictDoUpdate({
      target: [schema.deliveries.roundId, schema.deliveries.channel, schema.deliveries.target],
      set: { status: "pending", nextAttemptAt: sql`now()`, attempts: 0, lastError: null },
    });
  return latest.id;
}

export interface MonitorRow {
  preset_slug: string;
  monitor_id: string;
  estimated_credits_per_month: number | null;
  created_at: string;
}

export async function listMonitors(handle: Db): Promise<MonitorRow[]> {
  const rows = await handle.select().from(presetMonitors);
  return rows.map((r) => ({
    preset_slug: r.presetSlug,
    monitor_id: r.monitorId,
    estimated_credits_per_month: r.estimatedCreditsPerMonth,
    created_at: r.createdAt.toISOString(),
  }));
}
