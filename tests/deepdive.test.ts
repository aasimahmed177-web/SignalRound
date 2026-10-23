import type { CompanyDossier, DossierRecheck, DossierVerdict } from "@fireround/core";
import { DossierVerdict as DossierVerdictSchema } from "@fireround/core";
import { schema } from "@fireround/core/db";
import type { NativeWebClient as Firecrawl } from "@fireround/core/web";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getCompany } from "../lib/company.ts";
import { corroborateRecord } from "../lib/corroborate.ts";
import { getDossier, reverifyDossier, runDeepDive, saveDossier } from "../lib/deepdive.ts";
import type { CheckDeps } from "../lib/dossier-check.ts";
import { DossierCheckUnavailable } from "../lib/dossier-check.ts";
import { backfillTargets, deepDiveTargets, divesResting, dossierBacklog, dossierCoverage, parseBackfillParams } from "../lib/intel.ts";
import { persistRecords, recordRun } from "../lib/persist.ts";
import { record, testDb } from "./helpers.ts";

const dossier: CompanyDossier = {
  one_liner: "Acme builds widgets for fintech teams.",
  founded_year: 2021,
  founders: [
    { name: "Ada Example", role: "CEO", background: "Previously led payments at Big Bank." },
    { name: "Ben Example", role: "CTO", background: null },
  ],
  headcount_estimate: "51 to 200",
  total_raised_as_written: "$28 million",
  prior_rounds: [
    { stage_as_written: "Seed", amount_as_written: "$8 million", announced_date: "2024-05-01", lead_investors: ["Seed Fund"] },
  ],
  customers: ["Globex", "Initech"],
  investors_and_backers: [],
  competitors: ["Widgetly"],
  business_model: "Usage-based subscription.",
  why_it_matters: "Widgets are a growing category. Acme is the first to sell them to fintechs.",
  sources: ["https://acme.com/about", "https://techcrunch.com/2026/09/02/acme-series-a/"],
};

async function checkFreshness(handle: import("@fireround/core/db").Db, ids: string[]) {
  const client = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
  for (const id of ids) await corroborateRecord(handle, client, id, { broad: true, maxPages: 0 });
}

const ABOUT = [
  "Acme builds widgets for fintech teams.",
  "Founded in 2021.",
  "Ada Example is co-founder and CEO. Previously led payments at Big Bank.",
  "Ben Example is co-founder and CTO.",
  "Team size: 51 to 200.",
  "Acme has raised $28 million in total.",
  "Acme raised an $8 million seed round led by Seed Fund in May 2024.",
  "Customers include Globex and Initech.",
  "Acme competes with Widgetly.",
  "Acme charges a usage-based subscription.",
  "Widgets are a growing category. Acme is the first to sell them to fintechs.",
].join("\n");

const ok = (quote: string) => ({ verdict: "supported" as const, source: "S1", quote, confidence: "high" as const, reason: "stated" });

function verdict(identity: "yes" | "no" | "unclear" = "yes"): DossierVerdict {
  return {
    identity: { same_company: identity, reason: identity === "yes" ? "the widget company in our record" : "a namesake" },
    one_liner: ok("Acme builds widgets for fintech teams"),
    founded_year: ok("Founded in 2021"),
    headcount_estimate: ok("Team size: 51 to 200"),
    total_raised: { ...ok("Acme has raised $28 million in total"), includes_our_latest_round: "yes" },
    business_model: ok("Acme charges a usage-based subscription"),
    why_it_matters: ok("Widgets are a growing category"),
    founders: [
      { index: 0, ...ok("Ada Example is co-founder and CEO"), is_founder: true, role_supported: true, background_supported: true },
      { index: 1, ...ok("Ben Example is co-founder and CTO"), is_founder: true, role_supported: true, background_supported: false },
    ],
    prior_rounds: [
      {
        index: 0,
        ...ok("an $8 million seed round led by Seed Fund"),
        is_equity_round: true,
        same_as_our_round: false,
        amount_supported: true,
        date_supported: true,
        leads_supported: ["Seed Fund"],
      },
    ],
    customers: [
      { index: 0, ...ok("Customers include Globex and Initech"), kind: "customer" },
      { index: 1, ...ok("Customers include Globex and Initech"), kind: "customer" },
    ],
    investors_and_backers: [],
    competitors: [{ index: 0, ...ok("Acme competes with Widgetly") }],
  };
}

