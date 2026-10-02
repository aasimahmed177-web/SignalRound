// Apollo at the store, on the captured bulk answer (no network): the row per company and what it
// never keeps, the gap-fill rules a page reads (headcount and LinkedIn only where the others have
// none, the logo only where the company has none, the headquarters never), the admin signals, and the
// funding events queued as history leads only when the store lacks them, promoted only by a page that
// states them.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { readFileSync } from "node:fs";
import type { AlexandriaEnrichment, ApolloFundingEvent } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { and, eq, sql } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { describe, expect, test } from "vitest";
import { alexandriaFacts, companyLinkedin } from "../lib/alexandria-facts";
import {
  APOLLO_BACKFILL_MAX_CREDITS,
  apolloBatch,
  apolloCoverage,
  currentFundingGap,
  hqAgrees,
  parseApolloBackfillParams,
  pendingApollo,
  type StoredApollo,
} from "../lib/apollo";
import { getCompany } from "../lib/company";
import { historyCoverage, historyTargets, planPromotion, promotePrior, queueCompanyHistory } from "../lib/history";
import { listRounds, persistRecords, setDisposition, toAlexandria } from "../lib/persist";
import { record, testDb } from "./helpers";
import { item, reader, round, SEED_URL } from "./history-fixtures";

const { companies, enrichments, fundingRounds, historyPromotions } = schema;

const fixture = JSON.parse(readFileSync("tests/fixtures/alexandria/apollo-bulk.json", "utf8"));
const orgs: Array<Record<string, unknown> | null> = fixture.data.alexandria[0].data.organizations;

/** Footprint as Apollo might list it: its seed (which the store lacks) and its Series A (which it holds). */
const FOOTPRINT = {
  id: "fp1",
  name: "Footprint",
  primary_domain: "onefootprint.com",
  linkedin_url: "http://www.linkedin.com/company/onefootprint",
  city: "New York",
  state: "New York",
  country: "United States",
  estimated_num_employees: 36,
  logo_url: "https://logos.example/footprint",
  total_funding: 31_000_000,
  technology_names: ["Bugzilla"],
  keywords: ["identity"],
  funding_events: [
    { date: "2026-09-01T00:00:00.000+00:00", type: "Series A", amount: "20M", currency: "$", news_url: null },
    { date: "2022-08-01T00:00:00.000+00:00", type: "Seed", amount: "6M", currency: "$", news_url: SEED_URL },
    { date: "2021-01-01T00:00:00.000+00:00", type: "Other", amount: "1M", currency: "$", news_url: null },
  ],
};

const byDomain = (d: string) => (d === "onefootprint.com" ? FOOTPRINT : (orgs.find((o) => o?.primary_domain === d) ?? null));

/** Answers each bulk call as the API does: one entry per domain asked, null for a miss, 30 credits a match. */
function apolloClient() {
  const calls: string[][] = [];
  const client = {
    scrape: async (req: { alexandria: { options: Record<string, string[]> } }) => {
      const domains = req.alexandria.options["domains[]"];
      calls.push(domains);
      const organizations = domains.map(byDomain);
      const cost = organizations.filter(Boolean).length * 30;
      return { alexandria: [{ creditsCost: cost, data: { organizations } }], creditsCost: cost };
    },
  } as unknown as Firecrawl;
  return { client, calls };
}

async function company(handle: Awaited<ReturnType<typeof testDb>>, name: string, domain: string, extra: Record<string, unknown> = {}) {
  const key = name.toLowerCase();
  const item = record({
    company_name: name,
    company_key: key,
    evidence_quotes: [`${name} raised $20M.`],
    sources: [{ url: `https://reuters.com/${key}-series-a`, host: "reuters.com", title: `${name} raises $20M` }],
    ...extra,
  });
  await persistRecords(handle, [item], "series-a-b", "run-1");
  await setDisposition(handle, item.id, "publish");
  await handle.update(companies).set({ domain }).where(eq(companies.id, key));
  return key;
}

async function stored(handle: Awaited<ReturnType<typeof testDb>>, id: string): Promise<StoredApollo | undefined> {
  const [row] = await handle
    .select({ data: enrichments.data })
    .from(enrichments)
    .where(and(eq(enrichments.companyId, id), eq(enrichments.kind, "apollo")));
  return row?.data as StoredApollo | undefined;
}

