// The public "Add to Slack": any visitor may start it (the proxy leaves this path open in demo
// mode, and outside demo mode it answers 404: a private instance connects Slack from Settings). Check the install is switched on, slow down an address that keeps starting installs, pin a
// random state and the visitor's picks (preset, cadence) to this browser in a short-lived cookie,
// and send the browser to Slack's consent screen for one channel's incoming webhook.

import { type NextRequest, NextResponse } from "next/server";
import { isPublicDemo } from "@/lib/access";
import { db } from "@/lib/db";
import { publicOrigin } from "@/lib/origin";
import { listPresets } from "@/lib/presets";
import { clientKey, LIMITS, rateLimit } from "@/lib/rate-limit";
import { newSlackState, SLACK_STATE_MAX_AGE, slackAuthorizeUrl } from "@/lib/slack";
import {
  connectCookieValue,
  liveSubscriptionCount,
  normalizeCadence,
  normalizePreset,
  publicSlackConfig,
  SLACK_CONNECT_COOKIE,
  SLACK_CONNECTED_PATH,
  slackConnectedRedirectUri,
  slackPageUrl,
  subscriptionCap,
} from "@/lib/slack-subscriptions";

/** A redirect nobody caches or indexes: each one carries a fresh state. */
function redirect(url: string): NextResponse {
  const res = NextResponse.redirect(url);
  res.headers.set("cache-control", "no-store");
  res.headers.set("x-robots-tag", "noindex");
  return res;
}

export async function GET(request: NextRequest) {
  if (!isPublicDemo()) return new NextResponse("Not Found", { status: 404 });
  const origin = publicOrigin(request.headers);
  const config = publicSlackConfig();
  if (!config) return redirect(slackPageUrl(origin, "not_configured"));
  if (!(await rateLimit(LIMITS.slackConnect, clientKey(request.headers))).ok) return redirect(slackPageUrl(origin, "rate_limited"));
  const params = request.nextUrl.searchParams;
  let preset: string;
  try {
    const handle = await db();
    // Full before Slack's screen, not after the visitor picked a channel for nothing.
    if ((await liveSubscriptionCount(handle)) >= subscriptionCap()) return redirect(slackPageUrl(origin, "full"));
    preset = normalizePreset(
      params.get("preset"),
      (await listPresets(handle)).map((p) => p.slug),
    );
  } catch {
    return redirect(slackPageUrl(origin, "save_failed"));
  }
  const cadence = normalizeCadence(params.get("cadence"));
  const state = newSlackState();
  const res = redirect(slackAuthorizeUrl({ clientId: config.clientId, state, redirectUri: slackConnectedRedirectUri(origin) }));
  res.cookies.set(SLACK_CONNECT_COOKIE, connectCookieValue(state, preset, cadence), {
    httpOnly: true,
    // Lax: sent on Slack's top-level redirect back, withheld from cross-site subrequests.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: SLACK_CONNECTED_PATH,
    maxAge: SLACK_STATE_MAX_AGE,
  });
  return res;
}
