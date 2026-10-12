// PUBLIC_DEMO: the two viewer tiers, the proxy's split of open and admin paths, the public
// feeds, and the nav a visitor sees.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import type { Firecrawl } from "firecrawl";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { POST as mcpPost } from "../app/api/mcp/route";
import { GET as feedsGet } from "../app/feeds/[token]/[file]/route";
import { isAdminPath, viewerFrom } from "../lib/access";
import { corroborateRecord } from "../lib/corroborate";
import { BASIC_CHALLENGE } from "../lib/dashboard-auth";
import { requireDashboardWith, requireVisitorOrDashboardWith } from "../lib/dashboard-auth.server";
import { db } from "../lib/db";
import { NAV_DISPLAY, visibleNav } from "../lib/nav";
import { persistRecords } from "../lib/persist";
import { mintFeedToken } from "../lib/settings";
import { gate } from "../proxy";
import { record } from "./helpers";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const feedCtx = (token: string, file: string) => ({ params: Promise.resolve({ token, file }) });
const passed = (res: Response) => res.headers.get("x-middleware-next") === "1";

beforeAll(async () => {
  const handle = await db();
  await persistRecords(handle, [record({ company_name: "Demo Alpha", company_key: "demo-alpha" })], "series-a-b", "run-demo-1");
  await persistRecords(
    handle,
    [record({ company_name: "Demo Beta", company_key: "demo-beta", stage: "seed", stage_as_written: "Seed" })],
    "seed",
    "run-demo-2",
  );
  const searched = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
  for (const id of ["demo-alpha:series_a:2026-09-02", "demo-beta:seed:2026-09-02"])
    await corroborateRecord(handle, searched, id, { broad: true, maxPages: 0 });
  // A company whose only round stays in review: a visitor never reads it, on the web or over MCP.
  await persistRecords(
    handle,
    [record({ company_name: "Demo Gamma", company_key: "demo-gamma", confidence: 0.3 })],
    "series-a-b",
    "run-demo-3",
    { startIn: "review" },
  );
});

/** One JSON-RPC call to the MCP route, the reply read out of its event stream. */
async function mcp(method: string, params: Record<string, unknown> = {}): Promise<{ result: Record<string, unknown> }> {
  const res = await mcpPost(
    new Request("http://app.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const body = await res.text();
  const data = body.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : body);
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.DASHBOARD_PASSWORD;
  delete process.env.PUBLIC_DEMO;
});

describe("viewerFrom", () => {
  test("demo on: admin only when a password is configured and the header carries it", () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    expect(viewerFrom(null)).toEqual({ demo: true, admin: false });

    process.env.DASHBOARD_PASSWORD = "secret";
    expect(viewerFrom(`Basic ${b64("u:secret")}`)).toEqual({ demo: true, admin: true });
    expect(viewerFrom(`Basic ${b64("u:wrong")}`)).toEqual({ demo: true, admin: false });
    expect(viewerFrom(null)).toEqual({ demo: true, admin: false });
  });

  test("demo off: the flag stays false whatever the header", () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    expect(viewerFrom(`Basic ${b64("u:secret")}`)).toEqual({ demo: false, admin: true });
    expect(viewerFrom(null)).toEqual({ demo: false, admin: false });
  });
});

describe("isAdminPath", () => {
  test("the three admin sections and anything under them", () => {
    for (const p of ["/review", "/presets", "/settings", "/settings/feeds", "/presets/new"]) expect(isAdminPath(p), p).toBe(true);
    for (const p of ["/", "/overview", "/feed", "/news", "/runs", "/companies/x", "/api/v1/rounds", "/reviewed"]) {
      expect(isAdminPath(p), p).toBe(false);
    }
  });
});

describe("proxy in demo mode", () => {
  test("public paths pass, admin paths keep the challenge, / serves the feed", () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    process.env.DASHBOARD_PASSWORD = "secret";

    for (const path of ["/overview", "/feed", "/news", "/runs", "/companies/acme", "/api/v1/rounds"]) {
      const res = gate(new NextRequest(`http://app.test${path}`));
      expect(passed(res), path).toBe(true);
      expect(res.headers.get("www-authenticate"), path).toBeNull();
    }

    for (const path of ["/settings", "/review", "/presets"]) {
      const res = gate(new NextRequest(`http://app.test${path}`));
      expect(res.status, path).toBe(401);
      expect(res.headers.get("www-authenticate"), path).toBe(BASIC_CHALLENGE["www-authenticate"]);
    }

    const authed = gate(new NextRequest("http://app.test/settings", { headers: { authorization: `Basic ${b64("u:secret")}` } }));
    expect(passed(authed)).toBe(true);

    const home = gate(new NextRequest("http://app.test/"));
    expect(home.headers.get("x-middleware-rewrite")).toContain("/feed");
    // The filters live in the query string, so the rewrite keeps it: clicking Seed on `/` narrows the feed.
    const filtered = gate(new NextRequest("http://app.test/?stage=seed&q=acme"));
    expect(filtered.headers.get("x-middleware-rewrite")).toContain("/feed?stage=seed&q=acme");
  });

  test("demo with no password has no admin tier: admin paths 404, never a challenge", () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    for (const path of ["/settings", "/review", "/presets", "/api/slack/install"]) {
      const res = gate(new NextRequest(`http://app.test${path}`));
      expect(res.status, path).toBe(404);
      expect(res.headers.get("www-authenticate"), path).toBeNull();
    }
    expect(passed(gate(new NextRequest("http://app.test/feed")))).toBe(true);
  });

  test("demo off: the password gates /feed as before", () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    const res = gate(new NextRequest("http://app.test/feed"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(BASIC_CHALLENGE["www-authenticate"]);
  });
});

