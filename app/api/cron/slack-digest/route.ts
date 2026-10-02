// The public Slack subscriptions' morning digest: every daily subscription due one gets it (lib/
// slack-delivery.ts sendDailyDigests). Vercel Cron calls this once a day at 07:00 UTC with
// `Authorization: Bearer $CRON_SECRET`; the deliveries cron retries any that failed.

import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { claimCronTick } from "@/lib/cron-lease";
import { db } from "@/lib/db";
import { sendDailyDigests } from "@/lib/slack-delivery";

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tick = new Date();
  const origin = process.env.APP_ORIGIN ?? new URL(request.url).origin;
  if (!(await claimCronTick(await db(), "slack-digest", tick))) return NextResponse.json({ ok: true, skipped: "already claimed" });
  const summary = await sendDailyDigests(await db(), origin);
  return NextResponse.json({ ok: true, ...summary });
}
