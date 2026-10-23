import { schema } from "@fireround/core/db";
import { and, eq } from "drizzle-orm";
import { start } from "workflow/api";
import { db } from "@/lib/db";
import { getWebClient } from "@/lib/web-client";
import { ingestCandidate } from "@/workflows/ingest-candidate";

export async function nativeMonitorsWorkflow(origin: string): Promise<void> {
  "use workflow";
  const monitors = await monitorList();
  for (const monitor of monitors) {
    try {
      await checkMonitor(monitor, origin);
    } catch (error) {
      await recordFailure(monitor, error instanceof Error ? error.message : String(error));
    }
  }
}

async function recordFailure(monitor: { monitorId: string; presetSlug: string }, error: string) {
  "use step";
  await (await db()).insert(schema.runs).values({
    id: `monitor-error:${monitor.monitorId}:${Date.now()}`,
    presetSlug: monitor.presetSlug,
    lane: "monitor",
    window: "scheduled",
    startedAt: new Date(),
    finishedAt: new Date(),
    counts: { errors: 1 },
    creditsEstimated: 0,
  });
  console.error(`Native monitor ${monitor.monitorId} failed: ${error}`);
}

async function monitorList() {
  "use step";
  return (await (await db()).select().from(schema.presetMonitors)).filter((monitor) => monitor.monitorId.startsWith("native-monitor:"));
}

async function checkMonitor(monitor: { monitorId: string; presetSlug: string }, origin: string) {
  "use step";
  const handle = await db();
  const client = getWebClient();
  const check = await client.runMonitor(monitor.monitorId);
  const detail = await client.getMonitorCheck(monitor.monitorId, check.id, { limit: 100 });
  if (detail.status !== "completed") throw new Error(detail.error ?? `Monitor check ${detail.status}`);
  await handle
    .insert(schema.runs)
    .values({
      id: `check:${check.id}`,
      presetSlug: monitor.presetSlug,
      lane: "monitor",
      window: "scheduled",
      startedAt: new Date(),
      finishedAt: new Date(),
      creditsEstimated: 0,
      creditsMeasured: 0,
      counts: { search_results: detail.summary.totalPages, alerted: detail.pages?.filter((page) => page.status === "new").length ?? 0 },
    })
    .onConflictDoNothing();
  for (const page of detail.pages ?? []) {
    // Retry incomplete candidate ingestion too: URL-new is not an ingestion acknowledgement.
    const inserted = await handle
      .insert(schema.candidates)
      .values({ monitorId: monitor.monitorId, url: page.url, checkId: check.id })
      .onConflictDoNothing()
      .returning({ url: schema.candidates.url });
    const [candidate] = await handle
      .select()
      .from(schema.candidates)
      .where(and(eq(schema.candidates.monitorId, monitor.monitorId), eq(schema.candidates.url, page.url)))
      .limit(1);
    if (inserted.length || candidate?.status === "pending")
      await start(ingestCandidate, [monitor.monitorId, page.url, monitor.presetSlug, origin, check.id]);
  }
}
