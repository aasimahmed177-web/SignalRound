/**
 * The URL this instance is reached at, for links that leave it (feed URLs, the Slack redirect
 * URL): APP_ORIGIN when set, since a proxy or a preview deployment can report a host a reader
 * cannot use, else the host the request came in on. No trailing slash.
 */
export function publicOrigin(h: Headers): string {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host") || "localhost:3000";
  return `${proto}://${host}`;
}

/**
 * The origin for URLs built with no request in hand (metadataBase, the sitemap, robots.txt,
 * JSON-LD): APP_ORIGIN, else on Vercel the production domain (a production deployment) or the
 * deployment's own host (a preview), else a local dev server. One function, so a canonical tag and
 * a sitemap entry never name two hosts, and a canonical never points at a per-deployment URL. No
 * trailing slash.
 */
export function siteOrigin(): string {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const production = process.env.VERCEL_ENV === "production" ? process.env.VERCEL_PROJECT_PRODUCTION_URL : undefined;
  const host = production || process.env.VERCEL_URL;
  return host ? `https://${host}` : "http://localhost:3000";
}

/** A loopback origin: Slack can neither redirect to it over https nor fetch a feed from it. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}
