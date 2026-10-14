// The dashboard password gates the whole app: every page, the read API, and the server-action
// POSTs that land on those pages. The excluded routes carry their own secrets instead: the
// webhook verifies the Firecrawl signature, the cron routes take CRON_SECRET, the MCP server
// MCP_API_KEY, and the feeds their per-token path. With DASHBOARD_PASSWORD unset nothing is
// gated: a laptop, or a host with its own protection in front.
//
// PUBLIC_DEMO=1 turns it into a public demo: `/` serves the feed, and everything matched here
// (the pages, /api/v1) is open except the admin paths (/review, /presets, /settings, and the
// admin Slack install routes), which keep the password check. Server actions and the Slack routes
// guard themselves too, so a visitor cannot call a write the UI never rendered. The public Add to
// Slack (/api/slack/connect, /api/slack/connected, /slack/manage/<token>) is open on purpose: it
// writes only the visitor's own channel subscription, gated by Slack's OAuth and the manage token. A demo with no
// password has no admin tier at all: the admin paths answer 404, never a Basic challenge, so a
// browser never pops a sign-in dialog and a visitor never reaches a control that spends credits.
//
// LANDING=1 serves the landing page at `/` instead (frontDoor in lib/access.ts), and the feed
// stays at /feed. The rewrite comes after the password check, so a private instance keeps its gate.
// With neither flag `/` redirects to /overview (homeRedirect), also after the check.
//
// A demo visitor's company or investor page is checked against the store first (lib/entity-exists.ts):
// the pages stream inside Suspense, so a miss found there could only ever answer 200. A miss here
// is rewritten to an unmatched path under MISSING_PREFIX, which Next answers with a real 404 and the
// root not-found, which reads the kind from the address.

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { adminRefusal, frontDoor, homeRedirect, isAdminPath, isLanding, isPublicDemo, viewerFrom } from "@/lib/access";
import { requestCompanyPath } from "@/lib/company-request-status";
import { companyRequestFor } from "@/lib/company-requests";
import { db } from "@/lib/db";
import { companyRedirect, entityPath, entityVisible, investorRedirect } from "@/lib/entity-exists";
import { companyHref, investorHref, legacyInvestorPath } from "@/lib/links";

/** No route lives here, so a rewrite under it is Next's own 404, status included. */
const MISSING_PREFIX = "/_missing";

/**
 * The entity a demo visitor's request names, when it should be checked before the page streams; null
 * otherwise. Only with a database URL: an embedded store belongs to one process, and a private
 * instance's viewers all see review rows, so there a page can only miss on a bad id and keeps its
 * in-page not-found. An admin sees review rows too, so an admin's request is never checked.
 */
function entityToCheck(request: NextRequest) {
  if (!process.env.DATABASE_URL) return null;
  const entity = entityPath(request.nextUrl.pathname);
  if (!entity || viewerFrom(request.headers.get("authorization")).admin) return null;
  return entity;
}

/** The entity page checked against the store: a miss rewritten to a 404, anything else on to pass. */
async function checkedEntity(
  request: NextRequest,
  entity: NonNullable<ReturnType<typeof entityToCheck>>,
  mode: { demo: boolean; landing: boolean },
): Promise<NextResponse> {
  if ((await entityVisible(entity.kind, entity.id)) !== false) return pass(request, mode);
  // A request submitted since the snapshot loaded already has its page at the domain.
  if (
    entity.kind === "companies" &&
    entity.id.includes(".") &&
    process.env.COMPANY_REQUESTS === "1" &&
    (await companyRequestFor(await db(), entity.id))
  ) {
    return pass(request, mode);
  }
  const url = request.nextUrl.clone();
  // A folded company's old id (a link a Slack delivery already sent) goes to the row it went into. Not a
  // permanent redirect: a fold found by a name alias is a reading of the store, and a browser keeps a 308.
  // A renamed company's old id is the one exception: the same company now lives at a clean id for good.
  const survivor = entity.kind === "companies" ? await companyRedirect(await db(), entity.id).catch(() => null) : null;
  if (survivor) {
    url.pathname = companyHref(survivor.id);
    return NextResponse.redirect(url, survivor.permanent ? 301 : 307);
  }
  // A folded investor's old id is a spelling of the same firm, so it moves for good.
  const firm = entity.kind === "investors" ? await investorRedirect(await db(), entity.id).catch(() => null) : null;
  if (firm) {
    url.pathname = investorHref(firm);
    return NextResponse.redirect(url, 301);
  }
  url.pathname = `${MISSING_PREFIX}${request.nextUrl.pathname}`;
  return NextResponse.rewrite(url);
}

