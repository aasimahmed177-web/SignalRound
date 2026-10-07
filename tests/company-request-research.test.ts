// What a request's research can and cannot verify: Apple's 1977 and 1978 rounds traced through the
// history lane with a scripted reader (no network), and a listed company kept with its rounds.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import type { HistoryCandidate, KnownRound, PageClassifier, PageVerdict, SourceKind } from "@fireround/core";
import { hostOf } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { alsoFound } from "../components/company/request-funding-history";
import { cleanBrandName, searchName } from "../lib/brand-name";
import { getCompany } from "../lib/company";
import { tallyMessage } from "../lib/company-request-status";
import { requestTally } from "../lib/company-requests";
import { db } from "../lib/db";
import { saveDossier } from "../lib/deepdive";
import { loadVisibleIds } from "../lib/entity-exists";
import { promotePrior, queueCompanyHistory } from "../lib/history";
import { compareShadow, recordShadowVerdicts, screenWithJev } from "../lib/jev-shadow";
import { persistRecords } from "../lib/persist";
import {
  fillRequestSector,
  gapQueries,
  leadsFromCandidate,
  MAX_GAP_QUERIES,
  queueFundingSearch,
  queueGapSearch,
  repairRequestCompanyNames,
} from "../lib/request-research";
import { record } from "./helpers";
import { dossier, reader, round } from "./history-fixtures";

/** A checked dossier for a company with no feed round, as a request's research leaves it. */
async function requested(id: string, name: string, priors: Parameters<typeof dossier>[0], sources: string[]) {
  const handle = await db();
  await handle.insert(schema.companies).values({ id, name, nameKey: name.toLowerCase(), domain: id, website: `https://${id}/` });
  const at = new Date();
  await saveDossier(handle, id, { ...dossier(priors), sources }, sources[0] ?? null, at, {
    version: 1,
    checked_at: at.toISOString(),
    model: "test",
    sources_checked: sources,
    searched: false,
    kept: priors.length,
    dropped: [],
    citations: Object.fromEntries(sources.map((url, i) => [`prior_rounds[${i}]`, url])),
    rechecked: 0,
    credits: 1,
  });
  return handle;
}

function blogPost(
  url: string,
  title: string,
  date: string,
  r: Parameters<typeof round>[0],
  kind: "press_release" | "roundup" | "article" = "press_release",
) {
  return { round: round(r), source: { url, host: hostOf(url), title }, page_kind: kind, page_date: date, grounded: true };
}

const WIKI = "https://en.wikipedia.org/wiki/History_of_Apple_Inc.";
const RETRO = "https://www.computerhistory.org/atchm/2016/01/how-mike-markkula-funded-apple/";

beforeEach(async () => {
  await (await db()).execute(sql`truncate table companies cascade`);
});

test("Apple's pre-web rounds stay unverified: retrospectives are not dated announcements", async () => {
  const handle = await db();
  await handle.insert(schema.companies).values({ id: "apple.com", name: "Apple", nameKey: "apple", domain: "apple.com" });
  const priors = [
    { stage_as_written: "Angel investment", amount_as_written: "$250,000", announced_date: "1977", lead_investors: ["Mike Markkula"] },
    {
      stage_as_written: "Venture round",
      amount_as_written: "$517,000",
      announced_date: "1978",
      lead_investors: ["Venrock", "Arthur Rock", "Sequoia Capital"],
    },
  ];
  const at = new Date("2026-09-26T00:00:00Z");
  await saveDossier(handle, "apple.com", { ...dossier(priors), investors_and_backers: ["Mike Markkula"], sources: [WIKI] }, WIKI, at, {
    version: 1,
    checked_at: at.toISOString(),
    model: "test",
    sources_checked: [WIKI],
    searched: false,
    kept: 2,
    dropped: [],
    citations: {},
    rechecked: 0,
    credits: 1,
  });
  // The pages a search finds for them: an encyclopedia's history and a retrospective written decades later.
  const apple = (p: Parameters<typeof round>[0]) => round({ company_name: "Apple", lead_investors: [], ...p });
  const { reader: r } = reader({
    search: [
      { url: WIKI, title: "History of Apple Inc.", via: "search" },
      { url: RETRO, title: "How Mike Markkula funded Apple", via: "search" },
    ],
    pages: {
      [WIKI]: [
        {
          round: apple({
            round_type_as_written: "Angel investment",
            amount_as_written: "$250,000",
            announced_date: "1977",
            evidence_quote: "In January 1977 Mike Markkula invested $250,000 in Apple.",
            lead_investors: ["Mike Markkula"],
          }),
          source: { url: WIKI, host: hostOf(WIKI), title: "History of Apple Inc." },
          page_kind: "profile",
          grounded: true,
        },
      ],
      [RETRO]: [
        {
          round: apple({
            round_type_as_written: "Venture round",
            amount_as_written: "$517,000",
            announced_date: "1978",
            evidence_quote: "Apple raised $517,000 from Venrock, Arthur Rock and Sequoia Capital in 1978.",
          }),
          source: { url: RETRO, host: hostOf(RETRO), title: "How Mike Markkula funded Apple", published: "2016-01-03" },
          page_kind: "article",
          page_date: "2016-01-03",
          grounded: true,
        },
      ],
    },
  });
  const keys = await queueCompanyHistory(handle, "apple.com");
  expect(keys).toHaveLength(2);
  for (const key of keys) expect(await promotePrior(handle, r, "apple.com", key, "run-apple")).toMatchObject({ status: "no_source" });
  const ledger = await handle.select().from(schema.historyPromotions).where(eq(schema.historyPromotions.companyId, "apple.com"));
  const tried = ledger.flatMap((row) => ((row.outcome as { tried?: Array<{ result: string }> }).tried ?? []).map((t) => t.result));
  expect(tried.length).toBeGreaterThan(0);
  expect(tried.every((result) => result.startsWith("no rounds kept"))).toBe(true);
  expect(tried.some((result) => result.includes("nonArticle"))).toBe(true);
  const tally = await requestTally(handle, "apple.com");
  expect(tally).toMatchObject({ found: 2, verified: 0 });
  expect(tallyMessage(tally)).toBe(
    "Found 2 earlier rounds in research, verified 0: no dated announcement online from the 1970s for either.",
  );
  expect(await handle.select().from(schema.fundingRounds)).toEqual([]);
});

