// The daily accuracy check against an in-memory Postgres: the flags it records for the store as the
// audit found it (OpenAI with no homepage and no dossier, a trend story's Series A, Other stages; a
// real duplicate pair), auto-clear, dismissal, the remedy caps and rests, the route's bearer and dry
// run, and that nothing of it reaches a public demo's visitor. Firecrawl, the enrichment read, and
// the workflow runtime are faked; the rules, the store, and the workflow body are real.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { schema } from "@fireround/core/db";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const started = vi.hoisted(() => [] as Array<{ fn: unknown; args: unknown[] }>);
const enriched = vi.hoisted(() => ({ ids: [] as string[], verify: true }));
const checkModel = vi.hoisted(() => ({ available: true }));

vi.mock("workflow/api", () => ({
  start: vi.fn(async (fn: unknown, args: unknown[]) => {
    started.push({ fn, args });
    return { runId: `wf-${started.length}` };
  }),
}));
vi.mock("@/lib/firecrawl", () => ({ getFirecrawl: () => ({}) }));
vi.mock("@/lib/dossier-check", async (original) => ({
  ...(await original<typeof import("@/lib/dossier-check")>()),
  dossierCheckAvailable: () => checkModel.available,
}));
vi.mock("@/lib/enrich", async (original) => {
  const real = await original<typeof import("@/lib/enrich")>();
  return {
    ...real,
    // The homepage read, faked: it verifies (or not) the company's own site and writes what the real one writes.
    enrichBatch: vi.fn(async (handle: import("@fireround/core/db").Db, _client: unknown, batch: Array<{ id: string; name: string }>) => {
      const c = batch[0];
      enriched.ids.push(c.id);
      const website = `https://${c.id}.com`;
      const e = {
        company_key: c.id,
        company_website: enriched.verify ? website : null,
        website_source: enriched.verify ? "search" : "none",
        profile: enriched.verify
          ? {
              same_company: true,
              identity_reason: "its own site",
              different_business: null,
              what_they_sell: `${c.name} builds things.`,
              customer_type: "enterprise",
              sells_software_subscription: true,
            }
          : null,
        logo_url: enriched.verify ? `${website}/logo.png` : null,
        pricing: null,
        error: enriched.verify ? null : "no homepage found",
      };
      await handle
        .insert(schema.enrichments)
        .values({ companyId: c.id, kind: "profile", data: e })
        .onConflictDoUpdate({
          target: [schema.enrichments.companyId, schema.enrichments.kind],
          set: { data: e },
        });
      if (enriched.verify) {
        await handle
          .update(schema.companies)
          .set({ domain: `${c.id}.com`, website, description: `${c.name} builds things.`, logoUrl: `${website}/logo.png` })
          .where(eq(schema.companies.id, c.id));
      }
      return { resolved: enriched.verify ? 1 : 0, pricing: 0, credits: 6, enrichments: [e] };
    }),
  };
});

import { GET as accuracyGet, POST as accuracyPost } from "../app/api/cron/accuracy/route";
import { GET as runsGet } from "../app/api/v1/runs/route";
import {
  dismissAccuracyFlag,
  evaluateAccuracy,
  listAccuracy,
  markRemedied,
  openAccuracyCount,
  parseAccuracyParams,
  planRemedies,
  recordAccuracy,
  reopenAccuracyFlag,
} from "../lib/accuracy";
import { db } from "../lib/db";
import { listRuns } from "../lib/news";
import { recordRun } from "../lib/persist";
import { gate } from "../proxy";
import { accuracyDossierWorkflow, accuracyWorkflow } from "../workflows/accuracy";
import { companyHistoryWorkflow } from "../workflows/history";

const NOW = new Date("2026-09-24T05:00:00Z");
const TWO_DAYS_AGO = new Date("2026-09-22T05:00:00Z");
const { accuracyFlags, companies, enrichments, fundingRounds, historyPromotions, investors, roundInvestors, runs } = schema;

