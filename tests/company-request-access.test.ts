// Developer access to company requests: the MCP tools and the OpenAPI entries, both behind
// COMPANY_REQUESTS=1, and the MCP door sharing the POST route's checks, dedupe, and daily caps.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { schema } from "@fireround/core/db";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const started = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("workflow/api", () => ({ start: started }));
vi.mock("botid/server", () => ({ checkBotId: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (original) => {
  const real = await original<typeof import("../lib/safe-fetch")>();
  return { ...real, publicUrl: (raw: string, resolve?: Resolve) => real.publicUrl(raw, resolve ?? (async () => ["8.8.8.8"])) };
});

import { POST } from "../app/api/company-requests/route";
import { POST as mcpPost } from "../app/api/mcp/route";
import { GET as openapiGet } from "../app/api/v1/openapi.json/route";
import { db } from "../lib/db";
import { LIMITS, rateLimit, resetRateLimitsForTests } from "../lib/rate-limit";
import type { Resolve } from "../lib/safe-fetch";

const ADDRESS = "203.0.113.20";

function rpc(method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("http://app.test/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": ADDRESS, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

/** The JSON-RPC reply, read out of the event stream when the server answered with one. */
async function reply(res: Response): Promise<{ result: Record<string, unknown> }> {
  const body = await res.text();
  const data = body.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : body);
}

async function toolNames(post = mcpPost, headers: Record<string, string> = {}): Promise<string[]> {
  return ((await reply(await post(rpc("tools/list", {}, headers)))).result.tools as Array<{ name: string }>).map((t) => t.name);
}

async function call(name: string, args: Record<string, unknown>, address = ADDRESS) {
  const { result } = await reply(await mcpPost(rpc("tools/call", { name, arguments: args }, { "x-forwarded-for": address })));
  const [content] = result.content as Array<{ text: string }>;
  return result.isError ? { error: content.text } : (JSON.parse(content.text) as Record<string, unknown>);
}

const submit = (url: string, address = ADDRESS) =>
  POST(
    new Request("https://app.test/api/company-requests", {
      method: "POST",
      headers: { origin: "https://app.test", host: "app.test", "x-forwarded-for": address, "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  );

beforeEach(async () => {
  started.mockClear();
  await resetRateLimitsForTests();
  await (await db()).execute(sql`truncate table companies, company_requests cascade`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.COMPANY_REQUESTS;
  delete process.env.COMPANY_REQUESTS_DAILY_MAX;
});

describe("MCP request tools", () => {
  test("are listed only with COMPANY_REQUESTS=1, for a keyless public demo too", async () => {
    expect(await toolNames()).not.toContain("request_company");
    const unknown = await reply(await mcpPost(rpc("tools/call", { name: "request_company", arguments: { website: "acme.com" } })));
    expect(unknown).toHaveProperty("error");
    expect(started).not.toHaveBeenCalled();
    vi.stubEnv("COMPANY_REQUESTS", "1");
    vi.stubEnv("PUBLIC_DEMO", "1");
    expect(await toolNames()).toEqual([
      "list_rounds",
      "search_rounds",
      "get_company",
      "list_trending",
      "list_companies",
      "get_company_profile",
      "list_investors",
      "get_investor",
      "top_investors",
      "list_news",
      "list_presets",
      "request_company",
      "company_request_status",
    ]);
  });

  test("a request starts research, reads its status, and dedupes against the page's POST", async () => {
    vi.stubEnv("COMPANY_REQUESTS", "1");
    const created = await call("request_company", { website: "https://www.acme.example.com/about" });
    expect(created).toMatchObject({ status: "queued", message: null, company_url: "http://app.test/companies/example.com" });
    const id = created.id as string;
    expect(created.request_url).toBe(`http://app.test/requests/${id}`);
    expect(started).toHaveBeenCalledTimes(1);
    expect(await (await submit("acme.example.com")).json()).toEqual({
      id,
      requestUrl: `/requests/${id}`,
      companyUrl: "/companies/example.com",
    });
    expect((await call("request_company", { website: "acme.example.com" })).id).toBe(id);
    expect(started).toHaveBeenCalledTimes(1);
    expect(await call("company_request_status", { id })).toEqual(created);
    expect(await call("company_request_status", { id: crypto.randomUUID() })).toEqual({ error: "No company request has that id." });
  });

  test("a finished request links its company, and a known company answers with its page", async () => {
    vi.stubEnv("COMPANY_REQUESTS", "1");
    vi.stubEnv("APP_ORIGIN", "https://fireround.dev");
    const handle = await db();
    const id = crypto.randomUUID();
    await handle.insert(schema.companies).values({ id: "acme.com", name: "Acme", nameKey: "acme", domain: "acme.com" });
    await handle.insert(schema.companyRequests).values({
      id,
      domain: "acme.com",
      submittedUrl: "https://acme.com/",
      requesterHash: "hash",
      companyId: "acme.com",
      status: "done",
      message: "No earlier funding round could be verified.",
    });
    expect(await call("company_request_status", { id })).toEqual({
      id,
      status: "done",
      step: null,
      message: "No earlier funding round could be verified.",
      company_url: "https://fireround.dev/companies/acme.com",
      request_url: `https://fireround.dev/requests/${id}`,
    });
    expect(await call("request_company", { website: "https://acme.com" })).toEqual({
      company_url: "https://fireround.dev/companies/acme.com",
    });
    expect(started).not.toHaveBeenCalled();
  });

  test("refuses what the page refuses", async () => {
    vi.stubEnv("COMPANY_REQUESTS", "1");
    for (const website of ["https://linkedin.com/company/acme", "http://127.0.0.1/", "localhost"]) {
      expect(await call("request_company", { website })).toEqual({
        error: "Enter a public company website, not a directory or news site.",
      });
    }
    expect(started).not.toHaveBeenCalled();
  });

  test("one address's three a day and the global cap count both doors", async () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    vi.stubEnv("COMPANY_REQUESTS", "1");
    vi.stubEnv("COMPANY_REQUESTS_DAILY_MAX", "4");
    expect((await submit("https://firm0.com")).status).toBe(202);
    expect((await submit("https://firm1.com")).status).toBe(202);
    expect(await call("request_company", { website: "firm2.com" })).toHaveProperty("status", "queued");
    expect((await call("request_company", { website: "firm3.com" })).error).toMatch(
      /^You've used today's 3 research requests\. You can request another in about /,
    );
    expect((await submit("https://firm3.com")).status).toBe(429);
    expect(await call("request_company", { website: "firm3.com" }, "203.0.113.21")).toHaveProperty("status", "queued");
    expect((await call("request_company", { website: "firm4.com" }, "203.0.113.22")).error).toMatch(
      /^Fireround has reached today's research limit/,
    );
    expect((await submit("https://firm4.com", "203.0.113.23")).status).toBe(429);
    expect(started).toHaveBeenCalledTimes(4);
  });

  test("the endpoint's own limit still answers first on a keyless public demo", async () => {
    vi.stubEnv("COMPANY_REQUESTS", "1");
    vi.stubEnv("PUBLIC_DEMO", "1");
    for (let i = 0; i < LIMITS.mcp.limit; i++) await rateLimit(LIMITS.mcp, ADDRESS);
    const res = await mcpPost(rpc("tools/call", { name: "request_company", arguments: { website: "acme.com" } }));
    expect(res.status).toBe(429);
    expect(started).not.toHaveBeenCalled();
  });

  test("MCP_API_KEY mode requires the bearer, then serves the request tools", async () => {
    vi.stubEnv("COMPANY_REQUESTS", "1");
    vi.stubEnv("MCP_API_KEY", "key-123");
    vi.resetModules();
    const { POST: keyed } = await import("../app/api/mcp/route");
    expect((await keyed(rpc("tools/list", {}))).status).toBe(401);
    expect(await toolNames(keyed, { authorization: "Bearer key-123" })).toContain("request_company");
  });
});

describe("OpenAPI", () => {
  const spec = async () =>
    (await openapiGet(new Request("http://app.test/api/v1/openapi.json")).json()) as {
      paths: Record<string, Record<string, { description: string; responses: Record<string, unknown> }>>;
    };

  test("documents the request operations only with COMPANY_REQUESTS=1", async () => {
    expect(Object.keys((await spec()).paths)).toEqual([
      "/api/v1/rounds",
      "/api/v1/companies",
      "/api/v1/companies/{id}",
      "/api/v1/investors",
      "/api/v1/investors/top",
      "/api/v1/investors/{id}",
      "/api/v1/news",
      "/api/v1/runs",
      "/api/v1/signals",
    ]);
    vi.stubEnv("COMPANY_REQUESTS", "1");
    vi.stubEnv("COMPANY_REQUESTS_DAILY_MAX", "20");
    const { paths } = await spec();
    expect(Object.keys(paths)).toEqual([
      "/api/v1/rounds",
      "/api/v1/companies",
      "/api/v1/companies/{id}",
      "/api/v1/investors",
      "/api/v1/investors/top",
      "/api/v1/investors/{id}",
      "/api/v1/news",
      "/api/v1/runs",
      "/api/v1/signals",
      "/api/company-requests",
      "/api/company-requests/{id}",
    ]);
    const post = paths["/api/company-requests"].post;
    expect(Object.keys(post.responses).sort()).toEqual(["200", "202", "400", "403", "404", "429", "503"]);
    expect(post.description).toContain("3 per address per day");
    expect(post.description).toContain("20 new requests per UTC day");
    expect(post.description).toContain("never delivered");
    expect(Object.keys(paths["/api/company-requests/{id}"].get.responses).sort()).toEqual(["200", "404"]);
    expect(JSON.stringify(paths)).not.toMatch(/[\u2013\u2014]/);
  });
});
