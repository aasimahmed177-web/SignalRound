// The company, investor and news reads of the public API: companies by search and filter, one
// company's funding, who led what, an investor's profile, the most active leads in a window and
// sector, and the latest articles behind the feed's rounds. Every
// payload is the public shape: no round ids (a few carry internal suffixes), no operator detail.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { GET as companyGet } from "../app/api/v1/companies/[id]/route";
import { GET as companiesGet, OPTIONS as companiesOptions } from "../app/api/v1/companies/route";
import { GET as profileGet } from "../app/api/v1/investors/[id]/route";
import { GET as investorsGet, OPTIONS as investorsOptions } from "../app/api/v1/investors/route";
import { GET as topGet } from "../app/api/v1/investors/top/route";
import { GET as newsGet } from "../app/api/v1/news/route";
import { GET as openapiGet } from "../app/api/v1/openapi.json/route";
import { db } from "../lib/db";
import { persistRecords, setDisposition } from "../lib/persist";
import { bareSite } from "../lib/public-api";
import { internalFields } from "../lib/public-view";
import { record } from "./helpers";
import { isoDaysAgo } from "./history-fixtures";

const usd = (m: number, day: string) => ({ value: m, currency: "USD", as_written: `$${m}M`, usd_millions: m, fx_rate: 1, fx_date: day });
const ROUNDUP = "https://news.example/weekly-funding-roundup";

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
      certainty?: "expected";
      disposition?: "review";
      history?: boolean;
      stage?: "seed" | "series_b";
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
    const id = summary.persistedIds[0] as string;
    await setDisposition(handle, id, o.disposition ?? "publish");
    if (o.certainty) await handle.update(schema.fundingRounds).set({ certainty: o.certainty }).where(eq(schema.fundingRounds.id, id));
    if (o.history) await handle.update(schema.fundingRounds).set({ history: true }).where(eq(schema.fundingRounds.id, id));
    return id;
  };
  await add("Alpha", { daysAgo: 2, usd: 20, sector: "ai", leads: ["Fund One", "Fund Two"], urls: ["https://news.example/alpha", ROUNDUP] });
  await add("Beta", {
    daysAgo: 3,
    usd: 10,
    sector: "ai",
    leads: ["Fund One"],
    urls: ["https://wire.example/beta", ROUNDUP, "https://www.sec.gov/beta-form-d"],
  });
  await add("Gamma", { daysAgo: 40, usd: 50, sector: "fintech", leads: ["Fund Two"], urls: ["https://news.example/gamma"] });
  await add("Delta", {
    daysAgo: 1,
    usd: 900,
    sector: "ai",
    leads: ["Fund Three"],
    urls: ["https://news.example/delta"],
    certainty: "expected",
  });
  await add("Echo", { daysAgo: 1, usd: 700, sector: "ai", leads: ["Fund Three"], urls: ["https://news.example/echo"], history: true });
  await add("Hidden", {
    daysAgo: 1,
    usd: 500,
    sector: "ai",
    leads: ["Fund Four"],
    urls: ["https://news.example/hidden"],
    disposition: "review",
  });
  // Zeta: a London healthtech company with a closed seed long ago, on its own page, and a round still being raised.
  await add("Zeta", {
    daysAgo: 120,
    usd: 40,
    sector: "healthtech",
    leads: ["Fund Six"],
    urls: ["https://zeta.example/blog/seed", "https://news.example/zeta-seed"],
    stage: "seed",
    hq: "London, UK",
  });
  await add("Zeta", {
    daysAgo: 2,
    usd: 300,
    sector: "healthtech",
    leads: ["Fund Seven"],
    urls: ["https://news.example/zeta-series-b"],
    stage: "series_b",
    hq: "London, UK",
    certainty: "expected",
  });
  await handle
    .insert(schema.companyAliases)
    .values({ companyId: "zeta.example", kind: "name", aliasKey: "zeta-health", alias: "Zeta Health" });
});

