// Investor websites against the store: a search per investor that has no domain and was never
// checked, one homepage verdict per candidate, the verified domain written with the logo and profile
// off that same read, a miss recorded so it is not paid for twice, a person with an affiliation never
// searched, and a thrown search left for the next pass. A snippet stands in only where the homepage
// could not be read, and its logo is then the branding-only read, chained or over the backlog,
// claimed, isolated, and paid for once like the search.

import { schema } from "@fireround/core/db";
import type { NativeWebClient as Firecrawl } from "@fireround/core/web";
import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import {
  clearInvestorDomains,
  fetchInvestorLogos,
  pendingInvestorDomains,
  pendingInvestorLogos,
  planInvestorDomains,
  planInvestorLogos,
  resolveInvestor,
  resolveInvestorDomains,
} from "../lib/investor-enrich";
import { persistRecords, setDisposition } from "../lib/persist";
import { record, testDb } from "./helpers";

const { investors, roundInvestors } = schema;

interface Page {
  branding?: { logo?: string | null; brandName?: string };
  metadata?: { favicon?: string; creditsUsed?: number; url?: string; title?: string };
  json?: unknown;
  markdown?: string;
}

/**
 * Search results per firm name the query carries (both queries a resolution may spend), and page
 * reads per URL; an Error fixture throws. A URL with no page fixture reads as a page with nothing on
 * it, no verdict included. Every call is recorded.
 */
function fakeClient(
  results: Record<string, Array<{ url: string; title: string; description?: string }> | Error>,
  pages: Record<string, Page | Error> = {},
) {
  const calls: Array<{ query: string; options: unknown }> = [];
  const scrapes: Array<{ url: string; options: unknown }> = [];
  const client = {
    async search(query: string, options: unknown) {
      calls.push({ query, options });
      const key = Object.keys(results).find((k) => query.includes(k));
      const fixture = key ? results[key] : [];
      if (fixture instanceof Error) throw fixture;
      return { web: fixture };
    },
    async scrape(url: string, options: unknown) {
      scrapes.push({ url, options });
      const page = pages[url] ?? { metadata: {} };
      if (page instanceof Error) throw page;
      return page;
    },
  };
  return { client: client as unknown as Firecrawl, calls, scrapes };
}

/**
 * Acme's Series A (Aug) names Acme Ventures and Beta Capital; Gamma's seed (Mar) names Old Fund;
 * Delta's round sits in review naming Hidden Fund. A founder with an affiliation and a fund whose
 * search throws sit on Acme's round too.
 */
async function seed() {
  const db = await testDb();
  const acme = record({
    company_name: "Acme",
    company_domain: "acme.com",
    announced_date: "2026-08-01",
    lead_investors: ["Acme Ventures"],
    other_investors: ["Beta Capital"],
  });
  const gamma = record({ company_name: "Gamma", stage: "seed", announced_date: "2026-03-01", lead_investors: ["Old Fund"] });
  const delta = record({ company_name: "Delta", announced_date: "2026-08-02", lead_investors: ["Hidden Fund"] });
  await persistRecords(db, [gamma], "series-a-b", "run-0");
  await persistRecords(db, [acme, delta], "series-a-b", "run-1");
  await setDisposition(db, gamma.id, "publish");
  await setDisposition(db, acme.id, "publish");
  await setDisposition(db, delta.id, "review");
  // Names the hygiene pass would reshape, attached directly: the resolver sees them as stored.
  await db.insert(investors).values([
    { id: "sylvestre blavet", name: "Sylvestre Blavet (Freelance.com)" },
    { id: "flaky", name: "Flaky Partners" },
  ]);
  await db.insert(roundInvestors).values([
    { roundId: acme.id, investorId: "sylvestre blavet", role: "participant" },
    { roundId: acme.id, investorId: "flaky", role: "participant" },
  ]);
  return { db };
}

const FIXTURES = {
  "Acme Ventures": [
    { url: "https://www.crunchbase.com/organization/acme-ventures", title: "Acme Ventures - Crunchbase" },
    { url: "https://www.acmevc.com/", title: "Acme Ventures", description: "Seed-stage venture capital" },
  ],
  "Beta Capital": [{ url: "https://www.linkedin.com/company/beta-capital", title: "Beta Capital | LinkedIn" }],
  "Old Fund": [{ url: "https://oldfund.com/", title: "Old Fund", description: "We back founders early" }],
  "Flaky Partners": new Error("rate limited"),
};

