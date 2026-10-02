import { headers } from "next/headers";
import { isPublicDemo } from "@/lib/access";
import { basicAuthorized, dashboardPassword } from "@/lib/dashboard-auth";

/** The header check, injectable so the pure part is testable without a request context. */
export function requireDashboardWith(authorization: string | null): void {
  const password = dashboardPassword();
  // A public demo with no password has no admin tier: every admin action is refused outright.
  if (password === null && isPublicDemo()) throw new Error("This is a read-only demo.");
  if (password === null) return;
  if (!basicAuthorized(authorization, password)) throw new Error("Unauthorized: the dashboard password was not sent.");
}

/**
 * Throws unless the request carried the dashboard password (or none is configured). Every
 * action that spends credits or changes configuration calls this first, whatever the proxy
 * matched: a server function is a POST to the page that uses it, and a matcher change or a
 * move to another route could quietly lift it out of coverage.
 */
export async function requireDashboard(): Promise<void> {
  requireDashboardWith((await headers()).get("authorization"));
}

/**
 * The visitor tier: passes outright in a public demo, otherwise the same check as
 * requireDashboardWith. Reads only (the command palette's search): anything that writes a row or
 * spends a credit calls requireDashboard, so a password-less demo refuses it and a demo with a
 * password asks for it.
 */
export function requireVisitorOrDashboardWith(authorization: string | null): void {
  if (isPublicDemo()) return;
  requireDashboardWith(authorization);
}

export async function requireVisitorOrDashboard(): Promise<void> {
  requireVisitorOrDashboardWith((await headers()).get("authorization"));
}
