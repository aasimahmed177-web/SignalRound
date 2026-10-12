// The MCP tools for the company, investor, and news reads answer with what /api/v1 answers for the same
// inputs: the same rows, the same JSON, the same refusals, and on a miss the same near names. A
// trusted caller on a private instance reads the published rows only, as the API's readers do.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { schema } from "@fireround/core/db";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { POST as mcpPost } from "../app/api/mcp/route";
import { GET as companyGet } from "../app/api/v1/companies/[id]/route";
import { GET as companiesGet } from "../app/api/v1/companies/route";
import { GET as investorGet } from "../app/api/v1/investors/[id]/route";
import { GET as investorsGet } from "../app/api/v1/investors/route";
import { GET as topGet } from "../app/api/v1/investors/top/route";
import { GET as newsGet } from "../app/api/v1/news/route";
import { db } from "../lib/db";
import { persistRecords, setDisposition } from "../lib/persist";
import { internalFields } from "../lib/public-view";
import { record } from "./helpers";
import { isoDaysAgo } from "./history-fixtures";

const usd = (m: number, day: string) => ({ value: m, currency: "USD", as_written: `$${m}M`, usd_millions: m, fx_rate: 1, fx_date: day });
const ROUNDUP = "https://news.example/weekly-funding-roundup";
const READS = ["list_companies", "get_company_profile", "list_investors", "get_investor", "top_investors", "list_news"];

