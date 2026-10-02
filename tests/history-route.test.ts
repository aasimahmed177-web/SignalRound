// The history backfill route and the feeds against the app's own in-memory store: the CRON_SECRET
// guard, the params, the progress read, and a promoted history row kept out of RSS, Atom, and JSON.
// The workflow itself is not run here; lib/history.ts is tested in tests/history.test.ts.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { afterEach, describe, expect, test, vi } from "vitest";

const started = vi.hoisted(() => [] as unknown[][]);
vi.mock("workflow/api", () => ({
  start: vi.fn(async (...args: unknown[]) => {
    started.push(args);
    return { runId: "wrun_history" };
  }),
  getRun: vi.fn(() => ({ status: Promise.resolve("running") })),
}));

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { GET as routeGet, POST as routePost } from "../app/api/cron/history-rounds/route";
import { GET as feedsGet } from "../app/feeds/[token]/[file]/route";
import { db } from "../lib/db";
import { promotePrior } from "../lib/history";
import { mintFeedToken } from "../lib/settings";
import { backfillHistoryWorkflow, companyHistoryWorkflow, queueCompanyHistoryStep } from "../workflows/history";
import { item, reader, round, SEED_KEY, SEED_URL, seed, seedSearch } from "./history-fixtures";

afterEach(() => {
  vi.unstubAllEnvs();
  started.length = 0;
});

describe("a newly checked dossier", () => {
  test("queues its prior rounds and starts the company's own pass; once promoted, nothing is queued again", async () => {
    const app = await db();
    const companyId = await seed(app);
    expect(await queueCompanyHistoryStep(companyId)).toBe(true);
    expect(started).toHaveLength(1);
    expect(started[0][0]).toBe(companyHistoryWorkflow);
    expect(started[0][1]).toEqual([companyId]);
    const { reader: r } = reader({ search: seedSearch, pages: { [SEED_URL]: [item(SEED_URL, round({}))] } });
    expect((await promotePrior(app, r, companyId, SEED_KEY, "history:test")).status).toBe("promoted");
    expect(await queueCompanyHistoryStep(companyId)).toBe(false);
    expect(started).toHaveLength(1);
  });
});

describe("feeds", () => {
  test("RSS, Atom, and JSON feeds: never an item", async () => {
    // The route reads the app's own store, where the test above promoted Footprint's seed.
    const app = await db();
    const [out] = await app
      .select({ roundId: schema.fundingRounds.id })
      .from(schema.fundingRounds)
      .where(eq(schema.fundingRounds.history, true));
    expect(out?.roundId).toBeTruthy();
    const token = await mintFeedToken(app, "test", "series-a-b");
    const ctx = (file: string) => ({ params: Promise.resolve({ token, file }) });
    const rss = await (await feedsGet(new Request("http://app.test/feeds/x/y"), ctx("series-a-b.rss"))).text();
    expect(rss).not.toContain("<item>");
    expect(rss).not.toContain(String(out.roundId));
    const atom = await (await feedsGet(new Request("http://app.test/feeds/x/y"), ctx("series-a-b.atom"))).text();
    expect(atom).not.toContain("<entry>");
    const json = (await (await feedsGet(new Request("http://app.test/feeds/x/y"), ctx("series-a-b.json"))).json()) as {
      items: Array<{ id: string }>;
    };
    expect(json.items).toHaveLength(0);
    expect(json.items.map((i) => i.id)).not.toContain(out.roundId);
  });
});

describe("/api/cron/history-rounds", () => {
  const url = "http://app.test/api/cron/history-rounds";
  const bearer = { authorization: "Bearer s3cret" };

  test("a missing or wrong bearer is unauthorized, and nothing starts; with no secret it is closed in production", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await routePost(new Request(url, { method: "POST" }))).status).toBe(401);
    expect((await routePost(new Request(url, { method: "POST", headers: { authorization: "Bearer nope" } }))).status).toBe(401);
    expect((await routeGet(new Request(url))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    expect((await routePost(new Request(url, { method: "POST" }))).status).toBe(401);
    expect(started).toHaveLength(0);
  });

  test("the right bearer starts the backfill with its params and returns the workflow run id; a bad param is a 400", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await routePost(new Request(`${url}?limit=10&concurrency=2&maxTotalCredits=1500`, { method: "POST", headers: bearer }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; workflowRunId: string; params: unknown; planned: { companies: number } };
    expect(body.runId).toMatch(/^history-rounds:/);
    expect(body.workflowRunId).toBe("wrun_history");
    expect(body.params).toEqual({ limit: 10, concurrency: 2, maxTotalCredits: 1500 });
    expect(started[0][0]).toBe(backfillHistoryWorkflow);
    expect(started[0][1]).toEqual([body.params, body.runId]);
    const bad = await routePost(new Request(`${url}?concurrency=0`, { method: "POST", headers: bearer }));
    expect(bad.status).toBe(400);
    expect(started).toHaveLength(1);
  });

  test("GET reports where the prior rounds stand and a workflow's status", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await routeGet(new Request(`${url}?workflow=wrun_history`, { headers: bearer }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { coverage: Record<string, number>; runs: unknown[]; workflow: unknown };
    expect(body.coverage).toHaveProperty("prior_rounds");
    expect(body.workflow).toEqual({ id: "wrun_history", status: "running" });
  });
});