/** A homepage verdict saying the site is the named investor's, of this kind. */
function site(siteName: string, extra: Record<string, unknown> = {}) {
  return {
    site_name: siteName,
    kind: "venture capital firm",
    identity_reason: `This is ${siteName}'s own site.`,
    is_named_investor: true,
    is_parent_of_named_investor: false,
    business_is_investing: true,
    description: "",
    headquarters: "",
    ...extra,
  };
}

/** The firms' own homepages, each read once with its verdict and its logo. */
const PAGES: Record<string, Page | Error> = {
  "https://www.acmevc.com": {
    json: site("Acme Ventures", { description: "Seed-stage venture capital.", headquarters: "Berlin, Germany" }),
    branding: { brandName: "Acme Ventures", logo: "/logo.svg" },
    metadata: { url: "https://www.acmevc.com/", title: "Acme Ventures", favicon: "/favicon.ico" },
  },
  "https://oldfund.com": {
    json: site("Old Fund"),
    branding: { logo: "data:image/png;base64,AAAA" },
    metadata: { url: "https://oldfund.com/", favicon: "https://oldfund.com/icon.png" },
  },
};

/** The same homepages as the branding-only logo pass reads them, by bare domain. */
const LOGO_PAGES: Record<string, Page | Error> = {
  "https://acmevc.com": { branding: { brandName: "Acme Ventures", logo: "/logo.svg" }, metadata: { favicon: "/favicon.ico" } },
  "https://oldfund.com": { branding: { logo: "data:image/png;base64,AAAA" }, metadata: { favicon: "https://oldfund.com/icon.png" } },
};

/** The firms' homepages unreachable: their resolutions stand on a snippet, with no logo read yet. */
const DOWN: Record<string, Page | Error> = { "https://www.acmevc.com": new Error("timeout"), "https://oldfund.com": new Error("timeout") };

async function row(db: Awaited<ReturnType<typeof testDb>>, id: string) {
  const [r] = await db.select().from(investors).where(eq(investors.id, id));
  return r;
}