describe("apolloBatch", () => {
  test("a row per company, trimmed; a namesake keeps nothing; the headquarters never reaches the company", async () => {
    const handle = await testDb();
    await company(handle, "Vals", "vals.ai");
    await company(handle, "Cognition", "cognition.com");
    await company(handle, "Upwind", "upwindsecurity.com");
    const pending = await pendingApollo(handle, "series-a-b", 10);
    expect(pending.map((c) => c.id).sort()).toEqual(["cognition", "upwind", "vals"]);

    const { client, calls } = apolloClient();
    const r = await apolloBatch(handle, client, pending, { leads: false, checkLogo: async () => true });
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ companies: 3, matched: 1, credits: 60, leads: 0 });

    const vals = await stored(handle, "vals");
    expect(vals?.apollo.status).toBe("matched");
    expect(JSON.stringify(vals)).not.toMatch(/technology_names|current_technologies|keywords|Bugzilla/);
    expect((await stored(handle, "cognition"))?.apollo).toEqual({ status: "namesake", name: "CoDev Labs", domain: "cognition.com" });
    expect((await stored(handle, "upwind"))?.apollo).toEqual({ status: "none" });

    // Apollo's headquarters is stored on its row and never written onto the company.
    const [v] = await handle.select({ hq: companies.hq }).from(companies).where(eq(companies.id, "vals"));
    expect(v.hq).toBeNull();
    const [row] = (await handle.execute(sql`select schema_version from enrichments where company_id = 'vals' and kind = 'apollo'`)).rows;
    expect(row.schema_version).toBe(1);
    expect(await pendingApollo(handle, "series-a-b", 10)).toEqual([]);
  });

  test("the logo fills only an empty one, and only when it loads as an image", async () => {
    const handle = await testDb();
    await company(handle, "Dialybrid", "dialybrid.com");
    await company(handle, "Loora", "loora.com");
    await company(handle, "Vals", "vals.ai");
    await handle.update(companies).set({ logoUrl: "https://loora.com/logo.png" }).where(eq(companies.id, "loora"));
    const { client } = apolloClient();
    const checked: string[] = [];
    await apolloBatch(
      handle,
      client,
      [
        { id: "dialybrid", name: "Dialybrid", domain: "dialybrid.com" },
        { id: "loora", name: "Loora", domain: "loora.com" },
        { id: "vals", name: "Vals", domain: "vals.ai" },
      ],
      {
        leads: false,
        checkLogo: async (url) => {
          checked.push(url);
          return !url.includes("6aae81696be168000120c527"); // Vals' logo fails the check.
        },
      },
    );
    const logos = Object.fromEntries(
      (await handle.select({ id: companies.id, logo: companies.logoUrl }).from(companies)).map((c) => [c.id, c.logo]),
    );
    expect(logos.dialybrid).toMatch(/zenprospect/);
    expect(logos.loora).toBe("https://loora.com/logo.png");
    expect(logos.vals).toBeNull();
    // A company that already had a logo is not even checked.
    expect(checked.some((u) => u.includes("69a4d6431a8b530001345d09"))).toBe(false);
  });

  test("a disagreement with our headquarters and a much larger total are recorded for admins", async () => {
    const handle = await testDb();
    await company(handle, "Anthropic", "anthropic.com", { headquarters: "San Francisco, USA" });
    await handle.update(companies).set({ hq: "San Francisco, USA" }).where(eq(companies.id, "anthropic"));
    const { client } = apolloClient();
    await apolloBatch(handle, client, [{ id: "anthropic", name: "Anthropic", domain: "anthropic.com" }], {
      leads: false,
      checkLogo: async () => false,
    });
    const row = await stored(handle, "anthropic");
    expect(row?.signals.hq_disagrees).toEqual({ ours: "San Francisco, USA", apollo: "Cambridge, Massachusetts, United States" });
    expect(row?.signals.funding_gap).toEqual({ apollo_usd_millions: 139154, ours_usd_millions: 20 });
    const coverage = await apolloCoverage(handle);
    expect(coverage).toMatchObject({ looked_up: 1, matched: 1, hq_disagrees: 1, funding_gap: 1, credits: 30 });
  });
});

describe("hqAgrees", () => {
  test("the same city, a region that holds it, or a bare country agree; another place does not", () => {
    expect(hqAgrees("Israel", { hq: "Tel Aviv-Yafo, Tel Aviv District", country: "Israel" })).toBe(true);
    expect(hqAgrees("Cantù, Italy", { hq: "Cantu, Lombardy", country: "Italy" })).toBe(true);
    expect(hqAgrees("Chicago, USA; Tokyo, Japan", { hq: "Chicago, Illinois", country: "United States" })).toBe(true);
    expect(hqAgrees("UK", { hq: "London, England", country: "United Kingdom" })).toBe(true);
    expect(hqAgrees("NEW YORK", { hq: "New York, New York", country: "United States" })).toBe(true);
    expect(hqAgrees("Egypt", { hq: "New York, New York", country: "United States" })).toBe(false);
    expect(hqAgrees("Britain", { hq: "Lisbon, Lisbon", country: "Portugal" })).toBe(false);
    expect(hqAgrees("San Francisco, USA", { hq: "Wilmington, Delaware", country: "United States" })).toBe(false);
    expect(hqAgrees("Antwerp, Belgium", { hq: null, country: null })).toBe(true);
  });
});

