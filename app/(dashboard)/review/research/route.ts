// The review queue's Research button. A route handler, not a server action: Next dispatches a
// client's server actions one at a time, so a Research run (up to a few minutes) as an action
// would hold every Publish, Reject, and Undo on the page behind it. A fetch runs beside them.
// Under /review, so the proxy gates it with the admin paths in demo mode; the handler checks
// the dashboard password itself as well, the same guard every action carries.

import { revalidatePath, revalidateTag } from "next/cache";
import { attempt } from "@/lib/action-result";
import { TAG_ROUNDS } from "@/lib/cached";
import { requireDashboard } from "@/lib/dashboard-auth.server";
import { db } from "@/lib/db";
import { invalidateEntityPages } from "@/lib/entity-invalidation";
import { getFirecrawl } from "@/lib/firecrawl";
import { researchRound } from "@/lib/gapfill";

/** One agent call inline; give it room on serverless hosts. */
export const maxDuration = 300;

/**
 * The CSRF check Next runs on server actions, done by hand: the browser resends the dashboard's
 * basic-auth credentials to this origin whoever built the request, and this spends credits.
 * A JSON body forces a CORS preflight; the Origin must name this host.
 */
function sameOrigin(request: Request): boolean {
  if (!request.headers.get("content-type")?.includes("application/json")) return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * POST `{ id }`: one bounded /agent run for one review item, the play lib/gapfill.ts researchRound
 * owns. Answers an ActionResult as JSON, the same shape an action would, so the card reads the
 * reason on failure. The client refreshes the route itself: revalidatePath here only marks it.
 *
 * CEILING: runs inline (about a minute at effort low, under maxDuration). A batch "research
 * everything in the queue" belongs in a workflow with one step per record, the shape
 * workflows/enrich.ts already has.
 */
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ ok: false, error: "Cross-origin request refused." }, { status: 403 });
  const result = await attempt(async () => {
    await requireDashboard();
    const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!id) throw new Error("The request named no record.");
    const handle = await db();
    const outcome = await researchRound(handle, getFirecrawl(), id);
    revalidatePath("/runs");
    if (outcome.status === "completed") {
      await invalidateEntityPages(handle, { roundIds: [id] });
      revalidatePath("/");
      revalidatePath("/feed");
      revalidatePath("/review");
      revalidateTag(TAG_ROUNDS, "max");
    }
    return outcome;
  });
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