describe("resolveInvestorDomains", () => {
  test("a second search's own venture-arm page can verify a parent domain rejected by the first search", async () => {
    let searches = 0;
    let reads = 0;
    const client = {
      async search() {
        searches++;
        return {
          web:
            searches === 1
              ? [{ url: "https://www.nasdaq.com/", title: "Nasdaq: markets and technology" }]
              : [{ url: "https://www.nasdaq.com/nasdaq-ventures", title: "Nasdaq Ventures" }],
        };
      },
      async scrape() {
        reads++;
        return {
          json: site("Nasdaq", {
            kind: "corporation",
            is_named_investor: false,
            business_is_investing: false,
          }),
          metadata: { url: "https://www.nasdaq.com/", title: "Nasdaq" },
        };
      },
    } as unknown as Firecrawl;
    const result = await resolveInvestor(client, "Nasdaq Ventures");
    expect(result).toMatchObject({ outcome: "resolved", domain: "nasdaq.com", type: "corporate_venture" });
    expect(searches).toBe(2);
    expect(reads).toBe(2);
  });

  test("verified sites write the domain, logo, and profile; misses and skips are checked; a thrown search is left for the next pass", async () => {
    const { db } = await seed();
    const { client, calls, scrapes } = fakeClient(FIXTURES, PAGES);
    const r = await resolveInvestorDomains(db, client, { presetSlug: "series-a-b", limit: 25 });
    // Hidden Fund sits only on a review row; Sylvestre Blavet has nothing to search for. Beta
    // Capital's first search offers no site, so the quoted-name search runs too.
    expect(calls.map((c) => c.query).sort()).toEqual([
      '"Beta Capital" venture capital',
      "Acme Ventures investor official website",
      "Beta Capital investor official website",
      "Flaky Partners investor official website",
      "Old Fund investor official website",
    ]);
    expect(calls[0].options).toEqual({ limit: 10, highlights: false });
    // One homepage verdict each for the two that verified, and Beta's round's press page read for links.
    expect(scrapes.map((s) => s.url).sort()).toEqual(["https://oldfund.com", "https://reuters.com/acme", "https://www.acmevc.com"]);
    // Native searches, verdict reads, and the press page use no hosted scraping credits.
    expect(r).toMatchObject({ investors: 5, searched: 4, resolved: 2, skipped: 1, errors: 1, credits: 0, logos: null });
    expect(await row(db, "acme")).toMatchObject({
      domain: "acmevc.com",
      kind: "venture_capital",
      description: "Seed-stage venture capital.",
      headquarters: "Berlin, Germany",
      logoUrl: "https://www.acmevc.com/logo.svg",
    });
    expect((await row(db, "acme")).domainCheckedAt).toBeInstanceOf(Date);
    expect((await row(db, "acme")).logoCheckedAt).toBeInstanceOf(Date);
    // A data: URI is no stored logo, so the favicon stands in, as on a company.
    expect(await row(db, "old")).toMatchObject({ domain: "oldfund.com", logoUrl: "https://oldfund.com/icon.png" });
    expect(await row(db, "beta")).toMatchObject({ domain: null, kind: null });
    expect((await row(db, "beta")).domainCheckedAt).toBeInstanceOf(Date);
    expect((await row(db, "sylvestre blavet")).domainCheckedAt).toBeInstanceOf(Date);
    expect(await row(db, "flaky")).toMatchObject({ domain: null, domainCheckedAt: null });
    expect(await row(db, "hidden")).toMatchObject({ domain: null, domainCheckedAt: null });
    expect(r.outcomes.find((o) => o.id === "flaky")).toMatchObject({ outcome: "error", detail: "rate limited" });

    // The second pass pays only for the one that threw. Its homepage gives no verdict, so the result
    // that passed the snippet bar alone ("flaky.partners" writes the whole name) stands in, with the
    // logo that read found.
    const again = fakeClient(
      { ...FIXTURES, "Flaky Partners": [{ url: "https://flaky.partners/", title: "Flaky Partners" }] },
      { "https://flaky.partners": { branding: { logo: "https://flaky.partners/mark.png" } } },
    );
    const r2 = await resolveInvestorDomains(db, again.client, { presetSlug: "series-a-b", limit: 25 });
    expect(again.calls.map((c) => c.query)).toEqual(["Flaky Partners investor official website", '"Flaky Partners" venture capital']);
    expect(r2).toMatchObject({ searched: 2, resolved: 1, logos: null });
    expect(r2.outcomes[0]).toMatchObject({ outcome: "resolved", domain: "flaky.partners" });
    expect(await row(db, "flaky")).toMatchObject({ domain: "flaky.partners", logoUrl: "https://flaky.partners/mark.png", kind: null });
  });

  test("a namesake's homepage is refused and the firm's own verifies", async () => {
    const { db } = await seed();
    const { client, scrapes } = fakeClient(
      {
        "Acme Ventures": [
          { url: "https://acmeventures.io/", title: "Acme Ventures | Robotics", description: "Robots for warehouses" },
          { url: "https://www.acmevc.com/", title: "Acme Ventures", description: "Seed-stage venture capital" },
        ],
      },
      {
        ...PAGES,
        "https://acmeventures.io": {
          json: site("Acme Ventures Robotics", {
            kind: "startup or other company",
            is_named_investor: false,
            business_is_investing: false,
            identity_reason: "A robotics startup that shares the name.",
          }),
          metadata: { url: "https://acmeventures.io/", title: "Acme Ventures | Robotics" },
        },
      },
    );
    const r = await resolveInvestorDomains(db, client, { ids: ["acme"], limit: 1 });
    expect(scrapes.map((s) => s.url)).toEqual(["https://acmeventures.io", "https://www.acmevc.com"]);
    expect(r.outcomes[0]).toMatchObject({ outcome: "resolved", domain: "acmevc.com" });
    expect(await row(db, "acme")).toMatchObject({ domain: "acmevc.com" });
  });

  test("the round's press release links the firm when neither search offers its site", async () => {
    const { db } = await seed();
    const { client } = fakeClient(FIXTURES, {
      "https://reuters.com/acme": {
        markdown: "Acme raised $20M led by [Acme Ventures](https://www.acmevc.com/) with [Beta Capital](https://betacap.io/).",
      },
      "https://betacap.io": {
        json: site("Beta Capital", { headquarters: "Paris, France" }),
        metadata: { url: "https://betacap.io/", title: "Beta Capital" },
      },
    });
    const r = await resolveInvestorDomains(db, client, { ids: ["beta"], limit: 1 });
    expect(r.outcomes[0]).toMatchObject({ outcome: "resolved", domain: "betacap.io" });
    expect(await row(db, "beta")).toMatchObject({ domain: "betacap.io", headquarters: "Paris, France", kind: "venture_capital" });
  });

  test("an individual is recorded as a person, never onto their own site", async () => {
    const { db } = await seed();
    const [acmeRound] = await db.select().from(roundInvestors).where(eq(roundInvestors.investorId, "acme"));
    await db.insert(investors).values({ id: "jeff hammer", name: "Jeff Hammer" });
    await db.insert(roundInvestors).values({ roundId: acmeRound.roundId, investorId: "jeff hammer", role: "participant" });
    const { client, calls } = fakeClient(
      {
        "Jeff Hammer": [
          { url: "https://www.linkedin.com/in/jeffhammer", title: "Jeff Hammer - Angel investor | LinkedIn" },
          {
            url: "https://jeffhammer.com/",
            title: "Jeff Hammer",
            description: "Angel investor and former founder. I invest in seed-stage startups.",
          },
        ],
      },
      {
        "https://jeffhammer.com": {
          json: site("Jeff Hammer", { kind: "personal website of an individual", business_is_investing: false }),
          metadata: { url: "https://jeffhammer.com/", title: "Jeff Hammer" },
        },
      },
    );
    const r = await resolveInvestorDomains(db, client, { ids: ["jeff hammer"], limit: 1 });
    // One search only, and no press page: an individual's second search would find only their own pages.
    expect(calls).toHaveLength(1);
    expect(r.outcomes[0]).toMatchObject({ outcome: "person", domain: null });
    expect(await row(db, "jeff hammer")).toMatchObject({ domain: null, kind: "person", logoUrl: null });
  });

  test("a one-word name's suffixed host never stands in on its snippet alone", async () => {
    const { db } = await seed();
    const [acmeRound] = await db.select().from(roundInvestors).where(eq(roundInvestors.investorId, "acme"));
    await db.insert(investors).values({ id: "soma", name: "Soma" });
    await db.insert(roundInvestors).values({ roundId: acmeRound.roundId, investorId: "soma", role: "participant" });
    const { client } = fakeClient(
      { Soma: [{ url: "https://soma.ventures/", title: "Soma Ventures", description: "An early-stage venture capital firm" }] },
      { "https://soma.ventures": new Error("private site") },
    );
    const r = await resolveInvestorDomains(db, client, { ids: ["soma"], limit: 1 });
    expect(r.outcomes[0]).toMatchObject({ outcome: "miss", domain: null });
  });

  test("without verification (the Lite rung) one search picks by its snippet, and the logo is the branding read", async () => {
    const { db } = await seed();
    const { client, calls, scrapes } = fakeClient(FIXTURES, LOGO_PAGES);
    const r = await resolveInvestorDomains(db, client, { presetSlug: "series-a-b", limit: 25, verify: false });
    expect(calls.map((c) => c.query).sort()).toEqual([
      "Acme Ventures investor official website",
      "Beta Capital investor official website",
      "Flaky Partners investor official website",
      "Old Fund investor official website",
    ]);
    // No homepage verdict and no press page: only the chained branding reads of what resolved.
    expect(scrapes.map((s) => s.url).sort()).toEqual(["https://acmevc.com", "https://oldfund.com"]);
    expect(r).toMatchObject({ searched: 3, resolved: 2, credits: 0, logos: { found: 2, credits: 0 } });
    expect(await row(db, "acme")).toMatchObject({ domain: "acmevc.com", logoUrl: "https://acmevc.com/logo.svg", kind: null });
  });

  test("the newest rounds' investors come first under a cap; a miss is retried only when asked", async () => {
    const { db } = await seed();
    const first = await pendingInvestorDomains(db, { limit: 10 });
    expect(first.map((p) => p.id).slice(-1)).toEqual(["old"]);
    expect(await pendingInvestorDomains(db, { limit: 2 })).toHaveLength(2);
    expect(await pendingInvestorDomains(db, { presetSlug: "seed-pre-seed", limit: 10 })).toEqual([]);

    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    await db.update(investors).set({ domainCheckedAt: longAgo }).where(eq(investors.id, "beta"));
    const ids = async (retryAfterDays?: number) => (await pendingInvestorDomains(db, { limit: 10, retryAfterDays })).map((p) => p.id);
    expect(await ids()).not.toContain("beta");
    expect(await ids(30)).toContain("beta");
    expect(await ids(60)).not.toContain("beta");
    // Explicit ids reach an investor on a review row too, and still skip one that has its domain.
    await db.update(investors).set({ domain: "oldfund.com" }).where(eq(investors.id, "old"));
    expect((await pendingInvestorDomains(db, { ids: ["hidden", "old"], limit: 10 })).map((p) => p.id)).toEqual(["hidden"]);
  });

  test("clear undoes a bad domain without a search and keeps it from being searched again on its own", async () => {
    const { db } = await seed();
    await resolveInvestorDomains(db, fakeClient(FIXTURES).client, { limit: 25 });
    expect(await row(db, "acme")).toMatchObject({ domain: "acmevc.com" });
    const checkedAt = (await row(db, "acme")).domainCheckedAt;
    // Hidden Fund was never checked: clearing it stamps the check so no pass picks it up.
    const before = await clearInvestorDomains(db, ["acme", "hidden", "nobody"]);
    expect(before.map((b) => [b.id, b.domain]).sort()).toEqual([
      ["acme", "acmevc.com"],
      ["hidden", null],
    ]);
    expect(await row(db, "acme")).toMatchObject({ domain: null, domainCheckedAt: checkedAt });
    expect((await row(db, "hidden")).domainCheckedAt).toBeInstanceOf(Date);
    expect((await pendingInvestorDomains(db, { limit: 25 })).map((p) => p.id)).not.toContain("acme");
    expect(await pendingInvestorDomains(db, { ids: ["acme"], limit: 25 })).toEqual([]);
  });

  test("a forced recheck searches the given ids whatever they hold, and its answer replaces the old one", async () => {
    const { db } = await seed();
    await resolveInvestorDomains(db, fakeClient(FIXTURES).client, { limit: 25 });
    expect(await row(db, "acme")).toMatchObject({ domain: "acmevc.com" });
    // The fresh search finds nothing that passes: the bad domain goes.
    const miss = fakeClient({ "Acme Ventures": [{ url: "https://www.crunchbase.com/organization/acme", title: "Acme Ventures" }] });
    const r = await resolveInvestorDomains(db, miss.client, { ids: ["acme", "beta"], force: true, limit: 2 });
    expect(miss.calls.map((c) => c.query).sort()).toEqual([
      '"Acme Ventures" venture capital',
      '"Beta Capital" venture capital',
      "Acme Ventures investor official website",
      "Beta Capital investor official website",
    ]);
    // Four searches and the round's press page, read once for both.
    expect(r).toMatchObject({ searched: 4, resolved: 0, credits: 0 });
    expect(await row(db, "acme")).toMatchObject({ domain: null });
    // And a hit replaces it.
    const hitAgain = fakeClient({ "Acme Ventures": [{ url: "https://acme.ventures/", title: "Acme Ventures" }] });
    await resolveInvestorDomains(db, hitAgain.client, { ids: ["acme"], force: true, limit: 1 });
    expect(await row(db, "acme")).toMatchObject({ domain: "acme.ventures" });
  });

  test("a write that throws is that investor's error: its claim goes back and the batch keeps its accounting", async () => {
    const { db } = await seed();
    // Any write of a domain onto Old Fund fails, as a store error would.
    await db.execute(sql`create function refuse_old() returns trigger language plpgsql as $$ begin raise exception 'disk full'; end $$`);
    await db.execute(
      sql`create trigger refuse_old before update of domain on investors for each row when (new.id = 'old') execute function refuse_old()`,
    );
    const r = await resolveInvestorDomains(db, fakeClient(FIXTURES, PAGES).client, { limit: 25 });
    expect(r.outcomes.find((o) => o.id === "old")).toMatchObject({ outcome: "error" });
    // Four searches, one verdict each for Acme and Old Fund, and Beta's press page were billed
    // (Flaky's search threw), and the others' writes landed.
    expect(r).toMatchObject({ searched: 4, resolved: 1, errors: 2, credits: 0 });
    expect(await row(db, "acme")).toMatchObject({ domain: "acmevc.com" });
    expect(await row(db, "old")).toMatchObject({ domain: null, domainCheckedAt: null });
  });

  test("overlapping passes claim rows first, so no investor is searched twice", async () => {
    const { db } = await seed();
    const { client, calls } = fakeClient(FIXTURES);
    const [a, b] = await Promise.all([
      resolveInvestorDomains(db, client, { presetSlug: "series-a-b", limit: 25 }),
      resolveInvestorDomains(db, client, { limit: 25 }),
    ]);
    const queries = calls.map((c) => c.query);
    expect(new Set(queries).size).toBe(queries.length);
    // Acme's and Old Fund's homepages give no verdict here, so each spends its second search too.
    expect(queries).toHaveLength(7);
    expect(a.investors + b.investors).toBe(5);
  });

  test("a scoped pass reads only the investors on the rounds or companies it was given", async () => {
    const { db } = await seed();
    const [gammaRound] = await db.select().from(roundInvestors).where(eq(roundInvestors.investorId, "old"));
    expect((await pendingInvestorDomains(db, { roundIds: [gammaRound.roundId], limit: 25 })).map((p) => p.id)).toEqual(["old"]);
    expect((await pendingInvestorDomains(db, { companyIds: ["acme.com"], limit: 25 })).map((p) => p.id).sort()).toEqual([
      "acme",
      "beta",
      "flaky",
      "sylvestre blavet",
    ]);
    expect(await pendingInvestorDomains(db, { roundIds: [], companyIds: [], limit: 25 })).toEqual([]);
  });

  test("skipPeople fills its limit with others even when hundreds of people sort first", async () => {
    const { db } = await seed();
    const [acmeRound] = await db.select().from(roundInvestors).where(eq(roundInvestors.investorId, "acme"));
    const letters = "bcdefghijklmnopqrstuvwxyz";
    // 250 angels on the newest round whose ids sort ahead of every firm on it ("aaron b..." before "acme").
    const people = Array.from(
      { length: 250 },
      (_, i) => `Aaron ${letters[Math.floor(i / 25) % 25].toUpperCase()}${letters[i % 25]}${letters[Math.floor(i / 25)]}`,
    );
    await db.insert(investors).values(people.map((name) => ({ id: name.toLowerCase(), name })));
    await db
      .insert(roundInvestors)
      .values(people.map((name) => ({ roundId: acmeRound.roundId, investorId: name.toLowerCase(), role: "participant" as const })));
    expect((await pendingInvestorDomains(db, { limit: 2 })).every((p) => p.name.startsWith("Aaron"))).toBe(true);
    expect((await pendingInvestorDomains(db, { limit: 2, skipPeople: true })).map((p) => p.id)).toEqual(["acme", "beta"]);
  });

  test("the dry run counts searches and credits without a call", async () => {
    const { db } = await seed();
    const plan = planInvestorDomains(await pendingInvestorDomains(db, { limit: 100 }));
    // The bounded read plan remains visible; native collection has no scraping-credit charge.
    expect(plan).toEqual({ investors: 5, searches: 4, skipped: 1, people: 0, credits: 0, maxCredits: 0 });
  });

  test("skipPeople leaves bare person-shaped names unsearched and pending, and the plan says what that saves", async () => {
    const { db } = await seed();
    const acmeRound = (await db.select().from(roundInvestors).where(eq(roundInvestors.investorId, "acme")))[0];
    await db.insert(investors).values({ id: "jane doe", name: "Jane Doe" });
    await db.insert(roundInvestors).values({ roundId: acmeRound.roundId, investorId: "jane doe", role: "participant" });
    expect(planInvestorDomains(await pendingInvestorDomains(db, { limit: 100 }))).toMatchObject({ searches: 5, people: 1, credits: 0 });
    expect(planInvestorDomains(await pendingInvestorDomains(db, { limit: 100, skipPeople: true }))).toMatchObject({
      searches: 4,
      people: 0,
      credits: 0,
    });
    const { client, calls } = fakeClient(FIXTURES);
    await resolveInvestorDomains(db, client, { limit: 100, skipPeople: true });
    expect(calls.map((c) => c.query)).not.toContain("Jane Doe investor official website");
    expect(await row(db, "jane doe")).toMatchObject({ domain: null, domainCheckedAt: null });
  });
});

