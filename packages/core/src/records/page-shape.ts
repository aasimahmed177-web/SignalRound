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

/** A money figure as a headline writes it: a currency mark and a number, or a number with a scale word and a currency name. */
const HEADLINE_FIGURE =
  /((?:US\$|\$|€|£|¥|₹|₩)\s?\d[\d,.]*\s*(?:billion|bn|million|mn|m|thousand|k)?\b|\d[\d,.]*\s*(?:billion|bn|million|mn|thousand)\s*(?:US dollars|dollars|USD|euros?|EUR|pounds?|GBP|yuan|CNY|rupees?|INR|crore))/gi;

/** Words beside a headline figure that make it money other than a round's: a valuation, revenue, a contract, an exit, a loan. */
const OTHER_MONEY_AFTER =
  /^\s*(?:\S+\s+){0,3}?(?:valuation|valued|arr\b|revenue|run[- ]rate|contracts?\b|exit\b|market cap|loans?\b|facility|debt\b|company\b|unicorn|war chest)/i;
const OTHER_MONEY_BEFORE = /\b(?:valued at|worth|valuation(?: of| to)?|at an?|run[- ]rate of|revenue of|from)\s*$/i;

/**
 * Every amount a headline states, in order, in millions of its currency (as parseAmount reads it), and
 * whether the headline says it is money other than a round's (a valuation, revenue, a contract).
 */
export function headlineAmounts(title: string | null | undefined): Array<{ value: number; currency: string | null; otherMoney: boolean }> {
  if (!title) return [];
  return [...title.matchAll(HEADLINE_FIGURE)].flatMap((m) => {
    const parsed = parseAmount(m[1]);
    if (parsed.value === null) return [];
    const at = m.index ?? 0;
    const otherMoney =
      OTHER_MONEY_AFTER.test(title.slice(at + m[1].length)) || OTHER_MONEY_BEFORE.test(title.slice(Math.max(0, at - 30), at));
    return [{ value: parsed.value, currency: parsed.currency, otherMoney }];
  });
}

/** The first amount a headline states, or null when it states none. */
export function headlineAmount(title: string | null | undefined): { value: number; currency: string | null } | null {
  const m = title ? new RegExp(HEADLINE_FIGURE.source, "i").exec(title) : null;
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
  /**
   * Read every figure the headline states, not only its first (the history lane, whose match against a
   * lead's stage and amount guards what this lets through). Elsewhere the first figure stands: in a
   * week of feed pages, every figure would have let an employee tender offer and a guide's example
   * through as news, which the first figure happened to keep out.
   */
  everyFigure?: boolean;
  /** Separately quoted growth financing or debt that, together with the equity round, explains a combined headline. */
  additionalFinancing?: { value: number; currency: string | null } | null;
}

/**
 * True when the page's shape says this round is history rather than the news the page reports:
 * the page is a single-story article (not a roundup, few rounds) whose headline states amounts, and
 * none of the headline's figures that could be a round's money (not a valuation, revenue, or a
 * contract) sits within 2x of this round's amount in the same currency. A headline often leads with
 * the valuation and names the round second ("Nubank is now worth $4 billion after Tencent's $180
 * million investment"); the round it names is its news. A headline with only other money still
 * contradicts a round far from it, as its first figure always did. Without `everyFigure`, the first
 * figure alone decides.
 */
export function backgroundByPageShape(input: PageShapeInput): boolean {
  if (input.pageKind === "roundup" || input.pageKind === "newsletter") return false;
  if (input.roundsOnPage > ROUNDUP_ROUNDS) return false;
  if (!input.title || ROUNDUP_TITLE.test(input.title)) return false;
  const amount = input.amountValue;
  if (amount === null || amount <= 0) return false;
  const first = headlineAmount(input.title);
  if (!first) return false;
  const side = input.additionalFinancing;
  const far = (headline: { value: number; currency: string | null }) => {
    if (headline.currency && input.amountCurrency && headline.currency !== input.amountCurrency) return false;
    if (
      side &&
      (!headline.currency || !side.currency || headline.currency === side.currency) &&
      Math.abs(headline.value - amount - side.value) <= headline.value * 0.05
    )
      return false;
    return Math.max(headline.value, amount) / Math.min(headline.value, amount) > HEADLINE_AMOUNT_RATIO;
  };
  if (!far(first)) return false;
  if (!input.everyFigure) return true;
  return headlineAmounts(input.title).every(
    (h) => h.otherMoney || far(h) || (h.currency !== null && input.amountCurrency !== null && h.currency !== input.amountCurrency),
  );
}