describe("what a page reads", () => {
  const firmographics = (headcount: number | null, linkedin: string | null) =>
    ({ headcount_range: null, headcount, year_founded: null, company_type: null, industry: null, linkedin_url: linkedin }) as const;
  const apollo = { headcount: 53, linkedin_url: "https://www.linkedin.com/company/loora" };

  test("FullEnrich's headcount first, then Apollo's, then YC's application-time figure, named in the tooltip", () => {
    expect(alexandriaFacts({ yc: null, firmographics: null, apollo })).toEqual([
      { label: "53 people", title: "From Apollo via Firecrawl Alexandria" },
    ]);
    expect(alexandriaFacts({ yc: null, firmographics: firmographics(85, null), apollo })[0]).toEqual({
      label: "85 people",
      title: "From FullEnrich via Firecrawl Alexandria",
    });
    expect(alexandriaFacts({ yc: { batch: null, team_size: 90, year_founded: null }, firmographics: null, apollo })[0].label).toBe(
      "53 people",
    );
    expect(alexandriaFacts({ yc: { batch: null, team_size: 90, year_founded: null }, firmographics: null, apollo: null })[0].label).toBe(
      "90 people",
    );
  });

  test("FullEnrich's LinkedIn page first, Apollo's checked one only in its place", () => {
    expect(companyLinkedin({ yc: null, firmographics: firmographics(null, "https://www.linkedin.com/company/fe"), apollo })).toEqual({
      url: "https://www.linkedin.com/company/fe",
      title: "From FullEnrich via Firecrawl Alexandria",
    });
    expect(companyLinkedin({ yc: null, firmographics: firmographics(null, null), apollo })?.title).toBe(
      "From Apollo via Firecrawl Alexandria",
    );
    expect(companyLinkedin({ yc: null, firmographics: null, apollo: null })).toBeNull();
  });

  test("an Apollo row alone still reaches the row shape; a namesake's does not", () => {
    const matched = {
      schema_version: 1,
      company_key: "loora",
      domain: "loora.com",
      credits: 30,
      apollo: {
        status: "matched",
        apollo_id: null,
        name: "Loora",
        domain: "loora.com",
        linkedin_url: apollo.linkedin_url,
        hq: "Tel Aviv-Yafo, Tel Aviv District",
        country: "Israel",
        headcount: 53,
        founded_year: 2020,
        logo_url: null,
        total_funding_usd: 43_250_000,
        funding_events: [] as ApolloFundingEvent[],
      },
    } as const;
    expect(toAlexandria(undefined, matched)).toEqual({ yc: null, firmographics: null, apollo });
    expect(toAlexandria(undefined, { ...matched, apollo: { status: "namesake", name: "CoDev Labs", domain: "loora.com" } })).toBeNull();
    // The flat shape never carries Apollo's headquarters or its funding.
    expect(JSON.stringify(toAlexandria(undefined, matched))).not.toMatch(/Tel Aviv|43250000|hq|funding/);
  });

  test("listRounds and the company page carry the Apollo facts beside FullEnrich's", async () => {
    const handle = await testDb();
    await company(handle, "Loora", "loora.com");
    const fe: AlexandriaEnrichment = {
      company_key: "loora",
      domain: "loora.com",
      credits: 5,
      yc: { status: "none" },
      firmographics: { status: "none" },
    };
    await handle.insert(enrichments).values({ companyId: "loora", kind: "alexandria", data: fe });
    const { client } = apolloClient();
    await apolloBatch(handle, client, [{ id: "loora", name: "Loora", domain: "loora.com" }], {
      leads: false,
      checkLogo: async () => false,
    });
    const { rows } = await listRounds(handle, { companyId: "loora" });
    expect(rows[0].alexandria?.apollo).toEqual({ headcount: 53, linkedin_url: "https://www.linkedin.com/company/loora" });
    const page = await getCompany(handle, "loora");
    expect(page?.apollo?.apollo.status).toBe("matched");
    expect(page?.company.hq).toBeNull();
  });
});

