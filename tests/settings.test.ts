import { describe, expect, test } from "vitest";
import { coverageFor } from "../lib/coverage";
import { getCoverage, getCoverageSetting, setCoverageSetting } from "../lib/settings";
import { testDb } from "./helpers";

describe("coverage setting", () => {
  test("absent means Lite; set, read back, overrides resolve into the plan", async () => {
    const db = await testDb();
    expect(await getCoverageSetting(db)).toEqual({ tier: "lite", overrides: {} });
    expect(await getCoverage(db)).toEqual(coverageFor("lite"));

    await setCoverageSetting(db, { tier: "standard", overrides: { xAccountsMax: 1, agent: { gapFill: "auto" } } });
    expect(await getCoverageSetting(db)).toEqual({ tier: "standard", overrides: { xAccountsMax: 1, agent: { gapFill: "auto" } } });
    const plan = await getCoverage(db);
    expect(plan).toMatchObject({ sweep: { cadence: "daily" }, xAccountsMax: 1, agent: { gapFill: "auto", deepDive: "manual" } });

    // A second write replaces the first: one row per key.
    await setCoverageSetting(db, { tier: "max", overrides: {} });
    expect(await getCoverage(db)).toEqual(coverageFor("max"));
  });
});
