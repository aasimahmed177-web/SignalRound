import { describe, expect, test } from "vitest";
import { foldCopies } from "../lib/fold-copies";

const src = (host: string, title: string | null) => ({ url: `https://${host}/a`, host, title });

describe("foldCopies", () => {
  test("a wire release republished word for word folds to its first copy", () => {
    const wire = "Ema Raises $77M Series B to Put AI Employees to Work Across the Enterprise";
    const out = foldCopies([
      src("finance.yahoo.com", wire),
      src("techcrunch.com", "Ema raises $77M as AI starts eating into enterprise software and services | TechCrunch"),
      src("markets.businessinsider.com", wire),
      src("globenewswire.com", `${wire} - GlobeNewswire`),
    ]);
    expect(out.map((e) => [e.primary.host, e.also.map((a) => a.host)])).toEqual([
      ["finance.yahoo.com", ["markets.businessinsider.com", "globenewswire.com"]],
      ["techcrunch.com", []],
    ]);
  });

  test("short or missing titles never fold", () => {
    const out = foldCopies([src("a.com", "Techmeme"), src("b.com", "Techmeme"), src("c.com", null), src("d.com", null)]);
    expect(out).toHaveLength(4);
  });
});
