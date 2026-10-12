import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { describe, expect, test } from "vitest";
import { corroborateRecord } from "../lib/corroborate";
import {
  hasNamedCompanyInResults,
  INVESTOR_SORTS,
  listCompanies,
  listInvestors,
  pageWindow,
  parseDirectoryParams,
  searchDirectory,
} from "../lib/directory";
import { persistRecords, setDisposition } from "../lib/persist";
import { record, testDb } from "./helpers";

const usd = (m: number, date: string) => ({ value: m, currency: "USD", as_written: `$${m}M`, usd_millions: m, fx_rate: 1, fx_date: date });

/**
 * Acme: a seed and a Series A (Big Fund leads the A). Beta: one Series B, the largest round.
 * Gamma: a seed, then moved to review, so it never shows. Big Fund also participates in Beta.
 */
async function seed() {
  const db = await testDb();
  const acmeSeed = record({
    company_name: "Acme",
    company_domain: "acme.com",
    company_description: "Payments for robots",
    stage: "seed",
    announced_date: "2026-03-01",
    amount: usd(5, "2026-03-01"),
    lead_investors: ["Angel Co"],
  });
  const acmeA = record({
    company_name: "Acme",
    company_domain: "acme.com",
    stage: "series_a",
    announced_date: "2026-08-01",
    amount: usd(20, "2026-08-01"),
    lead_investors: ["Big Fund"],
  });
  const beta = record({
    company_name: "Beta",
    stage: "series_b",
    sector: "energy",
    announced_date: "2026-06-15",
    amount: usd(80, "2026-06-15"),
    lead_investors: ["North Fund"],
    other_investors: ["Big Fund"],
  });
  const gamma = record({ company_name: "Gamma", stage: "seed", announced_date: "2026-09-01", lead_investors: ["Hidden Fund"] });
  await persistRecords(db, [acmeSeed, acmeA, beta, gamma], "series-a-b", "run-1");
  const client = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
  for (const id of [acmeSeed.id, acmeA.id, beta.id]) await corroborateRecord(db, client, id, { broad: true, maxPages: 0 });
  await setDisposition(db, gamma.id, "review");
  return { db };
}

describe("parseDirectoryParams", () => {
  const sorts = ["latest", "raised", "name"] as const;
  test("defaults for an empty or hostile query string", () => {
    expect(parseDirectoryParams({}, sorts)).toEqual({ q: "", sort: "latest", page: 1 });
    expect(parseDirectoryParams({ sort: "drop table", page: "-3" }, sorts)).toEqual({ q: "", sort: "latest", page: 1 });
    expect(parseDirectoryParams({ page: "abc" }, sorts).page).toBe(1);
  });
  test("reads q trimmed, a known sort, and the first of repeated params", () => {
    expect(parseDirectoryParams({ q: "  acme ", sort: "name", page: ["3", "9"] }, sorts)).toEqual({ q: "acme", sort: "name", page: 3 });
  });
  test("the investors index opens on the firms that led the most rounds, and still reads latest", () => {
    expect(parseDirectoryParams({}, INVESTOR_SORTS).sort).toBe("led");
    expect(parseDirectoryParams({ sort: "latest" }, INVESTOR_SORTS).sort).toBe("latest");
  });
});

describe("pageWindow", () => {
  test("clamps past the end and reports the span shown", () => {
    expect(pageWindow(120, 1, 50)).toEqual({ page: 1, pages: 3, offset: 0, from: 1, to: 50 });
    expect(pageWindow(120, 3, 50)).toEqual({ page: 3, pages: 3, offset: 100, from: 101, to: 120 });
    expect(pageWindow(120, 9, 50).page).toBe(3);
  });
  test("an empty list is one empty page", () => {
    expect(pageWindow(0, 4, 50)).toEqual({ page: 1, pages: 1, offset: 0, from: 0, to: 0 });
  });
});

