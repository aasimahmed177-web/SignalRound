import { db } from "@/lib/db";
import { receiveSlackEvent, verifySlackSignature } from "@/lib/slack-events";

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.SLACK_SIGNING_SECRET?.trim();
  if (!secret) return Response.json({ error: "Slack events are not configured" }, { status: 503 });
  const body = await request.text();
  if (!verifySlackSignature(body, request.headers.get("x-slack-request-timestamp"), request.headers.get("x-slack-signature"), secret)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof payload !== "object" || payload === null) return Response.json({ error: "Invalid event" }, { status: 400 });
  if ("type" in payload && payload.type === "url_verification") {
    if (!("challenge" in payload) || typeof payload.challenge !== "string") {
      return Response.json({ error: "Invalid challenge" }, { status: 400 });
    }
    return Response.json({ challenge: payload.challenge });
  }
  try {
    await receiveSlackEvent(await db(), payload);
  } catch {
    return Response.json({ error: "Slack event processing failed" }, { status: 503 });
  }
  return Response.json({ ok: true });
}