const company = async (id: string) => {
  const res = await companyGet(new Request(`http://app.test/api/v1/companies/${id}`), { params: Promise.resolve({ id }) } as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const get = async (handler: (r: Request) => Promise<Response>, path: string) => {
  const res = await handler(new Request(`http://app.test${path}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { data: Array<Record<string, unknown>> } };
};

describe("/api/v1/companies and /api/v1/companies/{id}", () => {
  test("lists companies newest raise first, and searches, filters, and sorts them", async () => {
    const { status, body } = await get(companiesGet, "/api/v1/companies");
    expect(status).toBe(200);
    const ids = body.data.map((r) => r.id);
    expect(ids).not.toContain("hidden.example");
    expect(ids.slice(0, 2).sort()).toEqual(["delta.example", "echo.example"]);
    expect(body.data.find((r) => r.id === "zeta.example")).toMatchObject({
      name: "Zeta",
      headquarters: "London, UK",
      rounds_total: 2,
      total_raised_usd_millions: 40,
      url: expect.stringMatching(/\/companies\/zeta\.example$/),
      latest_round: { stage: "series_b" },
    });
    expect((await get(companiesGet, "/api/v1/companies?q=london")).body.data.map((r) => r.id)).toEqual(["zeta.example"]);
    expect((await get(companiesGet, "/api/v1/companies?sector=fintech")).body.data.map((r) => r.id)).toEqual(["gamma.example"]);
    for (const sector of ["Fin%20Tech", "FINTECH", "fin-tech"])
      expect((await get(companiesGet, `/api/v1/companies?sector=${sector}`)).body.data.map((r) => r.id)).toEqual(["gamma.example"]);
    expect((await get(companiesGet, `/api/v1/companies?since=${isoDaysAgo(10)}&stage=Series%20A`)).body.data).toHaveLength(4);
    expect((await get(companiesGet, "/api/v1/companies?since=10d&stage=series_a")).body.data).toHaveLength(4);
    const recent = await get(companiesGet, `/api/v1/companies?since=${isoDaysAgo(10)}&stage=series_a`);
    expect(recent.body.data.map((r) => r.id).sort()).toEqual(["alpha.example", "beta.example", "delta.example", "echo.example"]);
    expect((await get(companiesGet, `/api/v1/companies?since=${isoDaysAgo(10)}&stage=seed`)).body.data).toEqual([]);
    const raised = await get(companiesGet, "/api/v1/companies?sort=raised&limit=2");
    expect(raised.body.data.map((r) => r.id)).toEqual(["echo.example", "gamma.example"]);
    expect(raised.body.next_page).toBe(2);
    for (const bad of ["sector=robots-and-more", "since=last-week", "sort=hot", "stage=series_z", "page=0"]) {
      expect((await get(companiesGet, `/api/v1/companies?${bad}`)).status).toBe(400);
    }
  });

  test("a sector group matches every sector under it, and a narrower sector only itself", async () => {
    const handle = await db();
    await handle.update(schema.companies).set({ sector: "ai infrastructure" }).where(eq(schema.companies.id, "beta.example"));
    try {
      const ids = async (path: string) => (await get(companiesGet, path)).body.data.map((r) => r.id).sort();
      expect(await ids("/api/v1/companies?sector=ai")).toEqual(["alpha.example", "beta.example", "delta.example", "echo.example"]);
      expect(await ids("/api/v1/companies?sector=ai-infra")).toEqual(["beta.example"]);
      expect(await ids("/api/v1/companies?sector=healthcare")).toEqual(["zeta.example"]);
      expect(await ids("/api/v1/companies?sector=health")).toEqual(["zeta.example"]);
      expect(await ids("/api/v1/companies?sector=biotech")).toEqual([]);
      const news = await get(newsGet, "/api/v1/news?sector=ai");
      expect(news.body.data.map((a) => a.url)).toContain("https://wire.example/beta");
    } finally {
      await handle.update(schema.companies).set({ sector: "ai" }).where(eq(schema.companies.id, "beta.example"));
    }
  });

  test("a profile counts closed rounds only, lists rounds newest first with leads and the announcement, and investors leads first", async () => {
    const { status, body } = await company("zeta.example");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: "zeta.example",
      name: "Zeta",
      sector: "healthtech",
      headquarters: "London, UK",
      total_raised_usd_millions: 40,
    });
    const rounds = body.rounds as Array<Record<string, unknown>>;
    expect(rounds.map((r) => [r.stage, r.certainty, r.lead_investors])).toEqual([
      ["series_b", "expected", ["Fund Seven"]],
      ["seed", "announced", ["Fund Six"]],
    ]);
    expect(rounds[1]?.primary_source).toBe("https://zeta.example/blog/seed");
    expect(body.latest_round).toEqual(rounds[0]);
    expect((body.investors as Array<Record<string, unknown>>).map((i) => [i.id, i.rounds_led])).toEqual([
      ["fund-seven", 1],
      ["fund-six", 1],
    ]);
    // A name it is known by reads the same profile, as its page redirects it.
    expect((await company("zeta-health")).body.id).toBe("zeta.example");
    // A URL of its site reads the same profile, as /api/v1/rounds?company= reads it.
    for (const url of ["https://www.zeta.example/", "http://zeta.example/blog/seed?ref=x", "www.zeta.example"])
      expect((await company(encodeURIComponent(url))).body.id, url).toBe("zeta.example");
    expect((await company("nobody.example")).status).toBe(404);
    // A typo is still a 404, naming the company it was probably meant to be, in the message too.
    const typo = await company("zetta");
    expect(typo.status).toBe(404);
    expect(typo.body.did_you_mean).toEqual([{ id: "zeta.example", name: "Zeta" }]);
    expect(typo.body.error).toMatch(/Did you mean Zeta \(id zeta\.example\)\?$/);
    expect((await company("nobody.example")).body.did_you_mean).toEqual([]);
    expect((await company("hidden.example")).status).toBe(404);
  });
});

describe("/api/v1/investors/top", () => {
  test("ranks the leads of closed, current rounds in the window and sector, splitting co-led amounts", async () => {
    const { status, body } = await get(topGet, "/api/v1/investors/top?window=30d&sector=Artificial%20Intelligence");
    expect(status).toBe(200);
    expect(body.data.map((r) => [r.id, r.rounds_led, r.lead_share_usd_millions])).toEqual([
      ["fund-one", 2, 20],
      ["fund-two", 1, 10],
    ]);
    expect((body.data[0]?.led_rounds as Array<Record<string, unknown>> | undefined)?.map((r) => r.company)).toEqual(["Alpha", "Beta"]);
    // Over 90 days Gamma's $50M counts too, and Fund Two leads two rounds with more money led.
    const wide = await get(topGet, "/api/v1/investors/top?window=90d");
    expect(wide.body.data.map((r) => r.id)).toEqual(["fund-two", "fund-one"]);
    expect(JSON.stringify(wide.body)).not.toMatch(/Fund Three|Fund Four/);
  });

  test("reads week, month and quarter as its windows", async () => {
    const ids = async (window: string) => (await get(topGet, `/api/v1/investors/top?window=${window}`)).body.data.map((r) => r.id);
    expect(await ids("quarter")).toEqual(await ids("90d"));
    expect(await ids("Month")).toEqual(await ids("30d"));
    expect((await get(topGet, "/api/v1/investors/top?window=week")).body.window).toBe("7d");
  });

  test("refuses a window or sector it does not know", async () => {
    expect((await get(topGet, "/api/v1/investors/top?window=1y")).status).toBe(400);
    expect((await get(topGet, "/api/v1/investors/top?sector=robots-and-more")).status).toBe(400);
  });
});

describe("/api/v1/investors and /api/v1/investors/{id}", () => {
  test("searches investors by name, with slug ids and their seats", async () => {
    const { body } = await get(investorsGet, "/api/v1/investors?q=fund&sort=led");
    expect(body.data.map((r) => r.id)).toEqual(expect.arrayContaining(["fund-one", "fund-two"]));
    expect(body.data.map((r) => r.id)).not.toContain("fund-four");
    const one = body.data.find((r) => r.id === "fund-one");
    expect(one).toMatchObject({ name: "Fund One", rounds_led: 2, url: expect.stringMatching(/\/investors\/fund-one$/) });
    expect(body.did_you_mean).toBeUndefined();
    const typo = await get(investorsGet, "/api/v1/investors?q=fund%20sevn");
    expect(typo.body).toMatchObject({ data: [], total: 0, did_you_mean: [{ id: "fund-seven", name: "Fund Seven" }] });
    const missed = await get(companiesGet, "/api/v1/companies?q=gammma");
    expect(missed.body).toMatchObject({ data: [], total: 0, did_you_mean: [{ id: "gamma.example", name: "Gamma" }] });
  });

  test("a profile lists the investor's rounds, totals, and co-investors; an unknown id is a 404", async () => {
    const res = await profileGet(new Request("http://app.test/api/v1/investors/fund-one"), {
      params: Promise.resolve({ id: "fund-one" }),
    } as never);
    const profile = (await res.json()) as Record<string, unknown> & { recent_rounds: Array<Record<string, unknown>> };
    expect(res.status).toBe(200);
    expect(profile).toMatchObject({ id: "fund-one", name: "Fund One", totals: { rounds_led: 2 } });
    expect(profile.recent_rounds.map((r) => [r.company, r.role])).toEqual([
      ["Alpha", "lead"],
      ["Beta", "lead"],
    ]);
    const missing = await profileGet(new Request("http://app.test/api/v1/investors/nobody"), {
      params: Promise.resolve({ id: "nobody" }),
    } as never);
    expect(missing.status).toBe(404);
    const byName = async (id: string) => {
      const r = await profileGet(new Request(`http://app.test/api/v1/investors/${encodeURIComponent(id)}`), {
        params: Promise.resolve({ id: encodeURIComponent(id) }),
      } as never);
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    // Its name as written finds it too, legal and generic tails and all.
    for (const name of ["Fund One", "FUND ONE", "Fund One Capital"]) expect((await byName(name)).body.id).toBe("fund-one");
    // So does its site, bare or as a URL.
    await (await db()).update(schema.investors).set({ domain: "fundone.example" }).where(eq(schema.investors.id, "fund one"));
    for (const site of ["fundone.example", "https://www.fundone.example/portfolio"])
      expect((await byName(site)).body.id, site).toBe("fund-one");
    const typo = await byName("Fund Sevenn");
    expect(typo.status).toBe(404);
    expect(typo.body.did_you_mean).toEqual([{ id: "fund-seven", name: "Fund Seven" }]);
  });
});

