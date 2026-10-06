// The request workflow end to end with Firecrawl, the Deep dive, and each round's verification
// scripted: the branding read lands before the identity check answers, the Deep dive and the funding
// search run side by side, what both find is one round, and rounds are verified several at once.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { schema } from "@fireround/core/db";
import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, test, vi } from "vitest";

const timing = vi.hoisted(() => ({ dive: 300, verify: 100 }));
const scenario = vi.hoisted(() => ({
  search: "results" as "results" | "empty",
  dive: "verified" as "verified" | "failed",
  atDiveEnd: null as unknown,
}));
const log = vi.hoisted(() => ({
  events: [] as string[],
  brandBeforeIdentity: null as boolean | null,
  active: 0,
  peak: 0,
  keys: [] as string[],
}));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

vi.mock("workflow/api", () => ({ start: vi.fn(async () => undefined) }));
vi.mock("@/lib/firecrawl", () => ({
  getFirecrawl: () => ({
    async scrape(_url: string, opts: { formats: unknown[] }) {
      // The branding read asks for the brand and the homepage's links; the identity check asks for its JSON.
      if (opts.formats[0] === "branding") {
        log.events.push("brand");
        return { branding: { brandName: "Acme", logo: "https://acme.com/logo.svg", colors: { primary: "#123456" } }, metadata: {} };
      }
      const { db } = await import("../lib/db");
      const [row] = await (await db()).select({ brand: schema.companyRequests.brand }).from(schema.companyRequests);
      log.brandBeforeIdentity = row?.brand?.name === "Acme";
      log.events.push("identity");
      return {
        json: {
          what_they_sell: "Payments for robots.",
          customer_type: "B2B software",
          sells_software_subscription: true,
          identity_reason: "Acme's own site.",
          different_business: null,
          same_company: true,
        },
        branding: { brandName: "Acme" },
        markdown: HOME_TEXT,
        links: [],
        metadata: {},
      };
    },
    async search(query: string) {
      log.events.push(`search:${query}`);
      if (scenario.search === "empty") return { news: [] };
      return {
        news: [
          {
            url: "https://techcrunch.com/2024/05/10/acme-raises-20m-series-a/",
            title: "Acme raises $20M Series A led by Big Fund",
            date: "2024-05-10",
          },
        ],
      };
    },
    async map() {
      return { links: [] };
    },
  }),
}));
vi.mock("@/workflows/dossiers", () => ({
  startDiveStep: async () => ({ jobId: "job", startedAt: new Date().toISOString() }),
  awaitDiveStep: async () => {
    log.events.push("dive:start");
    await wait(timing.dive);
    log.events.push("dive:end");
    return { status: "completed" };
  },
  finishDiveStep: async (companyId: string) => {
    const { db } = await import("../lib/db");
    const [request] = await (await db()).select().from(schema.companyRequests);
    scenario.atDiveEnd = { status: request.status, tally: request.tally, dossierStatus: request.dossierStatus };
    if (scenario.dive === "failed") return { companyId, action: "dive", status: "failed", agentCredits: 0, checkCredits: 0 };
    const { saveDossier } = await import("../lib/deepdive");
    const { dossier } = await import("./history-fixtures");
    const at = new Date();
    await saveDossier(
      await db(),
      companyId,
      dossier([
        { stage_as_written: "Seed", amount_as_written: "$4 million", announced_date: "2022-02-01", lead_investors: [] },
        { stage_as_written: "Series A", amount_as_written: "$20 million", announced_date: "2024-05-10", lead_investors: ["Big Fund"] },
        { stage_as_written: "Series B", amount_as_written: "$60 million", announced_date: "2025-06-01", lead_investors: [] },
        { stage_as_written: "Series C", amount_as_written: "$120 million", announced_date: "2026-03-01", lead_investors: [] },
      ]),
      null,
      at,
      {
        version: 1,
        checked_at: at.toISOString(),
        model: "test",
        sources_checked: [],
        searched: false,
        kept: 4,
        dropped: [],
        citations: {},
        rechecked: 0,
        credits: 1,
      },
    );
    return { companyId, action: "dive", status: "verified", agentCredits: 0, checkCredits: 0 };
  },
}));
vi.mock("@/workflows/history", async (original) => {
  const real = await original<typeof import("../workflows/history")>();
  return {
    ...real,
    recordCompanyStep: async () => undefined,
    scheduleHistoryRetryStep: async () => false,
    // Each round's three steps, as one timed call that claims the round like the real plan step.
    processPrior: async (companyId: string, key: string, claimer: string) => {
      const { db } = await import("../lib/db");
      const { claimPrior, skippedOutcome } = await import("../lib/history");
      const handle = await db();
      if (!(await claimPrior(handle, companyId, key, claimer))) return skippedOutcome(companyId, key, "claimed");
      log.keys.push(key);
      log.events.push(`verify:${key}`);
      log.active++;
      log.peak = Math.max(log.peak, log.active);
      await wait(timing.verify);
      log.active--;
      await handle
        .update(schema.historyPromotions)
        .set({ status: "no_source", claimedBy: null, outcome: { reason: "no page states it" } })
        .where(eq(schema.historyPromotions.priorKey, key));
      return { ...skippedOutcome(companyId, key, "no page states it"), status: "no_source", searched: true };
    },
  };
});

