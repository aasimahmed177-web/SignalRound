// The dossier backfill route against an in-memory Postgres: the CRON_SECRET guard, the refusal
// without a model, the params, and the progress read. The workflow itself is not run here.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { afterEach, describe, expect, test, vi } from "vitest";

const started = vi.hoisted(() => [] as unknown[][]);
vi.mock("workflow/api", () => ({
  start: vi.fn(async (...args: unknown[]) => {
    started.push(args);
    return { runId: "wrun_mock" };
  }),
  getRun: vi.fn(() => ({ status: Promise.resolve("running") })),
}));

import { GET, POST } from "../app/api/cron/backfill-dossiers/route";
import { BACKFILL_DEFAULTS } from "../lib/intel";
import { BACKFILL_CHUNK, backfillDossiersWorkflow, dealLanes, emptyTally, tallyOutcome } from "../workflows/dossiers";

const url = "http://app.test/api/cron/backfill-dossiers";
const bearer = { authorization: "Bearer s3cret" };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  started.length = 0;
});

describe("POST /api/cron/backfill-dossiers", () => {
  test("a missing or wrong bearer is unauthorized when CRON_SECRET is set, and nothing starts", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
    expect((await POST(new Request(url, { method: "POST" }))).status).toBe(401);
    expect((await POST(new Request(url, { method: "POST", headers: { authorization: "Bearer s3cre" } }))).status).toBe(401);
    expect((await GET(new Request(url))).status).toBe(401);
    expect(started).toHaveLength(0);
  });

  test("with no CRON_SECRET it is open in development and closed in production", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
    vi.stubEnv("NODE_ENV", "production");
    expect((await POST(new Request(url, { method: "POST" }))).status).toBe(401);
    expect((await GET(new Request(url))).status).toBe(401);
    vi.stubEnv("NODE_ENV", "development");
    expect((await GET(new Request(url))).status).toBe(200);
  });

  test("refuses before any spend when no model could check a dossier", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    for (const k of ["AI_GATEWAY_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "VERCEL_OIDC_TOKEN"])
      vi.stubEnv(k, "");
    const res = await POST(new Request(url, { method: "POST", headers: bearer }));
    expect(res.status).toBe(409);
    expect(started).toHaveLength(0);
  });

  test("the right bearer starts the backfill with its params and returns the run id", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
    const res = await POST(new Request(`${url}?limit=5&reverifyOnly=1`, { method: "POST", headers: bearer }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; runId: string; workflowRunId: string; params: unknown; planned: unknown };
    expect(body.runId).toMatch(/^dossiers:/);
    expect(body.workflowRunId).toBe("wrun_mock");
    const params = {
      limit: 5,
      concurrency: BACKFILL_DEFAULTS.concurrency,
      maxTotalCredits: BACKFILL_DEFAULTS.maxTotalCredits,
      reverifyOnly: true,
    };
    expect(body.params).toEqual(params);
    expect(body.planned).toEqual({ reverify: 0, dive: 0 });
    expect(started).toHaveLength(1);
    expect(started[0][0]).toBe(backfillDossiersWorkflow);
    expect(started[0][1]).toEqual([params, body.runId]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 60_000));
    // A JSON body works the same way.
    const json = await POST(
      new Request(url, {
        method: "POST",
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({ concurrency: 2 }),
      }),
    );
    expect(((await json.json()) as { params: { concurrency: number } }).params.concurrency).toBe(2);
  });

  test("a bad param is a 400 that names it, and nothing starts", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
    for (const q of ["limit=0", "limit=abc", "concurrency=101", "maxTotalCredits=-1"]) {
      const res = await POST(new Request(`${url}?${q}`, { method: "POST", headers: bearer }));
      expect(res.status, q).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(q.split("=")[0]);
    }
    expect(started).toHaveLength(0);
  });
});

describe("GET /api/cron/backfill-dossiers", () => {
  test("reports the store's dossier coverage, the backfill rows, and a workflow's status", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await GET(new Request(`${url}?workflow=wrun_mock`, { headers: bearer }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { coverage: Record<string, number>; runs: unknown[]; workflow: unknown };
    expect(body.coverage).toEqual({ visible: 0, verified: 0, stale: 0, unchecked: 0, missing: 0, resting: 0 });
    expect(body.runs).toEqual([]);
    expect(body.workflow).toEqual({ id: "wrun_mock", status: "running" });
  });
});

describe("the backfill's bookkeeping", () => {
  test("lanes are dealt round-robin, so each lane's order is fixed before a step runs", () => {
    expect(dealLanes([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([
      [1, 4, 7],
      [2, 5],
      [3, 6],
    ]);
    expect(dealLanes([1], 3)).toEqual([[1]]);
    expect(dealLanes([], 3)).toEqual([[]]);
    expect(BACKFILL_CHUNK).toBeGreaterThanOrEqual(3);
  });

  test("the tally counts each outcome once and adds the agent's and the check's credits", () => {
    let t = emptyTally(4);
    t = tallyOutcome(t, { companyId: "a", action: "dive", status: "verified", agentCredits: 240, checkCredits: 12 });
    t = tallyOutcome(t, { companyId: "b", action: "dive", status: "rejected", agentCredits: 180, checkCredits: 9 });
    t = tallyOutcome(t, { companyId: "c", action: "reverify", status: "removed", agentCredits: 0, checkCredits: 16 });
    t = tallyOutcome(t, { companyId: "d", action: "dive", status: "skipped", agentCredits: 0, checkCredits: 0 });
    expect(t).toMatchObject({ targets: 4, dived: 2, reverified: 1, verified: 1, rejected: 1, removed: 1, skipped: 1, failed: 0 });
    expect(t).toMatchObject({ agent_credits: 420, check_credits: 37, credits: 457 });
  });
});
