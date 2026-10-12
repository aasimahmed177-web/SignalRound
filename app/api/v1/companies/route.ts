// GET /api/v1/companies?q=london&sector=fintech&stage=seed&since=2026-10-01&sort=latest|raised|name&page=1&limit=20
// The companies the feed lists rounds for, newest raise first, searched by name, description, sector, domain, or headquarters.

import { NextResponse } from "next/server";
import { seesReview, viewerFrom } from "@/lib/access";
import {
  badRequest,
  parseChoice,
  parseLimit,
  parsePage,
  parseQuery,
  parseSector,
  parseSince,
  parseStages,
  preflight,
  readHeaders,
} from "@/lib/api-params";
import { visitorRead, withinDeadline } from "@/lib/db";
import { COMPANY_SORTS } from "@/lib/directory";
import { apiCompanies } from "@/lib/public-api";
import { LIMITS, limitRequest } from "@/lib/rate-limit";

/** A browser client's CORS preflight (lib/api-params.ts preflight). */
export function OPTIONS(): Response {
  return preflight();
}

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const q = parseQuery(p.get("q"));
  if (!q.ok) return badRequest(q.error);
  const sector = parseSector(p.get("sector"));
  if (!sector.ok) return badRequest(sector.error);
  const stages = parseStages(p.get("stage"));
  if (!stages.ok) return badRequest(stages.error);
  const since = parseSince(p.get("since"));
  if (!since.ok) return badRequest(since.error);
  const sort = parseChoice(p.get("sort"), "sort", COMPANY_SORTS, "latest");
  if (!sort.ok) return badRequest(sort.error);
  const page = parsePage(p.get("page"));
  if (!page.ok) return badRequest(page.error);
  const limit = parseLimit(p.get("limit"), 20);
  if (!limit.ok) return badRequest(limit.error);
  const limited = await limitRequest(request, LIMITS.api, seesReview(viewerFrom(request.headers.get("authorization"))));
  if (limited) return limited;
  const body = await withinDeadline(
    visitorRead((h) =>
      apiCompanies(h, {
        q: q.value,
        sector: sector.value,
        stages: stages.value,
        since: since.value,
        sort: sort.value,
        page: page.value,
        limit: Math.min(limit.value, 100),
      }),
    ),
  );
  return NextResponse.json(body, { headers: readHeaders(false) });
}
