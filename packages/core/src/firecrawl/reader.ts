import { generateText, Output } from "ai";
import { z } from "zod";
import type { ReconcileModel } from "../llm/model.ts";
import { cleanInvestors, hasLeadLanguage } from "../records/investors.ts";
import { MONEY_KINDS } from "../records/money-kind.ts";
import { classifyStage, namesCompany, stageWritten } from "../records/normalize.ts";
import { amountInEvidence } from "../records/resolve.ts";
import { AMOUNT_SCOPES, ExtractedRound, FieldQuotes, RoundsPage } from "../records/schema.ts";
import { groundingCheck, pageSentences } from "./extract.ts";

export const QuotedPage = RoundsPage.extend({
  rounds: z.array(
    ExtractedRound.omit({ money_kind_checked: true, issuer_checked: true, certainty_checked: true }).safeExtend({
      amount_scope: z.enum(AMOUNT_SCOPES).nullable(),
      money_kind: z.enum(MONEY_KINDS).optional(),
      money_kind_quote: z.string().nullable().optional(),
      field_quotes: FieldQuotes.safeExtend({ money_kind: z.string().nullable().optional() }),
      financing_total_as_written: z.string().nullable(),
      financing_total_quote: z.string().nullable(),
      valuation_quote: z.string().nullable(),
      debt_quote: z.string().nullable(),
      extension_quote: z.string().nullable().optional(),
    }),
  ),
});

export const QUOTED_READER_PROMPT =
  "Read the funding announcements in this page's markdown. Use the page's own words, not outside knowledge. " +
  "Classify the page and give its own publication date, not the crawl date. Include every round stated by a roundup. " +
  "Distinguish new money from totals, valuation, older rounds and debt. Classify certainty from evidence_quote: announced is closed on the record, reported is closed according to unnamed sources, expected is still in talks, nearing, seeking, or raising. Keep expected and reported rounds, with certainty_quote quoting the sentence. " +
  "For every non-null field copy a short verbatim quote from this page that states that field. " +
  "Give a separate quote for each lead and other investor, and name only investors in this round. " +
  "The date quote can be the page's dateline or its statement of the round's day. " +
  "Null fields need null quotes; empty investor lists need empty quote lists. " +
  "The company and stage always need quotes, including an unlettered 'funding round' label. " +
  "evidence_quote must quote a sentence that names the company and announces the round. " +
  "Return no round when the page states no funding round.";

function supported(value: string | null | undefined, quote: string | null | undefined, markdown: string): boolean {
  return !value || (!!quote && groundingCheck({ evidence_quote: quote }, markdown));
}

/**
 * Whether the round's own words state its label's stage: the stage quote or the round's sentence writes
 * it (stageWritten). On a page of several rounds a stage quote counts only when it names the company,
 * since a roundup's next line is another company's Series A. A quote that is on the page but writes no
 * stage ("today announced $5 million in venture funding" for a "Seed") states none.
 */
function stageQuoted(round: z.infer<typeof QuotedPage>["rounds"][number], several: boolean): boolean {
  const { stage } = classifyStage(round.round_type_as_written);
  const quote = round.field_quotes.stage;
  return (
    stageWritten(stage, round.evidence_quote) ||
    (!!quote && (!several || namesCompany(quote, round.company_name)) && stageWritten(stage, quote))
  );
}

