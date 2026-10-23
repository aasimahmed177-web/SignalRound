import type { NativeWebClient as Firecrawl } from "@fireround/core/web";
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { getCompany } from "../lib/company";
import { corroborateRecord } from "../lib/corroborate";
import { saveDossier } from "../lib/deepdive";
import { listRounds, persistRecords, setDisposition } from "../lib/persist";
import { record, testDb } from "./helpers";

/** Acme: a Series A and a Series B, two sources on the A, one of which the B shares. Beta: one round led by the same fund. */
async function seed() {
  const db = await testDb();
  const acmeA = record({
    company_name: "Acme",
    company_domain: "acme.com",
    company_website: "https://acme.com",
    stage: "series_a",
    announced_date: "2026-03-02",
    lead_investors: ["Big Fund"],
    other_investors: ["Angel Co"],
    sources: [
      { url: "https://techcrunch.com/acme-a", host: "techcrunch.com", title: "Acme raises $20M", published: "2026-03-02" },
      { url: "https://wire.example/acme", host: "wire.example", title: "Acme press release", published: "2026-03-01" },
    ],
    verification: { status: "confirmed", notes: [], url: "https://techcrunch.com/acme-a", sources_seen: 2 },
  });
  const acmeB = record({
    company_name: "Acme",
    company_domain: "acme.com",
    company_website: "https://acme.com",
    stage: "series_b",
    announced_date: "2026-09-02",
    amount: { value: 60, currency: "USD", as_written: "$60M", usd_millions: 60, fx_rate: 1, fx_date: "2026-09-02" },
    lead_investors: ["Big Fund", "Second Fund"],
    other_investors: [],
    sources: [
      { url: "https://techcrunch.com/acme-b", host: "techcrunch.com", title: "Acme raises $60M", published: "2026-09-02" },
      { url: "https://wire.example/acme", host: "wire.example", title: "Acme press release" },
    ],
    verification: { status: "confirmed", notes: [], url: "https://techcrunch.com/acme-b", sources_seen: 2 },
  });
  const beta = record({
    company_name: "Beta",
    stage: "series_a",
    announced_date: "2026-08-20",
    lead_investors: ["Big Fund"],
    other_investors: ["Angel Co"],
    sources: [{ url: "https://news.example/beta", host: "news.example", title: "Beta raises $20M" }],
  });
  await persistRecords(db, [acmeA, acmeB, beta], "series-a-b", "run-1");
  const client = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
  for (const id of [acmeA.id, acmeB.id]) await corroborateRecord(db, client, id, { broad: true, maxPages: 0 });
  return { db, acmeA, acmeB, beta };
}

