import { readFileSync } from "node:fs";
import { parsePreset } from "@fireround/core";
import { describe, expect, test } from "vitest";
import { BACKFILL_MAX_MONTHS, backfillSpan, backfillWindows, estimateBackfillCredits, parseBackfillMonths } from "../lib/backfill";
import {
  COVERAGE_TIERS,
  type CoveragePlan,
  coverageFor,
  diffCoverage,
  estimateMonthlyCredits,
  estimateSweep,
  parseCoverageSetting,
  resolveCoverage,
  sweepCredits,
  sweepDue,
} from "../lib/coverage";

const preset = parsePreset(JSON.parse(readFileSync("presets/series-a-b.json", "utf8")));
/** The shipped presets read no X profiles now; the estimator still prices a custom preset that lists some. */
const withX = { ...preset, xAccounts: ["crunchbasenews", "dealroomco"] };

describe("backfill", () => {
  test("parseBackfillMonths accepts whole months from 1 to the ceiling", () => {
    expect(parseBackfillMonths(null)).toBeNull();
    expect(parseBackfillMonths("3")).toBe(3);
    expect(parseBackfillMonths("1")).toBe(1);
    expect(parseBackfillMonths(String(BACKFILL_MAX_MONTHS))).toBe(BACKFILL_MAX_MONTHS);
    for (const bad of ["0", "13", "-1", "2.5", "abc", "", " 3", "3 "]) expect(parseBackfillMonths(bad), bad).toBeNull();
  });

  test("backfillWindows lists the months newest first and backfillSpan opens on the oldest month's first day", () => {
    expect(backfillWindows(1)).toEqual(["month"]);
    expect(backfillWindows(3)).toEqual(["month", "month-1", "month-2"]);
    const now = new Date("2026-09-04T12:00:00Z");
    expect(backfillSpan(3, now)).toEqual({ start: "2026-07-01T00:00:00.000Z", end: "2026-09-04T12:00:00.000Z" });
    expect(backfillSpan(1, now).start).toBe("2026-09-01T00:00:00.000Z");
    // Across a year boundary.
    expect(backfillSpan(10, now).start).toBe("2025-12-01T00:00:00.000Z");
  });

  test("a backfill is priced per month like a week sweep, times presets and months, plus X accounts; Form D is free", () => {
    const plan = coverageFor("standard");
    const week = sweepCredits(withX, plan, "week");
    const month = sweepCredits(withX, plan, { kind: "month", back: 0 });
    expect(month).toEqual(week);
    const three = estimateBackfillCredits(plan, [withX], 3);
    expect(three.lines.map((l) => l.label)).toEqual(["Series A and B: 3 month sweeps", "SEC Form D (EDGAR, no scraping credits)"]);
    expect(three.lines[0]).toMatchObject({ low: week.low * 3, high: week.high * 3 });
    expect(three.lines[1]).toMatchObject({ low: 0, high: 0 });
    expect(three.low).toBe(three.lines.reduce((n, l) => n + l.low, 0));
    expect(three.high).toBe(three.lines.reduce((n, l) => n + l.high, 0));
    // Two presets cost twice one; one month is a third of three.
    const two = estimateBackfillCredits(plan, [withX, withX], 3);
    expect(two.low).toBe(three.low * 2);
    expect(estimateBackfillCredits(plan, [withX], 1).low * 3).toBe(three.low);
    // Lite reads no X accounts, so that line is absent.
    const lite = estimateBackfillCredits(coverageFor("lite"), [withX], 1);
    expect(lite.lines.find((l) => l.label === "X accounts")).toBeUndefined();
    expect(lite.lines[0].label).toBe("Series A and B: 1 month sweep");
  });
});

