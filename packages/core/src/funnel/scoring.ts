import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._-]+$/);
export const scoreModelSchema = z
  .object({
    version: z.literal(1),
    baseScore: z.number().finite().default(0),
    questions: z
      .array(
        z
          .object({
            id,
            weights: z.record(z.string().max(500), z.number().finite()).refine((weights) => Object.keys(weights).length <= 100),
          })
          .strict(),
      )
      .max(100),
    routes: z.array(z.object({ id, minScore: z.number().finite(), maxScore: z.number().finite().optional() }).strict()).max(30),
  })
  .strict()
  .superRefine((model, ctx) => {
    const ids = new Set<string>();
    for (const question of model.questions) {
      if (ids.has(question.id)) ctx.addIssue({ code: "custom", message: `Duplicate question: ${question.id}` });
      ids.add(question.id);
    }
    for (const route of model.routes) {
      if (route.maxScore !== undefined && route.maxScore < route.minScore)
        ctx.addIssue({ code: "custom", message: `Invalid route range: ${route.id}` });
    }
  });

export type ScoreModel = z.infer<typeof scoreModelSchema>;

export function scoreAnswers(modelInput: unknown, answers: Record<string, string>) {
  const model = scoreModelSchema.parse(modelInput);
  let score = model.baseScore;
  const contributions = model.questions.map((question) => {
    const answerPresent = Object.hasOwn(answers, question.id);
    const answer = answers[question.id];
    const points = answerPresent ? (question.weights[answer] ?? 0) : 0;
    score += points;
    return { questionId: question.id, points, matched: answerPresent && Object.hasOwn(question.weights, answer) };
  });
  const matches = model.routes.filter((route) => score >= route.minScore && (route.maxScore === undefined || score <= route.maxScore));
  return { score, route: matches.length === 1 ? matches[0].id : null, routeAmbiguous: matches.length > 1, contributions };
}

export function compareScoreTrials(trials: Array<{ id: string; score: number; route: string | null }>) {
  if (!trials.length || trials.length > 50) throw new Error("Provide 1–50 score trials");
  const baseline = trials[0];
  return trials.map((trial, index) => ({
    ...trial,
    baseline: index === 0,
    scoreDelta: trial.score - baseline.score,
    routeChanged: trial.route !== baseline.route,
  }));
}
