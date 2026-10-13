// GET /companies/{id}/index.md: the company page as markdown for agents (lib/llms.ts), from the same
// cached visitor view the page reads. Its Link header names the HTML page as canonical, so a search
// engine keeps one address for the company.

import { connection } from "next/server";
import { cachedCompanyView } from "@/lib/cached";
import { companyHref, decodeParam } from "@/lib/links";
import { companyMarkdown } from "@/lib/llms";
import { canonicalBase, canonicalUrl } from "@/lib/origin";

export async function GET(_request: Request, ctx: RouteContext<"/companies/[id]/index.md">) {
  await connection();
  const { id } = await ctx.params;
  const view = await cachedCompanyView(decodeParam(id));
  if (!view) return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(companyMarkdown(view.page, canonicalBase(), new Date()), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Link: `<${canonicalUrl(companyHref(view.page.company.id))}>; rel="canonical"`,
    },
  });
}
