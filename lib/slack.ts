// Slack in one click. With SLACK_CLIENT_ID and SLACK_CLIENT_SECRET set, "Add to Slack" runs
// Slack's OAuth v2 flow with the single `incoming-webhook` scope: the user picks a channel on
// Slack's own screen, Slack hands back a webhook URL for it, and that URL becomes an ordinary
// Slack delivery target. Without them, the manifest below prefills Slack's "create an app" page
// so making the app is one click too. Nothing here posts to Slack; delivery stays in delivery.ts.

import { randomBytes } from "node:crypto";
import { decryptWebhook, slackWebhookKey } from "./slack-credentials.ts";
import { tokenEquals } from "./tokens.ts";

/** The OAuth app's credentials, or null when either is missing (the setup card shows instead). */
export function slackOAuthConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.SLACK_CLIENT_ID?.trim();
  const clientSecret = process.env.SLACK_CLIENT_SECRET?.trim();
  return clientId && clientSecret && slackWebhookKey() ? { clientId, clientSecret } : null;
}

/** The httpOnly cookie that carries the OAuth state across Slack's round trip. */
export const SLACK_STATE_COOKIE = "fireround_slack_state";

/** Ten minutes to pick a channel; long enough for a workspace switch, short enough to go stale. */
export const SLACK_STATE_MAX_AGE = 600;

export const SLACK_CALLBACK_PATH = "/api/slack/oauth/callback";

/** 32 random bytes: the value the callback must see again, in both the query and the cookie. */
export function newSlackState(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Whether a URL is one of Slack's incoming webhooks (hooks.slack.com, or GovSlack's host). Every later
 * post goes to the stored URL from the server, so nothing else is ever kept as one, whatever a
 * response claimed.
 */
export function isSlackWebhook(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.port && !u.username && (u.hostname === "hooks.slack.com" || u.hostname === "hooks.slack-gov.com");
  } catch {
    return false;
  }
}

/**
 * The state check, the CSRF half of the flow: the query's state must equal the cookie this
 * browser was given at install time. Constant-time, and a missing side never matches.
 */
export function slackStateMatches(query: string | null, cookie: string | undefined): boolean {
  if (!query || !cookie) return false;
  return tokenEquals(query, cookie);
}

export function slackRedirectUri(origin: string): string {
  return `${origin}${SLACK_CALLBACK_PATH}`;
}

/** Slack's consent screen, asking for a webhook into one channel and nothing else. */
export function slackAuthorizeUrl(input: { clientId: string; state: string; redirectUri: string }): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", "incoming-webhook");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

/**
 * The app manifest Slack's "create from manifest" page is prefilled with (schema:
 * docs.slack.dev/reference/app-manifest). The redirect URL is this instance's callback; the one
 * bot scope is `incoming-webhook`. A bot user is declared because Slack issues a bot token with
 * every OAuth v2 install; it never posts, the webhook does.
 */
export function slackManifest(origin: string, opts: { public?: boolean } = {}): Record<string, unknown> {
  return {
    _metadata: { major_version: 2, minor_version: 1 },
    display_information: {
      name: "Fireround",
      description: "New funding rounds from the open web, verified and posted to a channel.",
      background_color: "#fa5d19",
    },
    features: { bot_user: { display_name: "Fireround", always_online: false } },
    oauth_config: {
      // The public install (lib/slack-subscriptions.ts) returns to its own callback, so its app lists both.
      redirect_urls: opts.public ? [slackRedirectUri(origin), `${origin}/api/slack/connected`] : [slackRedirectUri(origin)],
      scopes: { bot: ["incoming-webhook"] },
    },
    settings: {
      event_subscriptions: {
        request_url: `${origin}/api/webhooks/slack`,
        bot_events: ["app_uninstalled", "tokens_revoked"],
      },
      incoming_webhooks: { incoming_webhooks_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/** Slack's deep link that opens "Create an app" with the manifest filled in (the JSON variant). */
export function slackManifestUrl(origin: string, opts: { public?: boolean } = {}): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest(origin, opts)))}`;
}

/** The target's name in the list: the channel Slack picked, then the workspace. */
export function slackTargetLabel(channel: string | null, team: string | null): string {
  const name = channel ? (channel.startsWith("#") || channel.startsWith("@") ? channel : `#${channel}`) : "Slack";
  return team ? `${name} · ${team}` : name;
}

/**
 * A Slack webhook URL is a bearer credential: anyone holding it can post to the channel. After
 * creation it renders as its host and the last four characters only.
 */
export function maskWebhookUrl(target: string): string {
  if (!target) return "Slack disconnected";
  if (target.startsWith("v1.")) {
    const key = slackWebhookKey();
    const plaintext = key ? decryptWebhook(target, key) : null;
    return plaintext ? maskWebhookUrl(plaintext) : "Slack webhook unavailable";
  }
  try {
    const u = new URL(target);
    const tail = target.slice(-4);
    return `${u.host}/…${tail}`;
  } catch {
    return `…${target.slice(-4)}`;
  }
}

/** What Slack's RSS app takes in a channel's message box. */
export function feedSubscribeCommand(rssUrl: string): string {
  return `/feed subscribe ${rssUrl}`;
}

