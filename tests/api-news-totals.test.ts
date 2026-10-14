// What an agent reads about one company's coverage and its money: news listed once per article under
// any of its addresses, never untitled, filtered to one company's rounds (its earlier ones included), each
// round's sentence labelled as the round's evidence; and a profile that keeps the sum of its rounds but
// also shows the company's own stated total, flagging the rounds the record is missing.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { GET as companyGet } from "../app/api/v1/companies/[id]/route";
import { GET as newsGet } from "../app/api/v1/news/route";
import { db } from "../lib/db";
import { persistRecords, setDisposition } from "../lib/persist";
import { record } from "./helpers";
import { isoDaysAgo } from "./history-fixtures";

const usd = (m: number, day: string) => ({ value: m, currency: "USD", as_written: `$${m}M`, usd_millions: m, fx_rate: 1, fx_date: day });
const STAGE_NAMES = { seed: "Seed", series_a: "Series A", series_b: "Series B", series_c: "Series C" } as const;

beforeAll(async () => {
  const handle = await db();
  const add = async (
    name: string,
    domain: string,
    o: {
      daysAgo: number;
      usd: number;
      stage?: keyof typeof STAGE_NAMES;
      sources: Array<{ url: string; title: string | null }>;
      history?: boolean;
      total?: { as_written: string; quote: string };
    },
  ) => {
    const day = isoDaysAgo(o.daysAgo);
    const stage = o.stage ?? "series_a";
    const r = record({
      company_name: name,
      company_key: name.toLowerCase(),
      company_domain: domain,
      announced_date: day,
      stage,
      stage_as_written: STAGE_NAMES[stage],
      sector: "ai",
      amount: usd(o.usd, day),
      lead_investors: ["Fund One"],
      evidence_quotes: [`${name} raised $${o.usd}M led by Fund One.`],
      ...(o.total ? { financing_total_as_written: o.total.as_written, financing_total_quote: o.total.quote } : {}),
      sources: o.sources.map((s) => ({ url: s.url, host: new URL(s.url).hostname, title: s.title ?? undefined, published: day })),
    });
    const summary = await persistRecords(handle, [r], "series-a-b", `run-${name}-${o.daysAgo}`);
    const id = summary.persistedIds[0] as string;
    await setDisposition(handle, id, "publish");
    if (o.history) await handle.update(schema.fundingRounds).set({ history: true }).where(eq(schema.fundingRounds.id, id));
    return id;
  };
  // Wonder's rounds were all promoted from its checked dossier: history rows, as a company added on request has.
  await add("Wonder", "wonder.example", {
    daysAgo: 5,
    usd: 550,
    stage: "series_c",
    history: true,
    sources: [
      { url: "https://news.example/wonder-series-c", title: "Wonder raises $550M" },
      { url: "https://news.example/wonder-series-c/amp", title: "Wonder raises $550M" },
      { url: "https://amp.news.example/wonder-series-c?utm_source=feed", title: "Wonder raises $550M (AMP)" },
    ],
  });
  await add("Vinci Pharmaceuticals", "vincipharma.example", {
    daysAgo: 2,
    usd: 30,
    sources: [
      { url: "https://pharma.example/vinci-pharma", title: "Vinci Pharmaceuticals raises $30M" },
      { url: "https://vincipharma.example/press", title: null },
      { url: "https://vincipharma.example/about", title: "  " },
    ],
  });
  await add("Vinci", "getvinci.example", {
    daysAgo: 6,
    usd: 250,
    stage: "series_b",
    history: true,
    sources: [{ url: "https://news.example/vinci-series-b", title: "Hardware maker raises $250M Series B" }],
  });
  // Harmonic's record misses an earlier round: its Series B says $76M to date, the two rounds on record add to $67.5M.
  await add("Harmonic", "harmonic.example", {
    daysAgo: 700,
    usd: 17.5,
    sources: [{ url: "https://news.example/harmonic-a", title: "Harmonic raises $17.5M" }],
  });
  await add("Harmonic", "harmonic.example", {
    daysAgo: 3,
    usd: 50,
    stage: "series_b",
    total: {
      as_written: "$76 million",
      quote: "Harmonic has raised $50 million in a Series B financing round, bringing its total funding to $76 million.",
    },
    sources: [{ url: "https://harmonic.example/blog/series-b", title: "Harmonic raises $50M" }],
  });
  // Steady's stated total matches its rounds; Tally's total is one series' running total, not the company's.
  await add("Steady", "steady.example", {
    daysAgo: 400,
    usd: 6,
    stage: "seed",
    sources: [{ url: "https://news.example/steady-seed", title: "Steady seed" }],
  });
  await add("Steady", "steady.example", {
    daysAgo: 4,
    usd: 30,
    total: { as_written: "$36M", quote: "Steady just raised $30M, bringing our total funding to $36M." },
    sources: [{ url: "https://news.example/steady-a", title: "Steady raises $30M" }],
  });
  await add("Tally", "tally.example", {
    daysAgo: 4,
    usd: 12.5,
    total: { as_written: "$22.5 million", quote: "Tally today announced $22.5 million in total Series A funding." },
    sources: [{ url: "https://news.example/tally-a", title: "Tally raises $12.5M" }],
  });
});

