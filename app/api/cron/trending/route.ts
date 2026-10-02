// The Trending lane, hourly. Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`
// (vercel.json); `pnpm start` ticks it from lib/scheduler.ts. The coverage rung decides whether it
// runs (on at Deep and Max); `?force=1` runs it whatever the rung says. Each run follows the visible
// rounds first seen in the last 72 hours, searches the ones a checkpoint has come for, rescores
// every one, and records a row on Runs.
//
//   curl -H "authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/trending?force=1"

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { cronAuthorized } from "@/lib/cron-auth";
import { claimCronTick } from "@/lib/cron-lease";
import { db } from "@/lib/db";
import { getCoverage } from "@/lib/settings";
import { trendingWorkflow } from "@/workflows/trending";

/** The route only queues the workflow and returns. */
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tick = new Date();
  const force = new URL(request.url).searchParams.get("force") === "1";
  if (!force) {
    const plan = await getCoverage(await db());
    if (!plan.trending) return NextResponse.json({ ok: true, skipped: "off at this coverage rung" });
  }
  if (!(await claimCronTick(await db(), "trending", tick))) return NextResponse.json({ ok: true, skipped: "already claimed" });
  const runId = `trending:${randomUUID()}`;
  await start(trendingWorkflow, [runId]);
  return NextResponse.json({ ok: true, runs: [], lanes: [{ lane: "trending", preset: null, runId }] });
}
