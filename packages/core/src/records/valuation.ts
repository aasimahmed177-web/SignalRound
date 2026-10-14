// Every money field carries the sentence that states it, and a field whose sentence is not about this
// round is blank: better missing than wrong. An article about a round recalls the company's earlier
// ones beside it, and the extractor can take them: Corgi's $64 million September extension carried
// "$1.3 billion" from "announced it was a unicorn in May with a $160 million Series B at a $1.3 billion
// valuation"; FORE Biotherapeutics' extension carried the series' $110 million running total as a
// valuation; Cyera's $600 million round kept a "$2.7 billion" beside the "$12B" its releases state,
// because the longer string won the merge. The checks here are pure: the extraction applies them to a
// page's reading, the merge ranks what passes, and the repair replays them on stored rows.

import { classifyStage, parseAmount } from "./normalize.ts";
import type { FeedRecord, Stage } from "./schema.ts";
import { textNamesSubject } from "./source-fit.ts";

/** A legal form a company's stored name can end with ("Space Labs d.o.o.", "BigHat Biosciences, Inc."); a sentence names the company without it. */
const LEGAL_FORM =
  /[,\s]+(?:d\.o\.o\.?|d\.d\.?|s\.r\.o\.?|sp\. z o\.o\.?|a\.s\.?|s\.a\.?|s\.a\.s\.?|sas|b\.v\.?|n\.v\.?|gmbh|ag|ab|oy|plc|ltd\.?|limited|llc|inc\.?|corp\.?|corporation|co\.?)$/i;

/** Whether a text names the company by its distinctive words ("Heidi" for Heidi Health, "Nscale" for Neocloud Nscale). */
function names(text: string, company: string): boolean {
  let name = company.trim();
  for (let bare = name.replace(LEGAL_FORM, ""); bare !== name && bare; bare = name.replace(LEGAL_FORM, "")) name = bare;
  return textNamesSubject(text, { name }) || textNamesSubject(text, { name: company });
}

/**
 * A money figure with its unit, the currency before or after it, separators and all: "$1.3 billion",
 * "€15M", "USD 64 million", "₹1,930 crore", "Rs 120 crore", "11.7B€", "$1.5-billion", "500 million US dollars".
 */
const MONEY =
  /(?:(?:US|CA|AU|NZ|HK|S|A|C|R)?\$|[€£¥₹]|\b(?:USD|EUR|GBP|INR|CNY|RMB|JPY|CHF|Rs\.?)\s?)?\d[\d,]*(?:\.\d+)?[\s-]?(?:million|billion|trillion|mn|bn|crore|cr|lakh|m|b)\b(?:\s?(?:€|\$|£|euros?|(?:US |U\.S\. )?dollars?|yuan|rupees?|pounds?))?/gi;