test("a company whose profile later reads as listed retains its private round without exposing an uncleared page", async () => {
  const handle = await db();
  const seed = record({ company_name: "Anthropic", company_key: "anthropic", company_domain: "anthropic.com", stage: "seed" });
  await persistRecords(handle, [seed], "seed-pre-seed", "run-1");
  const [{ companyId }] = await handle.select({ companyId: schema.fundingRounds.companyId }).from(schema.fundingRounds);
  await handle.insert(schema.enrichments).values({
    companyId,
    kind: "profile",
    data: {
      company_website: "https://anthropic.com",
      website_source: "record",
      profile: {
        what_they_sell: "AI models for businesses.",
        customer_type: "B2B software",
        sells_software_subscription: true,
        identity_reason: "Anthropic's own site.",
        same_company: true,
        public_listing: "NASDAQ: ANTH",
      },
    },
  });
  const page = await getCompany(handle, companyId);
  expect(page).toBeNull();
  expect((await loadVisibleIds()).companies).not.toContain(companyId);
  const [round] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.companyId, companyId));
  expect(round).toMatchObject({ disposition: "review", companyId });
  const [profile] = await handle.select().from(schema.enrichments).where(eq(schema.enrichments.companyId, companyId));
  expect(profile.data).toMatchObject({ profile: { public_listing: "NASDAQ: ANTH" } });
});

test("Clerk: every prior is worked in one pass, and the undated seed takes its day from the company's announcement", async () => {
  const [S, A, B, C] = ["a16z-seed", "series-a", "series-b", "series-c"].map((slug) => `https://clerk.com/blog/${slug}`);
  const priors = [
    { stage_as_written: "Seed", amount_as_written: "$6.2m", announced_date: null, lead_investors: ["Andreessen Horowitz"] },
    { stage_as_written: "Series A", amount_as_written: "$15 million", announced_date: "2023-03-22", lead_investors: ["Madrona"] },
    { stage_as_written: "Series B", amount_as_written: "$30 million", announced_date: "2024-01-18", lead_investors: ["CRV"] },
    { stage_as_written: "Series C", amount_as_written: "$50 million", announced_date: "2025-10-15", lead_investors: ["Menlo Ventures"] },
  ];
  const handle = await requested("clerk.com", "Clerk", priors, [S, A, B, C]);
  const clerk = (p: Parameters<typeof round>[0]) => ({ company_name: "Clerk", ...p });
  const { reader: r } = reader({
    pages: {
      // The extractor copies the post's byline into the round; only "announced today" makes it the announcement's day.
      [S]: [
        blogPost(
          S,
          "Clerk raises $6.2m led by Andreessen Horowitz",
          "2022-11-30",
          clerk({
            round_type_as_written: "Seed",
            amount_as_written: "$6.2m",
            announced_date: "2022-11-30",
            lead_investors: ["Andreessen Horowitz"],
            evidence_quote: "Clerk announced today that it has closed a $6.2m seed round led by Andreessen Horowitz.",
          }),
        ),
      ],
      [A]: [
        blogPost(
          A,
          "Clerk raises $15M Series A",
          "2023-03-22",
          clerk({
            round_type_as_written: "Series A",
            amount_as_written: "$15 million",
            announced_date: "2023-03-22",
            lead_investors: ["Madrona"],
            evidence_quote: "Clerk has raised a $15 million Series A led by Madrona.",
          }),
        ),
      ],
      [B]: [
        blogPost(
          B,
          "Clerk raises $30M Series B",
          "2024-01-18",
          clerk({
            round_type_as_written: "Series B",
            amount_as_written: "$30 million",
            announced_date: "2024-01-18",
            lead_investors: ["CRV"],
            evidence_quote: "Clerk has raised a $30 million Series B led by CRV.",
          }),
        ),
      ],
      [C]: [
        blogPost(
          C,
          "Clerk raises $50m Series C from Menlo and Anthropic's Anthology Fund",
          "2025-10-15",
          clerk({
            round_type_as_written: "Series C",
            amount_as_written: "$50 million",
            announced_date: "2025-10-15",
            lead_investors: ["Menlo", "Anthropic's Anthology Fund"],
            evidence_quote:
              "We're excited to share that Clerk has raised a $50 million Series C, led by Menlo and Anthropic's Anthology Fund.",
          }),
        ),
      ],
    },
  });
  const keys = await queueCompanyHistory(handle, "clerk.com");
  expect(keys).toHaveLength(4);
  for (const key of keys) expect(await promotePrior(handle, r, "clerk.com", key, "run-clerk")).toMatchObject({ status: "promoted" });
  const rounds = await handle
    .select({ stage: schema.fundingRounds.stage, on: schema.fundingRounds.announcedOn })
    .from(schema.fundingRounds)
    .orderBy(schema.fundingRounds.announcedOn);
  expect(rounds).toEqual([
    { stage: "seed", on: "2022-11-30" },
    { stage: "series_a", on: "2023-03-22" },
    { stage: "series_b", on: "2024-01-18" },
    { stage: "series_c", on: "2025-10-15" },
  ]);
  expect(await requestTally(handle, "clerk.com")).toMatchObject({ found: 4, verified: 4 });
});

test("an own-site post that is not the announcement still does not date an undated round", async () => {
  const S = "https://clerk.com/blog/year-in-review";
  const handle = await requested(
    "clerk.com",
    "Clerk",
    [{ stage_as_written: "Seed", amount_as_written: "$6.2m", announced_date: null, lead_investors: [] }],
    [S],
  );
  const { reader: r } = reader({
    pages: {
      [S]: [
        blogPost(S, "Our year in review", "2026-01-05", {
          company_name: "Clerk",
          round_type_as_written: "Seed",
          amount_as_written: "$6.2m",
          announced_date: "2026-01-05",
          lead_investors: [],
          evidence_quote: "Clerk closed a $6.2m seed round.",
        }),
      ],
    },
  });
  const [key] = await queueCompanyHistory(handle, "clerk.com");
  expect(await promotePrior(handle, r, "clerk.com", key, "run")).toMatchObject({ status: "no_source" });
});