describe("investor logos", () => {
  test("a verified site's logo comes off its own homepage read: the brand's file, else the favicon", async () => {
    const { db } = await seed();
    const { client, scrapes } = fakeClient(FIXTURES, PAGES);
    const r = await resolveInvestorDomains(db, client, { presetSlug: "series-a-b", limit: 25 });
    const homepage = scrapes.find((s) => s.url === "https://www.acmevc.com");
    // One read carries the logo (branding) and the verdict (JSON), the header kept so the logo is in it.
    expect(homepage?.options).toMatchObject({ formats: ["branding", { type: "json" }], onlyMainContent: false, timeout: 60_000 });
    expect(r.logos).toBeNull();
    expect(await row(db, "acme")).toMatchObject({ logoUrl: "https://www.acmevc.com/logo.svg" });
    expect(await row(db, "old")).toMatchObject({ logoUrl: "https://oldfund.com/icon.png" });
    expect(await row(db, "beta")).toMatchObject({ logoUrl: null, logoCheckedAt: null });
  });

  test("a snippet-only resolution whose homepage threw gets the branding read chained; logos: false leaves it for the backlog", async () => {
    const { db } = await seed();
    const off = await resolveInvestorDomains(db, fakeClient(FIXTURES, DOWN).client, { limit: 25, logos: false });
    expect(off.resolved).toBe(2);
    expect(off.logos).toBeNull();
    expect(await pendingInvestorLogos(db, { limit: 25 })).toHaveLength(2);

    const { db: db2 } = await seed();
    const { client, scrapes } = fakeClient(FIXTURES, { ...DOWN, "https://acmevc.com": { branding: { logo: "/logo.svg" } } });
    const on = await resolveInvestorDomains(db2, client, { limit: 25 });
    const brandingOnly = (s: { options: unknown }) => JSON.stringify((s.options as { formats: unknown }).formats) === '["branding"]';
    expect(
      scrapes
        .filter(brandingOnly)
        .map((s) => s.url)
        .sort(),
    ).toEqual(["https://acmevc.com", "https://oldfund.com"]);
    // Old Fund's branding read is down too: that one is an error, left for the backlog.
    expect(on.logos).toMatchObject({ investors: 2, scraped: 1, found: 1, errors: 1 });
    expect(await row(db2, "acme")).toMatchObject({ domain: "acmevc.com", logoUrl: "https://acmevc.com/logo.svg", kind: null });
  });

  test("the backlog pass reads domains already resolved; a page with no logo is paid for once unless a retry is asked", async () => {
    const { db } = await seed();
    await resolveInvestorDomains(db, fakeClient(FIXTURES, DOWN).client, { limit: 25, logos: false });
    const plan = planInvestorLogos(await pendingInvestorLogos(db, { limit: 25 }));
    expect(plan).toEqual({ investors: 2, scrapes: 2, credits: 0 });
    const { client, scrapes } = fakeClient({}, { "https://acmevc.com": LOGO_PAGES["https://acmevc.com"] });
    const r = await fetchInvestorLogos(db, client, { limit: 25 });
    expect(scrapes.map((s) => s.url).sort()).toEqual(["https://acmevc.com", "https://oldfund.com"]);
    expect(r).toMatchObject({ investors: 2, scraped: 2, found: 1, errors: 0, credits: 0 });
    expect(r.outcomes.find((o) => o.id === "old")).toMatchObject({ outcome: "miss", logo_url: null });
    expect(await row(db, "old")).toMatchObject({ logoUrl: null });
    expect((await row(db, "old")).logoCheckedAt).toBeInstanceOf(Date);

    const again = fakeClient({}, LOGO_PAGES);
    expect(await fetchInvestorLogos(db, again.client, { limit: 25 })).toMatchObject({ investors: 0, credits: 0 });
    expect(again.scrapes).toEqual([]);
    await db
      .update(investors)
      .set({ logoCheckedAt: new Date(Date.now() - 40 * 86_400_000) })
      .where(eq(investors.id, "old"));
    const retry = await fetchInvestorLogos(db, again.client, { limit: 25, retryAfterDays: 30 });
    expect(again.scrapes.map((s) => s.url)).toEqual(["https://oldfund.com"]);
    expect(retry.found).toBe(1);
    expect(await row(db, "old")).toMatchObject({ logoUrl: "https://oldfund.com/icon.png" });
  });

  test("a scrape that throws is that investor's error: its claim goes back, the batch keeps its accounting", async () => {
    const { db } = await seed();
    const { client } = fakeClient(FIXTURES, { ...PAGES, "https://oldfund.com": new Error("timeout") });
    const r = await resolveInvestorDomains(db, client, { limit: 25 });
    // Old Fund's homepage threw, so its snippet stood in and its second search ran.
    expect(r).toMatchObject({ resolved: 2, credits: 0 });
    // The chained logo read throws too; it is not billed, and the domain it was for stays.
    expect(r.logos).toMatchObject({ investors: 1, scraped: 0, found: 0, errors: 1, credits: 0 });
    expect(r.logos?.outcomes.find((o) => o.id === "old")).toMatchObject({ outcome: "error", detail: "timeout" });
    expect(await row(db, "old")).toMatchObject({ domain: "oldfund.com", logoUrl: null, logoCheckedAt: null });
    // The next pass reads only the one that threw.
    const again = fakeClient({}, LOGO_PAGES);
    await fetchInvestorLogos(db, again.client, { limit: 25 });
    expect(again.scrapes.map((s) => s.url)).toEqual(["https://oldfund.com"]);
  });

  test("a write that throws releases the claim too", async () => {
    const { db } = await seed();
    await resolveInvestorDomains(db, fakeClient(FIXTURES, DOWN).client, { limit: 25, logos: false });
    await db.execute(sql`create function refuse_logo() returns trigger language plpgsql as $$ begin raise exception 'disk full'; end $$`);
    await db.execute(
      sql`create trigger refuse_logo before update of logo_url on investors for each row when (new.id = 'acme') execute function refuse_logo()`,
    );
    const r = await fetchInvestorLogos(db, fakeClient({}, LOGO_PAGES).client, { limit: 25 });
    expect(r).toMatchObject({ scraped: 2, found: 1, errors: 1, credits: 0 });
    expect(await row(db, "acme")).toMatchObject({ logoUrl: null, logoCheckedAt: null });
    expect(await row(db, "old")).toMatchObject({ logoUrl: "https://oldfund.com/icon.png" });
  });

  test("explicit historical usage is retained, while native reads default to zero credits", async () => {
    const { db } = await seed();
    await resolveInvestorDomains(db, fakeClient(FIXTURES, DOWN).client, { limit: 25, logos: false });
    const pages = { ...LOGO_PAGES, "https://acmevc.com": { branding: { logo: "/logo.svg" }, metadata: { creditsUsed: 3 } } };
    const r = await fetchInvestorLogos(db, fakeClient({}, pages).client, { limit: 25 });
    expect(r.credits).toBe(3);
  });

  test("overlapping passes claim rows first, so no homepage is read twice", async () => {
    const { db } = await seed();
    await resolveInvestorDomains(db, fakeClient(FIXTURES, DOWN).client, { limit: 25, logos: false });
    const { client, scrapes } = fakeClient({}, LOGO_PAGES);
    const [a, b] = await Promise.all([
      fetchInvestorLogos(db, client, { presetSlug: "series-a-b", limit: 25 }),
      fetchInvestorLogos(db, client, { limit: 25 }),
    ]);
    expect(scrapes).toHaveLength(2);
    expect(new Set(scrapes.map((s) => s.url)).size).toBe(2);
    expect(a.scraped + b.scraped).toBe(2);
  });

  test("a scoped pass reads only the investors on its rounds or companies, up to its limit", async () => {
    const { db } = await seed();
    await resolveInvestorDomains(db, fakeClient(FIXTURES, DOWN).client, { limit: 25, logos: false });
    expect(await pendingInvestorLogos(db, { roundIds: [], companyIds: [], limit: 25 })).toEqual([]);
    expect((await pendingInvestorLogos(db, { companyIds: ["acme.com"], limit: 25 })).map((p) => p.id)).toEqual(["acme"]);
    expect(await pendingInvestorLogos(db, { limit: 1 })).toHaveLength(1);
    const { client, scrapes } = fakeClient({}, LOGO_PAGES);
    await fetchInvestorLogos(db, client, { companyIds: ["acme.com"], limit: 25 });
    expect(scrapes.map((s) => s.url)).toEqual(["https://acmevc.com"]);
  });

  test("clearing a domain clears its logo; a recheck that moves the domain takes the new homepage's logo, one that keeps it keeps its logo", async () => {
    const { db } = await seed();
    await resolveInvestorDomains(db, fakeClient(FIXTURES, PAGES).client, { limit: 25 });
    await clearInvestorDomains(db, ["old"]);
    expect(await row(db, "old")).toMatchObject({ domain: null, logoUrl: null, logoCheckedAt: null });

    // The new homepage gives no verdict, so its snippet stands in, with the logo that same read found.
    const moved = fakeClient(
      { "Acme Ventures": [{ url: "https://acme.ventures/", title: "Acme Ventures" }] },
      { "https://acme.ventures": { branding: { logo: "https://acme.ventures/mark.png" } } },
    );
    const r = await resolveInvestorDomains(db, moved.client, { ids: ["acme"], force: true, limit: 1 });
    expect(moved.scrapes.filter((s) => s.url === "https://acme.ventures")).toHaveLength(1);
    expect(r.logos).toBeNull();
    expect(await row(db, "acme")).toMatchObject({ domain: "acme.ventures", logoUrl: "https://acme.ventures/mark.png" });

    // Read again with no logo on the page: the domain did not move, so the logo it had stays.
    const same = fakeClient({ "Acme Ventures": [{ url: "https://acme.ventures/", title: "Acme Ventures" }] });
    const kept = await resolveInvestorDomains(db, same.client, { ids: ["acme"], force: true, limit: 1 });
    expect(kept.logos).toBeNull();
    expect(await row(db, "acme")).toMatchObject({ domain: "acme.ventures", logoUrl: "https://acme.ventures/mark.png" });
  });
});
