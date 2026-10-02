import { acceptCorroboration, DEFAULT_TIERS, type RoundsPage, sourceMentionsCompany } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { describe, expect, it } from "vitest";
import { corroborateRecord } from "../lib/corroborate.ts";
import { corroborateUnstated, corroborationTargets } from "../lib/intel.ts";
import { listRounds, persistRecords } from "../lib/persist.ts";
import { linksToDrop, pruneCorroborationSources, type StoredLink } from "../lib/prune-corroboration.ts";
import { record, testDb } from "./helpers.ts";

const NOW = new Date("2026-09-04T12:00:00Z");

describe("acceptCorroboration", () => {
  // Ollie, the San Diego AI assistant: $7.5M seed led by Khosla, announced 2026-09-04.
  const ollie = {
    company_name: "Ollie",
    company_domain: "ollie.ai",
    stage: "seed" as const,
    stage_as_written: "seed",
    amount_as_written: "$7.5M",
    announced_date: "2026-09-04",
  };
  const candidate = (partial: Parameters<typeof record>[0]) =>
    record({
      company_key: "ollie",
      company_domain: "ollie.ai",
      stage: "seed",
      stage_as_written: "seed",
      amount: { value: 7.5, currency: "USD", as_written: "$7.5M", usd_millions: 7.5, fx_rate: 1, fx_date: "2026-09-04" },
      announced_date: "2026-09-04",
      ...partial,
    });

  it("accepts the same company under a different stage label inside the week", () => {
    const c = candidate({ company_name: "Ollie", stage: "pre_seed", stage_as_written: "pre-seed", announced_date: "2026-09-02" });
    expect(acceptCorroboration(ollie, c, "Ollie raises pre-seed")).toEqual({ accept: true });
  });

  it("rejects the same name when the amount is three times the record's", () => {
    const c = candidate({
      company_name: "Ollie",
      amount: { value: 22.5, currency: "USD", as_written: "$22.5M", usd_millions: 22.5, fx_rate: 1, fx_date: "2026-09-04" },
    });
    expect(acceptCorroboration(ollie, c, "Ollie raises $22.5M")).toEqual({ accept: false, reason: "amount" });
  });

  it("rejects a different company key with no name in the title", () => {
    const c = candidate({ company_name: "Zenith Robotics", company_key: "zenith robotics", company_domain: null });
    expect(acceptCorroboration(ollie, c, "Zenith Robotics announces its seed round")).toEqual({ accept: false, reason: "company" });
  });

  it("accepts on a shared domain when the title lacks the name", () => {
    const c = candidate({ company_name: "Ollie Pets", company_key: "ollie pets", company_domain: "ollie.ai" });
    expect(acceptCorroboration(ollie, c, "Khosla leads a $7.5M seed for a San Diego AI assistant")).toEqual({ accept: true });
  });

  it("holds a title-only namesake until an identifying fact agrees", () => {
    const c = candidate({ company_name: "Ollie Labs Inc", company_key: "ollie labs", company_domain: null });
    expect(acceptCorroboration(ollie, c, "Ollie announces $7.5M seed")).toEqual({ accept: false, reason: "company" });
    expect(
      acceptCorroboration(
        { ...ollie, company_headquarters: "San Diego" },
        { ...c, headquarters: "San Diego" },
        "Ollie announces $7.5M seed",
      ),
    ).toEqual({ accept: true });
  });

  it("accepts an undated candidate when everything else matches", () => {
    const c = candidate({ company_name: "Ollie", announced_date: null });
    expect(acceptCorroboration(ollie, c, "Ollie raises $7.5M")).toEqual({ accept: true });
    // And an undated record against a dated candidate, on the same stage.
    expect(acceptCorroboration({ ...ollie, announced_date: null }, candidate({ company_name: "Ollie" }), null)).toEqual({ accept: true });
  });

  it("rejects a different stage when either side is undated, and a date outside 45 days", () => {
    const undatedOther = candidate({ company_name: "Ollie", stage: "series_a", stage_as_written: "Series A", announced_date: null });
    expect(acceptCorroboration(ollie, undatedOther, "Ollie").accept).toBe(false);
    const late = candidate({ company_name: "Ollie", announced_date: "2026-11-01" });
    expect(acceptCorroboration(ollie, late, "Ollie")).toEqual({ accept: false, reason: "round" });
  });

  it("leaves two amounts alone when either is missing or not in USD", () => {
    const noAmount = candidate({
      company_name: "Ollie",
      amount: { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null },
    });
    expect(acceptCorroboration(ollie, noAmount, null)).toEqual({ accept: true });
    const euros = candidate({
      company_name: "Ollie",
      amount: { value: 30, currency: "EUR", as_written: "EUR 30M", usd_millions: null, fx_rate: null, fx_date: null },
    });
    expect(acceptCorroboration(ollie, euros, null)).toEqual({ accept: true });
  });

  it("takes the same round's earlier release when the record's day may be a late page's, and only then", () => {
    // Fearn: a $5.5M seed read off Term Sheet's Sep 23 issue; PR Newswire announced it on June 10.
    const fearn = {
      company_name: "Fearn",
      company_domain: "fearn.ai",
      stage: "seed" as const,
      stage_as_written: "seed",
      amount_as_written: "$5.5 million",
      announced_date: "2026-09-23",
      date_basis: "page" as const,
      date_precision: "week" as const,
    };
    const release = candidate({
      company_name: "Fearn",
      company_key: "fearn",
      company_domain: "fearn.ai",
      amount: { value: 5.5, currency: "USD", as_written: "$5.5 million", usd_millions: 5.5, fx_rate: 1, fx_date: "2026-06-10" },
      announced_date: "2026-06-10",
      date_precision: "day",
    });
    expect(acceptCorroboration(fearn, release, "Fearn Raises $5.5 Million Seed to End the Two-Tier Patent System")).toEqual({
      accept: true,
    });
    // Even a stated day can be a later byline; the same release still moves it earlier.
    expect(acceptCorroboration({ ...fearn, date_basis: "stated", date_precision: "day" }, release, null)).toEqual({
      accept: true,
    });
    // A different figure, another stage, or a later page is not this round's earlier announcement.
    const bigger = candidate({
      company_name: "Fearn",
      company_key: "fearn",
      company_domain: "fearn.ai",
      amount: { value: 2, currency: "USD", as_written: "$2 million", usd_millions: 2, fx_rate: 1, fx_date: "2026-01-10" },
      announced_date: "2026-01-10",
    });
    expect(acceptCorroboration(fearn, bigger, null)).toEqual({ accept: false, reason: "round" });
    const preSeed = candidate({ ...release, stage: "pre_seed", stage_as_written: "pre-seed" });
    expect(acceptCorroboration(fearn, preSeed, null)).toEqual({ accept: false, reason: "round" });
    const noFigure = candidate({
      ...release,
      amount: { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null },
    });
    expect(acceptCorroboration(fearn, noFigure, null)).toEqual({ accept: false, reason: "round" });
  });

  it("takes a named round's earlier release for a stageless record whose day may be late", () => {
    // Assort Health (2026-09-25): an SF Business Times profile read as "$120M funding", no label, dated
    // by the page; the company announced the $120M Series C on June 24.
    const profile = {
      company_name: "Assort Health",
      company_domain: "assorthealth.com",
      stage: "other" as const,
      stage_as_written: "funding",
      amount_as_written: "$120 million",
      announced_date: "2026-09-25",
      date_basis: "page" as const,
      date_precision: "day" as const,
    };
    const release = candidate({
      company_name: "Assort Health",
      company_key: "assort health",
      company_domain: "assorthealth.com",
      stage: "series_c",
      stage_as_written: "Series C",
      amount: { value: 120, currency: "USD", as_written: "$120 million", usd_millions: 120, fx_rate: 1, fx_date: "2026-06-24" },
      announced_date: "2026-06-24",
      date_precision: "day",
    });
    const title = "Assort Health Raises $120 Million Series C";
    expect(acceptCorroboration(profile, release, title)).toEqual({ accept: true });
    // A stated day may still be a later byline; a debt facility is never a stageless round's release.
    expect(acceptCorroboration({ ...profile, date_basis: "stated" }, release, title)).toEqual({ accept: true });
    expect(acceptCorroboration(profile, candidate({ ...release, stage: "debt", stage_as_written: "credit facility" }), title)).toEqual({
      accept: false,
      reason: "round",
    });
  });
});

