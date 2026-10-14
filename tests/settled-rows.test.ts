// A reading that merges into a published row, or one a person checked, adds its sources and fills what the
// row lacks; it never moves the row's facts. Revolut's published £6.75M Series A came back as "$10 million",
// expected, in review, from one TechCrunch page that said the company "is raising" it; Unitree's published
// Series C lost its 8 billion yuan valuation and went back to review on a second Chinese page.

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { persistRecords, setDisposition } from "../lib/persist";
import { record, testDb } from "./helpers";

type Db = Awaited<ReturnType<typeof testDb>>;
const row = async (db: Db, id: string) => (await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, id)))[0];

const revolutA = (over: Partial<Parameters<typeof record>[0]> = {}) =>
  record({
    company_name: "Revolut",
    stage: "series_a",
    stage_as_written: "Series A",
    announced_date: "2016-07-11",
    amount: { value: 6.75, currency: "GBP", as_written: "£6.75m", usd_millions: 8.764, fx_rate: 0.77018, fx_date: "2016-07-11" },
    lead_investors: ["Balderton Capital"],
    evidence_quotes: ["Revolut has landed up to £6.75m in Series A funding in a round led by Balderton Capital."],
    sources: [{ url: "https://www.uktech.news/revolut-gets-6-5m-round-led-balderton-capital", host: "uktech.news" }],
    verification: { status: "confirmed", notes: [], url: "https://www.uktech.news/revolut-gets-6-5m-round-led-balderton-capital" },
    ...over,
  });

const techcrunch = {
  amount: { value: 10, currency: "USD", as_written: "$10 million", usd_millions: 10, fx_rate: 1, fx_date: "2016-07-11" },
  certainty: "expected" as const,
  evidence_quotes: ["And the company is raising a $10 million Series A (£7.75 million) with Balderton Capital leading the round."],
  sources: [
    {
      url: "https://techcrunch.com/2016/07/11/revolut-grabs-10-million",
      host: "techcrunch.com",
      evidence: "And the company is raising a $10 million Series A (£7.75 million) with Balderton Capital leading the round.",
    },
  ],
  verification: {
    status: "confirmed" as const,
    notes: ["held for review: the amount $10 million is at or above the financing total £7.75 million"],
    url: "https://techcrunch.com/2016/07/11/revolut-grabs-10-million",
    sources_seen: 1,
  },
};

const unitreeC = (over: Partial<Parameters<typeof record>[0]> = {}) =>
  record({
    company_name: "Unitree Robotics",
    company_key: "unitree robotics",
    stage: "series_c",
    stage_as_written: "Series C funding",
    announced_date: "2024-09-24",
    amount: { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null },
    valuation_as_written: "8 billion yuan",
    valuation_claims: [
      {
        value: "8 billion yuan",
        quote: "Unitree's post-investment valuation stands at 8 billion yuan",
        url: "https://en.tmtpost.com/post/7263532",
        tier: 0.3,
      },
    ],
    lead_investors: [],
    evidence_quotes: ["Unitree Robotics has raised several billion yuan in Series C funding."],
    sources: [{ url: "https://en.tmtpost.com/post/7263532", host: "tmtpost.com" }],
    verification: { status: "confirmed", notes: [], url: "https://en.tmtpost.com/post/7263532" },
    ...over,
  });

async function stored(db: Db, r: ReturnType<typeof record>, companyId: string, place: (id: string) => Promise<void>) {
  await db.insert(schema.companies).values({ id: companyId, name: r.company_name, nameKey: r.company_key, domain: companyId });
  await persistRecords(db, [r], "growth", "run-1", { history: true, companyId });
  await place(r.id);
  return r.id;
}