/** A parenthesis that converts the figure before it into another currency: "€1.4 billion ($1.7 billion)". */
const CONVERSION_OPEN = /^\s*\(\s*(?:about|around|roughly|approximately|approx\.?|nearly|some|~|or|equivalent to)?\s*$/i;
/** An "or" that converts it: "a €411 million, or $468 million, funding round". */
const CONVERSION_OR = /^\s*,?\s*or\s+(?:about|around|roughly|approximately|nearly|some)?\s*$/i;
/** A lettered or seed stage a sentence names. */
const STAGE = /\b(?:pre-?seed|seed|series\s+[a-k](?:[-\s]?\d)?)\b/i;
/** Words that make the figure after them a running total, not a valuation (unless a valuation word sits between: "brings its valuation to"). */
const TOTAL_BEFORE = /\b(?:total|to date|cumulative|in all|altogether|so far|bringing|brings|brought)\b[^.]{0,40}$/i;
/** Words that make a figure a valuation. */
const VALUATION_WORD = /valu|worth/i;
/** Qualifiers a figure can carry after the phrase that governs it: "valued at over", "worth about". */
const QUALIFIERS = String.raw`(?:(?:around|about|roughly|approximately|approx\.?|over|nearly|almost|more than|less than|just over|just under|close to|some|at least|an estimated|up to)\s+)*`;
/** A valuation phrase that governs the figure right after it: "values Heidi at", "is now valued at", "valuation of", "lifts the company's valuation to", "now worth". */
const VALUATION_BEFORE = new RegExp(
  String.raw`(?:\bvalu(?:es|ed|ing)\b[^.;$€£¥₹]{0,40}?\bat|\bvaluation\s+(?:of|to|at)|\b(?:now\s+)?worth|\bmarket (?:cap(?:italization)?|value) of)\s+${QUALIFIERS}$`,
  "i",
);
/** A phrase that ties a valuation to another round: "at its Series B in 2024", "in its previous round". */
const TIED =
  /\b(?:series\s+[a-k]\d?|seed|previous|prior|last round|earlier round)\b|\b(?:in|at|during)\s+(?:early |late |mid-)?(?:January|February|March|April|May|June|July|August|September|October|November|December|\d{4})\b/i;
/** Words that make the figure after them an earlier valuation. */
const EARLIER_FIGURE = new RegExp(String.raw`\b(?:up from|down from|previously|compared (?:with|to))\s+${QUALIFIERS}$`, "i");
/** Words that place a sentence at another round than the one announced. */
const EARLIER =
  /\b(?:earlier this year|last year|previous(?:ly)?|prior round|its last round|a year ago|months ago|in its (?:seed|series [a-k]))\b/i;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** The company named by what it is, as a release or an article refers to it after the first mention ("the Paris-based insurtech startup"). */
const REFERENT =
  /\b(?:the|this|that) (?:[\w-]+ ){0,3}(?:company|startup|start-up|firm|business|unicorn|platform|maker|provider|developer|lab|scaleup|scale-up|insurtech|fintech|biotech)\b|\bvalu(?:ing|es|ed) (?:it|the company)\b/i;

const near = (a: number, b: number) => Math.abs(a - b) <= 0.05 * Math.max(a, b);

/** A figure in a sentence: its text, its values (a converted figure in parentheses is the same figure), and where it starts. */
interface Figure {
  text: string;
  values: number[];
  index: number;
}

function figures(sentence: string): Figure[] {
  const found = [...sentence.matchAll(MONEY)].flatMap((m) => {
    const parsed = parseAmount(m[0].replace(/(\d)-(?=[a-z])/i, "$1 "));
    return parsed.value === null
      ? []
      : [{ text: m[0].trim(), value: parsed.value, currency: parsed.currency, index: m.index ?? 0, end: (m.index ?? 0) + m[0].length }];
  });
  const out: Figure[] = [];
  for (let i = 0; i < found.length; i++) {
    const f = found[i];
    const next = found[i + 1];
    // "€1.4 billion ($1.7 billion)": the parenthesis converts the figure, it is not another amount.
    const between = next ? sentence.slice(f.end, next.index) : "";
    const parenthesis = next && CONVERSION_OPEN.test(between) && /^\s*\)/.test(sentence.slice(next.end));
    const or = next && CONVERSION_OR.test(between) && f.currency && next.currency && f.currency !== next.currency;
    if (parenthesis || or) {
      out.push({ text: f.text, values: [f.value, next.value], index: f.index });
      i++;
      continue;
    }
    out.push({ text: f.text, values: [f.value], index: f.index });
  }
  return out;
}

const states = (f: Figure, value: number) => f.values.some((v) => near(v, value));

/** The round a money field is checked against: its company, stage, amount (millions), and day. */
export interface RoundContext {
  company: string;
  stage: Stage;
  amount: number | null;
  /** YYYY-MM-DD, or null when undated. */
  announced: string | null;
  /** A total the page states for the financing (a series' running total), in millions. */
  total?: number | null;
  /** The page names the company right around the sentence (namedNearby): the sentence's "it" is the company. */
  named?: boolean;
}

/**
 * Why `quote` does not support `valuation` for this round, or null when it does. The quote must state
 * the figure and name the company (by name, by what it is, by carrying the round's own amount, or by
 * the page around it). A figure a valuation phrase governs ("values Heidi at", "is now valued at over",
 * "lifts the company's valuation to") is this round's whatever other amounts the sentence states,
 * unless the phrase is tied to another round or the figure follows "up from". Otherwise the quote must
 * not make the figure a running total, the round's amount, another round's (another amount right before
 * it, another stage, another month, "earlier this year").
 */
