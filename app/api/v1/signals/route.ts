import { ZodError } from "zod";
import { db } from "@/lib/db";
import { ingestSignal, parseSignalInput, publicSignal } from "@/lib/signals";
import { tokenEquals } from "@/lib/tokens";

const BATCH_MAX = 100;

function refusal(request: Request): Response | null {
  const key = process.env.SIGNAL_INGEST_KEY;
  if (!key) return Response.json({ error: "SIGNAL_INGEST_KEY is not configured" }, { status: 503 });
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (tokenEquals(bearer, key)) return null;
  return Response.json(
    { error: "A valid signal-ingest bearer token is required" },
    { status: 401, headers: { "www-authenticate": "Bearer" } },
  );
}

function asBatch(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object" && "data" in body) {
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) throw new Error("data must be an array");
    return data;
  }
  return [body];
}

/** Agent Reach and any other discovery worker post one observation or a batch of up to 100. */
export async function POST(request: Request): Promise<Response> {
  const refused = refusal(request);
  if (refused) return refused;

  try {
    const inputs = asBatch(await request.json());
    if (inputs.length === 0) return Response.json({ error: "At least one signal is required" }, { status: 400 });
    if (inputs.length > BATCH_MAX) return Response.json({ error: `A batch may contain at most ${BATCH_MAX} signals` }, { status: 413 });

    // Validate the whole batch before writing any of it.
    const parsed = inputs.map(parseSignalInput);
    const handle = await db();
    const rows = [];
    for (const input of parsed) rows.push(await ingestSignal(handle, input));
    const created = rows.every((row) => row.seenCount === 1);
    return Response.json({ data: rows.map(publicSignal) }, { status: created ? 201 : 200 });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
    if (error instanceof ZodError) {
      return Response.json(
        { error: "Invalid signal", issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
        { status: 400 },
      );
    }
    if (error instanceof Error && error.message === "data must be an array")
      return Response.json({ error: error.message }, { status: 400 });
    console.error("signal ingest failed", error);
    return Response.json({ error: "Signal could not be stored" }, { status: 500 });
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { allow: "POST, OPTIONS" } });
}
