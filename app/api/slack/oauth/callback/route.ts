// Slack sends the browser back here after the channel pick. Check the state against this
// browser's cookie (and clear it either way), trade the code for the channel's webhook, store
// that as an ordinary Slack delivery target, and return to Settings to say so. Every failure
// goes back to Settings as a reason code; the webhook URL is never logged or echoed.

import { type NextRequest, NextResponse } from "next/server";
import { adminRefusal } from "@/lib/access";
import { db } from "@/lib/db";
import { publicOrigin } from "@/lib/origin";
import { createTarget } from "@/lib/settings";
import {
  exchangeSlackCode,
  SLACK_STATE_COOKIE,
  SlackInstallError,
  slackDenialCode,
  slackOAuthConfig,
  slackRedirectUri,
  slackReturnUrl,
  slackStateMatches,
  slackTargetLabel,
} from "@/lib/slack";

/** A new Slack channel gets every preset at the form's default floor: verified and checked. */
const DEFAULT_FLOOR = 0.5;

export async function GET(request: NextRequest) {
  const refused = adminRefusal(request.headers.get("authorization"));
  if (refused) return refused;
  const origin = publicOrigin(request.headers);
  const params = request.nextUrl.searchParams;
  const cookie = request.cookies.get(SLACK_STATE_COOKIE)?.value;

  const back = (outcome: Parameters<typeof slackReturnUrl>[1]) => {
    const res = NextResponse.redirect(slackReturnUrl(origin, outcome));
    // One state, one use: cleared on every way out, success or not.
    res.cookies.set(SLACK_STATE_COOKIE, "", { path: "/api/slack", maxAge: 0 });
    return res;
  };

  const denied = params.get("error");
  if (denied) return back({ error: slackDenialCode(denied) });
  if (!slackStateMatches(params.get("state"), cookie)) {
    return back({ error: "state_mismatch" });
  }
  const code = params.get("code");
  if (!code) return back({ error: "no_code" });
  const config = slackOAuthConfig();
  if (!config) return back({ error: "not_configured" });

  let install: Awaited<ReturnType<typeof exchangeSlackCode>>;
  try {
    install = await exchangeSlackCode({ code, ...config, redirectUri: slackRedirectUri(origin) });
  } catch (err) {
    return back({ error: err instanceof SlackInstallError ? err.code : "bad_response" });
  }
  try {
    const { id } = await createTarget(await db(), {
      channel: "slack",
      target: install.webhookUrl,
      slackTeamId: install.teamId,
      slackBotUserId: install.botUserId,
      slackUserId: install.userId,
      label: slackTargetLabel(install.channel, install.team),
      presetSlug: null,
      minConfidence: DEFAULT_FLOOR,
    });
    return back({ connected: { channel: slackTargetLabel(install.channel, null), target: id } });
  } catch {
    // A driver error quotes the query's parameters, the webhook URL among them: never forward it.
    return back({ error: "save_failed" });
  }
}
