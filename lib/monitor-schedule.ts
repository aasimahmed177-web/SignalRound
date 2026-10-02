// Firecrawl keeps a monitor's schedule from the moment it was created, so a coverage change would
// otherwise leave every live monitor on the old cadence. Saving the rung reschedules them here.

import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import type { Firecrawl } from "firecrawl";
import { loadPreset } from "./presets.ts";

/** Puts every stored preset monitor on `schedule` in its preset's timezone; returns how many moved. */
export async function rescheduleMonitors(handle: Db, client: Pick<Firecrawl, "updateMonitor">, schedule: string): Promise<number> {
  const rows = await handle.select().from(schema.presetMonitors);
  for (const row of rows) {
    const preset = await loadPreset(row.presetSlug, handle);
    await client.updateMonitor(row.monitorId, { schedule: { text: schedule, timezone: preset.monitor.timezone } });
  }
  return rows.length;
}
