import { describe, expect, it } from "vitest";
import { compareScoreTrials, scoreAnswers, scoreModelSchema } from "./scoring.ts";

const model = {
  version: 1,
  baseScore: 1,
  questions: [
    { id: "income", weights: { low: 0, high: 5 } },
    { id: "savings", weights: { low: 0, high: 3 } },
  ],
  routes: [
    { id: "standard", minScore: 0, maxScore: 5 },
    { id: "qualified", minScore: 6 },
  ],
} as const;

describe("declarative scoring", () => {
  it("scores exact answer values and selects one route", () => {
    expect(scoreAnswers(model, { income: "high", savings: "low" })).toMatchObject({ score: 6, route: "qualified", routeAmbiguous: false });
    expect(scoreAnswers(model, { income: "unknown" })).toMatchObject({ score: 1, route: "standard" });
  });
  it("reports matched contributions without returning answer values", () => {
    const result = scoreAnswers(model, { income: "high", savings: "high" });
    expect(result.contributions).toEqual([
      { questionId: "income", points: 5, matched: true },
      { questionId: "savings", points: 3, matched: true },
    ]);
    expect(JSON.stringify(result)).not.toContain('"high"');
  });
  it("compares matched trials against the baseline", () => {
    expect(
      compareScoreTrials([
        { id: "baseline", score: 1, route: "standard" },
        { id: "income-high", score: 6, route: "qualified" },
      ]),
    ).toEqual([
      { id: "baseline", score: 1, route: "standard", baseline: true, scoreDelta: 0, routeChanged: false },
      { id: "income-high", score: 6, route: "qualified", baseline: false, scoreDelta: 5, routeChanged: true },
    ]);
  });
  it("rejects duplicate questions and overlapping output ambiguity remains explicit", () => {
    expect(scoreModelSchema.safeParse({ ...model, questions: [model.questions[0], model.questions[0]] }).success).toBe(false);
    expect(
      scoreAnswers(
        {
          ...model,
          routes: [
            { id: "a", minScore: 0 },
            { id: "b", minScore: 0 },
          ],
        },
        {},
      ),
    ).toMatchObject({
      route: null,
      routeAmbiguous: true,
    });
  });
});
