import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { cronAuthorized } from "@/lib/cron-auth";
import { claimCronTick } from "@/lib/cron-lease";
import { db } from "@/lib/db";
import { companyNewsroomsWorkflow } from "@/workflows/company-newsrooms";

export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tick = new Date();
  if (!(await claimCronTick(await db(), "company-newsrooms", tick))) return NextResponse.json({ ok: true, skipped: "already claimed" });
  const runId = `company-newsrooms:${randomUUID()}`;
  const origin = process.env.APP_ORIGIN ?? new URL(request.url).origin;
  const started = await start(companyNewsroomsWorkflow, [origin, runId]);
  return NextResponse.json({ ok: true, lanes: [{ lane: "company-newsrooms", runId }], workflowRunId: started?.runId ?? null });
}
