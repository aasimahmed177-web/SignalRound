// A company stored with its domain gets no second row under its name. Ramp (ramp.com) got a "ramp-2"
// from a news roundup that named it and gave no site; Crusoe (crusoe.ai) got a "crusoe-2" from a
// reading whose site was www.crusoe.ai. Each twin then took the history lane's rounds for the company.

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { mergeCompanies, persistRecords, publisherDomain } from "../lib/persist";
import { applyRecordFixes, type RecordFix } from "../lib/repair";
import { record, testDb } from "./helpers";

const HOLD = "held for review: same-name company identity is unverified";

async function ramp() {
  const db = await testDb();
  await persistRecords(
    db,
    [
      record({
        company_name: "Ramp",
        company_domain: "ramp.com",
        company_website: "https://ramp.com",
        stage: "series_d_plus",
        announced_date: "2025-06-17",
        sources: [{ url: "https://ramp.com/blog/series-e", host: "ramp.com" }],
      }),
    ],
    "growth",
    "run-1",
  );
  return db;
}

const companyIds = async (db: Awaited<ReturnType<typeof testDb>>) =>
  (await db.select({ id: schema.companies.id }).from(schema.companies)).map((c) => c.id).sort();

describe("a reading that names a stored company", () => {
  test("with no domain and no site lands on the company holding the name, held for review", async () => {
    const db = await ramp();
    const roundup = record({
      company_name: "Ramp",
      stage: "other",
      announced_date: "2020-02-12",
      sources: [{ url: "https://citybiz.co/article/ramp", host: "citybiz.co" }],
    });
    await persistRecords(db, [roundup], "growth", "run-2");
    expect(await companyIds(db)).toEqual(["ramp.com"]);
    const rows = await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.companyId, "ramp.com"));
    expect(rows).toHaveLength(2);
    const held = rows.find((r) => r.announcedOn === "2020-02-12");
    expect(held?.disposition).toBe("review");
    expect((held?.verification as { notes: string[] } | undefined)?.notes).toContain(HOLD);
  });

  test("with the company's own site as its site lands on the company", async () => {
    const db = await ramp();
    await persistRecords(
      db,
      [
        record({
          company_name: "Ramp",
          company_website: "https://www.ramp.com/",
          stage: "series_c",
          announced_date: "2022-03-21",
          sources: [{ url: "https://techcrunch.com/2022/03/21/ramp", host: "techcrunch.com" }],
        }),
      ],
      "growth",
      "run-2",
    );
    expect(await companyIds(db)).toEqual(["ramp.com"]);
    const [row] = await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.announcedOn, "2022-03-21"));
    expect((row?.verification as { notes: string[] } | null)?.notes ?? []).not.toContain(HOLD);
  });

  test("with headquarters elsewhere is another company", async () => {
    const db = await ramp();
    await db.update(schema.companies).set({ hq: "New York" }).where(eq(schema.companies.id, "ramp.com"));
    await persistRecords(
      db,
      [record({ company_name: "Ramp", headquarters: "Bengaluru", stage: "seed", announced_date: "2021-01-05" })],
      "seed",
      "run-2",
    );
    expect(await companyIds(db)).toEqual(["ramp-2", "ramp.com"]);
  });

  test("with headquarters written at another grain lands on the company", async () => {
    const db = await ramp();
    await db.update(schema.companies).set({ hq: "New York, United States" }).where(eq(schema.companies.id, "ramp.com"));
    await persistRecords(
      db,
      [record({ company_name: "Ramp", headquarters: "New York and San Francisco", stage: "seed", announced_date: "2021-01-05" })],
      "seed",
      "run-2",
    );
    expect(await companyIds(db)).toEqual(["ramp.com"]);
  });

  test("with a site of its own is another company", async () => {
    const db = await ramp();
    await persistRecords(
      db,
      [record({ company_name: "Ramp", company_website: "https://ramp.network", stage: "seed", announced_date: "2021-01-05" })],
      "seed",
      "run-2",
    );
    expect(await companyIds(db)).toEqual(["ramp-2", "ramp.com"]);
  });
});

