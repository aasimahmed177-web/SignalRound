import type { FeedRecord } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { describe, expect, test } from "vitest";
import { isDuplicateRound, isSameRound, persistRecords, type RoundIdentity } from "../lib/persist";
import { record, testDb } from "./helpers";

function nscale(total: boolean): FeedRecord {
  const value = total ? 3360 : 2360;
  return record({
    company_name: "Nscale",
    company_domain: "nscale.com",
    stage: total ? "growth" : "convertible",
    stage_as_written: total ? "growth financing" : "convertible financing initial tranche",
    amount: { value, currency: "USD", as_written: `$${value} million`, usd_millions: value, fx_rate: 1, fx_date: null },
    announced_date: "2026-09-24",
    financing_total_as_written: total ? null : "$3.36 billion",
    financing_total_quote: total ? null : "Nscale announced $3.36 billion, with $2.36 billion funded at closing.",
    amount_scope: total ? "financing_total" : "tranche",
    evidence_quotes: [`Nscale announced $${value} million in financing.`],
    sources: [{ url: `https://reuters.com/nscale-${total ? "total" : "closing"}`, host: "reuters.com" }],
  });
}

describe("stored financing totals deduplicate alternative readings", () => {
  test.each([
    [false, "2026-09-24"],
    [true, "2026-09-24"],
    [false, "2026-09-25"],
    [true, "2026-09-25"],
    [false, "2026-10-01"],
    [true, "2026-10-01"],
  ] as const)("Nscale remains one stored financing with total-first arrival %s on %s", async (totalFirst, date) => {
    const db = await testDb();
    const first = nscale(totalFirst);
    await persistRecords(db, [first], "growth", "first");
    const incoming = nscale(!totalFirst);
    incoming.announced_date = date;
    const second = await persistRecords(db, [incoming], "growth", "second");
    expect(second.inserted).toBe(0);
    const rows = await db.select().from(schema.fundingRounds);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].financingTotalAsWritten).toBe("$3.36 billion");
    expect(await db.select().from(schema.roundSources)).toHaveLength(2);
  });

  test("financing-total agreement overrides differing tranche labels only within its date window", () => {
    const stored = {
      stage: "convertible",
      announcedOn: "2026-09-24",
      amountUsdMillions: 2360,
      financingTotalAsWritten: "$3.36 billion",
      isExtension: true,
    };
    const incoming = { stage: "growth", announcedOn: "2026-09-24", amountUsdMillions: 3360 };
    expect(isSameRound(stored, incoming)).toBe(true);
    expect(isSameRound(incoming, stored)).toBe(true);
    expect(isSameRound(stored, { ...incoming, amountUsdMillions: 3200 })).toBe(true);
    expect(isSameRound(stored, { ...incoming, amountUsdMillions: 3100 })).toBe(false);
    expect(isSameRound(stored, { ...incoming, announcedOn: "2026-10-01" })).toBe(true);
    expect(isSameRound(stored, { ...incoming, announcedOn: "2026-10-02" })).toBe(false);
    expect(isSameRound(stored, { ...incoming, announcedOn: "2026-10-24" })).toBe(false);
    expect(isSameRound(stored, { ...incoming, stage: "convertible", announcedOn: "2026-11-08" })).toBe(true);
    expect(isSameRound(stored, { ...incoming, stage: "convertible", announcedOn: "2026-11-09" })).toBe(false);
  });

  test("a matching total cannot merge two different companies", () => {
    const base: RoundIdentity = {
      companyId: "nscale.com",
      nameKey: "nscale",
      domain: "nscale.com",
      aliasKeys: [],
      stage: "convertible",
      announcedOn: "2026-09-24",
      amountValue: 2360,
      amountCurrency: "USD",
      amountUsdMillions: 2360,
      financingTotalAsWritten: "$3.36 billion",
      sourceIds: [],
    };
    expect(
      isDuplicateRound(base, { ...base, companyId: "other.com", nameKey: "other", domain: "other.com", amountUsdMillions: 3360 }),
    ).toBe(false);
  });

  test("Plus Partners never inherits an existing PLUS Capital investor row", async () => {
    const db = await testDb();
    await db.insert(schema.investors).values({ id: "plus", name: "PLUS Capital" });
    const incoming = record({ company_name: "Acme", lead_investors: ["Plus Partners"] });
    await persistRecords(db, [incoming], "growth", "investor");
    const links = await db.select().from(schema.roundInvestors);
    expect(links.map((link) => link.investorId)).toEqual(["plus partners"]);
    const names = await db.select({ id: schema.investors.id, name: schema.investors.name }).from(schema.investors);
    expect(names).toEqual(
      expect.arrayContaining([
        { id: "plus", name: "PLUS Capital" },
        { id: "plus partners", name: "Plus Partners" },
      ]),
    );
  });
});
