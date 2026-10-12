// SEC Form D filings stay out of the default public lists (the API's list, its amount sort, Biggest
// rounds) and are reached by asking for them (preset=form-d) or through their company.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { beforeAll, describe, expect, test } from "vitest";
import { GET as roundsGet } from "../app/api/v1/rounds/route";
import { db } from "../lib/db";
import { FORM_D_PRESET, persistRecords, publicRoundQuery, setDisposition } from "../lib/persist";
import { marketView } from "../lib/stats";
import { record } from "./helpers";
import { isoDaysAgo } from "./history-fixtures";

const day = isoDaysAgo(1);
const usd = (m: number) => ({ value: m, currency: "USD", as_written: `$${m}M`, usd_millions: m, fx_rate: 1, fx_date: day });

beforeAll(async () => {
  const handle = await db();
  const news = record({
    company_name: "Newsy",
    company_key: "newsy",
    company_domain: "newsy.example",
    announced_date: day,
    amount: usd(20),
    sources: [{ url: "https://news.example/newsy", host: "news.example", title: "Newsy raises $20M", published: day }],
  });
  const filing = record({
    company_name: "Filer",
    company_key: "filer",
    company_domain: "filer.example",
    stage: "other",
    stage_as_written: "Form D (equity)",
    announced_date: day,
    amount: usd(900),
    sources: [{ url: "https://www.sec.gov/Archives/edgar/data/1/filer-form-d", host: "www.sec.gov", title: "Form D", published: day }],
  });
  for (const [r, preset] of [
    [news, "series-a-b"],
    [filing, FORM_D_PRESET],
  ] as const) {
    const { persistedIds } = await persistRecords(handle, [r], preset, `run-${r.company_key}`);
    await setDisposition(handle, persistedIds[0] as string, "publish");
  }
});

const companies = async (path: string) => {
  const res = await roundsGet(new Request(`http://app.test${path}`));
  const body = (await res.json()) as { data: Array<{ company: { name: string } }> };
  return body.data.map((r) => r.company.name);
};

describe("Form D filings in public lists", () => {
  test("publicRoundQuery leaves them out unless the query asks for a preset, a company, or ids", () => {
    expect(publicRoundQuery({ limit: 5 })).toMatchObject({ excludePreset: FORM_D_PRESET });
    expect(publicRoundQuery({ preset: FORM_D_PRESET })).not.toHaveProperty("excludePreset");
    expect(publicRoundQuery({ company: "filer.example" })).not.toHaveProperty("excludePreset");
    expect(publicRoundQuery({ ids: ["x"] })).not.toHaveProperty("excludePreset");
  });

  test("the API's list and its amount sort leave the filing out; preset=form-d and company= return it", async () => {
    expect(await companies("/api/v1/rounds")).toEqual(["Newsy"]);
    expect(await companies("/api/v1/rounds?sort=amount")).toEqual(["Newsy"]);
    expect(await companies("/api/v1/rounds?preset=form-d")).toEqual(["Filer"]);
    expect(await companies("/api/v1/rounds?company=filer.example")).toEqual(["Filer"]);
  });

  test("Biggest rounds leaves the filing out, however large its figure", async () => {
    const { biggest } = await marketView(await db());
    expect(biggest.map((r) => r.company.name)).toEqual(["Newsy"]);
  });
});
