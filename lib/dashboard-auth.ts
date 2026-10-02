import { tokenEquals } from "@/lib/tokens";

/** The password that gates the dashboard and the read API; unset means open (a laptop, or a host with its own protection in front). */
export function dashboardPassword(): string | null {
  return process.env.DASHBOARD_PASSWORD || null;
}

export const BASIC_CHALLENGE = { "www-authenticate": 'Basic realm="Fireround", charset="UTF-8"' };

/**
 * True when `authorization` carries Basic credentials whose password is `expected`, any
 * username. The split is on the first colon (a password may itself contain colons) and the
 * compare is constant-time on the password.
 */
export function basicAuthorized(authorization: string | null | undefined, expected: string): boolean {
  if (!authorization) return false;
  const space = authorization.indexOf(" ");
  const scheme = space < 0 ? authorization : authorization.slice(0, space);
  const credentials = space < 0 ? "" : authorization.slice(space + 1).trim();
  if (scheme.toLowerCase() !== "basic" || !/^[A-Za-z0-9+/]+={0,2}$/.test(credentials)) return false;
  const decoded = Buffer.from(credentials, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  return tokenEquals(decoded.slice(colon + 1), expected);
}
