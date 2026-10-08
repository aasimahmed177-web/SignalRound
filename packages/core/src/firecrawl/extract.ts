// One structured extraction per page, with the shared rounds schema.
// 1 credit for the page plus 4 for the json format. A cache hit saves the fetch
// credit but the extraction still runs, so estimates use the full rate.
// https://docs.firecrawl.dev/features/llm-extract

import type { Firecrawl } from "firecrawl";
import { jevCertaintyClassifier, jevIssuerClassifier, jevMoneyClassifier } from "../llm/jev.ts";
import { mixedFinancingScope } from "../records/money-kind.ts";
import type { DateContext } from "../records/normalize.ts";
import {
  classifyStage,
  dateFromUrl,
  hostOf,
  humanizeSlug,
  isArticleUrl,
  namesCompany,
  normalizeCompanyKey,
  parseAmount,
  parseDate,
  parseStatedDate,
  registrableDomain,
  slugWords,
  urlSlug,
} from "../records/normalize.ts";
import type { ExtractedItem } from "../records/resolve.ts";
import { amountInEvidence, DEFAULT_TIMELINE_HOSTS } from "../records/resolve.ts";
import type { ExtractedRound, PageKind, RoundSource } from "../records/schema.ts";
import { ROUNDS_PAGE_PROMPT, RoundsPageLenient, roundsPageJsonSchema } from "../records/schema.ts";
import { namedNearby } from "../records/valuation.ts";
import { extractionCredits, mapLimit } from "./credits.ts";
import { groundQuotedPage, QuotedPage } from "./reader.ts";

export interface ExtractTarget {
  url: string;
  title?: string;
  /** The search result's publish date. The last rung of the date order; the page's own dates outrank it. */
  published?: string;
  query?: string;
}

/** The error a skipped target carries; no credit was spent on it. */
export const NOT_ARTICLE_ERROR = "not an article URL";

export interface ExtractResult {
  items: ExtractedItem[];
  pages: Array<{ url: string; ok: boolean; rounds: number; ungrounded: number; cached: boolean; error?: string }>;
  creditsEstimated: number;
  /** Targets declined before any scrape: site roots, section indexes, paginated lists, directory hosts. */
  notArticle: number;
}

/** What the extractor said about the page as a whole. */
export interface PageReading {
  page_kind: PageKind | null;
  page_date: string | null;
  visible_article_date?: boolean;
}

export interface ExtractOptions {
  concurrency?: number;
  /** Cache age in ms. Default 2 days on Firecrawl's side; 0 forces a live fetch. */
  maxAge?: number;
  onPage?: (page: ExtractResult["pages"][number]) => void;
  /** The scrape's clock, for telling a page's own date from the time it was fetched. */
  now?: Date;
}

/** The parts of a scraped document the title rule reads. */
export interface TitleDoc {
  markdown?: string;
  metadata?: { title?: unknown; ogTitle?: unknown };
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  return s ? s : undefined;
}

/**
 * The article's own title: its Open Graph title, then the first H1 of the markdown, then the
 * page `<title>`, then whatever the caller carried in (the search result's title). A search
 * result's title is the search index's reading of the page, and on some publishers it belongs
 * to a different article than the URL (thesaasnews.com results arrive titled with a sibling
 * post); the page's own metadata is what the site says about itself.
 */
export function articleTitle(doc: TitleDoc, fallback?: string): string | undefined {
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(doc.markdown ?? "")?.[1];
  return text(doc.metadata?.ogTitle) ?? text(h1) ?? text(doc.metadata?.title) ?? text(fallback);
}

function words(value: string): string[] {
  return normalizeCompanyKey(value).split(" ").filter(Boolean);
}

/**
 * True when a title or a slug names the company: at least half of the company key's words appear
 * among the text's words. A headline about a different company does not name this one; "Acme.io
 * raises" names Acme.io; "Acme Research in talks" names Acme Research and Technologies.
 */
export function mentionsCompany(value: string | undefined, companyName: string): boolean {
  return namesCompany(value, companyName);
}

/** The share of the slug's words the title carries: high when the title is this article's own rendering of the slug. */
const TITLE_RENDERS_SLUG = 0.8;

