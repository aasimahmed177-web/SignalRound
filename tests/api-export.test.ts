// The read API at launch (P2): a CSV export is the whole filtered set, not the first 200 rows, and the
// public view may be read from another origin and held by the CDN, while an insider's view is neither.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { GET as roundsGet } from "../app/api/v1/rounds/route";
import { GET as runsGet } from "../app/api/v1/runs/route";
import { db } from "../lib/db";
import { persistRecords } from "../lib/persist";
import { record } from "./helpers";

beforeAll(async () => {
  // 205 companies, one Series A each, a day apart: more than one API page.
  const rows = Array.from({ length: 205 }, (_, i) =>
    record({
      company_name: `Export Co ${i}`,
      company_domain: `export-co-${i}.example`,
      stage: "series_a",
      announced_date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    }),
  );
  await persistRecords(await db(), rows, "series-a-b", "run-export");
}, 120_000);

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.DASHBOARD_PASSWORD;
});

function demo() {
  vi.stubEnv("PUBLIC_DEMO", "1");
  process.env.DASHBOARD_PASSWORD = "secret";
}

describe("the CSV export", () => {
  test("without a limit it holds every filtered row, with the disposition column", async () => {
    const res = await roundsGet(new Request("http://app.test/api/v1/rounds?format=csv&include_review=true"));
    const lines = (await res.text()).trim().split("\n");
    expect(lines[0].split(",").at(-1)).toBe("disposition");
    expect(lines).toHaveLength(206);
    expect(res.headers.get("x-next-cursor")).toBeNull();
  });

  test("with a limit it is that page, and says where the rest starts", async () => {
    const res = await roundsGet(new Request("http://app.test/api/v1/rounds?format=csv&limit=10&include_review=true"));
    expect((await res.text()).trim().split("\n")).toHaveLength(11);
    expect(res.headers.get("x-next-cursor")).toBeTruthy();
  });
});

describe("CORS and caching", () => {
  test("a visitor's read is open to any origin and cached a minute at the edge", async () => {
    demo();
    for (const res of [
      await roundsGet(new Request("http://app.test/api/v1/rounds")),
      await roundsGet(new Request("http://app.test/api/v1/rounds?format=csv")),
      await runsGet(new Request("http://app.test/api/v1/runs")),
    ]) {
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("cache-control")).toContain("s-maxage=60");
    }
  });

  test("an admin's read is never shared or cached", async () => {
    demo();
    const auth = { authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` };
    const res = await roundsGet(new Request("http://app.test/api/v1/rounds", { headers: auth }));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});
