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
    expect(three.lines.map((l) => l.label)).toEqual([
      "Series A and B: 3 month sweeps",
      "X accounts",
      "SEC Form D (EDGAR, no Firecrawl credits)",
    ]);
    expect(three.lines[0]).toMatchObject({ low: week.low * 3, high: week.high * 3 });
    expect(three.lines[1]).toMatchObject({ low: week.x * 3, high: week.x * 3 });
    expect(three.lines[2]).toMatchObject({ low: 0, high: 0 });
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
      alexandria: "yc_firmographics",
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
      alexandria: "yc_firmographics",
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
    const firmographics = coverageFor("standard");
    firmographics.alexandria = "yc_firmographics";
    const o2 = diffCoverage("standard", firmographics);
    expect(o2).toEqual({ alexandria: "yc_firmographics" });
    expect(resolveCoverage({ tier: "standard", overrides: o2 })).toEqual(firmographics);
  });

  test("a stored value that does not parse falls back to Lite", () => {
    expect(parseCoverageSetting(null)).toEqual({ tier: "lite", overrides: {} });
    expect(parseCoverageSetting({ tier: "platinum" })).toEqual({ tier: "lite", overrides: {} });
    expect(parseCoverageSetting({ tier: "max" })).toEqual({ tier: "max", overrides: {} });
  });
});

describe("estimateMonthlyCredits", () => {
  test("one preset, no monitor: Lite under 4k, Standard 8k to 32k, Deep 40k to 275k, Max 500k to 3M", () => {
    const lite = estimateMonthlyCredits(coverageFor("lite"), [preset], 0);
    expect(lite.low).toBeGreaterThan(1500);
    expect(lite.high).toBeLessThan(4000);
    const standard = estimateMonthlyCredits(coverageFor("standard"), [preset], 0);
    expect(standard.low).toBeGreaterThan(8000);
    // Investor websites are verified on their homepages from Standard up (about 3,600 credits a month here).
    expect(standard.high).toBeLessThan(32_000);
    const deep = estimateMonthlyCredits(coverageFor("deep"), [preset], 0);
    expect(deep.low).toBeGreaterThan(40_000);
    // The stage-free searches and the X announcements lane ride with watch sites (Deep and Max); the
    // default preset watches 13 publisher pages and runs 7 stage-free searches.
    expect(deep.high).toBeLessThan(275_000);
    const max = estimateMonthlyCredits(coverageFor("max"), [preset], 0);
    expect(max.low).toBeGreaterThan(500_000);
    // Max searches X every quarter hour, on X's own index (30 credits a query) as well as the web: about 1.2M a month.
    expect(max.high).toBeLessThan(3_000_000);
    expect(lite.high).toBeLessThan(standard.low);
    expect(standard.high).toBeLessThan(deep.low);
    expect(deep.high).toBeLessThan(max.low);
  });

  test("a checked dossier is priced at 300 credits a company, and Max adds the backlog as a range from zero", () => {
    const deep = estimateMonthlyCredits(coverageFor("deep"), [preset], 0);
    const max = estimateMonthlyCredits(coverageFor("max"), [preset], 0);
    const line = (e: typeof deep, label: string) => e.lines.find((l) => l.label.startsWith(label));
    // Deep dives the 30 percent of about 330 records a month above $10M; Max dives every one of about 900.
    expect(line(deep, "Agent deep dive")?.low).toBe(29_700);
    expect(line(max, "Agent deep dive")?.low).toBe(270_000);
    expect(line(deep, "Agent deep dive backlog")).toBeUndefined();
    // Two dives on each of 720 hourly ticks while visible companies still lack a checked dossier, each
    // with its prior rounds looked for (0.8 a dossier at up to 30 credits); none once it is drained.
    expect(line(max, "Agent deep dive backlog")).toMatchObject({ low: 0, high: 466_560 });
  });

  test("each dossier's prior rounds are priced as history rounds wherever dives run", () => {
    const deep = estimateMonthlyCredits(coverageFor("deep"), [preset], 0);
    const standard = estimateMonthlyCredits(coverageFor("standard"), [preset], 0);
    const line = (e: typeof deep, label: string) => e.lines.find((l) => l.label.startsWith(label));
    // 99 dossiers a month on Deep, 0.8 prior rounds each, 11 to 30 credits a round.
    expect(line(deep, "History rounds")).toMatchObject({ low: 871, high: 2376 });
    expect(line(standard, "History rounds")).toBeUndefined();
  });

  test("lines add up to the totals and name what the rung buys", () => {
    const e = estimateMonthlyCredits(coverageFor("deep"), [preset], 1);
    expect(e.lines.reduce((n, l) => n + l.low, 0)).toBe(e.low);
    expect(e.lines.reduce((n, l) => n + l.high, 0)).toBe(e.high);
    const labels = e.lines.map((l) => l.label);
    expect(labels).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Sweeps/), "Watch sites (map, then new pages)", "Agent deep dive"]),
    );
    expect(labels.find((l) => l.startsWith("Monitor checks"))).toBeTruthy();
    const noMonitor = estimateMonthlyCredits(coverageFor("deep"), [preset], 0);
    expect(noMonitor.lines.find((l) => l.label.startsWith("Monitor checks"))).toBeUndefined();
    // A monitor checked every 6 hours: 130 credits a check, 120 checks a month.
    expect(e.low - noMonitor.low).toBe(130 * 120);
  });

  test("Trending prices four checkpoints of X searches per record plus the showcase ceiling, on Deep and Max only", () => {
    const line = (tier: "lite" | "standard" | "deep" | "max") =>
      estimateMonthlyCredits(coverageFor(tier), [preset], 0).lines.find((l) => l.label.startsWith("Trending"));
    expect(line("lite")).toBeUndefined();
    expect(line("standard")).toBeUndefined();
    // Deep: about 330 records a month. Low: nine in ten followed at 2.7 searches of 3.4 credits a checkpoint, a credit for the
    // handle, nothing labelled. High: every record at three full searches, and five labelled rounds' three posts every six hours.
    expect(line("deep")).toMatchObject({ low: 11_203, high: 70_170 });
    expect(line("max")?.low).toBeGreaterThan(line("deep")?.low ?? 0);
    // A plan override turns it on at Standard, and the line appears.
    const on = { ...coverageFor("standard"), trending: true };
    expect(estimateMonthlyCredits(on, [preset], 0).lines.find((l) => l.label.startsWith("Trending"))?.low).toBeGreaterThan(0);
  });

  test("Alexandria prices per company on rungs that buy it and is absent on Lite", () => {
    const lite = estimateMonthlyCredits(coverageFor("lite"), [preset], 0);
    expect(lite.lines.find((l) => l.label.startsWith("Alexandria"))).toBeUndefined();
    const standard = estimateMonthlyCredits(coverageFor("standard"), [preset], 0);
    const line = standard.lines.find((l) => l.label.startsWith("Alexandria"));
    expect(line?.low).toBeGreaterThan(0);
    // A yc_firmographics rung prices the FullEnrich lookup on top.
    const deep = estimateMonthlyCredits(coverageFor("deep"), [preset], 0);
    expect((deep.lines.find((l) => l.label.startsWith("Alexandria"))?.low ?? 0) > (line?.low ?? 0)).toBe(true);
    const off = { ...coverageFor("standard"), alexandria: "off" as const };
    expect(estimateMonthlyCredits(off, [preset], 0).lines.find((l) => l.label.startsWith("Alexandria"))).toBeUndefined();
  });

  test("the rung is a ceiling on X accounts and sources; Lite reads none and news only", () => {
    const lite = estimateMonthlyCredits(coverageFor("lite"), [withX], 0);
    expect(lite.lines.find((l) => l.label === "X accounts")).toBeUndefined();
    const standard = estimateMonthlyCredits(coverageFor("standard"), [withX], 0);
    expect(standard.lines.find((l) => l.label === "X accounts")?.low).toBeGreaterThan(0);
    // Two presets cost twice one (to rounding).
    const two = estimateMonthlyCredits(coverageFor("standard"), [withX, withX], 0);
    expect(Math.abs(two.low - standard.low * 2)).toBeLessThan(10);
  });
});

