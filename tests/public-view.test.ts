// A public demo's visitor reads the API, the MCP tools, the feeds, and the exports. None of them may
// carry operator detail: the verifier's model, a source's search query, a profile-refusal trail, or
// any credit figure (P0-4). These tests fail the moment one of those fields comes back.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { schema } from "@fireround/core/db";
import type { Firecrawl } from "firecrawl";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { POST as mcpPost } from "../app/api/mcp/route";
import { GET as roundsGet } from "../app/api/v1/rounds/route";
import { GET as runsGet } from "../app/api/v1/runs/route";
import { GET as feedsGet } from "../app/feeds/[token]/[file]/route";
import { corroborateRecord } from "../lib/corroborate";
import { db } from "../lib/db";
import { listRounds, persistRecords, toFeedRow } from "../lib/persist";
import { internalFields, publicLane, publicRound, publicRun, publicVerifier } from "../lib/public-view";
import { record } from "./helpers";

const MODEL = "gateway:openai/gpt-5.6-luna";
const QUERY = '"funding round" "seed" OR "pre-seed" OR "angel" million startup';
const auth = (pw: string) => ({ authorization: `Basic ${Buffer.from(`u:${pw}`).toString("base64")}` });

beforeAll(async () => {
  const handle = await db();
  await persistRecords(
    handle,
    [
      record({
        company_name: "Leaky",
        company_key: "leaky",
        verification: {
          status: "confirmed",
          notes: ["Sources agree."],
          url: "https://news.example/leaky",
          verifier: MODEL,
          sources_seen: 2,
        },
        sources: [
          { url: "https://news.example/leaky", host: "news.example", title: "Leaky raises $20M", query: QUERY },
          { url: "https://wire.example/leaky", host: "wire.example", title: "Leaky raises", query: "corroborate" },
        ],
      }),
    ],
    "series-a-b",
    "run-leaky",
  );
  const searched = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
  await corroborateRecord(handle, searched, "leaky:series_a:2026-09-02", { broad: true, maxPages: 0 });
  await handle.insert(schema.runs).values({
    id: "run-spend",
    presetSlug: "series-a-b",
    lane: "sweep",
    startedAt: new Date("2026-09-24T10:00:00Z"),
    finishedAt: new Date("2026-09-24T10:05:00Z"),
    creditsEstimated: 120,
    creditsMeasured: 118,
    counts: { searched: 8, published: 2, judge_credits: 40, corroboration_credits: 12, credits: 118, skipped_budget: 1 },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.DASHBOARD_PASSWORD;
});

/** A public demo with an admin password, so the same request can be made as a visitor and as the admin. */
function demo() {
  vi.stubEnv("PUBLIC_DEMO", "1");
  process.env.DASHBOARD_PASSWORD = "secret";
}

async function mcpCall(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const res = await mcpPost(
    new Request("http://app.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const body = await res.text();
  const data = body.split("\n").find((l) => l.startsWith("data: "));
  const reply = JSON.parse(data ? data.slice(6) : body) as { result: { content: Array<{ text: string }> } };
  return JSON.parse(reply.result.content[0].text);
}

describe("the public API carries no operator detail", () => {
  test("rounds JSON and JSONL for a visitor: no verifier, no source query, no refusal trail", async () => {
    demo();
    const json = await (await roundsGet(new Request("http://app.test/api/v1/rounds"))).json();
    expect(internalFields(json)).toEqual([]);
    const text = await (await roundsGet(new Request("http://app.test/api/v1/rounds?format=jsonl"))).text();
    expect(text).not.toContain(MODEL);
    expect(text).not.toContain("pre-seed");
    for (const line of text.trim().split("\n")) expect(internalFields(JSON.parse(line))).toEqual([]);
    // What stays: the verdict, its read count, and every source link.
    const [row] = (json as { data: Array<{ verification: Record<string, unknown>; sources: Array<Record<string, unknown>> }> }).data;
    expect(row.verification).toMatchObject({ status: "confirmed", sources_seen: 2 });
    expect(row.sources.map((s) => s.url)).toEqual(["https://news.example/leaky", "https://wire.example/leaky"]);
  });

  test("the admin and a private instance still read the full row", async () => {
    demo();
    const admin = (await (await roundsGet(new Request("http://app.test/api/v1/rounds", { headers: auth("secret") }))).json()) as {
      data: Array<{ verification: { verifier: string } }>;
    };
    expect(admin.data[0].verification.verifier).toBe(MODEL);
    vi.unstubAllEnvs();
    delete process.env.DASHBOARD_PASSWORD;
    const privateInstance = await (await roundsGet(new Request("http://app.test/api/v1/rounds"))).text();
    expect(privateInstance).toContain(MODEL);
  });

  test("the CSV export names no model and no query", async () => {
    demo();
    const csv = await (await roundsGet(new Request("http://app.test/api/v1/rounds?format=csv"))).text();
    expect(csv).not.toContain(MODEL);
    expect(csv).not.toContain("pre-seed");
    expect(csv.split("\n")[0]).not.toMatch(/credit|verifier|query/);
  });

  test("runs for a visitor: no credits columns and no credit or budget counter", async () => {
    demo();
    const body = (await (await runsGet(new Request("http://app.test/api/v1/runs"))).json()) as { data: Array<Record<string, unknown>> };
    expect(internalFields(body)).toEqual([]);
    const run = body.data.find((r) => r.id === "run-spend");
    expect(run?.counts).toEqual({ searched: 8, published: 2 });
    const admin = (await (await runsGet(new Request("http://app.test/api/v1/runs", { headers: auth("secret") }))).json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(admin.data.find((r) => r.id === "run-spend")).toMatchObject({ credits_measured: 118 });
  });
});

describe("MCP, feeds, and the browser's rows carry none either", () => {
  test("every MCP read tool for a keyless demo", async () => {
    demo();
    for (const [name, args] of [
      ["list_rounds", {}],
      ["search_rounds", { query: "leaky" }],
      ["get_company", { company: "leaky" }],
      ["list_trending", {}],
      ["list_presets", {}],
    ] as const) {
      const out = await mcpCall(name, args);
      expect(internalFields(out), name).toEqual([]);
      expect(JSON.stringify(out), name).not.toMatch(/queries|xAccounts|watchQueries/);
    }
  });

  test("RSS, Atom, and JSON Feed", async () => {
    demo();
    for (const format of ["rss", "atom", "json"]) {
      const body = await (
        await feedsGet(new Request("http://app.test/feeds/public/all"), {
          params: Promise.resolve({ token: "public", file: `all.${format}` }),
        })
      ).text();
      expect(body).not.toContain(MODEL);
      expect(body).not.toContain("pre-seed");
      expect(body).not.toMatch(/credits?\b/i);
    }
  });

  test("a feed row keeps whether it was reconciled and each page's lane, not the model or the query", async () => {
    const { rows } = await listRounds(await db(), { company: "leaky" });
    const row = toFeedRow(rows[0]);
    expect(row.verification?.verifier).toBe("model");
    expect(row.sources.map((s) => s.query)).toEqual(["search", "corroborate"]);
    expect(internalFields({ verification: row.verification }).filter((p) => !p.endsWith(".verifier"))).toEqual([]);
    expect(JSON.stringify(row)).not.toContain(MODEL);
    expect(JSON.stringify(row)).not.toContain("pre-seed");
  });
});

describe("the pure helpers", () => {
  test("publicVerifier and publicLane", () => {
    expect(publicVerifier("judge")).toBe("judge");
    expect(publicVerifier(MODEL)).toBe("model");
    expect(publicVerifier(undefined)).toBeUndefined();
    for (const [q, lane] of [
      [QUERY, "search"],
      ["corroborate", "corroborate"],
      ["formd", "formd"],
      ["manual", "manual"],
      ["watch:techcrunch.com", "watch:techcrunch.com"],
      ["x:@founder", "x:@founder"],
      ["monitor:mon_123", "monitor"],
      ["check:chk_9", "monitor"],
      ["agent:gap-fill", "agent"],
    ] as const)
      expect(publicLane(q)).toBe(lane);
    expect(publicLane(null)).toBeNull();
  });

  test("publicRound and publicRun leave nothing internalFields would find", () => {
    const r = {
      verification: { status: "confirmed", notes: [], url: null, verifier: MODEL, sources_seen: 1 },
      sources: [{ url: "u", title: null, host: "h", published: null, query: QUERY }],
      enrichment: {
        what_they_sell: null,
        pricing_model: null,
        has_free_tier: null,
        plans: [],
        pricing_page_url: null,
        website_source: "search",
        verified: false,
        error: "tried acme.io: sells shoes",
        brand: null,
      },
    };
    expect(internalFields(r).length).toBeGreaterThan(0);
    expect(internalFields(publicRound(r))).toEqual([]);
    const run = {
      id: "r",
      preset: "p",
      lane: "sweep",
      window: null,
      started_at: "",
      finished_at: null,
      credits_estimated: 1,
      credits_measured: 2,
      credits_charged: 2,
      overlapped: false,
      counts: { judge_credits: 3, published: 1 },
      error: null,
    };
    expect(internalFields(publicRun(run))).toEqual([]);
    expect(publicRun(run).counts).toEqual({ published: 1 });
  });
});