/**
 * The title a source row carries for the rounds it reported. The page's title stands unless it
 * names none of the companies while the URL slug names one: then the slug, humanized, is the
 * title, since a URL is minted for its own article and a title can be copied from a sibling.
 * Two exceptions keep a real title: a roundup, whose slug lists two or more of the companies
 * ("The Week's Top Funding for Robotics" over `robotics-raises-acme-labs-beta-aerial-...`), and a
 * title that carries most of the slug's own words ("The Week's 10 Biggest Funding Rounds" over
 * `biggest-funding-rounds-ai-tools-assistants-instinct`). A company whose key normalizes to
 * nothing counts as named. Returns the title to store.
 */
export function sourceTitle(title: string | undefined, url: string, companyNames: string[]): string | undefined {
  const names = companyNames.filter((n) => words(n).length > 0);
  if (names.length === 0) return title;
  if (names.some((n) => mentionsCompany(title, n))) return title;
  const slug = urlSlug(url);
  const slugText = slugWords(slug).join(" ");
  const namedInSlug = slugText ? names.filter((n) => mentionsCompany(slugText, n)).length : 0;
  if (namedInSlug === 0) return title;
  if (title) {
    if (namedInSlug >= 2) return title;
    const titleWords = new Set(words(title));
    const shared = words(slugText).filter((w) => titleWords.has(w)).length;
    if (shared >= TITLE_RENDERS_SLUG * words(slugText).length) return title;
  }
  return humanizeSlug(slug);
}

/** Lower case, markdown link and image syntax reduced to their text, punctuation gone, whitespace collapsed. */
export function normalizeForGrounding(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const VERBATIM_MIN_CHARS = 40;
const ORDERED_TOKEN_RATIO = 0.85;

/**
 * The share of `quote` tokens that appear in order inside `page`, within a window of a sentence
 * or two (three times the quote's length plus ten tokens). The window keeps a sentence about
 * another company from passing on common words ("raised", "million", "seed") scattered across
 * a long page.
 */
function orderedTokenRatio(quote: string[], page: string[]): number {
  if (quote.length === 0) return 0;
  const span = quote.length * 3 + 10;
  let best = 0;
  for (let start = 0; start < page.length; start++) {
    let q = 0;
    for (let i = start; i < page.length && i < start + span && q < quote.length; i++) if (page[i] === quote[q]) q++;
    if (q > best) best = q;
    if (best === quote.length) break;
  }
  return best / quote.length;
}

/**
 * Whether the round's evidence sentence is in the page's own text. `onlyMainContent` trims most
 * boilerplate, but a related-posts box or a sidebar still yields rounds for other companies; their
 * quotes are not in the article's markdown. Both sides are normalized; a quote of 40 or more
 * characters passes verbatim, and any quote passes when 85 percent of its tokens appear in order
 * within a bounded window (the shorter-quote rule, which also forgives a link or a stray
 * character inside a long sentence). Empty evidence is ungrounded.
 */
export function groundingCheck(round: Pick<ExtractedRound, "evidence_quote">, markdown: string): boolean {
  const quote = normalizeForGrounding(round.evidence_quote ?? "");
  if (!quote) return false;
  const page = normalizeForGrounding(markdown);
  if (quote.length >= VERBATIM_MIN_CHARS && page.includes(quote)) return true;
  return orderedTokenRatio(quote.split(" "), page.split(" ")) >= ORDERED_TOKEN_RATIO;
}

/**
 * The page's rounds as items for the resolver: each carries whether its evidence is in the
 * page's markdown (with no markdown to check against, every round counts as grounded), the
 * page's own kind and date when the extractor read them, and the source, titled once for the
 * page by `sourceTitle` against the companies of its grounded rounds.
 */
/**
 * The city a wire or newspaper dateline opens the article with ("SAN FRANCISCO, Sept. 2, 2026 /PRNewswire/"),
 * read from the first lines of the markdown. It is where the release was issued, not where the company sits.
 */
export function pageDateline(markdown: string | undefined): string | null {
  if (!markdown) return null;
  const head = markdown.split("\n").slice(0, 40).join("\n");
  const m =
    /(?:^|\n)\s*(?:\*\*)?([A-Z][A-Z .'\u2019-]{2,40}?)(?:, [A-Z][A-Za-z.]+)?,?\s*(?:\*\*)?[\s,-]+(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2}, \d{4}|\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]* \d{4})\b/.exec(
      head,
    );
  return m?.[1]?.trim() ?? null;
}

/**
 * Whether the page links the website the extractor gave: the domain must occur as a link target or
 * an explicit URL, never merely as a word in the article. The extractor still writes
 * the name plus ".com" when the page links none: Creem's pages all linked creem.io, the record got
 * creem.com (a rock magazine), and a magazine's company facts rode in on it.
 */
export function websiteOnPage(website: string | null | undefined, markdown: string): boolean {
  const domain = website ? registrableDomain(website) : null;
  if (!domain) return false;
  return [...markdown.matchAll(/(?:\]\(|\bhttps?:\/\/)([^\s)>]+)|\bhttps?:\/\/([^\s)>]+)/gi)].some((match) => {
    const url = match[0].startsWith("](") ? match[1] : match[0];
    return registrableDomain(url?.replace(/[.,;]+$/, "") ?? "") === domain;
  });
}