describe("estimateSweep", () => {
  test("the total prices the whole run: the sweep portion plus X, verification, corroboration, and enrichment", () => {
    for (const tier of COVERAGE_TIERS) {
      const e = estimateSweep(preset, coverageFor(tier));
      expect(e.creditsLow).toBe(
        e.sweepLow + e.xCredits + e.verificationCredits + e.corroborationCredits + e.enrichmentCredits + e.alexandriaCredits,
      );
      expect(e.creditsHigh).toBe(
        e.sweepHigh + e.xCredits + e.verificationCredits + e.corroborationCredits + e.enrichmentCredits + e.alexandriaCredits,
      );
      expect(e.creditsLow).toBeGreaterThan(e.sweepLow);
    }
  });

  test("Lite corroborates nothing and verifies 25 records at 5 credits each", () => {
    const e = estimateSweep(preset, coverageFor("lite"));
    expect(e.records).toBe(25);
    expect(e.corroborationCredits).toBe(0);
    expect(e.verificationCredits).toBe(25 * 5);
    // The pinned Lite week total: search and pages plus the run they feed, so a constant drifting shows here.
    expect(e.sweepLow).toBe(256);
    expect(e.sweepHigh).toBe(316);
    expect(e.creditsLow).toBe(631);
    expect(e.creditsHigh).toBe(691);
  });

  test("enrichment prices the run's investor logos: a 2-credit search and a 1-credit logo read each, capped at the per-pass limit", () => {
    const e = estimateSweep(preset, coverageFor("lite"));
    // 25 homepages at 5 credits with the 1-in-5 retry, half needing a 2-credit website search: 175.
    // 25 records name about 75 new investors; the pass searches 25 of them at 2 credits and reads their logos at 1: 75.
    expect(e.enrichmentCredits).toBe(175 + 75);
    // A month prices every new investor once, across the passes: Lite's 107 records at 7 credits a
    // homepage plus 3 investors at 3 credits each.
    const month = estimateMonthlyCredits(coverageFor("lite"), [preset], 0).lines.find((l) => l.label === "Enrichment");
    expect(month?.low).toBe(Math.round(((25 * 30) / 7) * (7 + 3 * 3)));
  });

  test("a plan without the judge prices no verification, in the sweep estimate or the monthly lines", () => {
    const noJudge = { ...coverageFor("standard"), judge: false };
    const e = estimateSweep(preset, noJudge);
    expect(e.verificationCredits).toBe(0);
    expect(e.creditsLow).toBe(e.sweepLow + e.xCredits + e.corroborationCredits + e.enrichmentCredits + e.alexandriaCredits);
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
