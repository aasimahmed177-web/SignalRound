import type { FeedRecord } from "@fireround/core";
import type { NativeWebClient as Firecrawl } from "@fireround/core/web";
import { expect, it, vi } from "vitest";
import { listRounds, persistRecords } from "../lib/persist.ts";
import { reconcileGrownRows } from "../lib/reconcile.ts";
import { record, testDb } from "./helpers.ts";

vi.mock("@fireround/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@fireround/core")>();
  return {
    ...core,
    reconcileRecords: async (records: FeedRecord[]) => ({
      records: records.map((r) => ({
        ...r,
        verification: {
          status: "confirmed" as const,
          notes: [],
          url: r.sources[0]?.url ?? null,
          verifier: "test-model",
          sources_seen: r.sources.length,
        },
      })),
      judged: records.length,
      confirmed: records.length,
      corrected: 0,
      contradicted: 0,
      notNews: 0,
      failed: 0,
      credits: 0,
      creditsEstimated: 0,
    }),
  };
});

it("reads a history row back as history, so a second source does not hold it for an earliest-report search", async () => {
  const handle = await testDb();
  const release = { url: "https://www.techcrunch.com/2019/03/05/acme-raises-20m-series-b", host: "techcrunch.com" };
  const second = { url: "https://www.reuters.com/2019/03/05/acme-series-b", host: "reuters.com" };
  const round = record({
    company_name: "Acme",
    company_domain: "acme.com",
    stage: "series_b",
    stage_as_written: "Series B",
    amount: { value: 20, currency: "USD", as_written: "$20 million", usd_millions: 20, fx_rate: 1, fx_date: "2019-03-05" },
    announced_date: "2019-03-05",
    lead_investors: ["Fund One"],
    evidence_quotes: ["Acme raised $20 million in a Series B led by Fund One."],
    verification: { status: "confirmed", notes: [], url: release.url, sources_seen: 1 },
    sources: [release],
  });
  await persistRecords(handle, [round], "default", "history:test", { history: true });
  await persistRecords(handle, [{ ...round, sources: [release, second] }], "default", "history:test", { history: true });
  const [stored] = (await listRounds(handle, { includeReview: true, certainty: "all", limit: 5 })).rows;
  expect(stored?.history).toBe(true);
  expect(stored?.sources).toHaveLength(2);

  await reconcileGrownRows(handle, {} as Firecrawl, { label: "test-model" } as never, [stored?.id ?? ""], { rates: null });

  const [after] = (await listRounds(handle, { ids: [stored?.id ?? ""], includeReview: true, certainty: "all", limit: 1 })).rows;
  expect(after?.verification?.notes.join(" ")).not.toContain("earliest-report search pending");
  expect(after?.verification?.sources_seen).toBe(2);
  expect(after?.disposition).not.toBe("review");
});
