import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { getCompany } from "../lib/company.ts";
import { listCompanies } from "../lib/directory.ts";
import { listRounds, persistRecords, setDisposition } from "../lib/persist.ts";
import { demoStats, market, overview } from "../lib/stats.ts";
import { record, testDb } from "./helpers.ts";

describe("certainty and capital stats", () => {
  test("expected rounds stay visible but do not count as raised capital; reported rounds do", async () => {
    const db = await testDb();
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    for (const [name, certainty, amount] of [
      ["Forecast", "expected", 750],
      ["Sourced", "reported", 20],
      ["Released", "announced", 10],
    ] as const) {
      const r = record({
        company_name: name,
        announced_date: day,
        certainty,
        amount: { value: amount, currency: "USD", as_written: `$${amount}M`, usd_millions: amount, fx_rate: 1, fx_date: day },
      });
      await persistRecords(db, [r], "series-a-b", `certainty:${name}`);
      await setDisposition(db, r.id, "publish");
    }
    expect((await listRounds(db)).rows).toHaveLength(3);
    expect((await market(db)).week).toMatchObject({ rounds: 2, usd_millions: 30, with_amount: 2 });
    expect(await demoStats(db)).toMatchObject({ rounds_7d: 2, usd_7d: 30 });
    expect(await overview(db, 7)).toMatchObject({ rounds: 2, total_usd_millions: 30 });
    const companies = await listCompanies(db);
    expect(companies.rows.find((c) => c.name === "Forecast")?.usd_millions_raised).toBeNull();
    expect(companies.rows.find((c) => c.name === "Sourced")?.usd_millions_raised).toBe(20);
    expect((await getCompany(db, "forecast"))?.totals.usd_millions_raised).toBe(0);
    await db
      .update(schema.fundingRounds)
      .set({ certainty: "unconfirmed" })
      .where(eq(schema.fundingRounds.id, `forecast:series_a:${day}`));
    expect((await listRounds(db)).rows.map((r) => r.company.name)).not.toContain("Forecast");
    expect((await listRounds(db, { certainty: "all" })).rows.map((r) => r.company.name)).toContain("Forecast");
    expect((await listRounds(db, { certainty: "unconfirmed" })).rows).toHaveLength(1);
  });
});