/** The page's text as sentences: links reduced to their text, emphasis marks gone, split at sentence ends and lines. */
export function pageSentences(markdown: string): string[] {
  const text = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]{1,3}/g, "")
    .replace(/\\/g, "");
  return text
    .split(/\n+|(?<!\b(?:[A-Z]|Inc|Corp|Co|Ltd|Mr|Ms|Mrs|Dr|St|No|Jr|Sr|vs)\.)(?<=[.!?])\s+(?=[A-Z"\u201c(])/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter((x) => x.length > 0);
}

/** A money figure as a page prints it: "$45 million", "US$30M", "€12 million". */
const MONEY_FIGURE = /(?:US\$|[A-Z]{1,2}\$|[$€£]|\b(?:USD|EUR|GBP)\s?)\s?\d[\d.,]*(?:\s*(?:million|billion|mn|bn|m|b)\b)?/g;
const EQUITY_AFTER = /^\s*(?:(?:in|of)\s+)?(?:new\s+|primary\s+)?equity\b/i;
const EQUITY_BEFORE = /\bequity(?:\s+(?:round|funding|financing|investment|capital))?(?:\s+(?:of|totaling|totalling|worth))?\s*$/i;
const DEBT_AFTER =
  /^\s*(?:(?:in|of)\s+)?(?:new\s+|non-dilutive\s+|venture\s+)?(?:debt|credit|loans?|term loans?|equipment financing|project financing|lending)\b/i;
const DEBT_BEFORE =
  /\b(?:debt|credit facility|credit line|line of credit|loan|debt financing|venture debt)(?:\s+(?:of|totaling|totalling))?\s*$/i;

interface Figure {
  text: string;
  value: number;
  currency: string | null;
  sentence: string;
}

/** Every figure in the sentences that the words beside it call equity, or debt. */
function figuresBeside(sentences: string[], after: RegExp, before: RegExp): Figure[] {
  const out: Figure[] = [];
  for (const sentence of sentences) {
    for (const m of sentence.matchAll(MONEY_FIGURE)) {
      const tail = sentence.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 40);
      const head = sentence.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
      if (!after.test(tail) && !before.test(head)) continue;
      const parsed = parseAmount(m[0]);
      if (parsed.value !== null) out.push({ text: m[0].trim(), value: parsed.value, currency: parsed.currency, sentence });
    }
  }
  return out;
}

/**
 * A financing the page splits into equity and debt is its equity: "Solcoa Industries today announced $75
 * million in financing ... The round includes $45 million in equity led by Bain Capital Ventures ... It
 * also includes $30 million in debt and equipment financing". When the extractor gave the total (the
 * equity and the debt figures sum to it) the round becomes the equity figure with its sentence; either
 * way the page's debt sentence rides along as `debt_quote`, so the record notes the debt without counting
 * it. The debt alone is never the round. Null when the page states no such split.
 */
export function equitySplit(
  round: Pick<ExtractedRound, "amount_as_written" | "evidence_quote">,
  markdown: string,
): Pick<ExtractedRound, "amount_as_written" | "evidence_quote" | "debt_quote"> | null {
  const total = parseAmount(round.amount_as_written);
  if (total.value === null) return null;
  const sentences = pageSentences(markdown);
  const equity = figuresBeside(sentences, EQUITY_AFTER, EQUITY_BEFORE).filter((f) => f.currency === total.currency);
  const debt = figuresBeside(sentences, DEBT_AFTER, DEBT_BEFORE).filter((f) => f.currency === total.currency);
  if (equity.length === 0 || debt.length === 0) return null;
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.5, 0.02 * Math.max(a, b));
  for (const e of equity) {
    for (const d of debt) {
      if (e.sentence === d.sentence && e.text === d.text) continue;
      if (near(e.value + d.value, total.value)) return { amount_as_written: e.text, evidence_quote: e.sentence, debt_quote: d.sentence };
      if (near(e.value, total.value)) return { amount_as_written: e.text, evidence_quote: e.sentence, debt_quote: d.sentence };
    }
  }
  return null;
}