/** An unsupported optional fact abstains; an unsupported round quote drops only that round. */
export function groundQuotedPage(page: z.infer<typeof QuotedPage>, markdown: string): RoundsPage {
  const rounds: RoundsPage["rounds"] = [];
  const sentences = pageSentences(markdown);
  for (const round of page.rounds) {
    const q = round.field_quotes;
    if (!groundingCheck({ evidence_quote: round.evidence_quote }, markdown)) continue;
    if (
      (!supported(round.company_name, q.company, markdown) || !namesCompany(q.company, round.company_name)) &&
      !namesCompany(round.evidence_quote, round.company_name)
    )
      continue;
    const { field_quotes: _quotes, ...result } = round;
    if (!supported(result.round_type_as_written, q.stage, markdown) || !stageQuoted(round, page.rounds.length > 1))
      result.round_type_as_written = "funding round";
    if (!supported(result.company_website, q.website, markdown)) result.company_website = null;
    if (!supported(result.company_description, q.description, markdown)) result.company_description = null;
    if (!supported(result.headquarters, q.headquarters, markdown)) result.headquarters = null;
    if (!supported(result.sector, q.sector, markdown)) result.sector = null;
    if (!supported(result.announced_date, q.date, markdown)) result.announced_date = null;
    if (!supported(result.money_kind_quote, q.money_kind, markdown)) result.money_kind_quote = null;
    if (result.certainty_quote && !groundingCheck({ evidence_quote: result.certainty_quote }, markdown)) result.certainty_quote = null;
    if (
      (!supported(result.amount_as_written, q.amount, markdown) ||
        (result.amount_as_written && !amountInEvidence(result.amount_as_written, q.amount ?? ""))) &&
      !amountInEvidence(result.amount_as_written ?? "", result.evidence_quote)
    ) {
      result.amount_as_written = null;
      result.amount_kind = "unknown";
      result.amount_scope = null;
    }
    if (
      !supported(result.financing_total_as_written, q.financing_total, markdown) ||
      !supported(result.financing_total_as_written, result.financing_total_quote, markdown) ||
      (result.financing_total_as_written && !amountInEvidence(result.financing_total_as_written, q.financing_total ?? ""))
    ) {
      result.financing_total_as_written = null;
      result.financing_total_quote = null;
    }
    if (
      !supported(result.valuation_as_written, q.valuation, markdown) ||
      !supported(result.valuation_as_written, result.valuation_quote, markdown) ||
      (result.valuation_as_written && !amountInEvidence(result.valuation_as_written, q.valuation ?? ""))
    ) {
      result.valuation_as_written = null;
      result.valuation_quote = null;
    }
    const investorSupported = (name: string, entries: typeof q.lead_investors, lead: boolean) => {
      const attributed = (sentence: string) =>
        cleanInvestors({
          lead_investors: lead ? [name] : [],
          other_investors: lead ? [] : [name],
          evidence: sentence,
          amount_as_written: null,
        }).lead_investors.includes(name);
      const quoted = entries.some(
        (entry) =>
          entry.name === name &&
          supported(name, entry.quote, markdown) &&
          namesCompany(entry.quote, name, { share: 1 }) &&
          (!lead || attributed(entry.quote)),
      );
      if (quoted) return true;
      const role = lead
        ? /\b(?:co[ -]?led|led by|lead investor|anchored|leads?)\b/i
        : /\b(?:participat|invest|joined|backed|alongside|included)\w*\b/i;
      return sentences.some(
        (sentence) => namesCompany(sentence, name, { share: 1 }) && role.test(sentence) && (!lead || attributed(sentence)),
      );
    };
    result.lead_investors = result.lead_investors.filter((name) => investorSupported(name, q.lead_investors, true));
    result.other_investors = result.other_investors.filter((name) => investorSupported(name, q.other_investors, false));
    result.lead_evidence = q.lead_investors
      .filter(
        (entry) =>
          result.lead_investors.includes(entry.name) && supported(entry.name, entry.quote, markdown) && hasLeadLanguage(entry.quote),
      )
      .map((entry) => entry.quote);
    if (!supported(result.debt_quote, result.debt_quote, markdown)) result.debt_quote = null;
    rounds.push(result);
  }
  return { page_kind: page.page_kind, page_date: page.page_date, rounds };
}

export async function readQuotedPage(
  markdown: string,
  model: ReconcileModel,
  signal?: AbortSignal,
): Promise<{
  page: RoundsPage | null;
  quoted: z.infer<typeof QuotedPage> | null;
  usage: { input: number; output: number };
}> {
  const result = await generateText({
    abortSignal: signal ?? AbortSignal.timeout(60_000),
    model: model.model,
    output: Output.object({ schema: QuotedPage }),
    prompt: `${QUOTED_READER_PROMPT}\n\n${markdown.slice(0, 30_000)}`,
    providerOptions: model.provider === "gateway" ? { gateway: { zeroDataRetention: true } } : undefined,
    maxRetries: 1,
  });
  return {
    page: result.output ? groundQuotedPage(result.output, markdown) : null,
    quoted: result.output ?? null,
    usage: { input: result.usage.inputTokens ?? 0, output: result.usage.outputTokens ?? 0 },
  };
}
