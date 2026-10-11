// GET /api/v1/investors/top?window=7d|30d|90d&sector=ai&stage=seed,series_a&limit=10
// The investors that led the most rounds in the window, with their share of the money led and their latest led rounds.

import { NextResponse } from "next/server";
import { seesReview, viewerFrom } from "@/lib/access";
import { badRequest, parseChoice, parseLimit, parseSector, parseStages, preflight, readHeaders } from "@/lib/api-params";
import { db, withinDeadline } from "@/lib/db";
import { apiTopLeads, TOP_WINDOWS, type TopWindow } from "@/lib/public-api";
import { LIMITS, limitRequest } from "@/lib/rate-limit";

/** A browser client's CORS preflight (lib/api-params.ts preflight). */
export function OPTIONS(): Response {
  return preflight();
}

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const window = parseChoice(p.get("window"), "window", Object.keys(TOP_WINDOWS) as TopWindow[], "30d");
  if (!window.ok) return badRequest(window.error);
  const sector = parseSector(p.get("sector"));
  if (!sector.ok) return badRequest(sector.error);
  const stages = parseStages(p.get("stage"));
  if (!stages.ok) return badRequest(stages.error);
  const limit = parseLimit(p.get("limit"), 10);
  if (!limit.ok) return badRequest(limit.error);
  const limited = await limitRequest(request, LIMITS.api, seesReview(viewerFrom(request.headers.get("authorization"))));
  if (limited) return limited;
  const body = await withinDeadline(
    db().then((h) =>
      apiTopLeads(h, { window: window.value, sector: sector.value, stages: stages.value, limit: Math.min(limit.value, 50) }),
    ),
  );
  return NextResponse.json(body, { headers: readHeaders(false) });
}