/**
 * Labels the extractor writes when the page names no stage ("unknown", "not specified", "N/A", "Funding
 * round; formal stage not disclosed"): the live pass stored Parallax's WSJ round as "unknown" (September
 * 24, 2026). "undisclosed" stays: it is a stage the classifier keeps.
 */
const PLACEHOLDER_LABEL =
  /^(?:unknown|not specified|unspecified|n\/?a|na|none|not stated|not given|no specific round type given|not disclosed|series unknown)$|\b(?:stage|round type)\s+(?:not\s+(?:disclosed|specified|given|stated)|unknown)\b/i;

/** How a lettered or named stage is written on a page, loosely: "Series A", "Serie A", "A round", "seed". */
function stageWrittenOn(stage: string, text: string): boolean {
  const letter = /^series_([a-c])$/.exec(stage)?.[1];
  if (letter)
    return new RegExp(
      `\\bs[e\u00e9]ries?[\\s-]*${letter}(?![a-z])|\\b${letter}[\\s-]*(?:round|runde|ronde)\\b|\\bround[\\s-]*${letter}\\b|${letter}\\+?\\s*\u8f6e|\u30b7\u30ea\u30fc\u30ba\\s*${letter}|\uc2dc\ub9ac\uc988\\s*${letter}`,
      "i",
    ).test(text);
  if (stage === "series_d_plus")
    return /\bs[e\u00e9]ries?[\s-]*[d-j](?![a-z])|[d-j]\+?\s*\u8f6e|\u30b7\u30ea\u30fc\u30ba\s*[d-j]/i.test(text);
  if (stage === "seed") return /\bseed\b|\u79cd\u5b50|\u7a2e\u5b50|\u30b7\u30fc\u30c9|\uc2dc\ub4dc/i.test(text);
  if (stage === "pre_seed") return /\bpre[\s-]*seed\b|\bangel\b|\u5929\u4f7f|\u30a8\u30f3\u30b8\u30a7\u30eb|\uc5d4\uc824/i.test(text);
  return true;
}

/** The words a page uses for a round it does not letter, in the order they are tried against the round's sentence. */
const UNLETTERED_LABEL = /\b(funding round|financing round|fundraise|financing|funding|investment round|investment|round)\b/i;

/**
 * A label the page never writes is the extractor's guess: a Business Wire release that says only "$75
 * million in financing" came back as a "Series A" on one read. A lettered or seed label whose stage
 * appears nowhere on the page becomes what the round's sentence calls the money ("financing"), or
 * "funding round", so the round is placed by its size (routing.ts) and shown as the page wrote it.
 */
export function labelOnPage(label: string, evidence: string | null | undefined, markdown: string): string {
  // The extractor's word for "the page names no stage" is not a label either: the sentence's word is.
  if (PLACEHOLDER_LABEL.test(label.trim())) return UNLETTERED_LABEL.exec(evidence ?? "")?.[1]?.toLowerCase() ?? "funding round";
  const { stage } = classifyStage(label);
  if (!/^(?:series_[a-c]|series_d_plus|seed|pre_seed)$/.test(stage)) return label;
  if (stageWrittenOn(stage, markdown)) return label;
  return UNLETTERED_LABEL.exec(evidence ?? "")?.[1]?.toLowerCase() ?? "funding round";
}

/**
 * The page's own reading of a round, where the markdown can settle it: the label the page writes, the
 * equity half of an equity-and-debt financing, and a debt sentence only when it is on the page.
 */