describe("a company row with no domain whose site is a stored company's", () => {
  test("is folded into that company when the company is next written", async () => {
    const db = await ramp();
    await db.insert(schema.companies).values({ id: "ramp-2", name: "Ramp", nameKey: "ramp", website: "https://www.ramp.com" });
    await db.insert(schema.fundingRounds).values({
      ...(await db.select().from(schema.fundingRounds))[0],
      id: "ramp:other:2020-02-12",
      companyId: "ramp-2",
      announcedOn: "2020-02-12",
    });
    await persistRecords(
      db,
      [
        record({
          company_name: "Ramp",
          company_domain: "ramp.com",
          stage: "series_d_plus",
          announced_date: "2025-06-17",
          sources: [{ url: "https://ramp.com/blog/series-e", host: "ramp.com" }],
        }),
      ],
      "growth",
      "run-2",
    );
    expect(await companyIds(db)).toEqual(["ramp.com"]);
    const [moved] = await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, "ramp:other:2020-02-12"));
    expect(moved?.companyId).toBe("ramp.com");
    const [fold] = await db.select().from(schema.companyFolds).where(eq(schema.companyFolds.fromId, "ramp-2"));
    expect(fold?.intoId).toBe("ramp.com");
  });
});

describe("a history write for a company folded away mid-run", () => {
  test("lands on the company it was folded into and brings no second row back", async () => {
    const db = await ramp();
    await db.insert(schema.companies).values({ id: "ramp-2", name: "Ramp", nameKey: "ramp" });
    await mergeCompanies(db, "ramp-2", "ramp.com");
    await persistRecords(
      db,
      [
        record({
          company_name: "Ramp",
          stage: "series_b",
          announced_date: "2021-04-08",
          sources: [{ url: "https://techcrunch.com/2021/04/08/ramp", host: "techcrunch.com" }],
        }),
      ],
      "growth",
      "history-1",
      { history: true, companyId: "ramp-2" },
    );
    expect(await companyIds(db)).toEqual(["ramp.com"]);
    const [row] = await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.announcedOn, "2021-04-08"));
    expect(row?.companyId).toBe("ramp.com");
  });
});

describe("the fold fix", () => {
  test("folds a domainless twin by the app's merge, skips once done, and refuses two domains", async () => {
    const db = await ramp();
    await db.insert(schema.companies).values([
      { id: "ramp-2", name: "Ramp", nameKey: "ramp" },
      { id: "ramp.network", name: "Ramp", nameKey: "ramp", domain: "ramp.network" },
    ]);
    const fix: RecordFix = {
      kind: "fold",
      from: "ramp-2",
      into: "ramp.com",
      evidence: "https://citybiz.co/article/ramp",
      note: "the roundup's Ramp is the corporate card company",
    };
    const dry = await applyRecordFixes(db, [fix], { apply: false });
    expect(dry).toMatchObject({ applied: 0, refused: 0 });
    expect(dry.lines.join("\n")).toContain("fold ramp-2 (Ramp, site none) into ramp.com (Ramp, ramp.com)");
    expect(await companyIds(db)).toContain("ramp-2");
    expect(await applyRecordFixes(db, [fix], { apply: true })).toMatchObject({ applied: 1 });
    expect(await companyIds(db)).toEqual(["ramp.com", "ramp.network"]);
    expect(await applyRecordFixes(db, [fix], { apply: true })).toMatchObject({ applied: 0, skipped: 1 });
    expect(await applyRecordFixes(db, [{ ...fix, from: "ramp.network" }], { apply: true })).toMatchObject({ refused: 1 });
  });
});

