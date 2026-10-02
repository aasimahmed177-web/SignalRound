import { canonicalUrl } from "@fireround/core";
import { CHECK_CAP, DISCOVERY_CAP, discoveryDue, HISTORY_CAP, MONITORED_COMPANIES, sectionDue } from "@fireround/core/company-newsrooms";
import { schema } from "@fireround/core/db";
import { and, eq } from "drizzle-orm";
import { start } from "workflow/api";
import { checkCompanySection, companyNewsroomTargets, discoverCompany } from "@/lib/company-newsrooms";
import { db } from "@/lib/db";
import { getFirecrawl } from "@/lib/firecrawl";
import { recordRun } from "@/lib/persist";
import { startCompanyTimelinesStep } from "@/workflows/history";
import { ingestCandidate } from "@/workflows/ingest-candidate";

export interface CompanyNewsroomSummary {
  discovered: number;
  sections: number;
  mapped: number;
  newPages: number;
  monitors: number;
  history: number;
}

async function checkSectionStep(companyId: string, section: string, origin: string): Promise<{ mapped: number; newPages: number }> {
  "use step";
  const result = await checkCompanySection(await db(), getFirecrawl(), companyId, section);
  for (const url of result.urls) await start(ingestCandidate, [`company:${companyId}`, url, "series-a-b", origin]);
  return { mapped: result.mapped, newPages: result.urls.length };
}

/** A scrape monitor reports a changed section, not an article. Its URL is checked against our ledger before mapping. */
export async function companyNewsroomAlert(companyId: string, monitorId: string, section: string, origin: string): Promise<void> {
  "use workflow";
  const owned = await ownedSectionStep(companyId, monitorId, section);
  if (owned) await checkSectionStep(companyId, owned, origin);
}

async function ownedSectionStep(companyId: string, monitorId: string, section: string): Promise<string | null> {
  "use step";
  const handle = await db();
  const [owned] = await handle
    .select({ url: schema.companyNewsrooms.url })
    .from(schema.companyNewsrooms)
    .where(and(eq(schema.companyNewsrooms.companyId, companyId), eq(schema.companyNewsrooms.monitorId, monitorId)))
    .limit(1);
  return owned && canonicalUrl(owned.url) === canonicalUrl(section) ? owned.url : null;
}

async function ensureMonitorStep(companyId: string, section: string, name: string, origin: string): Promise<boolean> {
  "use step";
  if (process.env.NODE_ENV === "production" && !process.env.FIRECRAWL_WEBHOOK_SECRET && !process.env.WEBHOOK_BEARER_TOKEN) return false;
  if (!/^https:\/\//.test(origin)) return false;
  const handle = await db();
  const [row] = await handle
    .select()
    .from(schema.companyNewsrooms)
    .where(and(eq(schema.companyNewsrooms.companyId, companyId), eq(schema.companyNewsrooms.url, section)))
    .limit(1);
  if (!row || row.monitorId) return false;
  const monitor = await getFirecrawl().createMonitor({
    name: `${name} newsroom`,
    schedule: { text: "every day", timezone: "UTC" },
    targets: [{ type: "scrape", urls: [section], scrapeOptions: { formats: ["markdown", "changeTracking"], maxAge: 0 } }],
    webhook: {
      url: `${origin}/api/webhooks/firecrawl`,
      events: ["monitor.page"],
      metadata: { companyId, lane: "company-newsroom" },
      ...(process.env.WEBHOOK_BEARER_TOKEN ? { headers: { Authorization: `Bearer ${process.env.WEBHOOK_BEARER_TOKEN}` } } : {}),
    },
    retentionDays: 30,
  });
  const [updated] = await handle
    .update(schema.companyNewsrooms)
    .set({ monitorId: monitor.id })
    .where(and(eq(schema.companyNewsrooms.companyId, companyId), eq(schema.companyNewsrooms.url, section)))
    .returning({ monitorId: schema.companyNewsrooms.monitorId });
  return !!updated;
}

async function discoverStep(companyId: string): Promise<number> {
  "use step";
  const handle = await db();
  const target = (await companyNewsroomTargets(handle)).find((c) => c.id === companyId);
  return target ? discoverCompany(handle, getFirecrawl(), target) : 0;
}

async function targetsStep() {
  "use step";
  return companyNewsroomTargets(await db());
}

async function recordStep(runId: string, startedAt: string, summary: CompanyNewsroomSummary): Promise<void> {
  "use step";
  await recordRun(await db(), {
    id: runId,
    lane: "company-newsrooms",
    presetSlug: "company-newsrooms",
    window: null,
    startedAt: new Date(startedAt),
    finishedAt: new Date(),
    creditsEstimated: null,
    creditsMeasured: null,
    counts: { ...summary },
  });
}

/** Daily bounded pass: discovery, weekly or monthly map diffs, and the slow company timeline cycle. */
export async function companyNewsroomsWorkflow(origin: string, runId: string): Promise<CompanyNewsroomSummary> {
  "use workflow";
  const startedAt = new Date().toISOString();
  const now = new Date(startedAt);
  const targets = await targetsStep();
  const summary: CompanyNewsroomSummary = { discovered: 0, sections: 0, mapped: 0, newPages: 0, monitors: 0, history: 0 };
  for (const target of targets.filter((t) => discoveryDue(t, now)).slice(0, DISCOVERY_CAP)) {
    summary.discovered++;
    summary.sections += await discoverStep(target.id);
  }
  const refreshed = summary.discovered ? await targetsStep() : targets;
  const due = refreshed.flatMap((t) => t.sections.filter((s) => sectionDue(t, s, now)).map((s) => ({ target: t, section: s })));
  for (const { target, section } of due.slice(0, CHECK_CAP)) {
    try {
      const r = await checkSectionStep(target.id, section.url, origin);
      summary.mapped += r.mapped;
      summary.newPages += r.newPages;
    } catch {
      // A failed map stays due: checkedAt only advances after a successful map.
    }
  }
  for (const target of refreshed.filter((t) => t.monitor).slice(0, MONITORED_COMPANIES)) {
    const section = target.sections.find((s) => !s.monitorId);
    if (!section) continue;
    try {
      if (await ensureMonitorStep(target.id, section.url, target.name, origin)) summary.monitors++;
    } catch {
      // A failed monitor setup stays due on the next daily run.
    }
  }
  summary.history = await startCompanyTimelinesStep(
    refreshed.map((t) => t.id),
    HISTORY_CAP,
  );
  await recordStep(runId, startedAt, summary);
  return summary;
}