describe("getCompany", () => {
  test("null for an id the store does not hold", async () => {
    const { db } = await seed();
    expect(await getCompany(db, "nobody.example")).toBeNull();
  });

  test("rounds newest first; totals count the feed's rounds", async () => {
    const { db, acmeA, acmeB } = await seed();
    const page = await getCompany(db, "acme.com");
    expect(page).not.toBeNull();
    if (!page) return;
    expect(page.company).toMatchObject({
      id: "acme.com",
      name: "Acme",
      domain: "acme.com",
      website: "https://acme.com",
      sector: "fintech",
    });
    expect(page.rounds.map((r) => r.id)).toEqual([acmeB.id, acmeA.id]);
    expect(page.totals).toMatchObject({ rounds: 2, usd_millions_raised: 80 });
    expect(page.totals.first_seen).toBeTruthy();
    expect(page.totals.last_seen).toBeTruthy();
  });

  test("review and rejected rows: hidden from a visitor, listed for an admin, never counted", async () => {
    const { db, acmeA, acmeB } = await seed();
    await setDisposition(db, acmeA.id, "rejected");
    const visitor = await getCompany(db, "acme.com");
    expect(visitor?.rounds.map((r) => r.id)).toEqual([acmeB.id]);
    const admin = await getCompany(db, "acme.com", true);
    expect(admin?.rounds.map((r) => r.disposition)).toEqual(["publish", "rejected"]);
    for (const page of [visitor, admin]) {
      // The figures match /companies, which reads the same publish and flagged rows.
      expect(page?.totals).toMatchObject({ rounds: 1, usd_millions_raised: 60 });
      // Angel Co sat only on the rejected A, so it leaves the investor list too.
      expect(page?.investors.map((i) => i.id)).toEqual(["big", "second"]);
    }
    expect((await listRounds(db, { companyId: "acme.com" })).rows).toHaveLength(1);

    await setDisposition(db, acmeA.id, "review");
    expect((await getCompany(db, "acme.com"))?.rounds).toHaveLength(1);
    expect((await getCompany(db, "acme.com", true))?.totals.rounds).toBe(1);
  });

  test("a company the feed does not list is null for a visitor, an empty record for an admin", async () => {
    const { db, beta } = await seed();
    await setDisposition(db, beta.id, "review");
    const id = (await listRounds(db, { ids: [beta.id], includeReview: true })).rows[0]?.company.id ?? "";
    expect(await getCompany(db, id)).toBeNull();
    const admin = await getCompany(db, id, true);
    expect(admin?.rounds.map((r) => r.disposition)).toEqual(["review"]);
    expect(admin?.totals).toMatchObject({ rounds: 0, usd_millions_raised: 0, first_seen: null });
    expect(admin?.investors).toEqual([]);
  });

  test("sources are the union across rounds, one entry per URL, naming the rounds each supports", async () => {
    const { db, acmeA, acmeB } = await seed();
    const page = await getCompany(db, "acme.com");
    const shared = page?.sources.find((s) => s.url === "https://wire.example/acme");
    expect(page?.sources).toHaveLength(3);
    expect(shared?.round_ids.sort()).toEqual([acmeA.id, acmeB.id].sort());
    expect(shared?.published_at).toBe("2026-03-01");
    expect(shared?.title).toBe("Acme press release");
    // Newest publish date first.
    expect(page?.sources.map((s) => s.url)).toEqual([
      "https://techcrunch.com/acme-b",
      "https://techcrunch.com/acme-a",
      "https://wire.example/acme",
    ]);
  });

  test("investors carry their role counts across the company's rounds", async () => {
    const { db } = await seed();
    const page = await getCompany(db, "acme.com");
    expect(page?.investors.map(({ roles: _roles, ...i }) => i)).toEqual([
      { id: "big", name: "Big Fund", domain: null, logo_url: null, leads: 2, participations: 0, total: 2 },
      { id: "second", name: "Second Fund", domain: null, logo_url: null, leads: 1, participations: 0, total: 1 },
      { id: "angel", name: "Angel Co", domain: null, logo_url: null, leads: 0, participations: 1, total: 1 },
    ]);
    // A resolved investor domain rides along for the investor's logo.
    await db.execute(sql`update investors set domain = 'bigfund.vc' where id = 'big'`);
    expect((await getCompany(db, "acme.com"))?.investors[0]).toMatchObject({ id: "big", domain: "bigfund.vc" });
  });

  test("each investor names the rounds it is on and whether it led each, for the by-round panel", async () => {
    const { db, acmeA, acmeB } = await seed();
    const page = await getCompany(db, "acme.com");
    const roles = (id: string) =>
      page?.investors
        .find((i) => i.id === id)
        ?.roles.slice()
        .sort((a, b) => a.round_id.localeCompare(b.round_id));
    expect(roles("big")).toEqual(
      [
        { round_id: acmeA.id, lead: true },
        { round_id: acmeB.id, lead: true },
      ].sort((a, b) => a.round_id.localeCompare(b.round_id)),
    );
    expect(roles("angel")).toEqual([{ round_id: acmeA.id, lead: false }]);
  });

  test("enrichment comes from the stored profile, in the row shape", async () => {
    const { db } = await seed();
    expect((await getCompany(db, "acme.com"))?.enrichment).toBeNull();
    await db.execute(
      sql`insert into enrichments (company_id, kind, data) values ('acme.com', 'profile', ${JSON.stringify({
        website_source: "record",
        company_website: "https://acme.com",
        pricing_page_url: "https://acme.com/pricing",
        profile: { what_they_sell: "Invoicing", customer_type: "SMB", sells_software_subscription: true, same_company: true },
        pricing: { pricing_model: "per seat", has_free_tier: true, plans: [{ name: "Starter", price_as_written: "$10" }] },
      })}::jsonb)`,
    );
    const page = await getCompany(db, "acme.com");
    // The stored profile still carries the two labels above; the read shape drops them.
    expect(page?.enrichment).toEqual({
      what_they_sell: "Invoicing",
      pricing_model: "per seat",
      has_free_tier: true,
      plans: [{ name: "Starter", price_as_written: "$10" }],
      pricing_page_url: "https://acme.com/pricing",
      website_source: "record",
      verified: true,
      error: null,
      brand: null,
    });
    // A profile the identity check refused is unverified and carries the reason.
    await db.execute(
      sql`update enrichments set data = ${JSON.stringify({
        website_source: "unverified",
        company_website: null,
        error: "no homepage verified as Acme: acme.com (sells pistachios)",
        profile: null,
        pricing: null,
      })}::jsonb where company_id = 'acme.com' and kind = 'profile'`,
    );
    const refused = await getCompany(db, "acme.com");
    expect(refused?.enrichment?.verified).toBe(false);
    expect(refused?.enrichment?.error).toContain("pistachios");
  });

  test("dossier is null until a checked deep dive has run, then comes back with its fetch time", async () => {
    const { db } = await seed();
    expect((await getCompany(db, "acme.com"))?.dossier).toBeNull();
    const fetched = new Date("2026-09-04T12:00:00Z");
    await saveDossier(
      db,
      "acme.com",
      {
        one_liner: "Acme builds invoicing for SMBs.",
        founded_year: 2021,
        founders: [{ name: "Ada Example", role: "CEO", background: null }],
        headcount_estimate: null,
        total_raised_as_written: "$80 million",
        prior_rounds: [],
        customers: [],
        investors_and_backers: [],
        competitors: [],
        business_model: null,
        why_it_matters: "Invoicing is a wedge. Acme owns it for SMBs.",
        sources: ["https://acme.com/about"],
      },
      "https://acme.com/about",
      fetched,
      {
        version: 1,
        checked_at: fetched.toISOString(),
        model: "test",
        sources_checked: ["https://acme.com/about"],
        searched: false,
        kept: 5,
        dropped: [],
        citations: {},
        rechecked: 0,
        credits: 1,
      },
    );
    const page = await getCompany(db, "acme.com");
    expect(page?.dossier?.data.one_liner).toBe("Acme builds invoicing for SMBs.");
    expect(page?.dossier?.data.founders[0]?.name).toBe("Ada Example");
    expect(page?.dossier?.fetched_at).toBe(fetched.toISOString());
    // The profile enrichment is a separate row; a dossier does not stand in for it.
    expect(page?.enrichment).toBeNull();
  });
});