async function reset(): Promise<void> {
  const h = await db();
  for (const table of [
    "accuracy_flags",
    "accuracy_memory",
    "round_investors",
    "round_sources",
    "sources",
    "funding_rounds",
    "history_promotions",
    "enrichments",
    "investors",
    "companies",
    "runs",
  ]) {
    await h.execute(sql.raw(`delete from ${table}`));
  }
}

async function addCompany(id: string, over: Partial<typeof companies.$inferInsert> = {}): Promise<void> {
  const h = await db();
  await h.insert(companies).values({ id, name: id.charAt(0).toUpperCase() + id.slice(1), nameKey: id, ...over });
}

async function addRound(
  companyId: string,
  over: Partial<typeof fundingRounds.$inferInsert> & { stage: (typeof fundingRounds.$inferInsert)["stage"]; announcedOn: string },
  lead: string | null = "Fund One",
): Promise<string> {
  const h = await db();
  const id = `${companyId}:${over.stage}:${over.announcedOn}`;
  await h.insert(fundingRounds).values({
    id,
    companyId,
    presetSlug: "growth",
    stageAsWritten: "Series B",
    amountUsdMillions: "100",
    amountAsWritten: "$100 million",
    datePrecision: "day",
    confidence: "0.9",
    verification: { status: "confirmed", notes: [], url: null },
    disposition: "publish",
    firstSeenAt: TWO_DAYS_AGO,
    ...over,
  });
  if (lead) {
    const key = lead.toLowerCase();
    await h.insert(investors).values({ id: key, name: lead }).onConflictDoNothing();
    await h.insert(roundInvestors).values({ roundId: id, investorId: key, role: "lead" });
  }
  return id;
}

async function verifiedProfile(companyId: string, domain: string): Promise<void> {
  const h = await db();
  await h.insert(enrichments).values({
    companyId,
    kind: "profile",
    data: {
      company_key: companyId,
      company_website: `https://${domain}`,
      website_source: "record",
      profile: { same_company: true, what_they_sell: "Things." },
    },
  });
}

async function checkedDossier(companyId: string, founders: string[], checkedAt = "2026-09-20T00:00:00.000Z"): Promise<void> {
  const h = await db();
  const data = {
    one_liner: "Builds things.",
    founded_year: 2015,
    founders: founders.map((name) => ({ name, role: "co-founder", background: null })),
    headcount_estimate: null,
    total_raised_as_written: null,
    prior_rounds: [],
    customers: [],
    investors_and_backers: [],
    competitors: [],
    business_model: null,
    why_it_matters: "It builds things.",
    sources: [],
    verification: {
      version: 1,
      checked_at: checkedAt,
      model: "test",
      sources_checked: [],
      searched: false,
      kept: 1,
      dropped: [],
      citations: {},
      rechecked: 0,
      credits: 0,
    },
  };
  await h
    .insert(enrichments)
    .values({ companyId, kind: "deep_dive", data, schemaVersion: 2, fetchedAt: new Date(checkedAt) })
    .onConflictDoUpdate({ target: [enrichments.companyId, enrichments.kind], set: { data, fetchedAt: new Date(checkedAt) } });
}

/** A company with nothing wrong: verified homepage, description, logo, a checked dossier with founders, a lettered round with a lead. */
async function cleanCompany(id: string, usd = "150"): Promise<void> {
  await addCompany(id, { domain: `${id}.com`, description: "Builds things.", logoUrl: `https://${id}.com/logo.png` });
  await verifiedProfile(id, `${id}.com`);
  await checkedDossier(id, ["Ada Lovelace"]);
  await addRound(id, {
    stage: "series_c",
    stageAsWritten: "Series C",
    announcedOn: "2025-06-01",
    amountUsdMillions: usd,
    amountAsWritten: `$${usd} million`,
  });
}

