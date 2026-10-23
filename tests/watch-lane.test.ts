// The watch-sites lane reads every record back before persist, as the sweep and the monitor do: an
// unjudged watch reading once landed a trend story's "megarounds for Silicon Valley-based OpenAI" as
// a flagged OpenAI "Series A". The section read, the extraction, and the read-back are faked; the
// resolver, persist, and the store are real. So is the order: a row whose day the company never stated
// is corroborated before the deliver step.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import type { ExtractedItem, FeedRecord } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { describe, expect, test, vi } from "vitest";

vi.mock("workflow/api", () => ({ start: vi.fn(async () => ({ runId: "test-workflow" })) }));

const read = vi.hoisted(() => ({ records: [] as FeedRecord[][], events: [] as string[] }));

vi.mock("@fireround/core", async (original) => {
  const core = await original<typeof import("@fireround/core")>();
  const day = new Date().toISOString().slice(0, 10);
  const items: ExtractedItem[] = [
    {
      round: {
        company_name: "Acme Robotics",
        round_type_as_written: "Series A",
        company_website: null,
        company_description: null,
        amount_as_written: "$20 million",
        amount_kind: "round",
        valuation_as_written: null,
        lead_investors: ["Fund One"],
        other_investors: [],
        announced_date: day,
        headquarters: null,
        sector: null,
        evidence_quote: "Acme Robotics raised $20 million in a Series A led by Fund One.",
        source_url: null,
        is_background: false,
        is_rumor: false,
      },
      source: { url: `https://news.example/${day.replaceAll("-", "/")}/acme-robotics-raises-20-million`, host: "news.example" },
      page_kind: "article",
      page_date: day,
      grounded: true,
    },
    {
      round: {
        company_name: "Globex",
        round_type_as_written: "Series A",
        company_website: null,
        company_description: null,
        amount_as_written: "$9 million",
        amount_kind: "round",
        valuation_as_written: null,
        lead_investors: [],
        other_investors: [],
        announced_date: day,
        headquarters: null,
        sector: null,
        evidence_quote: "Globex raised $9 million in a Series A.",
        source_url: null,
        is_background: false,
        is_rumor: false,
      },
      source: { url: `https://news.example/${day.replaceAll("-", "/")}/globex-raised-nine-million-series-a`, host: "news.example" },
      page_kind: "article",
      page_date: day,
      grounded: true,
    },
  ];
  return {
    ...core,
    runWatchSites: async () => ({
      candidates: items.map((i) => ({ url: i.source.url })),
      sites: [{ articles: 2 }],
      queries: [],
      mapCredits: 1,
      searchCredits: 0,
    }),
    extractRounds: async () => ({ items, pages: items.map((i) => ({ url: i.source.url, ok: true })), creditsEstimated: 10, notArticle: 0 }),
    reconcileModel: () => ({ label: "test-model", model: null }),
    reconcileRecords: async (records: FeedRecord[]) => {
      read.records.push(records);
      const out = records.map((r) =>
        r.company_key === "globex"
          ? { ...r, verification: { status: "not_news" as const, notes: ["the page recalls this round as history"], url: null } }
          : {
              ...r,
              verification: {
                status: "confirmed" as const,
                notes: [],
                url: r.sources[0]?.url ?? null,
                verifier: "test-model",
                sources_seen: r.sources.length,
              },
            },
      );
      return {
        records: out,
        judged: 2,
        confirmed: 1,
        corrected: 0,
        contradicted: 0,
        notNews: 1,
        failed: 0,
        credits: 2,
        creditsEstimated: 2,
      };
    },
  };
});

vi.mock("@/lib/web-client", () => ({
  getWebClient: () => ({ getCreditUsage: async () => ({ remainingCredits: 1000 }) }),
}));

vi.mock("@/lib/delivery", () => ({
  enqueueDeliveries: async (_h: unknown, ids: string[]) => {
    read.events.push(`deliver ${ids.join(",")}`);
    return 0;
  },
  flushDeliveries: async () => undefined,
}));

// The page-dated row is corroborated before anything is delivered (the search and pages are faked).
vi.mock("../lib/corroborate.ts", () => ({
  corroborateRecord: async (_h: unknown, _c: unknown, id: string) => {
    read.events.push(`corroborate ${id}`);
    return { rejected: 0, newsroom: 0, creditsEstimated: 3 };
  },
}));

import { db } from "../lib/db";
import { watchSitesWorkflow } from "../workflows/watch-sites";

describe("the watch lane reads back before persist", () => {
  test("every record is read back; history does not land, a confirmed record lands with its verdict", async () => {
    const summary = await watchSitesWorkflow("series-a-b", "watch-run-1", "http://localhost");
    expect(read.records).toHaveLength(1);
    expect(read.records[0]?.map((r) => r.company_key).sort()).toEqual(["acme robotics", "globex"]);
    const handle = await db();
    const rows = await handle.select().from(schema.fundingRounds);
    expect(rows.map((r) => r.companyId)).toEqual(["acme-robotics"]);
    expect((rows[0]?.verification as FeedRecord["verification"])?.status).toBe("confirmed");
    expect(summary.records).toBe(1);
    const [run] = await handle.select().from(schema.runs);
    expect(run?.counts?.judged).toBe(2);
    expect(run?.counts?.judge_not_news).toBe(1);
    // Its day is the article's byline, not one the company stated: corroborated, then delivered.
    expect(rows[0]?.dateBasis).not.toBe("stated");
    expect(read.events).toEqual([`corroborate ${rows[0]?.id}`, `corroborate ${rows[0]?.id}`, `deliver ${rows[0]?.id}`]);
    expect(run?.counts?.corroborated).toBe(2);
  });
});
