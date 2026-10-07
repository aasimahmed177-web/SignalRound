// The Alexandria lane end to end on fixtures captured from the live API: the batch writer's
// row and its safe fills, the pending list's domain gate, and the company facts the rows and
// API carry (YC's record, the checked dossier, and the LinkedIn page the homepage links).

import { readFileSync } from "node:fs";
import type { AlexandriaEnrichment } from "@fireround/core";
import { ycFromRecord } from "@fireround/core";
import { sql } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { describe, expect, test } from "vitest";
import { alexandriaBatch, pendingAlexandria } from "../lib/alexandria";
import { companyFacts, factChips, ycBatchShort, ycFoundedYear } from "../lib/company-facts";
import { listRounds, persistRecords, setDisposition } from "../lib/persist";
import { record, testDb } from "./helpers";

const searchFixture = JSON.parse(readFileSync("tests/fixtures/alexandria/yc-search-firecrawl.json", "utf8"));
const companyFixture = JSON.parse(readFileSync("tests/fixtures/alexandria/yc-company-firecrawl.json", "utf8"));

async function publishedCompany(db: Awaited<ReturnType<typeof testDb>>, name: string, key: string) {
  const item = record({
    company_name: name,
    company_key: key,
    evidence_quotes: [`${name} raised $20M.`],
    sources: [{ url: `https://reuters.com/${key}-series-a`, host: "reuters.com", title: `${name} raises $20M` }],
  });
  await persistRecords(db, [item], "series-a-b", "run-1");
  await setDisposition(db, item.id, "publish");
}

/** The fixtures answer as the API did: the SDK unwraps `data`, so the stub returns its contents. */
function fixtureClient(): Firecrawl {
  return {
    scrape: async (req: { alexandria: { capability: string } }) => {
      const capability = req.alexandria.capability;
      if (capability === "companies/search") return searchFixture.data;
      if (capability === "companies/company") return companyFixture.data;
      throw new Error(`unexpected capability ${capability}`);
    },
  } as unknown as Firecrawl;
}

describe("ycFromRecord on the captured fixture", () => {
  test("Firecrawl's own record: slug, batch, three founders with links and no bios", () => {
    const hit = searchFixture.data.alexandria[0].data.records[0];
    const company = companyFixture.data.alexandria[0].data.records[0];
    const yc = ycFromRecord(hit, company);
    expect(yc.slug).toBe("firecrawl");
    expect(yc.batch).toBe("Summer 2022");
    expect(yc.year_founded).toBe(2024);
    expect(yc.team_size).toBe(3);
    expect(yc.location).toBe("San Francisco");
    expect(yc.founders).toHaveLength(3);
    expect(yc.founders.map((f) => f.linkedin_url).filter(Boolean)).toHaveLength(3);
    expect(yc.founders.every((f) => !("bio" in f))).toBe(true);
  });
});

describe("ycBatchShort", () => {
  test("the season letter plus the two-digit year; an unknown string passes through", () => {
    expect(ycBatchShort("Summer 2022")).toBe("S22");
    expect(ycBatchShort("Winter 2025")).toBe("W25");
    expect(ycBatchShort("Spring 2025")).toBe("X25");
    expect(ycBatchShort("Fall 2025")).toBe("F25");
    expect(ycBatchShort("Batch 12")).toBe("Batch 12");
    expect(ycBatchShort(null)).toBeNull();
  });
});

describe("company facts", () => {
  const yc = { batch: "Winter 2025", team_size: 3, year_founded: 2024 };
  test("YC's batch, founding year, and team size, each naming its source; nothing when nothing is known", () => {
    const facts = companyFacts(yc, null, null);
    expect(facts).toEqual({
      founded_year: { value: 2024, source: "yc" },
      headcount: { value: "3", source: "yc" },
      linkedin_url: null,
    });
    expect(factChips(yc, facts)).toEqual([
      { label: "YC W25", title: "From Y Combinator via Firecrawl Alexandria" },
      { label: "founded 2024", title: "From Y Combinator via Firecrawl Alexandria" },
      { label: "3 people", title: "From Y Combinator via Firecrawl Alexandria" },
    ]);
    expect(companyFacts(null, null, null)).toEqual({ founded_year: null, headcount: null, linkedin_url: null });
    expect(factChips(null, null)).toEqual([]);
  });

  test("the Firecrawl case: YC's founding year after its own batch gives way to the dossier's, and a page's team size comes before YC's", () => {
    const firecrawl = { batch: "Summer 2022", team_size: 3, year_founded: 2024 };
    const facts = companyFacts(firecrawl, { founded_year: 2022, headcount_estimate: "about 50 people" }, null);
    expect(facts.founded_year).toEqual({ value: 2022, source: "dossier" });
    expect(facts.headcount).toEqual({ value: "about 50 people", source: "dossier" });
    expect(factChips(firecrawl, facts).map((f) => f.label)).toEqual(["YC S22", "founded 2022", "about 50 people"]);
    expect(factChips(null, companyFacts(null, { founded_year: null, headcount_estimate: "51 to 200" }, null))[0]?.label).toBe(
      "51 to 200 people",
    );
    expect(ycFoundedYear({ batch: "Winter 2025", team_size: 3, year_founded: 2024 })).toBe(2024);
    expect(ycFoundedYear({ batch: "Summer 2022", team_size: 3, year_founded: 2024 })).toBeNull();
  });
});