describe("requireDashboardWith", () => {
  test("a password-less demo refuses every admin action; a password-less private instance allows it", () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    expect(() => requireDashboardWith(null)).toThrow("read-only demo");
    expect(() => requireDashboardWith(`Basic ${b64("u:anything")}`)).toThrow("read-only demo");

    vi.stubEnv("PUBLIC_DEMO", "0");
    expect(() => requireDashboardWith(null)).not.toThrow();
  });
});

describe("requireVisitorOrDashboardWith", () => {
  test("demo passes without a header; outside demo the password still rules", () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    vi.stubEnv("PUBLIC_DEMO", "1");
    expect(() => requireVisitorOrDashboardWith(null)).not.toThrow();

    vi.stubEnv("PUBLIC_DEMO", "0");
    expect(() => requireVisitorOrDashboardWith(null)).toThrow("Unauthorized");
    expect(() => requireVisitorOrDashboardWith(`Basic ${b64("u:secret")}`)).not.toThrow();
  });
});

describe("MCP in demo mode", () => {
  const toolNames = async () => ((await mcp("tools/list")).result.tools as Array<{ name: string }>).map((t) => t.name);
  const companyRounds = async () => {
    const r = await mcp("tools/call", { name: "get_company", arguments: { company: "Demo Gamma" } });
    const [content] = r.result.content as Array<{ text: string }>;
    return (JSON.parse(content.text) as { rounds: unknown[] }).rounds.length;
  };

  test("a keyless demo drops mark_seen and reads only the feed's rows", async () => {
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
    ]);
    expect(await companyRounds()).toBe(0);
  });

  test("a private instance keeps the write and the review rows", async () => {
    expect(await toolNames()).toContain("mark_seen");
    expect(await companyRounds()).toBe(1);
  });
});

describe("feeds in demo mode", () => {
  test("the public token reads a preset feed, and 'all' mixes presets", async () => {
    vi.stubEnv("PUBLIC_DEMO", "1");

    const rss = await feedsGet(new Request("http://app.test/feeds/public/series-a-b.rss"), feedCtx("public", "series-a-b.rss"));
    expect(rss.status).toBe(200);
    expect(rss.headers.get("content-type")).toContain("application/rss+xml");
    expect(rss.headers.get("cache-control")).toBe("public, max-age=120, s-maxage=120, stale-while-revalidate=600");

    const res = await feedsGet(new Request("http://app.test/feeds/public/all.json"), feedCtx("public", "all.json"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { items: Array<{ title: string }> };
    const titles = json.items.map((i) => i.title).join("\n");
    // One seeded under series-a-b, one under seed: 'all' is the only slug that carries both.
    expect(titles).toContain("Demo Alpha");
    expect(titles).toContain("Demo Beta");
  });

  test("an item opens the company's page on Fireround and reads as a sentence, not machinery", async () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    const res = await feedsGet(new Request("http://app.test/feeds/public/all.json"), feedCtx("public", "all.json"));
    const json = (await res.json()) as { title: string; items: Array<{ url: string; content_html: string }> };
    expect(json.title).toBe("Fireround: All rounds");
    for (const item of json.items) {
      expect(item.url).toMatch(/^http:\/\/app\.test\/companies\//);
      expect(item.content_html).toContain("Open on Fireround");
      expect(item.content_html).not.toMatch(/Confidence|Status:/);
    }
  });

  test("outside demo 'public' is just an unknown token, and minted tokens still work in demo", async () => {
    vi.stubEnv("PUBLIC_DEMO", "0");
    expect((await feedsGet(new Request("http://app.test/feeds/public/series-a-b.rss"), feedCtx("public", "series-a-b.rss"))).status).toBe(
      404,
    );

    vi.stubEnv("PUBLIC_DEMO", "1");
    const token = await mintFeedToken(await db(), "demo", "series-a-b");
    const minted = await feedsGet(new Request("http://app.test/feeds/x/series-a-b.rss"), feedCtx(token, "series-a-b.rss"));
    expect(minted.status).toBe(200);
    // 'all' stays public-only even for a minted token.
    expect((await feedsGet(new Request("http://app.test/feeds/x/all.json"), feedCtx(token, "all.json"))).status).toBe(404);
  });
});

describe("visibleNav", () => {
  test("a demo visitor loses the admin sections and keeps Overview; a demo admin loses nothing", () => {
    const hrefs = (demo: boolean, admin: boolean) => visibleNav({ demo, admin }).map((n) => n.href);
    expect(hrefs(true, false)).toEqual(["/overview", "/feed", "/companies", "/investors", "/news", "/runs"]);
    expect(hrefs(true, true)).toEqual(NAV_DISPLAY.map((n) => n.href));
    expect(hrefs(false, false)).toEqual(NAV_DISPLAY.map((n) => n.href));
  });
});