const get = async (path: string) => {
  const res = await newsGet(new Request(`http://app.test${path}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { data: Array<Record<string, unknown>> } };
};

const profile = async (id: string) => {
  const res = await companyGet(new Request(`http://app.test/api/v1/companies/${id}`), { params: Promise.resolve({ id }) } as never);
  return (await res.json()) as Record<string, unknown>;
};

describe("/api/v1/news", () => {
  test("one article under its AMP and tracking addresses is listed once, as the page itself", async () => {
    const { body } = await get("/api/v1/news?company=wonder.example");
    expect(body.data.map((a) => a.url)).toEqual(["https://news.example/wonder-series-c"]);
    expect(body.data[0]).toMatchObject({ title: "Wonder raises $550M", publisher: "news.example" });
    expect(body.data[0]?.rounds).toHaveLength(1);
  });

  test("a page with no title, or only spaces, is never listed", async () => {
    const urls = (await get("/api/v1/news?limit=100")).body.data.map((a) => a.url);
    expect(urls).toContain("https://pharma.example/vinci-pharma");
    expect(urls).not.toContain("https://vincipharma.example/press");
    expect(urls).not.toContain("https://vincipharma.example/about");
  });

  test("company names one company by id, domain, URL, or earlier name, and counts its earlier rounds", async () => {
    for (const company of ["getvinci.example", "https://www.getvinci.example/", "GETVINCI.EXAMPLE"]) {
      const { status, body } = await get(`/api/v1/news?company=${encodeURIComponent(company)}`);
      expect(status, company).toBe(200);
      expect(
        body.data.map((a) => a.url),
        company,
      ).toEqual(["https://news.example/vinci-series-b"]);
    }
    const handle = await db();
    await handle
      .insert(schema.companyAliases)
      .values({ companyId: "getvinci.example", kind: "name", aliasKey: "vinci-robotics", alias: "Vinci Robotics" });
    expect((await get("/api/v1/news?company=vinci-robotics")).body.data.map((a) => a.url)).toEqual(["https://news.example/vinci-series-b"]);
    // The default list still leaves earlier rounds out.
    expect((await get("/api/v1/news?limit=100")).body.data.map((a) => a.url)).not.toContain("https://news.example/vinci-series-b");
  });

  test("company is read as the profile reads it: by name, a typo one edit away, and the profile's own 404", async () => {
    expect((await get("/api/v1/news?company=Vinci%20Pharmaceuticals")).body.data.map((a) => a.url)).toEqual([
      "https://pharma.example/vinci-pharma",
    ]);
    const typo = await get("/api/v1/news?company=harmonik");
    expect(typo.status).toBe(200);
    expect(typo.body).toMatchObject({ matched_from: "harmonik", note: expect.stringContaining("this is Harmonic") });
    expect(typo.body.data.map((a) => a.url).sort()).toEqual(["https://harmonic.example/blog/series-b", "https://news.example/harmonic-a"]);
    const miss = await get("/api/v1/news?company=harmonik.example");
    const profileMiss = await companyGet(new Request("http://app.test/api/v1/companies/harmonik.example"), {
      params: Promise.resolve({ id: "harmonik.example" }),
    } as never);
    expect(miss.status).toBe(404);
    expect(profileMiss.status).toBe(404);
    expect(miss.body).toEqual(await profileMiss.json());
    expect(miss.body.did_you_mean).toEqual([{ id: "harmonic.example", name: "Harmonic" }]);
  });

  test("a q that names a company exactly reads its rounds' coverage, earlier rounds included", async () => {
    // Wonder's Series C is a history row, so q=Wonder used to find nothing.
    expect((await get("/api/v1/news?q=Wonder")).body.data.map((a) => a.url)).toEqual(["https://news.example/wonder-series-c"]);
    // "Vinci" names Vinci exactly, so its coverage lists beside the headline matches for Vinci Pharmaceuticals.
    const vinci = (await get("/api/v1/news?q=Vinci")).body.data.map((a) => a.url);
    expect(vinci.sort()).toEqual(["https://news.example/vinci-series-b", "https://pharma.example/vinci-pharma"]);
    // A word that names no company exactly keeps to the feed's current rounds.
    expect((await get("/api/v1/news?q=Vin")).body.data.map((a) => a.url)).toEqual(["https://pharma.example/vinci-pharma"]);
  });

  test("the round's sentence is labelled as its evidence, never as the article's excerpt", async () => {
    const { body } = await get("/api/v1/news?company=vincipharma.example");
    expect(body.data[0]).toMatchObject({
      excerpt: null,
      rounds: [{ company: "Vinci Pharmaceuticals", evidence: "Vinci Pharmaceuticals raised $30M led by Fund One." }],
    });
  });
});

describe("/api/v1/companies/{id} stated_total_raised", () => {
  test("keeps the sum of the rounds on record and adds the company's own stated total, flagging the gap", async () => {
    const body = await profile("harmonic.example");
    expect(body.total_raised_usd_millions).toBe(67.5);
    expect(body.stated_total_raised).toEqual({
      usd_millions: 76,
      as_written: "$76 million",
      quote: "Harmonic has raised $50 million in a Series B financing round, bringing its total funding to $76 million.",
      stated_on: isoDaysAgo(3),
      stage: "series_b",
      stage_as_written: "Series B",
      source: "https://harmonic.example/blog/series-b",
      rounds_sum_usd_millions: 67.5,
      exceeds_rounds_sum: true,
    });
  });

  test("a total that matches the rounds is not flagged", async () => {
    const body = await profile("steady.example");
    expect(body.total_raised_usd_millions).toBe(36);
    expect(body.stated_total_raised).toMatchObject({ usd_millions: 36, rounds_sum_usd_millions: 36, exceeds_rounds_sum: false });
  });

  test("a series' running total, or no stated total, is null", async () => {
    expect((await profile("tally.example")).stated_total_raised).toBeNull();
    expect((await profile("vincipharma.example")).stated_total_raised).toBeNull();
  });
});
