// Route handlers called directly with Web Requests against an in-memory Postgres.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { beforeAll, describe, expect, test } from "vitest";
import { POST as mcpPost } from "../app/api/mcp/route";
import { GET as openapiGet } from "../app/api/v1/openapi.json/route";
import { GET as roundsGet } from "../app/api/v1/rounds/route";
import { GET as runsGet } from "../app/api/v1/runs/route";
import { POST as webhookPost } from "../app/api/webhooks/firecrawl/route";
import { GET as feedsGet } from "../app/feeds/[token]/[file]/route";
import { corroborateRecord } from "../lib/corroborate";
import { db } from "../lib/db";
import { signForTests } from "../lib/firecrawl-webhook";
import { persistRecords } from "../lib/persist";
import { feedItemId } from "../lib/public-feeds";
import { mintFeedToken } from "../lib/settings";
import { record } from "./helpers";

const searched = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;

beforeAll(async () => {
  const handle = await db();
  await persistRecords(
    handle,
    [
      record({
        company_name: "Alpha",
        stage: "series_a",
        announced_date: "2026-09-03",
        company_domain: "alpha.com",
        company_website: "https://alpha.com",
      }),
      record({
        company_name: "Beta",
        stage: "series_b",
        announced_date: "2026-09-02",
        lead_investors: ["Big Fund"],
        certainty: "reported",
      }),
      record({ company_name: "Gamma", stage: "series_a", announced_date: "2026-09-01", confidence: 0.3 }),
    ],
    "series-a-b",
    "run-routes",
  );
  await persistRecords(
    handle,
    [record({ company_name: "Sprout", stage: "seed", stage_as_written: "Seed", announced_date: "2026-08-30" })],
    "seed",
    "run-routes-seed",
  );
  for (const id of ["alpha:series_a:2026-09-03", "beta:series_b:2026-09-02", "sprout:seed:2026-08-30"])
    await corroborateRecord(handle, searched, id, { broad: true, maxPages: 0 });
});

test("feed tokens opt in to expected rounds individually, while public feeds remain closed-only", async () => {
  const handle = await db();
  const id = "alpha:series_a:2026-09-03";
  await handle.update(schema.fundingRounds).set({ certainty: "expected" }).where(eq(schema.fundingRounds.id, id));
  try {
    const defaultToken = await mintFeedToken(handle, "default expected filter", "series-a-b");
    const optedToken = await mintFeedToken(handle, "opted expected filter", "series-a-b", true);
    for (const format of ["rss", "atom", "json"]) {
      const body = async (token: string) =>
        (
          await feedsGet(new Request("http://app.test/feeds/x/y"), { params: Promise.resolve({ token, file: `series-a-b.${format}` }) })
        ).text();
      expect(await body(defaultToken)).not.toContain("Alpha");
      expect(await body(optedToken)).toContain("Alpha plans to raise");
      process.env.PUBLIC_DEMO = "1";
      try {
        expect(await body("public")).not.toContain("Alpha");
      } finally {
        delete process.env.PUBLIC_DEMO;
      }
    }
  } finally {
    await handle.update(schema.fundingRounds).set({ certainty: "announced" }).where(eq(schema.fundingRounds.id, id));
  }
});

