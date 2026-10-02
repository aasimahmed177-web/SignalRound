// An email digest's unsubscribe link. GET answers a one-button page, so a mail scanner that
// follows links never unsubscribes anyone; POST, from that button or a mail client's RFC 8058
// one-click, turns the email target off. The link's signature (lib/digest.ts) is the whole
// credential, so the proxy leaves this path outside the dashboard password.

import { schema } from "@fireround/core/db";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { digestUnsubscribeToken, esc } from "@/lib/digest";
import { tokenEquals } from "@/lib/tokens";

/** The target id when the link's signature holds; null for a forged link, or on an instance with no Resend key. */
function signedTarget(request: NextRequest): string | null {
  const key = process.env.RESEND_API_KEY;
  const id = request.nextUrl.searchParams.get("t");
  const sig = request.nextUrl.searchParams.get("s");
  if (!key || !id || !sig) return null;
  return tokenEquals(sig, digestUnsubscribeToken(id, key)) ? id : null;
}

function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>${esc(title)}</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:64px auto;padding:0 24px;color:#111"><h1 style="font-size:22px;font-weight:600">${esc(title)}</h1>${body}<p style="font-size:14px;color:#6b6b6b"><a href="/support" style="color:#6b6b6b">Support</a></p></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

const INVALID = () =>
  page(
    400,
    "This unsubscribe link is not valid",
    "<p>It may be incomplete, or older than the site's current key. Ask us on the support page.</p>",
  );

export function GET(request: NextRequest) {
  if (!signedTarget(request)) return INVALID();
  const action = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  return page(
    200,
    "Unsubscribe from the Fireround digest?",
    `<form method="post" action="${esc(action)}"><button type="submit" style="font-size:15px;padding:10px 18px;border-radius:10px;border:0;background:#111;color:#fff;cursor:pointer">Unsubscribe</button></form>`,
  );
}

export async function POST(request: NextRequest) {
  const id = signedTarget(request);
  if (!id) return INVALID();
  const { deliveryTargets } = schema;
  await (await db())
    .update(deliveryTargets)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(eq(deliveryTargets.id, id), eq(deliveryTargets.channel, "email")));
  return page(200, "You are unsubscribed", "<p>This address gets no more Fireround digests.</p>");
}
