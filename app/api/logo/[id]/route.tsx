// GET /api/logo/<id>: a logo as a 128px PNG tile, always. Two readers use it:
//
// - Slack rejects a whole message when one of its images cannot be downloaded, and many stored logos
//   are SVG or live on hosts that refuse or time out, so Slack messages point here (the company's id).
// - Every page draws its logo tiles from here too (components/company-logo.tsx, `ui=1`), so no
//   reader's browser contacts a company's site or a favicon service, and a blank or wordmark logo is
//   caught once, on the server, instead of by a probe in every browser.
//
// `kind` picks the lookup: a company (the default) or an investor by id, or a host (a publisher on
// /news) by its domain alone. The logo is fetched and drawn by the same code as the share cards (the
// favicon first, then the stored logo, minus white and wordmark files); with neither, the initial
// draws on a tile. Public like the pages it belongs to.

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { ImageResponse } from "next/og";
import { db } from "@/lib/db";
import { hostLabel } from "@/lib/format";
import { decodeParam } from "@/lib/links";
import { initialOf, investorInitials } from "@/lib/logo";
import { LogoTile, loadFonts, loadLogo } from "@/lib/og";
import { LIMITS, limitRequest } from "@/lib/rate-limit";

const SIZE = 128;

/** A logo changes rarely; the CDN keeps a tile a day and serves it stale for a week while it redraws. */
const CACHE = "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

/** A host is a bare domain: letters, digits, dots, and hyphens, so the route never fetches anything else. */
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

async function tile(src: string | null, mark: string, ui: boolean): Promise<ArrayBuffer | null> {
  try {
    const fonts = await loadFonts();
    const res = new ImageResponse(<LogoTile src={src} mark={mark} size={SIZE} ui={ui} />, {
      width: SIZE,
      height: SIZE,
      fonts: fonts.length ? fonts : undefined,
    });
    const body = await res.arrayBuffer();
    return body.byteLength > 0 ? body : null;
  } catch {
    return null;
  }
}

/** What the tile is drawn from: the monogram's letters and where to look for a logo; null when the id names nothing. */
async function subject(kind: string, id: string): Promise<{ mark: string; domain: string | null; logoUrl: string | null } | null> {
  if (kind === "host") {
    const host = id
      .trim()
      .toLowerCase()
      .replace(/^www\./, "");
    return HOST.test(host) ? { mark: initialOf(hostLabel(host)), domain: host, logoUrl: null } : null;
  }
  const handle = await db();
  if (kind === "request") {
    // A request's homepage branding, only while research runs: a refused or failed request has no face.
    if (process.env.COMPANY_REQUESTS !== "1" || !/^[0-9a-f-]{36}$/.test(id)) return null;
    const [request] = await handle
      .select({ domain: schema.companyRequests.domain, status: schema.companyRequests.status, brand: schema.companyRequests.brand })
      .from(schema.companyRequests)
      .where(eq(schema.companyRequests.id, id))
      .limit(1);
    if (!request || request.status === "refused" || request.status === "failed") return null;
    return { mark: initialOf(request.brand?.name ?? request.domain), domain: request.domain, logoUrl: request.brand?.logo ?? null };
  }
  if (kind === "investor") {
    const [investor] = await handle
      .select({ name: schema.investors.name, domain: schema.investors.domain, logoUrl: schema.investors.logoUrl })
      .from(schema.investors)
      .where(eq(schema.investors.id, id))
      .limit(1);
    return investor ? { mark: investorInitials(investor.name), domain: investor.domain, logoUrl: investor.logoUrl } : null;
  }
  const [company] = await handle
    .select({ name: schema.companies.name, domain: schema.companies.domain, logoUrl: schema.companies.logoUrl })
    .from(schema.companies)
    .where(eq(schema.companies.id, id))
    .limit(1);
  return company ? { mark: initialOf(company.name), domain: company.domain, logoUrl: company.logoUrl } : null;
}

/** The query a tile may carry (lib/logo.ts logoSrc): anything else is a cache-buster, refused before any work. */
const KINDS = new Set(["company", "investor", "host", "request"]);

function wellFormed(params: URLSearchParams): boolean {
  for (const [key, value] of params) {
    if (key === "kind" ? !KINDS.has(value) : key === "ui" ? value !== "1" : true) return false;
  }
  return true;
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = decodeParam((await ctx.params).id);
  const params = new URL(request.url).searchParams;
  if (!wellFormed(params) || id.length > 253) return new Response("Not Found", { status: 404 });
  const limited = await limitRequest(request, LIMITS.logo);
  if (limited) return limited;
  const ui = params.get("ui") === "1";
  const found = await subject(params.get("kind") ?? "company", id);
  if (!found) return new Response("Not Found", { status: 404 });

  const logo = await loadLogo({ domain: found.domain, logoUrl: found.logoUrl });
  // A logo the renderer cannot decode falls back to the initial, so the answer is always a PNG.
  const body = (logo ? await tile(logo, found.mark, ui) : null) ?? (await tile(null, found.mark, ui));
  if (!body) return new Response("Logo unavailable", { status: 500, headers: { "cache-control": "no-store" } });
  return new Response(body, { headers: { "content-type": "image/png", "cache-control": CACHE } });
}
