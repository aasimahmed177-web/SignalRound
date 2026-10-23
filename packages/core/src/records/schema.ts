// The one definition of a funding-round record, in Zod 4.
// Three artifacts derive from it: TypeScript types, the JSON Schema NativeWebClient's
// `json` format and `/agent` extract against, and (via db/schema.ts) the tables.

import { z } from "zod";
import type { RoundCertainty } from "./certainty.ts";
import type { PriorRound } from "./history.ts";
import { ISSUER_TYPES, MONEY_KINDS } from "./money-kind.ts";
import { SECTOR_HINT, SECTORS } from "./sectors.ts";
import type { Stage } from "./stages.ts";
import type { ValuationClaim } from "./valuation.ts";

export { STAGES, type Stage } from "./stages.ts";

/** What the money figure on the page actually is. Round amounts and valuations get confused constantly. */
export const AMOUNT_KINDS = ["round", "total_funding", "valuation", "unknown"] as const;
export type AmountKind = (typeof AMOUNT_KINDS)[number];

/** What a round's amount covers: new money added to a round, the whole round, or a financing announced in tranches, all of it. */
export const AMOUNT_SCOPES = [
  "tranche",
  "round",
  "financing_total",
  "includes_grants",
  "includes_secondary",
  "combined_rounds",
  "cumulative",
] as const;
export type AmountScope = (typeof AMOUNT_SCOPES)[number];

const nullableString = z.string().nullable();
const quotedInvestor = z.object({
  name: z.string(),
  quote: z.string().describe("The page's own words placing this investor in this round and this role."),
});
export const FieldQuotes = z.object({
  company: z.string().describe("Verbatim text identifying the company that raised this round."),
  website: nullableString.describe("Verbatim text or link stating the company's website, null if unstated."),
  description: nullableString.describe("Verbatim text describing what this company does, null if unstated."),
  stage: z.string().describe("Verbatim text naming this round's stage or its unlettered funding label."),
  amount: nullableString.describe("Verbatim text containing the new-money amount, null if unstated."),
  money_kind: nullableString
    .optional()
    .describe(
      "Verbatim sentence identifying whether this figure is primary new money, a tranche, combined rounds, a cumulative total, a commitment, a secondary sale, an IPO allocation, debt, a grant, or internal spending.",
    ),
  financing_total: nullableString.describe("Verbatim text containing this series' running total, null if unstated."),
  valuation: nullableString.describe("Verbatim text stating this round's valuation, null if unstated."),
  date: nullableString.describe("Verbatim dateline or text dating this round, null if unstated."),
  headquarters: nullableString.describe("Verbatim text locating the company itself, null if unstated."),
  sector: nullableString.describe("Verbatim text describing the company's sector, null if unstated."),
  lead_investors: z.array(quotedInvestor).describe("One name and verbatim lead-language quote for each lead investor."),
  other_investors: z.array(quotedInvestor).describe("One name and verbatim participation quote for each other investor."),
});

/**
 * One funding round as extracted from one page. Field descriptions are the
 * extraction prompt: NativeWebClient's guidance is short prompts, constraints in the
 * schema, enums for fixed values, "null if not stated" on every optional field.
 */
