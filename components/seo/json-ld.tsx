import { jsonLdHtml } from "@/lib/seo";

/**
 * Structured data for search engines and AI crawlers. A plain <script>, not next/script: it is data,
 * not code, and must be in the HTML a crawler fetches rather than injected after hydration.
 */
export function JsonLd({ data }: { data: unknown }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: jsonLdHtml escapes `<`, so the payload cannot close the tag.
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(data) }} />;
}