describe("sourceMentionsCompany and linksToDrop", () => {
  const ollie = { name: "Ollie", domain: "ollie.ai" };

  it("reads the host, the title, and the URL slug for the name's longer tokens, and declines to judge without them", () => {
    expect(sourceMentionsCompany({ title: "Our seed round", host: "blog.ollie.ai" }, ollie)).toBe(true);
    expect(sourceMentionsCompany({ title: "Ollie raises $7.5M seed", host: "techcrunch.com" }, ollie)).toBe(true);
    expect(sourceMentionsCompany({ title: "Fresh dog food brand raises Series C", host: "techcrunch.com" }, ollie)).toBe(false);
    // A search result titled with the wrong story, on a page whose slug names the company.
    expect(
      sourceMentionsCompany(
        {
          title: "Emberos Raises $5.5M Seed - The SaaS News",
          host: "thesaasnews.com",
          url: "https://www.thesaasnews.com/news/ollie-raises-7-5m-seed",
        },
        ollie,
      ),
    ).toBe(true);
    expect(sourceMentionsCompany({ title: null, host: "techcrunch.com", url: "https://techcrunch.com" }, ollie)).toBeNull();
    expect(sourceMentionsCompany({ title: null, host: "techcrunch.com" }, ollie)).toBeNull();
    expect(sourceMentionsCompany({ title: "Lux raises", host: "techcrunch.com" }, { name: "Lux", domain: null })).toBeNull();
  });

  it("drops only second-reading links about someone else, never the earliest", () => {
    const at = (iso: string) => new Date(iso);
    const link = (sourceId: string, title: string | null, host: string, query: string | null, fetchedAt: string): StoredLink => ({
      sourceId,
      url: `https://${host}/${sourceId}`,
      title,
      host,
      query,
      fetchedAt: at(fetchedAt),
    });
    const links: StoredLink[] = [
      link("s1", "Weekly funding roundup", "news.example", "Series A funding", "2026-09-01T00:00:00Z"),
      link("s2", "Dog food brand raises $60M", "techcrunch.com", "corroborate", "2026-09-02T00:00:00Z"),
      link("s3", "Ollie announces seed", "prnewswire.com", "corroborate", "2026-09-02T00:00:00Z"),
      link("s4", "A press release", "ollie.ai", "corroborate", "2026-09-03T00:00:00Z"),
      link("s5", "Something else entirely", "blog.example", "watch:blog.example", "2026-09-03T00:00:00Z"),
      link("s6", null, "blog.example", "agent:gap-fill", "2026-09-03T00:00:00Z"),
      link("s7", null, "blog.example", null, "2026-09-03T00:00:00Z"),
    ];
    const seed = { amountValue: 7.5, amountCurrency: "USD" };
    expect(linksToDrop(ollie, seed, links).map((l) => l.sourceId)).toEqual(["s2"]);
    // A headline that omits the name but states the round's own amount is the story itself, and stays.
    const resect = [
      links[0]!,
      link(
        "g",
        "Startup takes on AI hallucinations with $25M and an HQ south of Seattle",
        "geekwire.com",
        "corroborate",
        "2026-09-02T00:00:00Z",
      ),
    ];
    expect(linksToDrop({ name: "Resect", domain: null }, { amountValue: 25, amountCurrency: "USD" }, resect)).toEqual([]);
    // A headline with no amount proves nothing either way.
    const edena = [
      links[0]!,
      link("i", "Singapore dominates Southeast Asia blockchain funding", "itbrief.asia", "corroborate", "2026-09-02T00:00:00Z"),
    ];
    expect(linksToDrop({ name: "Edena Capital", domain: null }, { amountValue: 100, amountCurrency: "USD" }, edena)).toEqual([]);
    // The earliest link is kept even when its title says nothing about the company.
    const earliestOff: StoredLink[] = [
      link("a", "Another company entirely", "x.example", "corroborate", "2026-09-01T00:00:00Z"),
      link("b", "Ollie raises", "y.example", "corroborate", "2026-09-02T00:00:00Z"),
    ];
    expect(linksToDrop(ollie, seed, earliestOff)).toEqual([]);
    expect(linksToDrop(ollie, seed, [links[0]!])).toEqual([]);
  });
});

