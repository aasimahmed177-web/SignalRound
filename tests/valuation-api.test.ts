// A round's valuation on the public surfaces: the rounds API, a company's profile with
// its valuation history, the MCP tools, and the company page. Only a published, read-back-confirmed
// round that closed carries one; a flagged or unverified row never does, and a valuation is never
// counted as money raised.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { POST as mcpPost } from "../app/api/mcp/route";
import { GET as companyGet } from "../app/api/v1/companies/[id]/route";
import { GET as openapiGet } from "../app/api/v1/openapi.json/route";
import { GET as roundsGet } from "../app/api/v1/rounds/route";
import { db } from "../lib/db";
import { valuationLabel } from "../lib/format";
import { persistRecords, setDisposition } from "../lib/persist";
import { citableValuation, internalFields } from "../lib/public-view";
import { record } from "./helpers";

const usd = (m: number, day: string) => ({ value: m, currency: "USD", as_written: `$${m}M`, usd_millions: m, fx_rate: 1, fx_date: day });

const base = {
  valuation_as_written: "$1.2 billion",
  quotes: [],
  disposition: "publish" as const,
  certainty: "announced" as const,
  verification: { status: "confirmed" },
  amount: { value: 100, currency: "USD", usd_millions: 100 },
};

describe("citableValuation", () => {
  test("a published, confirmed, closed round carries its valuation in USD", () => {
    expect(citableValuation(base)).toEqual({ usd_millions: 1200, as_written: "$1.2 billion", basis: "unknown" });
    expect(citableValuation({ ...base, certainty: "reported", verification: { status: "corrected" } })?.usd_millions).toBe(1200);
  });

  test("a flagged, held, rejected, unverified, expected, or unconfirmed round carries none", () => {
    for (const disposition of ["flagged", "review", "rejected"] as const) expect(citableValuation({ ...base, disposition })).toBeNull();
    for (const status of ["unverified", "contradicted", "not_news", "skipped"]) {
      expect(citableValuation({ ...base, verification: { status } })).toBeNull();
    }
    expect(citableValuation({ ...base, verification: null })).toBeNull();
    for (const certainty of ["expected", "unconfirmed"] as const) expect(citableValuation({ ...base, certainty })).toBeNull();
    expect(citableValuation({ ...base, valuation_as_written: null })).toBeNull();
    expect(citableValuation({ ...base, valuation_as_written: "undisclosed" })).toBeNull();
  });

  test("the basis is post or pre only when the valuation or a sentence stating it says so", () => {
    expect(citableValuation({ ...base, valuation_as_written: "$190m pre-money" })?.basis).toBe("pre");
    const quoted = citableValuation({
      ...base,
      valuation_as_written: "around US$380 billion",
      quotes: [null, "We have raised $30 billion in Series G funding, valuing the company at $380 billion post-money."],
    });
    expect(quoted).toEqual({ usd_millions: 380_000, as_written: "around US$380 billion", basis: "post" });
    // A sentence that says post-money about another figure says nothing about this one.
    const other = citableValuation({ ...base, quotes: ["The company was valued at $500 million post-money in 2023."] });
    expect(other?.basis).toBe("unknown");
  });

  test("a valuation in the amount's currency converts at the round's own rate; another currency stays unconverted", () => {
    const eur = { value: 50, currency: "EUR", usd_millions: 55 };
    expect(citableValuation({ ...base, valuation_as_written: "€400 million", amount: eur })?.usd_millions).toBe(440);
    expect(citableValuation({ ...base, valuation_as_written: "CHF 30 million", amount: eur })).toEqual({
      usd_millions: null,
      as_written: "CHF 30 million",
      basis: "unknown",
    });
  });

  test("the page label keeps the source's words and adds the basis once", () => {
    expect(valuationLabel({ as_written: "$5.8 billion", basis: "post" })).toBe("$5.8 billion post-money");
    expect(valuationLabel({ as_written: "$5.8 billion post-money valuation", basis: "post" })).toBe("$5.8 billion post-money");
    expect(valuationLabel({ as_written: "$15 million valuation", basis: "unknown" })).toBe("$15 million");
  });
});

const ids: Record<string, string> = {};

beforeAll(async () => {
  const handle = await db();
  const add = async (
    key: string,
    o: {
      stage: "seed" | "series_a" | "series_b";
      day: string;
      amount: number;
      valuation: string;
      quote: string;
      disposition: "publish" | "flagged";
      status?: string;
    },
  ) => {
    const r = record({
      company_name: "Valco",
      company_key: "valco",
      company_domain: "valco.example",
      stage: o.stage,
      stage_as_written: { seed: "Seed", series_a: "Series A", series_b: "Series B" }[o.stage],
      announced_date: o.day,
      amount: usd(o.amount, o.day),
      evidence_quotes: [o.quote],
      sources: [
        { url: `https://news.example/valco-${o.stage}`, host: "news.example", title: `Valco raises $${o.amount}M`, published: o.day },
      ],
    });
    const summary = await persistRecords(handle, [r], "series-a-b", `run-valco-${o.stage}`);
    const id = summary.persistedIds[0] as string;
    await setDisposition(handle, id, o.disposition);
    await handle
      .update(schema.fundingRounds)
      .set({
        valuationAsWritten: o.valuation,
        valuationDisclosed: true,
        verification: { status: o.status ?? "confirmed", notes: [], url: `https://news.example/valco-${o.stage}` },
      })
      .where(eq(schema.fundingRounds.id, id));
    ids[key] = id;
  };
  await add("b", {
    stage: "series_b",
    day: "2026-09-01",
    amount: 100,
    valuation: "$1.2 billion",
    quote: "Valco raised $100M at a $1.2 billion post-money valuation.",
    disposition: "publish",
  });
  await add("a", {
    stage: "series_a",
    day: "2026-03-01",
    amount: 30,
    valuation: "$400 million",
    quote: "Valco raised $30M at a $400 million valuation.",
    disposition: "flagged",
  });
  await add("seed", {
    stage: "seed",
    day: "2025-06-01",
    amount: 5,
    valuation: "$25 million",
    quote: "Valco raised $5M at a $25 million valuation.",
    disposition: "publish",
    status: "unverified",
  });
});