export function settleOnPage(round: ExtractedRound, markdown: string): ExtractedRound {
  const label = round.round_type_as_written
    ? labelOnPage(round.round_type_as_written, round.evidence_quote, markdown)
    : round.round_type_as_written;
  const split = equitySplit(round, markdown);
  const debtOnPage = round.debt_quote && groundingCheck({ evidence_quote: round.debt_quote }, markdown) ? round.debt_quote : null;
  const sentences = pageSentences(markdown);
  const evidenceAt = sentences.findIndex((sentence) => sentence.includes(round.evidence_quote) || round.evidence_quote.includes(sentence));
  const following = evidenceAt < 0 ? null : (sentences[evidenceAt + 1] ?? null);
  const moneyContext = evidenceAt < 0 ? null : sentences.slice(evidenceAt, evidenceAt + 5).join(" ");
  const mixedScope =
    moneyContext &&
    round.amount_as_written &&
    amountInEvidence(round.amount_as_written, round.evidence_quote) &&
    groundingCheck({ evidence_quote: moneyContext }, markdown)
      ? mixedFinancingScope(moneyContext)
      : null;
  const extension =
    round.extension_quote && groundingCheck({ evidence_quote: round.extension_quote }, markdown)
      ? round.extension_quote
      : following && /\b(?:investment|financing|round|capital|funding)\s+is\s+an?\s+extension\s+of\b/i.test(following)
        ? following
        : null;
  const creditor = /\b(?:from|by)\s+([\p{L}\p{N}&.-]+(?:\s+[\p{L}\p{N}&.-]+){0,4}\s+Credit Partners)\b/iu.exec(round.evidence_quote)?.[1];
  const creditorDebt = creditor
    ? sentences.find((sentence) => sentence.includes(creditor) && /\bprovides?\s+debt financing\b|\bprivate credit\b/i.test(sentence))
    : null;
  // A money field stands only on a sentence that is on the page and states its figure; otherwise it is blank.
  const quoted = (figure: string | null | undefined, quote: string | null | undefined) =>
    Boolean(figure && quote && groundingCheck({ evidence_quote: quote }, markdown) && amountInEvidence(figure, quote));
  const valuationQuote = quoted(round.valuation_as_written, round.valuation_quote)
    ? round.valuation_quote
    : /\b(?:valuation|valued|worth)\b/i.test(round.evidence_quote) && quoted(round.valuation_as_written, round.evidence_quote)
      ? round.evidence_quote
      : null;
  const total = quoted(round.financing_total_as_written, round.financing_total_quote);
  return {
    ...round,
    round_type_as_written: label,
    ...(split ?? { debt_quote: debtOnPage ?? creditorDebt ?? null }),
    extension_quote: extension,
    valuation_as_written: valuationQuote ? round.valuation_as_written : null,
    valuation_quote: valuationQuote,
    financing_total_as_written: mixedScope ? round.amount_as_written : total ? round.financing_total_as_written : null,
    financing_total_quote: mixedScope ? moneyContext : total ? round.financing_total_quote : null,
    amount_scope: mixedScope ?? round.amount_scope,
    money_kind: mixedScope ? "mixed" : round.money_kind,
    money_kind_quote: mixedScope
      ? moneyContext
      : round.money_kind_quote && groundingCheck({ evidence_quote: round.money_kind_quote }, markdown)
        ? round.money_kind_quote
        : null,
    certainty_quote:
      round.certainty_quote && groundingCheck({ evidence_quote: round.certainty_quote }, markdown) ? round.certainty_quote : null,
    issuer_quote: round.issuer_quote && groundingCheck({ evidence_quote: round.issuer_quote }, markdown) ? round.issuer_quote : null,
  };
}

/** Exchanges a release names a listed company's ticker on: "(Nasdaq: CELU)", "(TSXV: ABC)". */
const TICKER =
  /^\((?:nasdaq|nyse(?: american| arca)?|tsx(?:v|-v| venture)?|cse|asx|lse|aim|otc(?:qb|qx| pink| markets)?|euronext|six|hkex|sgx|kosdaq|krx|bse|nse|cboe)\s*:\s*[A-Z0-9.]{1,8}\)/i;

/** Whether the page prints a ticker right after the company's name: the company is listed, not venture-backed. */
export function listedOnPage(companyName: string | null | undefined, markdown: string): boolean {
  const first = (companyName ?? "")
    .trim()
    .split(/\s+/)[0]
    ?.replace(/[^\p{L}\p{N}&.-]/gu, "");
  if (!first || first.length < 3) return false;
  const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const text = markdown.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_]/g, "");
  for (const m of text.matchAll(new RegExp(escaped, "gi"))) {
    // The ticker's parenthesis opens within a few words of the name ("Celularity Inc. (Nasdaq: CELU)").
    const tail = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 80);
    const open = /^[^()\n]{0,40}\(/.exec(tail);
    if (open && TICKER.test(tail.slice(open[0].length - 1))) return true;
  }
  return false;
}