describe("GET /api/v1/rounds", () => {
  test("json with filters and a cursor", async () => {
    const res = await roundsGet(new Request("http://app.test/api/v1/rounds?limit=1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ company: { name: string } }>; next_cursor: string | null };
    expect(body.data.map((r) => r.company.name)).toEqual(["Alpha"]);
    expect(body.next_cursor).toBeTruthy();

    const page2 = (await (
      await roundsGet(new Request(`http://app.test/api/v1/rounds?limit=1&cursor=${encodeURIComponent(body.next_cursor ?? "")}`))
    ).json()) as { data: Array<{ company: { name: string } }> };
    expect(page2.data.map((r) => r.company.name)).toEqual(["Beta"]);

    const b = (await (await roundsGet(new Request("http://app.test/api/v1/rounds?stage=series_b"))).json()) as {
      data: Array<{ company: { name: string } }>;
    };
    expect(b.data.map((r) => r.company.name)).toEqual(["Beta"]);

    const q = (await (await roundsGet(new Request("http://app.test/api/v1/rounds?q=big%20fund"))).json()) as {
      data: Array<{ company: { name: string } }>;
    };
    expect(q.data.map((r) => r.company.name)).toEqual(["Beta"]);

    const byDomain = (await (await roundsGet(new Request("http://app.test/api/v1/rounds?company=https://www.alpha.com/"))).json()) as {
      data: Array<{ company: { name: string } }>;
    };
    expect(byDomain.data.map((r) => r.company.name)).toEqual(["Alpha"]);

    // Gamma scored 0.3 and sits in review; hidden unless asked for.
    const all = (await (await roundsGet(new Request("http://app.test/api/v1/rounds"))).json()) as { data: unknown[] };
    expect(all.data).toHaveLength(3);
    const withReview = (await (await roundsGet(new Request("http://app.test/api/v1/rounds?include_review=true"))).json()) as {
      data: unknown[];
    };
    expect(withReview.data).toHaveLength(4);
  });

  test("include_review on a public demo needs the dashboard password", async () => {
    const auth = (pw: string) => ({ authorization: `Basic ${Buffer.from(`u:${pw}`).toString("base64")}` });
    const url = "http://app.test/api/v1/rounds?include_review=true";
    process.env.PUBLIC_DEMO = "1";
    process.env.DASHBOARD_PASSWORD = "secret";
    try {
      const visitor = await roundsGet(new Request(url));
      expect(visitor.status).toBe(403);
      expect(((await visitor.json()) as { error: string }).error).toContain("include_review");
      expect((await roundsGet(new Request(url, { headers: auth("wrong") }))).status).toBe(403);
      // The plain read stays open to a visitor; only the review rows are gated.
      expect((await roundsGet(new Request("http://app.test/api/v1/rounds"))).status).toBe(200);
      const admin = (await (await roundsGet(new Request(url, { headers: auth("secret") }))).json()) as { data: unknown[] };
      expect(admin.data).toHaveLength(4);
    } finally {
      delete process.env.PUBLIC_DEMO;
      delete process.env.DASHBOARD_PASSWORD;
    }
  });

  test("preset narrows to the rows that preset wrote, and every row names its preset", async () => {
    type Body = { data: Array<{ company: { name: string }; preset_slug: string }> };
    const seed = (await (await roundsGet(new Request("http://app.test/api/v1/rounds?preset=seed"))).json()) as Body;
    expect(seed.data.map((r) => [r.company.name, r.preset_slug])).toEqual([["Sprout", "seed"]]);
    const ab = (await (await roundsGet(new Request("http://app.test/api/v1/rounds?preset=series-a-b"))).json()) as Body;
    expect(ab.data.map((r) => r.company.name)).toEqual(["Alpha", "Beta"]);
    const none = (await (await roundsGet(new Request("http://app.test/api/v1/rounds?preset=growth"))).json()) as Body;
    expect(none.data).toEqual([]);
  });

  test("csv and jsonl", async () => {
    const csv = await roundsGet(new Request("http://app.test/api/v1/rounds?format=csv"));
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\n")[0]).toMatch(/^status,company,website,logo_url,stage,/);
    expect(text.split("\n")[0]).toContain(",certainty,");
    expect(text).toContain(",reported,");
    expect(text).toContain("Alpha");
    const jsonl = await roundsGet(new Request("http://app.test/api/v1/rounds?format=jsonl"));
    expect(jsonl.headers.get("content-type")).toContain("ndjson");
    const lines = (await jsonl.text()).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).company.name).toBe("Alpha");
    expect(JSON.parse(lines[0]).certainty).toBe("announced");
  });

  test("certainty filters before pagination across JSON and CSV", async () => {
    const first = (await (await roundsGet(new Request("http://app.test/api/v1/rounds?certainty=reported&limit=1"))).json()) as {
      data: Array<{ company: { name: string }; certainty: string }>;
      next_cursor: string | null;
    };
    expect(first.data.map((r) => [r.company.name, r.certainty])).toEqual([["Beta", "reported"]]);
    expect(first.next_cursor).toBeNull();
    const csv = await (await roundsGet(new Request("http://app.test/api/v1/rounds?certainty=reported&format=csv"))).text();
    expect(csv).toContain("Beta");
    expect(csv).not.toContain("Alpha");
    const announced = (await (await roundsGet(new Request("http://app.test/api/v1/rounds?certainty=announced"))).json()) as {
      data: Array<{ company: { name: string } }>;
    };
    expect(announced.data.map((r) => r.company.name)).toEqual(["Alpha", "Sprout"]);
  });

  test("a bad parameter is a 400 with one line, never a silent empty set", async () => {
    const cases: Array<[string, string]> = [
      ["limit=0", "limit"],
      ["limit=1.5", "limit"],
      ["limit=abc", "limit"],
      ["limit=201", "limit"],
      ["since=not-a-date", "since"],
      ["since=2026-02-30", "since"],
      ["min_usd=-1", "min_usd"],
      ["min_usd=abc", "min_usd"],
      ["stage=series_z", "stage"],
      ["stage=series_a,bogus", "stage"],
      ["status=archived", "status"],
      ["certainty=", "certainty"],
      ["certainty=announced,reported", "certainty"],
      ["certainty=rumor", "certainty"],
      ["format=xml", "format"],
      ["cursor=notacursor", "cursor"],
      ["cursor=2026-09-03", "cursor"],
      ["cursor=09-03|x", "cursor"],
    ];
    for (const [qs, needle] of cases) {
      const res = await roundsGet(new Request(`http://app.test/api/v1/rounds?${qs}`));
      expect(res.status, qs).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(Object.keys(body), qs).toEqual(["error"]);
      expect(body.error, qs).toContain(needle);
      expect(body.error).not.toMatch(/\n/);
    }

    // Valid values still return data.
    const ok = await roundsGet(
      new Request("http://app.test/api/v1/rounds?limit=2&since=2026-08-01&stage=series_a,series_b&status=new,seen&min_usd=0&format=json"),
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { data: unknown[] };
    expect(body.data.length).toBeGreaterThan(0);
  });

  test("runs shares the limit rule", async () => {
    const bad = await runsGet(new Request("http://app.test/api/v1/runs?limit=0"));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "limit must be a whole number from 1 to 200" });
    expect((await runsGet(new Request("http://app.test/api/v1/runs?limit=5"))).status).toBe(200);
  });
});