export const ExtractedRound = z.object({
  company_name: z
    .string()
    .describe(
      "The company that raised the round. On an investor's own announcement ('X invests in Y', 'X leads Y's Series A'), Y, never the investor X.",
    ),
  company_website: nullableString.describe(
    "The company's own homepage URL if the page states or links it. Never the URL of this article. Null if not stated.",
  ),
  company_description: nullableString.describe(
    "What the company is or does, as a noun phrase or an 'X is a ...' sentence, for example 'a carbon capture company using molten salt'. Never what the money is for, never a use-of-funds clause. Null if the page does not say.",
  ),
  issuer_type: z
    .enum(ISSUER_TYPES)
    .optional()
    .describe(
      "Classify who receives this money: operating_company (a private company funding its operations), fund (a VC or private equity fund raising LP commitments), listed_company (a public company's offering), government_program, or unknown. A fund close or a listed company's QIP is not a startup round.",
    ),
  issuer_quote: nullableString
    .optional()
    .describe("Verbatim company line identifying the issuer as a fund, a listed company, or a government programme; null if unstated."),
  issuer_checked: z.enum(ISSUER_TYPES).nullable().optional().describe("Independent Jev issuer reading, if available."),
  round_type_as_written: z
    .string()
    .describe(
      'The round label exactly as written on the page, for example Series A, Series B extension, Seed, Series B-1. The label only, never the amount: for "USD 150 million funding round" write funding round',
    ),
  amount_as_written: nullableString.describe(
    'The money raised in this round, in the currency the company announced, as printed, with any conversion in parentheses after it, for example $46 million, EUR 15M, or NZ$2 million (AU$1.64 million). It must appear in evidence_quote. Never a contract, partnership, or deal value, a total raised to date, or a valuation. When the page splits the financing into equity and debt (a loan, a credit facility, venture debt, equipment financing), the equity figure alone, and evidence_quote is the sentence that states it. When the page announces new money added to a round (an extension, a second close) and also a running total for the series or the company ("bringing the total Series D-2 raised to $110 million"), the new money, never the total. When the page announces one financing split into tranches or sub-series at once ("an $875 million Series C financing, comprising a $375 million Series C and a $500 million Series C-1"), the financing\'s total. Null if the round\'s amount is not stated.',
  ),
  amount_kind: z
    .enum(AMOUNT_KINDS)
    .describe("What amount_as_written is: the round just raised, the company's total funding to date, a valuation, or unknown"),
  money_kind: z
    .enum(MONEY_KINDS)
    .optional()
    .describe(
      "What the evidence sentence's amount actually represents. Only primary and tranche can supply this round's amount. Combined separate rounds have an aggregate financing total but no per-round amount unless each is stated.",
    ),
  money_kind_quote: nullableString.optional().describe("The exact evidence sentence classifying the money, null if no amount is stated."),
  money_kind_checked: z
    .enum(MONEY_KINDS)
    .nullable()
    .optional()
    .describe("Independent Jev reading of money_kind_quote, when available; otherwise null."),
  amount_scope: z
    .enum(AMOUNT_SCOPES)
    .nullable()
    .optional()
    .describe(
      "What the reported figure covers: tranche, round, financing_total (all new money), includes_grants, includes_secondary, combined_rounds, or cumulative (funding to date). The last four scopes refer to financing_total_as_written, not new primary amount.",
    ),
  financing_total_as_written: nullableString
    .optional()
    .describe(
      "A total the page states beside new money or in place of an isolated primary figure, exactly as written: a series running total, one financing announced in tranches, primary money combined with grants or secondary sales, or cumulative funding to date. Never a valuation. Null if the page states none.",
    ),
  financing_total_quote: nullableString
    .optional()
    .describe("The exact sentence that states financing_total_as_written. Null when that is null."),
  valuation_as_written: nullableString.describe(
    "The company's valuation at this round (pre- or post-money) exactly as written, only when the page states it for this round. Never a valuation an earlier or later round reached that the page recalls (\"became a unicorn in May with a $160 million Series B at a $1.3 billion valuation\" in a story about a later round), a total raised to date, or a series' running total. Null if the page states no valuation for this round.",
  ),
  valuation_quote: nullableString
    .optional()
    .describe("The exact sentence that states valuation_as_written for this round. Null when that is null."),
  debt_quote: nullableString
    .optional()
    .describe(
      "When the page announces debt, a loan, a credit facility, or equipment financing together with this equity round, the exact sentence that states the debt. Null if none.",
    ),
  extension_quote: nullableString
    .optional()
    .describe("Exact sentence saying this investment extends an earlier named round; null if the page does not say so."),
  lead_investors: z
    .array(z.string())
    .describe(
      "Only firms the page says led or co-led this round ('led by', 'co-led by', 'lead investor', 'was a leader in'). A firm named after 'with participation from', 'joined by', 'backed by', 'investors include', 'participants included', or 'also invested' is not a lead. One entry per firm, the fuller form of its name, no descriptors ('angel investor X' is X), never a placeholder ('other investors'), never a lender on a credit facility, never a person's employer named as background. Empty if the page names no lead.",
    ),
  other_investors: z
    .array(z.string())
    .describe(
      "Other firms and angels the page names as investing in this round. An existing investor belongs here only when the page says it joined this round ('with participation from existing investors X and Y'). One entry per firm, the fuller form, no duplicates of a lead under another spelling, no placeholders, no partners or customers, no earlier-round backers the page mentions as history, and no company backers listed as background rather than as this round's ('the company's investors include', 'is also backed by', 'existing investors include', 'counts X among its backers'). Empty if none named.",
    ),
  announced_date: nullableString.describe(
    "The date this round was announced, YYYY-MM-DD. Read the whole page: a dateline, 'announced on', 'Funding Date', a byline. Resolve relative phrases against the page's own date: 'today' is the page date, 'yesterday' the day before, 'announced Wednesday' the most recent Wednesday on or before the page date, 'last week' about seven days before. Never invent a day: when the page gives only a month or a season, or does not date the round, return null and let is_background say whether the round is history.",
  ),
  headquarters: nullableString.describe(
    "City and country only where the page says the company is based or headquartered ('Abu Dhabi-based', 'headquartered in Elche'). Never a dateline, a byline, an acquired company's city, or a site header. Null otherwise.",
  ),
  sector: z
    .enum(SECTORS)
    .nullable()
    .describe(
      `The closest sector from the list for what the company does (${SECTOR_HINT}); other if none fits; null if the page says nothing about it.`,
    ),
  evidence_quote: z
    .string()
    .describe(
      "The exact sentence from the page that states this round and, when one is given, its amount. When the amount is in the headline and not in the body, quote the headline. Copy verbatim.",
    ),
  source_url: nullableString.describe(
    "When the page lists several items that each have their own link (a timeline of posts, a newsletter, a roundup), the URL of the item that states this round, exactly as printed on the page. Null when the page itself is the article.",
  ),
  is_background: z
    .boolean()
    .describe(
      "true when the page mentions this round as history or context rather than as the news it reports: an earlier round recalled in a profile, an acquisition or partnership story, a follow-on article ('which raised a Series A in June'), a rival's past raise, a company explainer or a standard-deal description (Y Combinator's terms are not a round). False only when this page's news is this round.",
    ),
  is_rumor: z
    .boolean()
    .describe(
      "true when the page says the round is in talks, being raised, sought, planned, reported by unnamed sources, or not yet closed",
    ),
  certainty: z
    .enum(["announced", "reported", "expected"])
    .optional()
    .describe(
      "announced when closed on the record; reported when press says it closed citing unnamed sources; expected when in talks, nearing, seeking, raising, or not yet closed. Classify the evidence sentence, not a headline's speculation.",
    ),
  certainty_quote: nullableString.optional().describe("Exact evidence sentence supporting certainty, null if no sentence states it."),
  certainty_checked: z.enum(["announced", "reported", "expected"]).nullable().optional(),
  field_quotes: FieldQuotes.optional().describe("One source quote for every stated field. Required in new NativeWebClient readings."),
  lead_evidence: z.array(z.string()).optional().describe("Grounded lead sentences retained by the quoted reader for role validation."),
});
export type ExtractedRound = z.infer<typeof ExtractedRound>;

