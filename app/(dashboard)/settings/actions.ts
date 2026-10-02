"use server";

import { revalidatePath, updateTag } from "next/cache";
import { headers } from "next/headers";
import { type ActionResult, attempt } from "@/lib/action-result";
import { TAG_SETTINGS } from "@/lib/cached";
import { CoverageSetting, resolveCoverage } from "@/lib/coverage";
import { requireDashboard } from "@/lib/dashboard-auth.server";
import { db } from "@/lib/db";
import { deleteDigestState, flushDeliveries, sendSampleDigest } from "@/lib/delivery";
import type { DigestCadence } from "@/lib/digest";
import { getFirecrawl } from "@/lib/firecrawl";
import { rescheduleMonitors } from "@/lib/monitor-schedule";
import { publicOrigin } from "@/lib/origin";
import {
  createEmailTarget,
  createTarget,
  deleteTarget,
  getCoverageSetting,
  getTarget,
  mintFeedToken,
  queueTestDelivery,
  revokeFeedToken,
  setCoverageSetting,
  setTargetEnabled,
  setTargetExpected,
} from "@/lib/settings";
import { feedSubscribeCommand } from "@/lib/slack";

/**
 * The stored rung, for the Settings page. Guarded like the writes: an exported server function is
 * a POST anyone can aim at any page, and the plan is operator configuration, not feed content.
 */
export async function readCoverage(): Promise<CoverageSetting> {
  await requireDashboard();
  return getCoverageSetting(await db());
}

/** Store the rung and its overrides. The next cron tick, sweep, and enrichment read it; live monitors move to its schedule now. */
export async function setCoverage(setting: CoverageSetting): Promise<ActionResult> {
  return attempt(async () => {
    await requireDashboard();
    const handle = await db();
    const next = CoverageSetting.parse(setting);
    const before = resolveCoverage(await getCoverageSetting(handle)).monitorSchedule;
    await setCoverageSetting(handle, next);
    revalidatePath("/settings");
    revalidatePath("/presets");
    // The rung decides whether the feed opens on Trending (lib/cached.ts cachedTrendingOn).
    updateTag(TAG_SETTINGS);
    const after = resolveCoverage(next).monitorSchedule;
    if (after !== before) await rescheduleMonitors(handle, getFirecrawl(), after);
  });
}

async function origin(): Promise<string> {
  return publicOrigin(await headers());
}

export async function newFeedToken(
  label: string,
  presetSlug: string,
  includeExpected = false,
): Promise<ActionResult<{ value: { urls: string[] } }>> {
  return attempt(async () => {
    await requireDashboard();
    const handle = await db();
    const token = await mintFeedToken(handle, label || "default", presetSlug || null, includeExpected === true);
    const base = `${await origin()}/feeds/${token}/${presetSlug || "series-a-b"}`;
    revalidatePath("/settings");
    return { urls: [`${base}.rss`, `${base}.atom`, `${base}.json`] };
  });
}

/** Slack's /feed path: a feed token for one preset, returned as the command a channel pastes (the RSS URL). */
export async function newSlackFeedCommand(label: string, presetSlug: string): Promise<ActionResult<{ value: { command: string } }>> {
  const r = await newFeedToken(label, presetSlug);
  if (!r.ok) return r;
  return { ok: true, value: { command: feedSubscribeCommand(r.value.urls[0]) } };
}

export async function revokeToken(tokenHash: string): Promise<ActionResult> {
  return attempt(async () => {
    await requireDashboard();
    const handle = await db();
    await revokeFeedToken(handle, tokenHash);
    revalidatePath("/settings");
  });
}

/** Payloads carry company data and, for webhooks, a signature: https everywhere except a loopback receiver on the same machine. */
function deliverableUrl(target: string): boolean {
  try {
    const u = new URL(target);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  } catch {
    return false;
  }
}

/** One mailbox, no display name: Resend takes the display name from DIGEST_FROM, not from the recipient. */
function deliverableAddress(target: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(target);
}

export async function addTarget(input: {
  channel: "slack" | "webhook" | "email";
  target: string;
  label: string;
  presetSlug: string;
  minConfidence: number;
  includeExpected?: boolean;
  cadence?: DigestCadence;
}): Promise<ActionResult<{ value: { id: string; secret: string | null } }>> {
  return attempt(async () => {
    await requireDashboard();
    // Bad input is refused before the store opens.
    const target = input.target.trim();
    if (input.channel === "email" && !deliverableAddress(target)) throw new Error("Target must be an email address.");
    if (input.channel !== "email" && !deliverableUrl(target))
      throw new Error("Target must be an https URL (http is allowed for localhost only).");
    const handle = await db();
    const r =
      input.channel === "email"
        ? await createEmailTarget(handle, { ...input, target, presetSlug: input.presetSlug || null, cadence: input.cadence ?? "weekly" })
        : await createTarget(handle, { ...input, channel: input.channel, target, presetSlug: input.presetSlug || null });
    revalidatePath("/settings");
    return r;
  });
}

export async function toggleTarget(id: string, enabled: boolean): Promise<ActionResult> {
  return attempt(async () => {
    await requireDashboard();
    const handle = await db();
    await setTargetEnabled(handle, id, enabled);
    revalidatePath("/settings");
  });
}

export async function toggleTargetExpected(id: string, includeExpected: boolean): Promise<ActionResult> {
  return attempt(async () => {
    await requireDashboard();
    const handle = await db();
    await setTargetExpected(handle, id, includeExpected === true);
    revalidatePath("/settings");
  });
}

export async function removeTarget(id: string): Promise<ActionResult> {
  return attempt(async () => {
    await requireDashboard();
    const handle = await db();
    await deleteTarget(handle, id);
    await deleteDigestState(handle, id);
    revalidatePath("/settings");
  });
}

export async function flushNow(): Promise<ActionResult<{ value: { sent: number; failed: number; deadLettered: number } }>> {
  return attempt(async () => {
    await requireDashboard();
    const handle = await db();
    const r = await flushDeliveries(handle, await origin());
    revalidatePath("/settings");
    return r;
  });
}

export async function sendTest(
  targetId: string,
): Promise<ActionResult<{ value: { sent: number; failed: number; deadLettered: number; round: string | null; error: string | null } }>> {
  return attempt(async () => {
    await requireDashboard();
    const handle = await db();
    const t = await getTarget(handle, targetId);
    // An email target gets a one-round sample straight away; the outbox and its cadence are not touched.
    if (t?.channel === "email") {
      const s = await sendSampleDigest(handle, targetId, await origin());
      const ok = s.round !== null && s.error === null;
      return { sent: ok ? 1 : 0, failed: s.error ? 1 : 0, deadLettered: 0, round: s.round, error: s.error };
    }
    const round = await queueTestDelivery(handle, targetId);
    const r = await flushDeliveries(handle, await origin());
    revalidatePath("/settings");
    return { ...r, round, error: null };
  });
}