describe("listCompanies", () => {
  test("only companies with a visible round; counts, totals, and the newest round", async () => {
    const { db } = await seed();
    const page = await listCompanies(db);
    expect(page.total).toBe(2);
    expect(page.rows.map((c) => c.name)).toEqual(["Acme", "Beta"]);
    const acme = page.rows[0];
    expect(acme.rounds).toBe(2);
    expect(acme.usd_millions_raised).toBe(25);
    expect(acme.latest).toMatchObject({ stage: "series_a", announced_on: "2026-08-01" });
  });

  test("sorts by total raised and by name", async () => {
    const { db } = await seed();
    expect((await listCompanies(db, { sort: "raised" })).rows.map((c) => c.name)).toEqual(["Beta", "Acme"]);
    expect((await listCompanies(db, { sort: "name" })).rows.map((c) => c.name)).toEqual(["Acme", "Beta"]);
  });

  test("latest breaks a shared day by the most recently found, not the name", async () => {
    const db = await testDb();
    const day = "2026-09-23";
    await persistRecords(db, [record({ company_name: "Zeliq", company_key: "zeliq", announced_date: day })], "series-a-b", "run-1");
    await persistRecords(db, [record({ company_name: "Aardvark", company_key: "aardvark", announced_date: day })], "series-a-b", "run-2");
    const client = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
    for (const id of [`zeliq:series_a:${day}`, `aardvark:series_a:${day}`])
      await corroborateRecord(db, client, id, { broad: true, maxPages: 0 });
    await db
      .update(schema.fundingRounds)
      .set({ firstSeenAt: new Date("2026-09-23T08:00:00Z") })
      .where(eq(schema.fundingRounds.companyId, "aardvark"));
    await db
      .update(schema.fundingRounds)
      .set({ firstSeenAt: new Date("2026-09-23T20:00:00Z") })
      .where(eq(schema.fundingRounds.companyId, "zeliq"));
    expect((await listCompanies(db, { sort: "latest" })).rows.map((c) => c.name)).toEqual(["Zeliq", "Aardvark"]);
  });

  test("searches name, description, sector, and domain; wildcards are literal", async () => {
    const { db } = await seed();
    expect((await listCompanies(db, { q: "robots" })).rows.map((c) => c.name)).toEqual(["Acme"]);
    expect((await listCompanies(db, { q: "energy" })).rows.map((c) => c.name)).toEqual(["Beta"]);
    expect((await listCompanies(db, { q: "acme.com" })).rows.map((c) => c.name)).toEqual(["Acme"]);
    expect((await listCompanies(db, { q: "gamma" })).total).toBe(0);
    expect((await listCompanies(db, { q: "%" })).total).toBe(2);
  });

  test("pages", async () => {
    const { db } = await seed();
    const second = await listCompanies(db, { pageSize: 1, page: 2 });
    expect(second).toMatchObject({ total: 2, page: 2, pages: 2, from: 2, to: 2 });
    expect(second.rows.map((c) => c.name)).toEqual(["Beta"]);
  });

  test("a company named on another search page still counts as a name match", async () => {
    const { db } = await seed();
    await db.update(schema.companies).set({ description: "An Acme competitor" }).where(eq(schema.companies.name, "Beta"));
    const second = await listCompanies(db, { q: "acme", sort: "name", pageSize: 1, page: 2 });
    expect(second.rows.map((c) => c.name)).toEqual(["Beta"]);
    expect(await hasNamedCompanyInResults(db, "acme")).toBe(true);
    expect(await hasNamedCompanyInResults(db, "competitor")).toBe(false);
  });
});

describe("listInvestors", () => {
  test("seats over visible rounds only; the newest round names its company", async () => {
    const { db } = await seed();
    const page = await listInvestors(db);
    expect(page.rows.map((i) => i.name)).not.toContain("Hidden Fund");
    const big = page.rows.find((i) => i.name === "Big Fund");
    expect(big).toMatchObject({ led: 1, participated: 1, total: 2 });
    expect(big?.latest).toMatchObject({ company: "Acme", stage: "series_a", announced_on: "2026-08-01" });
    // Latest activity first: Big Fund's Acme A (Aug) ahead of North Fund's Beta B (Jun) and Angel Co's seed (Mar).
    expect(page.rows.map((i) => i.name)).toEqual(["Big Fund", "North Fund", "Angel Co"]);
  });

  test("sorts by rounds, led, and name; searches by name", async () => {
    const { db } = await seed();
    expect((await listInvestors(db, { sort: "rounds" })).rows[0].name).toBe("Big Fund");
    expect((await listInvestors(db, { sort: "name" })).rows.map((i) => i.name)).toEqual(["Angel Co", "Big Fund", "North Fund"]);
    expect((await listInvestors(db, { q: "north" })).rows.map((i) => i.name)).toEqual(["North Fund"]);
  });

  test("an investor's resolved domain reaches the index and the command palette; unknown stays null", async () => {
    const { db } = await seed();
    await db.update(schema.investors).set({ domain: "bigfund.vc" }).where(eq(schema.investors.id, "big"));
    const rows = (await listInvestors(db, { sort: "name" })).rows;
    expect(rows.map((i) => [i.name, i.domain])).toEqual([
      ["Angel Co", null],
      ["Big Fund", "bigfund.vc"],
      ["North Fund", null],
    ]);
    expect((await searchDirectory(db, "big")).investors[0]).toMatchObject({ kind: "investor", name: "Big Fund", domain: "bigfund.vc" });
  });
});

describe("searchDirectory", () => {
  test("prefix matches rank first, hidden entities never match, blank queries return nothing", async () => {
    const { db } = await seed();
    const hits = await searchDirectory(db, "fund");
    expect(hits.investors.map((i) => i.name)).toEqual(["Big Fund", "North Fund"]);
    expect((await searchDirectory(db, "n")).investors[0].name).toBe("North Fund");
    expect((await searchDirectory(db, "gamma")).companies).toEqual([]);
    expect((await searchDirectory(db, "hidden")).investors).toEqual([]);
    expect(await searchDirectory(db, "  %  ")).toEqual({ companies: [], investors: [] });
    expect((await searchDirectory(db, "acme.com")).companies[0]).toMatchObject({ kind: "company", name: "Acme", detail: "acme.com" });
  });
});
