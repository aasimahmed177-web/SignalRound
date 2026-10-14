// GET /api/v1/news?since=YYYY-MM-DD&sector=ai&q=acme&company=acme.com&limit=20&cursor=...
// The latest articles about the rounds the feed lists, newest first, each with its publisher, its day, and the rounds it reports.

import { NextResponse } from "next/server";
import { seesReview, viewerFrom } from "@/lib/access";
import { badRequest, parseLimit, parseQuery, parseSector, parseSince, preflight, readHeaders } from "@/lib/api-params";
import { visitorRead, withinDeadline } from "@/lib/db";
import { apiNews, newsCompany, parseNewsCursor } from "@/lib/public-api";
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
  const company = parseQuery(p.get("company"));
  if (!company.ok) return badRequest(company.error.replace(/^q /, "company "));
  const rawCursor = p.get("cursor");
  const cursor = rawCursor ? parseNewsCursor(rawCursor) : undefined;
  if (cursor === null) return badRequest('cursor must be the next_cursor of the previous page ("YYYY-MM-DD|url")');
  const limited = await limitRequest(request, LIMITS.api, seesReview(viewerFrom(request.headers.get("authorization"))));
  if (limited) return limited;
  const body = await withinDeadline(
    visitorRead(async (h) => {
      const named = company.value ? await newsCompany(h, company.value) : undefined;
      if (named && "error" in named) return named;
      const { matched_from, note } = named ?? {};
      const page = await apiNews(h, {
        since: since.value,
        sector: sector.value,
        q: q.value,
        companyId: named?.id,
        cursor,
        limit: Math.min(limit.value, 100),
      });
      return matched_from ? { ...page, matched_from, note } : page;
    }),
  );
  if ("error" in body) return NextResponse.json(body, { status: 404 });
  return NextResponse.json(body, { headers: readHeaders(false) });
}