describe("GET /api/v1/openapi.json", () => {
  test("serves OpenAPI 3.1 for the read API", async () => {
    const res = openapiGet(new Request("http://app.test/api/v1/openapi.json"));
    const spec = (await res.json()) as {
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<string, unknown>;
      components: { schemas: { Round: { properties: Record<string, unknown> } } };
    };
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers[0].url).toBe("http://app.test");
    expect(Object.keys(spec.paths)).toEqual([
      "/api/v1/rounds",
      "/api/v1/companies",
      "/api/v1/companies/{id}",
      "/api/v1/investors",
      "/api/v1/investors/top",
      "/api/v1/investors/{id}",
      "/api/v1/news",
      "/api/v1/runs",
    ]);
    const params = (spec.paths["/api/v1/rounds"] as { get: { parameters: Array<{ name: string; description?: string }> } }).get.parameters;
    const preset = params.find((p) => p.name === "preset");
    for (const slug of ["series-a-b", "seed", "growth"]) expect(preset?.description).toContain(slug);
    expect(params.find((p) => p.name === "certainty")).toMatchObject({
      schema: { enum: ["announced", "reported", "expected", "unconfirmed"] },
    });
    const round = spec.components.schemas.Round;
    expect(round.properties.certainty).toMatchObject({ enum: ["announced", "reported", "expected", "unconfirmed"] });
  });
});

