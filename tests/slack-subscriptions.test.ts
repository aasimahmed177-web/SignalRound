// The public Add to Slack, end to end with no network: the connect route's state cookie and rate
// limit, the callback's CSRF check and code exchange against a fake Slack, webhook encryption,
// one subscription per (team, channel), which rounds a channel gets (preset, history, caps,
// bursts), the daily digest, what each Slack failure does, the manage token, unsubscribe, and the
// admin install routes staying admin-only beside it in demo mode.

import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const store = vi.hoisted(() => ({ handle: null as unknown as import("@fireround/core/db").Db }));
vi.mock("@/lib/db", () => ({ db: async () => store.handle }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "fireround.example", "x-forwarded-proto": "https" }) }));
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  updateTag: () => {},
  cacheLife: () => {},
  cacheTag: () => {},
}));

import { saveSubscription, sendSubscriptionTest, setSubscriptionPaused, unsubscribe } from "../app/(slack)/slack/actions";
import { GET as connectGet } from "../app/api/slack/connect/route";
import { GET as connectedGet } from "../app/api/slack/connected/route";
import { GET as installGet } from "../app/api/slack/install/route";
import { isAdminPath } from "../lib/access";
import { corroborateRecord } from "../lib/corroborate";
import { enqueueDeliveries, flushDeliveries } from "../lib/delivery";
import { listRounds, persistRecords, type RoundRow } from "../lib/persist";
import { resetRateLimitsForTests } from "../lib/rate-limit";
import {
  classifySlackResponse,
  digestDueFor,
  enqueueSubscriptions,
  flushSubscriptionDeliveries,
  planBurst,
  sendDailyDigests,
  sendTest,
} from "../lib/slack-delivery";
import { digestMessage, footerBlock, type MessageScope, welcomeMessage } from "../lib/slack-messages";
import {
  connectCookieValue,
  decryptWebhook,
  encryptWebhook,
  hashToken,
  manageToken,
  normalizePreset,
  parseConnectCookie,
  SLACK_CONNECT_COOKIE,
  SubscribeRefused,
  subscriptionById,
  subscriptionByToken,
  subscriptionCounts,
  updateSubscription,
  upsertSubscription,
} from "../lib/slack-subscriptions";
import { gate } from "../proxy";
import { record as recordOn, testDb } from "./helpers";

// Rounds announced today: the news rule sends nothing announced more than 14 days before sending (lib/deliverable.ts).
const TODAY = new Date().toISOString().slice(0, 10);
const record = (partial: Parameters<typeof recordOn>[0]) => recordOn({ announced_date: TODAY, ...partial });

const KEY = "k".repeat(40);
const ORIGIN = "https://fireround.example";
const WEBHOOK = "https://hooks.slack.com/services/T0001/B0001/abcdefghijklmnopqrstwxyz";

function configure(extra: Record<string, string> = {}) {
  vi.stubEnv("PUBLIC_DEMO", "1");
  vi.stubEnv("DASHBOARD_PASSWORD", "");
  vi.stubEnv("SLACK_CLIENT_ID", "111.222");
  vi.stubEnv("SLACK_CLIENT_SECRET", "shh-secret");
  vi.stubEnv("SLACK_WEBHOOK_KEY", KEY);
  vi.stubEnv("APP_ORIGIN", ORIGIN);
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
}

beforeEach(async () => {
  store.handle = await testDb();
  await resetRateLimitsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A recording fetch: oauth.v2.access answers `oauth`, every webhook post answers `hook`. */
function fakeSlack(oauth: unknown, hook: { status: number; body: string } = { status: 200, body: "ok" }) {
  const posts: Array<{ url: string; body: unknown }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u === "https://slack.com/api/oauth.v2.access") {
      return new Response(JSON.stringify(oauth), { status: 200, headers: { "content-type": "application/json" } });
    }
    posts.push({ url: u, body: JSON.parse(String(init?.body)) });
    return new Response(hook.body, { status: hook.status });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, posts };
}

/** A fetch for the senders, which take it as an argument. */
function hookFetch(answers: Array<{ status: number; body: string }> = []) {
  const posts: Array<{ url: string; body: { text: string; blocks: Array<{ type: string }> } }> = [];
  let i = 0;
  const fn: typeof fetch = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const a = answers[Math.min(i++, answers.length - 1)] ?? { status: 200, body: "ok" };
    return new Response(a.body, { status: a.status });
  };
  return { fn, posts };
}

async function subscribe(handle: Db, over: Partial<Parameters<typeof upsertSubscription>[1]> = {}) {
  return upsertSubscription(
    handle,
    {
      webhookUrl: WEBHOOK,
      teamId: "T0001",
      teamName: "Acme",
      channelId: "C0001",
      channelName: "deals",
      presetSlug: "all",
      cadence: "instant",
      ...over,
    },
    KEY,
  );
}

