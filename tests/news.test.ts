// News lists articles: every source page with the rounds it reported, minus regulatory filings,
// which stay on the record (the company page and the feed's expanded row) without being news.

import type { Firecrawl } from "firecrawl";
import { describe, expect, test } from "vitest";
import { corroborateRecord } from "../lib/corroborate";
import { FILING_HOSTS, listNews, listStories } from "../lib/news";
import { listRounds, persistRecords } from "../lib/persist";
import { record, testDb } from "./helpers";

describe("listNews", () => {
  test("a Form D filing is a source on the record but not an article, so News leaves sec.gov out", async () => {
    const db = await testDb();
    const filing = "https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/0001234567-26-000001-index.htm";
    const saved = await persistRecords(
      db,
      [
        record({
          company_name: "Acme Robotics",
          sources: [
            { url: "https://techcrunch.com/acme-series-a", host: "techcrunch.com", title: "Acme raises $20M", published: "2026-09-02" },
            { url: filing, host: "sec.gov", title: "Form D: Acme Robotics, Inc.", published: "2026-09-03", query: "formd" },
          ],
          verification: { status: "confirmed", notes: [], url: "https://techcrunch.com/acme-series-a", sources_seen: 2 },
        }),
        record({
          company_name: "Quiet Co",
          stage: "other",
          sources: [
            {
              url: "https://www.sec.gov/Archives/edgar/data/7654321/000765432126000001/0007654321-26-000001-index.htm",
              host: "www.sec.gov",
              title: "Form D: Quiet Co",
              published: "2026-09-03",
              query: "formd",
            },
          ],
        }),
      ],
      "series-a-b",
      "run-1",
    );
    const client = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
    await corroborateRecord(db, client, saved.insertedIds[0], { broad: true, maxPages: 0 });

    const news = await listNews(db);
    expect(news.map((n) => n.host)).toEqual(["techcrunch.com"]);
    expect(news[0]).toMatchObject({ title: "Acme raises $20M", published_at: "2026-09-02" });
    expect(news[0].rounds.map((r) => r.company)).toEqual(["Acme Robotics"]);
    expect(FILING_HOSTS).toContain("sec.gov");

    // The filings are still on the records themselves.
    const acme = (await listRounds(db, { company: "Acme Robotics" })).rows[0];
    expect(acme.sources.map((s) => s.host).sort()).toEqual(["sec.gov", "techcrunch.com"]);
  });

  test("a one-round article carries that round's evidence as its excerpt, clipped on a word boundary", async () => {
    const db = await testDb();
    const long = `${"Acme Robotics builds warehouse robots for mid-size logistics operators. ".repeat(8)}The round closes next quarter.`;
    await persistRecords(
      db,
      [
        record({
          company_name: "Clip Co",
          evidence_quotes: [long, "A second quote the card never reads."],
          sources: [{ url: "https://news.example/clip-co", host: "news.example", title: "Clip Co raises" }],
        }),
      ],
      "series-a-b",
      "run-1",
    );
    const news = await listNews(db);
    expect(news).toHaveLength(1);
    const excerpt = news[0].excerpt ?? "";
    expect(excerpt.endsWith("...")).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(243);
    expect(excerpt.slice(0, -3).endsWith(" ")).toBe(false);
    // A short quote lands whole, no ellipsis.
    const short = await testDb();
    await persistRecords(
      short,
      [
        record({
          company_name: "Brief Co",
          evidence_quotes: ["Brief Co raised $20M."],
          sources: [{ url: "https://news.example/brief-co", host: "news.example", title: "Brief Co raises" }],
        }),
      ],
      "series-a-b",
      "run-1",
    );
    expect((await listNews(short))[0].excerpt).toBe("Brief Co raised $20M.");
  });

  test("a roundup carries no excerpt; the chips carry the story, each with disposition and lead", async () => {
    const db = await testDb();
    const shared = { url: "https://techcrunch.com/roundup", host: "techcrunch.com", title: "This week's rounds" };
    const saved = await persistRecords(
      db,
      [record({ company_name: "Alpha Co", sources: [shared] }), record({ company_name: "Beta Co", stage: "series_b", sources: [shared] })],
      "series-a-b",
      "run-1",
    );
    const client = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
    for (const id of saved.insertedIds) await corroborateRecord(db, client, id, { broad: true, maxPages: 0 });
    const news = await listNews(db);
    expect(news).toHaveLength(1);
    expect(news[0].excerpt).toBeNull();
    expect(news[0].rounds).toHaveLength(2);
    expect(news[0].rounds[0]).toMatchObject({ disposition: "publish", lead: "Fund One" });
  });

  test("publishedOnly drops articles whose only rounds sit in review", async () => {
    const db = await testDb();
    const saved = await persistRecords(
      db,
      [
        record({
          company_name: "Public Co",
          sources: [{ url: "https://techcrunch.com/public-co", host: "techcrunch.com", title: "Public Co raises" }],
        }),
        record({
          company_name: "Shadow Co",
          confidence: 0.4,
          sources: [{ url: "https://news.example/shadow-co", host: "news.example", title: "Shadow Co rumour" }],
        }),
      ],
      "series-a-b",
      "run-1",
    );
    const client = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
    await corroborateRecord(db, client, saved.insertedIds[0], { broad: true, maxPages: 0 });
    const all = await listNews(db);
    expect(all.map((n) => n.title).sort()).toEqual(["Public Co raises", "Shadow Co rumour"]);
    const visitors = await listNews(db, { publishedOnly: true });
    expect(visitors.map((n) => n.title)).toEqual(["Public Co raises"]);
    expect(visitors[0].rounds[0].disposition).toBe("publish");
  });

  test("preset narrows the list to articles behind that preset's rounds", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [record({ company_name: "Growth Co", stage: "series_c", sources: [{ url: "https://news.example/growth", host: "news.example" }] })],
      "growth",
      "run-1",
    );
    await persistRecords(
      db,
      [record({ company_name: "Seed Co", stage: "seed", sources: [{ url: "https://news.example/seed", host: "news.example" }] })],
      "seed",
      "run-1",
    );
    const all = await listNews(db);
    expect(all).toHaveLength(2);
    const seed = await listNews(db, { preset: "seed" });
    expect(seed).toHaveLength(1);
    expect(seed[0].rounds.map((r) => r.company)).toEqual(["Seed Co"]);
  });
});