describe("a reading merged into a settled row", () => {
  test("Revolut's published Series A keeps its amount, certainty and place when one page says it is being raised", async () => {
    const db = await testDb();
    const id = await stored(db, revolutA(), "revolut.com", (id) =>
      db
        .update(schema.fundingRounds)
        .set({ disposition: "publish" })
        .where(eq(schema.fundingRounds.id, id))
        .then(() => undefined),
    );
    await persistRecords(db, [revolutA(techcrunch)], "growth", "history-2", { history: true, companyId: "revolut.com" });
    const after = await row(db, id);
    expect(after).toMatchObject({
      disposition: "publish",
      amountAsWritten: "£6.75m",
      amountCurrency: "GBP",
      certainty: "announced",
      announcedOn: "2016-07-11",
      stage: "series_a",
    });
    const linked = await db.select().from(schema.roundSources).where(eq(schema.roundSources.roundId, id));
    expect(linked.map((l) => l.sourceId)).toContain("https://techcrunch.com/2016/07/11/revolut-grabs-10-million");
  });

  test("Unitree's published Series C keeps its stage label and valuation, and fills only what it lacked", async () => {
    const db = await testDb();
    const id = await stored(db, unitreeC(), "unitree-robotics", (id) =>
      db
        .update(schema.fundingRounds)
        .set({ disposition: "publish" })
        .where(eq(schema.fundingRounds.id, id))
        .then(() => undefined),
    );
    await persistRecords(
      db,
      [
        unitreeC({
          stage_as_written: "C轮融资",
          valuation_as_written: null,
          valuation_claims: [],
          amount: { value: 500, currency: "CNY", as_written: "5亿元人民币", usd_millions: 70, fx_rate: 7.1, fx_date: "2024-09-24" },
          sources: [{ url: "https://www.tmtpost.com/7262451.html", host: "tmtpost.com" }],
          verification: {
            status: "corrected",
            notes: ["held for review: source fidelity is not independent confirmation"],
            url: "https://www.tmtpost.com/7262451.html",
            sources_seen: 1,
          },
        }),
      ],
      "growth",
      "history-2",
      { history: true, companyId: "unitree-robotics" },
    );
    expect(await row(db, id)).toMatchObject({
      disposition: "publish",
      stageAsWritten: "Series C funding",
      valuationAsWritten: "8 billion yuan",
      amountAsWritten: "5亿元人民币",
      amountCurrency: "CNY",
    });
  });

  test("a published row a reading confirmed on two pages takes the corrected figure", async () => {
    const db = await testDb();
    const id = await stored(db, revolutA(), "revolut.com", (id) =>
      db
        .update(schema.fundingRounds)
        .set({ disposition: "publish" })
        .where(eq(schema.fundingRounds.id, id))
        .then(() => undefined),
    );
    await persistRecords(
      db,
      [revolutA({ ...techcrunch, certainty: "announced", verification: { ...techcrunch.verification, notes: [], sources_seen: 2 } })],
      "growth",
      "history-2",
      { history: true, companyId: "revolut.com" },
    );
    expect(await row(db, id)).toMatchObject({ amountAsWritten: "$10 million", amountCurrency: "USD" });
  });

  test("a row a person published keeps its facts against a corroborated reading and is flagged for a person", async () => {
    const db = await testDb();
    const id = await stored(db, revolutA(), "revolut.com", (id) => setDisposition(db, id, "publish"));
    await persistRecords(
      db,
      [revolutA({ ...techcrunch, certainty: "announced", verification: { ...techcrunch.verification, notes: [], sources_seen: 2 } })],
      "growth",
      "history-2",
      { history: true, companyId: "revolut.com" },
    );
    expect(await row(db, id)).toMatchObject({ disposition: "flagged", amountAsWritten: "£6.75m", amountCurrency: "GBP" });
  });

  test("a row in review still follows the reading", async () => {
    const db = await testDb();
    const id = await stored(db, revolutA(), "revolut.com", (id) =>
      db
        .update(schema.fundingRounds)
        .set({ disposition: "review" })
        .where(eq(schema.fundingRounds.id, id))
        .then(() => undefined),
    );
    await persistRecords(db, [revolutA(techcrunch)], "growth", "history-2", { history: true, companyId: "revolut.com" });
    expect(await row(db, id)).toMatchObject({ amountAsWritten: "$10 million", disposition: "review" });
  });
});
