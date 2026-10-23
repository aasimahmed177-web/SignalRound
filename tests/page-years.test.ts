// An extractor that answers a year the page leaves out with its own put October 2026 stories in October
// 2023. The repair re-dates such a round from its sources, and leaves a round any of its pages dates in
// the stored year (Sammmm's January 2025 seed, re-reported in a September 2026 snippet).

import { schema } from "@fireround/core/db";
import type { NativeWebClient as Firecrawl } from "@fireround/core/web";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { extractionDater, type PageDater, repairPageYears } from "../lib/page-years";
import { persistRecords } from "../lib/persist";
import { record, testDb } from "./helpers";

test("a guessed year goes to the day the round's coverage tells of; a year a page writes stays", async () => {
  const db = await testDb();
  const revnu = record({
    company_name: "Revnu",
    announced_date: "2023-10-01",
    date_basis: "page",
    sources: [
      { url: "https://aboutmanchester.co.uk/ai-marketing-platform-revnu-raises-3m", host: "aboutmanchester.co.uk" },
      { url: "https://example.news/2026/10/01/revnu-raises-3m", host: "example.news" },
      { url: "https://another.example/revnu", host: "another.example", published: "2026-10-02" },
      { url: "https://stale.example/roundup", host: "stale.example", published: "2026-08-01" },
    ],
  });
  const sammmm = record({
    company_name: "Sammmm",
    announced_date: "2025-01-30",
    date_basis: "page",
    sources: [
      { url: "https://sammmm.com/news/seed", host: "sammmm.com" },
      { url: "https://entrackr.com/snippets/lumikai", host: "entrackr.com", published: "2026-09-22" },
    ],
  });
  await persistRecords(db, [revnu, sammmm], "seed", "history:test", { history: true });
  const pages: Record<string, string> = {
    "https://aboutmanchester.co.uk/ai-marketing-platform-revnu-raises-3m": "Revnu raises $3m to grow in Manchester. October 1",
    "https://sammmm.com/news/seed": "Sammmm raised Rs 10 crore in January 2025.",
  };
  const read = async (url: string) => pages[url] ?? null;
  const changes = await repairPageYears(db, read);
  expect(changes).toEqual([{ id: revnu.id, from: "2023-10-01", to: "2026-10-01", backToFeed: false }]);
  expect((await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, revnu.id)))[0].announcedOn).toBe("2023-10-01");
  expect(await repairPageYears(db, read, true)).toEqual(changes);
  expect((await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, revnu.id)))[0]).toMatchObject({
    announcedOn: "2026-10-01",
    dateBasis: "page",
  });
  expect((await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, sammmm.id)))[0].announcedOn).toBe("2025-01-30");
  // A page that cannot be read leaves the round as it is.
  expect(await repairPageYears(db, async () => null)).toEqual([]);
});

test("a re-read under today's rules decides: a new year moves the round, the stored year or no day leaves it", async () => {
  const db = await testDb();
  const row = (name: string, day: string, sources: Array<{ url: string; published?: string }>) =>
    record({
      company_name: name,
      announced_date: day,
      date_basis: "page",
      sources: sources.map((s) => ({ ...s, host: new URL(s.url).hostname })),
    });
  // A source of an earlier round dated in the stored year sits beside the new round's coverage.
  const valon = row("Valon", "2023-10-01", [
    { url: "https://example.news/valon-150m", published: "2026-10-05" },
    { url: "https://old.example/valon-series-b", published: "2023-10-02" },
  ]);
  const keyper = row("Keyper", "2023-10-26", [{ url: "https://bw.example/keyper-seed" }]);
  const mecka = row("Mecka", "2023-10-05", [{ url: "https://mecka.example/news/series-b" }]);
  // One of its pages still carries a stale 2023 day; the rest of its coverage agrees on August 2024.
  const eliseai = row("EliseAI", "2023-10-01", [
    { url: "https://eliseai.example/blog/series-d" },
    { url: "https://news.example/eliseai-75m", published: "2024-08-14" },
    { url: "https://other.example/eliseai", published: "2024-08-16" },
  ]);
  await persistRecords(db, [valon, keyper, mecka, eliseai], "series-a-b", "history:test", { history: true });
  const readings: Record<string, string[]> = {
    Valon: ["2026-10-05"],
    Keyper: ["2023-10-26"],
    Mecka: [],
    EliseAI: ["2023-10-12", "2024-08-14", "2024-08-14"],
  };
  const reread: PageDater = async (_pages, company) => readings[company] ?? [];
  const ids = [valon.id, keyper.id, mecka.id, eliseai.id];
  const noText = async () => null;
  const changes = await repairPageYears(db, noText, false, { reread, ids });
  expect(changes).toHaveLength(2);
  expect(changes).toEqual(
    expect.arrayContaining([
      { id: valon.id, from: "2023-10-01", to: "2026-10-05", backToFeed: false },
      { id: eliseai.id, from: "2023-10-01", to: "2024-08-14", backToFeed: false },
    ]),
  );
  await repairPageYears(db, noText, true, { reread, ids });
  const day = async (id: string) => (await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, id)))[0]?.announcedOn;
  expect(await day(valon.id)).toBe("2026-10-05");
  expect(await day(eliseai.id)).toBe("2024-08-14");
  expect(await day(keyper.id)).toBe("2023-10-26");
  expect(await day(mecka.id)).toBe("2023-10-05");
});

test("extractionDater gives the day of the company's own round, never of a page recalling it as history", async () => {
  const reading = (company: string, background: boolean) => ({
    company_name: company,
    round_type_as_written: "Series B",
    amount_as_written: "$60 million",
    announced_date: null,
    evidence_quote: `${company} raised $60 million in a Series B.`,
    company_website: null,
    company_description: null,
    amount_kind: "round",
    valuation_as_written: null,
    lead_investors: [],
    other_investors: [],
    headquarters: null,
    sector: null,
    source_url: null,
    is_background: background,
    is_rumor: false,
  });
  const pages: Record<string, { markdown: string; json: unknown; metadata: Record<string, string> }> = {
    "https://news.example/mecka-series-b": {
      markdown: "# Mecka raises $60 million\n\nOctober 7, 2026\n\nMecka raised $60 million in a Series B.",
      json: { page_kind: "article", page_date: null, rounds: [reading("Mecka", false)] },
      metadata: { title: "Mecka raises $60 million" },
    },
    "https://news.example/profile": {
      markdown: "# A profile\n\nMarch 3, 2026\n\nMecka raised $60 million in a Series B.",
      json: { page_kind: "article", page_date: null, rounds: [reading("Mecka", true)] },
      metadata: { title: "A profile" },
    },
  };
  const client = { scrape: async (url: string) => pages[url] } as unknown as Firecrawl;
  const dater = extractionDater(client);
  const targets = Object.keys(pages).map((url) => ({ url, title: null, published: null }));
  expect(await dater(targets, "Mecka")).toEqual(["2026-10-07"]);
});