export interface SlackInstall {
  webhookUrl: string;
  channel: string | null;
  team: string | null;
  /** Slack's ids, which the public install keys a subscription on (a channel can be renamed). */
  channelId: string | null;
  teamId: string | null;
  botUserId: string | null;
  userId: string | null;
}

/**
 * Every way the install can fail, as a code in the return URL and a sentence on the page. The
 * page renders only these sentences, so a crafted link to Settings cannot put its own words in
 * a toast; a code from Slack itself rides along as `slack:<code>` in a fixed frame.
 */
const INSTALL_ERRORS: Record<string, string> = {
  not_configured: "Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and SLACK_WEBHOOK_KEY (at least 32 characters), then redeploy.",
  access_denied: "Slack install cancelled; nothing was connected.",
  state_mismatch: "The Slack install could not be verified (its state did not match). Start again from Add to Slack.",
  no_code: "Slack returned without an install code. Start again from Add to Slack.",
  unreachable: "Could not reach Slack to finish the install. Try again.",
  bad_response: "Slack answered with an error while finishing the install. Try again.",
  no_webhook: "Slack finished the install but returned no channel webhook. Check the app requests the incoming-webhook scope.",
  save_failed: "Slack connected, but the target could not be saved. Check the database and try again.",
  "slack:invalid_code": "Slack did not accept the install code. Try Add to Slack again.",
  "slack:code_already_used": "That install code was already used. Try Add to Slack again.",
  "slack:code_expired": "The install code expired. Try Add to Slack again.",
  "slack:bad_redirect_uri": "The redirect URL does not match the Slack app. Check its Redirect URLs under OAuth & Permissions.",
  "slack:invalid_client_id": "Slack does not recognise SLACK_CLIENT_ID. Copy it again from the app's Basic Information page.",
  "slack:bad_client_secret": "Slack rejected SLACK_CLIENT_SECRET. Copy it again from the app's Basic Information page.",
};

/** A code as its sentence. Unknown Slack codes (lowercase words only) name themselves; anything else is generic. */
export function slackErrorMessage(code: string | null | undefined): string {
  if (code && Object.hasOwn(INSTALL_ERRORS, code)) return INSTALL_ERRORS[code];
  const slack = code?.match(/^(slack|denied):([a-z0-9_]{1,48})$/);
  if (slack?.[1] === "slack") return `Slack refused the install (${slack[2]}).`;
  if (slack?.[1] === "denied") return `Slack did not finish the install (${slack[2]}).`;
  return "The Slack install did not finish. Start again from Add to Slack.";
}

/** The `error` Slack puts on the redirect when the user leaves its consent screen, as a code. */
export function slackDenialCode(error: string): string {
  return error === "access_denied" ? "access_denied" : `denied:${asCode(error)}`;
}

/** Slack's own code, reduced to the characters its codes use. */
function asCode(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 48);
}

/** A failed install, carrying the code the return URL takes. The message never holds the code or a URL. */
export class SlackInstallError extends Error {
  constructor(readonly code: string) {
    super(slackErrorMessage(code));
    this.name = "SlackInstallError";
  }
}

/**
 * Trade the code for the install (oauth.v2.access, form-encoded, credentials in the body as
 * Slack documents). Only the webhook and the channel's and workspace's names and ids are kept; the bot token is
 * dropped on the floor, since delivery needs nothing but the webhook. Throws SlackInstallError.
 */
export async function exchangeSlackCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
}): Promise<SlackInstall> {
  const doFetch = input.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SlackInstallError("unreachable");
  }
  if (!res.ok) throw new SlackInstallError("bad_response");
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    team?: { id?: string; name?: string } | null;
    bot_user_id?: string;
    authed_user?: { id?: string } | null;
    incoming_webhook?: { url?: string; channel?: string; channel_id?: string } | null;
  } | null;
  if (!body) throw new SlackInstallError("bad_response");
  if (!body.ok) throw new SlackInstallError(`slack:${asCode(String(body.error ?? "unknown_error"))}`);
  const webhookUrl = body.incoming_webhook?.url;
  if (!webhookUrl || !isSlackWebhook(webhookUrl)) throw new SlackInstallError("no_webhook");
  return {
    webhookUrl,
    channel: body.incoming_webhook?.channel ?? null,
    team: body.team?.name ?? null,
    channelId: body.incoming_webhook?.channel_id ?? null,
    teamId: body.team?.id ?? null,
    botUserId: body.bot_user_id ?? null,
    userId: body.authed_user?.id ?? null,
  };
}

/**
 * Where both routes send the browser back: Settings, with `slack=connected` and the new target,
 * or `slack=error` and a reason code the page turns into a sentence.
 */
export function slackReturnUrl(origin: string, outcome: { connected: { channel: string; target: string } } | { error: string }): string {
  const url = new URL("/settings", origin);
  if ("connected" in outcome) {
    url.searchParams.set("slack", "connected");
    url.searchParams.set("channel", outcome.connected.channel);
    url.searchParams.set("target", outcome.connected.target);
  } else {
    url.searchParams.set("slack", "error");
    url.searchParams.set("reason", outcome.error);
  }
  return url.toString();
}
