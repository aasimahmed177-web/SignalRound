// Slack sends the visitor back here after the channel pick. Check the state against this browser's
// cookie (cleared on every way out), trade the code for the channel's webhook, keep the webhook
// (encrypted), the channel, and the workspace, drop the bot token, and create or update the
// channel's subscription. Then post the welcome and open the manage page. A failure goes to the
// Slack page as a reason code; the webhook URL is never logged, echoed, or put in a URL.

import { type NextRequest, NextResponse } from "next/server";
import { isPublicDemo } from "@/lib/access";
import { db } from "@/lib/db";
import { publicOrigin } from "@/lib/origin";
import { exchangeSlackCode, SlackInstallError, slackStateMatches } from "@/lib/slack";
import { sendWelcome } from "@/lib/slack-delivery";
import {
  manageUrl,
  parseConnectCookie,
  publicSlackConfig,
  SLACK_CONNECT_COOKIE,
  SLACK_CONNECTED_PATH,
  SubscribeRefused,
  slackConnectedRedirectUri,
  slackPageUrl,
  upsertSubscription,
} from "@/lib/slack-subscriptions";

export async function GET(request: NextRequest) {
  if (!isPublicDemo()) return new NextResponse("Not Found", { status: 404 });
  const origin = publicOrigin(request.headers);
  const params = request.nextUrl.searchParams;
  const picked = parseConnectCookie(request.cookies.get(SLACK_CONNECT_COOKIE)?.value);

  const go = (url: string) => {
    const res = NextResponse.redirect(url);
    res.headers.set("cache-control", "no-store");
    res.headers.set("x-robots-tag", "noindex");
    // One state, one use: cleared on every way out, success or not.
    res.cookies.set(SLACK_CONNECT_COOKIE, "", { path: SLACK_CONNECTED_PATH, maxAge: 0 });
    return res;
  };
  const fail = (code: string) => go(slackPageUrl(origin, code));

  if (params.get("error")) return fail(params.get("error") === "access_denied" ? "access_denied" : "bad_response");
  if (!picked || !slackStateMatches(params.get("state"), picked.state)) return fail("state_mismatch");
  const code = params.get("code");
  if (!code) return fail("no_code");
  const config = publicSlackConfig();
  if (!config) return fail("not_configured");

  let install: Awaited<ReturnType<typeof exchangeSlackCode>>;
  try {
    install = await exchangeSlackCode({
      code,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: slackConnectedRedirectUri(origin),
    });
  } catch (err) {
    const reason = err instanceof SlackInstallError ? err.code : "bad_response";
    return fail(["unreachable", "no_webhook"].includes(reason) ? reason : "bad_response");
  }
  if (!install.teamId || !install.channelId) return fail("no_webhook");

  let handle: Awaited<ReturnType<typeof db>>;
  let sub: Awaited<ReturnType<typeof upsertSubscription>>;
  try {
    handle = await db();
    sub = await upsertSubscription(
      handle,
      {
        webhookUrl: install.webhookUrl,
        teamId: install.teamId,
        botUserId: install.botUserId,
        userId: install.userId,
        teamName: install.team,
        channelId: install.channelId,
        channelName: install.channel,
        presetSlug: picked.preset,
        cadence: picked.cadence,
      },
      config.key,
    );
  } catch (err) {
    // A driver error quotes the query's parameters, the ciphertext among them: never forward it.
    return fail(err instanceof SubscribeRefused ? err.code : "save_failed");
  }
  // The welcome is the proof it worked; if Slack refuses it, the manage page says so.
  const welcome = await sendWelcome(handle, sub.id, origin).catch(() => ({ ok: false as const }));
  const next = new URL(manageUrl(origin, sub.token));
  next.searchParams.set("connected", welcome.ok ? "1" : "quiet");
  return go(next.toString());
}