test("Raycast: a round a roundup dates to its week takes the day and a second source from the company's own post", async () => {
  const LIST = "https://www.finsmes.com/2024/10/raycast-raises-30m-in-series-b-funding.html";
  const POST = "https://www.raycast.com/blog/raycast-2-0";
  const handle = await requested(
    "raycast.com",
    "Raycast",
    [{ stage_as_written: "Series B", amount_as_written: "$30 million", announced_date: "2024-09", lead_investors: ["Atomico"] }],
    [],
  );
  const raycast = (p: Parameters<typeof round>[0]) => ({
    company_name: "Raycast",
    lead_investors: ["Atomico"],
    round_type_as_written: "Series B",
    amount_as_written: "$30M",
    ...p,
  });
  const { reader: r } = reader({
    search: [
      { url: LIST, title: "Raycast Raises $30M in Series B Funding", via: "search" },
      { url: POST, title: "Raycast 2.0", via: "search" },
    ],
    pages: {
      [LIST]: [
        blogPost(
          LIST,
          "Weekly funding roundup",
          "2024-10-01",
          raycast({ announced_date: null, evidence_quote: "Raycast raised $30M in Series B funding led by Atomico." }),
          "roundup",
        ),
      ],
      [POST]: [
        blogPost(
          POST,
          "Raycast 2.0",
          "2024-09-25",
          raycast({ announced_date: "2024-09-25", evidence_quote: "Today, we're announcing our $30M Series B led by Atomico." }),
        ),
      ],
    },
  });
  const [key] = await queueCompanyHistory(handle, "raycast.com");
  expect(await promotePrior(handle, r, "raycast.com", key, "run")).toMatchObject({ status: "promoted" });
  const [row] = await handle.select().from(schema.fundingRounds);
  expect(row).toMatchObject({ announcedOn: "2024-09-25", datePrecision: "day" });
  const sources = await handle
    .select({ url: schema.sources.url })
    .from(schema.roundSources)
    .innerJoin(schema.sources, eq(schema.sources.id, schema.roundSources.sourceId));
  expect(sources.map((s) => s.url).sort()).toEqual([LIST, POST].sort());
  const [ledger] = await handle.select().from(schema.historyPromotions);
  expect((ledger.outcome as { tried: Array<{ url: string; result: string }> }).tried).toEqual([
    { url: LIST, result: expect.stringMatching(/^matched/) },
    { url: POST, result: "dated the round (company announcement)" },
  ]);
});

test("a requested company's page names why each earlier round is not on it yet, a retrying one as still checking", async () => {
  const handle = await requested("acme.com", "Acme", [], []);
  await handle.insert(schema.companyRequests).values({
    id: crypto.randomUUID(),
    domain: "acme.com",
    submittedUrl: "https://acme.com/",
    requesterHash: "h",
    status: "done",
    companyId: "acme.com",
  });
  const prior = (stage: string, date: string) => ({
    stage_as_written: stage,
    amount_as_written: "$5M",
    announced_date: date,
    lead_investors: [],
  });
  await handle.insert(schema.historyPromotions).values([
    {
      companyId: "acme.com",
      priorKey: "a",
      prior: prior("Seed", "2021-01-01"),
      status: "no_source",
      outcome: { reason: "no page states it" },
    },
    { companyId: "acme.com", priorKey: "b", prior: prior("Series A", "2022-01-01"), status: "failed", attempts: 1 },
    { companyId: "acme.com", priorKey: "c", prior: prior("Series B", "2023-01-01"), origin: "search", status: "pending" },
    { companyId: "acme.com", priorKey: "d", prior: prior("Series B", "2023-01-01"), status: "skipped", outcome: { duplicateOf: "c" } },
    { companyId: "acme.com", priorKey: "e", prior: prior("Series C", "2024-01-01"), status: "failed", attempts: 4 },
  ]);
  const page = await getCompany(handle, "acme.com");
  expect(page?.priorReasons).toEqual({
    a: "no dated announcement found",
    b: "still checking",
    c: "still checking",
    d: "still checking",
    e: "search could not be completed",
  });
  expect(await requestTally(handle, "acme.com")).toMatchObject({ found: 4 });
});

test("a funding search result becomes a lead only when it names the company and states a round", () => {
  const company = { name: "Acme", domain: "acme.com" };
  expect(
    leadsFromCandidate(
      { url: "https://techcrunch.com/2024/05/10/acme-raises-20m/", title: "Acme raises $20M Series A led by Big Fund", via: "search" },
      company,
    ),
  ).toEqual([{ type: "Series A", amount: "$20M", date: "2024-05-10", source_url: "https://techcrunch.com/2024/05/10/acme-raises-20m/" }]);
  expect(
    leadsFromCandidate(
      { url: "https://acme.com/blog/seed", title: "We raised a seed round", published: "2022-11-30", via: "site" },
      company,
    ),
  ).toMatchObject([{ type: "seed round", amount: null, date: "2022-11-30" }]);
  expect(leadsFromCandidate({ url: "https://news.example/x", title: "Other Co raises $5M Series A", via: "search" }, company)).toEqual([]);
  expect(leadsFromCandidate({ url: "https://news.example/acme", title: "Acme launches a new product", via: "search" }, company)).toEqual(
    [],
  );
});

test("a highlight that quotes more rounds yields a lead for each, with only what is stated beside it", () => {
  const company = { name: "PlanetScale", domain: "planetscale.com" };
  const series =
    "https://techcrunch.com/2021/11/16/planetscale-raises-50m-series-c-as-its-enterprise-database-service-hits-general-availability/";
  expect(
    leadsFromCandidate(
      {
        url: series,
        title: "PlanetScale raises $50M Series C as its enterprise database service hits general availability",
        description:
          "# PlanetScale raises $50M Series C as its enterprise database service hits general availability With this, the company has now raised a total of $105 million, including a $30 million Series B it announced only five months ago.",
        via: "search",
      },
      company,
    ),
  ).toEqual([
    { type: "Series C", amount: "$50M", date: "2021-11-16", source_url: series },
    { type: "Series B", amount: "$30 million", date: null, source_url: series },
  ]);
  const table = "https://www.clay.com/dossier/planetscale-funding";
  expect(
    leadsFromCandidate(
      {
        url: table,
        title: "How Much Did PlanetScale Raise? Funding & Key Investors",
        description:
          "# How Much Did PlanetScale Raise? Funding & Key Investors ## How Much Funding Has PlanetScale Raised? | 2018 | Seed Round | $3M | | 2019 | Series A | $22M | | 2021 | Series B | $30M |",
        via: "search",
      },
      company,
    ).map((l) => [l.type, l.amount, l.date]),
  ).toEqual([
    ["Seed Round", "$3M", null],
    ["Series A", "$22M", null],
    ["Series B", "$30M", null],
  ]);
  expect(
    leadsFromCandidate(
      {
        url: "https://tracxn.com/d/companies/planetscale",
        title: "PlanetScale raises $50M Series C",
        description: "PlanetScale is a Series D candidate; rival Neon raised a Series B last year.",
        via: "search",
      },
      company,
    ),
  ).toHaveLength(1);
});

