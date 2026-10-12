// The public demo's rate limiter against an in-memory Postgres: the count lives in the store, so it
// holds across serverless instances; only a demo's visitors are counted; each open door that costs
// something per call answers 429 (or, for the palette, no hits) once one address spends its budget.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));

import { schema } from "@fireround/core/db";
import { NextRequest } from "next/server";
import { searchEntities } from "../app/(dashboard)/search/actions";
import { GET as logoGet } from "../app/api/logo/[id]/route";
import { GET as mcpGet, POST as mcpPost } from "../app/api/mcp/route";
import { GET as roundsGet } from "../app/api/v1/rounds/route";
import { GET as runsGet } from "../app/api/v1/runs/route";
import { db } from "../lib/db";
import { LIMITS, type Limit, limitRequest, rateLimit, resetRateLimitsForTests } from "../lib/rate-limit";

const IP = "203.0.113.7";
const from = (ip = IP) => ({ "x-forwarded-for": `${ip}, 10.0.0.1` });

/** Spend a bucket's whole budget for one address, as earlier calls would have. */
async function exhaust(limit: Limit, ip = IP) {
  for (let i = 0; i < limit.limit; i++) expect((await rateLimit(limit, ip)).ok).toBe(true);
}

beforeEach(async () => {
  await resetRateLimitsForTests();
  request.headers = new Headers(from());
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.DASHBOARD_PASSWORD;
});

describe("rateLimit", () => {
  const tiny: Limit = { bucket: "test", limit: 3, windowMs: 60_000 };
  const t0 = Date.UTC(2026, 8, 25, 12, 0, 5);

  test("counts per address in a fixed window, and the next window starts over", async () => {
    for (let i = 0; i < 3; i++) expect((await rateLimit(tiny, IP, t0)).ok).toBe(true);
    const refused = await rateLimit(tiny, IP, t0 + 1000);
    expect(refused).toEqual({ ok: false, retryAfter: 54 });
    expect((await rateLimit(tiny, "198.51.100.1", t0)).ok).toBe(true);
    expect((await rateLimit(tiny, IP, t0 + 60_000)).ok).toBe(true);
  });

  test("the count is the store's, so a second instance (an empty memory) still refuses", async () => {
    for (let i = 0; i < 3; i++) await rateLimit(tiny, IP, t0);
    // A cold instance: this one's memory forgotten, the row kept.
    const handle = await db();
    const rows = await handle.select().from(schema.rateLimits);
    await resetRateLimitsForTests();
    await handle.insert(schema.rateLimits).values(rows);
    expect((await rateLimit(tiny, IP, t0)).ok).toBe(false);
  });

  test("no address is stored, only a hash of it", async () => {
    await rateLimit(tiny, IP, t0);
    const rows = await (await db()).select().from(schema.rateLimits);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toMatch(/^test:[0-9a-f]{32}$/);
    expect(JSON.stringify(rows)).not.toContain(IP);
  });
});

describe("limitRequest", () => {
  test("only a public demo's visitors are counted", async () => {
    await exhaust(LIMITS.api);
    const req = new Request("http://app.test/api/v1/rounds", { headers: from() });
    expect(await limitRequest(req, LIMITS.api)).toBeNull();
    vi.stubEnv("PUBLIC_DEMO", "1");
    expect(await limitRequest(req, LIMITS.api, true)).toBeNull();
    const refused = await limitRequest(req, LIMITS.api);
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(refused?.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the open doors on a public demo", () => {
  beforeEach(() => vi.stubEnv("PUBLIC_DEMO", "1"));

  test("/api/v1/rounds and /api/v1/runs share the API budget; another address is unaffected", async () => {
    await exhaust(LIMITS.api);
    expect((await roundsGet(new Request("http://app.test/api/v1/rounds", { headers: from() }))).status).toBe(429);
    expect((await runsGet(new Request("http://app.test/api/v1/runs", { headers: from() }))).status).toBe(429);
    expect((await roundsGet(new Request("http://app.test/api/v1/rounds", { headers: from("198.51.100.2") }))).status).toBe(200);
  });

  test("the full CSV export has its own, tighter budget", async () => {
    await exhaust(LIMITS.export);
    expect((await roundsGet(new Request("http://app.test/api/v1/rounds?format=csv", { headers: from() }))).status).toBe(429);
    // A CSV page with a limit is an ordinary API call.
    expect((await roundsGet(new Request("http://app.test/api/v1/rounds?format=csv&limit=5", { headers: from() }))).status).toBe(200);
  });

  test("an admin is never counted", async () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    await exhaust(LIMITS.api);
    const admin = { ...from(), authorization: `Basic ${Buffer.from("u:secret").toString("base64")}` };
    expect((await roundsGet(new Request("http://app.test/api/v1/rounds", { headers: admin }))).status).toBe(200);
  });

  test("Alexandria's key lifts the per-address budget and reads only what a visitor reads", async () => {
    vi.stubEnv("ALEXANDRIA_API_KEY", "alexandria-key");
    await exhaust(LIMITS.api);
    const alexandria = { ...from(), authorization: "Bearer alexandria-key" };
    const res = await roundsGet(new Request("http://app.test/api/v1/rounds", { headers: alexandria }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("public");
    expect((await roundsGet(new Request("http://app.test/api/v1/rounds?include_review=true", { headers: alexandria }))).status).toBe(403);
    const wrong = { ...from(), authorization: "Bearer not-the-key" };
    expect((await roundsGet(new Request("http://app.test/api/v1/rounds", { headers: wrong }))).status).toBe(429);
  });

  test("a bearer counts like any visitor when no Alexandria key is configured", async () => {
    await exhaust(LIMITS.api);
    const bearer = { ...from(), authorization: "Bearer " };
    expect((await roundsGet(new Request("http://app.test/api/v1/rounds", { headers: bearer }))).status).toBe(429);
  });

  test("MCP answers 429 before the server reads the request", async () => {
    await exhaust(LIMITS.mcp);
    expect((await mcpGet(new Request("http://app.test/api/mcp", { headers: from() }))).status).toBe(429);
  });

  test("MCP refuses a batch, so one request cannot carry many tool calls on one count", async () => {
    const call = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "search_rounds", arguments: { query: "acme" } },
    });
    const post = (body: unknown) =>
      mcpPost(
        new Request("http://app.test/api/mcp", {
          method: "POST",
          headers: { ...from(), "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify(body),
        }),
      );
    const batch = await post([call(1), call(2), call(3)]);
    expect(batch.status).toBe(400);
    expect(await batch.json()).toMatchObject({ error: { code: -32600 } });
    expect(await (await db()).select().from(schema.rateLimits)).toHaveLength(0);
    expect((await post(call(1))).status).toBe(200);
    expect((await post([call(1)])).status).toBe(200);
  });

  test("the palette's search returns no hits past its budget", async () => {
    await exhaust(LIMITS.search);
    expect(await searchEntities("acme")).toEqual({ companies: [], investors: [] });
  });

  test("the logo route refuses a cache-busting query outright, and counts the rest", async () => {
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    expect((await logoGet(new NextRequest("http://app.test/api/logo/acme?ui=1&v=123", { headers: from() }), ctx("acme"))).status).toBe(404);
    expect((await logoGet(new NextRequest("http://app.test/api/logo/acme?kind=other", { headers: from() }), ctx("acme"))).status).toBe(404);
    await exhaust(LIMITS.logo);
    expect((await logoGet(new NextRequest("http://app.test/api/logo/acme?ui=1", { headers: from() }), ctx("acme"))).status).toBe(429);
  });
});
