// Fictional sample rounds for an empty store, so the dashboard has something to show before a Firecrawl
// key or a first sweep (`pnpm demo-data`, scripts/demo-data.ts). Every company, investor, and source is
// made up; the sources point at the reserved example.com, example.org, and example.net.
import type { FeedRecord, Stage } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { eq, sql } from "drizzle-orm";
import { persistRecords, recordRun, setDisposition } from "./persist.ts";

const { fundingRounds } = schema;
const PRESET = "series-a-b";
const RUN_ID = "sample-data";
export const SAMPLE_NOTE = "sample data from pnpm demo-data";

interface Sample {
  name: string;
  stage: Stage;
  stageAsWritten: string;
  usdMillions: number | null;
  lead: string[];
  others: string[];
  sector: string;
  headquarters: string;
  daysAgo: number;
  host: "example.com" | "example.org" | "example.net";
  description: string;
}

export const SAMPLES: Sample[] = [
  {
    name: "Example Robotics",
    stage: "series_a",
    stageAsWritten: "Series A",
    usdMillions: 24,
    lead: ["Sample Ventures"],
    others: ["Placeholder Capital"],
    sector: "robotics",
    headquarters: "Pittsburgh, PA",
    daysAgo: 0,
    host: "example.com",
    description: "warehouse picking robots",
  },
  {
    name: "Example Health",
    stage: "series_b",
    stageAsWritten: "Series B",
    usdMillions: 60,
    lead: ["Demo Partners"],
    others: ["Sample Ventures", "Mock Growth Fund"],
    sector: "healthtech",
    headquarters: "Boston, MA",
    daysAgo: 1,
    host: "example.org",
    description: "remote care for chronic conditions",
  },
  {
    name: "Example Ledger",
    stage: "series_a",
    stageAsWritten: "Series A",
    usdMillions: 18,
    lead: ["Placeholder Capital"],
    others: [],
    sector: "fintech",
    headquarters: "New York, NY",
    daysAgo: 1,
    host: "example.net",
    description: "accounting automation for small businesses",
  },
  {
    name: "Example Grid",
    stage: "series_b",
    stageAsWritten: "Series B",
    usdMillions: 45,
    lead: ["Mock Growth Fund"],
    others: ["Demo Partners"],
    sector: "energy",
    headquarters: "Austin, TX",
    daysAgo: 2,
    host: "example.com",
    description: "battery storage for utilities",
  },
  {
    name: "Example Shield",
    stage: "series_a",
    stageAsWritten: "Series A",
    usdMillions: 30,
    lead: ["Sample Ventures"],
    others: ["Test Bench Capital"],
    sector: "cybersecurity",
    headquarters: "Tel Aviv, Israel",
    daysAgo: 3,
    host: "example.org",
    description: "identity security for cloud workloads",
  },
  {
    name: "Example Models",
    stage: "series_a",
    stageAsWritten: "Series A",
    usdMillions: 22,
    lead: ["Test Bench Capital"],
    others: ["Placeholder Capital"],
    sector: "ai infrastructure",
    headquarters: "San Francisco, CA",
    daysAgo: 4,
    host: "example.net",
    description: "inference serving for open models",
  },
  {
    name: "Example Freight",
    stage: "series_b",
    stageAsWritten: "Series B",
    usdMillions: 38,
    lead: ["Demo Partners"],
    others: [],
    sector: "logistics",
    headquarters: "Chicago, IL",
    daysAgo: 5,
    host: "example.com",
    description: "freight brokerage software",
  },
  {
    name: "Example Bio",
    stage: "series_a",
    stageAsWritten: "Series A",
    usdMillions: 15,
    lead: ["Mock Growth Fund"],
    others: ["Sample Ventures"],
    sector: "biotech",
    headquarters: "Cambridge, UK",
    daysAgo: 6,
    host: "example.org",
    description: "enzyme design for manufacturing",
  },
  {
    name: "Example Code",
    stage: "series_b",
    stageAsWritten: "Series B",
    usdMillions: 52,
    lead: ["Test Bench Capital"],
    others: ["Demo Partners", "Sample Ventures"],
    sector: "developer tools",
    headquarters: "Toronto, Canada",
    daysAgo: 9,
    host: "example.com",
    description: "code review for large repositories",
  },
  {
    name: "Example Pay",
    stage: "series_a",
    stageAsWritten: "Series A",
    usdMillions: null,
    lead: ["Placeholder Capital"],
    others: [],
    sector: "payments",
    headquarters: "Berlin, Germany",
    daysAgo: 6,
    host: "example.net",
    description: "payouts for marketplaces",
  },
];