describe("alexandriaBatch and the pending list", () => {
  test("a verified domain gets its row, the coalesce fills, and leaves the pending list", async () => {
    const db = await testDb();
    await publishedCompany(db, "Firecrawl", "firecrawl");
    await db.execute(sql`update companies set domain = 'firecrawl.dev' where id = 'firecrawl'`);

    expect((await pendingAlexandria(db, "series-a-b", 10)).map((c) => c.id)).toEqual(["firecrawl"]);

    const r = await alexandriaBatch(db, fixtureClient(), [{ id: "firecrawl", name: "Firecrawl", domain: "firecrawl.dev" }]);
    expect(r.companies).toBe(1);
    expect(r.matched).toBe(1);
    expect(r.credits).toBe(10);

    const rows = await db.execute(sql`select kind, source_url from enrichments where company_id = 'firecrawl'`);
    expect(rows.rows).toEqual([{ kind: "alexandria", source_url: "https://www.ycombinator.com/companies/firecrawl" }]);

    const stored = (await db.execute(sql`select data from enrichments where company_id = 'firecrawl' and kind = 'alexandria'`)).rows[0]
      .data as AlexandriaEnrichment;
    expect(stored.yc.status).toBe("matched");
    expect(Object.keys(stored).sort()).toEqual(["company_key", "credits", "domain", "yc"]);

    // The safe fills only: description and hq from YC where the row had none.
    const [company] = (await db.execute(sql`select description, hq from companies where id = 'firecrawl'`)).rows;
    expect(company.description).toBe("The web data API for searching and scraping. 🔥");
    expect(company.hq).toBe("San Francisco");

    expect(await pendingAlexandria(db, "series-a-b", 10)).toEqual([]);
  });

  test("a company without a verified domain is never looked up", async () => {
    const db = await testDb();
    await publishedCompany(db, "NoSite", "nosite");
    expect(await pendingAlexandria(db, "series-a-b", 10)).toEqual([]);
    // And a domain on a company outside the preset does not join the list.
    await db.execute(sql`update companies set domain = 'nosite.example' where id = 'nosite'`);
    expect((await pendingAlexandria(db, "series-a-b", 10)).map((c) => c.id)).toEqual(["nosite"]);
    expect(await pendingAlexandria(db, "seed", 10)).toEqual([]);
  });
});

describe("the read surface", () => {
  test("listRounds carries YC's record and the company facts: the checked dossier's figures and the homepage's LinkedIn page", async () => {
    const db = await testDb();
    await publishedCompany(db, "RowCo", "rowco");
    const stored: AlexandriaEnrichment = {
      company_key: "rowco",
      domain: "rowco.com",
      credits: 10,
      yc: {
        status: "matched",
        slug: "rowco",
        url: "https://www.ycombinator.com/companies/rowco",
        batch: "Summer 2022",
        year_founded: 2023,
        team_size: 4,
        location: "NYC",
        one_liner: "Robots",
        tags: [],
        yc_status: "Active",
        founders: [
          { name: "A Founder", title: "CEO", linkedin_url: "https://linkedin.com/in/a", twitter_url: null },
          { name: "B Founder", title: "CTO", linkedin_url: null, twitter_url: null },
        ],
      },
    };
    await db.execute(
      sql`insert into enrichments (company_id, kind, data) values ('rowco', 'alexandria', ${JSON.stringify(stored)}::jsonb)`,
    );
    const profile = {
      company_key: "rowco",
      company_website: "https://rowco.com",
      website_source: "record",
      profile: { what_they_sell: "Robots", same_company: true },
      linkedin_url: "https://www.linkedin.com/company/rowco",
    };
    await db.execute(sql`insert into enrichments (company_id, kind, data) values ('rowco', 'profile', ${JSON.stringify(profile)}::jsonb)`);
    const dossier = { founded_year: 2022, headcount_estimate: "11 to 50", verification: { checked_at: "2026-10-01T00:00:00Z" } };
    await db.execute(
      sql`insert into enrichments (company_id, kind, data, schema_version) values ('rowco', 'deep_dive', ${JSON.stringify(dossier)}::jsonb, 2)`,
    );
    const [row] = (await listRounds(db, { includeReview: true })).rows;
    expect(row.alexandria).toEqual({ yc: { batch: "Summer 2022", team_size: 4, year_founded: 2023, founders_count: 2 } });
    // YC's 2023 is after its S22 batch, so it cannot be true and the dossier's year stands.
    expect(row.company_facts).toEqual({
      founded_year: { value: 2022, source: "dossier" },
      headcount: { value: "11 to 50", source: "dossier" },
      linkedin_url: "https://www.linkedin.com/company/rowco",
    });
    // No row, no key; an unchecked dossier and an unverified profile add nothing.
    await publishedCompany(db, "Plain", "plain");
    await db.execute(
      sql`insert into enrichments (company_id, kind, data, schema_version) values ('plain', 'deep_dive', ${JSON.stringify({ founded_year: 2020 })}::jsonb, 1)`,
    );
    await db.execute(
      sql`insert into enrichments (company_id, kind, data) values ('plain', 'profile', ${JSON.stringify({ ...profile, company_key: "plain", website_source: "unverified" })}::jsonb)`,
    );
    const plain = (await listRounds(db, { companyId: "plain", includeReview: true })).rows[0];
    expect(plain.alexandria).toBeNull();
    expect(plain.company_facts).toEqual({ founded_year: null, headcount: null, linkedin_url: null });
  });
});