/** OpenAI as the audit found it, stored: no domain, no dossier, a trend story's Series A beside its Other rounds, and Apollo's record. */
async function openaiBefore(): Promise<void> {
  await addCompany("openai", { name: "OpenAI" });
  await addRound(
    "openai",
    {
      stage: "other",
      stageAsWritten: "funding round",
      announcedOn: "2024-10-02",
      amountUsdMillions: "6600",
      amountAsWritten: "$6.6 billion",
    },
    null,
  );
  await addRound(
    "openai",
    {
      stage: "other",
      stageAsWritten: "funding round",
      announcedOn: "2025-03-31",
      amountUsdMillions: "40000",
      amountAsWritten: "$40 billion",
    },
    "SoftBank",
  );
  await addRound(
    "openai",
    {
      stage: "series_a",
      stageAsWritten: "Series A",
      announcedOn: "2026-09-23",
      amountUsdMillions: null,
      amountAsWritten: null,
      confidence: "0.64",
      disposition: "flagged",
      verification: { status: "unverified", notes: [], url: null },
    },
    null,
  );
  const h = await db();
  const url = "https://news.crunchbase.com/venture/biggest-funding-rounds-megarounds-ai-chips-robotics";
  await h
    .insert(schema.sources)
    .values({ id: url, url, host: "news.crunchbase.com", title: "The Week's 10 Biggest Funding Rounds: Megarounds For AI Chips" });
  await h.insert(schema.roundSources).values({ roundId: "openai:series_a:2026-09-23", sourceId: url });
  await h.insert(enrichments).values({
    companyId: "openai",
    kind: "apollo",
    data: {
      schema_version: 1,
      company_key: "openai",
      domain: "openai.com",
      credits: 30,
      apollo: {
        status: "matched",
        apollo_id: "x",
        name: "OpenAI",
        domain: "openai.com",
        linkedin_url: null,
        hq: null,
        country: null,
        headcount: null,
        founded_year: 2015,
        logo_url: null,
        total_funding_usd: 180_000_000_000,
        funding_events: [
          {
            type: "Series E",
            amount: "$10B",
            date: "2023-01",
            source_url: "https://blogs.microsoft.com/blog/2023/01/23/microsoftandopenaiextendpartnership/",
          },
        ],
      },
      signals: {},
      leads_queued: 0,
    },
  });
}

async function flagRows() {
  return (await db()).select().from(accuracyFlags).orderBy(accuracyFlags.companyId, accuracyFlags.rule);
}

beforeEach(async () => {
  await reset();
  started.length = 0;
  enriched.ids = [];
  enriched.verify = true;
  checkModel.available = true;
  process.env.FIRECRAWL_API_KEY = "fc-test";
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.PUBLIC_DEMO;
  delete process.env.DASHBOARD_PASSWORD;
  delete process.env.CRON_SECRET;
});

