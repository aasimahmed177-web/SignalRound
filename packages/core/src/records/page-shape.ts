// What the page's own shape says about a round extracted from it. The extractor marks a round
// `is_background` when the page mentions it as history, but that judgment misses: an article about
// one company's $3.7B round also recalls a smaller company's $150M round in passing, and the item comes
// back as news dated to the article. The headline is the page's own statement of what it reports,
// so a round the headline contradicts is background.

import { parseAmount } from "./normalize.ts";
import type { PageKind } from "./schema.ts";

/** A page that reports many rounds by design: each item is its own news, so the headline rule does not apply. */
export const ROUNDUP_TITLE =
  /\b(roundup|round-up|weekly|this week|week in|digest|deals? of the|deals you need|funding news|top \d+|biggest|newsletter|recap|wrap|in brief|briefing|daily|the week)\b/i;

/** Above this many rounds on one page, the page is a list, whatever its title says. */
export const ROUNDUP_ROUNDS = 3;

/** How far a round's amount may sit from the headline's before the page is not about it. */
export const HEADLINE_AMOUNT_RATIO = 2;

/** The first amount a headline states, in millions of its currency (as parseAmount reads it), or null when it states none. */
export function headlineAmount(title: string | null | undefined): { value: number; currency: string | null } | null {
  if (!title) return null;
  const m =
    /((?:US\$|\$|€|£|¥|₹|₩)\s?\d[\d,.]*\s*(?:billion|bn|million|mn|m|thousand|k)?\b|\d[\d,.]*\s*(?:billion|bn|million|mn|thousand)\s*(?:US dollars|dollars|USD|euros?|EUR|pounds?|GBP|yuan|CNY|rupees?|INR|crore))/i.exec(
      title,
    );
  if (!m) return null;
  const parsed = parseAmount(m[1]);
  return parsed.value === null ? null : { value: parsed.value, currency: parsed.currency };
}

export interface PageShapeInput {
  /** The page's title, as the source carries it. */
  title: string | null | undefined;
  /** How many rounds the extraction returned for this page. */
  roundsOnPage: number;
  /** The round's amount as written, and the currency the parser read from it. */
  amountValue: number | null;
  amountCurrency: string | null;
  /** The extractor's reading of the page's kind, when it gave one. A roundup or newsletter reports many rounds by design. */
  pageKind?: PageKind | null;
  /** Separately quoted growth financing or debt that, together with the equity round, explains a combined headline. */
  additionalFinancing?: { value: number; currency: string | null } | null;
}

/**
 * True when the page's shape says this round is history rather than the news the page reports:
 * the page is a single-story article (not a roundup, few rounds) whose headline states an amount,
 * and this round's amount in the same currency is more than 2x away from it.
 */
export function backgroundByPageShape(input: PageShapeInput): boolean {
  if (input.pageKind === "roundup" || input.pageKind === "newsletter") return false;
  if (input.roundsOnPage > ROUNDUP_ROUNDS) return false;
  if (!input.title || ROUNDUP_TITLE.test(input.title)) return false;
  const headline = headlineAmount(input.title);
  if (!headline || input.amountValue === null || input.amountValue <= 0) return false;
  if (headline.currency && input.amountCurrency && headline.currency !== input.amountCurrency) return false;
  const side = input.additionalFinancing;
  if (
    side &&
    (!headline.currency || !side.currency || headline.currency === side.currency) &&
    Math.abs(headline.value - input.amountValue - side.value) <= headline.value * 0.05
  )
    return false;
  const ratio = Math.max(headline.value, input.amountValue) / Math.min(headline.value, input.amountValue);
  return ratio > HEADLINE_AMOUNT_RATIO;
}
