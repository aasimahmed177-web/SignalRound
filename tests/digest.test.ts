import type { NativeWebClient as Firecrawl } from "@fireround/core/web";
import { describe, expect, test } from "vitest";
import { corroborateRecord } from "../lib/corroborate";
import { DIGEST_CAP, digestDue, digestHtml, digestSubject, digestText, parseDigestState } from "../lib/digest";
import { listRounds, persistRecords as persistUnchecked } from "../lib/persist";
import { record, testDb } from "./helpers";

const scope = { origin: "https://app.test", cadence: "weekly" as const, presetSlug: "series-a-b", minConfidence: 0.75 };

async function persistRecords(...args: Parameters<typeof persistUnchecked>) {
  const result = await persistUnchecked(...args);
  const searched = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
  for (const id of result.insertedIds) await corroborateRecord(args[0], searched, id, { broad: true, maxPages: 0 });
  return result;
}

describe("digest composer", () => {
  test("subject counts rounds and names the window", () => {
    expect(digestSubject(3, "weekly")).toBe("Fireround: 3 rounds newly found this week");
    expect(digestSubject(1, "daily")).toBe("Fireround: 1 round newly found today");
  });

  test("HTML and text carry both companies, the feed link, the scope, and no dashes", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [record({ company_name: "Acme" }), record({ company_name: "Beta & Co", company_key: "beta", stage: "seed", lead_investors: [] })],
      "series-a-b",
      "run-1",
    );
    const { rows } = await listRounds(db);
    expect(rows).toHaveLength(2);
    const html = digestHtml(rows, scope);
    expect(html).toContain("Acme");
    expect(html).toContain("Beta &amp; Co");
    expect(html).toContain("https://app.test/feed?preset=series-a-b");
    expect(html).toContain(`https://app.test/companies/${encodeURIComponent(rows[0].company.id)}`);
    expect(html).toContain("#fa5d19");
    expect(html).toContain("$20M");
    expect(html).toContain("Fund One");
    expect(html).toContain("lead not stated");
    expect(html).toContain("reuters.com");
    expect(html).toContain("series-a-b, verified only");
    expect(html).not.toMatch(/[\u2013\u2014]/);

    const text = digestText(rows, scope);
    expect(text).toContain("Acme");
    expect(text).toContain("Beta & Co");
    expect(text).toContain("Open the feed: https://app.test/feed?preset=series-a-b");
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  test("a digest caps at 50 rounds and counts the rest", async () => {
    const db = await testDb();
    const many = Array.from({ length: DIGEST_CAP + 3 }, (_, i) => record({ company_name: `Co ${i}`, company_key: `co-${i}` }));
    await persistRecords(db, many, "series-a-b", "run-1");
    const { rows } = await listRounds(db, { limit: 200 });
    expect(rows.length).toBe(DIGEST_CAP + 3);
    const html = digestHtml(rows, { ...scope, presetSlug: null, minConfidence: 0 });
    expect(html).toContain("and 3 more in");
    expect(html).toContain("https://app.test/feed");
    expect(html).toContain("all presets, everything");
    expect(digestText(rows, scope)).toContain("and 3 more in the feed");
  });

  test("the first digest is due at once; later ones wait for the window", () => {
    const now = Date.parse("2026-09-08T12:00:00Z");
    expect(digestDue({ cadence: "weekly", lastSentAt: null }, now)).toBe(true);
    expect(digestDue({ cadence: "weekly", lastSentAt: "2026-09-02T12:00:00Z" }, now)).toBe(false);
    expect(digestDue({ cadence: "weekly", lastSentAt: "2026-09-01T11:00:00Z" }, now)).toBe(true);
    expect(digestDue({ cadence: "daily", lastSentAt: "2026-09-07T13:00:00Z" }, now)).toBe(false);
    expect(digestDue({ cadence: "daily", lastSentAt: "2026-09-07T11:00:00Z" }, now)).toBe(true);
    expect(parseDigestState(undefined)).toEqual({ cadence: "weekly", lastSentAt: null });
    expect(parseDigestState({ cadence: "daily", lastSentAt: 5 })).toEqual({ cadence: "daily", lastSentAt: null });
  });
});