describe("corroborationTargets", () => {
  const ids = { insertedIds: ["a"], changedIds: ["a", "b"], persistedIds: ["a", "b", "c"] };
  it("follows the rung", () => {
    expect(corroborationTargets({ corroboration: "off" }, ids)).toEqual([]);
    expect(corroborationTargets({ corroboration: "new" }, ids)).toEqual(["a"]);
    expect(corroborationTargets({ corroboration: "new_and_updated" }, ids)).toEqual(["a", "b"]);
    expect(corroborationTargets({ corroboration: "all" }, ids)).toEqual(["a", "b", "c"]);
  });
});

interface FakePage {
  json: RoundsPage;
  title: string;
  published?: string;
}

const WIRE_URL = "https://www.prnewswire.com/news-releases/acme-series-a.html";

/** A client whose search lists the given pages (plus a social page and one the record has) and whose scrape returns them; every call is recorded. */
function fakeClient(pages: Record<string, FakePage>, site?: { domain: string; links: Array<{ url: string; title?: string }> }) {
  const calls: { search: unknown[]; scrape: string[]; map: string[] } = { search: [], scrape: [], map: [] };
  const client = {
    async map(url: string) {
      calls.map.push(url);
      if (!site || !url.includes(site.domain)) throw new Error("no site");
      return { links: site.links };
    },
    async search(query: string, options: unknown) {
      calls.search.push({ query, options });
      return {
        news: Object.entries(pages).map(([url, p]) => ({ url, title: p.title, date: p.published ?? "2026-09-02" })),
        web: [
          { url: "https://www.linkedin.com/company/acme", title: "Acme on LinkedIn" },
          { url: "https://reuters.com/acme", title: "The page the record already has" },
        ],
      };
    },
    async scrape(url: string) {
      calls.scrape.push(url);
      const page = pages[url];
      if (!page) throw new Error(`no fixture for ${url}`);
      return { json: page.json, metadata: { title: page.title, publishedTime: page.published ?? "2026-09-02" } };
    },
  };
  return { client: client as unknown as Firecrawl, calls };
}