/** Rounds, persisted after the subscription so they are news to it; returns them as the feed reads them. */
async function rounds(handle: Db, names: string[], preset = "series-a-b", amounts: number[] = []): Promise<RoundRow[]> {
  const saved = await persistRecords(
    handle,
    names.map((n, i) =>
      record({
        company_name: n,
        company_key: n.toLowerCase(),
        amount: {
          value: amounts[i] ?? 10 + i,
          currency: "USD",
          as_written: `$${amounts[i] ?? 10 + i}M`,
          usd_millions: amounts[i] ?? 10 + i,
          fx_rate: 1,
          fx_date: "2026-09-02",
        },
      }),
    ),
    preset,
    `run-${preset}-${names.join("-")}`,
  );
  const client = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
  for (const id of saved.insertedIds) await corroborateRecord(handle, client, id, { broad: true, maxPages: 0 });
  const { rows } = await listRounds(handle, { limit: 200 });
  return rows.filter((r) => names.includes(r.company.name));
}

function connect(query = "preset=seed&cadence=daily", headers: Record<string, string> = {}) {
  return connectGet(new NextRequest(`${ORIGIN}/api/slack/connect?${query}`, { headers }));
}

function connected(query: string, cookie?: string) {
  return connectedGet(
    new NextRequest(`${ORIGIN}/api/slack/connected?${query}`, { headers: cookie ? { cookie: `${SLACK_CONNECT_COOKIE}=${cookie}` } : {} }),
  );
}

function landed(res: Response) {
  const location = new URL(res.headers.get("location") ?? "");
  return { path: location.pathname, params: Object.fromEntries(location.searchParams), setCookie: res.headers.get("set-cookie") ?? "" };
}

const OAUTH_OK = {
  ok: true,
  access_token: "xoxb-dropped",
  team: { id: "T0001", name: "Acme" },
  incoming_webhook: { channel: "#deals", channel_id: "C0001", url: WEBHOOK },
};

