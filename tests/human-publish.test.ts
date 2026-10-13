// A row a person published stays published when a later reading only doubts it. Ramp's Series C
// ($300M at $3.9B) was published by hand at 16:48 on Oct 13 2026 and was back in review an hour
// later, when a history reading linked a TechCrunch page and carried a same-name doubt with it.

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { persistRecords, setDisposition } from "../lib/persist";
import { record, testDb } from "./helpers";

const seriesC = (over: Parameters<typeof record>[0] extends infer P ? Partial<P> : never = {}) =>
  record({
    company_name: "Ramp",
    stage: "series_c",
    announced_date: "2021-08-24",
    amount: { value: 300, currency: "USD", as_written: "$300M", usd_millions: 300, fx_rate: 1, fx_date: "2021-08-24" },
    sources: [{ url: "https://techcrunch.com/2021/08/24/ramp-series-c", host: "techcrunch.com" }],
    verification: { status: "confirmed", notes: [], url: "https://techcrunch.com/2021/08/24/ramp-series-c" },
    ...over,
  });

async function published() {
  const db = await testDb();
  await db.insert(schema.companies).values({ id: "ramp.com", name: "Ramp", nameKey: "ramp", domain: "ramp.com" });
  const r = seriesC();
  await persistRecords(db, [r], "growth", "run-1", { history: true, companyId: "ramp.com" });
  await setDisposition(db, r.id, "publish");
  return { db, id: r.id };
}

const row = async (db: Awaited<ReturnType<typeof testDb>>, id: string) =>
  (await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, id)))[0];

describe("a row a person published", () => {
  test("stays published when a later reading of the same company and amount carries a doubt", async () => {
    const { db, id } = await published();
    await persistRecords(
      db,
      [seriesC({ sources: [{ url: "https://techcrunch.com/2021/08/24/ramp-valuation", host: "techcrunch.com" }] })],
      "growth",
      "history-2",
      { history: true, companyId: "ramp.com" },
    );
    const after = await row(db, id);
    expect((after?.verification as { notes: string[] } | undefined)?.notes).toContain(
      "held for review: same-name company identity is unverified",
    );
    expect(after?.disposition).toBe("publish");
  });

  test("goes back to review when the doubting reading states another amount", async () => {
    const { db, id } = await published();
    await persistRecords(
      db,
      [
        seriesC({
          amount: { value: 625, currency: "USD", as_written: "$625M", usd_millions: 625, fx_rate: 1, fx_date: "2021-08-24" },
          sources: [{ url: "https://techcrunch.com/2021/08/24/ramp-valuation", host: "techcrunch.com" }],
        }),
      ],
      "growth",
      "history-2",
      { history: true, companyId: "ramp.com" },
    );
    expect((await row(db, id))?.disposition).toBe("review");
  });
});
