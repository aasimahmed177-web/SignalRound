import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { cronAuthorized } from "@/lib/cron-auth";
import { claimCronTick } from "@/lib/cron-lease";
import { db } from "@/lib/db";
import { verifyRoundsWorkflow } from "@/workflows/corroborate";

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tick = new Date();
  const requested = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 40) : 12;
  if (!(await claimCronTick(await db(), "verify-rounds", tick))) return NextResponse.json({ ok: true, skipped: "already claimed" });
  const runId = `verify:${randomUUID()}`;
  const started = await start(verifyRoundsWorkflow, [runId, limit]);
  return NextResponse.json({ ok: true, runId, workflowRunId: started?.runId ?? null });
}