export function valuationSupport(
  valuation: string | null | undefined,
  quote: string | null | undefined,
  round: RoundContext,
): string | null {
  const value = parseAmount(valuation).value;
  if (value === null) return "no figure";
  // "approximately $60 million in equity funding; more than $100 million including its credit facility" is not a valuation.
  if (/\b(?:funding|raised|credit|facility|debt|equity|revenue|round)\b/i.test(valuation ?? "")) return "not a valuation figure";
  if (!quote?.trim()) return "no sentence states it";
  const found = figures(quote);
  // The figure closest to the valuation: "$97 million" is not "$100 million" though they are within tolerance.
  const gap = (f: Figure) => Math.min(...f.values.map((v) => Math.abs(v - value) / Math.max(v, value)));
  const stated = found.filter((f) => states(f, value)).sort((a, b) => gap(a) - gap(b))[0];
  if (!stated) return "its sentence does not state it";
  if (round.total != null && near(value, round.total)) return `${stated.text} is the financing's total, not a valuation`;
  const lead = quote.slice(Math.max(0, stated.index - 70), stated.index);
  // "lifts the company's valuation to $250 million, up from $97 million at its Series B": the figure after
  // "up from" is the earlier one.
  const earlier = EARLIER_FIGURE.exec(lead);
  if (earlier) return `it is an earlier valuation (${earlier[0].trim()} ${stated.text})`;
  // A figure a valuation phrase governs ("values Heidi at", "valued at over", "valuation to") is this
  // round's valuation whatever other amounts the sentence states, unless the phrase is tied to another
  // round ("valued at $97 million at its Series B in 2024").
  // The words after a dash or "from" and an earlier figure tie that figure, not this one: "to $1.25 billion
  // from $625 million since its previous round", "$2.6 billion post-money — a jump from its last valuation
  // of $1.8 billion in 2023".
  const tail = quote
    .slice(stated.index + stated.text.length)
    .split(/[,;\u2013\u2014]|\s-\s|\bup from\b|\bfrom(?=\s+(?:US|A|C)?[$€£¥₹]|\s+\d)/i)[0];
  const governed = VALUATION_BEFORE.test(lead) && !TIED.test(tail);
  // "bringing the total Series D-2 raised to $110 million" is a total; "brings its valuation to €4 billion" is not.
  const total = TOTAL_BEFORE.exec(quote.slice(0, stated.index));
  if (
    !governed &&
    total &&
    !VALUATION_WORD.test(total[0]) &&
    !VALUATION_WORD.test(quote.slice(stated.index, stated.index + stated.text.length + 30))
  ) {
    return `${stated.text} is a total raised, not a valuation`;
  }
  const amount = round.amount;
  if (!governed && amount !== null && near(value, amount)) return `${stated.text} is the round's amount, not a valuation`;
  const statesAmount = amount !== null && found.some((f) => states(f, amount));
  if (!statesAmount && !round.named && !names(quote, round.company) && !REFERENT.test(quote)) {
    return "its sentence does not name the company";
  }
  // A valuation phrase hung on another round's figure is that round's: "a $173 million Series C in December
  // 2023, valuing the company at $633 million". The phrase follows the figure's own words after a comma, and
  // those words name another stage, an earlier round, or another year. A clause of its own ("and lifts the
  // company's valuation to") is not hung on the figure before it.
  const prior = found.filter((f) => f.index < stated.index).pop();
  const hung = prior ? /,\s*(?:which\s+|that\s+)?valu(?:ing|ed)\b[^,;]*$/i.exec(quote.slice(prior.index, stated.index)) : null;
  if (governed && prior && hung && (amount === null || !states(prior, amount))) {
    const between = quote.slice(prior.index + prior.text.length, prior.index + hung.index);
    const stage = STAGE.exec(between)?.[0];
    const year = /\b(?:19|20)\d{2}\b/.exec(between)?.[0];
    if (
      (stage && classifyStage(stage).stage !== round.stage) ||
      EARLIER.test(between) ||
      (year && round.announced && year !== round.announced.slice(0, 4))
    )
      return `it is stated for another round (${prior.text})`;
  }
  if (governed) return null;
  // In one sentence with two rounds, the valuation belongs to the figure right before it.
  const before = found.filter((f) => f.index < stated.index && stated.index - f.index <= 80).pop();
  if (amount !== null && before && !states(before, amount)) return `it is stated for another round (${before.text})`;
  const other = found.find((f) => !states(f, value) && (amount === null || !states(f, amount)));
  if (amount !== null && !statesAmount && other) return `its sentence is about another round (${other.text})`;
  if (statesAmount) return null;
  const stage = STAGE.exec(quote)?.[0];
  if (stage && classifyStage(stage).stage !== round.stage) return `its sentence is about another round (${stage})`;
  if (EARLIER.test(quote)) return `its sentence is about an earlier round (${EARLIER.exec(quote)?.[0]})`;
  const month = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`).test(quote)) + 1;
  const announcedMonth = Number(round.announced?.slice(5, 7)) || null;
  if (month && announcedMonth && month !== announcedMonth) return `its sentence dates another round (${MONTHS[month - 1]})`;
  return null;
}

/** Words that make the figure after them money raised, not a valuation: "bringing total funding to", "has raised". */
const RAISED_WORD =
  /\b(?:total|to date|cumulative|in all|altogether|so far|bringing|brings|brought|raised|raising|funding|capital|financing)\b/gi;
/** A valuation word right after a figure: "a $1.9B valuation", "$800M post-money valuation". */
const VALUATION_AFTER = /^\s*(?:\([^)]*\)\s*)?(?:(?:pre|post)[\s-]?money\s+)?valuation\b/i;

/**
 * Whether the sentence a financing total stands on states that figure as a valuation: "at a $1.9B
 * valuation", "valuing the company at US$18bn", "The fintech's valuation now stands at USD 1.4 billion".
 * The words nearest before the figure decide, so "at a $6B valuation, bringing total funding to roughly
 * $835M" keeps $835M as the total.
 */
export function totalIsValuation(total: string | null | undefined, quote: string | null | undefined): boolean {
  const value = parseAmount(total).value;
  if (value === null || !quote) return false;
  const found = figures(quote);
  const at = found.findIndex((f) => states(f, value));
  if (at < 0) return false;
  const stated = found[at];
  const previous = found[at - 1];
  const from = Math.max(previous ? previous.index + previous.text.length : 0, stated.index - 70);
  const lead = quote.slice(from, stated.index);
  if (VALUATION_AFTER.test(quote.slice(stated.index + stated.text.length))) return true;
  if (VALUATION_BEFORE.test(lead)) return true;
  const valuationAt = Math.max(-1, ...[...lead.matchAll(/valu|worth/gi)].map((m) => m.index ?? -1));
  const raisedAt = Math.max(-1, ...[...lead.matchAll(RAISED_WORD)].map((m) => m.index ?? -1));
  return valuationAt > raisedAt;
}

/** Words that make a figure money raised over more than this round: "to date", "bringing its total to", "across two seed rounds", "seed and Series A". */
const CUMULATIVE =
  /\b(?:total(?:ling|ing)?|to date|cumulative(?:ly)?|in all|altogether|so far|overall|combined|bringing|brings|brought|since (?:its )?(?:founding|inception|launch)|lifetime|aggregate|across|backed by|disclosed|(?:two|three|four|several|multiple) (?:\w+ )?rounds)\b|\b(?:pre-?seed|seed|series [a-k])\s+and\s+(?:seed|series [a-k])\b/i;

/**
 * Whether a financing total only repeats the round's own amount: the same figure in the same currency,
 * stated by a sentence that never says the money is cumulative ("Kalshi today announced a $1 billion
 * Series F round"). A total equal to the amount that its sentence calls a total to date, or money across
 * rounds, is the company's word and stays.
 */
export function totalRepeatsAmount(
  total: string | null | undefined,
  amount: string | null | undefined,
  quote: string | null | undefined,
  scope: FeedRecord["amount_scope"],
): boolean {
  // An amount that already spans more than one round (combined rounds, a total) may equal its total.
  if (scope && scope !== "round" && scope !== "tranche") return false;
  const t = parseAmount(total);
  const a = parseAmount(amount);
  if (t.value === null || a.value === null || (t.currency && a.currency && t.currency !== a.currency)) return false;
  return Math.abs(t.value - a.value) <= 0.01 * Math.max(t.value, a.value) && !CUMULATIVE.test(quote ?? "");
}

/** Text as the context check compares it: link text kept, markdown marks dropped, lowercase. */
function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>`|]/g, "")
    .toLowerCase();
}

