import { describe, expect, test } from "vitest";
import { parseSector, parseSince, parseStages, parseWindow } from "../lib/api-params";

describe("filter words", () => {
  test("a sector reads the way people write it", () => {
    for (const [raw, sector] of [
      ["AI infrastructure", "ai infrastructure"],
      ["ai-infra", "ai infrastructure"],
      ["ai_infrastructure", "ai infrastructure"],
      ["Fin Tech", "fintech"],
      ["dev tools", "developer tools"],
      ["healthcare", "health"],
      ["Health", "health"],
      ["Climate and energy", "climate"],
      ["SaaS", "software"],
      ["aerospace", "aerospace and defense"],
      ["other", "other"],
    ])
      expect(parseSector(raw)).toEqual({ ok: true, value: sector });
    expect(parseSector("robots-and-more").ok).toBe(false);
    const refused = parseSector("robots-and-more");
    expect(!refused.ok && refused.error).toContain("ai (ai, ai infrastructure)");
    expect(parseSector(null)).toEqual({ ok: true, value: undefined });
  });

  test("a stage reads the way people write it", () => {
    for (const [raw, stages] of [
      ["series_a", ["series_a"]],
      ["Series A", ["series_a"]],
      ["series-a", ["series_a"]],
      ["Pre-Seed", ["pre_seed"]],
      ["Series D+", ["series_d_plus"]],
      ["series-f", ["series_d_plus"]],
      ["seed,Series A,seed", ["seed", "series_a"]],
    ] as const)
      expect(parseStages(raw)).toEqual({ ok: true, value: stages });
    for (const raw of ["series_z", "foo", "seed,foo"]) expect(parseStages(raw).ok).toBe(false);
  });

  test("since reads a date, a month, today, yesterday, or days back, in UTC", () => {
    const now = new Date("2026-10-11T23:30:00Z");
    for (const [raw, day] of [
      ["2026-10-04", "2026-10-04"],
      ["2026-10", "2026-10-01"],
      ["today", "2026-10-11"],
      ["Yesterday", "2026-10-10"],
      ["7d", "2026-10-04"],
      ["30D", "2026-09-11"],
      ["0d", "2026-10-11"],
      [" 2026-02-01 ", "2026-02-01"],
    ])
      expect(parseSince(raw, now)).toEqual({ ok: true, value: day });
    for (const raw of ["", "last week", "2026-13", "2026-02-30", "7", "-7d", "7w", "99999d"])
      expect(parseSince(raw, now).ok, raw).toBe(false);
    expect(parseSince(null, now)).toEqual({ ok: true, value: undefined });
  });

  test("a window reads week, month and quarter", () => {
    const windows = ["7d", "30d", "90d"] as const;
    for (const [raw, value] of [
      ["7d", "7d"],
      ["week", "7d"],
      ["Month", "30d"],
      ["quarter", "90d"],
      [null, "30d"],
    ] as const)
      expect(parseWindow(raw, windows, "30d")).toEqual({ ok: true, value });
    const refused = parseWindow("year", windows, "30d");
    expect(!refused.ok && refused.error).toContain("week, month, quarter");
  });
});