describe("/api/v1/news", () => {
  test("the newest articles behind the feed's current rounds, each with its rounds; filings, roundups, and hidden rounds left out", async () => {
    const { body } = await get(newsGet, "/api/v1/news?limit=10");
    const urls = body.data.map((a) => a.url);
    // A weekly roundup is a source on Alpha's and Beta's rounds, not an article about either company.
    expect(urls).not.toContain(ROUNDUP);
    expect(urls).toEqual(expect.arrayContaining(["https://news.example/alpha", "https://wire.example/beta"]));
    expect(urls).not.toContain("https://www.sec.gov/beta-form-d");
    for (const hidden of ["echo", "hidden"]) expect(urls).not.toContain(`https://news.example/${hidden}`);
    // A round still being raised is news, and says so.
    const delta = body.data.find((a) => a.url === "https://news.example/delta") as { rounds: Array<Record<string, unknown>> };
    expect(delta.rounds[0]).toMatchObject({ company: "Delta", certainty: "expected" });
    const alpha = body.data.find((a) => a.url === "https://news.example/alpha");
    expect(alpha).toMatchObject({ publisher: "news.example", excerpt: "Alpha raised $20M led by Fund One and Fund Two." });
  });

  test("pages with a cursor, narrows by sector and since, and refuses a bad cursor", async () => {
    const first = await get(newsGet, "/api/v1/news?limit=1");
    expect(first.body.data).toHaveLength(1);
    const next = first.body.next_cursor as string;
    const second = await get(newsGet, `/api/v1/news?limit=1&cursor=${encodeURIComponent(next)}`);
    expect(second.body.data[0]?.url).not.toBe(first.body.data[0]?.url);
    const fintech = await get(newsGet, "/api/v1/news?sector=fintech");
    expect(fintech.body.data.map((a) => a.url)).toEqual(["https://news.example/gamma"]);
    const recent = await get(newsGet, `/api/v1/news?since=${isoDaysAgo(10)}`);
    expect(recent.body.data.map((a) => a.url)).not.toContain("https://news.example/gamma");
    expect((await get(newsGet, "/api/v1/news?since=10d")).body.data).toEqual(recent.body.data);
    expect((await get(newsGet, "/api/v1/news?cursor=nope")).status).toBe(400);
  });
});