const pressRelease: RoundsPage = {
  page_kind: "press_release",
  page_date: "2026-09-02",
  rounds: [
    {
      company_name: "Acme",
      company_website: "https://acme.com",
      company_description: "Acme builds widgets.",
      round_type_as_written: "Series A",
      amount_as_written: "$20 million",
      amount_kind: "round",
      valuation_as_written: null,
      lead_investors: ["Fund One"],
      other_investors: ["Angel Co"],
      announced_date: "2026-09-02",
      headquarters: "Austin, USA",
      sector: "fintech",
      evidence_quote: "Acme today announced $20 million in Series A funding led by Fund One.",
      source_url: null,
      is_background: false,
      is_rumor: false,
    },
  ],
};

/** The same name on another company: a pet food Acme, three times the money, a later stage, other investors. */
const impostor: RoundsPage = {
  page_kind: "article",
  page_date: "2026-08-20",
  rounds: [
    {
      ...pressRelease.rounds[0]!,
      company_website: "https://acmepets.com",
      company_description: "Acme delivers fresh pet food.",
      round_type_as_written: "Series C",
      amount_as_written: "$60 million",
      lead_investors: ["Big Fund"],
      other_investors: ["Other Fund"],
      announced_date: "2026-08-20",
      sector: "consumer",
      evidence_quote: "Acme, the pet food brand, raised $60 million in Series C funding led by Big Fund.",
    },
  ],
};
const IMPOSTOR_URL = "https://techcrunch.com/2026/08/20/acme-pet-food-series-c/";

async function seedReviewRow(handle: Awaited<ReturnType<typeof testDb>>) {
  // One low-tier source, undated, no lead: the queue shape. The wire will date it and name the lead.
  await persistRecords(
    handle,
    [
      record({
        company_name: "Acme",
        company_domain: "acme.com",
        announced_date: null,
        lead_investors: [],
        evidence_quotes: ["Acme raised $20M."],
        confidence: 0.36,
      }),
    ],
    "series-a-b",
    "run-1",
  );
  const { rows } = await listRounds(handle, { includeReview: true });
  const row = rows[0];
  if (!row) throw new Error("seed failed");
  return row;
}

describe("a round merged away mid-lane", () => {
  it("is skipped, and the rest of the batch is corroborated", async () => {
    const handle = await testDb();
    await persistRecords(handle, [record({ company_name: "Acme", company_domain: "acme.com" })], "series-a-b", "run-1");
    const [row] = (await listRounds(handle, { includeReview: true, certainty: "all" })).rows;
    const { client } = fakeClient({});
    const tally = await corroborateUnstated(handle, client, ["gone:series_a:2026-09-02", row.id]);
    expect(tally.corroborated).toBe(1);
  });
});