type Json = Record<string, unknown>;

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A visitor on a public demo, or, with the password, its admin, who keeps the stored row. */
async function rounds(query: string, admin = false) {
  vi.stubEnv("PUBLIC_DEMO", "1");
  vi.stubEnv("DASHBOARD_PASSWORD", "secret");
  const headers = admin ? { authorization: `Basic ${Buffer.from("u:secret").toString("base64")}` } : undefined;
  return roundsGet(new Request(`http://app.test/api/v1/rounds?${query}`, { headers }));
}

describe("/api/v1/rounds", () => {
  test("an admin keeps the stored valuation text, but the citable valuation is the same for every caller", async () => {
    const body = (await (await rounds("company=valco.example", true)).json()) as { data: Json[] };
    const series = body.data.find((r) => r.stage === "series_a");
    expect(series?.valuation_as_written).toBe("$400 million");
    expect(series?.valuation).toBeNull();
  });

  test("each round carries valuation, null on a flagged or unverified one, and the older fields agree", async () => {
    const body = (await (await rounds("company=valco.example")).json()) as { data: Json[] };
    const byStage = Object.fromEntries(body.data.map((r) => [r.stage, r]));
    expect(byStage.series_b?.valuation).toEqual({ usd_millions: 1200, as_written: "$1.2 billion", basis: "post" });
    expect(byStage.series_b?.valuation_as_written).toBe("$1.2 billion");
    expect(byStage.series_b?.valuation_disclosed).toBe(true);
    expect(byStage.series_b?.amount).toMatchObject({ usd_millions: 100 });
    for (const stage of ["series_a", "seed"]) {
      expect(byStage[stage]?.valuation, stage).toBeNull();
      expect(byStage[stage]?.valuation_as_written, stage).toBeNull();
      expect(byStage[stage]?.valuation_disclosed, stage).toBeNull();
    }
    expect(internalFields(body)).toEqual([]);
  });
});

describe("/api/v1/companies/{id}", () => {
  test("each round carries its valuation, and valuation_history names the latest, apart from what it raised", async () => {
    const res = await companyGet(new Request("http://app.test/api/v1/companies/valco.example"), {
      params: Promise.resolve({ id: "valco.example" }),
    } as never);
    const body = (await res.json()) as Json & { rounds: Json[]; latest_round: Json };
    expect(res.status).toBe(200);
    expect(body.total_raised_usd_millions).toBe(135);
    expect(body.valuation_history).toEqual({
      latest: {
        usd_millions: 1200,
        as_written: "$1.2 billion",
        basis: "post",
        announced_on: "2026-09-01",
        stage: "series_b",
        stage_as_written: "Series B",
        certainty: "announced",
      },
      stated: [expect.objectContaining({ as_written: "$1.2 billion", announced_on: "2026-09-01" })],
    });
    expect(body.latest_round.valuation).toEqual({ usd_millions: 1200, as_written: "$1.2 billion", basis: "post" });
    expect(body.rounds.map((r) => r.valuation === null)).toEqual([false, true, true]);
    expect(internalFields(body)).toEqual([]);
  });
});

describe("MCP", () => {
  async function call(name: string, args: Json) {
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
    return JSON.parse(reply.result.content[0]?.text ?? "null") as Json;
  }

  test("the compact round carries the valuation's figure, USD, and basis only where it is citable", async () => {
    const { rounds: listed } = (await call("get_company", { company: "valco.example" })) as { rounds: Json[] };
    const byStage = Object.fromEntries(listed.map((r) => [r.stage, r]));
    expect(byStage.series_b).toMatchObject({
      valuation: "$1.2 billion",
      valuation_usd_millions: 1200,
      valuation_basis: "post",
      valuation_disclosed: true,
    });
    for (const stage of ["series_a", "seed"]) {
      expect(byStage[stage], stage).toMatchObject({ valuation: null, valuation_usd_millions: null, valuation_basis: null });
    }
  });

  test("get_company_profile answers what the route answers, valuation history included", async () => {
    const profile = await call("get_company_profile", { id: "valco.example" });
    expect((profile.valuation_history as { latest: Json }).latest).toMatchObject({ usd_millions: 1200, basis: "post" });
  });
});

test("the OpenAPI document describes the valuation on rounds and the company profile", async () => {
  const spec = (await (await openapiGet(new Request("http://app.test/api/v1/openapi.json"))).json()) as {
    components: { schemas: { Round: { properties: Json }; Valuation: { properties: Json } } };
    paths: Record<string, { get: { responses: Record<string, { content: Record<string, { schema: { properties: Json } }> }> } }>;
  };
  expect(Object.keys(spec.components.schemas.Valuation.properties)).toEqual(["usd_millions", "as_written", "basis"]);
  expect(spec.components.schemas.Round.properties.valuation).toBeDefined();
  const profile = spec.paths["/api/v1/companies/{id}"]?.get.responses["200"]?.content["application/json"]?.schema.properties;
  expect(profile?.valuation_history).toBeDefined();
});
