"use server";

import { headers } from "next/headers";
import { viewer } from "@/lib/access";
import { requireVisitorOrDashboard } from "@/lib/dashboard-auth.server";
import { db } from "@/lib/db";
import { type SearchHit, searchDirectory } from "@/lib/directory";
import { clientKey, counted, LIMITS, rateLimit } from "@/lib/rate-limit";

/**
 * The command palette's lookup. A read of what the feed already shows, so a demo visitor may run
 * it; outside a demo it takes the dashboard password like every other server function. A visitor
 * past the palette's budget gets no hits rather than an error: the box just stops suggesting.
 */
export async function searchEntities(q: string): Promise<{ companies: SearchHit[]; investors: SearchHit[] }> {
  await requireVisitorOrDashboard();
  if (typeof q !== "string") return { companies: [], investors: [] };
  if (counted((await viewer()).admin) && !(await rateLimit(LIMITS.search, clientKey(await headers()))).ok) {
    return { companies: [], investors: [] };
  }
  return searchDirectory(await db(), q);
}