describe("the check over the store", () => {
  test("OpenAI before the fix is flagged on every count; a clean company is not", async () => {
    await openaiBefore();
    await cleanCompany("acme");
    const handle = await db();
    const evaluation = await evaluateAccuracy(handle, { now: NOW });
    expect(evaluation.checked.map((l) => l.company.id)).toEqual(["openai", "acme"]);
    const rules = evaluation.results.filter((r) => r.companyId === "openai").map((r) => r.flag.rule);
    expect(rules.sort()).toEqual(
      [
        "apollo_missing_round",
        "apollo_total_gap",
        "dossier_missing",
        "list_only",
        "no_description",
        "no_domain",
        "no_lead_large",
        "no_logo",
        "stage_other_large",
        "stage_regression",
        "unverified",
      ].sort(),
    );
    expect(evaluation.results.filter((r) => r.companyId === "acme")).toEqual([]);
    const counts = await recordAccuracy(handle, evaluation, NOW);
    expect(counts).toMatchObject({ companies_checked: 2, flags_new: 11, flags_open: 11, flags_cleared: 0 });
    expect(await openAccuracyCount(handle)).toBe(11);
    // Review lists OpenAI with its own largest round and total, not the store's.
    const listed = await listAccuracy(handle, "open", NOW);
    expect(listed.companies.map((c) => [c.id, c.largest_usd_millions, c.total_usd_millions, c.flags.length])).toEqual([
      ["openai", 40000, 46600, 11],
    ]);
    expect(listed.companies[0].flags[0].severity).toBe("high");
  });

  test("a real duplicate pair the merge rule missed: one round under two labels a week apart", async () => {
    await cleanCompany("tekever", "580");
    await addRound("tekever", {
      stage: "growth",
      stageAsWritten: "funding round",
      announcedOn: "2025-06-08",
      amountUsdMillions: "560",
      amountAsWritten: "$560 million",
    });
    const { results } = await evaluateAccuracy(await db(), { now: NOW });
    expect(results.map((r) => [r.companyId, r.flag.rule, r.flag.subjects])).toEqual([
      ["tekever", "possible_duplicate", ["tekever:growth:2025-06-08", "tekever:series_c:2025-06-01"]],
    ]);
  });

  test("flags clear on their own once the condition no longer holds, and a recurrence is new", async () => {
    await openaiBefore();
    const handle = await db();
    await recordAccuracy(handle, await evaluateAccuracy(handle, { now: NOW }), NOW);
    // The repairs land: a verified homepage, a description and logo, the trend story rejected, growth stages, a checked dossier.
    await handle
      .update(companies)
      .set({ domain: "openai.com", description: "OpenAI builds AI models.", logoUrl: "https://openai.com/logo.svg" })
      .where(eq(companies.id, "openai"));
    await verifiedProfile("openai", "openai.com");
    await checkedDossier("openai", ["Sam Altman", "Greg Brockman"]);
    await handle.update(fundingRounds).set({ disposition: "rejected" }).where(eq(fundingRounds.id, "openai:series_a:2026-09-23"));
    await handle.update(fundingRounds).set({ stage: "growth" }).where(eq(fundingRounds.companyId, "openai"));
    const later = new Date(NOW.getTime() + 86_400_000);
    const counts = await recordAccuracy(handle, await evaluateAccuracy(handle, { now: later }), later);
    expect(counts.flags_cleared).toBe(8);
    const open = (await flagRows()).filter((f) => !f.clearedAt).map((f) => f.rule);
    // What is still true stays: Apollo's larger total, its $10B round not yet on the ledger, and no lead on the $6.6B round.
    expect(open.sort()).toEqual(["apollo_missing_round", "apollo_total_gap", "no_lead_large"]);
    const cleared = (await flagRows()).find((f) => f.rule === "no_domain");
    expect(cleared?.clearedAt?.toISOString()).toBe(later.toISOString());
    // The domain goes again: the flag is new, first seen now.
    await handle.update(companies).set({ domain: null }).where(eq(companies.id, "openai"));
    const again = new Date(later.getTime() + 86_400_000);
    const c2 = await recordAccuracy(handle, await evaluateAccuracy(handle, { now: again }), again);
    expect(c2.flags_new).toBe(1);
    const reopened = (await flagRows()).find((f) => f.rule === "no_domain");
    expect(reopened?.clearedAt).toBeNull();
    expect(reopened?.firstSeenAt.toISOString()).toBe(again.toISOString());
  });

  test("a dismissal keeps a flag quiet while it is about the same rounds; a new round reopens it", async () => {
    await cleanCompany("acme");
    await addRound(
      "acme",
      {
        stage: "series_d_plus",
        stageAsWritten: "Series D",
        announcedOn: "2026-01-10",
        amountUsdMillions: "300",
        amountAsWritten: "$300 million",
      },
      null,
    );
    const handle = await db();
    await recordAccuracy(handle, await evaluateAccuracy(handle, { now: NOW }), NOW);
    expect(await dismissAccuracyFlag(handle, "acme", "no_lead_large", "The release names no lead; checked.", NOW)).toBe(true);
    const c1 = await recordAccuracy(handle, await evaluateAccuracy(handle, { now: NOW }), NOW);
    expect(c1).toMatchObject({ flags_dismissed: 1, flags_open: 0, flags_new: 0 });
    const listed = await listAccuracy(handle, "dismissed", NOW);
    expect(listed.companies[0].flags[0]).toMatchObject({ rule: "no_lead_large", dismissed_note: "The release names no lead; checked." });
    expect(listed.counts).toEqual({ open: 0, dismissed: 1, cleared: 0 });
    // A second leadless round: the dismissal did not cover it.
    await addRound(
      "acme",
      { stage: "growth", stageAsWritten: "Series E", announcedOn: "2026-08-01", amountUsdMillions: "700", amountAsWritten: "$700 million" },
      null,
    );
    const c2 = await recordAccuracy(handle, await evaluateAccuracy(handle, { now: NOW }), NOW);
    expect(c2).toMatchObject({ flags_reopened: 1, flags_open: 1 });
    const [row] = await handle
      .select()
      .from(accuracyFlags)
      .where(and(eq(accuracyFlags.companyId, "acme"), eq(accuracyFlags.rule, "no_lead_large")));
    expect(row.dismissedAt).toBeNull();
    // Reopen by hand undoes a dismissal too.
    await dismissAccuracyFlag(handle, "acme", "no_lead_large", "Both checked.", NOW);
    expect(await reopenAccuracyFlag(handle, "acme", "no_lead_large")).toBe(true);
    expect(await reopenAccuracyFlag(handle, "acme", "no_lead_large")).toBe(false);
  });

  test("a new dossier that drops a founder is flagged against the one before it", async () => {
    await cleanCompany("acme");
    await checkedDossier("acme", ["Ada Lovelace", "Charles Babbage"], "2026-09-01T00:00:00.000Z");
    const handle = await db();
    await recordAccuracy(handle, await evaluateAccuracy(handle, { now: NOW }), NOW);
    await checkedDossier("acme", ["Ada Lovelace"], "2026-09-23T00:00:00.000Z");
    const { results } = await evaluateAccuracy(handle, { now: NOW });
    expect(results.map((r) => [r.flag.rule, r.flag.subjects])).toEqual([["founders_dropped", ["charles babbage"]]]);
  });
});