test("no payload carries a round id or operator detail, and the preflight answers", async () => {
  for (const [handler, path] of [
    [companiesGet, "/api/v1/companies"],
    [topGet, "/api/v1/investors/top?window=90d"],
    [investorsGet, "/api/v1/investors"],
    [newsGet, "/api/v1/news"],
  ] as const) {
    const { body } = await get(handler, path);
    expect(internalFields(body)).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/:series_a:|:identity:|"hold"|"pinned"|"disposition"/);
  }
  const { body } = await company("zeta.example");
  expect(internalFields(body)).toEqual([]);
  expect(JSON.stringify(body)).not.toMatch(/:seed:|:series_b:|:identity:|round_id|"hold"|"pinned"|"disposition"|"verification"|"sources"/);
  expect(investorsOptions().status).toBe(204);
  expect(companiesOptions().status).toBe(204);
});

test("each read's fields are the ones the OpenAPI spec documents", async () => {
  type Schema = { properties?: Record<string, Schema>; items?: Schema; allOf?: Schema[] };
  const spec = (await openapiGet(new Request("http://app.test/api/v1/openapi.json")).json()) as {
    paths: Record<string, { get: { responses: { "200": { content: { "application/json": { schema: Schema } } } } } }>;
  };
  const schemaOf = (path: string) => spec.paths[path]?.get.responses["200"].content["application/json"].schema as Schema;
  const keysOf = (s: Schema | undefined): string[] => [...Object.keys(s?.properties ?? {}), ...(s?.allOf ?? []).flatMap(keysOf)];
  const undocumented = (value: unknown, schema: Schema | undefined, path: string): string[] => {
    if (Array.isArray(value)) return value.flatMap((v, i) => undocumented(v, schema?.items, `${path}[${i}]`));
    if (!value || typeof value !== "object") return [];
    const known = keysOf(schema);
    const merged: Record<string, Schema> = Object.assign({}, schema?.properties, ...(schema?.allOf ?? []).map((a) => a.properties));
    return Object.entries(value).flatMap(([k, v]) => (known.includes(k) ? undocumented(v, merged[k], `${path}.${k}`) : [`${path}.${k}`]));
  };
  for (const [handler, path, specPath] of [
    [companiesGet, "/api/v1/companies", "/api/v1/companies"],
    [topGet, "/api/v1/investors/top?window=90d", "/api/v1/investors/top"],
    [investorsGet, "/api/v1/investors", "/api/v1/investors"],
    [newsGet, "/api/v1/news", "/api/v1/news"],
  ] as const) {
    const { body } = await get(handler, path);
    expect(undocumented(body, schemaOf(specPath), "$")).toEqual([]);
  }
  const profile = await (
    await profileGet(new Request("http://app.test/api/v1/investors/fund-one"), { params: Promise.resolve({ id: "fund-one" }) } as never)
  ).json();
  expect(undocumented(profile, schemaOf("/api/v1/investors/{id}"), "$")).toEqual([]);
  expect(undocumented((await company("zeta.example")).body, schemaOf("/api/v1/companies/{id}"), "$")).toEqual([]);
});

test("a site as people paste it reads as its bare host; an id or a name passes through", () => {
  for (const [raw, host] of [
    ["https://www.firecrawl.dev/", "firecrawl.dev"],
    ["http://Ramp.com/careers?x=1", "ramp.com"],
    ["www.supabase.com", "supabase.com"],
    ["supabase.com/pricing", "supabase.com"],
    ["supabase.com", "supabase.com"],
    ["zeta-health", "zeta-health"],
    ["Andreessen Horowitz", "Andreessen Horowitz"],
    ["sequoia", "sequoia"],
  ])
    expect(bareSite(raw), raw).toBe(host);
});
