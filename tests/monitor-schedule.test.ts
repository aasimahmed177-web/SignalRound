import { schema } from "@fireround/core/db";
import { describe, expect, test } from "vitest";
import { rescheduleMonitors } from "../lib/monitor-schedule";
import { testDb } from "./helpers";

describe("rescheduleMonitors", () => {
  test("every stored preset monitor moves to the new schedule in its preset's timezone", async () => {
    const db = await testDb();
    await db.insert(schema.presetMonitors).values([
      { presetSlug: "seed", monitorId: "mon-seed" },
      { presetSlug: "growth", monitorId: "mon-growth" },
    ]);
    const calls: Array<[string, unknown]> = [];
    const client = {
      updateMonitor: async (id: string, request: unknown) => {
        calls.push([id, request]);
        return {} as never;
      },
    };
    expect(await rescheduleMonitors(db, client, "hourly")).toBe(2);
    expect(calls.sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ["mon-growth", { schedule: { text: "hourly", timezone: "UTC" } }],
      ["mon-seed", { schedule: { text: "hourly", timezone: "UTC" } }],
    ]);
  });

  test("no stored monitors, no calls", async () => {
    const db = await testDb();
    const client = { updateMonitor: async () => ({}) as never };
    expect(await rescheduleMonitors(db, client, "hourly")).toBe(0);
  });
});