beforeAll(async () => {
  const handle = await db();
  const add = async (
    name: string,
    o: {
      daysAgo: number;
      usd: number;
      sector: string;
      leads: string[];
      urls: string[];
      stage?: "seed";
      disposition?: "review";
      hq?: string;
    },
  ) => {
    const day = isoDaysAgo(o.daysAgo);
    const r = record({
      company_name: name,
      company_key: name.toLowerCase(),
      company_domain: `${name.toLowerCase()}.example`,
      announced_date: day,
      ...(o.stage ? { stage: o.stage } : {}),
      headquarters: o.hq ?? null,
      sector: o.sector,
      amount: usd(o.usd, day),
      lead_investors: o.leads,
      other_investors: ["Angel Syndicate"],
      evidence_quotes: [`${name} raised $${o.usd}M led by ${o.leads.join(" and ")}.`],
      sources: o.urls.map((url) => ({ url, host: new URL(url).hostname, title: `${name} raises $${o.usd}M`, published: day })),
    });
    const summary = await persistRecords(handle, [r], "series-a-b", `run-${name}`);
    await setDisposition(handle, summary.persistedIds[0] as string, o.disposition ?? "publish");
  };
  await add("Alpha", { daysAgo: 2, usd: 20, sector: "ai", leads: ["Fund One", "Fund Two"], urls: ["https://news.example/alpha", ROUNDUP] });
  await add("Beta", { daysAgo: 3, usd: 10, sector: "ai", leads: ["Fund One"], urls: ["https://wire.example/beta", ROUNDUP] });
  await add("Gamma", { daysAgo: 40, usd: 50, sector: "fintech", leads: ["Fund Two"], urls: ["https://news.example/gamma"] });
  await add("Zeta", {
    daysAgo: 5,
    usd: 40,
    sector: "healthtech",
    leads: ["Fund Six"],
    urls: ["https://news.example/zeta-seed"],
    stage: "seed",
    hq: "London, UK",
  });
  await add("Hidden", {
    daysAgo: 1,
    usd: 500,
    sector: "ai",
    leads: ["Fund Four"],
    urls: ["https://news.example/hidden"],
    disposition: "review",
  });
  await handle
    .insert(schema.companyAliases)
    .values({ companyId: "zeta.example", kind: "name", aliasKey: "zeta-health", alias: "Zeta Health" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** One JSON-RPC call to the MCP route, the reply read out of its event stream. */
async function rpc(method: string, params: Record<string, unknown>) {
  const res = await mcpPost(
    new Request("http://app.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const body = await res.text();
  const data = body.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : body) as {
    result: {
      tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
      isError?: boolean;
      content: Array<{ text: string }>;
    };
  };
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const { result } = await rpc("tools/call", { name, arguments: args });
  return { isError: result.isError ?? false, text: result.content[0]?.text ?? "" };
}

const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse((await tool(name, args)).text) as unknown;

async function http(handler: (r: Request, ctx: never) => Promise<Response>, path: string, id?: string) {
  const res = await handler(new Request(`http://app.test${path}`), { params: Promise.resolve({ id }) } as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("tools/list names each read, marked read-only", async () => {
  const { tools } = (await rpc("tools/list", {})).result;
  for (const name of READS) expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint, name).toBe(true);
  expect(tools.map((t) => t.name)).toContain("get_company");
});

describe("each tool answers what its route answers", () => {
  test.each([
    ["list_companies", {}, companiesGet, "/api/v1/companies"],
    ["list_companies", { q: "london" }, companiesGet, "/api/v1/companies?q=london"],
    ["list_companies", { sector: "Fin Tech" }, companiesGet, "/api/v1/companies?sector=Fin%20Tech"],
    [
      "list_companies",
      { since: isoDaysAgo(10), stage: ["Series A"], sort: "raised", page: 1, limit: 1 },
      companiesGet,
      `/api/v1/companies?since=${isoDaysAgo(10)}&stage=Series%20A&sort=raised&page=1&limit=1`,
    ],
    ["list_companies", { q: "gammma" }, companiesGet, "/api/v1/companies?q=gammma"],
    ["list_investors", {}, investorsGet, "/api/v1/investors"],
    ["list_investors", { q: "fund", sort: "name", limit: 2, page: 2 }, investorsGet, "/api/v1/investors?q=fund&sort=name&limit=2&page=2"],
    ["list_investors", { q: "fund sevn" }, investorsGet, "/api/v1/investors?q=fund%20sevn"],
    ["top_investors", {}, topGet, "/api/v1/investors/top"],
    [
      "top_investors",
      { window: "90d", sector: "ai", stage: ["series_a"], limit: 1 },
      topGet,
      "/api/v1/investors/top?window=90d&sector=ai&stage=series_a&limit=1",
    ],
    ["list_news", {}, newsGet, "/api/v1/news"],
    ["list_news", { sector: "fintech" }, newsGet, "/api/v1/news?sector=fintech"],
    ["list_news", { q: "alpha", since: isoDaysAgo(10), limit: 1 }, newsGet, `/api/v1/news?q=alpha&since=${isoDaysAgo(10)}&limit=1`],
  ] as const)("%s %j", async (name, args, handler, path) => {
    const { status, body } = await http(handler, path);
    expect(status).toBe(200);
    expect(await call(name, args)).toEqual(body);
  });

  test("a news cursor from the tool pages the same as the route's", async () => {
    const first = (await call("list_news", { limit: 1 })) as { next_cursor: string };
    expect(first.next_cursor).toBeTruthy();
    const { body } = await http(newsGet, `/api/v1/news?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`);
    expect(await call("list_news", { limit: 1, cursor: first.next_cursor })).toEqual(body);
  });

  test("a company profile by id, domain alias, or name, and an investor by id or name", async () => {
    for (const id of ["zeta.example", "Zeta.Example", "zeta-health"]) {
      const { status, body } = await http(companyGet, `/api/v1/companies/${id}`, id);
      expect(status).toBe(200);
      expect(await call("get_company_profile", { id })).toEqual(body);
    }
    for (const id of ["fund-one", "Fund One"]) {
      const { status, body } = await http(investorGet, `/api/v1/investors/${encodeURIComponent(id)}`, encodeURIComponent(id));
      expect(status).toBe(200);
      expect(await call("get_investor", { id })).toEqual(body);
    }
  });
});

describe("misses and bad values", () => {
  test("a missed company or investor is an error with the route's near names", async () => {
    for (const [name, id, handler, near] of [
      ["get_company_profile", "zetta", companyGet, [{ id: "zeta.example", name: "Zeta" }]],
      ["get_investor", "Fund Sevenn", investorGet, []],
      ["get_investor", "fund-sixx", investorGet, [{ id: "fund-six", name: "Fund Six" }]],
      ["get_company_profile", "hidden.example", companyGet, []],
    ] as const) {
      const { status, body } = await http(handler, `/api/v1/x/${encodeURIComponent(id)}`, encodeURIComponent(id));
      expect(status).toBe(404);
      const r = await tool(name, { id });
      expect(r.isError, `${name} ${id}`).toBe(true);
      expect(JSON.parse(r.text)).toEqual(body);
      expect(body.did_you_mean).toEqual(near);
    }
    const typo = JSON.parse((await tool("get_company_profile", { id: "zetta" })).text) as { error: string };
    expect(typo.error).toMatch(/Did you mean Zeta \(id zeta\.example\)\?$/);
  });

  test("a value the route refuses is an error with the route's sentence", async () => {
    for (const [name, args, handler, path] of [
      ["list_companies", { sector: "robots-and-more" }, companiesGet, "/api/v1/companies?sector=robots-and-more"],
      ["list_companies", { since: "last-week" }, companiesGet, "/api/v1/companies?since=last-week"],
      ["list_companies", { stage: ["series_z"] }, companiesGet, "/api/v1/companies?stage=series_z"],
      ["top_investors", { sector: "robots-and-more" }, topGet, "/api/v1/investors/top?sector=robots-and-more"],
      ["list_news", { cursor: "nope" }, newsGet, "/api/v1/news?cursor=nope"],
      ["list_news", { since: "2026-02-30" }, newsGet, "/api/v1/news?since=2026-02-30"],
    ] as const) {
      const { status, body } = await http(handler, path);
      expect(status).toBe(400);
      const r = await tool(name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(r.text).toBe(body.error);
    }
    for (const [name, args] of [
      ["list_companies", { limit: 101 }],
      ["list_companies", { sort: "hot" }],
      ["list_investors", { sort: "hot" }],
      ["top_investors", { window: "1y" }],
      ["top_investors", { limit: 51 }],
      ["list_news", { limit: 101 }],
    ] as const) {
      expect((await tool(name, args)).isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
  });
});

describe("visibility", () => {
  const reads = [
    ["list_companies", {}],
    ["get_company_profile", { id: "alpha.example" }],
    ["list_investors", {}],
    ["get_investor", { id: "fund-one" }],
    ["top_investors", { window: "90d" }],
    ["list_news", {}],
  ] as const;

  test("a review row stays out for a trusted caller and a keyless demo visitor alike", async () => {
    for (const demo of [false, true]) {
      if (demo) vi.stubEnv("PUBLIC_DEMO", "1");
      for (const [name, args] of reads) {
        const out = JSON.stringify(await call(name, args));
        expect(out, `${name} demo=${demo}`).not.toMatch(/Hidden|hidden\.example|Fund Four/);
      }
      expect((await tool("get_company_profile", { id: "hidden.example" })).isError).toBe(true);
    }
  });

  test("no payload carries a round id or operator detail", async () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    for (const [name, args] of reads) {
      const out = await call(name, args);
      expect(internalFields(out), name).toEqual([]);
      expect(JSON.stringify(out), name).not.toMatch(/:series_a:|:seed:|:identity:|round_id|"hold"|"pinned"|"disposition"|"verification"/);
    }
  });
});
