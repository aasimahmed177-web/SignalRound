import { readFileSync } from "node:fs";
import type { FeedRecord } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

const { revalidateTag, cacheTag, scenario } = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
  cacheTag: vi.fn(),
  scenario: { records: [] as FeedRecord[] },
}));
let handle: Db;
vi.mock("@/lib/db", () => ({
  db: async () => handle,
  withinDeadline: <T>(read: Promise<T>) => read,
  visitorRead: <T>(read: (h: typeof handle) => Promise<T>) => read(handle),
}));
vi.mock("next/cache", () => ({ revalidateTag, cacheTag, cacheLife: vi.fn() }));
vi.mock("@fireround/core", async (original) => ({
  ...(await original<object>()),
  extractRounds: async () => ({ pages: [{ ok: true }], items: [], notArticle: 0 }),
  fetchRates: async () => null,
  resolveRounds: () => ({ kept: scenario.records, dropped: { ungrounded: 0, nonArticle: 0 } }),
  reconcileModel: () => undefined,
  judgeRecords: async () => ({ records: scenario.records }),
}));
vi.mock("@/lib/web-client", () => ({ getWebClient: () => ({}) }));
vi.mock("@/lib/settings", async (original) => ({ ...(await original<object>()), getCoverage: async () => ({ judge: true }) }));
vi.mock("@/lib/intel", async (original) => ({
  ...(await original<object>()),
  corroborateForPlan: async () => ({}),
  gapFillForPlan: async () => ({}),
}));
vi.mock("@/lib/delivery", async (original) => ({ ...(await original<object>()), flushDeliveries: async () => ({}) }));
vi.mock("@/workflows/dossiers", () => ({ deepDiveTargetsStep: async () => [], processDossierTargets: async () => undefined }));
vi.mock("@/workflows/enrich", () => ({ enrichPending: async () => null, recordEnrichmentStep: async () => undefined }));
vi.mock("@/workflows/history", () => ({ newRoundCompanyIdsStep: async () => [], startCompanyTimelinesStep: async () => undefined }));

import { cachedCompanyView, cachedInvestor } from "../lib/cached";
import { invalidateEntityPages } from "../lib/entity-invalidation";
import { companyTag, investorTag, TAG_ENTITY_DETAILS } from "../lib/entity-tags";
import { listRounds, persistRecords } from "../lib/persist";
import { ingestCandidate } from "../workflows/ingest-candidate";
import { record, testDb } from "./helpers";

beforeAll(async () => {
  handle = await testDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

test.each(["monitor-test", "company:readback.example"])("%s read-back invalidates metadata-only corrections", async (monitorId) => {
  const item = record({
    company_name: "Readback",
    company_domain: "readback.example",
    lead_investors: ["Readback Capital"],
    verification: { status: "confirmed", notes: [], url: "https://readback.example/news" },
  });
  await persistRecords(handle, [item], "series-a-b", "initial");
  const unchanged = await persistRecords(handle, [item], "series-a-b", "repeat");
  expect(unchanged.changedIds).toEqual([]);
  expect(unchanged.persistedIds).toHaveLength(1);
  revalidateTag.mockClear();
  scenario.records = [{ ...item, verification: { ...item.verification!, notes: ["Read-back checked against the company release"] } }];

  const result = await ingestCandidate(monitorId, "https://readback.example/news", "series-a-b", "http://app.test");
  expect(result.records).toBe(0);
  expect(revalidateTag).toHaveBeenCalledWith(companyTag("readback.example"), { expire: 0 });
  expect(revalidateTag).toHaveBeenCalledWith(investorTag("readback"), { expire: 0 });
  expect(revalidateTag).toHaveBeenCalledWith(TAG_ENTITY_DETAILS, { expire: 0 });
  expect(revalidateTag.mock.calls.filter(([tag]) => tag === TAG_ENTITY_DETAILS)).toHaveLength(2);
  const { rows } = await listRounds(handle, { ids: unchanged.persistedIds, includeReview: true });
  expect(rows[0]?.verification?.notes).toContain("Read-back checked against the company release");
});

test("a removed or merged round still invalidates the shared company, investor, and OG data cache", async () => {
  await invalidateEntityPages(handle, { roundIds: ["merged-away-round"] });
  expect(revalidateTag.mock.calls).toEqual([[TAG_ENTITY_DETAILS, { expire: 0 }]]);

  await cachedCompanyView("readback.example");
  expect(cacheTag).toHaveBeenCalledWith(TAG_ENTITY_DETAILS, companyTag("readback.example"));
  await cachedInvestor("readback");
  expect(cacheTag).toHaveBeenCalledWith(TAG_ENTITY_DETAILS, investorTag("readback"));
  const companyOg = readFileSync(new URL("../app/(dashboard)/companies/[id]/opengraph-image.tsx", import.meta.url), "utf8");
  const investorOg = readFileSync(new URL("../app/(dashboard)/investors/[id]/opengraph-image.tsx", import.meta.url), "utf8");
  expect(companyOg).toContain("await cachedCompanyView(");
  expect(investorOg).toContain("await cachedInvestor(");
});
