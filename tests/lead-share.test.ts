// An investor is credited its share of a round it co-led, never the whole round (P1-13): Sequoia was
// one of ten co-leads on Anthropic's $65B round, and its page summed all $65B as "LED".
import { describe, expect, test } from "vitest";
import { getInvestor } from "../lib/investor";
import { persistRecords, setDisposition } from "../lib/persist";
import { market } from "../lib/stats";
import { record, testDb } from "./helpers";
import { isoDaysAgo } from "./history-fixtures";

describe("lead share", () => {
  test("a co-led round's amount is split evenly between its leads on the investor page and in the Overview's leads", async () => {
    const db = await testDb();
    const coLed = record({
      company_name: "Colead",
      stage: "series_b",
      announced_date: isoDaysAgo(3),
      amount: { value: 90, currency: "USD", as_written: "$90M", usd_millions: 90, fx_rate: 1, fx_date: null },
      lead_investors: ["Fund One", "Fund Two", "Fund Three"],
    });
    const solo = record({
      company_name: "Solo",
      stage: "series_a",
      announced_date: isoDaysAgo(4),
      amount: { value: 10, currency: "USD", as_written: "$10M", usd_millions: 10, fx_rate: 1, fx_date: null },
      lead_investors: ["Fund One"],
    });
    const { insertedIds } = await persistRecords(db, [coLed, solo], "series-a-b", "run-1");
    for (const id of insertedIds) await setDisposition(db, id, "publish");

    const page = await getInvestor(db, "fund one");
    expect(page?.totals).toEqual({ led: 2, co_led: 1, participated: 0, lead_share_usd_millions: 40 });
    expect((await market(db)).top_leads.map((l) => [l.name, l.leads, l.usd_millions])).toEqual([
      ["Fund One", 2, 40],
      ["Fund Three", 1, 30],
      ["Fund Two", 1, 30],
    ]);
  });
});
