// The X announcements lane, hourly. Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`
// (vercel.json); `pnpm start` ticks it from lib/scheduler.ts. It runs when the coverage rung has the
// discovery lanes on (Deep and Max, the same switch as watch sites): the X search runs on the watch
// cadence (every hour on Max, 06:00 UTC on Deep, looking back a day), and the leads due a search for
// their article are worked every hour either way. `?force=1` runs the search now whatever the rung.
//
//   curl -H "authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/announcements?force=1"

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { cronAuthorized } from "@/lib/cron-auth";
import { claimCronTick } from "@/lib/cron-lease";
import { db } from "@/lib/db";
import { laneDue } from "@/lib/lanes";
import { getCoverage } from "@/lib/settings";
import { announcementsWorkflow } from "@/workflows/announcements";

/** The route only queues the workflow and returns. */
export const maxDuration = 60;

/** How old a post may be to count: twelve hours on the hourly cadence, a day and two hours on the daily. */
const LOOKBACK_HOURS = { hourly: 12, daily: 26 } as const;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tick = new Date();
  const url = new URL(request.url);
  const origin = process.env.APP_ORIGIN ?? url.origin;
  const force = url.searchParams.get("force") === "1";
  const plan = await getCoverage(await db());
  if (!force && !plan.watchSites.enabled) return NextResponse.json({ ok: true, skipped: "off at this coverage rung" });
  const cadence = plan.watchSites.cadence;
  const lookback = force || laneDue(cadence, new Date()) ? LOOKBACK_HOURS[cadence] : null;
  if (!(await claimCronTick(await db(), "announcements", tick))) return NextResponse.json({ ok: true, skipped: "already claimed" });
  const runId = `announcements:${randomUUID()}`;
  await start(announcementsWorkflow, [runId, origin, lookback]);
  return NextResponse.json({ ok: true, runs: [], lanes: [{ lane: "announcements", preset: null, runId }] });
}
