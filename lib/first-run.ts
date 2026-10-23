import { reconcileProviderFor } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { sql } from "drizzle-orm";
import { listPresets } from "@/lib/presets";

export interface FirstRunProps {
  hasKey: boolean;
  presetSlug: string;
  presetName: string;
  estimate: string;
}

/** Whether the store holds any round at all (rejected ones included: a store someone has worked on is not new). */
export async function storeIsEmpty(handle: Db): Promise<boolean> {
  const [row] = await handle.select({ n: sql<number>`count(*)::int` }).from(schema.fundingRounds);
  return (row?.n ?? 0) === 0;
}

/** The first-run panel's props: the default preset and its rate-card estimate for one week. */
export async function firstRunProps(): Promise<FirstRunProps> {
  const presets = await listPresets();
  const preset = presets.find((p) => p.slug === "series-a-b") ?? presets[0];
  const slug = preset?.slug ?? "series-a-b";
  return {
    hasKey: reconcileProviderFor() !== null,
    presetSlug: slug,
    presetName: preset?.name ?? "Series A and B",
    estimate: "no scraping credits; configured model usage is billed by its provider",
  };
}
