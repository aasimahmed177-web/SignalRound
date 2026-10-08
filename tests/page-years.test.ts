// An extractor that answers a year the page leaves out with its own put October 2026 stories in October
// 2023. The repair re-dates such a round from its sources, and leaves a round any of its pages dates in
// the stored year (Sammmm's January 2025 seed, re-reported in a September 2026 snippet).

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { repairPageYears } from "../lib/page-years";
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
