// Lane 2, wide form: one /agent run that reads a company, not a round. The dossier
// is what an analyst would pull together before a first call: who founded it, what it
// has raised before, how big it is, who buys it, who backs it, who it competes with, and
// why the round matters. Effort high with a 2,500 credit cap (the agent's own default): a
// run that hits the cap returns nothing and is not billed, so a low cap only buys failures.
// Nothing the agent returns is shown as is: llm/dossier-verify.ts checks every claim first.
// https://docs.firecrawl.dev/features/agent

import type { Firecrawl } from "firecrawl";
import { z } from "zod";
import { cleanText } from "../records/normalize.ts";

const nullableString = z.string().nullable();

export const DossierFounder = z.object({
  name: z.string().describe("The founder's full name as a page states it"),
  role: nullableString.describe(
    "Their role as a page states it, for example 'co-founder and CEO', 'co-founder, former chief scientist', 'co-chair at founding, left the board in 2018'. Null if no page states it.",
  ),
  background: nullableString.describe("One sentence on where they worked or studied before, from a page. Null if no page states it."),
});

export const DossierPriorRound = z.object({
  stage_as_written: z.string().describe("The round label as a page writes it, for example Seed, Series A"),
  amount_as_written: nullableString.describe("The amount exactly as written, with currency. Null if no page states it."),
  announced_date: nullableString.describe(
    "YYYY-MM-DD if a page dates the round; a month or a year alone as YYYY-MM or YYYY. Null if unstated.",
  ),
  lead_investors: z.array(z.string()).describe("Investors a page names as leading that round. Empty if none named."),
});

/** The agent's schema. Customers and backers are separate lists: one mixed list invited investors and accelerators into "customers". */
export const CompanyDossier = z.object({
  one_liner: z
    .string()
    .describe("One sentence on what the company builds and for whom, in plain language, from its own site or a profile."),
  founded_year: z.number().int().nullable().describe("The year the company was founded, as a page states it. Null if unstated."),
  founders: z
    .array(DossierFounder)
    .describe(
      "Every person a page calls a founder or co-founder of this company, including those who have since left. Not executives or employees who did not found it, nor funders or board members no page calls a founder.",
    ),
  headcount_estimate: nullableString.describe(
    "Team size as the most recent page states it, for example '51 to 200' or 'about 40 people'. Null if no page states it; never guess.",
  ),
  total_raised_as_written: nullableString.describe(
    "Total equity funding to date exactly as the most recent page writes it, for example '$62 million'. Null if no page states a total.",
  ),
  prior_rounds: z
    .array(DossierPriorRound)
    .describe(
      "Earlier equity funding rounds pages report, oldest first, each labelled as the page labels it (do not invent a series letter), including strategic investments by corporations. Not loans, grants, debt or credit facilities, secondary share sales, or the round being announced now. Empty if none.",
    ),
  customers: z
    .array(z.string())
    .describe(
      "Organizations a page names as paying customers or users of the product. Not investors, accelerators, grant bodies, partners, suppliers, or individual people. Empty if none.",
    ),
  investors_and_backers: z
    .array(z.string())
    .describe("Investors, accelerators, incubators, and grant programs a page names as backing the company. Empty if none."),
  competitors: z
    .array(z.string())
    .describe(
      "Companies a page names as competitors or alternatives to this company specifically, not a directory's generic list. Empty if none.",
    ),
  business_model: nullableString.describe(
    "How the company makes money in one sentence (subscription, usage, marketplace take rate, hardware sales). Null if no page says.",
  ),
  why_it_matters: z
    .string()
    .describe(
      "Two sentences on why this company and its funding matter, grounded in what the pages say: the problem, the traction, the bet.",
    ),
  sources: z.array(z.string()).describe("Every URL you read to fill this dossier."),
});
export type CompanyDossier = z.infer<typeof CompanyDossier>;
export const companyDossierJsonSchema = z.toJSONSchema(CompanyDossier, { target: "draft-07", io: "output" });

/** Rows written before the split kept one `customers_or_logos` list; they read as customers with no backers, and the check sorts them. */
const LegacyDossier = CompanyDossier.omit({ customers: true, investors_and_backers: true }).extend({
  customers_or_logos: z.array(z.string()),
});

/** A stored dossier in either shape, or null when it is neither. */
export function parseStoredDossier(data: unknown): CompanyDossier | null {
  const current = CompanyDossier.safeParse(data);
  if (current.success) return current.data;
  const legacy = LegacyDossier.safeParse(data);
  if (!legacy.success) return null;
  const { customers_or_logos, ...rest } = legacy.data;
  return { ...rest, customers: customers_or_logos, investors_and_backers: [] };
}

export interface DeepDiveInput {
  company_name: string;
  website: string | null;
  domain: string | null;
  description: string | null;
}