describe("a reading whose site is a publisher's", () => {
  /** A news site the store already holds two other companies' rounds from. */
  async function newsSite(db: Awaited<ReturnType<typeof testDb>>) {
    for (const name of ["Finmid", "Persona"])
      await persistRecords(
        db,
        [
          record({
            company_name: name,
            sources: [{ url: `https://ascendants.in/business-stories/${name.toLowerCase()}-raises`, host: "ascendants.in" }],
          }),
        ],
        "seed",
        `run-${name}`,
      );
  }

  test("Klarent: a news site's article taken for the company's site makes no second Klarent", async () => {
    const db = await testDb();
    await newsSite(db);
    await persistRecords(
      db,
      [
        record({
          company_name: "Klarent",
          company_domain: "klarent.ai",
          company_website: "https://klarent.ai/",
          headquarters: "Zurich, Switzerland",
          stage: "seed",
          announced_date: "2026-10-09",
          amount: { value: 8, currency: "USD", as_written: "$8M", usd_millions: 8, fx_rate: 1, fx_date: "2026-10-09" },
          sources: [{ url: "https://klarent.ai/blogs/klarent-secures-8m-seed-funding", host: "klarent.ai" }],
        }),
      ],
      "seed",
      "run-1",
    );
    expect(await publisherDomain(db, "ascendants.in", "klarent", {})).toBe(true);
    await persistRecords(
      db,
      [
        record({
          company_name: "Klarent",
          company_domain: "ascendants.in",
          company_website: "https://ascendants.in/",
          headquarters: "Zurich",
          stage: "other",
          announced_date: "2026-10-13",
          amount: { value: 7.13, currency: "EUR", as_written: "€7.13 Million", usd_millions: 8.3, fx_rate: 1.16, fx_date: "2026-10-13" },
          sources: [{ url: "https://maxime-droux.com/digest/index.html", host: "maxime-droux.com" }],
        }),
      ],
      "seed",
      "run-2",
    );
    const klarent = await db.select().from(schema.companies).where(eq(schema.companies.nameKey, "klarent"));
    expect(klarent.map((c) => [c.id, c.domain, c.website])).toEqual([["klarent.ai", "klarent.ai", "https://klarent.ai/"]]);
    const rounds = await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.companyId, "ascendants.in"));
    expect(rounds).toEqual([]);
  });

  test("CarbonFarm: a wire's homepage taken for the company's site lands on the company", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [
        record({
          company_name: "CarbonFarm",
          company_domain: "carbonfarm.tech",
          company_website: "https://carbonfarm.tech",
          headquarters: "Paris",
          announced_date: "2026-10-13",
          amount: { value: 7, currency: "EUR", as_written: "€7 million", usd_millions: 8.1, fx_rate: 1.16, fx_date: "2026-10-13" },
          sources: [{ url: "https://www.eu-startups.com/2026/10/paris-based-carbonfarm-raises-e7-million", host: "eu-startups.com" }],
        }),
      ],
      "growth",
      "run-1",
    );
    await persistRecords(
      db,
      [
        record({
          company_name: "CarbonFarm",
          company_website: "https://www.einpresswire.com/",
          announced_date: "2026-10-13",
          amount: { value: 7.8, currency: "USD", as_written: "$7.8 million", usd_millions: 7.8, fx_rate: 1, fx_date: "2026-10-13" },
          sources: [
            { url: "https://www.einpresswire.com/article/949116901/carbonfarm-raises-7-8m-series-a", host: "www.einpresswire.com" },
          ],
        }),
      ],
      "growth",
      "run-2",
    );
    expect(await companyIds(db)).toEqual(["carbonfarm.tech"]);
    const [company] = await db.select().from(schema.companies);
    expect(company.website).toBe("https://carbonfarm.tech");
  });

  test("a domain named for the company is its own, whatever else it publishes", async () => {
    const db = await testDb();
    for (const name of ["Ghost", "Every"])
      await persistRecords(
        db,
        [
          record({
            company_name: name,
            sources: [{ url: `https://${name.toLowerCase()}.substack.com/p/raise`, host: `${name.toLowerCase()}.substack.com` }],
          }),
        ],
        "seed",
        `run-${name}`,
      );
    expect(await publisherDomain(db, "substack.com", "substack", {})).toBe(false);
    expect(await publisherDomain(db, "substack.com", "klarent", {})).toBe(true);
    expect(await publisherDomain(db, "einpresswire.com", "carbonfarm", {})).toBe(true);
    expect(await publisherDomain(db, "carbonfarm.tech", "carbonfarm", {})).toBe(false);
  });
});