describe("corroborateRecord", () => {
  it("searches explicitly for an official closing and upgrades the accepted unconfirmed round", async () => {
    const handle = await testDb();
    await persistRecords(
      handle,
      [record({ company_name: "Acme", company_domain: "acme.com", certainty: "unconfirmed" })],
      "series-a-b",
      "run-1",
    );
    const [row] = (await listRounds(handle, { includeReview: true, certainty: "all" })).rows;
    const { client, calls } = fakeClient({ [WIRE_URL]: { json: pressRelease, title: "Acme Announces Series A" } });
    const outcome = await corroborateRecord(handle, client, row.id, { now: NOW, tiers: DEFAULT_TIERS, rates: null });
    expect((calls.search[0] as { query: string }).query).toContain("site:acme.com");
    expect(calls.scrape).toContain(WIRE_URL);
    expect(outcome.added.fields).toContain("certainty");
    const [after] = (await listRounds(handle, { ids: [row.id], includeReview: true })).rows;
    expect(after.certainty).toBe("announced");
    expect(after.reported_on).toBe(row.announced_on);
    expect(after.disposition).toBe(row.disposition);
  });
  it("reads only new pages, adds the source, the lead, and the date, and lifts confidence", async () => {
    const handle = await testDb();
    const row = await seedReviewRow(handle);
    expect(row.disposition).toBe("review");
    const { client, calls } = fakeClient({ [WIRE_URL]: { json: pressRelease, title: "Acme Announces Series A" } });

    const outcome = await corroborateRecord(handle, client, row.id, { now: NOW, tiers: DEFAULT_TIERS, rates: null });

    expect(calls.search).toHaveLength(1);
    expect(calls.scrape).toEqual([WIRE_URL]);
    expect(outcome.read).toBe(1);
    expect(outcome.rejected).toBe(0);
    expect(outcome.added.sources).toBe(1);
    expect(outcome.added.investors).toBe(2);
    expect(outcome.added.fields).toEqual(expect.arrayContaining(["date", "lead"]));
    expect(outcome.confidence.after).toBeGreaterThan(outcome.confidence.before);
    expect(outcome.disposition).toEqual({ before: "review", after: "review" });
    expect(outcome.creditsEstimated).toBeGreaterThan(0);

    const after = (await listRounds(handle, { ids: [row.id], includeReview: true })).rows[0];
    expect(after?.announced_on).toBe("2026-09-02");
    expect(after?.amount.as_written).toBe("$20M");
    expect(after?.lead_investors).toEqual(["Fund One"]);
    expect(after?.other_investors).toEqual(["Angel Co"]);
    expect(after?.sources.map((s) => s.host).sort()).toEqual(["prnewswire.com", "reuters.com"]);
    expect(after?.evidence_quotes).toHaveLength(2);
    expect(after?.confidence).toBe(outcome.confidence.after);

    const [source] = await handle.select().from(schema.sources).where(eq(schema.sources.id, WIRE_URL));
    expect(source?.query).toBe("corroborate");
  });

  it("a page the corroboration reads with a surer day moves a row's borrowed day; a stated day stands", async () => {
    // Gimlet: a republisher's Sep 5 on the row, SiliconANGLE's Sep 4 in the corroborant's URL.
    const handle = await testDb();
    const seed = async (basis: "page" | "stated", id: string, name: string) => {
      await persistRecords(
        handle,
        [
          record({
            id,
            company_name: name,
            company_key: name.toLowerCase(),
            company_domain: `${name.toLowerCase()}.com`,
            announced_date: "2026-09-05",
            date_precision: "day",
            date_basis: basis,
            lead_investors: ["Fund One"],
            evidence_quotes: [`${name} raised $20M in a Series A led by Fund One.`],
            sources: [
              { url: `https://wowtale.example/${id}`, host: "wowtale.example", title: `${name} raises $20M`, published: "2026-09-05" },
            ],
          }),
        ],
        "series-a-b",
        "run-1",
      );
      return (await listRounds(handle, { ids: [id], includeReview: true })).rows[0]!;
    };
    const page = (name: string): RoundsPage => ({
      page_kind: "article",
      page_date: "2026-09-04",
      rounds: [
        {
          ...pressRelease.rounds[0]!,
          company_name: name,
          company_website: `https://${name.toLowerCase()}.com`,
          announced_date: null,
          evidence_quote: `${name} raised $20M in a Series A led by Fund One.`,
        },
      ],
    });
    const borrowed = await seed("page", "gimlet:series_a:2026-09-05", "Gimlet");
    expect(borrowed.date_basis).toBe("page");
    const siliconangle = "https://siliconangle.com/2026/09/04/gimlet-raises-20m/";
    const one = fakeClient({ [siliconangle]: { json: page("Gimlet"), title: "Gimlet raises $20M" } });
    await corroborateRecord(handle, one.client, borrowed.id, { now: NOW, tiers: DEFAULT_TIERS, rates: null });
    const moved = (await listRounds(handle, { ids: [borrowed.id], includeReview: true })).rows[0];
    expect(moved?.announced_on).toBe("2026-09-04");
    expect(moved?.date_precision).toBe("day");

    const stated = await seed("stated", "acme2:series_a:2026-09-05", "Acme2");
    const two = fakeClient({ "https://siliconangle.com/2026/09/04/acme2-raises/": { json: page("Acme2"), title: "Acme2 raises $20M" } });
    await corroborateRecord(handle, two.client, stated.id, { now: NOW, tiers: DEFAULT_TIERS, rates: null });
    expect((await listRounds(handle, { ids: [stated.id], includeReview: true })).rows[0]?.announced_on).toBe("2026-09-05");
  });

  it("maps the company's own site for its release when the row knows the domain, reads it ahead of the search, and takes the day and the lead from it", async () => {
    const handle = await testDb();
    await persistRecords(
      handle,
      [
        record({
          id: "acme:series_a:2026-09-05",
          company_name: "Acme",
          company_domain: "acme.com",
          company_website: "https://acme.com",
          announced_date: "2026-09-05",
          date_precision: "day",
          date_basis: "page",
          lead_investors: [],
          evidence_quotes: ["Acme raised $20M."],
          confidence: 0.36,
        }),
      ],
      "series-a-b",
      "run-1",
    );
    const row = (await listRounds(handle, { includeReview: true })).rows[0]!;
    const release = "https://acme.com/blog/our-series-a";
    const { client, calls } = fakeClient(
      {
        [release]: {
          json: { ...pressRelease, page_date: "2026-09-02" },
          title: "Announcing our $20M Series A led by Fund One",
          published: "2026-09-02",
        },
      },
      {
        domain: "acme.com",
        links: [
          { url: "https://acme.com/blog", title: "Blog" },
          { url: release, title: "Announcing our $20M Series A led by Fund One" },
        ],
      },
    );
    const outcome = await corroborateRecord(handle, client, row.id, { now: NOW, tiers: DEFAULT_TIERS, rates: null });
    expect(calls.map).toEqual(["https://acme.com"]);
    expect(calls.scrape[0]).toBe(release);
    expect(outcome.added.sources).toBe(1);
    const after = (await listRounds(handle, { ids: [row.id], includeReview: true })).rows[0];
    expect(after?.lead_investors).toEqual(["Fund One"]);
    expect(after?.sources.map((s) => s.host)).toContain("acme.com");
    // The company's own page is dated Sep 2; the row's borrowed Sep 5 yields to it.
    expect(after?.announced_on).toBe("2026-09-02");
    // A row that already holds a page on the company's site is not mapped again.
    const again = fakeClient({}, { domain: "acme.com", links: [] });
    await corroborateRecord(handle, again.client, row.id, { now: NOW, tiers: DEFAULT_TIERS, rates: null });
    expect(again.calls.map).toEqual([]);
  });

  it("is idempotent: a second pass finds nothing new", async () => {
    const handle = await testDb();
    const row = await seedReviewRow(handle);
    const { client, calls } = fakeClient({ [WIRE_URL]: { json: pressRelease, title: "Acme Announces Series A" } });
    await corroborateRecord(handle, client, row.id, { now: NOW, tiers: DEFAULT_TIERS, rates: null });
    const again = await corroborateRecord(handle, client, row.id, { now: NOW, tiers: DEFAULT_TIERS, rates: null });
    // The wire page is now a known source, so nothing is read the second time.
    expect(calls.scrape).toHaveLength(1);
    expect(again.read).toBe(0);
    expect(again.rejected).toBe(0);
    expect(again.added).toEqual({ sources: 0, investors: 0, fields: [] });
    expect(again.confidence.before).toBe(again.confidence.after);
  });

  it("ignores a page about a different company and counts it as rejected", async () => {
    const handle = await testDb();
    const row = await seedReviewRow(handle);
    const other: RoundsPage = {
      ...pressRelease,
      rounds: [{ ...pressRelease.rounds[0]!, company_name: "Zenith Robotics", company_website: null }],
    };
    const { client } = fakeClient({ [WIRE_URL]: { json: other, title: "Zenith Robotics Announces Series A" } });
    const outcome = await corroborateRecord(handle, client, row.id, { now: NOW, tiers: DEFAULT_TIERS, rates: null });
    expect(outcome.read).toBe(1);
    expect(outcome.rejected).toBe(1);
    expect(outcome.added).toEqual({ sources: 0, investors: 0, fields: [] });
    const after = (await listRounds(handle, { ids: [row.id], includeReview: true })).rows[0];
    expect(after?.sources).toHaveLength(1);
    expect(after?.disposition).toBe("review");
  });

  it("takes the source, the investors, and the quote from the good page only when an impostor shares the name", async () => {
    const handle = await testDb();
    const row = await seedReviewRow(handle);
    const { client, calls } = fakeClient({
      [WIRE_URL]: { json: pressRelease, title: "Acme Announces Series A" },
      [IMPOSTOR_URL]: { json: impostor, title: "Acme, the pet food brand, raises $60M Series C", published: "2026-08-20" },
    });

    const outcome = await corroborateRecord(handle, client, row.id, { now: NOW, tiers: DEFAULT_TIERS, rates: null });

    expect(calls.scrape.sort()).toEqual([IMPOSTOR_URL, WIRE_URL].sort());
    expect(outcome.read).toBe(2);
    expect(outcome.rejected).toBe(1);
    expect(outcome.added.sources).toBe(1);
    expect(outcome.added.investors).toBe(2);

    const after = (await listRounds(handle, { ids: [row.id], includeReview: true })).rows[0];
    expect(after?.sources.map((s) => s.host).sort()).toEqual(["prnewswire.com", "reuters.com"]);
    expect(after?.lead_investors).toEqual(["Fund One"]);
    expect(after?.other_investors).toEqual(["Angel Co"]);
    expect(after?.evidence_quotes).toHaveLength(2);
    expect(after?.evidence_quotes.join(" ")).not.toContain("pet food");
    expect(after?.amount.as_written).toBe("$20M");
    const [source] = await handle.select().from(schema.sources).where(eq(schema.sources.id, IMPOSTOR_URL));
    expect(source).toBeUndefined();
  });

  it("a row dated to a newsletter's week searches back a year and attaches the round's earlier release, with its own day", async () => {
    // Fearn: Term Sheet (Sep 23) listed a seed PR Newswire announced on June 10; every other page that day
    // was fresh coverage of the same June round, so only the release could say when it was announced.
    const handle = await testDb();
    const termSheet = "https://fortune.com/2026/09/23/climate-tech-vc-fundraising-is-down-almost-40-but-ai-is-driving-deals";
    await persistRecords(
      handle,
      [
        record({
          id: "fearn:seed:2026-09-23",
          company_name: "Fearn",
          company_key: "fearn",
          company_domain: "fearn.ai",
          stage: "seed",
          stage_as_written: "seed",
          amount: { value: 5.5, currency: "USD", as_written: "$5.5 million", usd_millions: 5.5, fx_rate: 1, fx_date: "2026-09-23" },
          announced_date: "2026-09-23",
          date_precision: "week",
          date_basis: "page",
          lead_investors: [],
          other_investors: ["Kindred Ventures"],
          evidence_quotes: ["Fearn, a San Francisco-based AI-powered patent law firm, raised $5.5 million in seed funding."],
          sources: [
            { url: termSheet, host: "fortune.com", title: "Climate tech VC fundraising is down almost 40%, but AI is driving deals" },
          ],
        }),
      ],
      "seed",
      "run-1",
    );
    const release =
      "https://www.prnewswire.com/news-releases/fearn-raises-5-5-million-seed-to-end-the-two-tier-patent-system-302796012.html";
    const page: RoundsPage = {
      page_kind: "press_release",
      page_date: "2026-06-10",
      rounds: [
        {
          ...pressRelease.rounds[0]!,
          company_name: "Fearn",
          company_website: "https://fearn.ai",
          company_description: "the AI-native patent platform",
          round_type_as_written: "seed",
          amount_as_written: "$5.5 million",
          lead_investors: ["Kindred Ventures"],
          other_investors: ["a16z speedrun"],
          announced_date: "2026-06-10",
          evidence_quote: "Fearn, the AI-native patent platform, today announced a $5.5 million seed round led by Kindred Ventures.",
        },
      ],
    };
    const { client, calls } = fakeClient({
      [release]: { json: page, title: "Fearn Raises $5.5 Million Seed to End the Two-Tier Patent System", published: "2026-06-10" },
    });
    const outcome = await corroborateRecord(handle, client, "fearn:seed:2026-09-23", {
      now: new Date("2026-09-23T20:00:00Z"),
      tiers: DEFAULT_TIERS,
      rates: null,
    });
    expect((calls.search[0] as { options: { tbs: string } }).options.tbs).toBe("qdr:y");
    expect(outcome.rejected).toBe(0);
    expect(outcome.added.sources).toBe(1);
    const [source] = await handle.select().from(schema.sources).where(eq(schema.sources.id, release));
    // The release keeps its own day, so the read-back that follows sees when the round was announced.
    expect(source?.publishedAt).toBe("2026-06-10");
  });

  it("accepts a different stage label from the same week and folds it in", async () => {
    const handle = await testDb();
    const row = await seedReviewRow(handle);
    // The record is undated, so the page has to agree on the stage; date it first through the wire, then read a "pre-Series A" roundup.
    const wire = fakeClient({ [WIRE_URL]: { json: pressRelease, title: "Acme Announces Series A" } });
    await corroborateRecord(handle, wire.client, row.id, { now: NOW, tiers: DEFAULT_TIERS, rates: null });
    const roundupUrl = "https://techcrunch.com/2026/09/03/this-weeks-rounds/";
    const roundup: RoundsPage = {
      page_kind: "roundup",
      page_date: "2026-09-03",
      rounds: [
        {
          ...pressRelease.rounds[0]!,
          round_type_as_written: "pre-Series A",
          announced_date: "2026-09-03",
          other_investors: ["Angel Co", "Third Fund"],
          evidence_quote: "Acme closed a $20 million pre-Series A led by Fund One.",
        },
      ],
    };
    const { client } = fakeClient({ [roundupUrl]: { json: roundup, title: "This week's rounds", published: "2026-09-03" } });
    const outcome = await corroborateRecord(handle, client, row.id, { now: NOW, tiers: DEFAULT_TIERS, rates: null });
    expect(outcome.rejected).toBe(0);
    expect(outcome.added.sources).toBe(1);
    expect(outcome.added.investors).toBe(1);
    const after = (await listRounds(handle, { ids: [row.id], includeReview: true })).rows[0];
    expect(after?.stage).toBe("series_a");
    expect(after?.other_investors.sort()).toEqual(["Angel Co", "Third Fund"]);
  });

  it("never reads a job posting, refuses an aggregator's other story, and the link keeps the page's title and sentence", async () => {
    // Basecamp Research's Series C: an Ashby posting and a Techmeme permalink about Coachella both named the company.
    const handle = await testDb();
    const row = await seedReviewRow(handle);
    const jobUrl = "https://jobs.ashbyhq.com/acme/5c8e9cb3-f02c-4938-aa8b-8dd4c5fe61ca";
    const riverUrl = "https://www.techmeme.com/260902/p28";
    const job: RoundsPage = {
      page_kind: "article",
      page_date: "2026-09-02",
      rounds: [{ ...pressRelease.rounds[0]!, evidence_quote: "Acme just raised a $20 million Series A led by Fund One." }],
    };
    const { client, calls } = fakeClient({
      [WIRE_URL]: { json: pressRelease, title: "Acme Announces Series A" },
      [jobUrl]: { json: job, title: "Executive Assistant and Office Manager" },
      [riverUrl]: { json: pressRelease, title: "Coachella promoter Goldenvoice renews its livestreaming partnership with YouTube" },
    });
    const outcome = await corroborateRecord(handle, client, row.id, { now: NOW, tiers: DEFAULT_TIERS, rates: null });
    expect(calls.scrape).not.toContain(jobUrl);
    expect(calls.scrape.sort()).toEqual([riverUrl, WIRE_URL].sort());
    expect(outcome.rejected).toBe(1);
    expect(outcome.added.sources).toBe(1);
    const after = (await listRounds(handle, { ids: [row.id], includeReview: true })).rows[0];
    expect(after?.sources.map((s) => s.host).sort()).toEqual(["prnewswire.com", "reuters.com"]);
    const [link] = await handle.select().from(schema.roundSources).where(eq(schema.roundSources.sourceId, WIRE_URL));
    expect(link?.fieldClaims).toEqual({
      evidence: "Acme today announced $20 million in Series A funding led by Fund One.",
      title: "Acme Announces Series A",
    });
  });
});