export function pageItems(
  extracted: ExtractedRound[],
  source: RoundSource,
  markdown: string | undefined,
  page: PageReading = { page_kind: null, page_date: null },
): ExtractedItem[] {
  // A website the page never names is a guess, and a guess at a namesake's domain is worse than none.
  const rounds = extracted.map((round) => {
    if (markdown === undefined) return { ...round, company_website: null };
    const settled = settleOnPage(round, markdown);
    return settled.company_website && !websiteOnPage(settled.company_website, markdown) ? { ...settled, company_website: null } : settled;
  });
  const grounded = rounds.map((round) => (markdown === undefined ? undefined : groundingCheck(round, markdown)));
  const dateline = pageDateline(markdown);
  const companies = rounds.filter((_, i) => grounded[i] !== false).map((r) => r.company_name);
  const titled = { ...source, title: sourceTitle(source.title, source.url, companies) };
  return rounds.map((round, i) => ({
    round,
    source: titled,
    ...(grounded[i] === undefined ? {} : { grounded: grounded[i] }),
    ...(page.page_kind === null ? {} : { page_kind: page.page_kind }),
    ...(page.page_date === null ? {} : { page_date: page.page_date }),
    ...(page.visible_article_date ? { visible_article_date: true } : {}),
    ...(dateline === null ? {} : { dateline }),
    ...(markdown !== undefined && round.valuation_quote && namedNearby(round.valuation_quote, markdown, source.title, round.company_name)
      ? { valuation_named: true }
      : {}),
    ...(markdown !== undefined && listedOnPage(round.company_name, markdown) ? { listed: true } : {}),
  }));
}

/** A day this close to the scrape is the clock's, unless the page's own text writes it. */
const CLOCK_SLACK_MS = 36 * 3_600_000;

const MONTH_NAMES = [
  ["january", "jan"],
  ["february", "feb"],
  ["march", "mar"],
  ["april", "apr"],
  ["may", "may"],
  ["june", "jun"],
  ["july", "jul"],
  ["august", "aug"],
  ["september", "sept?"],
  ["october", "oct"],
  ["november", "nov"],
  ["december", "dec"],
];

/**
 * Whether the page's text writes this day: ISO or slashed ("2026-09-25", "2026/09/25"), a month and a
 * day either way round with or without the year ("September 25, 2026", "25 Sept 2026", "Sep. 25"), or
 * numeric with the year ("09/25/2026", "25.09.2026"). Pure.
 */
export function textWritesDay(markdown: string, day: Date): boolean {
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth() + 1;
  const d = day.getUTCDate();
  const [full, abbr] = MONTH_NAMES[m - 1] as [string, string];
  const pad = (n: number) => String(n).padStart(2, "0");
  const dd = `0?${d}`;
  const mm = `0?${m}`;
  const month = `(?:${full}|${abbr}\\.?)`;
  const forms = [
    `\\b${y}[-/]${pad(m)}[-/]${pad(d)}\\b`,
    `\\b${month}\\s+${dd}(?:st|nd|rd|th)?\\b`,
    `\\b${dd}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${month}\\b`,
    `\\b${mm}/${dd}/${y}\\b`,
    `\\b${dd}[./]${mm}[./]${y}\\b`,
  ];
  return forms.some((f) => new RegExp(f, "i").test(markdown));
}

/**
 * A date the page does not write that falls within a day and a half of the scrape is the clock's, not
 * the page's: a CMS that stamps an index or an evergreen page with the time it rendered (antidote.me's
 * 2017 press page, FinancialIT's "Fundraising News" index), or the extractor answering "today" for a page
 * that states no date. It becomes no date, so the round is undated rather than dated to its crawl. Pure.
 */
export function offClock(value: string | null | undefined, markdown: string | undefined, now: Date): string | null {
  if (!value) return null;
  if (markdown === undefined) return value;
  const day = parseDate(value, now);
  if (!day || Math.abs(now.getTime() - day.getTime()) > CLOCK_SLACK_MS) return value;
  return textWritesDay(markdown, day) ? value : null;
}

