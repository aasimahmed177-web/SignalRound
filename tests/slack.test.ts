// Slack in one click: the manifest and authorize URL builders, the state cookie that makes the
// OAuth round trip CSRF-safe, the callback's success and failure paths against a fake
// oauth.v2.access, the target it creates, the /feed command, and the password on /api/slack.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "app.test", "x-forwarded-proto": "https" }) }));
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  updateTag: () => {},
  cacheLife: () => {},
  cacheTag: () => {},
}));

import { newSlackFeedCommand } from "../app/(dashboard)/settings/actions";
import { GET as installGet } from "../app/api/slack/install/route";
import { GET as callbackGet } from "../app/api/slack/oauth/callback/route";
import { isAdminPath } from "../lib/access";
import { BASIC_CHALLENGE } from "../lib/dashboard-auth";
import { db } from "../lib/db";
import { isLoopbackOrigin, publicOrigin } from "../lib/origin";
import { listTargets } from "../lib/settings";
import {
  exchangeSlackCode,
  maskWebhookUrl,
  SLACK_STATE_COOKIE,
  slackAuthorizeUrl,
  slackDenialCode,
  slackErrorMessage,
  slackManifest,
  slackManifestUrl,
  slackReturnUrl,
  slackStateMatches,
  slackTargetLabel,
} from "../lib/slack";
import { decryptWebhook } from "../lib/slack-credentials";
import { gate } from "../proxy";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const WEBHOOK = "https://hooks.slack.com/services/T0001/B0001/abcdefghijklmnopqrstwxyz";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function configure() {
  vi.stubEnv("SLACK_CLIENT_ID", "111.222");
  vi.stubEnv("SLACK_CLIENT_SECRET", "shh-secret");
  vi.stubEnv("APP_ORIGIN", "https://fireround.example");
}

function callback(query: string, cookie?: string, headers: Record<string, string> = {}) {
  return callbackGet(
    new NextRequest(`https://fireround.example/api/slack/oauth/callback?${query}`, {
      headers: { ...headers, ...(cookie ? { cookie: `${SLACK_STATE_COOKIE}=${cookie}` } : {}) },
    }),
  );
}

/** The redirect's query, and whether it cleared the state cookie. */
function landed(res: Response) {
  const location = new URL(res.headers.get("location") ?? "");
  return { path: location.pathname, params: Object.fromEntries(location.searchParams), setCookie: res.headers.get("set-cookie") ?? "" };
}

/** A fake oauth.v2.access that records what it was sent. */
function fakeSlack(body: unknown, status = 200) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

describe("the manifest", () => {
  test("the deep link carries valid JSON with this origin's callback and the one scope", () => {
    const url = new URL(slackManifestUrl("https://fireround.example"));
    expect(url.origin + url.pathname).toBe("https://api.slack.com/apps");
    expect(url.searchParams.get("new_app")).toBe("1");
    const manifest = JSON.parse(url.searchParams.get("manifest_json") ?? "");
    expect(manifest).toEqual(slackManifest("https://fireround.example"));
    expect(manifest.display_information.name).toBe("Fireround");
    expect(manifest.display_information.description.length).toBeLessThanOrEqual(140);
    expect(manifest.oauth_config.redirect_urls).toEqual(["https://fireround.example/api/slack/oauth/callback"]);
    expect(manifest.oauth_config.scopes.bot).toEqual(["incoming-webhook"]);
    expect(manifest.settings.event_subscriptions).toEqual({
      request_url: "https://fireround.example/api/webhooks/slack",
      bot_events: ["app_uninstalled", "tokens_revoked"],
    });
    expect(manifest.settings.org_deploy_enabled).toBe(false);
  });
});