describe("remedies", () => {
  async function flaggedCompanies(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const id = `co${i}`;
      await addCompany(id, { description: "Builds things.", logoUrl: "https://example.com/logo.png" });
      await addRound(id, {
        stage: "series_c",
        stageAsWritten: "Series C",
        announcedOn: "2025-06-01",
        amountUsdMillions: String(500 - i * 10),
      });
    }
  }

  test("capped per kind, biggest companies first; a remedied flag rests a week", async () => {
    await flaggedCompanies(4);
    const handle = await db();
    const evaluation = await evaluateAccuracy(handle, { now: NOW });
    await recordAccuracy(handle, evaluation, NOW);
    const order = evaluation.checked.map((l) => l.company.id);
    const caps = { profile: 2, dossier: 1, history: 0 };
    const plan = await planRemedies(handle, { caps }, { now: NOW, order });
    expect(plan.targets).toEqual([
      { companyId: "co0", rule: "no_domain", remedy: "profile" },
      { companyId: "co0", rule: "dossier_missing", remedy: "dossier", action: "dive" },
      { companyId: "co1", rule: "no_domain", remedy: "profile" },
    ]);
    expect(plan.skipped).toBe(5);
    // A company dived in the last two weeks, or resting after a failed dive, waits; so does every dive without a model to check it.
    await recordRun(handle, {
      id: `deepdive:co0:${NOW.getTime() - 3 * 86_400_000}`,
      presetSlug: "deep-dive",
      lane: "agent",
      startedAt: new Date(NOW.getTime() - 3 * 86_400_000),
    });
    const rested = await planRemedies(handle, { caps }, { now: NOW, order, resting: new Set(["co1"]) });
    expect(rested.targets.filter((t) => t.remedy === "dossier")).toEqual([
      { companyId: "co2", rule: "dossier_missing", remedy: "dossier", action: "dive" },
    ]);
    const noModel = await planRemedies(handle, { caps }, { now: NOW, order, dossierCheck: false });
    expect(noModel.targets.filter((t) => t.remedy === "dossier")).toEqual([]);
  });

  test("a remedy is tried a few times at most: a checked dossier with no founders is dived again once, then left to a person", async () => {
    await cleanCompany("dayone", "1200");
    await checkedDossier("dayone", []);
    const handle = await db();
    await recordAccuracy(handle, await evaluateAccuracy(handle, { now: NOW }), NOW);
    const caps = { profile: 5, dossier: 5, history: 5 };
    expect((await planRemedies(handle, { caps }, { now: NOW })).targets).toEqual([
      { companyId: "dayone", rule: "dossier_no_founders", remedy: "dossier", action: "dive" },
    ]);
    await markRemedied(handle, { companyId: "dayone", rule: "dossier_no_founders" }, "deep dive: started", NOW);
    // A month on, past every rest: still no founders, and the one re-dive has been spent.
    const later = new Date(NOW.getTime() + 30 * 86_400_000);
    await recordAccuracy(handle, await evaluateAccuracy(handle, { now: later }), later);
    const plan = await planRemedies(handle, { caps }, { now: later });
    expect(plan.targets).toEqual([]);
    expect(plan.skipped).toBe(1);
    const [row] = (await listAccuracy(handle, "open", later)).companies[0].flags;
    expect(row).toMatchObject({ rule: "dossier_no_founders", remedy_attempts: 1, remedy_exhausted: true });
  });

  test("the daily workflow: records flags, starts the capped remedies, and writes its row on Runs", async () => {
    await flaggedCompanies(3);
    await openaiBefore();
    const params = { topN: 100, remedies: true, caps: { profile: 2, dossier: 1, history: 1 } };
    const summary = await accuracyWorkflow(params, "accuracy:run-1");
    expect(summary).toMatchObject({
      companies_checked: 4,
      remedies_profile: 2,
      profiles_verified: 2,
      remedies_dossier: 1,
      remedies_history: 1,
      history_leads: 1,
    });
    // OpenAI is the biggest name: its homepage is read first, its dive starts, its Apollo round goes on the ledger.
    expect(enriched.ids).toEqual(["openai", "co0"]);
    expect(started.map((s) => s.fn)).toEqual([accuracyDossierWorkflow, companyHistoryWorkflow]);
    expect(started[0].args).toEqual([{ companyId: "openai", action: "dive" }]);
    const handle = await db();
    const leads = await handle.select().from(historyPromotions).where(eq(historyPromotions.companyId, "openai"));
    expect(leads.map((l) => [l.origin, l.status, l.prior.amount_as_written])).toEqual([["apollo", "pending", "$10B"]]);
    const [run] = await handle.select().from(runs).where(eq(runs.id, "accuracy:run-1"));
    expect(run).toMatchObject({ lane: "accuracy", presetSlug: "accuracy", creditsEstimated: 12 });
    expect(run.counts).toMatchObject({ companies_checked: 4, remedies_profile: 2, remedies_dossier: 1, remedies_history: 1 });
    const [flag] = await handle
      .select()
      .from(accuracyFlags)
      .where(and(eq(accuracyFlags.companyId, "openai"), eq(accuracyFlags.rule, "no_domain")));
    expect(flag.remedyNote).toBe("profile refresh: verified https://openai.com");
    // The next day: OpenAI's profile flag cleared, the remedied flags rest, and the next companies in line get theirs.
    enriched.ids = [];
    started.length = 0;
    const next = await accuracyWorkflow(params, "accuracy:run-2");
    expect(next.flags_cleared).toBeGreaterThanOrEqual(1);
    expect(enriched.ids).toEqual(["co1", "co2"]);
    expect(started.map((s) => s.args[0])).toEqual([{ companyId: "co0", action: "dive" }, "openai"]);
  });

  test("remedies off, or no Firecrawl key: flags only, nothing spent", async () => {
    await flaggedCompanies(2);
    const off = await accuracyWorkflow({ topN: 100, remedies: false, caps: { profile: 5, dossier: 5, history: 5 } }, "accuracy:off");
    expect(off.remedies_profile + off.remedies_dossier + off.remedies_history).toBe(0);
    delete process.env.FIRECRAWL_API_KEY;
    const keyless = await accuracyWorkflow({ topN: 100, remedies: true, caps: { profile: 5, dossier: 5, history: 5 } }, "accuracy:keyless");
    expect(keyless.remedies_profile + keyless.remedies_dossier).toBe(0);
    expect(enriched.ids).toEqual([]);
    expect(started).toEqual([]);
  });
});