/**
 * Whether the page names the company around a sentence that refers to it as "it" or by what it is:
 * the page's headline names it ("Harvey raises $300M" over "It is now valued at $3 billion"), or a
 * sentence in the quote's own paragraph does. The quote itself must still be on the page and state the figure.
 */
export function namedNearby(quote: string, markdown: string, title: string | null | undefined, company: string): boolean {
  const q = plainText(quote).replace(/\s+/g, " ").trim();
  if (!q) return false;
  const lines = plainText(markdown).split("\n");
  // The page's headline: its title, or its first heading.
  const heading = markdown.split("\n").find((l) => /^\s*#{1,2}\s/.test(l)) ?? "";
  if (names(title ?? "", company) || names(heading.replace(/^\s*#+\s*/, ""), company)) return true;
  const paragraphs = lines
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // The quote's paragraph, found by its opening words, or by its figure when the copy differs.
  const figure = figures(quote)[0]?.text.toLowerCase();
  const probes = [q.slice(0, 60), q.slice(0, 30), ...(figure ? [figure] : [])];
  const para = probes.map((probe) => paragraphs.find((p) => p.includes(probe))).find(Boolean);
  return Boolean(para && names(para, company));
}

/**
 * The valuation as its sentence qualifies it: "pre-money" or "post-money" written beside the figure
 * stays on it ("$9 billion pre-money"), since the two are different numbers for one round.
 */
export function withBasis(value: string, quote: string | null | undefined): string {
  if (!quote || /\b(?:pre|post)[\s-]?money\b/i.test(value)) return value;
  const target = parseAmount(value).value;
  if (target === null) return value;
  const stated = figures(quote).find((f) => states(f, target));
  if (!stated) return value;
  const around = quote.slice(Math.max(0, stated.index - 25), stated.index + stated.text.length + 30);
  const basis = /\b(pre|post)[\s-]?money\b/i.exec(around)?.[1];
  return basis ? `${value} ${basis.toLowerCase()}-money` : value;
}

/** A valuation as one reading stated it: the figure, the sentence, the page, and the page's tier. */
export interface ValuationClaim {
  value: string;
  quote: string | null;
  url: string;
  tier: number;
}

/**
 * The valuation the claims support: a checked quote first, then the page's tier, then how many pages
 * state the same figure, then the earliest. Null with no claim. A claim without a quote is a stored
 * valuation from before the rule: it stands only when nothing checked says otherwise.
 */
export function pickValuation(claims: ValuationClaim[]): ValuationClaim | null {
  if (claims.length === 0) return null;
  const figure = (c: ValuationClaim) => parseAmount(c.value).value;
  const votes = (c: ValuationClaim) => {
    const v = figure(c);
    return v === null ? 0 : claims.filter((o) => o.url !== c.url && figure(o) !== null && near(figure(o) as number, v)).length + 1;
  };
  return [...claims]
    .map((c, i) => ({ c, i, quoted: c.quote ? 1 : 0, votes: votes(c) }))
    .sort((a, b) => b.quoted - a.quoted || b.c.tier - a.c.tier || b.votes - a.votes || a.i - b.i)[0].c;
}

/** The round a stored or merged record is, as the checks read it. */
export function roundContext(
  r: Pick<FeedRecord, "company_name" | "stage" | "amount" | "announced_date" | "financing_total_as_written">,
): RoundContext {
  return {
    company: r.company_name,
    stage: r.stage,
    amount: r.amount.value,
    announced: r.announced_date,
    total: parseAmount(r.financing_total_as_written ?? null).value,
  };
}

/**
 * Why a stored record's valuation has no support, or null when some sentence it keeps supports it:
 * a claim's quote, an evidence sentence, or a source's headline ("Corgi Is Now Worth $5 Billion").
 * The repair and the write path ask it of rows whose valuation came from before the rule.
 */
export function unsupportedValuation(r: Parameters<typeof valuationVerdict>[0]): string | null {
  return valuationVerdict(r)?.reason ?? null;
}

/** Why a stored valuation has no support, with the sentence that decided it (null when no sentence states the figure at all). */
export function valuationVerdict(
  r: Pick<
    FeedRecord,
    | "valuation_as_written"
    | "valuation_claims"
    | "evidence_quotes"
    | "sources"
    | "company_name"
    | "stage"
    | "amount"
    | "announced_date"
    | "financing_total_as_written"
  >,
): { reason: string; quote: string | null } | null {
  if (!r.valuation_as_written) return null;
  const round = roundContext(r);
  const quotes = [
    ...(r.valuation_claims ?? []).map((c) => c.quote),
    ...r.evidence_quotes.flatMap((q) => q.split(/(?<=[.!?])\s+/)),
    ...r.sources.map((s) => s.title ?? null),
  ].filter((q): q is string => Boolean(q));
  const verdicts = quotes.map((quote) => ({ quote, reason: valuationSupport(r.valuation_as_written, quote, round) }));
  if (verdicts.some((v) => v.reason === null)) return null;
  const decided = verdicts.find((v) => v.reason !== "its sentence does not state it");
  return decided ? { reason: decided.reason as string, quote: decided.quote } : { reason: "no sentence states it", quote: null };
}
