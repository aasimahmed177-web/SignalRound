// The valuation repair: published rounds with no valuation whose own linked page states one for the
// round. Quantexa's Series F is the production case: its read-back ruled the valuation out on an older
// check, and the row was published by hand without it.

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { persistRecords } from "../lib/persist";
import { applyRecordFixes } from "../lib/repair";
import { planValuationRepair } from "../lib/valuation-repair";
import { record, testDb } from "./helpers";

const TC = "https://techcrunch.com/2025/03/04/quantexa-nabs-175m";

describe("valuation repair", () => {
  test("Quantexa: the page's post-money valuation for this round is proposed, with its sentence; an earlier round's is not", async () => {
    const db = await testDb();
    const quantexa = record({
      company_name: "Quantexa",
      stage: "series_d_plus",
      amount: { value: 175, currency: "USD", as_written: "$175 million", usd_millions: 175, fx_rate: 1, fx_date: "2025-03-04" },
      sources: [{ url: TC, host: "techcrunch.com", title: "Quantexa nabs $175M at $2.6B valuation" }],
    });
    const helcim = record({
      company_name: "Helcim",
      amount: { value: 20, currency: "USD", as_written: "$20 million", usd_millions: 20, fx_rate: 1, fx_date: "2026-09-02" },
      sources: [{ url: "https://news.example/helcim", host: "news.example", title: "Helcim raises $20 million" }],
    });
    await persistRecords(db, [quantexa, helcim], "growth", "run-1");
    await db.update(schema.fundingRounds).set({ disposition: "publish" });
    const sentence =
      "The funding, a Series F, values Quantexa at $2.6 billion post-money — a significant jump from its last valuation of $1.8 billion in 2023.";
    const read = (company: string, amount: string, valuation: string) => ({
      rounds: [{ company_name: company, amount_as_written: amount, valuation_as_written: valuation }],
    });
    await db.insert(schema.pageSnapshots).values([
      { hash: "quantexa", markdown: `Quantexa has raised a fresh $175 million.\n\n${sentence}` },
      { hash: "helcim", markdown: "Helcim raised $20 million. Helcim was valued at $97 million at its Series B in 2024." },
    ]);
    await db.insert(schema.pageSnapshotReads).values([
      { sourceUrl: TC, snapshotHash: "quantexa", rawExtraction: read("Quantexa", "$175 million", "$2.6 billion") },
      { sourceUrl: "https://news.example/helcim", snapshotHash: "helcim", rawExtraction: read("Helcim", "$20 million", "$97 million") },
    ]);

    const plan = await planValuationRepair(db);
    expect(plan).toEqual([
      expect.objectContaining({
        kind: "valuation",
        round: quantexa.id,
        from: null,
        valuation: "$2.6 billion post-money",
        evidence: TC,
        quote: sentence,
      }),
    ]);

    const { company: _company, amount: _amount, ...fix } = plan[0] as (typeof plan)[number];
    expect((await applyRecordFixes(db, [fix], { apply: true })).applied).toBe(1);
    const [row] = await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, quantexa.id));
    expect(row?.valuationAsWritten).toBe("$2.6 billion post-money");
    expect(await planValuationRepair(db)).toEqual([]);
  });
});