describe("MCP certainty contract", () => {
  async function rpc(method: string, params: Record<string, unknown>) {
    const res = await mcpPost(
      new Request("http://app.test/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    const body = await res.text();
    const data = body.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data ? data.slice(6) : body) as {
      result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>; content: Array<{ text: string }> };
    };
  }

  test("listing tools expose and apply the certainty filter", async () => {
    const listed = (await rpc("tools/list", {})).result.tools;
    for (const name of ["list_rounds", "search_rounds", "list_trending"]) {
      expect(listed.find((tool) => tool.name === name)?.inputSchema.properties.certainty).toMatchObject({
        enum: ["announced", "reported", "expected", "unconfirmed"],
      });
    }
    const result = await rpc("tools/call", { name: "list_rounds", arguments: { certainty: "reported" } });
    const payload = JSON.parse(result.result.content[0].text) as { rounds: Array<{ company: string; certainty: string }> };
    expect(payload.rounds.map((row) => [row.company, row.certainty])).toEqual([["Beta", "reported"]]);
  });
});

describe("GET /feeds/{token}/{preset}.{rss|atom|json}", () => {
  test("token-gated feeds in three formats", async () => {
    const handle = await db();
    const token = await mintFeedToken(handle, "test", "series-a-b");
    const ctx = (file: string, t = token) => ({ params: Promise.resolve({ token: t, file }) });

    const rss = await feedsGet(new Request("http://app.test/feeds/x/y"), ctx("series-a-b.rss"));
    expect(rss.status).toBe(200);
    expect(rss.headers.get("content-type")).toContain("application/rss+xml");
    const xml = await rss.text();
    expect(xml).toContain("<item>");
    expect(xml).toContain('<guid isPermaLink="false">urn:fireround:round:alpha:series_a:2026-09-03</guid>');

    const atom = await feedsGet(new Request("http://app.test/feeds/x/y"), ctx("series-a-b.atom"));
    expect(atom.headers.get("content-type")).toContain("application/atom+xml");
    const json = await feedsGet(new Request("http://app.test/feeds/x/y"), ctx("series-a-b.json"));
    const feed = (await json.json()) as { items: Array<{ id: string }> };
    expect(feed.items.map((i) => i.id)).toContain("urn:fireround:round:beta:series_b:2026-09-02");

    expect((await feedsGet(new Request("http://app.test/feeds/x/y"), ctx("series-a-b.rss", "wrong"))).status).toBe(404);
    expect((await feedsGet(new Request("http://app.test/feeds/x/y"), ctx("series-a-b.txt"))).status).toBe(404);
  });
});

