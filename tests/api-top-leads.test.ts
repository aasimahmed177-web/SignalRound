// The most active leads list every round each one led in the window, so an answer can name them all.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { beforeAll, expect, test } from "vitest";
import { GET as topGet } from "../app/api/v1/investors/top/route";
import { db } from "../lib/db";
import { persistRecords, setDisposition } from "../lib/persist";
import { record } from "./helpers";
import { isoDaysAgo } from "./history-fixtures";

const LED = ["Kappa", "Lambda", "Mu", "Nu", "Xi"];

beforeAll(async () => {
  const handle = await db();
  for (const [i, name] of LED.entries()) {
    const day = isoDaysAgo(i + 1);
    const summary = await persistRecords(
      handle,
      [
        record({
          company_name: name,
          company_key: name.toLowerCase(),
          company_domain: `${name.toLowerCase()}.example`,
          announced_date: day,
          sector: "ai",
          amount: { value: 10, currency: "USD", as_written: "$10M", usd_millions: 10, fx_rate: 1, fx_date: day },
          lead_investors: ["Busy Fund"],
          evidence_quotes: [`${name} raised $10M led by Busy Fund.`],
          sources: [
            { url: `https://news.example/${name.toLowerCase()}`, host: "news.example", title: `${name} raises $10M`, published: day },
          ],
        }),
      ],
      "series-a-b",
      `run-${name}`,
    );
    await setDisposition(handle, summary.persistedIds[0] as string, "publish");
  }
});

test("an investor that led five rounds in the window lists all five, newest first", async () => {
  const res = await topGet(new Request("http://app.test/api/v1/investors/top?window=30d"));
  const body = (await res.json()) as { data: Array<{ name: string; rounds_led: number; led_rounds: Array<{ company: string }> }> };
  const busy = body.data.find((r) => r.name === "Busy Fund");
  expect(busy?.rounds_led).toBe(5);
  expect(busy?.led_rounds.map((r) => r.company)).toEqual(LED);
});
