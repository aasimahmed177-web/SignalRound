// Lane 2, narrow form: one /agent run for one record. A review item is in the
// queue because something is missing (date, amount, lead, website). The agent
// starts from the pages we already read, then looks for the press release and
// the company's own site, and returns only what a page states. Bounded: 400
// credits by default, effort low, so a click costs cents and finishes in a minute.
// https://docs.firecrawl.dev/features/agent

import type { Firecrawl } from "firecrawl";
import { z } from "zod";
import { SECTOR_HINT, SECTORS } from "../records/sectors.ts";

export const GapFill = z.object({
  announced_date: z
    .string()
    .nullable()
    .describe(
      "YYYY-MM-DD the round was publicly announced. The publish date of an article reporting it as news counts. Null if no page states it.",
    ),
  amount_as_written: z.string().nullable().describe("Round amount exactly as printed, e.g. '$12 million'. Null if no page states it."),
  lead_investors: z.array(z.string()).describe("Investors a page names as leading or co-leading the round"),
  other_investors: z.array(z.string()).describe("Other participating investors a page names"),
  company_website: z.string().nullable().describe("The company's own website. Never a news site, LinkedIn, Crunchbase, or a directory."),
  headquarters: z.string().nullable(),
  sector: z
    .enum(SECTORS)
    .nullable()
    .describe(`The closest sector from the list (${SECTOR_HINT}); other if none fits; null if no page says`),
  evidence_quote: z.string().nullable().describe("The exact sentence that states the round"),
  source_url: z.string().nullable().describe("URL of the page the filled facts came from"),
  is_rumor: z.boolean().describe("true if the round is only reported as rumored or in talks"),
  not_found: z.boolean().describe("true if no page confirms this company announced this round"),
});
export type GapFill = z.infer<typeof GapFill>;
export const gapFillJsonSchema = z.toJSONSchema(GapFill, { target: "draft-07", io: "output" });

export interface GapFillInput {
  company_name: string;
  stage_as_written: string;
  known: {
    announced_date: string | null;
    amount_as_written: string | null;
    lead_investors: string[];
    company_website: string | null;
  };
  /** Pages already read for this record; the agent opens these first. */
  source_urls: string[];
}

export function gapFillPrompt(input: GapFillInput): string {
  const k = input.known;
  const missing: string[] = [];
  if (!k.announced_date) missing.push("the announcement date");
  if (!k.amount_as_written) missing.push("the amount");
  if (k.lead_investors.length === 0) missing.push("the lead investor");
  if (!k.company_website) missing.push("the company website");
  const known = [
    k.announced_date ? `announced ${k.announced_date}` : null,
    k.amount_as_written ? `amount ${k.amount_as_written}` : null,
    k.lead_investors.length ? `led by ${k.lead_investors.join(", ")}` : null,
    k.company_website ? `website ${k.company_website}` : null,
  ].filter(Boolean);
  const pages = input.source_urls.length ? `Pages already read, open these first: ${input.source_urls.join(" ")}. ` : "";
  return (
    `${input.company_name} reportedly raised a ${input.stage_as_written} round. ` +
    (known.length ? `Known so far: ${known.join("; ")}. ` : "") +
    `Find ${missing.length ? missing.join(", ") : "anything the record is missing"}. ` +
    pages +
    "Then look for the company's own press release or newsroom post and one news article about the round. " +
    "Return only facts a page states, with the sentence as evidence_quote and its URL as source_url. " +
    "Leave a field null if no page states it. Do not infer the date from context; use the date the page gives. " +
    "If no page confirms the round, set not_found true. If it is only rumored or in talks, set is_rumor true."
  );
}

export interface GapFillOptions {
  maxCredits?: number;
  effort?: "low" | "medium" | "high";
}

export interface GapFillResult {
  status: "completed" | "failed" | "processing";
  fill: GapFill | null;
  creditsUsed: number | null;
  seconds: number;
  raw: unknown;
}

export async function gapFill(client: Firecrawl, input: GapFillInput, opts: GapFillOptions = {}): Promise<GapFillResult> {
  const started = Date.now();
  const result = await client.agent({
    prompt: gapFillPrompt(input),
    schema: gapFillJsonSchema,
    maxCredits: opts.maxCredits ?? 400,
    effort: opts.effort ?? "low",
    pollInterval: 3,
    timeout: 5 * 60,
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  const parsed = result.status === "completed" ? GapFill.safeParse(result.data) : null;
  return {
    status: result.status,
    fill: parsed?.success ? parsed.data : null,
    creditsUsed: result.creditsUsed ?? null,
    seconds,
    raw: result,
  };
}
