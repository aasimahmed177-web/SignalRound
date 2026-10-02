// "Add to Slack" lands here: mint a state, pin it to this browser in a short-lived cookie, and
// send the browser to Slack's consent screen. An admin action, so it checks the dashboard
// password itself as well as behind the proxy (which gates /api/slack in demo mode too); a
// password-less demo answers 404 here as well.

import { type NextRequest, NextResponse } from "next/server";
import { adminRefusal } from "@/lib/access";
import { publicOrigin } from "@/lib/origin";
import {
  newSlackState,
  SLACK_STATE_COOKIE,
  SLACK_STATE_MAX_AGE,
  slackAuthorizeUrl,
  slackOAuthConfig,
  slackRedirectUri,
  slackReturnUrl,
} from "@/lib/slack";

export async function GET(request: NextRequest) {
  const refused = adminRefusal(request.headers.get("authorization"));
  if (refused) return refused;
  const origin = publicOrigin(request.headers);
  const config = slackOAuthConfig();
  if (!config) {
    return NextResponse.redirect(slackReturnUrl(origin, { error: "not_configured" }));
  }
  const state = newSlackState();
  const res = NextResponse.redirect(slackAuthorizeUrl({ clientId: config.clientId, state, redirectUri: slackRedirectUri(origin) }));
  res.cookies.set(SLACK_STATE_COOKIE, state, {
    httpOnly: true,
    // Lax: sent on Slack's top-level redirect back, withheld from cross-site subrequests.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/slack",
    maxAge: SLACK_STATE_MAX_AGE,
  });
  return res;
}