describe("the route", () => {
  test("refuses without the cron bearer; with it, starts the workflow with the parsed params", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await accuracyGet(new Request("http://app.test/api/cron/accuracy"))).status).toBe(401);
    process.env.CRON_SECRET = "s3cret-s3cret-s3cret";
    expect(
      (await accuracyGet(new Request("http://app.test/api/cron/accuracy", { headers: { authorization: "Bearer wrong" } }))).status,
    ).toBe(401);
    const res = await accuracyGet(
      new Request("http://app.test/api/cron/accuracy", { headers: { authorization: "Bearer s3cret-s3cret-s3cret" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lanes: Array<{ lane: string; runId: string }>; params: unknown };
    expect(body.lanes[0].lane).toBe("accuracy");
    expect(started).toHaveLength(1);
    expect(started[0].fn).toBe(accuracyWorkflow);
    expect(started[0].args).toEqual([{ topN: 100, remedies: true, caps: { profile: 5, dossier: 2, history: 3 } }, body.lanes[0].runId]);
    const bad = await accuracyPost(
      new Request("http://app.test/api/cron/accuracy?dossier=99", {
        method: "POST",
        headers: { authorization: "Bearer s3cret-s3cret-s3cret" },
      }),
    );
    expect(bad.status).toBe(400);
  });

  test("a dry run answers with the flags and writes nothing", async () => {
    await openaiBefore();
    const res = await accuracyGet(new Request("http://app.test/api/cron/accuracy?dry=1"));
    const body = (await res.json()) as { dry: boolean; companies: number; byRule: Record<string, number> };
    expect(body).toMatchObject({ dry: true, companies: 1 });
    expect(body.byRule.no_domain).toBe(1);
    expect(await flagRows()).toEqual([]);
    expect(started).toEqual([]);
  });

  test("params parse with their bounds", () => {
    expect(parseAccuracyParams({ remedies: "0", profile: "10" })).toEqual({
      topN: 100,
      remedies: false,
      caps: { profile: 10, dossier: 2, history: 3 },
    });
    expect(parseAccuracyParams({ topN: "0" })).toEqual({ error: "topN must be a whole number from 1 to 1000" });
  });
});