describe("listStories", () => {
  test("copies behind one round fold into a story led by the higher-tier publisher", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [
        record({
          company_name: "Wired Co",
          sources: [
            { url: "https://news.example/wired-co", host: "news.example", title: "Wired Co raises $20M", published: "2026-09-03" },
            { url: "https://techcrunch.com/wired-co", host: "techcrunch.com", title: "Wired Co raises $20M", published: "2026-09-04" },
          ],
        }),
      ],
      "series-a-b",
      "run-1",
    );
    const entries = await listStories(db);
    expect(entries).toHaveLength(1);
    const story = entries[0];
    expect(story.kind).toBe("story");
    if (story.kind !== "story") return;
    // TechCrunch outranks the wire host, so its headline and date lead even though it published later.
    expect(story.primary.host).toBe("techcrunch.com");
    expect(story.also.map((a) => a.host)).toEqual(["news.example"]);
    expect(story.round.company).toBe("Wired Co");
    expect(story.excerpt).toBe("Acme raised $20M.");
    expect(story.day).toBe("2026-09-04");
  });

  test("a page that reported two rounds stays an article, not a story", async () => {
    const db = await testDb();
    const shared = { url: "https://news.example/roundup", host: "news.example", title: "This week's rounds" };
    await persistRecords(
      db,
      [record({ company_name: "One Co", sources: [shared] }), record({ company_name: "Two Co", stage: "series_b", sources: [shared] })],
      "series-a-b",
      "run-1",
    );
    const entries = await listStories(db);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("article");
  });

  test("stories and articles sort by day, then the primary's publish date", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [
        record({
          company_name: "Early Co",
          announced_date: "2026-09-01",
          sources: [{ url: "https://news.example/early", host: "news.example", title: "Early Co", published: "2026-09-01" }],
        }),
        record({
          company_name: "Late Co",
          sources: [{ url: "https://news.example/late", host: "news.example", title: "Late Co", published: "2026-09-03" }],
        }),
        record({
          company_name: "Late Two Co",
          stage: "series_b",
          sources: [
            { url: "https://news.example/late-two-a", host: "news.example", title: "Late Two Co", published: "2026-09-02" },
            { url: "https://news.example/late-two-b", host: "techcrunch.com", title: "Late Two Co", published: "2026-09-03T15:00:00Z" },
          ],
        }),
      ],
      "series-a-b",
      "run-1",
    );
    const entries = await listStories(db);
    // Late Co and Late Two share the day; Late Two's primary published later that day.
    expect(entries.map((e) => (e.kind === "story" ? e.round.company : "article"))).toEqual(["Late Two Co", "Late Co", "Early Co"]);
  });
});
