// The daily accuracy check. Vercel Cron calls GET at 05:00 UTC with `Authorization: Bearer
// $CRON_SECRET` (vercel.ts); `pnpm start` ticks it from lib/scheduler.ts. An operator runs it by
// hand with the same bearer, on GET or POST. Each run reads the companies that matter most (the top
// 100 by largest round and by total raised, plus every $100M round), records the flags an admin sees
// in Review under Accuracy, clears the ones whose condition no longer holds, starts the capped safe
// remedies, and writes a row on Runs. `?dry=1` answers with what it would flag and writes nothing.
//
//   curl -H "authorization: Bearer $CRON_SECRET" "https://fireround.dev/api/cron/accuracy?dry=1"
//   curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://fireround.dev/api/cron/accuracy?remedies=0"
//   curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://fireround.dev/api/cron/accuracy?profile=10&dossier=0"
//
// Params (query string, or a JSON body on POST): `topN` (100), `remedies` (0 or false: flags only),
// `profile` (5), `dossier` (2), `history` (3): the remedies per run of each kind.

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { ACCURACY_LANE, evaluateAccuracy, parseAccuracyParams } from "@/lib/accuracy";
import { cronAuthorized } from "@/lib/cron-auth";
import { claimCronTick } from "@/lib/cron-lease";
import { db } from "@/lib/db";
import { accuracyWorkflow } from "@/workflows/accuracy";

/** The route only queues the workflow and returns; a dry run is DB reads alone. */
export const maxDuration = 60;

async function run(input: Record<string, unknown>, tick: Date): Promise<Response> {
  const params = parseAccuracyParams(input);
  if ("error" in params) return NextResponse.json(params, { status: 400 });
  if (input.dry === "1" || input.dry === true) {
    const evaluation = await evaluateAccuracy(await db(), { topN: params.topN });
    const byRule: Record<string, number> = {};
    for (const r of evaluation.results) byRule[r.flag.rule] = (byRule[r.flag.rule] ?? 0) + 1;
    return NextResponse.json({
      ok: true,
      dry: true,
      companies: evaluation.checked.length,
      flags: evaluation.results.length,
      byRule,
      results: evaluation.results.map((r) => ({ company: r.companyId, ...r.flag })),
    });
  }
  if (!(await claimCronTick(await db(), "accuracy", tick))) return NextResponse.json({ ok: true, skipped: "already claimed" });
  const runId = `${ACCURACY_LANE}:${randomUUID()}`;
  const started = await start(accuracyWorkflow, [params, runId]);
  return NextResponse.json({
    ok: true,
    runs: [],
    lanes: [{ lane: ACCURACY_LANE, preset: null, runId }],
    workflowRunId: started?.runId ?? null,
    params,
  });
}

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return run(Object.fromEntries(new URL(request.url).searchParams), new Date());
}

export async function POST(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tick = new Date();
  let body: Record<string, unknown> = {};
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "the body is not JSON" }, { status: 400 });
    }
  }
  return run({ ...Object.fromEntries(new URL(request.url).searchParams), ...body }, tick);
}