/**
 * Whether the page writes this day together with its year: ISO, numeric with the year, a month and day
 * with the year after it ("Oct. 9, 2023", "9 October 2023"), or the month and year alone ("October 2023"). Pure.
 */
function textWritesDayWithYear(markdown: string, day: Date): boolean {
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth() + 1;
  const d = day.getUTCDate();
  const [full, abbr] = MONTH_NAMES[m - 1] as [string, string];
  const pad = (n: number) => String(n).padStart(2, "0");
  const dd = `0?${d}`;
  const mm = `0?${m}`;
  const month = `(?:${full}|${abbr}\\.?)`;
  const forms = [
    `\\b${y}[-/]${pad(m)}[-/]${pad(d)}\\b`,
    `\\b${month}\\s+${dd}(?:st|nd|rd|th)?,?\\s+${y}\\b`,
    `\\b${dd}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${month},?\\s+${y}\\b`,
    `\\b${month},?\\s+${y}\\b`,
    `\\b${mm}/${dd}/${y}\\b`,
    `\\b${dd}[./]${mm}[./]${y}\\b`,
  ];
  return forms.some((f) => new RegExp(f, "i").test(markdown));
}

/**
 * The extractor answers a year the page leaves out with one of its own: an October 2026 story with no
 * year near its date read as October 2023. A day the extractor gave is kept when the page writes it with
 * its year, or when its year is the year of the page's own day (its byline, metadata, URL, or search
 * result), or the round's own sentence names it ("its 2023 seed"), or, for a page with no day of its own,
 * a year the page writes. Otherwise it is no date, and the page's own day answers in its place. Pure.
 */
export function guessedYear(
  value: string | null | undefined,
  markdown: string | undefined,
  pageDay: Date | null,
  now: Date,
  sentence = "",
): string | null {
  if (!value) return null;
  if (markdown === undefined) return value;
  const day = parseDate(value, now);
  if (!day || textWritesDayWithYear(markdown, day)) return value;
  const year = day.getUTCFullYear();
  if (new RegExp(`\\b${year}\\b`).test(sentence)) return value;
  if (pageDay) return pageDay.getUTCFullYear() === year ? value : null;
  return new RegExp(`\\b${year}\\b`).test(markdown) ? value : null;
}

/** A metadata value as text; a meta tag that appears twice arrives as an array, and its first value is the one. */
function metadataString(doc: { metadata?: Record<string, unknown> }, key: string): string | undefined {
  const value = doc.metadata?.[key];
  return text(Array.isArray(value) ? value[0] : value);
}

