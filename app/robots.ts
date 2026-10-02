import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/origin";

/**
 * Crawl the public pages; skip the admin paths (password-gated or 404 on the demo), the API, the
 * per-token feeds and Slack manage pages, and what is noise to an index: /runs (sweep bookkeeping)
 * and the workflow runtime. The OpenAPI spec stays readable, since agents discover the API through it.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/api/v1/openapi.json", "/api/logo/"],
        disallow: ["/api/", "/feeds/", "/slack/manage/", "/presets", "/review", "/settings", "/runs", "/.well-known/workflow/"],
      },
    ],
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