describe("PlanetScale: gap searches find the rounds the first pass missed", () => {
  const TC = (path: string) => `https://techcrunch.com/${path}`;
  const SEED = TC("2018/12/13/planetscale/");
  const RELEASE = "https://www.webwire.com/ViewPressRel.asp?aId=232910";
  const A = TC("2019/05/24/planetscale-raises-22m-series-a/");
  const B = TC("2021/06/23/planetscale-raises-30m-series-b-for-its-database-service/");
  const C = TC("2021/11/16/planetscale-raises-50m-series-c/");
  const result = (url: string, title: string, published: string, description?: string) => ({
    url,
    title,
    published,
    description,
    via: "search" as const,
  });
  const results = {
    // The seed's coverage names no round in its headline or snippet, so a broad search cannot read a lead off it.
    seed: result(
      SEED,
      "They scaled YouTube, now they'll shard everyone with PlanetScale",
      "2018-12-13",
      "PlanetScale brings Vitess to every company.",
    ),
    release: result(
      RELEASE,
      "Ex-YouTube and Dropbox Engineering Powerhouse Teams with Co-Creator of Vitess to Launch PlanetScale",
      "2018-12-13",
      "Today, PlanetScale announced $3 million in seed funding from SignalFire and a dozen top tech and infrastructure vets.",
    ),
    a: result(A, "PlanetScale raises $22M Series A led by a16z", "2019-05-24"),
    b: result(B, "PlanetScale raises $30M Series B for its database service", "2021-06-23"),
    c: result(C, "PlanetScale raises $50M Series C led by Kleiner Perkins", "2021-11-16"),
  };
  const planetscale = (p: Parameters<typeof round>[0]) => ({ company_name: "PlanetScale", lead_investors: [], ...p });
  // The pages as the extractor reads them, their sentences taken from the real coverage.
  const pages = {
    [RELEASE]: [
      blogPost(
        RELEASE,
        results.release.title,
        "2018-12-13",
        planetscale({
          round_type_as_written: "Seed",
          amount_as_written: "$3 million",
          announced_date: "2018-12-13",
          lead_investors: ["SignalFire"],
          evidence_quote:
            "Today, PlanetScale announced $3 million in seed funding from SignalFire and a dozen top tech and infrastructure vets.",
        }),
      ),
    ],
    [SEED]: [
      blogPost(
        SEED,
        results.seed.title,
        "2018-12-13",
        planetscale({
          round_type_as_written: "Seed",
          amount_as_written: "$3 million",
          announced_date: null,
          lead_investors: ["SignalFire"],
          evidence_quote: "PlanetScale quietly raised a $3 million seed round in April, led by SignalFire.",
        }),
        "article",
      ),
    ],
    [A]: [
      blogPost(
        A,
        results.a.title,
        "2019-05-24",
        planetscale({
          round_type_as_written: "Series A",
          amount_as_written: "$22 million",
          announced_date: "2019-05-24",
          lead_investors: ["a16z"],
          evidence_quote: "PlanetScale has raised a $22 million Series A led by a16z.",
        }),
        "article",
      ),
    ],
    [B]: [
      blogPost(
        B,
        results.b.title,
        "2021-06-23",
        planetscale({
          round_type_as_written: "Series B",
          amount_as_written: "$30 million",
          announced_date: "2021-06-23",
          lead_investors: ["Insight Partners"],
          other_investors: ["a16z", "SignalFire"],
          evidence_quote:
            "PlanetScale today announced that it has raised a $30 million Series B funding round led by Insight Partners, with participation from a16z and SignalFire.",
        }),
        "article",
      ),
    ],
    [C]: [
      blogPost(
        C,
        results.c.title,
        "2021-11-16",
        planetscale({
          round_type_as_written: "Series C",
          amount_as_written: "$50 million",
          announced_date: "2021-11-16",
          lead_investors: ["Kleiner Perkins"],
          evidence_quote: "PlanetScale today announced that it has raised a $50 million Series C led by Kleiner Perkins.",
        }),
        "article",
      ),
    ],
  };
  /** The search as it behaved: the broad queries surface only the headline rounds; a stage-specific one finds its round. */
  function searching() {
    const { reader: r } = reader({ pages });
    const queries: string[] = [];
    r.search = async (query: string) => {
      queries.push(query);
      if (/series b/i.test(query)) return [results.b];
      if (/2018/.test(query)) return [results.release];
      if (/seed/i.test(query)) return [results.seed];
      if (/series a/i.test(query)) return [results.a];
      return [results.c, results.a];
    };
    return { r, queries };
  }

  test("the broad pass misses the seed and Series B; the gap searches find and verify them, and B stays apart from C", async () => {
    const priors = [
      { stage_as_written: "Series A", amount_as_written: "$22 million", announced_date: "2019-05-24", lead_investors: ["a16z"] },
      { stage_as_written: "Series C", amount_as_written: "$50 million", announced_date: "2021-11-16", lead_investors: ["Kleiner Perkins"] },
    ];
    const handle = await requested("planetscale.com", "PlanetScale", priors, []);
    const { r, queries } = searching();
    await queueFundingSearch(handle, r, "planetscale.com");
    for (const key of await queueCompanyHistory(handle, "planetscale.com")) await promotePrior(handle, r, "planetscale.com", key, "run");
    const first = await handle.select({ stage: schema.fundingRounds.stage }).from(schema.fundingRounds);
    expect(first.map((x) => x.stage).sort()).toEqual(["series_a", "series_c"]);

    const gap = await queueGapSearch(handle, r, "planetscale.com");
    expect(gap.queries).toEqual(['"PlanetScale" seed round', '"PlanetScale" Series B', '"PlanetScale" raises 2018']);
    expect(gap.queued).toBe(2);
    for (const key of await queueCompanyHistory(handle, "planetscale.com")) await promotePrior(handle, r, "planetscale.com", key, "run");
    const rounds = await handle
      .select({ stage: schema.fundingRounds.stage, on: schema.fundingRounds.announcedOn, usd: schema.fundingRounds.amountUsdMillions })
      .from(schema.fundingRounds)
      .orderBy(schema.fundingRounds.announcedOn);
    expect(rounds.map((x) => [x.stage, x.on])).toEqual([
      ["seed", "2018-12-13"],
      ["series_a", "2019-05-24"],
      ["series_b", "2021-06-23"],
      ["series_c", "2021-11-16"],
    ]);
    const tally = await requestTally(handle, "planetscale.com");
    expect(tally).toMatchObject({ found: 4, verified: 4 });
    expect(tally.priors.map((p) => p.source).sort()).toEqual(["company dossier", "company dossier", "gap search", "gap search"]);
    expect(queries.some((q) => /series b/i.test(q))).toBe(true);
  });

  test("a gap search fires only when the known rounds leave a gap", () => {
    const k = (stage: KnownRound["stage"], on: string | null = null): KnownRound => ({ stage, usd_millions: null, announced_on: on });
    expect(gapQueries("Acme", [])).toEqual([]);
    expect(gapQueries("Acme", [k("seed"), k("series_a"), k("series_b")])).toEqual([]);
    expect(gapQueries("Acme", [k("pre_seed", "2020-01-01"), k("series_a")])).toEqual([]);
    expect(gapQueries("Acme", [k("series_a", "2019-05-24")])).toEqual(['"Acme" seed round', '"Acme" raises 2018']);
    expect(gapQueries("Acme", [k("series_d_plus", "2022-01-01")])).toHaveLength(MAX_GAP_QUERIES);
  });
});

