// The production health check, every ten minutes. Vercel Cron calls this with `Authorization:
// Bearer $CRON_SECRET` (vercel.json). Each call probes the database and the public pages, checks
// every scheduled lane kept its cadence under the coverage plan, and reads the run error rate, the
// outbox, and the feed's freshness (lib/health-check.ts). A condition failing two checks in a row
// posts one message to ALERT_SLACK_WEBHOOK_URL (logged when unset); two passing checks post one
// "recovered". docs/deploy.md has the triggers.
//
//   curl -H "authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/health?dry=1"   # read only: findings, no state, no message
//   curl -H "authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/health?test=1"  # one test line to the alert channel

import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { claimCronTick } from "@/lib/cron-lease";
import { db } from "@/lib/db";
import { runHealthCheck, sendTestAlert } from "@/lib/health-check";

/** Page probes time out at 15 seconds; a store that is down adds one 20-second confirmation wait. */
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tick = new Date();
  const url = new URL(request.url);
  const origin = process.env.APP_ORIGIN ?? url.origin;
  if (url.searchParams.get("dry") !== "1" || url.searchParams.get("test") === "1") {
    const mayRun = await db()
      .then((handle) => claimCronTick(handle, "health", tick))
      .catch(() => true);
    if (!mayRun) return NextResponse.json({ ok: true, skipped: "already claimed" });
  }
  if (url.searchParams.get("test") === "1") return NextResponse.json({ ok: true, sent: await sendTestAlert({ origin }) });
  return NextResponse.json(await runHealthCheck({ origin, dry: url.searchParams.get("dry") === "1" }));
}