/** A newsroom article's printed publication day immediately below its headline. */
export function visibleArticleDate(markdown: string | undefined, ctx: DateContext = {}): string | null {
  if (!markdown) return null;
  const lines = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = lines.findIndex((line) => /^#\s+\S/.test(line));
  if (heading < 0) return null;
  for (const line of lines.slice(heading + 1, heading + 5)) {
    const plain = line.replace(/^[*_]+|[*_]+$/g, "").trim();
    if (/^(?:updated|last modified)\b/i.test(plain)) continue;
    const day = parseStatedDate(plain, ctx);
    if (day && plain.length <= 40) return day.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Extract every target that can be an article. A site root, a section index, a paginated list, or
 * a page on a directory host is declined before any scrape (the callers build targets from search
 * results, section pages, and monitor alerts, and all of those carry such URLs) and counted on
 * the result as `notArticle`, with a failed page entry so the caller sees it was not read.
 */
export async function extractRounds(client: Firecrawl, targets: ExtractTarget[], opts: ExtractOptions = {}): Promise<ExtractResult> {
  const items: ExtractedItem[] = [];
  const pages: ExtractResult["pages"] = [];
  let notArticle = 0;
  const checkMoney = jevMoneyClassifier();
  const checkIssuer = jevIssuerClassifier();
  const checkCertainty = jevCertaintyClassifier();

  await mapLimit(targets, opts.concurrency ?? 8, async (t) => {
    if (!isArticleUrl(t.url)) {
      notArticle++;
      const page = { url: t.url, ok: false, rounds: 0, ungrounded: 0, cached: false, error: NOT_ARTICLE_ERROR };
      pages.push(page);
      opts.onPage?.(page);
      return;
    }
    try {
      const doc = await client.scrape(t.url, {
        // The markdown is the grounding text for every round. It costs nothing extra: the json
        // format's 5 credits already pay for the page, and a second format on the same scrape is free.
        formats: ["markdown", { type: "json", schema: roundsPageJsonSchema, prompt: ROUNDS_PAGE_PROMPT }],
        onlyMainContent: true,
        timeout: 60_000,
        ...(opts.maxAge !== undefined ? { maxAge: opts.maxAge } : {}),
      });
      const quoted = QuotedPage.safeParse(doc.json);
      const parsed = RoundsPageLenient.safeParse(quoted.success ? groundQuotedPage(quoted.data, doc.markdown ?? "") : doc.json);
      const now = opts.now ?? new Date();
      // The page's own publish date: its published-time metadata when the publisher set it (the
      // CMS wrote it, so it is never a year read off a navigation menu, which the extractor has
      // done), else the dateline or byline the extractor read. The search result's date stays on
      // the source as the last rung.
      const metadataPublished =
        offClock(metadataString(doc, "publishedTime") ?? metadataString(doc, "article:published_time"), doc.markdown, now) ?? undefined;
      // A numeric byline both orders could read ("08-10-2026") takes the one the page's other dates, or the clock, support.
      const pageDates = { agree: [parseDate(metadataPublished, now), dateFromUrl(t.url)], near: now };
      const visible = offClock(visibleArticleDate(doc.markdown, pageDates), doc.markdown, now);
      // What the page says of its own day without the extractor: the year a guessed year is held to.
      const ownDay = parseDate(visible ?? metadataPublished, now) ?? dateFromUrl(t.url) ?? parseDate(t.published, now, pageDates);
      // A day the page does not write, on the scrape's own day, is the clock's (offClock), and a year
      // the page never gives is the extractor's (guessedYear): no date either way.
      const rounds = await mapLimit(parsed.success ? parsed.data.rounds : [], 8, async (r) => ({
        ...r,
        announced_date: guessedYear(offClock(r.announced_date, doc.markdown, now), doc.markdown, ownDay, now, r.evidence_quote ?? ""),
        money_kind_checked:
          checkMoney && r.amount_as_written && r.money_kind_quote ? await checkMoney(r.money_kind_quote, r.amount_as_written) : null,
        certainty_checked: checkCertainty ? await checkCertainty(r.evidence_quote) : null,
        issuer_checked: checkIssuer
          ? await checkIssuer(
              r.company_name,
              r.issuer_quote && doc.markdown && groundingCheck({ evidence_quote: r.issuer_quote }, doc.markdown) ? r.issuer_quote : null,
              r.evidence_quote,
            )
          : null,
      }));
      const reading: PageReading = {
        page_kind: parsed.success ? parsed.data.page_kind : null,
        page_date:
          visible ??
          metadataPublished ??
          guessedYear(offClock(parsed.success ? parsed.data.page_date : null, doc.markdown, now), doc.markdown, ownDay, now),
        visible_article_date: Boolean(visible),
      };
      const published = visible ?? metadataPublished ?? t.published;
      // An X timeline is not an article: its label ("@handle on X") stays; every other page is titled by itself.
      const timeline = DEFAULT_TIMELINE_HOSTS.includes(registrableDomain(t.url) ?? "");
      const title = timeline ? t.title : articleTitle(doc as TitleDoc, t.title);
      const source: RoundSource = { url: t.url, host: hostOf(t.url), title, published, query: t.query };
      const pageRounds = pageItems(rounds, source, doc.markdown, reading);
      items.push(...pageRounds);
      const page = {
        url: t.url,
        ok: true,
        rounds: rounds.length,
        ungrounded: pageRounds.filter((i) => i.grounded === false).length,
        cached: doc.metadata?.cacheState === "hit",
        error: parsed.success ? undefined : parsed.error.message,
      };
      pages.push(page);
      opts.onPage?.(page);
    } catch (err) {
      const page = {
        url: t.url,
        ok: false,
        rounds: 0,
        ungrounded: 0,
        cached: false,
        error: err instanceof Error ? err.message : String(err),
      };
      pages.push(page);
      opts.onPage?.(page);
    }
  });

  const scraped = pages.filter((p) => p.ok);
  return { items, pages, creditsEstimated: extractionCredits(scraped.map((p) => p.url)), notArticle };
}
