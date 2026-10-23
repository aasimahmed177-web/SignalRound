import { z } from "zod";
import { scoreModelSchema } from "./scoring.ts";

const publicHttpUrl = z
  .string()
  .max(8192)
  .refine((raw) => {
    try {
      const url = new URL(raw);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password && Boolean(url.hostname.includes("."));
    } catch {
      return false;
    }
  }, "Expected a public-looking HTTP(S) URL without credentials");
const answerKey = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._-]+$/);
const selector = z.string().min(1).max(500);

export const questionnairePlanSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("interactive-dry-run"),
    startUrl: publicHttpUrl,
    allowedOrigins: z.array(z.string().url()).min(1).max(30),
    steps: z
      .array(
        z.discriminatedUnion("action", [
          z.object({ id: answerKey, action: z.literal("fill"), selector, answerKey }).strict(),
          z
            .object({ id: answerKey, action: z.literal("select"), selector, answerKey, by: z.enum(["value", "label"]).default("value") })
            .strict(),
          z.object({ id: answerKey, action: z.literal("check"), selector, answerKey }).strict(),
          z.object({ id: answerKey, action: z.literal("click"), selector, intent: z.enum(["answer", "continue", "next"]) }).strict(),
          z.object({ id: answerKey, action: z.literal("observe"), selector: selector.optional() }).strict(),
        ]),
      )
      .min(1)
      .max(50),
    profiles: z
      .array(
        z
          .object({ id: answerKey, label: z.string().min(1).max(100), answers: z.record(answerKey, z.string().max(4096)) })
          .strict()
          .refine((profile) => Object.keys(profile.answers).length <= 100),
      )
      .min(1)
      .max(8),
    scoreSelectors: z.array(selector).max(10).default([]),
    scoring: scoreModelSchema.optional(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const start = new URL(plan.startUrl);
    if (!plan.allowedOrigins.includes(start.origin)) ctx.addIssue({ code: "custom", message: "Start origin must be allowed" });
    if (
      plan.allowedOrigins.some((origin) => {
        try {
          const url = new URL(origin);
          return url.origin !== origin || !/^https?:$/.test(url.protocol) || Boolean(url.username || url.password);
        } catch {
          return true;
        }
      })
    )
      ctx.addIssue({ code: "custom", message: "Allowed origins must be canonical HTTP(S) origins" });
    const ids = new Set<string>();
    for (const step of plan.steps) {
      if (ids.has(step.id)) ctx.addIssue({ code: "custom", message: `Duplicate step: ${step.id}` });
      ids.add(step.id);
      if ("answerKey" in step && plan.profiles.some((profile) => !Object.hasOwn(profile.answers, step.answerKey)))
        ctx.addIssue({ code: "custom", message: `Every profile needs answer: ${step.answerKey}` });
    }
  });

export type QuestionnairePlan = z.infer<typeof questionnairePlanSchema>;
