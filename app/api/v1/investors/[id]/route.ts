// GET /api/v1/investors/{id}: one investor's profile, by the id /api/v1/investors returns ("sequoia-capital-india").

import { NextResponse } from "next/server";
import { seesReview, viewerFrom } from "@/lib/access";
import { preflight, readHeaders } from "@/lib/api-params";
import { db, withinDeadline } from "@/lib/db";
import { decodeParam } from "@/lib/links";
import { apiInvestorProfile } from "@/lib/public-api";
import { LIMITS, limitRequest } from "@/lib/rate-limit";

/** A browser client's CORS preflight (lib/api-params.ts preflight). */
export function OPTIONS(): Response {
  return preflight();
}

export async function GET(request: Request, ctx: RouteContext<"/api/v1/investors/[id]">) {
  const { id } = await ctx.params;
  const limited = await limitRequest(request, LIMITS.api, seesReview(viewerFrom(request.headers.get("authorization"))));
  if (limited) return limited;
  const profile = await withinDeadline(db().then((h) => apiInvestorProfile(h, decodeParam(id))));
  if (!profile) return NextResponse.json({ error: "No investor with that id is named on a published round" }, { status: 404 });
  return NextResponse.json(profile, { headers: readHeaders(false) });
}