describe("GET /api/slack/connect", () => {
  test("to Slack with a fresh state, the picks pinned in an httpOnly Lax cookie on the callback path", async () => {
    configure();
    const res = await connect();
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(to.searchParams.get("scope")).toBe("incoming-webhook");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/slack/connected`);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toContain("Path=/api/slack/connected");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).not.toMatch(/Secure/i);
    const value = decodeURIComponent(cookie.split(";")[0].split("=").slice(1).join("="));
    const parsed = parseConnectCookie(value);
    expect(parsed).toEqual({ state: to.searchParams.get("state"), preset: "seed", cadence: "daily" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("an unknown preset or cadence falls back to every round, each round", async () => {
    configure();
    const res = await connect("preset=../etc&cadence=hourly");
    const value = decodeURIComponent((res.headers.get("set-cookie") ?? "").split(";")[0].split("=").slice(1).join("="));
    expect(parseConnectCookie(value)).toMatchObject({ preset: "all", cadence: "instant" });
    expect(normalizePreset("Seed", ["seed"])).toBe("seed");
  });

  test("Secure in production", async () => {
    configure({ NODE_ENV: "production" });
    const res = await connect();
    expect(res.headers.get("set-cookie")).toMatch(/Secure/i);
  });

  test("switched off without SLACK_WEBHOOK_KEY (or a short one): the Slack page says so, no cookie", async () => {
    configure({ SLACK_WEBHOOK_KEY: "short" });
    const res = await connect();
    const { path, params } = landed(res);
    expect(path).toBe("/slack");
    expect(params.error).toBe("not_configured");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("404 outside demo mode", async () => {
    configure({ PUBLIC_DEMO: "" });
    expect((await connect()).status).toBe(404);
    expect((await connected("code=c&state=s")).status).toBe(404);
  });

  test("rate-limited per address: the eleventh start in ten minutes is turned back", async () => {
    configure();
    const from = { "x-forwarded-for": "203.0.113.9, 10.0.0.1" };
    for (let i = 0; i < 10; i++) expect(landed(await connect("", from)).path).toBe("/oauth/v2/authorize");
    expect(landed(await connect("", from)).params.error).toBe("rate_limited");
    expect(landed(await connect("", { "x-forwarded-for": "198.51.100.1" })).path).toBe("/oauth/v2/authorize");
  });

  test("full before Slack's screen when the cap is reached", async () => {
    configure({ SLACK_SUBSCRIPTION_CAP: "1" });
    await subscribe(store.handle);
    expect(landed(await connect()).params.error).toBe("full");
  });
});

describe("GET /api/slack/connected", () => {
  const state = "s".repeat(43);

  test("a forged or missing state is refused before Slack is called, and the cookie is cleared", async () => {
    configure();
    const slack = fakeSlack(OAUTH_OK);
    for (const [query, cookie] of [
      [`code=c&state=${state}`, undefined],
      [`code=c&state=${"x".repeat(43)}`, connectCookieValue(state, "all", "instant")],
      ["code=c", connectCookieValue(state, "all", "instant")],
      [`code=c&state=${state}`, "garbage"],
    ] as const) {
      const res = await connected(query, cookie);
      const { path, params, setCookie } = landed(res);
      expect(path).toBe("/slack");
      expect(params.error).toBe("state_mismatch");
      expect(setCookie).toContain("Max-Age=0");
    }
    expect(slack.fn).not.toHaveBeenCalled();
  });

  test("cancel on Slack's screen is access_denied", async () => {
    configure();
    const res = await connected(`error=access_denied&state=${state}`, connectCookieValue(state, "all", "instant"));
    expect(landed(res).params.error).toBe("access_denied");
  });

  test("success: the code is exchanged, the subscription saved encrypted, the welcome posted, the manage page opened", async () => {
    configure();
    const slack = fakeSlack(OAUTH_OK);
    await rounds(store.handle, ["Acme"]);
    const res = await connected(`code=good&state=${state}`, connectCookieValue(state, "seed", "daily"));
    const { path, params, setCookie } = landed(res);
    expect(path).toMatch(/^\/slack\/manage\/[A-Za-z0-9_-]{43}$/);
    expect(params.connected).toBe("1");
    expect(setCookie).toContain("Max-Age=0");
    expect(res.headers.get("location")).not.toContain("hooks.slack.com");

    const token = path.split("/").pop() ?? "";
    const sub = await subscriptionByToken(store.handle, token);
    expect(sub).toMatchObject({
      teamId: "T0001",
      teamName: "Acme",
      channelId: "C0001",
      channelName: "#deals",
      presetSlug: "seed",
      cadence: "daily",
    });
    const [row] = await store.handle.select().from(schema.slackSubscriptions);
    // At rest: the ciphertext and the token's hash, never the webhook or the token.
    expect(JSON.stringify(row)).not.toContain("hooks.slack.com");
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.manageTokenHash).toBe(hashToken(token));
    expect(decryptWebhook(row.webhookCiphertext, KEY)).toBe(WEBHOOK);

    // The exchange, then the welcome to the webhook.
    expect(slack.fn).toHaveBeenCalledTimes(2);
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0].url).toBe(WEBHOOK);
    const welcome = slack.posts[0].body as {
      text: string;
      blocks: Array<{ type: string; elements?: Array<{ text?: string; url?: string }> }>;
    };
    expect(welcome.text).toBe("Fireround is connected to #deals");
    expect(JSON.stringify(welcome)).toContain(`${ORIGIN}/slack/manage/${token}`);
    expect(sub?.postsToday).toBe(1);
  });

  test("a welcome Slack refuses still saves the subscription and says so on the manage page", async () => {
    configure();
    fakeSlack(OAUTH_OK, { status: 500, body: "internal_error" });
    const res = await connected(`code=good&state=${state}`, connectCookieValue(state, "all", "instant"));
    expect(landed(res).params.connected).toBe("quiet");
  });

  test("Slack's refusals come back as reasons and nothing is stored", async () => {
    configure();
    fakeSlack({ ok: false, error: "invalid_code" });
    expect(landed(await connected(`code=bad&state=${state}`, connectCookieValue(state, "all", "instant"))).params.error).toBe(
      "bad_response",
    );
    fakeSlack({ ok: true, team: { id: "T1" }, incoming_webhook: { channel_id: "C1" } });
    expect(landed(await connected(`code=bad&state=${state}`, connectCookieValue(state, "all", "instant"))).params.error).toBe("no_webhook");
    expect(await store.handle.select().from(schema.slackSubscriptions)).toHaveLength(0);
  });
});

describe("encryption", () => {
  test("round-trips, fresh IV each time; tampering or another key reads as nothing", () => {
    const a = encryptWebhook(WEBHOOK, KEY);
    const b = encryptWebhook(WEBHOOK, KEY);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(a).not.toContain("hooks");
    expect(decryptWebhook(a, KEY)).toBe(WEBHOOK);
    expect(decryptWebhook(a, "o".repeat(40))).toBeNull();
    const [v, iv, body] = a.split(".");
    const flipped = `${body.slice(0, 5)}${body[5] === "A" ? "B" : "A"}${body.slice(6)}`;
    expect(decryptWebhook(`${v}.${iv}.${flipped}`, KEY)).toBeNull();
    expect(decryptWebhook("plain", KEY)).toBeNull();
    expect(decryptWebhook(null, KEY)).toBeNull();
  });

  test("manage tokens are keyed HMACs, stable per id, different per key", () => {
    expect(manageToken("id-1", KEY)).toBe(manageToken("id-1", KEY));
    expect(manageToken("id-1", KEY)).not.toBe(manageToken("id-2", KEY));
    expect(manageToken("id-1", KEY)).not.toBe(manageToken("id-1", "o".repeat(40)));
    expect(manageToken("id-1", KEY)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("one subscription per (team, channel)", () => {
  test("a reinstall updates the row: same id and link, new webhook and picks, active again", async () => {
    const h = store.handle;
    const first = await subscribe(h);
    expect(first.created).toBe(true);
    await setSubscriptionPausedDirect(h, first.id);
    const again = await subscribe(h, { webhookUrl: `${WEBHOOK}-new`, presetSlug: "seed", cadence: "daily", channelName: "deals-renamed" });
    expect(again).toEqual({ id: first.id, token: first.token, created: false });
    const sub = await subscriptionById(h, first.id);
    expect(sub).toMatchObject({ status: "active", presetSlug: "seed", cadence: "daily", channelName: "deals-renamed", failureCount: 0 });
    expect(decryptWebhook(sub?.webhookCiphertext, KEY)).toBe(`${WEBHOOK}-new`);
    expect(await h.select().from(schema.slackSubscriptions)).toHaveLength(1);
    // Another channel in the same workspace is its own subscription.
    await subscribe(h, { channelId: "C0002" });
    expect(await h.select().from(schema.slackSubscriptions)).toHaveLength(2);
  });

  test("the caps refuse a new channel but never a reinstall", async () => {
    const h = store.handle;
    await subscribe(h);
    await expect(upsertSubscription(h, { ...input(), channelId: "C9" }, KEY, { total: 1 })).rejects.toBeInstanceOf(SubscribeRefused);
    await expect(upsertSubscription(h, { ...input(), channelId: "C9" }, KEY, { team: 1 })).rejects.toMatchObject({ code: "team_full" });
    await expect(upsertSubscription(h, input(), KEY, { total: 1, team: 1 })).resolves.toMatchObject({ created: false });
  });
});

function input() {
  return {
    webhookUrl: WEBHOOK,
    teamId: "T0001",
    teamName: "Acme",
    channelId: "C0001",
    channelName: "deals",
    presetSlug: "all",
    cadence: "instant" as const,
  };
}

async function setSubscriptionPausedDirect(h: Db, id: string) {
  await h.update(schema.slackSubscriptions).set({ status: "paused", failureCount: 3 }).where(eq(schema.slackSubscriptions.id, id));
}

describe("which rounds a channel gets", () => {
  test("expected rounds require per-subscription opt-in for instant queues and daily digests", async () => {
    configure();
    const h = store.handle;
    const defaultSub = await subscribe(h, { channelId: "C-default" });
    const opted = await subscribe(h, { channelId: "C-opted" });
    const daily = await subscribe(h, { channelId: "C-daily", cadence: "daily" });
    await updateSubscription(h, opted.id, { includeExpected: true });
    await updateSubscription(h, daily.id, { includeExpected: true });
    await new Promise((r) => setTimeout(r, 5));
    const [planned] = await rounds(h, ["Proposed"]);
    await h.update(schema.fundingRounds).set({ certainty: "expected" }).where(eq(schema.fundingRounds.id, planned.id));
    const expected = (await listRounds(h, { limit: 10 })).rows.find((r) => r.id === planned.id);
    expect(expected).toBeDefined();
    if (!expected) throw new Error("expected round missing");
    expect(await enqueueSubscriptions(h, [expected])).toBe(1);
    const queued = await h.select().from(schema.deliveries);
    expect(queued.map((r) => r.target)).toEqual([`sub:${opted.id}`]);
    await h.insert(schema.deliveries).values({ roundId: planned.id, channel: "slack", target: `sub:${defaultSub.id}` });
    const { fn, posts } = hookFetch();
    expect(await flushSubscriptionDeliveries(h, ORIGIN, fn)).toMatchObject({ sent: 1, deadLettered: 1 });
    expect(posts).toHaveLength(1);
    await h
      .update(schema.fundingRounds)
      .set({ certainty: "announced", reportedOn: new Date().toISOString().slice(0, 10) })
      .where(eq(schema.fundingRounds.id, planned.id));
    const announced = (await listRounds(h, { ids: [planned.id], limit: 1 })).rows[0];
    expect(await enqueueSubscriptions(h, [announced])).toBe(2);
    const announcement = hookFetch();
    expect(await flushSubscriptionDeliveries(h, ORIGIN, announcement.fn)).toMatchObject({ sent: 2, deadLettered: 0 });
    expect(announcement.posts).toHaveLength(2);
    expect(await enqueueSubscriptions(h, [announced])).toBe(0);
    const now = new Date(Date.now() + 60_000);
    now.setUTCHours(Math.max(now.getUTCHours(), 8));
    await h
      .update(schema.slackSubscriptions)
      .set({ createdAt: new Date(now.getTime() - 30 * 3_600_000), lastDigestAt: new Date(now.getTime() - 30 * 3_600_000) })
      .where(eq(schema.slackSubscriptions.id, daily.id));
    const digest = hookFetch();
    await sendDailyDigests(h, ORIGIN, digest.fn, now);
    expect(JSON.stringify(digest.posts)).toContain("Proposed");
  });
  test("its preset only, never history, never a round from before it subscribed, never while paused or daily", async () => {
    configure();
    const h = store.handle;
    const old = await rounds(h, ["Before"]);
    const all = await subscribe(h, { channelId: "C-all" });
    const seed = await subscribe(h, { channelId: "C-seed", presetSlug: "seed" });
    const daily = await subscribe(h, { channelId: "C-daily", cadence: "daily" });
    const paused = await subscribe(h, { channelId: "C-paused" });
    await h.update(schema.slackSubscriptions).set({ status: "paused" }).where(eq(schema.slackSubscriptions.id, paused.id));
    // Subscriptions created now; the rounds below are first seen after.
    await new Promise((r) => setTimeout(r, 5));
    const ab = await rounds(h, ["Acme", "Beta"], "series-a-b");
    const sd = await rounds(h, ["Sprout"], "seed");
    const beta = ab.find((r) => r.company.name === "Beta");
    await h
      .update(schema.fundingRounds)
      .set({ history: true })
      .where(eq(schema.fundingRounds.id, beta?.id ?? ""));
    const fresh = (await listRounds(h, { limit: 200, history: "exclude" })).rows;

    expect(await enqueueSubscriptions(h, [...fresh, ...old])).toBe(3); // Acme and Sprout to all; Sprout to seed
    const queued = await h.select().from(schema.deliveries);
    const by = (id: string) =>
      queued
        .filter((d) => d.target === `sub:${id}`)
        .map((d) => d.roundId)
        .sort();
    const acme = ab.find((r) => r.company.name === "Acme")?.id ?? "";
    expect(by(all.id)).toEqual([acme, sd[0].id].sort());
    expect(by(seed.id)).toEqual([sd[0].id]);
    expect(by(daily.id)).toEqual([]);
    expect(by(paused.id)).toEqual([]);
    // Queued once: the same round again adds nothing.
    expect(await enqueueSubscriptions(h, fresh)).toBe(0);
  });

  test("the sweep's enqueue reaches subscriptions with no delivery target configured", async () => {
    configure();
    const h = store.handle;
    await subscribe(h);
    await new Promise((r) => setTimeout(r, 5));
    const [acme] = await rounds(h, ["Acme"]);
    expect(await enqueueDeliveries(h, [acme.id], "series-a-b")).toBe(1);
    const { fn, posts } = hookFetch();
    const summary = await flushDeliveries(h, ORIGIN, fn);
    expect(summary.sent).toBe(1);
    expect(posts).toHaveLength(1);
    // The round card, with the channel's footer under it.
    const blocks = posts[0].body.blocks;
    expect(blocks[1].type).toBe("header");
    expect(JSON.stringify(blocks.at(-1))).toContain("Unsubscribe");
  });
});

describe("bursts and caps", () => {
  test("planBurst: five cards and a note; the note always fits under the cap", () => {
    expect(planBurst(3, 50)).toEqual({ cards: 3, more: 0 });
    expect(planBurst(9, 50)).toEqual({ cards: 5, more: 4 });
    expect(planBurst(9, 3)).toEqual({ cards: 2, more: 7 });
    expect(planBurst(9, 1)).toEqual({ cards: 0, more: 9 });
    expect(planBurst(1, 1)).toEqual({ cards: 1, more: 0 });
    expect(planBurst(4, 0)).toEqual({ cards: 0, more: 0 });
  });

  test("a burst of eight posts the five largest as cards and one 'and 3 more'", async () => {
    configure();
    const h = store.handle;
    const sub = await subscribe(h);
    await new Promise((r) => setTimeout(r, 5));
    const names = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"];
    const rs = await rounds(h, names, "series-a-b", [10, 80, 30, 70, 20, 60, 40, 50]);
    await enqueueSubscriptions(h, rs);
    const { fn, posts } = hookFetch();
    const summary = await flushSubscriptionDeliveries(h, ORIGIN, fn);
    expect(summary).toMatchObject({ sent: 8, posts: 6, failed: 0 });
    expect(posts).toHaveLength(6);
    expect(posts.slice(0, 5).map((p) => p.body.text.match(/A\d/)?.[0])).toEqual(["A2", "A4", "A6", "A8", "A7"]);
    expect(posts[5].body.text).toBe("And 3 more new rounds on Fireround");
    expect((await subscriptionById(h, sub.id))?.postsToday).toBe(6);
    expect((await h.select().from(schema.deliveries)).every((d) => d.status === "sent")).toBe(true);
  });

  test("at the daily cap nothing posts; the rows wait for the next UTC day", async () => {
    configure();
    const h = store.handle;
    const now = new Date();
    const sub = await subscribe(h);
    await h
      .update(schema.slackSubscriptions)
      .set({ postsDay: now.toISOString().slice(0, 10), postsToday: 50 })
      .where(eq(schema.slackSubscriptions.id, sub.id));
    await new Promise((r) => setTimeout(r, 5));
    await enqueueSubscriptions(h, await rounds(h, ["Acme"]));
    const { fn, posts } = hookFetch();
    await flushSubscriptionDeliveries(h, ORIGIN, fn, now);
    expect(posts).toHaveLength(0);
    const [row] = await h.select().from(schema.deliveries);
    expect(row.status).toBe("pending");
    expect(row.lastError).toBe("daily cap reached");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    // The test and the welcome respect it too.
    const capped = await subscriptionById(h, sub.id);
    if (!capped) throw new Error("missing");
    expect(await sendTest(h, capped, ORIGIN, fn, now)).toMatchObject({ ok: false, code: "daily_cap" });
  });
});

describe("failures", () => {
  test("classify: gone revokes, 429 and 5xx retry, the rest fail", () => {
    expect(classifySlackResponse(200, "ok")).toEqual({ ok: true });
    for (const [status, body] of [
      [404, "channel_not_found"],
      [410, ""],
      [403, "invalid_token"],
      [404, "no_service"],
      [400, "channel_is_archived"],
    ] as const)
      expect(classifySlackResponse(status, body)).toMatchObject({ ok: false, kind: "revoke" });
    expect(classifySlackResponse(429, "")).toMatchObject({ kind: "retry", code: "rate_limited" });
    expect(classifySlackResponse(503, "Service <b>down</b>")).toMatchObject({ kind: "retry", code: "servicebdownb" });
    expect(classifySlackResponse(400, "invalid_payload")).toMatchObject({ kind: "fail", code: "invalid_payload" });
  });

  test("a channel Slack says is gone revokes the subscription, forgets the webhook, drops the queue", async () => {
    configure();
    const h = store.handle;
    const sub = await subscribe(h);
    await new Promise((r) => setTimeout(r, 5));
    await enqueueSubscriptions(h, await rounds(h, ["Acme", "Beta"]));
    const { fn, posts } = hookFetch([{ status: 404, body: "channel_not_found" }]);
    const summary = await flushSubscriptionDeliveries(h, ORIGIN, fn);
    expect(summary.revoked).toBe(1);
    expect(posts).toHaveLength(1);
    const after = await subscriptionById(h, sub.id);
    expect(after).toMatchObject({ status: "revoked", webhookCiphertext: null, lastError: "channel_not_found" });
    expect((await h.select().from(schema.deliveries)).every((d) => d.status === "dead_letter")).toBe(true);
  });

  test("429 backs off and counts the failure; the subscription stays", async () => {
    configure();
    const h = store.handle;
    const sub = await subscribe(h);
    await new Promise((r) => setTimeout(r, 5));
    await enqueueSubscriptions(h, await rounds(h, ["Acme"]));
    const { fn } = hookFetch([{ status: 429, body: "" }]);
    const summary = await flushSubscriptionDeliveries(h, ORIGIN, fn);
    expect(summary.failed).toBe(1);
    const [row] = await h.select().from(schema.deliveries);
    expect(row.status).toBe("failed");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(await subscriptionById(h, sub.id)).toMatchObject({ status: "active", failureCount: 1, lastError: "rate_limited" });
  });
});

function scope(): MessageScope {
  return { origin: ORIGIN, token: "t".repeat(43), presetSlug: "all", presetName: "All rounds" };
}

describe("messages", () => {
  test("every message ends with Fireround · Manage · Unsubscribe on the signed link · Privacy", () => {
    const text = JSON.stringify(footerBlock(scope()));
    expect(text).toContain(`<${ORIGIN}|Fireround>`);
    expect(text).toContain(`<${ORIGIN}/slack/manage/${"t".repeat(43)}|Manage>`);
    expect(text).toContain(`<${ORIGIN}/slack/manage/${"t".repeat(43)}?unsubscribe=1|Unsubscribe>`);
    expect(text).toContain(`<${ORIGIN}/privacy|Privacy>`);
  });

  test("the welcome names the channel, the preset and cadence, the top three trending, and the manage button", async () => {
    const h = store.handle;
    const rs = await rounds(h, ["T1", "T2", "T3", "T4"]);
    const m = welcomeMessage({ channel: "deals", cadence: "daily", trending: rs }, { ...scope(), presetSlug: "seed", presetName: "Seed" });
    const text = JSON.stringify(m);
    expect(m.text).toBe("Fireround is connected to #deals");
    expect(text).toContain("each round we find that matches Seed");
    expect(text).toContain("one digest each morning at 07:00 UTC");
    expect(text).toContain("Trending on Fireround today");
    expect(["T1", "T2", "T3", "T4"].filter((n) => text.includes(`${n} raised`))).toHaveLength(3);
    expect(text).toContain("Manage this channel");
  });

  test("the digest ranks by amount, adds trending it has not listed, and says nothing on a quiet day", async () => {
    const h = store.handle;
    const rs = await rounds(h, ["Small", "Big", "Mid"], "series-a-b", [5, 90, 40]);
    const trend = await rounds(h, ["Hot"], "seed");
    const now = new Date("2026-09-23T07:00:00Z");
    const m = digestMessage({ rounds: rs, trending: [rs[0], ...trend], now }, scope());
    const text = JSON.stringify(m);
    expect(m?.text).toBe("Fireround daily: 3 rounds newly found");
    expect(text).toContain("Fireround daily · Wed 23 Sep");
    expect(text).toContain("$135M");
    expect(text.indexOf("Big raised")).toBeLessThan(text.indexOf("Mid raised"));
    expect(text.indexOf("Mid raised")).toBeLessThan(text.indexOf("Small raised"));
    expect(text.split("Small raised").length - 1).toBe(1);
    expect(text).toContain("Hot raised");
    expect(digestMessage({ rounds: [], trending: [], now }, scope())).toBeNull();
  });

  test("digest due once a day after 07:00 UTC", () => {
    const created = new Date("2026-09-22T12:00:00Z");
    expect(digestDueFor({ createdAt: created, lastDigestAt: null }, new Date("2026-09-23T06:59:00Z"))).toBe(false);
    expect(digestDueFor({ createdAt: created, lastDigestAt: null }, new Date("2026-09-23T07:00:00Z"))).toBe(true);
    expect(digestDueFor({ createdAt: created, lastDigestAt: new Date("2026-09-23T07:01:00Z") }, new Date("2026-09-23T12:00:00Z"))).toBe(
      false,
    );
  });

  test("sendDailyDigests posts each due daily channel its preset's rounds, once", async () => {
    configure();
    const h = store.handle;
    const now = new Date(Date.now() + 60_000);
    now.setUTCHours(Math.max(now.getUTCHours(), 8));
    const all = await subscribe(h, { channelId: "C1", cadence: "daily" });
    const growth = await subscribe(h, { channelId: "C2", cadence: "daily", presetSlug: "growth" });
    await subscribe(h, { channelId: "C3", cadence: "instant" });
    const earlier = new Date(now.getTime() - 30 * 3_600_000);
    await h.update(schema.slackSubscriptions).set({ createdAt: earlier, lastDigestAt: earlier });
    await rounds(h, ["Acme", "Beta"]);
    const requested = record({
      company_name: "Requested",
      company_key: "requested",
      announced_date: new Date(now.getTime() - 5 * 86_400_000).toISOString().slice(0, 10),
    });
    await persistRecords(h, [requested], "series-a-b", "company-request:digest", { history: true });
    const { fn, posts } = hookFetch();
    const first = await sendDailyDigests(h, ORIGIN, fn, now);
    expect(first).toMatchObject({ sent: 1, skipped: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0].body.text).toBe("Fireround daily: 2 rounds newly found");
    expect(JSON.stringify(posts)).not.toContain("Requested");
    expect((await subscriptionById(h, all.id))?.lastDigestAt?.getTime()).toBe(now.getTime());
    // The growth channel had nothing, so it is done for the day without a post.
    expect((await subscriptionById(h, growth.id))?.lastDigestAt?.getTime()).toBe(now.getTime());
    expect(await sendDailyDigests(h, ORIGIN, fn, now)).toMatchObject({ sent: 0, skipped: 0 });
  });
});

describe("the news window", () => {
  test("a round announced more than 14 days ago is never queued, never sent, and left out of the daily digest", async () => {
    configure();
    const h = store.handle;
    const instant = await subscribe(h, { channelId: "C1", cadence: "instant" });
    const daily = await subscribe(h, { channelId: "C2", cadence: "daily" });
    await new Promise((r) => setTimeout(r, 5));
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
    // Found today, announced three weeks ago (a re-dated or re-reported round).
    const stale = record({ company_name: "Oldco", company_key: "oldco", announced_date: old });
    await persistRecords(h, [stale], "series-a-b", "run-old");
    const client = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
    await corroborateRecord(h, client, stale.id, { broad: true, maxPages: 0 });
    const [fresh] = await rounds(h, ["Newco"]);
    expect(await enqueueDeliveries(h, [stale.id, fresh.id], "series-a-b")).toBe(1);

    // A row queued in time that is no longer news when the flush runs goes to the dead letters.
    await h.insert(schema.deliveries).values({ roundId: stale.id, channel: "slack", target: `sub:${instant.id}` });
    const { fn, posts } = hookFetch();
    const summary = await flushDeliveries(h, ORIGIN, fn);
    expect(summary).toMatchObject({ sent: 1, deadLettered: 1 });
    expect(JSON.stringify(posts)).not.toContain("Oldco");
    const [dead] = await h.select().from(schema.deliveries).where(eq(schema.deliveries.roundId, stale.id));
    expect(dead?.lastError).toBe(`announced ${old}, more than 14 days before sending: not news`);

    const now = new Date(Date.now() + 60_000);
    now.setUTCHours(Math.max(now.getUTCHours(), 8));
    const earlier = new Date(now.getTime() - 30 * 3_600_000);
    await h
      .update(schema.slackSubscriptions)
      .set({ createdAt: earlier, lastDigestAt: earlier })
      .where(eq(schema.slackSubscriptions.id, daily.id));
    const digest = hookFetch();
    await sendDailyDigests(h, ORIGIN, digest.fn, now);
    expect(digest.posts[0]?.body.text).toBe("Fireround daily: 1 round newly found");
    expect(JSON.stringify(digest.posts)).not.toContain("Oldco");
  });
});

describe("the manage token", () => {
  test("a malformed token is refused before the store opens; an unknown one after", async () => {
    configure();
    const opened = vi.fn();
    const real = store.handle;
    store.handle = new Proxy(real, {
      get(t, p, r) {
        opened();
        return Reflect.get(t, p, r);
      },
    });
    for (const fn of [
      () => saveSubscription("x", { preset: "all", cadence: "daily" }),
      () => setSubscriptionPaused("x", true),
      () => sendSubscriptionTest("x"),
      () => unsubscribe("x"),
    ]) {
      const r = await fn();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/not valid/);
    }
    expect(opened).not.toHaveBeenCalled();
    store.handle = real;
    const r = await unsubscribe("a".repeat(43));
    expect(r).toMatchObject({ ok: false });
  });

  test("a token minted under another key names nothing", async () => {
    configure();
    const sub = await subscribe(store.handle);
    vi.stubEnv("SLACK_WEBHOOK_KEY", "o".repeat(40));
    expect(await saveSubscription(sub.token, { preset: "seed", cadence: "daily" })).toMatchObject({ ok: false });
    vi.stubEnv("SLACK_WEBHOOK_KEY", KEY);
    expect(await saveSubscription(sub.token, { preset: "seed", cadence: "daily" })).toEqual({ ok: true });
  });

  test("save, pause, resume, test: each changes only its own subscription", async () => {
    configure();
    const h = store.handle;
    const mine = await subscribe(h);
    const other = await subscribe(h, { channelId: "C0002" });
    expect(await saveSubscription(mine.token, { preset: "seed", cadence: "daily" })).toEqual({ ok: true });
    expect(await subscriptionById(h, mine.id)).toMatchObject({ presetSlug: "seed", cadence: "daily" });
    expect(await saveSubscription(mine.token, { preset: "no-such", cadence: "weekly" })).toEqual({ ok: true });
    expect(await subscriptionById(h, mine.id)).toMatchObject({ presetSlug: "all", cadence: "instant" });
    expect(await setSubscriptionPaused(mine.token, true)).toEqual({ ok: true });
    expect((await subscriptionById(h, mine.id))?.status).toBe("paused");
    const refused = await sendSubscriptionTest(mine.token);
    expect(refused).toMatchObject({ ok: false });
    expect(await setSubscriptionPaused(mine.token, false)).toEqual({ ok: true });
    const { posts } = fakeSlack({});
    expect(await sendSubscriptionTest(mine.token)).toEqual({ ok: true });
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0].body)).toContain("A test from this channel's manage page");
    // A second test inside the cooldown is refused with a sentence.
    const again = await sendSubscriptionTest(mine.token);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/Wait 30 seconds/);
    expect(await subscriptionById(h, other.id)).toMatchObject({ presetSlug: "all", cadence: "instant", status: "active" });
  });

  test("unsubscribe ends it for good: revoked, webhook forgotten, queue dropped, further writes refused", async () => {
    configure();
    const h = store.handle;
    const sub = await subscribe(h);
    await new Promise((r) => setTimeout(r, 5));
    await enqueueSubscriptions(h, await rounds(h, ["Acme"]));
    expect(await unsubscribe(sub.token)).toEqual({ ok: true });
    expect(await subscriptionById(h, sub.id)).toMatchObject({ status: "revoked", webhookCiphertext: null, lastError: "unsubscribed" });
    expect(await h.select().from(schema.deliveries)).toHaveLength(0);
    expect(await setSubscriptionPaused(sub.token, false)).toMatchObject({ ok: false });
    expect((await subscriptionById(h, sub.id))?.status).toBe("revoked");
    expect(await subscriptionCounts(h)).toMatchObject({ active: 0, revoked: 1, queued: 0 });
    // A reinstall of the same channel brings it back under the same link.
    expect(await subscribe(h)).toMatchObject({ id: sub.id, token: sub.token, created: false });
  });
});

describe("access in demo mode", () => {
  test("the public install is open; the admin install and callback stay admin-only", async () => {
    expect(isAdminPath("/api/slack/connect")).toBe(false);
    expect(isAdminPath("/api/slack/connected")).toBe(false);
    expect(isAdminPath("/slack/manage/abc")).toBe(false);
    expect(isAdminPath("/api/slack/install")).toBe(true);
    expect(isAdminPath("/api/slack/oauth/callback")).toBe(true);

    configure();
    // No password: the admin routes 404, the public ones pass the proxy.
    expect(gate(new NextRequest(`${ORIGIN}/api/slack/install`)).status).toBe(404);
    expect(gate(new NextRequest(`${ORIGIN}/api/slack/oauth/callback?code=c&state=s`)).status).toBe(404);
    expect((await installGet(new NextRequest(`${ORIGIN}/api/slack/install`))).status).toBe(404);
    for (const path of ["/api/slack/connect?preset=all", "/api/slack/connected?code=c", `/slack/manage/${"a".repeat(43)}`, "/slack"])
      expect(gate(new NextRequest(`${ORIGIN}${path}`)).headers.get("x-middleware-next"), path).toBe("1");

    // With a password: the admin routes ask for it, the public ones still pass.
    vi.stubEnv("DASHBOARD_PASSWORD", "secret");
    expect(gate(new NextRequest(`${ORIGIN}/api/slack/install`)).status).toBe(401);
    expect(gate(new NextRequest(`${ORIGIN}/api/slack/connect`)).headers.get("x-middleware-next")).toBe("1");
  });
});

describe("the operator docs", () => {
  test("docs/slack.md links the public manifest for fireround.dev exactly as the builder makes it", async () => {
    const { readFile } = await import("node:fs/promises");
    const { slackManifestUrl, slackManifest } = await import("../lib/slack");
    const doc = await readFile("docs/slack.md", "utf8");
    expect(doc).toContain(`(${slackManifestUrl("https://fireround.dev", { public: true })})`);
    expect((slackManifest("https://fireround.dev", { public: true }).oauth_config as { redirect_urls: string[] }).redirect_urls).toEqual([
      "https://fireround.dev/api/slack/oauth/callback",
      "https://fireround.dev/api/slack/connected",
    ]);
  });
});