/**
 * What kind of page this is. Rounds are news only on the first four; a listing, a profile, or an
 * analysis mentions rounds as data or history, and the resolver drops them.
 */
export const PAGE_KINDS = ["article", "press_release", "roundup", "newsletter", "listing", "profile", "analysis", "other"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** The kinds a round is news on. */
export const NEWS_PAGE_KINDS: ReadonlySet<PageKind> = new Set<PageKind>(["article", "press_release", "roundup", "newsletter"]);

const pageKind = z
  .enum(PAGE_KINDS)
  .describe(
    "What this page is: article (one news story), press_release (the company's or a wire's own release), roundup (one dated post covering several deals), newsletter (an issue with several items), listing (an index of many items with links: a section page, a tag page, a funding-rounds table, a directory), profile (a company or investor page, a portfolio or deal-sourcing page, a law firm's credentials), analysis (a retrospective, a market report, an acquisition or competitor story that recounts old rounds), other.",
  );
const pageDate = nullableString.describe(
  "The date this page itself states it was published, YYYY-MM-DD: its dateline, byline, or the first date in the article header. Not a site clock, not a 'last updated' stamp, not a date inside the body. Null if the page shows none.",
);

/** What one page yields. A roundup article carries many rounds; a press release carries one. */
export const RoundsPage = z.object({
  page_kind: pageKind,
  page_date: pageDate,
  rounds: z.array(ExtractedRound).describe("Every venture funding round this page reports, one entry per company. Empty if none."),
});
export type RoundsPage = z.infer<typeof RoundsPage>;

/**
 * What the parse accepts: a page whose kind or date the extractor left out still yields its
 * rounds, with the missing field null (the resolver treats an unknown kind as an article).
 */
export const RoundsPageLenient = RoundsPage.extend({
  page_kind: z.enum(PAGE_KINDS).nullable().catch(null),
  page_date: nullableString.catch(null),
});

/** JSON Schema handed to NativeWebClient (`formats: [{ type: "json", schema }]` and `/agent`). */
export const roundsPageJsonSchema = z.toJSONSchema(
  RoundsPage.safeExtend({
    rounds: z.array(
      ExtractedRound.omit({ money_kind_checked: true, issuer_checked: true, certainty_checked: true }).safeExtend({
        amount_scope: z.enum(AMOUNT_SCOPES).nullable(),
        money_kind: z.enum(MONEY_KINDS),
        money_kind_quote: nullableString,
        issuer_type: z.enum(ISSUER_TYPES),
        issuer_quote: nullableString,
        financing_total_as_written: nullableString,
        financing_total_quote: nullableString,
        valuation_quote: nullableString,
        debt_quote: nullableString,
        extension_quote: nullableString,
        field_quotes: FieldQuotes,
      }),
    ),
  }),
  { target: "draft-07", io: "output" },
);

export const ROUNDS_PAGE_PROMPT =
  "First say what kind of page this is (page_kind) and the date the page states it was published (page_date). " +
  "List every venture funding round this page reports, one entry per company. " +
  "Only include rounds the page explicitly states; do not infer or add rounds from memory. " +
  "For each candidate distinguish a private operating company raising growth capital from a VC fund's close, a listed company's public share issue, and a government programme. Include candidates that are not startup rounds so issuer_type and issuer_quote can explain their rejection downstream. " +
  "Read dates from the article's header and body only: a year in a navigation menu, a sidebar, a footer, or a link to another story is not this page's date or this round's date; when the body gives no date for the round, announced_date is null. " +
  "If the page is a roundup or list, include every company it names with a round. " +
  "Investors are this round's only: the company's existing or earlier backers, listed as background, are not this round's investors unless the page says they joined it. " +
  "If the page is a timeline of posts, source_url is the post's own URL on this site (the status link), not a link inside the post; a post that only lists past rounds does not date them. " +
  "Return null for any field the page does not state. " +
  "For every stated field include a short verbatim quote from this page in field_quotes. " +
  "Give each investor its own quote placing it in this round, and each lead's quote must say it led. " +
  "An unstated field gets a null quote and an empty investor list gets an empty quote list. " +
  "The amount quote must contain the amount, and the valuation quote must state this round's valuation rather than another round's. " +
  "Classify certainty from the round's verbatim evidence sentence: announced is a closed round on the record; reported is a round said to have closed by press citing unnamed sources; expected has not closed (in talks, nearing, closing in on, seeking, or raising). Include the exact supporting sentence in certainty_quote. " +
  "Classify the figure in its own sentence, not another number nearby: only new primary equity, SAFE, or convertible financing and its closing tranche is a round amount. A combined pre-seed and seed aggregate, or a total combining primary with grants or secondary sales, has no isolated primary amount: put the figure in financing_total_as_written with its quote and scope. Keep cumulative funding out of valuation. Exclude secondary-only sales, IPO allocations, internal spending, the cost of a plant or project the round helps pay for, future commitments, grants, and debt-only or other non-dilutive financing.";

/** Where a round was seen. One record carries every source that reported it. */
export interface RoundSource {
  url: string;
  host: string;
  /** The page's title as read, never a later reading of the same URL (a front page's headline changes by the hour). */
  title?: string;
  published?: string;
  query?: string;
  /** The evidence sentence this reading took from the page: what places the company on it (see sourceFit). */
  evidence?: string;
}

/** Money as stored: the original figure, its currency, and a reproducible USD conversion. */
export interface Money {
  value: number | null;
  currency: string | null;
  as_written: string | null;
  usd_millions: number | null;
  fx_rate: number | null;
  fx_date: string | null;
}

/** A deduped, dated, scored record: one company, one round, every source. */
export type DatePrecision = "day" | "week" | "month" | "unknown";

/** Higher is surer; a merge lets a surer date replace a rougher one and never the reverse. */
export const DATE_PRECISION_RANK: Record<DatePrecision, number> = { day: 3, week: 2, month: 1, unknown: 0 };

export interface FeedRecord {
  id: string;
  company_key: string;
  company_name: string;
  company_domain: string | null;
  company_website: string | null;
  company_description: string | null;
  /** Other names the company is known by (a former name, the legal name), so a page that uses one reads as this company's. */
  company_aliases?: string[];
  stage: Stage;
  /** Existing rows with no value predate certainty and are announced. */
  certainty?: RoundCertainty;
  stage_as_written: string;
  is_extension: boolean;
  amount: Money;
  /** What the amount covers, when the page said (AMOUNT_SCOPES). */
  amount_scope?: AmountScope | null;
  financing_stages?: string[];
  /** A larger total the page states beside the new money (a series' running total), with its sentence. Never the amount, never a valuation. */
  financing_total_as_written?: string | null;
  financing_total_quote?: string | null;
  /** The valuation the claims support (pickValuation); null when none is stated for this round. */
  valuation_as_written: string | null;
  /** Every reading's valuation with the sentence and page that state it, checked for this round (valuation.ts). */
  valuation_claims?: ValuationClaim[];
  lead_investors: string[];
  other_investors: string[];
  announced_date: string | null;
  /**
   * How well the date is known. "day": the round's own stated date, or an article's date. "week": the
   * date of the roundup or newsletter the round was read from, so the announcement was inside the
   * period it covers. "month": a monthly list. "unknown": no date.
   */
  date_precision: DatePrecision;
  /**
   * Where the date came from: the round's own stated date ("stated"), the page's byline ("page"), a
   * date in a URL ("url"), the search result ("result"), or nowhere ("none"). A release date among the
   * sources may replace anything but "stated".
   */
  date_basis?: "stated" | "page" | "url" | "result" | "none";
  /**
   * The judge's verdict on this record against its primary page: confirmed (the page says what the
   * record says), corrected (the judge changed a field to what the page says), contradicted (the
   * page's company is not this one), not_news (the page recalls the round as history or is not about
   * a round), skipped (no page to read or the page could not be read), unverified (not judged yet).
   */
  verification?: {
    status: "unverified" | "confirmed" | "corrected" | "contradicted" | "not_news" | "skipped";
    notes: string[];
    url: string | null;
    /** Who verified: "judge" (NativeWebClient's single-page read) or the reconciling model ("gateway:openai/gpt-6-luna"). */
    verifier?: string;
    /** How many pages the verifier actually read (at most MAX_SOURCES, each cut at PAGE_CHARS). */
    sources_seen?: number;
    /** How many sources the record listed when it was read; a row that has gained sources since is reconciled again. */
    sources_listed?: number;
  };
  headquarters: string | null;
  sector: string | null;
  evidence_quotes: string[];
  sources: RoundSource[];
  confidence: number;
  status: "new" | "updated" | "seen";
  /** True when no date was found on the page, in the result, or in the URL. Goes to review, not the feed. */
  undated: boolean;
  /**
   * Why a valuation this record carried was taken off: no source states it for this round, or its only
   * sentence is about another round. Set, the row's stored valuation is cleared too and the row is
   * flagged for a reader, since a valuation is better missing than wrong.
   */
  valuation_ruled_out?: string;
  /**
   * Earlier rounds of the company its page stated beside this one (a stealth launch's seed with its
   * Series A): never news, queued on the history ledger when the record persists.
   */
  earlier_rounds?: PriorRound[];
}