/** The check's reads and model, faked: the about page is readable, the model answers `first`. */
function checkDeps(first: DossierVerdict | Error = verdict()): CheckDeps & { calls: number } {
  const deps = {
    calls: 0,
    model: null,
    read: async (urls: string[]) => urls.filter((u) => u === "https://acme.com/about").map((url) => ({ url, markdown: ABOUT })),
    search: async () => [],
    generate: async <T>(_prompt: string, schema: unknown): Promise<T> => {
      deps.calls++;
      if (first instanceof Error) throw first;
      if (schema === DossierVerdictSchema) return first as T;
      return { claims: [] } satisfies DossierRecheck as T;
    },
  };
  return deps;
}

async function seedAcme() {
  const handle = await testDb();
  const saved = await persistRecords(
    handle,
    [record({ company_name: "Acme", company_domain: "acme.com", company_website: "https://acme.com" })],
    "series-a-b",
    "run-1",
  );
  await checkFreshness(handle, saved.insertedIds);
  return handle;
}

/** A client whose agent returns a fixed status; the prompt and schema it was handed are kept for assertions. */
function fakeAgent(result: { status: "completed" | "failed"; data?: unknown; creditsUsed?: number }) {
  const calls: unknown[] = [];
  const client = {
    async agent(options: unknown) {
      calls.push(options);
      return { success: result.status === "completed", status: result.status, data: result.data, creditsUsed: result.creditsUsed };
    },
  };
  return { client: client as unknown as Firecrawl, calls };
}

const runRow = async (handle: Awaited<ReturnType<typeof testDb>>, id: string) =>
  (await handle.select().from(schema.runs).where(eq(schema.runs.id, id)))[0];