describe("funding events as history leads", () => {
  test("only the rounds the store lacks are queued, marked apollo, and need no dossier", async () => {
    const handle = await testDb();
    await company(handle, "Footprint", "onefootprint.com", { announced_date: "2026-09-02" });
    const { client } = apolloClient();
    const r = await apolloBatch(handle, client, [{ id: "footprint", name: "Footprint", domain: "onefootprint.com" }], {
      leads: true,
      checkLogo: async () => false,
    });
    // The Series A is ours already and "Other" names no stage: only the seed is a lead.
    expect(r).toMatchObject({ leads: 1, leadCompanies: ["footprint"] });
    const ledger = await handle.select().from(historyPromotions);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ origin: "apollo", status: "pending", priorKey: "seed|$6m|2022-08" });
    expect(ledger[0].prior.source_url).toBe(SEED_URL);
    expect((await stored(handle, "footprint"))?.leads_queued).toBe(1);

    // A second pass over the same events queues nothing new.
    await handle.delete(enrichments).where(eq(enrichments.kind, "apollo"));
    const again = await apolloBatch(handle, client, [{ id: "footprint", name: "Footprint", domain: "onefootprint.com" }], {
      leads: true,
      checkLogo: async () => false,
    });
    expect(again.leads).toBe(0);

    // The history lane sees it without a dossier, and reads the page the lead named first.
    expect(await queueCompanyHistory(handle, "footprint")).toEqual(["seed|$6m|2022-08"]);
    expect(await historyTargets(handle)).toEqual(["footprint"]);
    expect((await historyCoverage(handle)).apollo_leads).toEqual({ pending: 1 });
    const { reader: r2 } = reader();
    const plan = await planPromotion(handle, r2, "footprint", "seed|$6m|2022-08", "test");
    expect(plan.skip).toBeNull();
    expect(plan.origin).toBe("apollo");
    expect(plan.candidates.map((c) => c.url)).toContain(SEED_URL);

    // A company off the feed (its only round in review) is not worked for its leads.
    await handle.update(fundingRounds).set({ disposition: "review" }).where(eq(fundingRounds.companyId, "footprint"));
    expect(await historyTargets(handle)).toEqual([]);
  });

  test("a lead becomes a round only when a page states it and the read-back confirms it", async () => {
    const handle = await testDb();
    await company(handle, "Footprint", "onefootprint.com", { announced_date: "2026-09-02" });
    const { client } = apolloClient();
    await apolloBatch(handle, client, [{ id: "footprint", name: "Footprint", domain: "onefootprint.com" }], {
      leads: true,
      checkLogo: async () => false,
    });
    const key = "seed|$6m|2022-08";

    // No page states it: the ledger says so and no row is written.
    const empty = reader();
    const none = await promotePrior(handle, empty.reader, "footprint", key, "run-a");
    expect(none.status).toBe("no_source");
    expect(await handle.select().from(fundingRounds).where(eq(fundingRounds.history, true))).toEqual([]);

    // Its announcement, read and confirmed, is promoted as a history row.
    await handle
      .update(historyPromotions)
      .set({ status: "pending", nextAttemptAt: new Date(0) })
      .where(eq(historyPromotions.priorKey, key));
    const found = reader({ pages: { [SEED_URL]: [item(SEED_URL, round({}))] } });
    const promoted = await promotePrior(handle, found.reader, "footprint", key, "run-b");
    expect(promoted.status).toBe("promoted");
    const rows = await handle.select().from(fundingRounds).where(eq(fundingRounds.history, true));
    expect(rows.map((x) => [x.companyId, x.stage, x.announcedOn])).toEqual([["footprint", "seed", "2022-08-03"]]);
    const [ledger] = await handle.select().from(historyPromotions).where(eq(historyPromotions.priorKey, key));
    expect(ledger).toMatchObject({ origin: "apollo", status: "promoted", sourceUrl: SEED_URL });
  });
});

describe("parseApolloBackfillParams", () => {
  test("defaults, a cap, leads off, and a bad value named", () => {
    expect(parseApolloBackfillParams({})).toEqual({ limit: null, maxCredits: APOLLO_BACKFILL_MAX_CREDITS, leads: true });
    expect(parseApolloBackfillParams({ limit: "20", maxCredits: "600", leads: "0" })).toEqual({ limit: 20, maxCredits: 600, leads: false });
    expect(parseApolloBackfillParams({ limit: "-1" })).toEqual({ error: "limit must be a whole number from 1 to 100000" });
  });
});

describe("currentFundingGap", () => {
  test("the note reads the store's total now: history promoted since Apollo was read narrows or closes the gap", () => {
    const gap = { apollo_usd_millions: 289_000, ours_usd_millions: 47_000 };
    expect(currentFundingGap(gap, 169_600)).toBeNull();
    expect(currentFundingGap(gap, 100_000)).toEqual({ apollo_usd_millions: 289_000, ours_usd_millions: 100_000 });
    expect(currentFundingGap(undefined, 0)).toBeNull();
  });
});