export function deepDivePrompt(input: DeepDiveInput): string {
  const site = input.website ?? (input.domain ? `https://${input.domain}` : null);
  const known = [site ? `Its website is ${site}.` : null, input.description ? `What we know so far: ${input.description}` : null].filter(
    Boolean,
  );
  return [
    `Build a dossier on the company ${input.company_name}.`,
    ...known,
    "Make sure every page you use is about this company and not another company with a similar name.",
    "Start with the company's own site (about, team, customers, and pricing pages), then its press releases and news coverage, then a funding profile if one exists.",
    "Fill every field from what a page states: founders with their roles and backgrounds, the founding year, team size, total raised, each earlier equity round with its amount, date, and lead, named customers, named backers, named competitors, and how it makes money.",
    "Keep the lists apart: an investor, accelerator, or grant program is a backer, never a customer; a partner, supplier, or a person quoted in a testimonial is neither.",
    "When pages disagree on a number, use the most recent page and say nothing you cannot source.",
    "Write one_liner in plain language and why_it_matters as two sentences grounded in the pages.",
    "Leave a field null or empty when no page states it; never guess a number or a date.",
    "List every URL you read in sources.",
  ].join(" ");
}

export type DeepDiveEffort = "low" | "medium" | "high";

/** The agent's own default cap and its highest reasoning budget, on Spark 2 (the one model that takes an effort). */
export const DEEP_DIVE_MAX_CREDITS = 2500;
export const DEEP_DIVE_EFFORT: DeepDiveEffort = "high";
export const DEEP_DIVE_MODEL = "spark-2" as const;

export interface DeepDiveOptions {
  maxCredits?: number;
  effort?: DeepDiveEffort;
}

export interface DeepDiveResult {
  status: "completed" | "failed" | "processing";
  dossier: CompanyDossier | null;
  creditsUsed: number | null;
  seconds: number;
  /** The agent's error text, when it gave one. */
  error?: string | null;
}

/** Placeholder text ("Not stated") becomes null, and empty names go, like every other extraction. */
export function cleanDossier(d: CompanyDossier): CompanyDossier {
  const names = (list: string[]) => [...new Set(list.filter((n) => cleanText(n) !== null).map((n) => n.trim()))];
  return {
    ...d,
    one_liner: cleanText(d.one_liner) ?? "",
    founders: d.founders
      .filter((f) => cleanText(f.name) !== null)
      .map((f) => ({ name: f.name.trim(), role: cleanText(f.role), background: cleanText(f.background) })),
    headcount_estimate: cleanText(d.headcount_estimate),
    total_raised_as_written: cleanText(d.total_raised_as_written),
    prior_rounds: d.prior_rounds
      .filter((r) => cleanText(r.stage_as_written) !== null)
      .map((r) => ({
        stage_as_written: r.stage_as_written.trim(),
        amount_as_written: cleanText(r.amount_as_written),
        announced_date: cleanText(r.announced_date),
        lead_investors: names(r.lead_investors),
      })),
    customers: names(d.customers),
    investors_and_backers: names(d.investors_and_backers),
    competitors: names(d.competitors),
    business_model: cleanText(d.business_model),
    why_it_matters: cleanText(d.why_it_matters) ?? "",
    sources: [...new Set(d.sources.filter((u) => /^https?:\/\//i.test(u)))],
  };
}

function agentArgs(input: DeepDiveInput, opts: DeepDiveOptions) {
  return {
    prompt: deepDivePrompt(input),
    schema: companyDossierJsonSchema,
    model: DEEP_DIVE_MODEL,
    maxCredits: opts.maxCredits ?? DEEP_DIVE_MAX_CREDITS,
    effort: opts.effort ?? DEEP_DIVE_EFFORT,
  };
}

/** A status response as a result: the dossier parsed and cleaned, or null when it does not parse. */
export function toDeepDiveResult(
  result: { status: "completed" | "failed" | "processing"; data?: unknown; creditsUsed?: number; error?: string },
  seconds: number,
): DeepDiveResult {
  const parsed = result.status === "completed" ? CompanyDossier.safeParse(result.data) : null;
  return {
    status: result.status,
    dossier: parsed?.success ? cleanDossier(parsed.data) : null,
    creditsUsed: result.creditsUsed ?? null,
    seconds,
    error: result.error ?? null,
  };
}

/** One agent run, waited on inline. The durable path uses startDeepDive and awaitDeepDive instead, so no function waits ten minutes. */
export async function deepDive(client: Firecrawl, input: DeepDiveInput, opts: DeepDiveOptions = {}): Promise<DeepDiveResult> {
  const started = Date.now();
  const result = await client.agent({ ...agentArgs(input, opts), pollInterval: 5, timeout: 15 * 60 });
  return toDeepDiveResult(result, Math.round((Date.now() - started) / 1000));
}

/** Start the agent and return its job id without waiting. */
export async function startDeepDive(client: Firecrawl, input: DeepDiveInput, opts: DeepDiveOptions = {}): Promise<string> {
  const job = await client.startAgent(agentArgs(input, opts));
  if (!job.success || !job.id) throw new Error(`agent did not start: ${job.error ?? "no job id"}`);
  return job.id;
}

/**
 * Poll a started job for up to `budgetSeconds`, then hand back whatever it is: finished, or still
 * processing for the caller to poll again from a fresh step. `startedAt` (epoch ms) dates the run.
 */
export async function awaitDeepDive(
  client: Firecrawl,
  jobId: string,
  startedAt: number,
  opts: { budgetSeconds?: number; pollSeconds?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DeepDiveResult> {
  const budget = (opts.budgetSeconds ?? 480) * 1000;
  const poll = (opts.pollSeconds ?? 10) * 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = Date.now() + budget;
  for (;;) {
    const status = await client.getAgentStatus(jobId);
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    if (status.status !== "processing" || Date.now() + poll > until) return toDeepDiveResult(status, seconds);
    await sleep(poll);
  }
}
