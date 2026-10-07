// The retired providers' purge (lib/third-party-purge.ts): what it removes, what it keeps because
// a page states it, what takes its place, and that a second run finds nothing to do.

import { schema } from "@fireround/core/db";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { persistRecords, setDisposition } from "../lib/persist";
import { applyPurge, planPurge, purgeCounts } from "../lib/third-party-purge";
import { record, testDb } from "./helpers";

const { companies, enrichments, fundingRounds, historyPromotions, accuracyFlags, runs } = schema;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function seed() {
  const db = await testDb();
  const acme = record({
    company_name: "Acme",
    company_key: "acme",
    company_domain: "acme.com",
    evidence_quotes: ["Acme, based in Lisbon, raised $20M."],
    sources: [{ url: "https://reuters.com/acme-series-a", host: "reuters.com", title: "Acme raises $20M" }],
  });
  const beta = record({
    company_name: "Beta",
    company_key: "beta",
    company_domain: "beta.io",
    stage: "other",
    stage_as_written: "funding",
    announced_date: daysAgo(0),
    date_basis: "page",
    amount: { value: 13, currency: "USD", as_written: "$13 million", usd_millions: 13, fx_rate: 1, fx_date: daysAgo(0) },
    evidence_quotes: ["Beta raised $13 million."],
    sources: [{ url: "https://x.com/someone/status/1", host: "x.com", title: "Beta raises" }],
  });
  await persistRecords(db, [acme, beta], "series-a-b", "run-1");
  await setDisposition(db, acme.id, "publish");
  const firmographics = (hq: string, logo: string) => ({ status: "matched", provider: "fullenrich", hq, logo_url: logo, headcount: 40 });
  const yc = { status: "none" };
  await db.insert(enrichments).values([
    {
      companyId: "acme.com",
      kind: "alexandria",
      data: {
        company_key: "acme",
        domain: "acme.com",
        credits: 10,
        yc,
        firmographics: firmographics("Lisbon, Portugal", "https://app.fullenrich.com/logo/acme"),
      },
    },
    {
      companyId: "beta.io",
      kind: "alexandria",
      data: {
        company_key: "beta",
        domain: "beta.io",
        credits: 10,
        yc,
        firmographics: firmographics("Austin, Texas", "https://app.fullenrich.com/logo/beta"),
      },
    },
    {
      companyId: "beta.io",
      kind: "apollo",
      data: { apollo: { status: "matched", hq: "Austin, Texas", logo_url: "https://zenprospect-production.s3.amazonaws.com/beta" } },
    },
    {
      companyId: "beta.io",
      kind: "profile",
      data: {
        company_website: "https://beta.io",
        website_source: "record",
        profile: { what_they_sell: "Billing", same_company: true },
        logo_url: "https://beta.io/logo.svg",
      },
    },
    {
      companyId: "acme.com",
      kind: "deep_dive",
      schemaVersion: 2,
      data: {
        founded_year: 2019,
        headcount_estimate: "about 40 people",
        verification: { checked_at: "2026-10-01T00:00:00Z", citations: { headcount_estimate: "https://acme.com/about" }, dropped: [] },
      },
    },
  ]);
  // The providers' values filled what was empty.
  await db
    .update(companies)
    .set({ hq: "Lisbon, Portugal", logoUrl: "https://app.fullenrich.com/logo/acme" })
    .where(eq(companies.id, "acme.com"));
  await db
    .update(companies)
    .set({ hq: "Austin, Texas", logoUrl: "https://zenprospect-production.s3.amazonaws.com/beta" })
    .where(eq(companies.id, "beta.io"));
  // A lead from the retired source promoted to a history round, and one never found.
  const history = record({
    company_name: "Acme",
    company_key: "acme",
    company_domain: "acme.com",
    stage: "seed",
    stage_as_written: "Seed",
    announced_date: "2023-03-14",
    amount: { value: 4, currency: "USD", as_written: "$4M", usd_millions: 4, fx_rate: 1, fx_date: "2023-03-14" },
  });
  await persistRecords(db, [history], "series-a-b", "history:run");
  await db.update(fundingRounds).set({ history: true, disposition: "publish" }).where(eq(fundingRounds.id, history.id));
  await db.insert(historyPromotions).values([
    {
      companyId: "acme.com",
      priorKey: "seed|$3.9m|2023-03",
      prior: {
        stage_as_written: "Seed",
        amount_as_written: "$3.9M",
        announced_date: "2023-03",
        lead_investors: [],
        source_url: "https://news.example/acme",
      },
      origin: "apollo",
      status: "promoted",
      roundId: history.id,
      sourceUrl: "https://acme.com/blog/seed",
      outcome: { query: '"Acme" Seed $3.9M 2023 funding', verdict: "confirmed", disposition: "publish", merged: false },
    },
    {
      companyId: "acme.com",
      priorKey: "series b|$90m|2026-01",
      prior: { stage_as_written: "Series B", amount_as_written: "$90M", announced_date: "2026-01", lead_investors: [] },
      origin: "apollo",
      status: "pending",
    },
    {
      companyId: "beta.io",
      priorKey: "venture|$13m|2026-07",
      prior: { stage_as_written: "Venture", amount_as_written: "$13M", announced_date: "2026-07", lead_investors: [] },
      origin: "apollo",
      status: "no_source",
    },
  ]);
  // Beta's row was held on the retired source's month alone.
  const note = `held: Apollo reports Venture (Round not Specified) $13M dated ${daysAgo(90).slice(0, 7)}, more than 45 days before this row's ${daysAgo(0)} (a page date, not one the company stated); likely a late re-report of that round, so it is not delivered until a person checks it`;
  await db
    .update(fundingRounds)
    .set({ hold: note, disposition: "review", verification: { status: "confirmed", notes: ["sources agree", note], url: null } })
    .where(eq(fundingRounds.id, beta.id));
  await db.insert(accuracyFlags).values({ companyId: "acme.com", rule: "apollo_total_gap", severity: "medium", reason: "x" });
  await db.insert(runs).values([
    { id: "apollo-backfill:1", presetSlug: "apollo-backfill", lane: "enrich", startedAt: new Date() },
    { id: "sweep:1", presetSlug: "seed", lane: "sweep", startedAt: new Date(), counts: { companies: 3, apollo: 2, apollo_leads: 1 } },
  ]);
  return { db, beta: beta.id, history: history.id };
}

