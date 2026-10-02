// The dossier backfill: every visible company (a publish or flagged round) without a checked
// dossier gets one. Dossiers written before the check are checked first (no agent run), then the
// companies with none are dived, newest round first. Not a scheduled cron: an operator starts it,
// guarded by the same CRON_SECRET bearer as the crons.
//
//   curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://fireround.dev/api/cron/backfill-dossiers?limit=5"
//   curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://fireround.dev/api/cron/backfill-dossiers?reverifyOnly=1"
//   curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://fireround.dev/api/cron/backfill-dossiers"
//   curl -H "authorization: Bearer $CRON_SECRET" "https://fireround.dev/api/cron/backfill-dossiers?workflow=<workflowRunId>"
//
// POST params (query string, or a JSON body with the same names): `limit` caps each group (a pilot
// of 5 checks five and dives five; all when omitted), `concurrency` (20, at most 100), `maxTotalCredits`
// (250,000: no new dive starts past it), `reverifyOnly` (1 or true: check, never dive). GET reports
// the store's dossier coverage, the latest backfill rows with their counts, and a workflow's status.

import { randomUUID } from "node:crypto";
import { schema } from "@fireround/core/db";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getRun, start } from "workflow/api";
import { cronAuthorized } from "@/lib/cron-auth";
import { claimCronTick } from "@/lib/cron-lease";
import { db } from "@/lib/db";
import { dossierCheckAvailable } from "@/lib/dossier-check";
import { backfillTargets, dossierCoverage, parseBackfillParams } from "@/lib/intel";
import { backfillDossiersWorkflow } from "@/workflows/dossiers";

/** The agent can run for many minutes per company; the route only queues the workflow and returns. */
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
  const params = parseBackfillParams({ ...Object.fromEntries(url.searchParams), ...body });
  if ("error" in params) return NextResponse.json(params, { status: 400 });
  // Without a model nothing could be saved; refuse before a credit is spent.
  if (!dossierCheckAvailable()) {
    return NextResponse.json({ error: "no model is configured to check dossiers (set AI_GATEWAY_API_KEY)" }, { status: 409 });
  }
  const handle = await db();
  const planned = await backfillTargets(handle, { limit: params.limit, reverifyOnly: params.reverifyOnly });
  if (!(await claimCronTick(handle, "backfill-dossiers", tick))) return NextResponse.json({ ok: true, skipped: "already claimed" });
  const runId = `dossiers:${randomUUID()}`;
  const run = await start(backfillDossiersWorkflow, [params, runId]);
  return NextResponse.json({
    ok: true,
    runId,
    workflowRunId: run?.runId ?? null,
    params,
    planned: {
      reverify: planned.filter((t) => t.action === "reverify").length,
      dive: planned.filter((t) => t.action === "dive").length,
    },
  });
}

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const handle = await db();
  const [coverage, runs] = await Promise.all([
    dossierCoverage(handle),
    handle
      .select({
        id: schema.runs.id,
        startedAt: schema.runs.startedAt,
        finishedAt: schema.runs.finishedAt,
        counts: schema.runs.counts,
        error: schema.runs.error,
      })
      .from(schema.runs)
      .where(eq(schema.runs.lane, "dossiers"))
      .orderBy(desc(schema.runs.startedAt))
      .limit(5),
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
    workflow,
  });
}
