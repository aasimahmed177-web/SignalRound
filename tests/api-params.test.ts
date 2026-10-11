import { describe, expect, test } from "vitest";
import { parseSector, parseStages } from "../lib/api-params";

describe("filter words", () => {
  test("a sector reads the way people write it", () => {
    for (const [raw, sector] of [
      ["AI infrastructure", "ai infrastructure"],
      ["ai-infra", "ai infrastructure"],
      ["ai_infrastructure", "ai infrastructure"],
      ["Fin Tech", "fintech"],
      ["dev tools", "developer tools"],
      ["healthcare", "healthtech"],
      ["other", "other"],
    ])
      expect(parseSector(raw)).toEqual({ ok: true, value: sector });
    expect(parseSector("robots-and-more").ok).toBe(false);
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
});
