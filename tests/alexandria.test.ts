// The Alexandria lane end to end on fixtures captured from the live API: the batch writer's
// row and its safe fills, the pending list's domain gate, and the flattened shape the rows
// and API carry.

import { readFileSync } from "node:fs";
import type { AlexandriaEnrichment } from "@fireround/core";
import { ycFromRecord } from "@fireround/core";
import { sql } from "drizzle-orm";
import { type Firecrawl, SdkError } from "firecrawl";
import { describe, expect, test } from "vitest";
import { alexandriaBatch, alexandriaFacts, pendingAlexandria, refreshFirmographics, ycBatchShort, ycFoundedYear } from "../lib/alexandria";
import { listRounds, persistRecords, setDisposition, toAlexandria } from "../lib/persist";
import { record, testDb } from "./helpers";

const searchFixture = JSON.parse(readFileSync("tests/fixtures/alexandria/yc-search-firecrawl.json", "utf8"));
const companyFixture = JSON.parse(readFileSync("tests/fixtures/alexandria/yc-company-firecrawl.json", "utf8"));
const termsFixture = JSON.parse(readFileSync("tests/fixtures/alexandria/fullenrich-terms-required.json", "utf8"));
const firmographicsFixture = JSON.parse(readFileSync("tests/fixtures/alexandria/fullenrich-agave.json", "utf8"));

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
      // What the SDK does with the API's terms refusal: a typed throw carrying requiresAction.
      throw new SdkError(termsFixture.error, 403, termsFixture.code, undefined, undefined, undefined, termsFixture.requiresAction);
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

describe("alexandriaFacts", () => {
  test("batch, founded, people, each naming its provider; nothing when nothing matched", () => {
    const flat = toAlexandria({
      company_key: "acme",
      domain: "acme.com",
      credits: 10,
      yc: {
        status: "matched",
        slug: "acme",
        url: "https://www.ycombinator.com/companies/acme",
        batch: "Winter 2025",
        year_founded: 2024,
        team_size: 3,
        location: "SF",
        one_liner: "Widgets",
        tags: [],
        yc_status: "Active",
        founders: [],
      },
      firmographics: { status: "none" },
    });
    expect(alexandriaFacts(flat).map((f) => f.label)).toEqual(["YC W25", "founded 2024", "3 people"]);
    expect(alexandriaFacts(null)).toEqual([]);
    expect(alexandriaFacts({ yc: null, firmographics: null })).toEqual([]);
  });

  test("the Firecrawl case: YC's founding year after its own batch and its application-time team size give way", () => {
    const facts = alexandriaFacts({
      yc: { batch: "Summer 2022", team_size: 3, year_founded: 2024 },
      firmographics: { headcount_range: "11-50", headcount: 52, year_founded: 0 },
      apollo: { headcount: 53, linkedin_url: null },
    });
    // No year a provider could stand behind (YC's is after S22, FullEnrich writes 0): the page takes the dossier's.
    expect(facts.map((f) => f.label)).toEqual(["YC S22", "52 people"]);
    expect(facts[1]?.title).toBe("From FullEnrich via Firecrawl Alexandria");
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

    const r = await alexandriaBatch(db, fixtureClient(), [{ id: "firecrawl", name: "Firecrawl", domain: "firecrawl.dev" }], {
      firmographics: true,
    });
    expect(r.companies).toBe(1);
    expect(r.matched).toBe(1);
    expect(r.credits).toBe(10);

    const rows = await db.execute(sql`select kind, source_url from enrichments where company_id = 'firecrawl'`);
    expect(rows.rows).toEqual([{ kind: "alexandria", source_url: "https://www.ycombinator.com/companies/firecrawl" }]);

    const stored = (await db.execute(sql`select data from enrichments where company_id = 'firecrawl' and kind = 'alexandria'`)).rows[0]
      .data as AlexandriaEnrichment;
    expect(stored.yc.status).toBe("matched");
    expect(stored.firmographics).toEqual({ status: "terms_required", url: "https://www.firecrawl.dev/app/alexandria/fullenrich" });

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
  test("listRounds carries the flattened alexandria for a company with a row", async () => {
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
      firmographics: {
        status: "matched",
        provider: "fullenrich",
        description: "Robot company",
        year_founded: 2023,
        headcount: 12,
        headcount_range: "11-50",
        company_type: "private",
        specialties: ["robots"],
        logo_url: "https://logo.example/rowco.png",
        industry: "Robotics",
        hq: "New York, NY",
        linkedin_url: "https://www.linkedin.com/company/rowco",
        raw: {},
      },
    };
    await db.execute(
      sql`insert into enrichments (company_id, kind, data) values ('rowco', 'alexandria', ${JSON.stringify(stored)}::jsonb)`,
    );
    const [row] = (await listRounds(db, { includeReview: true })).rows;
    expect(row.alexandria).toEqual({
      yc: { batch: "Summer 2022", team_size: 4, year_founded: 2023, founders_count: 2 },
      firmographics: {
        headcount_range: "11-50",
        headcount: 12,
        year_founded: 2023,
        company_type: "private",
        industry: "Robotics",
        linkedin_url: "https://www.linkedin.com/company/rowco",
      },
      apollo: null,
    });
    // No row, no key.
    await publishedCompany(db, "Plain", "plain");
    const plain = (await listRounds(db, { companyId: "plain", includeReview: true })).rows[0];
    expect(plain.alexandria).toBeNull();
  });
});

describe("refreshFirmographics", () => {
  test("a terms-required row takes the lookup alone, adds its credits, fills logo and hq, then leaves the queue", async () => {
    const db = await testDb();
    await persistRecords(db, [record({ company_name: "Agave", company_key: "agave" })], "series-a-b", "run-1");
    await db.execute(sql`update companies set domain = 'useagave.com' where id = 'agave'`);
    const stored: AlexandriaEnrichment = {
      company_key: "agave",
      domain: "useagave.com",
      credits: 10,
      yc: {
        status: "matched",
        slug: "agave",
        url: "https://www.ycombinator.com/companies/agave",
        batch: "Winter 2022",
        year_founded: 2021,
        team_size: 50,
        location: null,
        one_liner: null,
        tags: [],
        yc_status: "Active",
        founders: [],
      },
      firmographics: { status: "terms_required", url: "https://www.firecrawl.dev/app/alexandria/fullenrich" },
    };
    await db.execute(
      sql`insert into enrichments (company_id, kind, data) values ('agave', 'alexandria', ${JSON.stringify(stored)}::jsonb)`,
    );

    const calls: string[] = [];
    const client = {
      scrape: async (req: { alexandria: { capability: string } }) => {
        calls.push(req.alexandria.capability);
        return firmographicsFixture.data;
      },
    } as unknown as Firecrawl;

    const r = await refreshFirmographics(db, client, { limit: 10 });
    expect(r).toEqual({ companies: 1, matched: 1, credits: 5 });
    expect(calls).toEqual(["companies/lookup"]);

    const after = (await db.execute(sql`select data from enrichments where company_id = 'agave' and kind = 'alexandria'`)).rows[0]
      .data as AlexandriaEnrichment;
    expect(after.credits).toBe(15);
    expect(after.firmographics.status).toBe("matched");
    expect(after.yc.status).toBe("matched");

    const [company] = (await db.execute(sql`select logo_url, hq from companies where id = 'agave'`)).rows;
    expect(company.logo_url).toBe("https://app.fullenrich.com/logo/company/handle/agave-api");
    expect(company.hq).toBe("San Francisco, California");

    expect(await refreshFirmographics(db, client, { limit: 10 })).toEqual({ companies: 0, matched: 0, credits: 0 });
  });
});
