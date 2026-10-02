// Lane 3: the always-on version. A web-scale monitor runs the preset's queries
// on a schedule inside Firecrawl, dedupes by URL against everything it has seen,
// and has a judge score each new result against the goal. Alerts arrive as
// `monitor.page` webhooks; the app structures them with extractRounds.
// https://docs.firecrawl.dev/features/monitoring-web-scale

import type { Firecrawl, Monitor, MonitorCheck } from "firecrawl";
import type { Preset } from "../presets/types.ts";

export interface CreateMonitorOptions {
  /** Where Firecrawl posts monitor.page and monitor.check.completed events. */
  webhookUrl?: string;
  /** Sent with every webhook; use it to authenticate the caller (Bearer) on top of the signature. */
  webhookHeaders?: Record<string, string>;
  /** Echoed in every payload; carry the preset slug for correlation. */
  metadata?: Record<string, string>;
  email?: string;
  retentionDays?: number;
  /** Natural-language schedule text in place of the preset's own; the coverage rung sets it. */
  schedule?: string;
}

export async function createPresetMonitor(client: Firecrawl, preset: Preset, opts: CreateMonitorOptions = {}): Promise<Monitor> {
  return client.createMonitor({
    name: `${preset.name} (funding feed)`,
    schedule: { text: opts.schedule ?? preset.monitor.schedule, timezone: preset.monitor.timezone },
    goal: preset.goal,
    targets: [
      {
        type: "search",
        queries: preset.queries,
        searchWindow: preset.monitor.searchWindow,
        maxResults: preset.monitor.maxResults,
        ...(preset.excludeDomains.length ? { excludeDomains: preset.excludeDomains } : {}),
        ...(preset.includeDomains.length ? { includeDomains: preset.includeDomains } : {}),
      },
    ],
    ...(opts.webhookUrl
      ? {
          webhook: {
            url: opts.webhookUrl,
            headers: opts.webhookHeaders,
            metadata: { preset: preset.slug, ...opts.metadata },
            events: ["monitor.page", "monitor.check.completed"],
          },
        }
      : {}),
    ...(opts.email ? { notification: { email: { enabled: true, recipients: [opts.email], includeDiffs: true } } } : {}),
    retentionDays: opts.retentionDays ?? 90,
  });
}

/** Trigger a check now and wait for it. Returns 409 server-side if one is already running. */
export async function runMonitorNow(client: Firecrawl, monitorId: string, pollMs = 5_000): Promise<MonitorCheck> {
  const started = await client.runMonitor(monitorId);
  for (;;) {
    const check = await client.getMonitorCheck(monitorId, started.id, { limit: 1 });
    if (!["queued", "running"].includes(check.status)) return check;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
