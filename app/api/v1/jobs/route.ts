import { driverFor } from "@fireround/core/db";
import { ZodError } from "zod";
import { db } from "@/lib/db";
import { JOB_STATUSES, type JobStatus, listJobs, PartialJobBatchError, parseJobInput, publicJob, upsertJobs } from "@/lib/jobs";
import { tokenEquals } from "@/lib/tokens";

const BATCH_MAX = 200;

/** Jobs are private to this instance: reads and writes both need the ingest key. */
function refusal(request: Request): Response | null {
  const key = process.env.SIGNAL_INGEST_KEY;
  if (!key) return Response.json({ error: "SIGNAL_INGEST_KEY is not configured" }, { status: 503 });
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (tokenEquals(bearer, key)) return null;
  return Response.json({ error: "A valid bearer token is required" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
}

/** GET /api/v1/jobs?q=engineer&status=open&source=greenhouse&funded=1&limit=100 */
export async function GET(request: Request): Promise<Response> {
  const refused = refusal(request);
  if (refused) return refused;
  const p = new URL(request.url).searchParams;
  const status = p.get("status") ?? "open";
  if (!JOB_STATUSES.includes(status as JobStatus)) return Response.json({ error: "status must be open or closed" }, { status: 400 });
  const limit = Number(p.get("limit") ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return Response.json({ error: "limit must be 1-500" }, { status: 400 });
  const listing = await listJobs(await db(), {
    status: status as JobStatus,
    q: p.get("q")?.slice(0, 120) ?? undefined,
    source: p.get("source") ?? undefined,
    funded: p.get("funded") === "1" || p.get("funded") === "true",
    limit,
  });
  return Response.json({
    data: listing.rows.map((row) => ({ ...publicJob(row), funding: row.funding })),
    counts: listing.counts,
    sources: listing.sources,
  });
}

/** POST one posting, an array, or { data: [...] } from any worker (Reddit, X, a custom crawler). */
export async function POST(request: Request): Promise<Response> {
  const refused = refusal(request);
  if (refused) return refused;
  try {
    const body: unknown = await request.json();
    const inputs = Array.isArray(body)
      ? body
      : body && typeof body === "object" && "data" in body
        ? (body as { data: unknown }).data
        : [body];
    if (!Array.isArray(inputs) || inputs.length === 0) return Response.json({ error: "At least one job is required" }, { status: 400 });
    if (inputs.length > BATCH_MAX) return Response.json({ error: `A batch may contain at most ${BATCH_MAX} jobs` }, { status: 413 });
    const parsed = inputs.map(parseJobInput);
    const handle = await db();
    // One transaction: a failing row stores nothing, so a retry of the whole batch is safe. Neon's HTTP driver has
    // no transactions; there a failure reports the rows that did land.
    const url = process.env.DATABASE_URL;
    const rows = await upsertJobs(handle, parsed, { transaction: !(url && driverFor(url) === "neon") });
    return Response.json({ data: rows.map(publicJob) }, { status: 201 });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
    if (error instanceof ZodError)
      return Response.json(
        { error: "Invalid job", issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
        { status: 400 },
      );
    if (error instanceof PartialJobBatchError) {
      console.error("job ingest failed part-way", error.reason);
      return Response.json(
        { error: "Job batch stopped part-way", stored: error.stored.map((row) => row.id), stored_count: error.stored.length },
        { status: 500 },
      );
    }
    console.error("job ingest failed", error);
    return Response.json({ error: "Job could not be stored" }, { status: 500 });
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { allow: "GET, POST, OPTIONS" } });
}
