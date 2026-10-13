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

/**
 * Where a search engine should keep a page: SITE_URL when set, else siteOrigin(). SITE_URL may carry
 * a path (https://www.example.com/funding) when another site serves these pages under its own
 * address; every canonical tag, og:url, sitemap entry, and JSON-LD page URL is built on it, while
 * the API, the MCP server, and the social images stay on this deployment. No trailing slash.
 */
export function canonicalBase(): string {
  const configured = process.env.SITE_URL?.trim();
  return configured ? configured.replace(/\/+$/, "") : siteOrigin();
}

/** The absolute canonical URL of a page path ("/companies/ramp"). */
export function canonicalUrl(path: string): string {
  return `${canonicalBase()}${path}`;
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