describe("coverageFor", () => {
  test("every rung is a complete plan and the table reads as docs/coverage.md", () => {
    for (const tier of COVERAGE_TIERS) expect(CoveragePlanKeys(coverageFor(tier))).toEqual(CoveragePlanKeys(coverageFor("lite")));
    expect(coverageFor("lite")).toMatchObject({
      sweep: { cadence: "weekly", windows: ["week"] },
      sources: ["news"],
      xAccountsMax: 0,
      watchSites: { enabled: false },
      formD: { enabled: false },
      monitorSchedule: "daily at 9am",
      corroboration: "off",
      enrichment: "homepage",
      alexandria: "off",
      trending: false,
      agent: { gapFill: "manual", deepDive: "manual", discoverySweep: "off" },
    });
    expect(coverageFor("standard")).toMatchObject({
      sweep: { cadence: "daily", windows: ["day", "week"] },
      sources: ["news", "web"],
      xAccountsMax: 2,
      corroboration: "new",
      enrichment: "homepage_pricing",
      alexandria: "yc",
      trending: false,
    });
    expect(coverageFor("deep")).toMatchObject({
      sweep: { cadence: "twice_daily", windows: ["day"] },
      xAccountsMax: 5,
      watchSites: { enabled: true, cadence: "daily" },
      formD: { enabled: true, cadence: "daily" },
      monitorSchedule: "every 6 hours",
      corroboration: "new_and_updated",
      enrichment: "plus_corroboration",
      alexandria: "yc",
      trending: true,
      agent: { gapFill: "auto", deepDive: "threshold", deepDiveMinUsdMillions: 10, discoverySweep: "weekly" },
    });
    expect(coverageFor("max")).toMatchObject({
      sweep: { cadence: "hourly", windows: ["day"] },
      xAccountsMax: 10,
      watchSites: { enabled: true, cadence: "hourly" },
      monitorSchedule: "hourly",
      corroboration: "all",
      enrichment: "weekly_reenrich",
      alexandria: "yc",
      trending: true,
      agent: { gapFill: "auto", deepDive: "all", discoverySweep: "daily" },
    });
  });

  test("returns a copy, so a caller cannot edit the table", () => {
    const plan = coverageFor("lite");
    plan.sources.push("web");
    expect(coverageFor("lite").sources).toEqual(["news"]);
  });
});

function CoveragePlanKeys(plan: CoveragePlan): string[] {
  return Object.keys(plan).sort();
}

describe("resolveCoverage", () => {
  test("overrides sit on top of the rung, field by field, nested fields included", () => {
    const plan = resolveCoverage({
      tier: "lite",
      overrides: { sources: ["news", "web"], agent: { deepDive: "threshold" }, watchSites: { enabled: true } },
    });
    expect(plan.sources).toEqual(["news", "web"]);
    expect(plan.agent).toEqual({ gapFill: "manual", deepDive: "threshold", deepDiveMinUsdMillions: 10, discoverySweep: "off" });
    expect(plan.watchSites).toEqual({ enabled: true, cadence: "daily" });
    expect(plan.sweep).toEqual(coverageFor("lite").sweep);
  });

  test("no overrides is the rung itself", () => {
    expect(resolveCoverage({ tier: "deep", overrides: {} })).toEqual(coverageFor("deep"));
  });

  test("diffCoverage keeps only what differs from the rung, and round-trips through resolveCoverage", () => {
    const plan = coverageFor("standard");
    plan.xAccountsMax = 1;
    plan.agent.gapFill = "auto";
    plan.watchSites.enabled = true;
    const overrides = diffCoverage("standard", plan);
    expect(overrides).toEqual({ xAccountsMax: 1, agent: { gapFill: "auto" }, watchSites: { enabled: true } });
    expect(resolveCoverage({ tier: "standard", overrides })).toEqual(plan);
    expect(diffCoverage("deep", coverageFor("deep"))).toEqual({});
    // An alexandria override round-trips the same way.
    const off = coverageFor("standard");
    off.alexandria = "off";
    const o2 = diffCoverage("standard", off);
    expect(o2).toEqual({ alexandria: "off" });
    expect(resolveCoverage({ tier: "standard", overrides: o2 })).toEqual(off);
  });

  test("a stored value that does not parse falls back to Lite", () => {
    expect(parseCoverageSetting(null)).toEqual({ tier: "lite", overrides: {} });
    expect(parseCoverageSetting({ tier: "platinum" })).toEqual({ tier: "lite", overrides: {} });
    expect(parseCoverageSetting({ tier: "max" })).toEqual({ tier: "max", overrides: {} });
  });
});

describe("estimateMonthlyCredits", () => {
  test.each(["lite", "standard", "deep", "max"] as const)("native %s coverage never estimates vendor scraping credits", (tier) => {
    const estimate = estimateMonthlyCredits(coverageFor(tier), [preset], 1);
    expect(estimate.low).toBe(0);
    expect(estimate.high).toBe(0);
    expect(estimate.lines.reduce((total, line) => total + line.high, 0)).toBe(0);
  });
});

