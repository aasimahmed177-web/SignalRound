import { checkBotId } from "botid/server";
import { seesReview, viewerFrom } from "@/lib/access";
import { companyPath, limitMessage, requestPath, submitCompanyRequest } from "@/lib/company-requests";
import { clientKey } from "@/lib/rate-limit";

export async function POST(request: Request): Promise<Response> {
  if (process.env.COMPANY_REQUESTS !== "1") return new Response("Not Found", { status: 404 });
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    if (!origin || !host || new URL(origin).host !== host) throw new Error("Cross-origin request");
  } catch {
    return Response.json({ error: "Cross-origin request refused." }, { status: 403 });
  }
  if (process.env.VERCEL === "1" && (await checkBotId()).isBot) {
    return Response.json({ error: "Automated requests are not accepted." }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Enter a company website." }, { status: 400 });
  }
  const url = typeof body === "object" && body !== null && "url" in body ? (body as { url: unknown }).url : null;
  if (typeof url !== "string") return Response.json({ error: "Enter a company website." }, { status: 400 });
  const insider = seesReview(viewerFrom(request.headers.get("authorization")));
  const outcome = await submitCompanyRequest(url, clientKey(request.headers), insider);
  switch (outcome.kind) {
    case "request":
      return Response.json(
        { id: outcome.id, requestUrl: requestPath(outcome.id), companyUrl: companyPath(outcome.domain) },
        { status: outcome.created ? 202 : 200 },
      );
    case "company":
      return Response.json({ companyUrl: companyPath(outcome.companyId) });
    case "limited":
      return Response.json(
        { error: limitMessage(outcome.scope, outcome.decision.retryAfter) },
        { status: 429, headers: { "retry-after": String(outcome.decision.retryAfter), "cache-control": "no-store" } },
      );
    case "refused":
      return Response.json({ error: outcome.error }, { status: outcome.status });
  }
}
