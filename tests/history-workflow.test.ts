process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { schema } from "@fireround/core/db";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { start } from "workflow/api";
import { db } from "../lib/db";
import { persistRecords } from "../lib/persist";
import { startLeadHistoryStep } from "../workflows/enrich";
import { companyHistoryWorkflow, startCompanyTimelinesStep } from "../workflows/history";
import { record } from "./helpers";

vi.mock("workflow/api", () => ({ start: vi.fn(async () => undefined) }));

beforeEach(async () => {
  vi.stubEnv("FIRECRAWL_API_KEY", "test");
  await (await db()).execute(sql`truncate companies, runs cascade`);
});

afterEach(() => vi.unstubAllEnvs());

test("a feed company starts timeline recall without an Apollo lead or a dossier", async () => {
  const handle = await db();
  const current = record({ company_name: "Acme", company_domain: "acme.com" });
  await persistRecords(handle, [current], "series-a-b", "feed");
  vi.mocked(start).mockClear();
  await startLeadHistoryStep([], [current.id]);
  expect(start).toHaveBeenCalledExactlyOnceWith(companyHistoryWorkflow, ["acme.com"]);
});

test("accuracy recall respects its cap and moves past recently checked prominent companies", async () => {
  const handle = await db();
  const now = new Date();
  await handle.insert(schema.runs).values([
    { id: "history-timeline:recent", lane: "history", presetSlug: "history-timeline", startedAt: now, finishedAt: now },
    { id: "history-timeline:running", lane: "history", presetSlug: "history-timeline", startedAt: now },
    { id: "history-timeline:stale", lane: "history", presetSlug: "history-timeline", startedAt: new Date(0), finishedAt: new Date(0) },
  ]);
  vi.mocked(start).mockClear();
  expect(await startCompanyTimelinesStep(["recent", "running", "stale", "new", "later"], 2)).toBe(2);
  expect(vi.mocked(start).mock.calls).toEqual([
    [companyHistoryWorkflow, ["stale"]],
    [companyHistoryWorkflow, ["new"]],
  ]);
});
