import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

/**
 * The Content-Security-Policy, the "without nonces" shape from Next's CSP guide. A nonce needs every
 * page rendered per request, and the landing page and the cached shells are prerendered, so inline
 * scripts stay allowed; what the policy buys is that no script, frame, or connection can come from
 * another origin, no plugin loads, and no form posts off-site. Images are open to any https host:
 * logos come from each company's own domain and Google's favicon service. vercel.live is the
 * Vercel toolbar a team member sees; /_vercel/* (Analytics, Speed Insights) is same-origin.
 * Development adds 'unsafe-eval' (React's error stacks); upgrade-insecure-requests only on Vercel,
 * so a self-hosted clone on plain http keeps working.
 */
function contentSecurityPolicy(): string {
  const dev = process.env.NODE_ENV === "development";
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' https://vercel.live${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://vercel.live wss://ws-us3.pusher.com",
    "frame-src https://vercel.live",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (process.env.VERCEL === "1") directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

const nextConfig: NextConfig = {
  cacheComponents: true,
  transpilePackages: ["@fireround/core"],
  serverExternalPackages: ["@electric-sql/pglite"],
  // Next's dev badge covers a control in every corner (the sidebar footer, a toast's Undo, the phone
  // menu button); off, build and runtime errors still surface in the overlay.
  devIndicators: false,
  // No X-Powered-By: the framework is in the public repo, but a header advertising it helps only a scanner.
  poweredByHeader: false,
  // Baseline hardening on every response. Route handlers' own headers (feeds' cache-control, the
  // webhook's) merge with these. HSTS is ignored over plain http, so a self-hosted clone is unaffected.
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
        // A page this site opens in a new tab, or that opens it, gets no handle on the other's window.
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        { key: "Content-Security-Policy", value: contentSecurityPolicy() },
      ],
    },
  ],
};

export default withWorkflow(withBotId(nextConfig));
