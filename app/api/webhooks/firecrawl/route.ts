// Firecrawl monitor webhooks. Verify the HMAC, record the delivery once,
// insert the candidate once, start the workflow, answer 200 inside 10 seconds.
// https://docs.firecrawl.dev/webhooks/security

import { schema } from "@fireround/core/db";
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { z } from "zod";
import { db } from "@/lib/db";
import { verifyFirecrawlSignature } from "@/lib/firecrawl-webhook";
import { tokenEquals } from "@/lib/tokens";
import { companyNewsroomAlert } from "@/workflows/company-newsrooms";
import { ingestCandidate } from "@/workflows/ingest-candidate";

// The envelope every event shares. Extra fields pass through untouched: the delivery row keeps the whole payload.
const eventSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  data: z.array(z.record(z.string(), z.unknown())).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

// What a monitor.page entry must carry before it can become a candidate row (monitor_id and url are not null).
const pageSchema = z.looseObject({
  monitorId: z.string().min(1),
  checkId: z.string().nullish(),
  url: z.string().min(1),
  status: z.string(),
  judgment: z.object({ reason: z.string().nullish() }).nullish(),
});

/** Like the cron routes: no configured secret means open in development and closed in production. */
function authorized(request: Request, raw: string): NextResponse | null {
  const secret = process.env.FIRECRAWL_WEBHOOK_SECRET;
  const bearer = process.env.WEBHOOK_BEARER_TOKEN;
  if (!secret && process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (secret && !verifyFirecrawlSignature(raw, request.headers.get("x-firecrawl-signature"), secret)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  if (bearer && !tokenEquals(request.headers.get("authorization"), `Bearer ${bearer}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(request: Request) {
  const raw = await request.text();
  const refused = authorized(request, raw);
  if (refused) return refused;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "body is not JSON" }, { status: 400 });
  }
  const parsed = eventSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "event needs a string id, a string type, and data as a list" }, { status: 400 });
  const event = parsed.data;
  // Shape the pages before anything is written, so a malformed delivery can be retried rather than deduped away.
  const pages = event.type === "monitor.page" ? z.array(pageSchema).safeParse(event.data ?? []) : null;
  if (pages && !pages.success) {
    return NextResponse.json({ error: "monitor.page entries need monitorId, url, and status" }, { status: 400 });
  }

  const origin = process.env.APP_ORIGIN ?? new URL(request.url).origin;
  const handle = await db();
  const delivery = await handle
    .insert(schema.webhookDeliveries)
    .values({ id: event.id, type: event.type, payload: json })
    .onConflictDoNothing()
    .returning({ id: schema.webhookDeliveries.id });
  if (delivery.length === 0) return NextResponse.json({ ok: true, duplicate: true });

  if (!pages) return NextResponse.json({ ok: true, ignored: event.type });
  if (event.metadata?.lane === "company-newsroom") {
    const companyId = event.metadata.companyId;
    if (!companyId) return NextResponse.json({ error: "company monitor needs a companyId" }, { status: 400 });
    let started = 0;
    for (const page of pages.data) {
      if (page.status !== "new" && page.status !== "changed") continue;
      await start(companyNewsroomAlert, [companyId, page.monitorId, page.url, origin]);
      started++;
    }
    return NextResponse.json({ ok: true, started });
  }
  const preset = event.metadata?.preset ?? "series-a-b";
  let started = 0;
  for (const page of pages.data) {
    if (page.status !== "new") continue;
    const inserted = await handle
      .insert(schema.candidates)
      .values({ monitorId: page.monitorId, url: page.url, checkId: page.checkId, judgeReason: page.judgment?.reason ?? null })
      .onConflictDoNothing()
      .returning({ url: schema.candidates.url });
    if (inserted.length === 0) continue;
    await start(ingestCandidate, [page.monitorId, page.url, preset, origin, page.checkId ?? null]);
    started++;
  }
  return NextResponse.json({ ok: true, started });
}
