// pnpm demo-data: fictional rounds that fill an empty store without a key, and never touch a store with data.
import { schema } from "@fireround/core/db";
import { describe, expect, test } from "vitest";
import { SAMPLE_NOTE, SAMPLES, seedSampleData } from "../lib/demo-data";
import { persistRecords } from "../lib/persist";
import { record, testDb } from "./helpers";

describe("seedSampleData", () => {
  test("publishes every sample but one, which waits in Review, all on reserved example hosts", async () => {
    const handle = await testDb();
    expect(await seedSampleData(handle, new Date("2026-10-12T12:00:00Z"))).toEqual({ published: SAMPLES.length - 1, review: 1 });
    const rows = await handle.select().from(schema.fundingRounds);
    expect(rows).toHaveLength(SAMPLES.length);
    expect(rows.filter((r) => r.disposition === "publish")).toHaveLength(SAMPLES.length - 1);
    expect(rows.filter((r) => r.disposition === "review")).toHaveLength(1);
    for (const r of rows.filter((row) => row.disposition === "publish")) expect(r.verification?.notes).toEqual([SAMPLE_NOTE]);
    const urls = (await handle.select({ url: schema.sources.url }).from(schema.sources)).map((s) => new URL(s.url).hostname);
    expect(new Set(urls)).toEqual(new Set(["example.com", "example.org", "example.net"]));
  });

  test("leaves a store that already has rounds alone", async () => {
    const handle = await testDb();
    await persistRecords(handle, [record({ company_name: "Acme" })], "series-a-b", "run-1");
    expect(await seedSampleData(handle)).toBeNull();
    expect(await handle.select().from(schema.fundingRounds)).toHaveLength(1);
  });
});