describe("the pure pieces", () => {
  test("the authorize URL asks for incoming-webhook with the state and redirect", () => {
    const u = new URL(slackAuthorizeUrl({ clientId: "111.222", state: "st", redirectUri: "https://x.example/cb" }));
    expect(u.origin + u.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "111.222",
      scope: "incoming-webhook",
      redirect_uri: "https://x.example/cb",
      state: "st",
    });
  });

  test("state matches only when both sides are present and equal", () => {
    expect(slackStateMatches("abc", "abc")).toBe(true);
    expect(slackStateMatches("abc", "abd")).toBe(false);
    expect(slackStateMatches("abc", undefined)).toBe(false);
    expect(slackStateMatches(null, "abc")).toBe(false);
    expect(slackStateMatches("", "")).toBe(false);
  });

  test("labels, masks, and error sentences", () => {
    expect(slackTargetLabel("#deals", "Acme")).toBe("#deals · Acme");
    expect(slackTargetLabel("deals", null)).toBe("#deals");
    expect(slackTargetLabel(null, "Acme")).toBe("Slack · Acme");
    expect(maskWebhookUrl(WEBHOOK)).toBe("hooks.slack.com/…wxyz");
    expect(maskWebhookUrl(WEBHOOK)).not.toContain("T0001");
    expect(slackErrorMessage("access_denied")).toBe("Slack install cancelled; nothing was connected.");
    expect(slackErrorMessage("slack:team_not_found")).toBe("Slack refused the install (team_not_found).");
    // A crafted reason cannot put its own words on the page.
    expect(slackErrorMessage("Your session expired, re-enter your password at evil.example")).toBe(
      "The Slack install did not finish. Start again from Add to Slack.",
    );
    expect(slackErrorMessage("toString")).toBe("The Slack install did not finish. Start again from Add to Slack.");
    expect(slackDenialCode("access_denied")).toBe("access_denied");
    expect(slackDenialCode("Weird Error!")).toBe("denied:weirderror");
  });

  test("the public origin prefers APP_ORIGIN, else the forwarded host; loopback is spotted", () => {
    vi.stubEnv("APP_ORIGIN", "https://fireround.example/");
    expect(publicOrigin(new Headers({ host: "internal:3000" }))).toBe("https://fireround.example");
    vi.stubEnv("APP_ORIGIN", "");
    expect(publicOrigin(new Headers({ host: "internal:3000", "x-forwarded-host": "app.test", "x-forwarded-proto": "https" }))).toBe(
      "https://app.test",
    );
    expect(isLoopbackOrigin("http://localhost:3100")).toBe(true);
    expect(isLoopbackOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isLoopbackOrigin("https://fireround.example")).toBe(false);
  });

  test("the return URL goes to Settings with the outcome", () => {
    expect(slackReturnUrl("https://f.example", { error: "no_code" })).toBe("https://f.example/settings?slack=error&reason=no_code");
    expect(slackReturnUrl("https://f.example", { connected: { channel: "#deals", target: "t1" } })).toBe(
      "https://f.example/settings?slack=connected&channel=%23deals&target=t1",
    );
  });
});

