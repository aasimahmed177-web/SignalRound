// What a failure or a public contract may say to a visitor. A driver error quotes its query and its
// parameters, and the MCP SDK and a plain action result would both forward it verbatim; a visitor
// gets one sentence instead. The demo's OpenAPI spec describes the visitor's API, not the admin's.

import { afterEach, describe, expect, test, vi } from "vitest";

const DRIVER_ERROR = 'Failed query: select "webhook_ciphertext" from "slack_subscriptions" where "manage_token_hash" = $1\nparams: abc';

vi.mock("@/lib/db", () => ({
  db: async () => {
    throw new Error(DRIVER_ERROR);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { saveSubscription } from "../app/(slack)/slack/actions";
import { POST as mcpPost } from "../app/api/mcp/route";
import { GET as openapiGet } from "../app/api/v1/openapi.json/route";
import { internalFields, publicRun, publicRunError } from "../lib/public-view";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function mcpCall(name: string, args: Record<string, unknown>) {
  const res = await mcpPost(
    new Request("http://app.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const body = await res.text();
  const data = body.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : body) as { result: { isError?: boolean; content: Array<{ text: string }> } };
}

describe("a failing store", () => {
  test("an MCP tool answers one sentence, never the driver's query", async () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await mcpCall("list_rounds", {});
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("internal error");
    expect(JSON.stringify(r)).not.toMatch(/Failed query|slack_subscriptions|params/);
  });

  test("a Slack manage action answers one sentence past a well-shaped token", async () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    vi.stubEnv("SLACK_CLIENT_ID", "1.2");
    vi.stubEnv("SLACK_CLIENT_SECRET", "s");
    vi.stubEnv("SLACK_WEBHOOK_KEY", "k".repeat(40));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await saveSubscription("a".repeat(43), { preset: "all", cadence: "instant" });
    expect(r).toEqual({ ok: false, error: "Something went wrong on our side. Try again in a moment." });
    // The sentences written for the visitor still come through.
    expect(await saveSubscription("short", { preset: "all", cadence: "instant" })).toMatchObject({
      error: expect.stringContaining("not valid"),
    });
  });
});

describe("publicRunError", () => {
  test("a driver error or a stack reads as a sentence; a plain one keeps its first line without step paths", () => {
    expect(publicRunError(null)).toBeNull();
    expect(publicRunError(DRIVER_ERROR)).toBe("The run stopped on an internal error.");
    expect(publicRunError("Error: boom\n    at run (/var/task/lib/x.js:1:2)")).toBe("The run stopped on an internal error.");
    expect(publicRunError('FatalError: Step "step//./workflows/sweep//deepDiveStep" exceeded max retries (4 retries)')).toBe(
      'FatalError: Step "deepDiveStep" exceeded max retries (4 retries)',
    );
    expect(publicRunError("dossier rejected: different company")).toBe("dossier rejected: different company");
  });

  test("publicRun carries the public error", () => {
    const run = publicRun({
      id: "r",
      preset: "seed",
      lane: "sweep",
      window: "24h",
      started_at: "2026-09-25T00:00:00Z",
      finished_at: null,
      credits_estimated: 1,
      credits_measured: 1,
      credits_charged: 1,
      overlapped: false,
      counts: { records: 1, credits: 5 },
      error: DRIVER_ERROR,
    });
    expect(run.error).toBe("The run stopped on an internal error.");
    expect(internalFields(run)).toEqual([]);
  });
});

describe("GET /api/v1/openapi.json", () => {
  const spec = async () => (await openapiGet(new Request("http://app.test/api/v1/openapi.json")).json()) as Record<string, unknown>;

  test("a public demo advertises the visitor's API: no include_review, no credit fields, no Basic auth", async () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    const text = JSON.stringify(await spec());
    for (const internal of [
      "include_review",
      "credits_estimated",
      "credits_charged",
      "overlapped",
      "securitySchemes",
      '"review"',
      '"rejected"',
    ]) {
      expect(text).not.toContain(internal);
    }
    expect(text).toContain("/api/v1/rounds");
  });

  test("a private instance documents the whole API", async () => {
    const text = JSON.stringify(await spec());
    for (const field of ["include_review", "credits_estimated", "securitySchemes"]) expect(text).toContain(field);
  });
});