test("a search's rounds are leads to verify, never facts", async () => {
  const handle = await requested("acme.com", "Acme", [], []);
  const prior = { stage_as_written: "Series A", amount_as_written: "$12M", announced_date: "2023-04", lead_investors: [] };
  await handle
    .insert(schema.historyPromotions)
    .values({ companyId: "acme.com", priorKey: "series a|$12m|2023-04", prior, origin: "search", status: "pending" });
  expect(await handle.select().from(schema.fundingRounds)).toEqual([]);
  // No page states it: nothing lands, and the tally says so under the search's name.
  const { reader: r } = reader({ search: [] });
  expect(await promotePrior(handle, r, "acme.com", "series a|$12m|2023-04", "run")).toMatchObject({ status: "no_source" });
  expect(await handle.select().from(schema.fundingRounds)).toEqual([]);
  expect((await requestTally(handle, "acme.com")).priors).toEqual([
    { label: "Series A, $12M, 2023-04", verified: false, reason: "no page found", source: "funding search" },
  ]);
});

test("a requested company left in 'other' takes its sector from its verified profile", async () => {
  const handle = await requested("planetscale.com", "PlanetScale", [], []);
  await handle.update(schema.companies).set({ sector: "other" }).where(eq(schema.companies.id, "planetscale.com"));
  await handle.insert(schema.enrichments).values({
    companyId: "planetscale.com",
    kind: "profile",
    data: {
      profile: {
        what_they_sell: "A serverless MySQL database platform for developers.",
        customer_type: "B2B software",
        same_company: true,
      },
    },
  });
  expect(await fillRequestSector(handle, "planetscale.com")).toBe("developer tools");
  await handle.update(schema.companies).set({ sector: "fintech" }).where(eq(schema.companies.id, "planetscale.com"));
  expect(await fillRequestSector(handle, "planetscale.com")).toBe("fintech");
});

describe("Resend: clean names, own announcements, and dated sources", () => {
  test("a tagline never stays in a company's name; a name with a separator of its own does", () => {
    expect(cleanBrandName("Resend · Email for developers", "resend.com")).toBe("Resend");
    expect(cleanBrandName("Linear | Plan and build products", "linear.app")).toBe("Linear");
    expect(cleanBrandName("Acme: The AI platform", "acme.ai")).toBe("Acme");
    expect(cleanBrandName("Acme - Home", "acme.com")).toBe("Acme");
    expect(cleanBrandName("Home \u2013 Acme", "acme.com")).toBe("Acme");
    expect(cleanBrandName("Build faster \u2014 Vercel", "vercel.com")).toBe("Vercel");
    expect(cleanBrandName("The platform for teams | Foo", "unrelated.com")).toBe("The platform for teams");
    expect(cleanBrandName("Cal.com", "cal.com")).toBe("Cal.com");
    expect(cleanBrandName("Hugging Face", "huggingface.co")).toBe("Hugging Face");
    expect(cleanBrandName("Hugging Face \u2013 The AI community building the future.", "huggingface.co")).toBe("Hugging Face");
    expect(searchName("App", "app.example")).toBe("app.example");
    expect(searchName("Resend", "resend.com")).toBe("Resend");
  });

  test("the repair gives a request's company its clean name and leaves its id; a second run changes nothing", async () => {
    const handle = await db();
    await handle.insert(schema.companies).values({
      id: "resend-email-for-developers",
      name: "Resend · Email for developers",
      nameKey: "resend email for developers",
      domain: "resend.com",
    });
    await handle
      .insert(schema.companies)
      .values({ id: "feed.example", name: "Feed Co: Payments", nameKey: "feed co payments", domain: "feed.example" });
    await handle.insert(schema.companyRequests).values({
      id: crypto.randomUUID(),
      domain: "resend.com",
      submittedUrl: "https://resend.com/",
      requesterHash: "h",
      status: "done",
      companyId: "resend-email-for-developers",
    });
    expect(await repairRequestCompanyNames(handle)).toEqual([
      { id: "resend-email-for-developers", from: "Resend · Email for developers", to: "Resend" },
    ]);
    expect(await repairRequestCompanyNames(handle)).toEqual([]);
    const rows = await handle
      .select({ id: schema.companies.id, name: schema.companies.name })
      .from(schema.companies)
      .orderBy(schema.companies.id);
    expect(rows).toEqual([
      { id: "feed.example", name: "Feed Co: Payments" },
      { id: "resend-email-for-developers", name: "Resend" },
    ]);
  });

  test("the company's own /blog/series-a is a candidate the site map offers, and verifies the round", async () => {
    const POST = "https://resend.com/blog/series-a";
    const handle = await requested("resend.com", "Resend", [], []);
    await handle.insert(schema.historyPromotions).values({
      companyId: "resend.com",
      priorKey: "series a|$18m|",
      prior: { stage_as_written: "Series A", amount_as_written: "$18M", announced_date: null, lead_investors: [] },
      origin: "search",
      status: "pending",
    });
    const { reader: r } = reader({
      pages: {
        [POST]: [
          blogPost(POST, "Announcing our $18M Series A", "2024-12-04", {
            company_name: "Resend",
            round_type_as_written: "Series A",
            amount_as_written: "$18M",
            announced_date: "2024-12-04",
            lead_investors: ["Andreessen Horowitz"],
            evidence_quote: "Today, we're excited to announce our $18M Series A led by Andreessen Horowitz.",
          }),
        ],
      },
    });
    const mapped: string[] = [];
    r.map = async (_domain, search) => {
      mapped.push(search);
      return [
        { url: "https://resend.com/docs/introduction", title: "Introduction", via: "site" },
        { url: POST, title: "Announcing our $18M Series A", via: "site" },
      ];
    };
    expect(await promotePrior(handle, r, "resend.com", "series a|$18m|", "run")).toMatchObject({ status: "promoted" });
    expect(mapped[0]).toMatch(/^Resend Series A/);
    const [row] = await handle.select().from(schema.fundingRounds);
    expect(row).toMatchObject({ stage: "series_a", announcedOn: "2024-12-04" });
  });

  test("a round an own-site page states without its day takes the dated article as a second source", async () => {
    const HANDBOOK = "https://resend.com/handbook/funding";
    const TC = "https://techcrunch.com/2023/07/18/resend-email-for-developers/";
    const handle = await requested("resend.com", "Resend", [], []);
    await handle.insert(schema.historyPromotions).values({
      companyId: "resend.com",
      priorKey: "seed|$3m|2023-07",
      prior: { stage_as_written: "Seed", amount_as_written: "$3M", announced_date: "2023-07", lead_investors: [] },
      origin: "search",
      status: "pending",
    });
    const resend = (p: Parameters<typeof round>[0]) => ({
      company_name: "Resend",
      round_type_as_written: "Seed",
      amount_as_written: "$3M",
      lead_investors: [],
      ...p,
    });
    const { reader: r } = reader({
      search: [
        { url: HANDBOOK, title: "Handbook: how we fund Resend", via: "search", published: "2023-07-20" },
        { url: TC, title: "Resend wants to fix email for developers", via: "search" },
      ],
      pages: {
        // The handbook states the round but no day; the search result's day is all that dates it.
        [HANDBOOK]: [
          {
            round: round(resend({ announced_date: null, evidence_quote: "Resend raised a $3M seed round to build email for developers." })),
            source: { url: HANDBOOK, host: hostOf(HANDBOOK), title: "Handbook: how we fund Resend", published: "2023-07-20" },
            page_kind: "article",
            grounded: true,
          },
        ],
        [TC]: [
          blogPost(
            TC,
            "Resend wants to fix email for developers",
            "2023-07-18",
            resend({ announced_date: "2023-07-18", evidence_quote: "Resend has raised a $3M seed round." }),
            "article",
          ),
        ],
      },
    });
    expect(await promotePrior(handle, r, "resend.com", "seed|$3m|2023-07", "run")).toMatchObject({ status: "promoted" });
    const [row] = await handle.select().from(schema.fundingRounds);
    expect(row).toMatchObject({ announcedOn: "2023-07-18", datePrecision: "day" });
    const sources = await handle
      .select({ url: schema.sources.url })
      .from(schema.roundSources)
      .innerJoin(schema.sources, eq(schema.sources.id, schema.roundSources.sourceId));
    expect(sources.map((s) => s.url.replace(/\/$/, "")).sort()).toEqual([HANDBOOK, TC.replace(/\/$/, "")].sort());
  });
});