describe("GET /api/slack/install", () => {
  test("missing encryption key disables installs even with OAuth credentials", async () => {
    configure();
    vi.stubEnv("SLACK_WEBHOOK_KEY", "");
    const res = await installGet(new NextRequest("https://fireround.example/api/slack/install"));
    expect(landed(res).params).toEqual({ slack: "error", reason: "not_configured" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  test("unconfigured: back to Settings with a reason, no cookie", async () => {
    vi.stubEnv("APP_ORIGIN", "https://fireround.example");
    const res = await installGet(new NextRequest("https://fireround.example/api/slack/install"));
    expect(res.status).toBe(307);
    expect(landed(res).params).toEqual({ slack: "error", reason: "not_configured" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("configured: to Slack, with the same random state in the query and an httpOnly Lax cookie", async () => {
    configure();
    const res = await installGet(new NextRequest("https://fireround.example/api/slack/install"));
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin).toBe("https://slack.com");
    expect(to.searchParams.get("redirect_uri")).toBe("https://fireround.example/api/slack/oauth/callback");
    const state = to.searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThanOrEqual(40);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SLACK_STATE_COOKIE}=${state}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toContain("Path=/api/slack");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).not.toMatch(/Secure/i);

    // A second install mints a different state.
    const again = new URL((await installGet(new NextRequest("https://fireround.example/api/slack/install"))).headers.get("location") ?? "");
    expect(again.searchParams.get("state")).not.toBe(state);
  });

  test("the cookie is Secure in production", async () => {
    configure();
    vi.stubEnv("NODE_ENV", "production");
    const res = await installGet(new NextRequest("https://fireround.example/api/slack/install"));
    expect(res.headers.get("set-cookie")).toMatch(/Secure/i);
  });
});

describe("GET /api/slack/oauth/callback", () => {
  test("success: the code is exchanged, a Slack target is created, Settings is told which", async () => {
    configure();
    const slack = fakeSlack({
      ok: true,
      access_token: "xoxb-dropped",
      bot_user_id: "Ubot",
      authed_user: { id: "Uinstaller" },
      team: { id: "T0001", name: "Acme" },
      incoming_webhook: { channel: "#deals", channel_id: "C0001", configuration_url: "https://acme.slack.com/x", url: WEBHOOK },
    });
    const res = await callback("code=good-code&state=s1", "s1");
    expect(res.status).toBe(307);

    expect(slack.calls).toHaveLength(1);
    expect(slack.calls[0].url).toBe("https://slack.com/api/oauth.v2.access");
    expect(Object.fromEntries(slack.calls[0].body)).toEqual({
      code: "good-code",
      client_id: "111.222",
      client_secret: "shh-secret",
      redirect_uri: "https://fireround.example/api/slack/oauth/callback",
    });

    const { path, params, setCookie } = landed(res);
    expect(path).toBe("/settings");
    expect(params.slack).toBe("connected");
    expect(params.channel).toBe("#deals");
    expect(setCookie).toContain(`${SLACK_STATE_COOKIE}=;`);
    expect(setCookie).toContain("Max-Age=0");
    // The webhook URL never rides in the redirect.
    expect(res.headers.get("location")).not.toContain("hooks.slack.com");

    const created = (await listTargets(await db())).find((t) => t.id === params.target);
    expect(created).toMatchObject({
      channel: "slack",
      target: expect.stringMatching(/^v1\./),
      label: "#deals · Acme",
      preset_slug: null,
      min_confidence: 0.5,
      enabled: true,
    });
    expect(decryptWebhook(created?.target, process.env.SLACK_WEBHOOK_KEY!)).toBe(WEBHOOK);
    expect(maskWebhookUrl(created!.target)).toBe("hooks.slack.com/…wxyz");
    const [stored] = await (await db()).select().from(schema.deliveryTargets).where(eq(schema.deliveryTargets.id, params.target));
    expect(stored).toMatchObject({ slackTeamId: "T0001", slackBotUserId: "Ubot", slackUserId: "Uinstaller" });
  });

  test("a forged or missing state is refused before Slack is called", async () => {
    configure();
    const slack = fakeSlack({ ok: true });
    for (const [query, cookie] of [
      ["code=c&state=attacker", "victim"],
      ["code=c&state=attacker", undefined],
      ["code=c", "victim"],
    ] as const) {
      const res = await callback(query, cookie);
      expect(landed(res).params).toEqual({ slack: "error", reason: "state_mismatch" });
      expect(landed(res).setCookie).toContain("Max-Age=0");
    }
    expect(slack.fn).not.toHaveBeenCalled();
  });

  test("cancel on Slack's screen comes back as access_denied", async () => {
    configure();
    const slack = fakeSlack({ ok: true });
    const res = await callback("error=access_denied&state=s1", "s1");
    expect(landed(res).params).toEqual({ slack: "error", reason: "access_denied" });
    expect(slack.fn).not.toHaveBeenCalled();
  });

  test("Slack's refusals and a missing webhook come back as reasons, and nothing is stored", async () => {
    configure();
    const before = (await listTargets(await db())).length;

    fakeSlack({ ok: false, error: "invalid_code" });
    expect(landed(await callback("code=bad&state=s", "s")).params).toEqual({ slack: "error", reason: "slack:invalid_code" });

    fakeSlack({ ok: true, team: { name: "Acme" } });
    expect(landed(await callback("code=c&state=s", "s")).params).toEqual({ slack: "error", reason: "no_webhook" });

    fakeSlack({}, 502);
    expect(landed(await callback("code=c&state=s", "s")).params).toEqual({ slack: "error", reason: "bad_response" });

    expect(landed(await callback("state=s", "s")).params).toEqual({ slack: "error", reason: "no_code" });
    expect((await listTargets(await db())).length).toBe(before);
  });

  test("an unreachable Slack is its own reason", async () => {
    await expect(
      exchangeSlackCode({
        code: "c",
        clientId: "i",
        clientSecret: "s",
        redirectUri: "https://x/cb",
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ).rejects.toMatchObject({ code: "unreachable" });
  });
});

describe("access", () => {
  test("/api/slack is an admin path: gated in demo mode, and gated outside it when a password is set", () => {
    expect(isAdminPath("/api/slack/install")).toBe(true);
    expect(isAdminPath("/api/slack/oauth/callback")).toBe(true);
    expect(isAdminPath("/api/slackers")).toBe(false);

    vi.stubEnv("DASHBOARD_PASSWORD", "secret");
    for (const demo of ["1", "0"]) {
      vi.stubEnv("PUBLIC_DEMO", demo);
      for (const path of ["/api/slack/install", "/api/slack/oauth/callback?code=c&state=s"]) {
        const denied = gate(new NextRequest(`https://app.test${path}`));
        expect(denied.status, `${demo} ${path}`).toBe(401);
        expect(denied.headers.get("www-authenticate")).toBe(BASIC_CHALLENGE["www-authenticate"]);
        const allowed = gate(new NextRequest(`https://app.test${path}`, { headers: { authorization: `Basic ${b64("u:secret")}` } }));
        expect(allowed.headers.get("x-middleware-next"), `${demo} ${path}`).toBe("1");
      }
    }
  });

  test("the routes check the password themselves too", async () => {
    configure();
    vi.stubEnv("DASHBOARD_PASSWORD", "secret");
    vi.stubEnv("PUBLIC_DEMO", "1");
    const slack = fakeSlack({ ok: true });
    const install = await installGet(new NextRequest("https://fireround.example/api/slack/install"));
    expect(install.status).toBe(401);
    expect(install.headers.get("set-cookie")).toBeNull();
    const cb = await callback("code=c&state=s", "s");
    expect(cb.status).toBe(401);
    expect(slack.fn).not.toHaveBeenCalled();

    const authed = await installGet(
      new NextRequest("https://fireround.example/api/slack/install", { headers: { authorization: `Basic ${b64("u:secret")}` } }),
    );
    expect(authed.status).toBe(307);
  });
});

describe("Slack's /feed", () => {
  test("mints a feed token and returns the subscribe command with the RSS URL", async () => {
    vi.stubEnv("APP_ORIGIN", "");
    const r = await newSlackFeedCommand("Slack /feed · Seed", "seed");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.command).toMatch(/^\/feed subscribe https:\/\/app\.test\/feeds\/[A-Za-z0-9_-]+\/seed\.rss$/);
  });
});
