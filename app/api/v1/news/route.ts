// GET /api/v1/news?since=YYYY-MM-DD&sector=ai&q=acme&limit=20&cursor=...
// The latest articles about the rounds the feed lists, newest first, each with its publisher, its day, and the rounds it reports.

import { NextResponse } from "next/server";
import { seesReview, viewerFrom } from "@/lib/access";
import { badRequest, parseLimit, parseQuery, parseSector, parseSince, preflight, readHeaders } from "@/lib/api-params";
import { db, withinDeadline } from "@/lib/db";
import { apiNews, parseNewsCursor } from "@/lib/public-api";
import { LIMITS, limitRequest } from "@/lib/rate-limit";

/** A browser client's CORS preflight (lib/api-params.ts preflight). */
export function OPTIONS(): Response {
  return preflight();
}

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const since = parseSince(p.get("since"));
  if (!since.ok) return badRequest(since.error);
  const sector = parseSector(p.get("sector"));
  if (!sector.ok) return badRequest(sector.error);
  const q = parseQuery(p.get("q"));
  if (!q.ok) return badRequest(q.error);
  const limit = parseLimit(p.get("limit"), 20);
  if (!limit.ok) return badRequest(limit.error);
  const rawCursor = p.get("cursor");
  const cursor = rawCursor ? parseNewsCursor(rawCursor) : undefined;
  if (cursor === null) return badRequest('cursor must be the next_cursor of the previous page ("YYYY-MM-DD|url")');
  const limited = await limitRequest(request, LIMITS.api, seesReview(viewerFrom(request.headers.get("authorization"))));
  if (limited) return limited;
  const body = await withinDeadline(
    db().then((h) => apiNews(h, { since: since.value, sector: sector.value, q: q.value, cursor, limit: Math.min(limit.value, 100) })),
  );
  return NextResponse.json(body, { headers: readHeaders(false) });
}
