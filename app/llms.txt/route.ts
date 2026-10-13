// GET /llms.txt: what the site is, how to read its records, and where the pages, the API, and the
// MCP server are, for agents and answer engines (lib/llms.ts). Built from the environment alone, so
// it is prerendered with the build.

import { feedAlternateTypes } from "@/lib/feed-discovery";
import { llmsTxt } from "@/lib/llms";
import { canonicalBase, siteOrigin } from "@/lib/origin";

export function GET() {
  return new Response(llmsTxt(canonicalBase(), siteOrigin(), feedAlternateTypes()), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
