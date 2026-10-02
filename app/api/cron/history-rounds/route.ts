// The history backfill: every checked dossier's prior rounds, each looked for once and promoted to a
// verified round marked history when its own announcement is found and read. Not a scheduled cron:
// an operator starts it, guarded by the same CRON_SECRET bearer as the crons. Idempotent: a prior
// round already promoted, or searched with no source found, is never searched again.
//
//   curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://fireround.dev/api/cron/history-rounds?limit=10"
//   curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://fireround.dev/api/cron/history-rounds"
//   curl -H "authorization: Bearer $CRON_SECRET" "https://fireround.dev/api/cron/history-rounds?workflow=<workflowRunId>"
//
// POST params (query string, or a JSON body with the same names): `limit` (dossiers to work; all
// with work left when omitted), `concurrency` (20, at most 100), `maxTotalCredits` (25,000: no company
// starts past it). GET reports where the prior rounds stand, the latest backfill rows with their
// counts, the newest history rows, and a workflow's status.

import { randomUUID } from "node:crypto";
import { schema } from "@fireround/core/db";
import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getRun, start } from "workflow/api";
import { cronAuthorized } from "@/lib/cron-auth";
import { claimCronTick } from "@/lib/cron-lease";
import { db } from "@/lib/db";
import { historyCoverage, historyTargets, latestHistoryRows, parseHistoryBackfillParams } from "@/lib/history";
import { backfillHistoryWorkflow } from "@/workflows/history";

/** The route only queues the workflow and returns. */
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tick = new Date();
  const url = new URL(request.url);
  let body: Record<string, unknown> = {};
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "the body is not JSON" }, { status: 400 });
    }
  }
  const params = parseHistoryBackfillParams({ ...Object.fromEntries(url.searchParams), ...body });
  if ("error" in params) return NextResponse.json(params, { status: 400 });
  const planned = await historyTargets(await db(), { limit: params.limit });
  if (!(await claimCronTick(await db(), "history-rounds", tick))) return NextResponse.json({ ok: true, skipped: "already claimed" });
  const runId = `history-rounds:${randomUUID()}`;
  const run = await start(backfillHistoryWorkflow, [params, runId]);
  return NextResponse.json({ ok: true, runId, workflowRunId: run?.runId ?? null, params, planned: { companies: planned.length } });
}

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const handle = await db();
  const [coverage, runs, latest] = await Promise.all([
    historyCoverage(handle),
    handle
      .select({
        id: schema.runs.id,
        startedAt: schema.runs.startedAt,
        finishedAt: schema.runs.finishedAt,
        counts: schema.runs.counts,
        error: schema.runs.error,
      })
      .from(schema.runs)
      .where(and(eq(schema.runs.lane, "history"), eq(schema.runs.presetSlug, "history-backfill")))
      .orderBy(desc(schema.runs.startedAt))
      .limit(5),
    latestHistoryRows(handle),
  ]);
  const workflowRunId = url.searchParams.get("workflow");
  let workflow: { id: string; status: string } | { id: string; error: string } | null = null;
  if (workflowRunId) {
    try {
      workflow = { id: workflowRunId, status: String(await getRun(workflowRunId).status) };
    } catch (err) {
      workflow = { id: workflowRunId, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return NextResponse.json({
    ok: true,
    coverage,
    runs: runs.map((r) => ({
      id: r.id,
      started_at: r.startedAt.toISOString(),
      finished_at: r.finishedAt?.toISOString() ?? null,
      counts: r.counts,
      error: r.error,
    })),
    latest,
    workflow,
  });
}
