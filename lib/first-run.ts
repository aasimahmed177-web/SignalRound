import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { sql } from "drizzle-orm";
import { estimateSweep } from "@/lib/coverage";
import { db } from "@/lib/db";
import { listPresets } from "@/lib/presets";
import { getCoverage } from "@/lib/settings";

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
  const est = await db()
    .then(getCoverage)
    .then((plan) => (preset ? estimateSweep(preset, plan) : null))
    .catch(() => null);
  const key = process.env.FIRECRAWL_API_KEY;
  return {
    hasKey: Boolean(key && key !== "fc-YOUR-API-KEY"),
    presetSlug: slug,
    presetName: preset?.name ?? "Series A and B",
    estimate: est ? `${est.creditsLow} to ${est.creditsHigh} credits` : "a few hundred credits",
  };
}
