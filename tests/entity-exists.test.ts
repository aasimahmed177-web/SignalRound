import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { loadVisibleIds, type VisibleIds, visibilityCheck } from "../lib/entity-exists";
import { persistRecords, setDisposition } from "../lib/persist";
import { record, testDb } from "./helpers";

const TIMING = { ttlMs: 60_000, missRefreshMs: 10_000, failBackoffMs: 5_000 };

/** A loader that counts its calls and answers from a mutable list, failing while `down` is set. */
function fakeStore(initial: VisibleIds) {
  const store = { ids: initial, down: false, calls: 0 };
  const load = async (): Promise<VisibleIds> => {
    store.calls++;
    if (store.down) throw new Error("connection refused");
    return { companies: [...store.ids.companies], investors: [...store.ids.investors] };
  };
  return { store, load };
}

describe("visibilityCheck", () => {
  test("a crawl of many ids, known and made up, costs one load", async () => {
    const { store, load } = fakeStore({ companies: ["acme.com", "globex.com"], investors: ["big fund"] });
    const visible = visibilityCheck(load, TIMING);
    const answers = await Promise.all([
      visible("companies", "acme.com", 0),
      visible("companies", "globex.com", 0),
      visible("investors", "big fund", 0),
      ...Array.from({ length: 500 }, (_, i) => visible("companies", `nope-${i}`, 1_000)),
    ]);
    expect(answers.slice(0, 3)).toEqual([true, true, true]);
    expect(answers.slice(3).every((a) => a === false)).toBe(true);
    expect(store.calls).toBe(1);
  });

  test("the kinds are separate: an investor id is no company", async () => {
    const { load } = fakeStore({ companies: ["acme.com"], investors: ["acme.com fund"] });
    const visible = visibilityCheck(load, TIMING);
    expect(await visible("companies", "acme.com fund", 0)).toBe(false);
    expect(await visible("investors", "acme.com fund", 0)).toBe(true);
  });

  test("a burst of misses refreshes at most once per missRefreshMs, all of them sharing it", async () => {
    const { store, load } = fakeStore({ companies: ["acme.com"], investors: [] });
    const visible = visibilityCheck(load, TIMING);
    await visible("companies", "acme.com", 0);
    await Promise.all(Array.from({ length: 200 }, (_, i) => visible("companies", `junk-${i}`, 5_000)));
    expect(store.calls).toBe(1);
    await Promise.all(Array.from({ length: 200 }, (_, i) => visible("companies", `junk-${i}`, 12_000)));
    expect(store.calls).toBe(2);
    await Promise.all(Array.from({ length: 200 }, (_, i) => visible("companies", `junk-${i}`, 15_000)));
    expect(store.calls).toBe(2);
  });

  test("a company published after the snapshot is found on its first visit once the snapshot is old enough", async () => {
    const { store, load } = fakeStore({ companies: ["acme.com"], investors: [] });
    const visible = visibilityCheck(load, TIMING);
    await visible("companies", "acme.com", 0);
    store.ids = { companies: ["acme.com", "new.co"], investors: [] };
    expect(await visible("companies", "new.co", 11_000)).toBe(true);
  });

  test("past the TTL a known page answers from the old snapshot while a new one loads", async () => {
    const { store, load } = fakeStore({ companies: ["acme.com"], investors: [] });
    const visible = visibilityCheck(load, TIMING);
    await visible("companies", "acme.com", 0);
    store.ids = { companies: [], investors: [] };
    expect(await visible("companies", "acme.com", 61_000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.calls).toBe(2);
    expect(await visible("companies", "acme.com", 62_000)).toBe(false);
  });

  test("with no snapshot and no database the answer is null, and the database is not asked again at once", async () => {
    const { store, load } = fakeStore({ companies: ["acme.com"], investors: [] });
    store.down = true;
    const visible = visibilityCheck(load, TIMING);
    expect(await visible("companies", "acme.com", 0)).toBeNull();
    expect(await visible("companies", "acme.com", 1_000)).toBeNull();
    expect(store.calls).toBe(1);
    store.down = false;
    expect(await visible("companies", "acme.com", 6_000)).toBe(true);
    expect(store.calls).toBe(2);
  });

  test("a failed refresh keeps the last snapshot, so known pages stay up during a blip", async () => {
    const { store, load } = fakeStore({ companies: ["acme.com"], investors: [] });
    const visible = visibilityCheck(load, TIMING);
    await visible("companies", "acme.com", 0);
    store.down = true;
    expect(await visible("companies", "acme.com", 61_000)).toBe(true);
    expect(await visible("companies", "unknown.com", 61_000)).toBe(false);
  });
});

describe("loadVisibleIds", () => {
  test("lists the companies and investors on a published or flagged round, and none only in review or rejected", async () => {
    const db = await testDb();
    const shown = record({ company_name: "Acme", company_domain: "acme.com", lead_investors: ["Sequoia"] });
    const flagged = record({ company_name: "Beta", company_domain: "beta.io", lead_investors: ["Benchmark"] });
    const queued = record({ company_name: "Gamma", company_domain: "gamma.dev", lead_investors: ["Accel"] });
    const rejected = record({ company_name: "Delta", company_domain: "delta.ai", lead_investors: ["Greylock"] });
    await persistRecords(db, [shown, flagged, queued, rejected], "series-a-b", "run-1");
    await setDisposition(db, shown.id, "publish");
    await setDisposition(db, flagged.id, "flagged");
    await setDisposition(db, queued.id, "review");
    await setDisposition(db, rejected.id, "rejected");
    const companyOf = async (roundId: string) =>
      (await db.select({ c: schema.fundingRounds.companyId }).from(schema.fundingRounds).where(eq(schema.fundingRounds.id, roundId)))[0].c;

    const ids = await loadVisibleIds();
    expect(ids.companies.sort()).toEqual([await companyOf(shown.id), await companyOf(flagged.id)].sort());
    expect(ids.investors.sort()).toEqual(["benchmark", "sequoia"]);
  });
});
