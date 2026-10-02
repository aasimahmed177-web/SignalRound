// The watch-sites lane against a fake Firecrawl: the preset run and the candidates ledger the
// workflow keeps. Link selection and a single section watch are tested in packages/core.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { readFileSync } from "node:fs";
import { parsePreset, RATE, runWatchSites } from "@fireround/core";
import { sql } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { describe, expect, test } from "vitest";
import { markCandidates, seenCandidate, seenWatchCandidate, upsertCandidates, WATCH_EMPTY_REREAD_DAYS, watchMonitorId } from "../lib/lanes";
import { persistRecords } from "../lib/persist";
import { record, testDb } from "./helpers";

describe("runWatchSites", () => {
  test("reads every site of the preset, marks each site's targets seen, and prices one credit per site", async () => {
    const preset = parsePreset(JSON.parse(readFileSync("presets/series-a-b.json", "utf8")));
    const n = preset.watchSites.length;
    expect(n).toBeGreaterThanOrEqual(7);
    const calls: string[] = [];
    const marked: Array<[string, string[]]> = [];
    const client = {
      search: async () => ({ web: [] }),
      scrape: async (url: string) => {
        calls.push(url);
        const host = new URL(url).hostname;
        return { links: [`https://${host}/2026/09/04/${host.split(".")[0]}-startup-raises-round/`, url] };
      },
    } as unknown as Firecrawl;
    // `now` pins the run inside the 14-day window of the fixture's 2026-09-04 dated links.
    const r = await runWatchSites(client, preset, {
      seen: () => false,
      markSeen: (host, urls) => void marked.push([host, urls]),
      now: new Date("2026-09-05T00:00:00Z"),
    });
    expect(calls).toEqual(preset.watchSites);
    expect(r.sites).toHaveLength(n);
    expect(r.candidates).toHaveLength(n);
    expect(r.mapCredits).toBe(n * RATE.mapCall);
    expect(marked.map(([h]) => h)).toEqual(preset.watchSites.map((u) => new URL(u).hostname.replace(/^www\./, "")));
    expect(marked[0][1]).toEqual(["https://techcrunch.com/2026/09/04/techcrunch-startup-raises-round"]);
  });

  test("the preset schema caps watch sites at 20 and wants URLs", () => {
    const base = JSON.parse(readFileSync("presets/series-a-b.json", "utf8"));
    expect(() => parsePreset({ ...base, watchSites: ["not a url"] })).toThrow();
    expect(() => parsePreset({ ...base, watchSites: Array.from({ length: 21 }, (_, i) => `https://site${i}.example/news/`) })).toThrow();
    expect(parsePreset({ ...base, watchSites: undefined }).watchSites).toEqual([]);
  });
});

describe("the candidates ledger", () => {
  test("a URL is seen once written, a failed one is read again, and rows are keyed by host", async () => {
    const handle = await testDb();
    const id = watchMonitorId("techcrunch.com");
    const url = "https://techcrunch.com/2026/09/04/acme-raises-46m-series-b";
    expect(await seenCandidate(handle, id, url)).toBe(false);
    await upsertCandidates(handle, id, [url], "pending", "run-1");
    expect(await seenCandidate(handle, id, url)).toBe(true);
    expect(await seenCandidate(handle, watchMonitorId("tech.eu"), url)).toBe(false);
    await markCandidates(handle, id, [url], "failed");
    expect(await seenCandidate(handle, id, url)).toBe(false);
    await upsertCandidates(handle, id, [url], "pending", "run-2");
    await markCandidates(handle, id, [url], "extracted");
    expect(await seenCandidate(handle, id, url)).toBe(true);
  });

  test("the watch lane reads an unproductive page again after a week; a page that sourced a round stays seen", async () => {
    const handle = await testDb();
    const id = watchMonitorId("eu-startups.com");
    const empty = "https://www.eu-startups.com/2026/09/londons-unit1-studio-secures-e23-3-million";
    const sourced = "https://www.eu-startups.com/2026/09/amsterdam-based-duqu-raises-e1-5-million";
    await upsertCandidates(handle, id, [empty, sourced], "pending", "run-1");
    await markCandidates(handle, id, [empty, sourced], "extracted");
    await persistRecords(
      handle,
      [
        record({
          company_name: "Duqu",
          stage: "pre_seed",
          announced_date: new Date().toISOString().slice(0, 10),
          sources: [{ url: sourced, host: "eu-startups.com" }],
        }),
      ],
      "seed",
      "run-1",
    );
    expect(WATCH_EMPTY_REREAD_DAYS).toBe(7);
    const now = new Date();
    expect(await seenWatchCandidate(handle, id, empty, now)).toBe(true);
    const later = new Date(now.getTime() + 8 * 86_400_000);
    expect(await seenWatchCandidate(handle, id, empty, later)).toBe(false);
    expect(await seenWatchCandidate(handle, id, sourced, later)).toBe(true);
    // The re-read restarts the clock: seen again for the next week.
    await upsertCandidates(handle, id, [empty], "pending", "run-2");
    await handle.execute(sql`update candidates set created_at = ${later.toISOString()} where url = ${empty}`);
    expect(await seenWatchCandidate(handle, id, empty, new Date(later.getTime() + 86_400_000))).toBe(true);
    // A failed read is read again at once, as before.
    await markCandidates(handle, id, [empty], "failed");
    expect(await seenWatchCandidate(handle, id, empty, now)).toBe(false);
  });

  test("a batch with the same URL twice, and one larger than a statement's worth, writes once per URL", async () => {
    const handle = await testDb();
    const id = "formd";
    const urls = Array.from({ length: 450 }, (_, i) => `https://www.sec.gov/Archives/edgar/data/${1000 + (i % 300)}/index.htm`);
    // 450 entries, 300 distinct: the Form D lane reads a filing twice when an amendment points back at it.
    await upsertCandidates(handle, id, urls, "extracted", "run-1");
    const n = (await handle.execute(sql`select count(*)::int n from candidates where monitor_id = ${id}`)).rows[0].n;
    expect(n).toBe(300);
    expect(await seenCandidate(handle, id, urls[0])).toBe(true);
  });
});
