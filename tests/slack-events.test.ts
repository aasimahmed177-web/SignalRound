import { createHmac } from "node:crypto";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const store = vi.hoisted(() => ({ handle: null as unknown as import("@fireround/core/db").Db, opened: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: async () => {
    store.opened();
    return store.handle;
  },
}));

import { POST } from "../app/api/webhooks/slack/route";
import { persistRecords } from "../lib/persist";
import { createTarget, getTarget } from "../lib/settings";
import { verifySlackSignature } from "../lib/slack-events";
import { subscriptionById, upsertSubscription } from "../lib/slack-subscriptions";
import { record, testDb } from "./helpers";

const SECRET = "test-slack-signing-secret";
const KEY = "test-slack-webhook-material-at-least-32-characters";
const WEBHOOK = "https://hooks.slack.com/services/T0001/B0001/abcdefghijklmnopqrstwxyz";
const sign = (body: string, timestamp: string) => `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;

function request(payload: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://app.test/api/webhooks/slack", {
    method: "POST",
    body,
    headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": sign(body, timestamp), ...headers },
  });
}

beforeEach(async () => {
  vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
  vi.stubEnv("SLACK_WEBHOOK_KEY", KEY);
  store.handle = await testDb();
  store.opened.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

async function install(teamId = "T0001", botUserId: string | null = "Ubot", userId: string | null = "Uinstaller") {
  const target = await createTarget(store.handle, {
    channel: "slack",
    target: WEBHOOK,
    slackTeamId: teamId,
    slackBotUserId: botUserId,
    slackUserId: userId,
  });
  const sub = await upsertSubscription(
    store.handle,
    {
      webhookUrl: WEBHOOK,
      teamId,
      botUserId,
      userId,
      teamName: "Team",
      channelId: `C${target.id}`,
      channelName: "deals",
      presetSlug: "all",
      cadence: "instant",
    },
    KEY,
  );
  return { target: target.id, sub: sub.id };
}

describe("signed Slack events", () => {
  test("the signature is over the raw body and rejects missing, wrong, stale, and future signatures", () => {
    const body = '{ "event": "test" }';
    const ts = "1700000000";
    const now = Number(ts) * 1000;
    expect(verifySlackSignature(body, ts, sign(body, ts), SECRET, now)).toBe(true);
    expect(verifySlackSignature(`${body.trim()} `, ts, sign(body, ts), SECRET, now)).toBe(false);
    expect(verifySlackSignature(body, ts, sign(body, ts), "wrong", now)).toBe(false);
    expect(verifySlackSignature(body, ts, null, SECRET, now)).toBe(false);
    expect(verifySlackSignature(body, null, sign(body, ts), SECRET, now)).toBe(false);
    expect(verifySlackSignature(body, ts, "v0=bad", SECRET, now)).toBe(false);
    expect(verifySlackSignature(body, ts, sign(body, ts), SECRET, now + 301000)).toBe(false);
    expect(verifySlackSignature(body, ts, sign(body, ts), SECRET, now - 301000)).toBe(false);
  });

  test("URL verification is signed and never opens the database", async () => {
    const payload = { type: "url_verification", challenge: "challenge-value" };
    expect(await (await POST(request(payload))).json()).toEqual({ challenge: "challenge-value" });
    expect((await POST(request(payload, { "x-slack-signature": "bad" }))).status).toBe(401);
    vi.stubEnv("SLACK_SIGNING_SECRET", "");
    expect((await POST(request(payload))).status).toBe(503);
    expect(store.opened).not.toHaveBeenCalled();
  });

  test("uninstall forgets both credential types and pending posts only in the named workspace", async () => {
    const ours = await install();
    const other = await install("TOTHER");
    const r = record({ company_name: "Acme" });
    await persistRecords(store.handle, [r], "series-a-b", "run-1");
    await store.handle.insert(schema.deliveries).values([
      { roundId: r.id, channel: "slack", target: ours.target, status: "pending" },
      { roundId: r.id, channel: "slack", target: `sub:${ours.sub}`, status: "failed" },
      { roundId: r.id, channel: "slack", target: other.target, status: "pending" },
    ]);
    const payload = { type: "event_callback", team_id: "T0001", event: { type: "app_uninstalled" } };
    expect((await POST(request(payload, { "x-slack-signature": "bad" }))).status).toBe(401);
    expect((await getTarget(store.handle, ours.target))?.enabled).toBe(true);
    expect((await POST(request(payload))).status).toBe(200);
    expect((await POST(request(payload))).status).toBe(200);
    expect(await getTarget(store.handle, ours.target)).toMatchObject({ enabled: false, target: "" });
    expect(await subscriptionById(store.handle, ours.sub)).toMatchObject({ status: "revoked", webhookCiphertext: null });
    expect(await getTarget(store.handle, other.target)).toMatchObject({ enabled: true });
    expect(await subscriptionById(store.handle, other.sub)).toMatchObject({ status: "active" });
    expect(await store.handle.select().from(schema.deliveries)).toHaveLength(1);
  });

  test("token revocation matches workspace and bot or installer ids, with a safe fallback for legacy installs", async () => {
    const bot = await install();
    const other = await install("T0001", "Uother", "UotherInstaller");
    const legacy = await install("T0001", null, null);
    const post = (tokens: unknown) =>
      POST(request({ type: "event_callback", team_id: "T0001", event: { type: "tokens_revoked", tokens } }));
    expect((await post({ bot: ["Ubot"] })).status).toBe(200);
    for (const pair of [bot, legacy]) {
      expect(await getTarget(store.handle, pair.target)).toMatchObject({ target: "", enabled: false });
      expect(await subscriptionById(store.handle, pair.sub)).toMatchObject({ status: "revoked", webhookCiphertext: null });
    }
    expect(await getTarget(store.handle, other.target)).toMatchObject({ enabled: true });
    await post({ oauth: ["UotherInstaller"] });
    expect(await getTarget(store.handle, other.target)).toMatchObject({ target: "", enabled: false });
    expect(await subscriptionById(store.handle, other.sub)).toMatchObject({ status: "revoked" });
  });

  test("unknown or malformed events do not erase credentials", async () => {
    const installed = await install();
    for (const event of [{ type: "other" }, { type: "tokens_revoked", tokens: {} }, { type: "tokens_revoked", tokens: { bot: "Ubot" } }]) {
      expect((await POST(request({ type: "event_callback", team_id: "T0001", event }))).status).toBe(200);
    }
    const [row] = await store.handle.select().from(schema.deliveryTargets).where(eq(schema.deliveryTargets.id, installed.target));
    expect(row.enabled).toBe(true);
    expect(row.target).toMatch(/^v1\./);
  });
});