/** An old request link moves for good to the company address the request lives at; an unknown id is a real 404. */
async function redirectCompanyRequest(request: NextRequest): Promise<NextResponse> {
  const id = /^\/requests\/([^/]+)\/?$/.exec(request.nextUrl.pathname)?.[1];
  const url = request.nextUrl.clone();
  url.search = "";
  if (process.env.COMPANY_REQUESTS === "1" && id && /^[0-9a-f-]{36}$/.test(id)) {
    const [row] = await (await db())
      .select({ domain: schema.companyRequests.domain, status: schema.companyRequests.status, companyId: schema.companyRequests.companyId })
      .from(schema.companyRequests)
      .where(eq(schema.companyRequests.id, id))
      .limit(1);
    if (row) {
      url.pathname = requestCompanyPath(row);
      return NextResponse.redirect(url, 308);
    }
  }
  url.pathname = `${MISSING_PREFIX}${request.nextUrl.pathname}`;
  return NextResponse.rewrite(url);
}

/**
 * The request through; rewritten to the page `/` stands for (the URL stays as typed); or, for a
 * private instance's `/`, redirected to /overview. The query string rides along either way.
 */
function pass(request: NextRequest, mode: { demo: boolean; landing: boolean }): NextResponse {
  const { pathname } = request.nextUrl;
  // Investor URLs handed out before hyphen slugs ("/investors/sequoia%20capital%20india") move for good.
  const moved = legacyInvestorPath(pathname);
  if (moved) {
    const url = request.nextUrl.clone();
    url.pathname = moved;
    return NextResponse.redirect(url, 308);
  }
  const redirect = homeRedirect(pathname, mode);
  const target = redirect ?? frontDoor(pathname, mode);
  if (!target) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = target;
  return redirect ? NextResponse.redirect(url, 307) : NextResponse.rewrite(url);
}

/** The password gate and the front door: every decision the proxy makes without the store. Synchronous, so the tests read it directly. */
export function gate(request: NextRequest): Response {
  const mode = { demo: isPublicDemo(), landing: isLanding() };
  // In a demo only the admin paths are gated; on a private instance every matched path is.
  if (mode.demo && !isAdminPath(request.nextUrl.pathname)) return pass(request, mode);
  const refused = adminRefusal(request.headers.get("authorization"));
  if (refused) return refused;
  return pass(request, mode);
}

/** The gate, plus the store check on a demo visitor's entity page, the one request that waits on the database. */
export function proxy(request: NextRequest): Response | Promise<Response> {
  const mode = { demo: isPublicDemo(), landing: isLanding() };
  if (/^\/requests\//.test(request.nextUrl.pathname)) {
    const refused = mode.demo ? null : adminRefusal(request.headers.get("authorization"));
    return refused ?? redirectCompanyRequest(request);
  }
  const entity = mode.demo && !isAdminPath(request.nextUrl.pathname) ? entityToCheck(request) : null;
  return entity ? checkedEntity(request, entity, mode) : gate(request);
}

export const config = {
  matcher: [
    /*
     * Match every request path except the ones starting with:
     * - api/webhooks, api/cron, api/mcp, api/digest (carry their own secrets; a digest's unsubscribe link is signed)
     * - feeds (per-token), .well-known (the workflow runtime)
     * - ingest (the product analytics rewrite in next.config.ts, which carries no app data)
     * - _next, brand (static assets), icon.svg, opengraph-image, favicon.ico (metadata files)
     */
    "/((?!api/webhooks|api/cron|api/mcp|api/digest|feeds|ingest/|\\.well-known|_next|brand|icon\\.svg|opengraph-image|favicon\\.ico).*)",
  ],
};
