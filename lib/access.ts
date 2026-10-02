// The two viewer tiers. Outside PUBLIC_DEMO nothing changes: `demo` is false and the dashboard
// password gates everything as before. In demo mode a visitor (no password) reads the feed, the
// news, the runs, the API, and the public feeds. Operator writes and Deep dive are admin only;
// COMPANY_REQUESTS=1 separately permits capped public research. `admin` is a request that carried
// DASHBOARD_PASSWORD, and only an admin sees the write controls.

import { headers } from "next/headers";
import { BASIC_CHALLENGE, basicAuthorized, dashboardPassword } from "@/lib/dashboard-auth";

/** The deployment hosts a public demo when PUBLIC_DEMO=1. */
export function isPublicDemo(): boolean {
  return process.env.PUBLIC_DEMO === "1";
}

/**
 * LANDING=1 makes `/` the product's landing page (app/(marketing)/home) instead of the dashboard's
 * front door. The hosted fireround.dev sets it beside PUBLIC_DEMO; a clone leaves it unset and `/`
 * opens the Overview (or the feed, in demo mode). The page always answers at LANDING_PATH too, so
 * it can be previewed on any instance.
 */
export function isLanding(): boolean {
  return process.env.LANDING === "1";
}

/** Where the landing page lives; with LANDING=1 the proxy serves it at `/` as well. */
export const LANDING_PATH = "/home";

/**
 * What `/` renders when it is not the Overview: the landing page when LANDING is on (it wins over
 * demo mode, whose feed then stays at /feed), the feed in demo mode, otherwise null and homeRedirect
 * sends the request to /overview. Pure, so the proxy and its tests read one table.
 */
export function frontDoor(pathname: string, mode: { demo: boolean; landing: boolean }): string | null {
  if (pathname !== "/") return null;
  if (mode.landing) return LANDING_PATH;
  if (mode.demo) return "/feed";
  return null;
}

/** Overview's own address; every viewer reaches it here, whatever `/` serves. */
export const OVERVIEW_PATH = "/overview";

/**
 * Where `/` redirects when frontDoor leaves it alone: a private instance (neither LANDING nor
 * PUBLIC_DEMO) opens on Overview at its own address, so the nav, the canonical, and a shared link
 * all name one URL. A temporary redirect, since setting LANDING later gives `/` back to the landing
 * page. Null for every other path and mode. Pure, beside frontDoor, for the same reason.
 */
export function homeRedirect(pathname: string, mode: { demo: boolean; landing: boolean }): string | null {
  return pathname === "/" && frontDoor(pathname, mode) === null ? OVERVIEW_PATH : null;
}

export interface Viewer {
  /** The instance is a public demo. */
  demo: boolean;
  /** The request carried the dashboard password; only reachable when one is configured. */
  admin: boolean;
}

/** Pure, testable. `admin` means a password is configured and `authorization` carries it. */
export function viewerFrom(authorization: string | null): Viewer {
  const password = dashboardPassword();
  return { demo: isPublicDemo(), admin: password !== null && basicAuthorized(authorization, password) };
}

/** The request's viewer, server-side: the authorization header is what the proxy checked. */
export async function viewer(): Promise<Viewer> {
  return viewerFrom((await headers()).get("authorization"));
}

/**
 * Whether the viewer may read rows the feed does not list (review and rejected): an admin, or
 * anyone on a private instance, where the proxy's password already gated the request. A demo
 * visitor reads what the feed publishes (publish and flagged) and nothing else.
 */
export function seesReview(v: Viewer): boolean {
  return !v.demo || v.admin;
}

/**
 * Whether the viewer sees what the instance spends: credits per run, estimates, the coverage rung.
 * The same tiers as seesReview. A demo runs on the operator's key, so its spend is the operator's
 * business, not the visitor's; on a private instance the viewer is the operator.
 */
export function seesSpend(v: Viewer): boolean {
  return !v.demo || v.admin;
}

/** Paths that stay behind the password in demo mode; lib/nav.ts hides the same entries for visitors. */
export const ADMIN_PATHS = ["/review", "/presets", "/settings"] as const;

/**
 * Route handlers that change configuration (the admin Add to Slack creates a delivery target): admin
 * in demo mode too. The public install (/api/slack/connect and /api/slack/connected) is the one
 * deliberate exception under /api/slack: it creates a subscription for the visitor's own channel
 * and nothing else, so it is listed by what stays gated, not by prefix.
 */
export const ADMIN_API_PATHS = ["/api/slack/install", "/api/slack/oauth"] as const;

export function isAdminPath(pathname: string): boolean {
  return [...ADMIN_PATHS, ...ADMIN_API_PATHS].some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * The answer an admin-only request gets when it may not pass, or null when it may. A password-less
 * demo has no admin tier, so it is a 404 (never a Basic challenge a browser would pop); otherwise a
 * configured password must be sent. The proxy and the admin route handlers share it, so a route
 * that slips out of the matcher still refuses on its own.
 */
export function adminRefusal(authorization: string | null): Response | null {
  const password = dashboardPassword();
  if (password === null) return isPublicDemo() ? new Response("Not Found", { status: 404 }) : null;
  if (basicAuthorized(authorization, password)) return null;
  return new Response("Unauthorized", { status: 401, headers: BASIC_CHALLENGE });
}

/**
 * Whether MCP callers are trusted with writes and review rows. With MCP_API_KEY set every caller
 * carried the key; a private instance without a dashboard password is deliberately open. A public demo with
 * no key serves the tools to anyone, so it drops mark_seen (one call would clear the unread set
 * for everybody) and reads only what the feed publishes, as /api/v1 does for a visitor.
 */
export function mcpTrusted(): boolean {
  return Boolean(process.env.MCP_API_KEY) || (!isPublicDemo() && dashboardPassword() === null);
}
