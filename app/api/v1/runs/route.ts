// Recent pipeline runs with their per-stage counts and drop tallies: the same rows the Runs page renders
// (a public demo's visitor sees neither page nor API list the admin lanes, nor any credit figure).

import { NextResponse } from "next/server";
import { seesReview, viewerFrom } from "@/lib/access";
import { badRequest, parseLimit, readHeaders } from "@/lib/api-params";
import { db } from "@/lib/db";
import { listRuns } from "@/lib/news";
import { publicRun } from "@/lib/public-view";
import { LIMITS, limitRequest } from "@/lib/rate-limit";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));
  if (!limit.ok) return badRequest(limit.error);
  // A demo visitor gets every lane but the admin ones, as on the Runs page, and no spend: the
  // credits columns and every credit or budget counter are the operator's.
  const insider = seesReview(viewerFrom(request.headers.get("authorization")));
  const limited = await limitRequest(request, LIMITS.api, insider);
  if (limited) return limited;
  const rows = await listRuns(await db(), limit.value, { adminLanes: insider });
  return NextResponse.json({ data: insider ? rows : rows.map(publicRun) }, { headers: readHeaders(insider) });
}