describe("tldraw: announcements on sibling sites, a seed extension, and funding databases", () => {
  // The pages as tldraw published them (fetched 2026-09-27) and the databases a search returns beside them.
  const SUBSTACK_SEED = "https://tldraw.substack.com/p/tiny-little-seed-round";
  const DEV_SEED = "https://tldraw.dev/blog/announcing-tldraws-seed-round";
  const DEV_EXTENSION = "https://tldraw.dev/blog/tldraw-raised-another-2m";
  const DEV_SERIES_A = "https://tldraw.dev/blog/announcing-tldraw-series-a";
  const SIGNALBASE = "https://trysignalbase.com/news/funding/tldraw-raises-10m";
  const STARTUPINTROS = "https://startupintros.com/orgs/tldraw";
  const CBINSIGHTS = "https://www.cbinsights.com/company/tldraw/financials";
  const tldraw = (p: Parameters<typeof round>[0]) =>
    round({ company_name: "tldraw", company_website: "https://tldraw.dev", other_investors: [], ...p });
  const pages = {
    [SUBSTACK_SEED]: [
      blogPost(SUBSTACK_SEED, "Announcing tldraw's $2.7M seed", "2022-11-30", {
        ...tldraw({}),
        company_website: null,
        round_type_as_written: "seed round",
        amount_as_written: "$2.7 million",
        announced_date: "2022-11-30",
        lead_investors: ["Lux Capital"],
        other_investors: ["Amplify Partners"],
        evidence_quote:
          "Today I'm announcing tldraw's $2.7 million seed round led by Lux Capital and including the support of Amplify Partners.",
      }),
    ],
    [DEV_SEED]: [
      blogPost(DEV_SEED, "Announcing tldraw's $2.7M seed", "2022-11-30", {
        ...tldraw({}),
        round_type_as_written: "seed round",
        amount_as_written: "$2.7 million",
        announced_date: "2022-11-30",
        lead_investors: ["Lux Capital"],
        evidence_quote: "Today I'm announcing tldraw's $2.7 million seed round led by Lux Capital.",
      }),
    ],
    // The post states no day in its text and writes the figure in words; the page's own day dates it.
    [DEV_EXTENSION]: [
      blogPost(DEV_EXTENSION, "tldraw raised another $2M", "2023-11-22", {
        ...tldraw({}),
        round_type_as_written: "insiders' extension",
        amount_as_written: "two million dollars",
        announced_date: null,
        lead_investors: [],
        other_investors: ["Amplify Partners", "Lux Capital", "Preston-Werner Ventures"],
        evidence_quote:
          "We've raised another two million dollars of venture capital from Amplify Partners, Lux Capital, and Preston-Werner Ventures. This was an insiders' extension, raised exclusively from participants in tldraw's seed.",
      }),
    ],
    [DEV_SERIES_A]: [
      blogPost(DEV_SERIES_A, "tldraw raises $10M to build the infinite canvas for developers", "2025-04-09", {
        ...tldraw({}),
        round_type_as_written: "Series A",
        amount_as_written: "$10M",
        announced_date: "2025-04-09",
        lead_investors: ["Lux Capital", "Definition"],
        evidence_quote: "Today I'm excited to share that tldraw has raised a $10M Series A led by Lux Capital and Definition.",
      }),
    ],
    // A content farm's retelling, misdated to June, and a profile that lists the extension undated.
    [SIGNALBASE]: [
      blogPost(
        SIGNALBASE,
        "tldraw raises $10M",
        "2025-06-22",
        {
          ...tldraw({}),
          company_website: null,
          round_type_as_written: "Funding round",
          amount_as_written: "$10M",
          announced_date: "2025-06-22",
          lead_investors: ["Lux Capital"],
          evidence_quote: "tldraw raised $10M in a funding round led by Lux Capital.",
        },
        "article",
      ),
    ],
    [STARTUPINTROS]: [
      blogPost(
        STARTUPINTROS,
        "tldraw: funding and investors",
        "2023-11-22",
        {
          ...tldraw({}),
          company_website: null,
          round_type_as_written: "Seed",
          amount_as_written: "$2M",
          announced_date: "2023-11-22",
          lead_investors: [],
          evidence_quote: "tldraw raised a $2M seed round on November 22, 2023.",
        },
        "article",
      ),
    ],
  };
  const junk = [
    { url: "https://examples.tldraw.com/custom-shape", title: "Custom shape", via: "site" as const },
    { url: "https://offline.tldraw.com/manual", title: "Manual", via: "site" as const },
    { url: "https://www.tldraw.com/p/k3j2h4g5", title: "Untitled board", via: "site" as const },
  ];
  const searched = (q: string) => {
    if (/series a/i.test(q))
      return [
        { url: SIGNALBASE, title: "tldraw raises $10M", published: "2025-06-22", via: "search" as const },
        { url: DEV_SERIES_A, title: "tldraw raises $10M to build the infinite canvas for developers", via: "search" as const },
      ];
    if (/\$2 million|2023/i.test(q))
      return [
        { url: STARTUPINTROS, title: "tldraw: funding and investors", via: "search" as const },
        { url: DEV_EXTENSION, title: "tldraw raised another $2M", via: "search" as const },
      ];
    return [{ url: DEV_SEED, title: "Announcing tldraw's $2.7M seed", via: "search" as const }];
  };
  const priors = {
    "seed|$2.7m|2022-11": {
      prior: {
        stage_as_written: "Seed",
        amount_as_written: "$2.7M",
        announced_date: "2022-11",
        lead_investors: ["Lux Capital"],
        source_url: SUBSTACK_SEED,
      },
      origin: "search" as const,
    },
    "seed round|$2 million|2023-11": {
      prior: { stage_as_written: "seed round", amount_as_written: "$2 million", announced_date: "2023-11", lead_investors: [] },
      origin: "search" as const,
    },
    "series a|$10m|2025-04": {
      prior: { stage_as_written: "Series A", amount_as_written: "$10M", announced_date: "2025-04", lead_investors: ["Lux Capital"] },
      origin: "search" as const,
    },
    // A database's total offered as a round.
    "series a|$14.7m|": {
      prior: {
        stage_as_written: "Series A",
        amount_as_written: "$14.7M",
        announced_date: null,
        lead_investors: [],
        source_url: CBINSIGHTS,
      },
      origin: "search" as const,
    },
  };

  async function run() {
    const handle = await requested("tldraw.com", "tldraw", [], []);
    for (const [priorKey, { prior, origin }] of Object.entries(priors))
      await handle.insert(schema.historyPromotions).values({ companyId: "tldraw.com", priorKey, prior, origin, status: "pending" });
    const { reader: r, calls } = reader({ pages });
    r.search = async (q) => searched(q);
    r.map = async () => junk;
    const outcomes = [];
    for (const key of Object.keys(priors)) outcomes.push(await promotePrior(handle, r, "tldraw.com", key, "run-tldraw"));
    return { handle, outcomes, calls };
  }

  test("all three rounds verify from tldraw's own posts, dated and staged as announced, and no database is a source", async () => {
    const { handle, outcomes } = await run();
    expect(outcomes.map((o) => o.status)).toEqual(["promoted", "promoted", "promoted", "no_source"]);
    const rounds = await handle
      .select({
        stage: schema.fundingRounds.stage,
        extension: schema.fundingRounds.isExtension,
        on: schema.fundingRounds.announcedOn,
        usd: schema.fundingRounds.amountUsdMillions,
        precision: schema.fundingRounds.datePrecision,
      })
      .from(schema.fundingRounds)
      .orderBy(schema.fundingRounds.announcedOn);
    expect(rounds).toEqual([
      { stage: "seed", extension: false, on: "2022-11-30", usd: "2.700", precision: "day" },
      { stage: "seed", extension: true, on: "2023-11-22", usd: "2.000", precision: "day" },
      { stage: "series_a", extension: false, on: "2025-04-09", usd: "10.000", precision: "day" },
    ]);
    const sources = await handle
      .select({ url: schema.sources.url })
      .from(schema.roundSources)
      .innerJoin(schema.sources, eq(schema.sources.id, schema.roundSources.sourceId));
    const hosts = sources.map((s) => hostOf(s.url));
    expect(hosts.every((h) => h === "tldraw.dev" || h === "tldraw.substack.com")).toBe(true);
    expect(sources.map((s) => s.url.replace(/\/$/, ""))).toEqual(expect.arrayContaining([SUBSTACK_SEED, DEV_EXTENSION, DEV_SERIES_A]));
  });

  test("the lead's own post is read first, app pages are never read, and the database's total stays off the page", async () => {
    const { handle } = await run();
    const ledger = await handle.select().from(schema.historyPromotions).where(eq(schema.historyPromotions.companyId, "tldraw.com"));
    const byKey = Object.fromEntries(
      ledger.map((row) => [row.priorKey, row.outcome as { candidates: string[]; tried: Array<{ url: string }> }]),
    );
    expect(byKey["seed|$2.7m|2022-11"].candidates[0]).toBe(SUBSTACK_SEED);
    for (const outcome of Object.values(byKey))
      expect(outcome.candidates.some((u) => /examples\.|offline\.|tldraw\.com\/p\//.test(u))).toBe(false);
    expect(byKey["series a|$10m|2025-04"].tried.map((t) => t.url)).toEqual([DEV_SERIES_A]);

    const tally = await requestTally(handle, "tldraw.com");
    expect(tally).toMatchObject({ found: 4, verified: 3 });
    const listed = await handle
      .select({ stage: schema.fundingRounds.stage, is_extension: schema.fundingRounds.isExtension })
      .from(schema.fundingRounds);
    expect(alsoFound(tally, listed)).toEqual([]);
    expect(alsoFound(tally, [])).toHaveLength(1);
  });

  test("a round only funding databases state stays unverified, with that reason", async () => {
    const handle = await requested("tldraw.com", "tldraw", [], []);
    const prior = { stage_as_written: "Series A", amount_as_written: "$10M", announced_date: "2025-04", lead_investors: [] };
    await handle
      .insert(schema.historyPromotions)
      .values({ companyId: "tldraw.com", priorKey: "a", prior, origin: "search", status: "pending" });
    const { reader: r } = reader({
      pages,
      search: [{ url: SIGNALBASE, title: "tldraw raises $10M", published: "2025-06-22", via: "search" }],
    });
    expect(await promotePrior(handle, r, "tldraw.com", "a", "run")).toMatchObject({
      status: "no_source",
      reason: "only funding databases state it",
    });
    expect(await handle.select().from(schema.fundingRounds)).toEqual([]);
    const tally = await requestTally(handle, "tldraw.com");
    expect(tally.priors[0].reason).toBe("stated only by funding databases, no announcement found");
  });
});

describe("Jev: the classifier's verdicts on candidates and leads (a scripted classifier)", () => {
  const TC = "https://techcrunch.com/2025/04/09/tldraw-raises-10m-series-a/";
  const MENTION = "https://techcrunch.com/2025/06/01/tldraw-computer-launch/";
  const FORUM = "https://community.example.com/t/tldraw-series-a/123";
  const verdict = (kind: SourceKind, aboutRaise: number, isRound = aboutRaise): PageVerdict => ({
    kind,
    aboutRaise,
    isRound,
    kindConfidence: 0.9,
    model: "fake",
  });
  const verdicts: Record<string, PageVerdict> = {
    [TC]: verdict("news", 0.95),
    [MENTION]: verdict("news", 0.05, 0.6),
    [FORUM]: verdict("other", 0.7),
  };
  const classify: PageClassifier = async (pages) => pages.map((p) => verdicts[p.url] ?? null);
  const tldrawRound = (url: string, title: string, kind: "article" | "press_release" = "article") =>
    blogPost(
      url,
      title,
      "2025-04-09",
      {
        company_name: "tldraw",
        round_type_as_written: "Series A",
        amount_as_written: "$10M",
        announced_date: "2025-04-09",
        lead_investors: ["Lux Capital"],
        evidence_quote: "tldraw has raised a $10M Series A led by Lux Capital.",
      },
      kind,
    );
  const pages = {
    [TC]: [tldrawRound(TC, "tldraw raises $10M Series A")],
    [MENTION]: [tldrawRound(MENTION, "tldraw launches tldraw computer")],
    [FORUM]: [tldrawRound(FORUM, "tldraw Series A thread")],
  };
  const prior = { stage_as_written: "Series A", amount_as_written: "$10M", announced_date: "2025-04", lead_investors: [] };

  async function promote(search: HistoryCandidate[]) {
    const handle = await requested("tldraw.com", "tldraw", [], []);
    await handle
      .insert(schema.historyPromotions)
      .values({ companyId: "tldraw.com", priorKey: "a", prior, origin: "search", status: "pending" });
    const { reader: r } = reader({ pages, search });
    r.classify = classify;
    const outcome = await promotePrior(handle, r, "tldraw.com", "a", "run");
    const [row] = await handle.select().from(schema.historyPromotions);
    return {
      handle,
      outcome,
      ledger: row.outcome as { candidates: string[]; tried: Array<{ url: string; result: string }>; verdicts?: object },
    };
  }

  test("a page that only mentions the raise is never read, the article verifies, and the verdicts are on the ledger", async () => {
    const { handle, outcome, ledger } = await promote([
      { url: MENTION, title: "tldraw launches tldraw computer", description: "tldraw, which raised $10M in April...", via: "search" },
      { url: FORUM, title: "tldraw Series A thread", via: "search" },
      { url: TC, title: "tldraw raises $10M Series A", via: "search" },
    ]);
    expect(outcome.status).toBe("promoted");
    expect(ledger.candidates).not.toContain(MENTION);
    expect(ledger.candidates[0]).toBe(TC);
    expect(ledger.verdicts).toMatchObject({ [TC]: { kind: "news", about: 0.95 }, [FORUM]: { kind: "other" } });
    const [round] = await handle.select().from(schema.fundingRounds);
    expect(round).toMatchObject({ stage: "series_a", announcedOn: "2025-04-09" });
  });

  test("a page the classifier reads as neither an announcement nor an article never verifies on its own", async () => {
    const { outcome, ledger } = await promote([{ url: FORUM, title: "tldraw Series A thread", via: "search" }]);
    expect(outcome).toMatchObject({ status: "no_source", reason: "no announcement or article states it" });
    expect(ledger.tried).toEqual([{ url: FORUM, result: "refused: neither an announcement nor an article" }]);
  });

  test("a result sure to state no round is no lead; one sure to state a round is a lead even from a database's snippet", () => {
    const company = { name: "Acme", domain: "acme.com" };
    const talks = { url: "https://news.example.com/acme-talks", title: "Acme in talks to raise a Series B at $1B", via: "search" as const };
    expect(leadsFromCandidate(talks, company)).toHaveLength(1);
    expect(leadsFromCandidate({ ...talks, verdict: verdict("news", 0.4, 0.05) }, company)).toEqual([]);
    const listing = {
      url: "https://data.example.com/profiles/acme",
      title: "Funding rounds and investors",
      description: "Acme raised $12M led by Index Ventures on May 3, 2024.",
      via: "search" as const,
    };
    expect(leadsFromCandidate(listing, company)).toEqual([]);
    expect(leadsFromCandidate({ ...listing, verdict: verdict("aggregator", 0.6, 0.92) }, company)).toEqual([
      { type: "Funding round", amount: "$12M", date: null, source_url: listing.url },
    ]);
  });

  test("in shadow on the live feed, verdicts are stored beside the rules' decisions and compared", async () => {
    const handle = await db();
    await handle.execute(sql`truncate table page_verdicts`);
    const screened = [
      { url: TC, title: "tldraw raises $10M Series A", kept: true },
      { url: MENTION, title: "tldraw launches tldraw computer", kept: true },
      { url: "https://example.com/top-50-startups", title: "Top 50 startups", kept: false },
    ];
    expect(await recordShadowVerdicts(handle, { lane: "sweep", runId: null, presetSlug: "seed" }, screened, classify)).toBe(2);
    expect(await recordShadowVerdicts(handle, { lane: "sweep", runId: null, presetSlug: "seed" }, screened, null)).toBe(0);
    const c = await compareShadow(handle);
    expect(c).toMatchObject({ total: 2, agree: 1, byLane: { sweep: { total: 2, rulesKept: 2, jevKept: 1 } } });
    expect(c.rulesOnly.map((r) => r.url)).toEqual([MENTION]);
  });

  test("on the live feed Jev only adds: a title-held article it is sure announces a round, never a drop", async () => {
    const handle = await db();
    await handle.execute(sql`truncate table page_verdicts`);
    const sure: PageVerdict = { aboutRaise: 0.93, isRound: 0.95, kind: "news", kindConfidence: 0.9, model: "jev-latest" };
    const byUrl: Record<string, PageVerdict> = {
      "https://news.example.com/2026/09/26/whoop-tracker-raise/": sure,
      "https://news.example.com/2026/09/26/unsure/": { ...sure, aboutRaise: 0.6 },
      "https://data.example.com/2026/09/26/listing/": { ...sure, kind: "aggregator" },
      "https://news.example.com/2026/09/26/kept/": { ...sure, aboutRaise: 0.05 },
    };
    const fake: PageClassifier = async (pages) => pages.map((p) => byUrl[p.url] ?? null);
    const screened = [
      {
        url: "https://news.example.com/2026/09/26/whoop-tracker-raise/",
        title: "Fitness tracker maker raises $200M",
        kept: false,
        heldByTitle: true,
      },
      { url: "https://news.example.com/2026/09/26/unsure/", title: "Tracker", kept: false, heldByTitle: true },
      { url: "https://data.example.com/2026/09/26/listing/", title: "Funding tracker", kept: false, heldByTitle: true },
      { url: "https://news.example.com/2026/09/26/kept/", title: "Acme launches a product", kept: true },
    ];
    const run = { lane: "sweep" as const, runId: null, presetSlug: "seed" };
    expect([...(await screenWithJev(handle, run, screened, fake))]).toEqual(["https://news.example.com/2026/09/26/whoop-tracker-raise/"]);
    expect((await screenWithJev(handle, run, screened, null)).size).toBe(0);
    const failing: PageClassifier = async () => {
      throw new Error("down");
    };
    expect((await screenWithJev(handle, run, screened, failing)).size).toBe(0);
  });
});
