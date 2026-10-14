// A round id is the company's name key plus the round, so two companies that share a name share ids.
// Odyssey Energy Solutions held a misfiled $310M Series B under "odyssey:series_b:2026-06-17"; when the
// history lane read that round for Odyssey the world-model lab (odyssey.systems), the reading landed on
// the energy company's row, the row's company stood as the reading's, and the domain claim folded the
// whole energy company into the lab. Luminary (withluminary.com into luminary.ai) and Rivet (rivetdating.com
// into rivet.us) went the same way. Two domains are two companies: no reading folds one into the other.

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { claimDomain, persistRecords } from "../lib/persist";
import { record, testDb } from "./helpers";

const cases = [
  { name: "Odyssey", stored: "odysseyenergysolutions.com", other: "odyssey.systems", stage: "series_b" as const, day: "2026-06-17" },
  { name: "Luminary", stored: "withluminary.com", other: "luminary.ai", stage: "series_b" as const, day: "2025-09-15" },
  { name: "Rivet", stored: "rivetdating.com", other: "rivet.us", stage: "other" as const, day: "2026-04-03" },
];

/** The stored namesake: its own earlier round and the misfiled round, both under its domain. */
async function namesake(c: (typeof cases)[number]) {
  const db = await testDb();
  const own = (stage: "seed" | "series_b" | "other", day: string) =>
    record({
      company_name: c.name,
      company_domain: c.stored,
      company_website: `https://${c.stored}`,
      stage,
      announced_date: day,
      sources: [{ url: `https://${c.stored}/news/${stage}-${day}`, host: c.stored }],
    });
  await persistRecords(db, [own("seed", "2022-09-08"), own(c.stage, c.day)], "series-a-b", "run-1");
  const [stored] = await db.select().from(schema.companies).where(eq(schema.companies.domain, c.stored));
  await db.insert(schema.companies).values({ id: c.other, name: c.name, nameKey: c.name.toLowerCase(), domain: c.other });
  const reading = record({
    company_name: c.name,
    company_domain: c.other,
    company_website: `https://${c.other}`,
    stage: c.stage,
    announced_date: c.day,
    sources: [{ url: `https://${c.other}/news/round`, host: c.other }],
  });
  return { db, storedId: stored.id, reading };
}

async function roundsOf(db: Awaited<ReturnType<typeof testDb>>, companyId: string) {
  return (await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.companyId, companyId)))
    .map((r) => r.announcedOn)
    .sort();
}

describe("a reading for one company whose round id a namesake with another domain already holds", () => {
  test.each(cases)("the history lane leaves $name ($stored) whole and writes the round to $other", async (c) => {
    const { db, storedId, reading } = await namesake(c);
    await persistRecords(db, [reading], "series-a-b", "history-1", { history: true, companyId: c.other });
    expect(await db.select().from(schema.companyFolds)).toEqual([]);
    const [stored] = await db.select().from(schema.companies).where(eq(schema.companies.id, storedId));
    expect(stored?.domain).toBe(c.stored);
    expect(await roundsOf(db, storedId)).toEqual(["2022-09-08", c.day].sort());
    expect(await roundsOf(db, c.other)).toEqual([c.day]);
  });

  test.each(cases)("a feed reading leaves $name ($stored) whole too", async (c) => {
    const { db, storedId, reading } = await namesake(c);
    await persistRecords(db, [reading], "series-a-b", "run-2");
    expect(await db.select().from(schema.companyFolds)).toEqual([]);
    expect(await roundsOf(db, storedId)).toEqual(["2022-09-08", c.day].sort());
    expect(await roundsOf(db, c.other)).toEqual([c.day]);
  });

  test("a domain claim never folds a company that has a domain of its own", async () => {
    const { db, storedId } = await namesake(cases[0]);
    expect(await claimDomain(db, storedId, "odyssey.systems")).toBe(storedId);
    expect(await db.select().from(schema.companyFolds)).toEqual([]);
    expect(await roundsOf(db, storedId)).toEqual(["2022-09-08", "2026-06-17"]);
  });
});
