import { afterEach, describe, expect, test, vi } from "vitest";
import { poolMax } from "../packages/core/src/db/index";

vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: vi.fn(() => Promise.reject(new Error("Database must not be called"))) }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function rpc(authorization?: string) {
  return new Request("https://app.test/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

async function tools(response: Response): Promise<string[]> {
  expect(response.status).toBe(200);
  const body = await response.text();
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : body).result.tools.map((tool: { name: string }) => tool.name);
}

describe("private MCP access", () => {
  test("a password-protected deployment without an MCP key refuses both anonymous and Basic callers", async () => {
    vi.stubEnv("PUBLIC_DEMO", "");
    vi.stubEnv("MCP_API_KEY", "");
    vi.stubEnv("DASHBOARD_PASSWORD", "dashboard-secret");
    const { GET, POST } = await import("../app/api/mcp/route");
    const { mcpTrusted } = await import("../lib/access");
    expect(mcpTrusted()).toBe(false);
    expect((await POST(rpc())).status).toBe(401);
    expect((await POST(rpc(`Basic ${Buffer.from("admin:dashboard-secret").toString("base64")}`))).status).toBe(401);
    expect((await GET(new Request("https://app.test/api/mcp"))).status).toBe(401);
  });

  test("a configured key must be presented before write tools are available", async () => {
    vi.stubEnv("PUBLIC_DEMO", "");
    vi.stubEnv("MCP_API_KEY", "mcp-secret");
    vi.stubEnv("DASHBOARD_PASSWORD", "dashboard-secret");
    const { POST } = await import("../app/api/mcp/route");
    expect((await POST(rpc())).status).toBe(401);
    expect((await POST(rpc("Bearer wrong"))).status).toBe(401);
    expect(await tools(await POST(rpc("Bearer mcp-secret")))).toContain("mark_seen");
  });

  test("a keyless public demo remains read-only even with a dashboard password", async () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    vi.stubEnv("MCP_API_KEY", "");
    vi.stubEnv("DASHBOARD_PASSWORD", "dashboard-secret");
    vi.doMock("@/lib/rate-limit", async (original) => ({
      ...(await original<typeof import("../lib/rate-limit")>()),
      limitRequest: vi.fn(async () => null),
    }));
    try {
      const { POST } = await import("../app/api/mcp/route");
      const names = await tools(await POST(rpc()));
      expect(names).toContain("list_rounds");
      expect(names).not.toContain("mark_seen");
    } finally {
      vi.doUnmock("@/lib/rate-limit");
    }
  });
});

test("the retired webhook remains closed in production", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const { POST } = await import("../app/api/webhooks/firecrawl/route");
  expect((await POST(new Request("https://app.test/api/webhooks/firecrawl", { method: "POST", body: "{}" }))).status).toBe(410);
});

describe("Postgres pool size", () => {
  test.each([undefined, "", "0", "-1", "bad", "2.5"])("defaults to three for %s", (value) => {
    vi.stubEnv("DATABASE_POOL_MAX", value);
    expect(poolMax()).toBe(3);
  });

  test("hosts can raise the pool limit", () => {
    vi.stubEnv("DATABASE_POOL_MAX", "12");
    expect(poolMax()).toBe(12);
  });
});