describe("estimateSweep", () => {
  test("the total prices the whole run: the sweep portion plus X, verification, corroboration, and enrichment", () => {
    for (const tier of COVERAGE_TIERS) {
      const e = estimateSweep(preset, coverageFor(tier));
      expect(e.creditsLow).toBe(0);
      expect(e.creditsHigh).toBe(0);
      expect(e.creditsLow).toBe(0);
    }
  });

  test("Lite corroborates nothing and verifies 25 records at 5 credits each", () => {
    const e = estimateSweep(preset, coverageFor("lite"));
    expect(e.records).toBe(25);
    expect(e.corroborationCredits).toBe(0);
    expect(e.verificationCredits).toBe(0);
    // The pinned Lite week total: search and pages plus the run they feed, so a constant drifting shows here.
    expect(e.sweepLow).toBe(0);
    expect(e.sweepHigh).toBe(0);
    expect(e.creditsLow).toBe(0);
    expect(e.creditsHigh).toBe(0);
  });

  test("enrichment prices the run's investor logos: a 2-credit search and a 1-credit logo read each, capped at the per-pass limit", () => {
    const e = estimateSweep(preset, coverageFor("lite"));
    // 25 homepages at 5 credits with the 1-in-5 retry, half needing a 2-credit website search: 175.
    // 25 records name about 75 new investors; the pass searches 25 of them at 2 credits and reads their logos at 1: 75.
    expect(e.enrichmentCredits).toBe(0);
    // A month prices every new investor once, across the passes: Lite's 107 records at 7 credits a
    // homepage plus 3 investors at 3 credits each.
    const month = estimateMonthlyCredits(coverageFor("lite"), [preset], 0).lines.find((l) => l.label === "Enrichment");
    expect(month?.low).toBe(0);
  });

  test("a plan without the judge prices no verification, in the sweep estimate or the monthly lines", () => {
    const noJudge = { ...coverageFor("standard"), judge: false };
    const e = estimateSweep(preset, noJudge);
    expect(e.verificationCredits).toBe(0);
    expect(e.creditsLow).toBe(0);
    const monthly = estimateMonthlyCredits(noJudge, [preset], 0);
    expect(monthly.lines.find((l) => l.label.startsWith("Verification"))).toBeUndefined();
    const judged = estimateMonthlyCredits(coverageFor("standard"), [preset], 0);
    const line = judged.lines.find((l) => l.label === "Verification (read-back before publish)");
    expect(line).toBeTruthy();
    expect(monthly.low).toBe(judged.low - (line?.low ?? 0));
  });
});

describe("sweepDue", () => {
  const monday6 = new Date("2026-09-07T06:03:00Z");
  const tuesday6 = new Date("2026-09-08T06:00:00Z");
  const tuesday18 = new Date("2026-09-08T18:00:00Z");
  const tuesday13 = new Date("2026-09-08T13:00:00Z");

  test("Lite: Monday 06:00 UTC only, the week window", () => {
    const plan = coverageFor("lite");
    expect(sweepDue(plan, monday6)).toEqual({ due: true, windows: ["week"], next: "2026-09-14T06:00:00.000Z" });
    expect(sweepDue(plan, tuesday6)).toMatchObject({ due: false, windows: [], next: "2026-09-14T06:00:00.000Z" });
    expect(sweepDue(plan, tuesday13).due).toBe(false);
  });

  test("Standard: 06:00 daily with the day window; Monday adds the week window", () => {
    const plan = coverageFor("standard");
    expect(sweepDue(plan, monday6)).toEqual({ due: true, windows: ["day", "week"], next: "2026-09-08T06:00:00.000Z" });
    expect(sweepDue(plan, tuesday6)).toMatchObject({ due: true, windows: ["day"], next: "2026-09-09T06:00:00.000Z" });
    expect(sweepDue(plan, tuesday18)).toMatchObject({ due: false, next: "2026-09-09T06:00:00.000Z" });
  });

  test("Deep: 06:00 and 18:00", () => {
    const plan = coverageFor("deep");
    expect(sweepDue(plan, tuesday6)).toMatchObject({ due: true, windows: ["day"], next: "2026-09-08T18:00:00.000Z" });
    expect(sweepDue(plan, tuesday18)).toMatchObject({ due: true, windows: ["day"], next: "2026-09-09T06:00:00.000Z" });
    expect(sweepDue(plan, tuesday13)).toMatchObject({ due: false, next: "2026-09-08T18:00:00.000Z" });
  });

  test("Max: every hour", () => {
    const plan = coverageFor("max");
    expect(sweepDue(plan, tuesday13)).toEqual({ due: true, windows: ["day"], next: "2026-09-08T14:00:00.000Z" });
    expect(sweepDue(plan, new Date("2026-09-08T23:59:59Z")).next).toBe("2026-09-09T00:00:00.000Z");
  });
});
