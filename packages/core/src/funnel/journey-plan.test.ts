import { describe, expect, it } from "vitest";
import { questionnairePlanSchema } from "./journey-plan.ts";

const plan = {
  version: 1,
  mode: "interactive-dry-run",
  startUrl: "https://forms.example.com/quiz?utm_source=test",
  allowedOrigins: ["https://forms.example.com"],
  steps: [
    { id: "income", action: "select", selector: "#income", answerKey: "income", by: "value" },
    { id: "next", action: "click", selector: "button.next", intent: "next" },
    { id: "result", action: "observe", selector: "[data-score]" },
  ],
  profiles: [{ id: "baseline", label: "Baseline", answers: { income: "low" } }],
  scoreSelectors: ["[data-score]"],
};

describe("questionnaire journey plan", () => {
  it("accepts a bounded dry-run plan", () => expect(questionnairePlanSchema.parse(plan).profiles).toHaveLength(1));
  it("rejects a missing profile answer", () => {
    expect(questionnairePlanSchema.safeParse({ ...plan, profiles: [{ id: "x", label: "X", answers: {} }] }).success).toBe(false);
  });
  it("rejects submission actions and noncanonical allowed origins", () => {
    expect(questionnairePlanSchema.safeParse({ ...plan, mode: "authorized-synthetic-experiment" }).success).toBe(false);
    expect(questionnairePlanSchema.safeParse({ ...plan, allowedOrigins: ["https://forms.example.com/"] }).success).toBe(false);
    expect(
      questionnairePlanSchema.safeParse({ ...plan, steps: [{ id: "submit", action: "click", selector: "button", intent: "submit" }] })
        .success,
    ).toBe(false);
  });
});