describe("purging the retired providers' data", () => {
  test("removes what they wrote, keeps what a page states, and finds nothing on a second run", async () => {
    const { db, beta, history } = await seed();
    const plan = await planPurge(db);
    expect(purgeCounts(plan)).toMatchObject({
      retired_enrichments_deleted: 1,
      alexandria_firmographics_stripped: 2,
      hq_cleared: 1,
      logos_cleared: 1,
      logos_from_homepage: 1,
      dossier_founded_year_dropped: 1,
      dossier_headcount_dropped: 0,
      holds_lifted: 1,
      ledger_deleted: 2,
      ledger_promoted_kept: 1,
      accuracy_flags_deleted: 1,
      runs_deleted: 1,
      run_counts_stripped: 1,
    });
    // Planning writes nothing.
    expect((await db.select().from(enrichments).where(eq(enrichments.kind, "apollo"))).length).toBe(1);
    expect(Object.values(plan.before).flat().length).toBeGreaterThan(0);

    await applyPurge(db, plan);
    expect(await db.select().from(enrichments).where(eq(enrichments.kind, "apollo"))).toEqual([]);
    const alex = await db.select({ data: enrichments.data }).from(enrichments).where(eq(enrichments.kind, "alexandria"));
    expect(alex.every((a) => !("firmographics" in (a.data as object)))).toBe(true);
    // Lisbon is in Acme's own round evidence, so its headquarters stays; Austin rested on the providers alone.
    const [acme] = await db.select().from(companies).where(eq(companies.id, "acme.com"));
    const [b] = await db.select().from(companies).where(eq(companies.id, "beta.io"));
    expect(acme).toMatchObject({ hq: "Lisbon, Portugal", logoUrl: null });
    expect(b).toMatchObject({ hq: null, logoUrl: "https://beta.io/logo.svg" });
    // The dossier's uncited year goes; the team size a page states stays.
    const [dive] = await db
      .select({ data: enrichments.data })
      .from(enrichments)
      .where(and(eq(enrichments.companyId, "acme.com"), eq(enrichments.kind, "deep_dive")));
    expect(dive.data).toMatchObject({ founded_year: null, headcount_estimate: "about 40 people" });
    // The promoted lead keeps its round and takes the round's own facts; the others go.
    const ledger = await db.select().from(historyPromotions);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      priorKey: "seed|$4m|2023-03-14",
      roundId: history,
      prior: { stage_as_written: "Seed", amount_as_written: "$4M", announced_date: "2023-03-14", source_url: "https://acme.com/blog/seed" },
      outcome: { verdict: "confirmed", disposition: "publish", merged: false },
    });
    expect(JSON.stringify(ledger[0])).not.toContain("news.example");
    // The hold lifts and its note goes; the row stays in review for a person.
    const [held] = await db.select().from(fundingRounds).where(eq(fundingRounds.id, beta));
    expect(held).toMatchObject({ hold: null, disposition: "review", verification: { notes: ["sources agree"] } });
    expect(await db.select().from(accuracyFlags)).toEqual([]);
    const runRows = await db.select().from(runs).orderBy(runs.id);
    expect(runRows.map((r) => [r.id, r.counts])).toEqual([["sweep:1", { companies: 3 }]]);

    const again = purgeCounts(await planPurge(db));
    expect(Object.values(again).every((n) => n === 0)).toBe(true);
  });

  test("a hold another source still supports names that source instead", async () => {
    const { db, beta } = await seed();
    await db.execute(sql`delete from history_promotions where company_id = 'beta.io'`);
    const prior = { stage_as_written: "Seed", amount_as_written: "$13M", announced_date: daysAgo(90).slice(0, 7), lead_investors: [] };
    await db.insert(historyPromotions).values({ companyId: "beta.io", priorKey: "seed|$13m", prior, origin: "search", status: "pending" });
    await applyPurge(db, await planPurge(db));
    const [held] = await db.select().from(fundingRounds).where(eq(fundingRounds.id, beta));
    expect(held.hold).toMatch(/^held: the history ledger \(search\) reports Seed \$13M/);
    expect((held.verification as { notes: string[] }).notes).toEqual(["sources agree", held.hold]);
  });
});