describe("saveDossier and getDossier", () => {
  it("round-trips and upserts; a row with no check's record reads as unchecked", async () => {
    const handle = await seedAcme();
    expect(await getDossier(handle, "acme.com")).toBeNull();

    const first = new Date("2026-09-03T10:00:00Z");
    await saveDossier(handle, "acme.com", dossier, "https://acme.com/about", first);
    const stored = await getDossier(handle, "acme.com");
    expect(stored?.data).toEqual(dossier);
    expect(stored?.verification).toBeNull();
    expect(stored?.source_url).toBe("https://acme.com/about");
    expect(stored?.fetched_at).toBe(first.toISOString());

    const later = new Date("2026-09-04T10:00:00Z");
    const verification = {
      version: 1 as const,
      checked_at: later.toISOString(),
      model: "test",
      sources_checked: ["https://acme.com/about"],
      searched: false,
      kept: 10,
      dropped: [],
      citations: {},
      rechecked: 0,
      credits: 1,
    };
    await saveDossier(handle, "acme.com", { ...dossier, headcount_estimate: "about 60" }, null, later, verification);
    const again = await getDossier(handle, "acme.com");
    expect(again?.data.headcount_estimate).toBe("about 60");
    expect(again?.verification).toEqual(verification);
    const rows = await handle.select().from(schema.enrichments).where(eq(schema.enrichments.companyId, "acme.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "deep_dive", schemaVersion: 2 });
  });

  it("a row stored before customers and backers were split still reads", async () => {
    const handle = await seedAcme();
    const { customers, investors_and_backers: _, ...rest } = dossier;
    await handle
      .insert(schema.enrichments)
      .values({ companyId: "acme.com", kind: "deep_dive", data: { ...rest, customers_or_logos: customers } });
    expect((await getDossier(handle, "acme.com"))?.data.customers).toEqual(customers);
  });
});

describe("runDeepDive", () => {
  it("checks the dossier, saves what the check keeps with its record, and records the run", async () => {
    const handle = await seedAcme();
    const { client, calls } = fakeAgent({ status: "completed", data: dossier, creditsUsed: 212 });
    const now = new Date("2026-09-04T12:00:00Z");

    const outcome = await runDeepDive(handle, client, "acme.com", { ...checkDeps(), now });
    expect(outcome.status).toBe("verified");
    expect(outcome.creditsUsed).toBe(212);
    expect(calls[0]).toMatchObject({ maxCredits: 2500, effort: "high" });
    expect((calls[0] as { prompt: string }).prompt).toContain("Acme");

    const stored = await getDossier(handle, "acme.com");
    // The background no page states is cleared; everything else was quoted from the about page.
    expect(stored?.data.founders[1]).toEqual({ name: "Ben Example", role: "CTO", background: null });
    expect(stored?.data.customers).toEqual(["Globex", "Initech"]);
    expect(stored?.data.sources).toEqual(["https://acme.com/about"]);
    expect(stored?.verification).toMatchObject({ sources_checked: ["https://acme.com/about"], searched: true });
    expect(stored?.source_url).toBe("https://acme.com/about");

    const run = await runRow(handle, `deepdive:acme.com:${now.getTime()}`);
    expect(run).toMatchObject({ presetSlug: "deep-dive", lane: "agent", creditsEstimated: 300, error: null });
    expect(run?.counts).toMatchObject({ companies: 1, agent_credits: 212, sources_checked: 1 });
    // The check's reads (the pages and a search) are added to what the agent reported.
    expect(run?.creditsMeasured).toBe(212 + (run?.counts?.check_credits ?? 0));

    // A visitor's company page carries it.
    const page = await getCompany(handle, "acme.com");
    expect(page?.dossier?.data.one_liner).toBe(dossier.one_liner);
  });

  it("a dossier about another company is not saved, the earlier one stays, and the run says why", async () => {
    const handle = await seedAcme();
    await saveDossier(handle, "acme.com", dossier, null, new Date("2026-09-01T00:00:00Z"));
    const { client } = fakeAgent({
      status: "completed",
      data: { ...dossier, one_liner: "Acme Robotics builds welding arms." },
      creditsUsed: 90,
    });
    const now = new Date("2026-09-04T12:00:00Z");
    const outcome = await runDeepDive(handle, client, "acme.com", { ...checkDeps(verdict("no")), now });
    expect(outcome).toMatchObject({ status: "rejected", reason: "different company" });
    expect((await getDossier(handle, "acme.com"))?.data.one_liner).toBe(dossier.one_liner);
    expect(await runRow(handle, `deepdive:acme.com:${now.getTime()}`)).toMatchObject({
      error: "dossier rejected: different company",
      creditsMeasured: expect.any(Number),
    });
  });

  it("a check that cannot run saves nothing and records the failure", async () => {
    const handle = await seedAcme();
    const { client } = fakeAgent({ status: "completed", data: dossier, creditsUsed: 90 });
    const now = new Date("2026-09-04T12:00:00Z");
    const outcome = await runDeepDive(handle, client, "acme.com", { ...checkDeps(new Error("gateway 503")), now });
    expect(outcome.status).toBe("failed");
    expect(await getDossier(handle, "acme.com")).toBeNull();
    expect((await runRow(handle, `deepdive:acme.com:${now.getTime()}`))?.error).toBe("dossier check failed: gateway 503");
  });

  it("with no model to check with, refuses before the agent is paid", async () => {
    const handle = await seedAcme();
    const { client, calls } = fakeAgent({ status: "completed", data: dossier });
    await expect(runDeepDive(handle, client, "acme.com", { model: null })).rejects.toBeInstanceOf(DossierCheckUnavailable);
    expect(calls).toHaveLength(0);
  });

  it("records the failed agent run with an error and saves no dossier", async () => {
    const handle = await seedAcme();
    const { client } = fakeAgent({ status: "failed", creditsUsed: 120 });
    const now = new Date("2026-09-04T12:00:00Z");
    const deps = checkDeps();
    const outcome = await runDeepDive(handle, client, "acme.com", { ...deps, now });
    expect(outcome).toMatchObject({ status: "failed", dossier: null, creditsUsed: 120 });
    expect(deps.calls).toBe(0);
    expect(await getDossier(handle, "acme.com")).toBeNull();
    expect(await runRow(handle, `deepdive:acme.com:${now.getTime()}`)).toMatchObject({
      lane: "agent",
      presetSlug: "deep-dive",
      creditsMeasured: 120,
      error: "agent failed",
    });
  });

  it("throws for a company the store does not hold", async () => {
    const handle = await seedAcme();
    const { client } = fakeAgent({ status: "completed", data: dossier });
    await expect(runDeepDive(handle, client, "nobody.example", checkDeps())).rejects.toThrow("Company not found.");
  });
});

describe("reverifyDossier", () => {
  it("rewrites an unchecked dossier as checked, keeping the dive's date", async () => {
    const handle = await seedAcme();
    const dived = new Date("2026-09-01T00:00:00Z");
    await saveDossier(handle, "acme.com", dossier, null, dived);
    const now = new Date("2026-09-10T00:00:00Z");
    const r = await reverifyDossier(handle, {} as Firecrawl, "acme.com", { ...checkDeps(), now });
    expect(r).toMatchObject({ status: "verified", dropped: expect.any(Number) });
    const stored = await getDossier(handle, "acme.com");
    expect(stored?.verification?.checked_at).toBe(now.toISOString());
    expect(stored?.fetched_at).toBe(dived.toISOString());
    expect(await runRow(handle, `dossiercheck:acme.com:${now.getTime()}`)).toMatchObject({ presetSlug: "dossier-check", error: null });
  });

  it("deletes a dossier that turns out to be about another company", async () => {
    const handle = await seedAcme();
    await saveDossier(handle, "acme.com", dossier, null);
    const now = new Date("2026-09-10T00:00:00Z");
    const r = await reverifyDossier(handle, {} as Firecrawl, "acme.com", { ...checkDeps(verdict("no")), now });
    expect(r).toMatchObject({ status: "removed", reason: "different company" });
    expect(await getDossier(handle, "acme.com")).toBeNull();
    expect((await runRow(handle, `dossiercheck:acme.com:${now.getTime()}`))?.error).toBe("dossier rejected: different company; removed");
  });

  it("changes nothing when the check cannot run", async () => {
    const handle = await seedAcme();
    await saveDossier(handle, "acme.com", dossier, null);
    await expect(reverifyDossier(handle, {} as Firecrawl, "acme.com", checkDeps(new Error("gateway 503")))).rejects.toThrow("gateway 503");
    expect((await getDossier(handle, "acme.com"))?.verification).toBeNull();
  });
});

describe("who sees an unchecked dossier", () => {
  it("an admin does, marked unchecked; a visitor does not", async () => {
    const handle = await seedAcme();
    await saveDossier(handle, "acme.com", dossier, null);
    expect((await getCompany(handle, "acme.com"))?.dossier).toBeNull();
    const admin = await getCompany(handle, "acme.com", true);
    expect(admin?.dossier?.verification).toBeNull();
  });
});

describe("which companies the dossier lane works on", () => {
  const plan = (deepDive: "manual" | "threshold" | "all", min = 10) =>
    ({ agent: { gapFill: "manual", deepDive, deepDiveMinUsdMillions: min, discoverySweep: "off" } }) as Parameters<
      typeof deepDiveTargets
    >[1];
  const verification = {
    version: 1 as const,
    checked_at: "2026-09-04T00:00:00Z",
    model: "test",
    sources_checked: [],
    searched: false,
    kept: 1,
    dropped: [],
    citations: {},
    rechecked: 0,
    credits: 0,
  };

  async function seedMany() {
    const handle = await testDb();
    const amount = (usd: number) => ({
      value: usd,
      currency: "USD",
      as_written: `$${usd}M`,
      usd_millions: usd,
      fx_rate: 1,
      fx_date: "2026-09-02",
    });
    const { insertedIds } = await persistRecords(
      handle,
      [
        record({ company_name: "Acme", company_domain: "acme.com", announced_date: "2026-09-10" }),
        record({ company_name: "Tiny", amount: amount(2), announced_date: "2026-09-09" }),
        record({ company_name: "Done", company_domain: "done.example", announced_date: "2026-09-08" }),
        record({ company_name: "Legacy", company_domain: "legacy.example", announced_date: "2026-09-07" }),
        record({ company_name: "Resting", company_domain: "resting.example", announced_date: "2026-09-06" }),
        record({ company_name: "Hidden", company_domain: "hidden.example", confidence: 0.3, announced_date: "2026-09-11" }),
      ],
      "series-a-b",
      "run-1",
    );
    await checkFreshness(
      handle,
      insertedIds.filter((id) => !id.startsWith("hidden:")),
    );
    await saveDossier(handle, "done.example", dossier, null, new Date(), verification);
    await saveDossier(handle, "legacy.example", dossier, null);
    await recordRun(handle, {
      id: "deepdive:resting.example:1790000000000",
      presetSlug: "deep-dive",
      lane: "agent",
      startedAt: new Date("2026-09-20T00:00:00Z"),
      finishedAt: new Date("2026-09-20T00:05:00Z"),
      error: "dossier rejected: different company",
    });
    return { handle, insertedIds };
  }
  const now = new Date("2026-09-23T00:00:00Z");

  it("new records: gated by rung and threshold; a checked dossier is skipped, an unchecked one checked, a resting company left alone", async () => {
    const { handle, insertedIds } = await seedMany();
    expect(await deepDiveTargets(handle, plan("manual"), insertedIds, now)).toEqual([]);
    const threshold = await deepDiveTargets(handle, plan("threshold"), insertedIds, now);
    expect(threshold).toContainEqual({ companyId: "acme.com", action: "dive" });
    expect(threshold).not.toContainEqual({ companyId: "tiny", action: "dive" });
    const all = await deepDiveTargets(handle, plan("all"), insertedIds, now);
    expect(all).toContainEqual({ companyId: "tiny", action: "dive" });
    expect(all).toContainEqual({ companyId: "legacy.example", action: "reverify" });
    expect(all.map((t) => t.companyId)).not.toContain("done.example");
    expect(all.map((t) => t.companyId)).not.toContain("resting.example");
    // A rejected dive rests a month: still resting eleven days on, dived again after thirty.
    const soon = await deepDiveTargets(handle, plan("all"), insertedIds, new Date("2026-10-01T00:00:00Z"));
    expect(soon.map((t) => t.companyId)).not.toContain("resting.example");
    const later = await deepDiveTargets(handle, plan("all"), insertedIds, new Date("2026-10-21T00:00:00Z"));
    expect(later).toContainEqual({ companyId: "resting.example", action: "dive" });
  });

  it("who rests: a failed dive a week, a rejected one a month, a dive still running while its row is open", async () => {
    const handle = await testDb();
    const run = (company: string, startedAt: string, finishedAt: string | null, error: string | null = null) =>
      recordRun(handle, {
        id: `deepdive:${company}:${Date.parse(startedAt)}`,
        presetSlug: "deep-dive",
        lane: "agent",
        startedAt: new Date(startedAt),
        finishedAt: finishedAt ? new Date(finishedAt) : null,
        error,
      });
    await run("failed.example", "2026-09-20T00:00:00Z", "2026-09-20T00:10:00Z", "agent failed");
    await run("rejected.example", "2026-09-01T00:00:00Z", "2026-09-01T00:10:00Z", "dossier rejected: identity unclear");
    await run("running.example", "2026-09-22T23:40:00Z", null);
    await run("stale.example", "2026-09-22T20:00:00Z", null);
    await run("done.example", "2026-09-22T00:00:00Z", "2026-09-22T00:10:00Z");
    // A company id with a colon in it still reads back whole.
    await run("acme:eu", "2026-09-21T00:00:00Z", "2026-09-21T00:10:00Z", "agent failed");
    expect([...(await divesResting(handle, now))].sort()).toEqual(["acme:eu", "failed.example", "rejected.example", "running.example"]);
    // Past the week the failure is free again; the rejection waits out its month.
    expect([...(await divesResting(handle, new Date("2026-09-29T00:00:00Z")))].sort()).toEqual(["rejected.example"]);
  });

  it("the backfill: unchecked dossiers first, then dives, newest round first, visible companies only, limit per group", async () => {
    const { handle } = await seedMany();
    expect(await backfillTargets(handle, { now })).toEqual([
      { companyId: "legacy.example", action: "reverify" },
      { companyId: "acme.com", action: "dive" },
      { companyId: "tiny", action: "dive" },
    ]);
    expect(await backfillTargets(handle, { now, limit: 1 })).toEqual([
      { companyId: "legacy.example", action: "reverify" },
      { companyId: "acme.com", action: "dive" },
    ]);
    expect(await backfillTargets(handle, { now, reverifyOnly: true })).toEqual([{ companyId: "legacy.example", action: "reverify" }]);
  });

  it("the Max rung's backlog: oldest first, skipping what the sweep already works on", async () => {
    const { handle } = await seedMany();
    for (const [id, at] of [
      ["tiny", "2026-09-01"],
      ["legacy.example", "2026-09-02"],
      ["acme.com", "2026-09-03"],
    ] as const) {
      await handle
        .update(schema.companies)
        .set({ firstSeenAt: new Date(at) })
        .where(eq(schema.companies.id, id));
    }
    expect(await dossierBacklog(handle, 2, [], now)).toEqual([
      { companyId: "tiny", action: "dive" },
      { companyId: "legacy.example", action: "reverify" },
    ]);
    expect(await dossierBacklog(handle, 2, ["tiny"], now)).toEqual([
      { companyId: "legacy.example", action: "reverify" },
      { companyId: "acme.com", action: "dive" },
    ]);
  });

  it("coverage counts what a visitor can reach", async () => {
    const { handle } = await seedMany();
    expect(await dossierCoverage(handle, now)).toEqual({ visible: 5, verified: 1, stale: 0, unchecked: 1, missing: 3, resting: 1 });
    const hidden = await handle
      .select()
      .from(schema.fundingRounds)
      .where(and(eq(schema.fundingRounds.companyId, "hidden.example"), eq(schema.fundingRounds.disposition, "review")));
    expect(hidden).toHaveLength(1);
  });
});

describe("a checked dossier a newer round outdates", () => {
  const verification = {
    version: 1 as const,
    checked_at: "2026-09-04T00:00:00Z",
    model: "test",
    sources_checked: [],
    searched: false,
    kept: 1,
    dropped: [],
    citations: {},
    rechecked: 0,
    credits: 0,
  };
  const plan = { agent: { gapFill: "manual", deepDive: "all", deepDiveMinUsdMillions: 10, discoverySweep: "off" } } as Parameters<
    typeof deepDiveTargets
  >[1];
  const now = new Date("2026-09-23T00:00:00Z");

  it("is dived again by the ingest, the backfill and the backlog; a current one, or a history round, is left alone", async () => {
    const handle = await testDb();
    // The Series A lands first and the dossier is written after it: current.
    const initial = await persistRecords(
      handle,
      [record({ company_name: "Acme", company_domain: "acme.com", announced_date: "2026-09-02" })],
      "series-a-b",
      "run-1",
    );
    await checkFreshness(handle, initial.insertedIds);
    await saveDossier(handle, "acme.com", dossier, null, new Date(Date.now() + 1_000), verification);
    expect(await dossierCoverage(handle, now)).toMatchObject({ verified: 1, stale: 0 });

    // A history round promoted out of the dossier is recorded later, and does not outdate it.
    const history = await persistRecords(
      handle,
      [
        record({
          company_name: "Acme",
          company_domain: "acme.com",
          stage: "seed",
          stage_as_written: "Seed",
          announced_date: "2024-05-01",
          amount: { value: 8, currency: "USD", as_written: "$8M", usd_millions: 8, fx_rate: 1, fx_date: "2024-05-01" },
          sources: [{ url: "https://news.example/acme-seed", host: "news.example", title: "Acme raises $8M seed" }],
        }),
      ],
      "series-a-b",
      "run-2",
    );
    await handle
      .update(schema.fundingRounds)
      .set({ history: true, firstSeenAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.fundingRounds.id, history.insertedIds[0]));
    expect(await dossierCoverage(handle, now)).toMatchObject({ verified: 1, stale: 0 });

    // Then the Series B lands, recorded after the dossier: the dossier is outdated and dived again.
    const b = await persistRecords(
      handle,
      [
        record({
          company_name: "Acme",
          company_domain: "acme.com",
          stage: "series_b",
          stage_as_written: "Series B",
          announced_date: "2026-09-22",
          amount: { value: 75, currency: "USD", as_written: "$75M", usd_millions: 75, fx_rate: 1, fx_date: "2026-09-22" },
          sources: [{ url: "https://techcrunch.com/acme-b", host: "techcrunch.com", title: "Acme raises $75M Series B" }],
        }),
      ],
      "series-a-b",
      "run-3",
    );
    await checkFreshness(handle, b.insertedIds);
    await handle
      .update(schema.fundingRounds)
      .set({ firstSeenAt: new Date(Date.now() + 120_000) })
      .where(eq(schema.fundingRounds.id, b.insertedIds[0]));
    expect(await dossierCoverage(handle, now)).toMatchObject({ verified: 0, stale: 1 });
    expect(await deepDiveTargets(handle, plan, b.insertedIds, now)).toEqual([{ companyId: "acme.com", action: "dive" }]);
    expect(await backfillTargets(handle, { now })).toEqual([{ companyId: "acme.com", action: "dive" }]);
    expect(await dossierBacklog(handle, 5, [], now)).toEqual([{ companyId: "acme.com", action: "dive" }]);

    // The fresh dossier, written after the Series B, is current again.
    await saveDossier(handle, "acme.com", dossier, null, new Date(Date.now() + 180_000), verification);
    expect(await dossierCoverage(handle, now)).toMatchObject({ verified: 1, stale: 0 });
    expect(await deepDiveTargets(handle, plan, b.insertedIds, now)).toEqual([]);
  });
});

describe("parseBackfillParams", () => {
  it("defaults, limits, and the reverify switch", () => {
    expect(parseBackfillParams({})).toEqual({ limit: null, concurrency: 20, maxTotalCredits: 250_000, reverifyOnly: false });
    expect(parseBackfillParams({ limit: "5", concurrency: "2", reverifyOnly: "1" })).toEqual({
      limit: 5,
      concurrency: 2,
      maxTotalCredits: 250_000,
      reverifyOnly: true,
    });
    expect(parseBackfillParams({ concurrency: 500 })).toEqual({ error: "concurrency must be a whole number from 1 to 100" });
    expect(parseBackfillParams({ limit: "x" })).toEqual({ error: "limit must be a whole number from 1 to 10000" });
  });
});