function toRecord(s: Sample, now: Date): FeedRecord {
  const key = s.name.toLowerCase();
  const date = new Date(now.getTime() - s.daysAgo * 86_400_000).toISOString().slice(0, 10);
  const amount = s.usdMillions === null ? "an undisclosed amount" : `$${s.usdMillions}M`;
  const sentence = `${s.name}, a fictional company that builds ${s.description}, raised ${amount} in a ${s.stageAsWritten} led by ${s.lead.join(" and ")}.`;
  const url = `https://${s.host}/sample/${key.replace(/\s+/g, "-")}-${s.stage.replace("_", "-")}`;
  return {
    id: `${key.replace(/\s+/g, "-")}:${s.stage}:${date}`,
    company_key: key,
    company_name: s.name,
    company_domain: null,
    company_website: null,
    company_description: `Sample data (pnpm demo-data): a fictional company that builds ${s.description}.`,
    stage: s.stage,
    stage_as_written: s.stageAsWritten,
    is_extension: false,
    amount: {
      value: s.usdMillions,
      currency: s.usdMillions === null ? null : "USD",
      as_written: s.usdMillions === null ? null : amount,
      usd_millions: s.usdMillions,
      fx_rate: s.usdMillions === null ? null : 1,
      fx_date: s.usdMillions === null ? null : date,
    },
    valuation_as_written: null,
    lead_investors: s.lead,
    other_investors: s.others,
    announced_date: date,
    date_precision: "day",
    date_basis: "stated",
    verification: { status: "confirmed", notes: [SAMPLE_NOTE], url },
    headquarters: s.headquarters,
    sector: s.sector,
    evidence_quotes: [sentence],
    sources: [{ url, host: s.host, title: `${s.name} raises ${amount} (sample)`, published: date, evidence: sentence }],
    confidence: 0.9,
    status: "new",
    undated: false,
  };
}

/**
 * Write the samples into an empty store: all but the last published, the last left in Review. A store that
 * already has rounds is left alone (returns null), so samples never mix into real data.
 */
export async function seedSampleData(handle: Db, now = new Date()): Promise<{ published: number; review: number } | null> {
  const [existing] = await handle.select({ n: sql<number>`count(*)::int` }).from(fundingRounds);
  if ((existing?.n ?? 0) > 0) return null;
  const records = SAMPLES.map((s) => toRecord(s, now));
  await persistRecords(handle, records, PRESET, RUN_ID);
  // The pipeline holds a new row until a primary source or an established publication confirms it, and
  // example.com is neither. Publish the samples the way Review's Publish does.
  for (const r of records.slice(0, -1)) {
    await setDisposition(handle, r.id, "publish");
    await handle
      .update(fundingRounds)
      .set({ verification: { status: "confirmed", notes: [SAMPLE_NOTE], url: r.sources[0]?.url ?? null } })
      .where(eq(fundingRounds.id, r.id));
  }
  await recordRun(handle, {
    id: RUN_ID,
    presetSlug: PRESET,
    lane: "sweep",
    window: "sample data",
    startedAt: now,
    finishedAt: now,
    creditsEstimated: 0,
    creditsMeasured: 0,
    counts: { records: records.length, inserted: records.length },
  });
  return { published: records.length - 1, review: 1 };
}