describe("admin only", () => {
  test("a demo visitor never reaches the Accuracy view: /review answers 404 with no password, a challenge with one", () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    expect(gate(new NextRequest("http://app.test/review?kind=accuracy")).status).toBe(404);
    expect(gate(new NextRequest("http://app.test/review?kind=accuracy&view=dismissed")).status).toBe(404);
    process.env.DASHBOARD_PASSWORD = "pw";
    expect(gate(new NextRequest("http://app.test/review?kind=accuracy")).status).toBe(401);
  });

  test("the accuracy run's row is left off Runs and /api/v1/runs for a demo visitor, and kept for an admin", async () => {
    const handle = await db();
    await recordRun(handle, {
      id: "accuracy:x",
      presetSlug: "accuracy",
      lane: "accuracy",
      startedAt: NOW,
      finishedAt: NOW,
      counts: { flags_new: 3 },
    });
    await recordRun(handle, { id: "sweep:x", presetSlug: "seed", lane: "sweep", startedAt: NOW, finishedAt: NOW });
    expect((await listRuns(handle, 10, { adminLanes: false })).map((r) => r.lane)).toEqual(["sweep"]);
    expect((await listRuns(handle, 10)).map((r) => r.lane).sort()).toEqual(["accuracy", "sweep"]);
    vi.stubEnv("PUBLIC_DEMO", "1");
    const visitor = (await (await runsGet(new Request("http://app.test/api/v1/runs"))).json()) as { data: Array<{ lane: string }> };
    expect(visitor.data.map((r) => r.lane)).toEqual(["sweep"]);
    process.env.DASHBOARD_PASSWORD = "pw";
    const admin = (await (
      await runsGet(
        new Request("http://app.test/api/v1/runs", { headers: { authorization: `Basic ${Buffer.from("u:pw").toString("base64")}` } }),
      )
    ).json()) as { data: Array<{ lane: string }> };
    expect(admin.data.map((r) => r.lane).sort()).toEqual(["accuracy", "sweep"]);
  });
});
