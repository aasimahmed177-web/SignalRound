// Records to the presets that keep them. A lane that reads pages any preset may care about (a
// publisher's funding section, a pasted URL, an X announcement, a stage-free search) resolves with
// every stage a preset keeps, then files each record under its preset: the lane's own when it keeps
// the round, else the first that does (packages/core/src/records/routing.ts). A round that names no
// stage goes by its amount's band. Persist and delivery run per preset, as if each had found it.

import type { FeedRecord, RoutablePreset, Stage } from "@fireround/core";
import { groupByPreset } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { enqueueDeliveries } from "./delivery.ts";
import { type PersistOptions, type PersistSummary, persistRecords } from "./persist.ts";
import { listPresets } from "./presets.ts";

/** The presets a record may be filed under, in list order, and every stage one of them keeps. */
export async function routingTable(handle: Db): Promise<{ presets: RoutablePreset[]; stages: Stage[] }> {
  const presets = (await listPresets(handle)).map((p) => ({ slug: p.slug, stages: p.stages }));
  return { presets, stages: [...new Set(presets.flatMap((p) => p.stages))] };
}

export interface RoutedSummary extends PersistSummary {
  /** The ids each preset gained or changed, for delivery on that preset's targets. */
  changedByPreset: Record<string, string[]>;
  /** Records no preset keeps (a stage no preset lists), counted and left out. */
  unrouted: number;
}

/** Persist each record under the preset that keeps it; the lane's own preset first. */
export async function persistRouted(
  handle: Db,
  records: FeedRecord[],
  home: string | null,
  runId: string,
  options: PersistOptions = {},
  presets?: RoutablePreset[],
): Promise<RoutedSummary> {
  const table = presets ?? (await routingTable(handle)).presets;
  const { groups, unrouted } = groupByPreset(records, table, home);
  const out: RoutedSummary = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    changedIds: [],
    insertedIds: [],
    persistedIds: [],
    changedByPreset: {},
    unrouted,
  };
  for (const [slug, group] of groups) {
    const s = await persistRecords(handle, group, slug, runId, options);
    out.inserted += s.inserted;
    out.updated += s.updated;
    out.unchanged += s.unchanged;
    out.changedIds.push(...s.changedIds);
    out.insertedIds.push(...s.insertedIds);
    out.persistedIds.push(...s.persistedIds);
    if (s.changedIds.length > 0) out.changedByPreset[slug] = [...(out.changedByPreset[slug] ?? []), ...s.changedIds];
  }
  return out;
}

/** Queue deliveries preset by preset, so each round reaches the targets of the preset it was filed under. */
export async function enqueueRouted(handle: Db, changedByPreset: Record<string, string[]>): Promise<number> {
  let queued = 0;
  for (const [slug, ids] of Object.entries(changedByPreset)) queued += await enqueueDeliveries(handle, ids, slug);
  return queued;
}
