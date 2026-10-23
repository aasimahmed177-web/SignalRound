import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { cronAuthorized } from "@/lib/cron-auth";
import { claimCronTick } from "@/lib/cron-lease";
import { db } from "@/lib/db";
import { getCoverage } from "@/lib/settings";
import { nativeMonitorsWorkflow } from "@/workflows/native-monitors";

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const handle = await db();
  const now = new Date();
  const { monitorSchedule } = await getCoverage(handle);
  const due = monitorSchedule === "hourly" || (monitorSchedule === "every 6 hours" ? now.getUTCHours() % 6 === 0 : now.getUTCHours() === 9);
  if (!due && new URL(request.url).searchParams.get("force") !== "1") return NextResponse.json({ ok: true, skipped: "not due" });
  if (!(await claimCronTick(handle, "native-monitors", now))) return NextResponse.json({ ok: true, skipped: "already claimed" });
  const run = await start(nativeMonitorsWorkflow, [process.env.APP_ORIGIN ?? new URL(request.url).origin]);
  return NextResponse.json({ ok: true, runId: run.runId });
}
