// The admin's paste-a-URL path keeps a stageless round. Solcoa's "$75 million in financing" names no
// stage, and the resolver used to drop it as another stage wherever it was read, pasted URLs included.
// Pasted under the seed preset, it now lands under Series A/B (its $45M equity is mid band), stored as
// the page writes it. The extraction and the read-back are faked; the page rules, the resolver,
// routing, persist, and the store are real.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import type { ExtractedRound, FeedRecord } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { describe, expect, test, vi } from "vitest";

vi.mock("@fireround/core", async (original) => {
  const core = await original<typeof import("@fireround/core")>();
  const markdown = `Solcoa Industries today announced $75 million in financing to build Solcoa One, its first commercial rare earth metalmaking plant. The round includes $45 million in equity led by Bain Capital Ventures, with participation from Gigascale Capital, Long Journey, Felicis, Dylan Field, and prominent leaders across defense and technology. It also includes $30 million in debt and equipment financing, anchored by J.P. Morgan.`;
  const extracted: ExtractedRound = {
    company_name: "Solcoa Industries",
    company_website: null,
    company_description: "a rare earth metals producer",
    round_type_as_written: "financing",
    amount_as_written: "$75 million",
    amount_kind: "round",
    valuation_as_written: null,
    lead_investors: ["Bain Capital Ventures"],
    other_investors: ["Gigascale Capital", "Long Journey", "Felicis"],
    announced_date: new Date().toISOString().slice(0, 10),
    headquarters: "Alameda, California",
    sector: null,
    evidence_quote:
      "Solcoa Industries today announced $75 million in financing to build Solcoa One, its first commercial rare earth metalmaking plant.",
    source_url: null,
    is_background: false,
    is_rumor: false,
  };
  return {
    ...core,
    fetchRates: async () => null,
    reconcileModel: () => null,
    extractRounds: async (_client: unknown, targets: Array<{ url: string }>) => {
      const url = targets[0].url;
      const day = new Date().toISOString().slice(0, 10);
      return {
        items: core.pageItems([extracted], { url, host: core.hostOf(url), published: day }, markdown, {
          page_kind: "article",
          page_date: day,
        }),
        pages: [{ url, ok: true, rounds: 1, ungrounded: 0, cached: false }],
        creditsEstimated: 5,
        notArticle: 0,
      };
    },
    judgeRecords: async (_client: unknown, records: FeedRecord[]) => ({
      records: records.map((r) => ({ ...r, verification: { status: "confirmed" as const, notes: [], url: r.sources[0]?.url ?? null } })),
      judged: records.length,
      confirmed: records.length,
      corrected: 0,
      contradicted: 0,
      notNews: 0,
      failed: 0,
      creditsEstimated: 5,
    }),
  };
});

vi.mock("@/lib/firecrawl", () => ({ getFirecrawl: () => ({}) }));
vi.mock("@/lib/delivery", () => ({ enqueueDeliveries: async () => 0, flushDeliveries: async () => undefined }));
vi.mock("@/lib/intel", () => ({
  corroborateForPlan: async () => ({}),
  gapFillForPlan: async () => ({ gap_filled: 0, agent_credits: 0 }),
}));
vi.mock("@/workflows/enrich", () => ({
  enrichPending: async () => null,
  recordEnrichmentStep: async () => undefined,
}));
vi.mock("@/workflows/dossiers", () => ({ deepDiveTargetsStep: async () => [], processDossierTargets: async () => undefined }));

import { db } from "../lib/db";
import { ingestCandidate } from "../workflows/ingest-candidate";

describe("a pasted URL", () => {
  test("keeps Solcoa's stageless financing: its equity figure, under the preset its band names, as the page labels it", async () => {
    const url =
      "https://www.businesswire.com/news/home/20260924752270/en/Solcoa-Announces-%2475M-to-Scale-Americas-First-New-Metalmaking-Process-in-80-Years";
    const r = await ingestCandidate("manual", url, "seed", "http://localhost");
    expect(r.records).toBe(1);
    const rows = await (await db()).select().from(schema.fundingRounds);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId: "solcoa-industries",
      presetSlug: "series-a-b",
      stage: "other",
      stageAsWritten: "financing",
      amountAsWritten: "$45 million",
    });
    expect(Number(rows[0].amountUsdMillions)).toBe(45);
    expect(rows[0].evidenceQuotes.some((q) => q.includes("$30 million in debt"))).toBe(true);
  });
});
