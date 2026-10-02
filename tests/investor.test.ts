import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { listInvestors } from "../lib/directory";
import { getInvestor } from "../lib/investor";
import { persistRecords, setDisposition } from "../lib/persist";
import { record, testDb } from "./helpers";

/** Big Fund leads Acme's A and B and Beta's A, and participates in Gamma's seed beside Angel Co. */
async function seed() {
  const db = await testDb();
  const acmeA = record({
    company_name: "Acme",
    company_domain: "acme.com",
    stage: "series_a",
    sector: "fintech",
    announced_date: "2026-03-02",
    lead_investors: ["Big Fund"],
    other_investors: ["Angel Co"],
  });
  const acmeB = record({
    company_name: "Acme",
    company_domain: "acme.com",
    stage: "series_b",
    sector: "fintech",
    announced_date: "2026-09-02",
    amount: { value: 60, currency: "USD", as_written: "$60M", usd_millions: 60, fx_rate: 1, fx_date: "2026-09-02" },
    lead_investors: ["Big Fund", "Second Fund"],
  });
  const beta = record({
    company_name: "Beta",
    evidence_quotes: ["Beta raised $20M."],
    sources: [{ url: "https://reuters.com/beta-series-a", host: "reuters.com", title: "Beta raises $20M" }],
    stage: "series_a",
    sector: "energy",
    announced_date: "2026-08-20",
    lead_investors: ["Big Fund"],
    other_investors: ["Angel Co"],
  });
  const gamma = record({
    company_name: "Gamma",
    evidence_quotes: ["Gamma raised $5M."],
    sources: [{ url: "https://reuters.com/gamma-seed", host: "reuters.com", title: "Gamma raises $5M seed" }],
    stage: "seed",
    sector: "energy",
    announced_date: "2026-07-01",
    amount: { value: 5, currency: "USD", as_written: "$5M", usd_millions: 5, fx_rate: 1, fx_date: "2026-07-01" },
    lead_investors: ["Angel Co"],
    other_investors: ["Big Fund"],
  });
  await persistRecords(db, [acmeA, acmeB, beta, gamma], "series-a-b", "run-1");
  for (const item of [acmeA, acmeB, beta, gamma]) await setDisposition(db, item.id, "publish");
  return { db, acmeA, acmeB, beta, gamma };
}

describe("getInvestor", () => {
  test("null for an id the store does not hold", async () => {
    const { db } = await seed();
    expect(await getInvestor(db, "nobody")).toBeNull();
  });

  test("rounds newest first with the seat taken on each; totals split led from participated", async () => {
    const { db, acmeA, acmeB, beta, gamma } = await seed();
    const page = await getInvestor(db, "big");
    expect(page?.investor).toEqual({
      id: "big",
      name: "Big Fund",
      domain: null,
      logo_url: null,
      kind: null,
      description: null,
      headquarters: null,
    });
    expect(page?.rounds.map((r) => [r.id, r.role])).toEqual([
      [acmeB.id, "lead"],
      [beta.id, "lead"],
      [gamma.id, "participant"],
      [acmeA.id, "lead"],
    ]);
    // Acme's $60M B is co-led with Second Fund, so Big Fund's share of it is $30M: 20 + 30 + 20.
    expect(page?.totals).toEqual({ led: 3, co_led: 1, participated: 1, lead_share_usd_millions: 70 });
  });

  test("the investor and its co-investors carry their resolved domains, for their logos", async () => {
    const { db } = await seed();
    await db.update(schema.investors).set({ domain: "bigfund.vc" }).where(eq(schema.investors.id, "big"));
    await db.update(schema.investors).set({ domain: "angel.co.uk" }).where(eq(schema.investors.id, "angel"));
    const page = await getInvestor(db, "big");
    expect(page?.investor.domain).toBe("bigfund.vc");
    expect(page?.co_investors.map((c) => [c.id, c.domain])).toEqual([
      ["angel", "angel.co.uk"],
      ["second", null],
    ]);
  });

  test("a rejected round leaves the investor's record", async () => {
    const { db, gamma } = await seed();
    await setDisposition(db, gamma.id, "rejected");
    const page = await getInvestor(db, "big");
    expect(page?.rounds).toHaveLength(3);
    expect(page?.totals.participated).toBe(0);
    expect(page?.co_investors.find((c) => c.id === "angel")?.rounds).toBe(2);
  });

  test("a round in review is left out for every viewer, so the page matches /investors", async () => {
    const { db, gamma } = await seed();
    await setDisposition(db, gamma.id, "review");
    const listed = (await listInvestors(db, { q: "Big Fund" })).rows.find((i) => i.id === "big");
    for (const page of [await getInvestor(db, "big"), await getInvestor(db, "big", true)]) {
      expect(page?.rounds.map((r) => r.disposition)).toEqual(["publish", "publish", "publish"]);
      expect(page?.rounds).toHaveLength(listed?.total ?? -1);
      expect(page?.totals).toEqual({ led: 3, co_led: 1, participated: 0, lead_share_usd_millions: 70 });
    }
  });

  test("an investor named only off the feed is null for a visitor, an empty record for an admin", async () => {
    const { db, acmeB } = await seed();
    // Second Fund co-leads Acme's B and nothing else.
    await setDisposition(db, acmeB.id, "review");
    expect(await getInvestor(db, "second")).toBeNull();
    const admin = await getInvestor(db, "second", true);
    expect(admin?.investor.name).toBe("Second Fund");
    expect(admin?.rounds).toEqual([]);
    expect(admin?.totals).toEqual({ led: 0, co_led: 0, participated: 0, lead_share_usd_millions: 0 });
  });

  test("co-investors ranked by shared rounds; sectors and stages counted over the rounds", async () => {
    const { db } = await seed();
    const page = await getInvestor(db, "big");
    expect(page?.co_investors).toEqual([
      { id: "angel", name: "Angel Co", domain: null, logo_url: null, rounds: 3 },
      { id: "second", name: "Second Fund", domain: null, logo_url: null, rounds: 1 },
    ]);
    expect(page?.sectors).toEqual([
      { sector: "energy", count: 2 },
      { sector: "fintech", count: 2 },
    ]);
    expect(page?.stages).toEqual([
      { stage: "series_a", count: 2 },
      { stage: "seed", count: 1 },
      { stage: "series_b", count: 1 },
    ]);
  });
});