describe("feed item ids", () => {
  // Atom parses every entry id as a URL: a bare record id that starts with a digit or holds a space
  // once made the whole feed a blank 500 (P0-2, "50skills:other:2026-09-24").
  test("every format renders when record ids start with a digit or hold spaces and colons", async () => {
    const handle = await db();
    await persistRecords(
      handle,
      [
        record({ company_name: "50skills", id: "50skills:other:2026-09-04", stage: "other", announced_date: "2026-09-04" }),
        record({ company_name: "Prevision Medicine", id: "prevision medicine:series_a:2026-09-04", announced_date: "2026-09-04" }),
        record({
          company_name: "Odd",
          id: "odd: name:: here:series_a:2026-09-04",
          company_key: "odd name here",
          announced_date: "2026-09-04",
        }),
      ],
      "series-a-b",
      "run-routes-ids",
    );
    for (const id of ["50skills:other:2026-09-04", "prevision medicine:series_a:2026-09-04", "odd: name:: here:series_a:2026-09-04"])
      await corroborateRecord(handle, searched, id, { broad: true, maxPages: 0 });
    const token = await mintFeedToken(handle, "ids", "series-a-b");
    const ctx = (file: string) => ({ params: Promise.resolve({ token, file }) });
    const bodies: Record<string, string> = {};
    for (const format of ["rss", "atom", "json"]) {
      const res = await feedsGet(new Request("http://app.test/feeds/x/y"), ctx(`series-a-b.${format}`));
      expect(res.status).toBe(200);
      bodies[format] = await res.text();
    }
    expect(bodies.atom).toContain("<id>urn:fireround:round:50skills:other:2026-09-04</id>");
    expect(bodies.atom).toContain("<id>urn:fireround:round:prevision%20medicine:series_a:2026-09-04</id>");
    expect(bodies.rss).toContain('<guid isPermaLink="false">urn:fireround:round:50skills:other:2026-09-04</guid>');
    const ids = (JSON.parse(bodies.json) as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(ids).toContain("urn:fireround:round:prevision%20medicine:series_a:2026-09-04");
    for (const id of ids) expect(() => new URL(id)).not.toThrow();
  });

  test("a title and a description carry the figure without the page's aside, and no stray space", async () => {
    const handle = await db();
    await persistRecords(
      handle,
      [
        record({
          company_name: "Asideco",
          stage: "other",
          stage_as_written: "financing",
          announced_date: "2026-09-05",
          lead_investors: [],
          amount: {
            value: 125,
            currency: "USD",
            as_written: "$125m (up from $100m)",
            usd_millions: 125,
            fx_rate: 1,
            fx_date: "2026-09-05",
          },
        }),
      ],
      "series-a-b",
      "run-routes-aside",
    );
    await corroborateRecord(handle, searched, "asideco:other:2026-09-05", { broad: true, maxPages: 0 });
    const token = await mintFeedToken(handle, "aside", "series-a-b");
    const res = await feedsGet(new Request("http://app.test/feeds/x/y"), { params: Promise.resolve({ token, file: "series-a-b.json" }) });
    const item = ((await res.json()) as { items: Array<{ title: string; content_html: string }> }).items.find((i) =>
      i.title.startsWith("Asideco"),
    );
    expect(item?.title).toBe("Asideco raises $125m");
    expect(item?.content_html).toContain("Asideco raised $125m.");
    expect(item?.content_html).not.toContain("up from");
    // One count with the feed's row: the sources listed, verified against all of them here.
    expect(item?.content_html).toContain("Verified against 1 source:");
  });

  test("feedItemId is a valid URL for any record id", () => {
    for (const id of ["50skills:other:2026-09-24", "a b:seed:2026-01-01", "x::y", "%weird#id?", "日本:seed:2026-01-01"]) {
      const urn = feedItemId(id);
      expect(urn.startsWith("urn:fireround:round:")).toBe(true);
      expect(() => new URL(urn)).not.toThrow();
    }
    expect(feedItemId("alpha:series_a:2026-09-03")).toBe("urn:fireround:round:alpha:series_a:2026-09-03");
  });
});

describe("POST /api/webhooks/firecrawl", () => {
  const body = JSON.stringify({
    success: true,
    type: "monitor.check.completed",
    id: "evt-1",
    data: [{ monitorId: "m", checkId: "c", status: "completed" }],
  });

  test("rejects a bad signature when a secret is set, accepts a good one, ignores non-page events, dedupes by id", async () => {
    process.env.FIRECRAWL_WEBHOOK_SECRET = "topsecret";
    const bad = await webhookPost(
      new Request("http://app.test/api/webhooks/firecrawl", { method: "POST", body, headers: { "x-firecrawl-signature": "sha256=00" } }),
    );
    expect(bad.status).toBe(401);

    const good = await webhookPost(
      new Request("http://app.test/api/webhooks/firecrawl", {
        method: "POST",
        body,
        headers: { "x-firecrawl-signature": signForTests(body, "topsecret") },
      }),
    );
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ok: true, ignored: "monitor.check.completed" });

    const dup = await webhookPost(
      new Request("http://app.test/api/webhooks/firecrawl", {
        method: "POST",
        body,
        headers: { "x-firecrawl-signature": signForTests(body, "topsecret") },
      }),
    );
    expect(await dup.json()).toEqual({ ok: true, duplicate: true });
    delete process.env.FIRECRAWL_WEBHOOK_SECRET;
  });

  test("requires the bearer token when configured", async () => {
    process.env.WEBHOOK_BEARER_TOKEN = "bearer-1";
    const other = JSON.stringify({ success: true, type: "monitor.check.completed", id: "evt-2", data: [] });
    const noAuth = await webhookPost(new Request("http://app.test/api/webhooks/firecrawl", { method: "POST", body: other }));
    expect(noAuth.status).toBe(401);
    const ok = await webhookPost(
      new Request("http://app.test/api/webhooks/firecrawl", { method: "POST", body: other, headers: { authorization: "Bearer bearer-1" } }),
    );
    expect(ok.status).toBe(200);
    delete process.env.WEBHOOK_BEARER_TOKEN;
  });
});