import { db } from "../lib/db";
import { companyRequestWorkflow } from "../workflows/company-request";

/** A homepage's worth of its own text: the identity check needs a page that says what the company does. */
const HOME_TEXT =
  "Acme builds software for finance teams: close the books faster, reconcile every account, and report with confidence. Trusted by finance leaders at growing companies around the world. About us, careers, press, blog, contact sales, help center, privacy policy, terms of service, cookie settings, and our newsletter for product updates and customer stories. See how teams automate approvals, forecast cash, and give every stakeholder a live view of the numbers, with integrations for the tools they already use.";

beforeEach(async () => {
  Object.assign(log, { events: [], brandBeforeIdentity: null, active: 0, peak: 0, keys: [] });
  Object.assign(scenario, { search: "results", dive: "verified", atDiveEnd: null });
  await (await db()).execute(sql`truncate table companies cascade`);
  await (await db()).execute(sql`truncate table company_requests`);
});

test("branding first, then the Deep dive and the funding search side by side, rounds verified several at once", async () => {
  const handle = await db();
  const id = crypto.randomUUID();
  await handle.insert(schema.companyRequests).values({ id, domain: "acme.com", submittedUrl: "https://acme.com/", requesterHash: "h" });
  const started = Date.now();
  await companyRequestWorkflow(id);
  const elapsed = Date.now() - started;

  // The page has a face before the identity check answers.
  expect(log.brandBeforeIdentity).toBe(true);
  expect(log.events.indexOf("brand")).toBeLessThan(log.events.indexOf("identity"));
  // The search's Series A was verified while the Deep dive was still running.
  expect(log.events.indexOf("verify:series a|$20m|2024-05-10")).toBeGreaterThan(log.events.indexOf("dive:start"));
  expect(log.events.indexOf("verify:series a|$20m|2024-05-10")).toBeLessThan(log.events.indexOf("dive:end"));
  // The dossier's Series A is the search's round, worked once; the other three at once.
  expect(log.keys.sort()).toEqual(
    [
      "seed|$4 million|2022-02-01",
      "series a|$20m|2024-05-10",
      "series b|$60 million|2025-06-01",
      "series c|$120 million|2026-03-01",
    ].sort(),
  );
  expect(log.peak).toBeGreaterThanOrEqual(3);
  expect(log.peak).toBeLessThanOrEqual(4);
  // Sequentially this was dive 300 + 4 rounds x 100 = 700 ms after the identity check; side by side it is dive 300 + one round 100.
  expect(elapsed).toBeLessThan(600);
  console.log(`mocked request: ${elapsed} ms (sequential path: ${timing.dive + 4 * timing.verify} ms of dive and verification)`);

  // Done on the search branch while the Deep dive was still running; the dossier's rounds counted after.
  expect(scenario.atDiveEnd).toMatchObject({ status: "done", tally: { found: 1 }, dossierStatus: "running" });
  const [request] = await handle.select().from(schema.companyRequests);
  expect(request).toMatchObject({
    status: "done",
    dossierStatus: "done",
    brand: { name: "Acme", logo: "https://acme.com/logo.svg", color: "#123456" },
  });
  expect(request.tally).toMatchObject({ found: 4, verified: 0 });
  expect(request.dossierFinishedAt?.getTime()).toBeGreaterThanOrEqual(request.dossierStartedAt?.getTime() ?? Number.POSITIVE_INFINITY);
  const dup = await handle
    .select()
    .from(schema.historyPromotions)
    .where(eq(schema.historyPromotions.priorKey, "series a|$20 million|2024-05-10"));
  expect(dup[0]).toMatchObject({ status: "skipped", outcome: { duplicateOf: "series a|$20m|2024-05-10" } });
});

test("a search that finds nothing still finishes, and the dossier's rounds arrive after", async () => {
  scenario.search = "empty";
  const handle = await db();
  const id = crypto.randomUUID();
  await handle.insert(schema.companyRequests).values({ id, domain: "acme.com", submittedUrl: "https://acme.com/", requesterHash: "h" });
  await companyRequestWorkflow(id);
  expect(scenario.atDiveEnd).toMatchObject({ status: "done", tally: { found: 0 }, dossierStatus: "running" });
  const [request] = await handle.select().from(schema.companyRequests);
  expect(request).toMatchObject({ status: "done", dossierStatus: "done", tally: { found: 4 } });
});

test("a failed dossier leaves the request done and stops the still-researching state", async () => {
  scenario.dive = "failed";
  const handle = await db();
  const id = crypto.randomUUID();
  await handle.insert(schema.companyRequests).values({ id, domain: "acme.com", submittedUrl: "https://acme.com/", requesterHash: "h" });
  await companyRequestWorkflow(id);
  const [request] = await handle.select().from(schema.companyRequests);
  expect(request).toMatchObject({ status: "done", dossierStatus: "failed", tally: { found: 1 } });
  expect(request.dossierFinishedAt).not.toBeNull();
});
