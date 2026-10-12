// GET /api/v1/companies/{id}: one company's funding, by the id /api/v1/companies returns ("ramp.com"),
// or a domain (a URL of its site works too) or earlier id the company is known by.

import { NextResponse } from "next/server";
import { seesReview, viewerFrom } from "@/lib/access";
import { preflight, readHeaders } from "@/lib/api-params";
import { visitorRead, withinDeadline } from "@/lib/db";
import { decodeParam } from "@/lib/links";
import { companyProfileOrNear } from "@/lib/public-api";
import { LIMITS, limitRequest } from "@/lib/rate-limit";

/** A browser client's CORS preflight (lib/api-params.ts preflight). */
export function OPTIONS(): Response {
  return preflight();
}

export async function GET(request: Request, ctx: RouteContext<"/api/v1/companies/[id]">) {
  const { id } = await ctx.params;
  const limited = await limitRequest(request, LIMITS.api, seesReview(viewerFrom(request.headers.get("authorization"))));
  if (limited) return limited;
  const wanted = decodeParam(id).trim().toLowerCase();
  const found = await withinDeadline(visitorRead((h) => companyProfileOrNear(h, wanted)));
  if ("error" in found) return NextResponse.json(found, { status: 404 });
  return NextResponse.json(found, { headers: readHeaders(false) });
}
