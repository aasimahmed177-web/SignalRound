// The sweep's seen-state: an hourly day-window sweep's searches return the same articles all day,
// and each re-read cost five credits and found nothing new. A page this preset's sweep read on this
// window within the window's days is not read again; a failed read is; X timelines always are; a
// month window (a backfill) reads everything.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import type { Candidate } from "@fireround/core";
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { recordReads, SWEEP_SEEN_DAYS, sweepMonitorId, unseenCandidates, watchQueriesDue } from "../lib/lanes";
import { testDb } from "./helpers";

const page = (url: string): Candidate => ({ url, queries: ["q"], kinds: ["news"] });
const x: Candidate = { url: "https://x.com/crunchbasenews", queries: ["x:@crunchbasenews"], kinds: ["x"] };
const A = "https://news.example/2026/09/24/acme-raises-20m-series-a";
const B = "https://news.example/2026/09/24/globex-raises-9m-seed";
const C = "https://news.example/2026/09/24/initech-raises-40m";

describe("the sweep's seen-state", () => {
  test("a page read within the window's days is skipped; a failed one, a new one, and X timelines are read", async () => {
    const handle = await testDb();
    const now = new Date();
    await recordReads(handle, sweepMonitorId("series-a-b", "day"), [A], [B], "run-1");
    const next = await unseenCandidates(handle, [page(A), page(B), page(C), x], "series-a-b", "day", now);
    expect(next.map((c) => c.url)).toEqual([B, C, x.url]);
    // Another preset, or another window, keeps its own ledger: a Series A/B read may still hold a seed round.
    expect((await unseenCandidates(handle, [page(A)], "seed", "day", now)).map((c) => c.url)).toEqual([A]);
    expect((await unseenCandidates(handle, [page(A)], "series-a-b", "week", now)).map((c) => c.url)).toEqual([A]);
    // A month window is a backfill: it reads older rounds a day window dropped, so it skips nothing.
    expect((await unseenCandidates(handle, [page(A)], "series-a-b", "month-1", now)).map((c) => c.url)).toEqual([A]);
  });

  test("after the window's days the page is read again, and the new read dates the row anew", async () => {
    const handle = await testDb();
    const id = sweepMonitorId("growth", "day");
    await recordReads(handle, id, [A], [], "run-1");
    // The read happened four days ago.
    await handle.execute(
      sql`update candidates set created_at = now() - make_interval(days => ${SWEEP_SEEN_DAYS.day + 1}) where monitor_id = ${id}`,
    );
    expect((await unseenCandidates(handle, [page(A)], "growth", "day", new Date())).map((c) => c.url)).toEqual([A]);
    await recordReads(handle, id, [A], [], "run-2");
    expect(await unseenCandidates(handle, [page(A)], "growth", "day", new Date())).toEqual([]);
  });
});

describe("the watch lane's stage-free searches", () => {
  test("every daily check; every third hour on the hourly cadence", () => {
    expect(watchQueriesDue("daily", new Date("2026-09-24T06:00:00Z"))).toBe(true);
    expect(watchQueriesDue("hourly", new Date("2026-09-24T21:00:00Z"))).toBe(true);
    expect(watchQueriesDue("hourly", new Date("2026-09-24T22:00:00Z"))).toBe(false);
    expect(watchQueriesDue("hourly", new Date("2026-09-24T00:00:00Z"))).toBe(true);
  });
});
