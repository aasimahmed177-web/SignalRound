// GET /api/v1/investors?q=sequoia&sort=led|rounds|latest|name&page=1&limit=20
// The investors named on the rounds the feed lists, searched by name, with the rounds each led and joined.

import { NextResponse } from "next/server";
import { seesReview, viewerFrom } from "@/lib/access";
import { badRequest, parseChoice, parseLimit, parsePage, parseQuery, preflight, readHeaders } from "@/lib/api-params";
import { db, withinDeadline } from "@/lib/db";
import { API_INVESTOR_SORTS, apiInvestors } from "@/lib/public-api";
import { LIMITS, limitRequest } from "@/lib/rate-limit";

/** A browser client's CORS preflight (lib/api-params.ts preflight). */
export function OPTIONS(): Response {
  return preflight();
}

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const q = parseQuery(p.get("q"));
  if (!q.ok) return badRequest(q.error);
  const sort = parseChoice(p.get("sort"), "sort", API_INVESTOR_SORTS, "led");
  if (!sort.ok) return badRequest(sort.error);
  const page = parsePage(p.get("page"));
  if (!page.ok) return badRequest(page.error);
  const limit = parseLimit(p.get("limit"), 20);
  if (!limit.ok) return badRequest(limit.error);
  const limited = await limitRequest(request, LIMITS.api, seesReview(viewerFrom(request.headers.get("authorization"))));
  if (limited) return limited;
  const body = await withinDeadline(
    db().then((h) => apiInvestors(h, { q: q.value, sort: sort.value, page: page.value, limit: Math.min(limit.value, 100) })),
  );
  return NextResponse.json(body, { headers: readHeaders(false) });
}
