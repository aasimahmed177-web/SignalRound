// The Apollo backfill: every visible company with a verified domain and no apollo row is looked up
// through Alexandria, ten domains a call, 30 credits for each company Apollo matches (a miss is
// free). It only writes: an enrichment row per company, a verified logo where a company has none, and
// the funding events the store lacks queued as history leads. The history backfill searches and
// verifies those leads afterwards. Not a scheduled cron: an operator starts it, guarded by the same
// CRON_SECRET bearer as the crons.
//
//   curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://fireround.dev/api/cron/backfill-apollo?limit=20"
//   curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://fireround.dev/api/cron/backfill-apollo"
//   curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://fireround.dev/api/cron/history-rounds"
//   curl -H "authorization: Bearer $CRON_SECRET" "https://fireround.dev/api/cron/backfill-apollo?workflow=<workflowRunId>"
//
// POST params (query string, or a JSON body with the same names): `limit` (companies; all without a
// row when omitted), `maxCredits` (15,000: no call starts past it), `leads` (0 or false: write the
// rows without queueing leads). GET reports what Apollo filled, the admin signals, the leads by
// status, the latest backfill rows, and a workflow's status.

import { randomUUID } from "node:crypto";
import { schema } from "@fireround/core/db";
import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getRun, start } from "workflow/api";
import { apolloCoverage, parseApolloBackfillParams, pendingApollo } from "@/lib/apollo";
import { cronAuthorized } from "@/lib/cron-auth";
import { claimCronTick } from "@/lib/cron-lease";
import { db } from "@/lib/db";
import { backfillApolloWorkflow } from "@/workflows/apollo";

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
  const params = parseApolloBackfillParams({ ...Object.fromEntries(url.searchParams), ...body });
  if ("error" in params) return NextResponse.json(params, { status: 400 });
  // Without a key every call would fail; refuse before a workflow starts.
  if (!process.env.FIRECRAWL_API_KEY) return NextResponse.json({ error: "FIRECRAWL_API_KEY is not set" }, { status: 409 });
  const planned = await pendingApollo(await db(), null, params.limit ?? 100_000);
  if (!(await claimCronTick(await db(), "backfill-apollo", tick))) return NextResponse.json({ ok: true, skipped: "already claimed" });
  const runId = `apollo-backfill:${randomUUID()}`;
  const run = await start(backfillApolloWorkflow, [params, runId]);
  return NextResponse.json({ ok: true, runId, workflowRunId: run?.runId ?? null, params, planned: { companies: planned.length } });
}

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const handle = await db();
  const [coverage, runs] = await Promise.all([
    apolloCoverage(handle),
    handle
      .select({
        id: schema.runs.id,
        startedAt: schema.runs.startedAt,
        finishedAt: schema.runs.finishedAt,
        counts: schema.runs.counts,
        error: schema.runs.error,
      })
      .from(schema.runs)
      .where(and(eq(schema.runs.lane, "enrich"), eq(schema.runs.presetSlug, "apollo-backfill")))
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