describe("pruneCorroborationSources", () => {
  async function seedStore(handle: Awaited<ReturnType<typeof testDb>>) {
    await persistRecords(
      handle,
      [
        record({
          company_name: "Ollie",
          company_domain: "ollie.ai",
          company_website: "https://ollie.ai",
          stage: "seed",
          stage_as_written: "seed",
          sources: [{ url: "https://news.example/ollie", host: "news.example", title: "This week's seed rounds", query: "seed funding" }],
        }),
        record({ company_name: "Solo", sources: [{ url: "https://news.example/solo", host: "news.example", title: "Solo raises" }] }),
      ],
      "seed",
      "run-1",
    );
    const { rows } = await listRounds(handle, { includeReview: true });
    const ollie = rows.find((r) => r.company.name === "Ollie");
    if (!ollie) throw new Error("seed failed");
    const extra = [
      {
        id: "https://techcrunch.com/dog-food",
        host: "techcrunch.com",
        title: "Fresh dog food brand raises $60M Series C",
        query: "corroborate",
      },
      { id: "https://www.prnewswire.com/ollie-seed", host: "prnewswire.com", title: "Ollie Announces $7.5M Seed", query: "corroborate" },
      { id: "https://ollie.ai/blog/seed", host: "ollie.ai", title: "Our seed round", query: "corroborate" },
      { id: "https://blog.example/untitled", host: "blog.example", title: null, query: "agent:gap-fill" },
    ];
    for (const s of extra) {
      await handle.insert(schema.sources).values({ ...s, url: s.id, fetchedAt: new Date("2026-09-05T00:00:00Z") });
      await handle.insert(schema.roundSources).values({ roundId: ollie.id, sourceId: s.id });
    }
    return ollie;
  }

  it("dry-runs the drop list without touching the store", async () => {
    const handle = await testDb();
    const ollie = await seedStore(handle);
    const summary = await pruneCorroborationSources(handle, { dryRun: true });
    expect(summary.rounds).toBe(1);
    expect(summary.checked).toBe(5);
    expect(summary.drops).toEqual([
      {
        roundId: ollie.id,
        company: "Ollie",
        sourceId: "https://techcrunch.com/dog-food",
        title: "Fresh dog food brand raises $60M Series C",
      },
    ]);
    expect(summary.orphans).toBe(1);
    const after = (await listRounds(handle, { ids: [ollie.id], includeReview: true })).rows[0];
    expect(after?.sources).toHaveLength(5);
  });

  it("drops the impostor link and the source row it leaves behind, and is idempotent", async () => {
    const handle = await testDb();
    const ollie = await seedStore(handle);
    const summary = await pruneCorroborationSources(handle);
    expect(summary.drops).toHaveLength(1);
    expect(summary.orphans).toBe(1);
    const after = (await listRounds(handle, { ids: [ollie.id], includeReview: true })).rows[0];
    expect(after?.sources.map((s) => s.host).sort()).toEqual(["blog.example", "news.example", "ollie.ai", "prnewswire.com"]);
    const [gone] = await handle.select().from(schema.sources).where(eq(schema.sources.id, "https://techcrunch.com/dog-food"));
    expect(gone).toBeUndefined();
    const again = await pruneCorroborationSources(handle);
    expect(again.drops).toEqual([]);
    expect(again.orphans).toBe(0);
  });
});
