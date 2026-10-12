// The public demo's strip says how fresh the feed is: when the newest run of any lane started.
import { schema } from "@fireround/core/db";
import { expect, test } from "vitest";
import { demoStats } from "../lib/stats.ts";
import { testDb } from "./helpers.ts";

test("last_run_at is the newest run's start, any lane, and null before the first run", async () => {
  const db = await testDb();
  expect((await demoStats(db)).last_run_at).toBeNull();
  const newest = new Date(Date.now() - 2 * 60_000);
  await db.insert(schema.runs).values([
    { id: "sweep-older", presetSlug: "series-a-b", lane: "sweep", startedAt: new Date(Date.now() - 3 * 3_600_000) },
    { id: "trending-newest", presetSlug: "series-a-b", lane: "trending", startedAt: newest },
  ]);
  expect((await demoStats(db)).last_run_at).toBe(newest.toISOString());
});
