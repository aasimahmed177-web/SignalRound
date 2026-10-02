// Flush the delivery outbox: retries with backoff for anything that failed, and any public Slack
// digest the morning run missed. Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`.

import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { claimCronTick } from "@/lib/cron-lease";
import { db } from "@/lib/db";
import { flushDeliveries } from "@/lib/delivery";
import { sendDailyDigests } from "@/lib/slack-delivery";

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tick = new Date();
  const origin = process.env.APP_ORIGIN ?? new URL(request.url).origin;
  const handle = await db();
  if (!(await claimCronTick(handle, "deliveries", tick))) return NextResponse.json({ ok: true, skipped: "already claimed" });
  const summary = await flushDeliveries(handle, origin);
  const digests = await sendDailyDigests(handle, origin);
  return NextResponse.json({ ok: true, ...summary, digests });
}
