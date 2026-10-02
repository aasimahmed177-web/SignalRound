// The cross-source read. A record's sources disagree in small ways (a roundup's day against a release's,
// "led by" against "participated"), and one page at a time nobody can arbitrate them. This step hands a
// model the record and every source's text together and asks for the round as the sources state it,
// each field with the source that states it and the sentence it is stated in. It replaces the single-page
// judge when a model is configured, and runs again when a row gains sources. Firecrawl still fetches
// every page; the model only reads what Firecrawl fetched.

import { generateText, Output } from "ai";
import type { Firecrawl } from "firecrawl";
import { z } from "zod";
import { mapLimit } from "../firecrawl/credits.ts";
import { groundingCheck } from "../firecrawl/extract.ts";
import { applyCorrection, samePage } from "../records/correction.ts";
import type { RateTable } from "../records/fx.ts";
import { investorMentions } from "../records/investors.ts";
import { hostOf, parseAmount } from "../records/normalize.ts";
import { amountInEvidence } from "../records/resolve.ts";
import type { FeedRecord } from "../records/schema.ts";
import { isFundingAggregatorUrl } from "../records/source-fit.ts";
import { namedNearby, roundContext, type ValuationClaim, valuationSupport, withBasis } from "../records/valuation.ts";
import type { ReconcileModel } from "./model.ts";

const Cited = z.object({
  stated: z.boolean().describe("Whether any source states this field for this round."),
  value: z.string().nullable().describe("The value as the best source writes it; null when no source states it."),
  source: z.string().nullable().describe("The URL of the source that states it, copied exactly from the list."),
  quote: z.string().nullable().describe("The sentence, or the fragment of it, that states it. Copied, not paraphrased."),
});

const CitedName = z.object({
  name: z.string().describe("The firm or person as the source names it."),
  source: z.string().nullable().describe("The URL of the source that names it in this role."),
});

export const Reconciliation = z.object({
  is_announcement: z
    .enum(["yes", "history", "not_a_round", "unclear"])
    .describe(
      "Whether the sources announce this company's round as news: yes; history (recalled as background to another story); not_a_round (a grant, a product, an acquisition, a list); unclear.",
    ),
  company_matches: z.boolean().describe("Whether the sources are about the company the record names, not a namesake."),
  stage: Cited.describe(
    "The round's label as the sources write it (Series A, seed, Series B extension). Prefer the company's release or the most specific source.",
  ),
  amount: Cited.describe(
    "The money raised in this round alone, as written with its currency. Not a total raised to date, a combined figure across rounds, a series' running total, a valuation, or a debt facility. New money added to a round (an extension, a second close) is the new money, never the series' total. One financing announced split into tranches or sub-series at once (a Series C and a Series C-1 announced together as one financing) is the financing's total; name the tranches in notes. If sources disagree, the release or the most specific source wins; say so in notes.",
  ),
  financing_total: Cited.describe(
    "A larger total a source states beside this round's new money: a series' running total that includes money raised before ('bringing the total Series D-2 to $110 million'). Never the round's amount and never a valuation. stated false and value null when no source states one, or when the whole financing is this round's new money.",
  ),
  valuation: Cited.describe(
    "The company's valuation at this round (pre- or post-money) as a source states it for this round. Not a valuation an earlier or later round reached that a source recalls (a unicorn valuation from a spring round in a story about a September extension), a total raised to date, or a round's amount. stated false and value null when no source states a valuation for this round.",
  ),
  announced_date: z.object({
    stated: z.boolean(),
    value: z.string().nullable().describe("YYYY-MM-DD, the day the round was announced."),
    precision: z
      .enum(["day", "week", "month"])
      .describe(
        "day when a source states or is dated to the announcement day; week or month when the best evidence is a roundup or list covering that period.",
      ),
    source: z.string().nullable(),
    quote: z.string().nullable().describe("The sentence or the dateline that fixes the day."),
  }),
  lead_investors: z
    .array(CitedName)
    .describe(
      "Every firm any source calls a lead or co-lead of this round in words ('led by', 'co-led', 'lead investor', 'anchored by'), cited to that source. A firm that merely participated is not a lead, and neither is a firm named first, a lead of an earlier round, or a lead of a separate vehicle.",
    ),
  other_investors: z
    .array(CitedName)
    .describe(
      "Every other firm or angel any source names as investing in this round. An existing investor counts only when a source says it joined this round ('with participation from existing investors X and Y'). Not the company's backers listed as background rather than as this round's ('the company's investors include', 'is backed by', 'existing investors include', 'counts X among its backers'), not partners, customers, earlier-round backers recalled as history, an angel's employer, a fund's manager named beside the fund, lenders on a debt facility, or placeholders ('other investors', 'angels').",
    ),
  not_this_round: z
    .array(z.string())
    .describe(
      "Investors the sources name who are not in this round: an earlier round's backer, a backer the sources list only as the company's existing investor, a partner, a lender, a fund's manager.",
    ),
  headquarters: Cited.describe(
    "The company's headquarters city and country or state, as a source states it about the company itself. Not a dateline.",
  ),
  notes: z
    .string()
    .describe(
      "What a reader needs beyond the fields above, in at most two short sentences (under 40 words): what the sources disagreed about and which won, or a caveat on a field (a dateline that is not the headquarters, a figure that is a valuation or a total rather than this round's amount). Never restate a field the sources agree on. 'sources agree' when there is nothing more.",
    ),
});
export type Reconciliation = z.infer<typeof Reconciliation>;

export interface SourceText {
  url: string;
  host: string;
  title?: string;
  published?: string;
  markdown: string;
}

/** Characters of each page the model reads: the announcement is in the first screen, the syndicate in the first few. */
export const PAGE_CHARS = 12_000;
/** Pages per record. Beyond four the marginal page repeats the wire. */
export const MAX_SOURCES = 4;

/**
 * The read-back prompt. Blind: the model is told only who the company is, never the stage, amount,
 * date, valuation, or investors the record holds, so it reads the round off the pages rather than
 * confirming what it was shown; applyReconciliation diffs its reading against the record.
 */
export function reconcilePrompt(record: FeedRecord, pages: SourceText[]): string {
  const summary = {
    company: record.company_name,
    website: record.company_website ?? record.company_domain,
  };
  const sources = pages
    .map((p, i) => {
      const meta = [`URL: ${p.url}`, p.title ? `Title: ${p.title}` : null, p.published ? `Published: ${p.published}` : null]
        .filter(Boolean)
        .join("\n");
      return `--- Source ${i + 1} ---\n${meta}\n\n${p.markdown.slice(0, PAGE_CHARS)}`;
    })
    .join("\n\n");
  return [
    "The sources below report a funding round of the company named after them. Read every source and state the round the sources announce as news, field by field, citing for each field the source URL and the sentence that states it, copied exactly. A field no sentence states is not stated.",
    "Rules: copy values as a source writes them; never infer. A roundup, a weekly, or a monthly list dates its items to the period it covers, not to its own publish day; a company's release or a dated article about this round alone fixes the day. A republisher's byline a day or two after the release is not the announcement day. A round known only to its month is precision month with the month's first day as the value, never a day; known only to its week, precision week with the list's day. 'Led by' makes a lead; 'with participation from', 'joined by', 'investors include' make a participant. The two investor lists are this round's whole syndicate: list every firm a source names in this round, and never one a source names only as the company's existing backer, a partner, or an earlier round's investor. The amount is this round's alone, written with its currency symbol or code exactly as the source has it: new money added to a round is that new money, never the series' running total, and one financing announced split into tranches is its total. A valuation is this round's only when a source states it for this round; a valuation recalled from another round is not.",
    "When sources disagree, prefer the company's own release, then the most specific article about this round, then the rest; say in notes what disagreed and which won, and nothing the sources agree on.",
    `Company: ${JSON.stringify(summary)}`,
    sources,
  ].join("\n\n");
}

export interface ApplyOptions {
  rates: RateTable | null;
  tiers?: Record<string, number>;
  verifier: string;
  sourcesSeen: number;
  /**
   * The pages the model read. With them, a record investor the verdict names in no list is judged
   * against what was read (see Correction.coverage); without them (a caller that has only the
   * verdict), such a name keeps its seat as the judge's would.
   */
  pages?: SourceText[];
}

/**
 * What the model saw, for the investor rule: whether every source the record has was read in full
 * (a page cut at PAGE_CHARS may name a participant past the cut), and a test of whether the text it
 * read (each page's title and its first PAGE_CHARS) names an investor.
 */
export function readCoverage(record: FeedRecord, pages: SourceText[]): { readAll: boolean; mentions: (name: string) => boolean } {
  const read = new Set(pages.map((p) => p.url));
  return {
    readAll: record.sources.every((s) => read.has(s.url)) && pages.every((p) => p.markdown.length <= PAGE_CHARS),
    mentions: investorMentions(pages.map((p) => `${p.title ?? ""}\n${p.markdown.slice(0, PAGE_CHARS)}`).join("\n")),
  };
}

/**
 * Apply what the sources state to the record. Pure: the tests exercise it without a model. The verdict
 * maps into a Correction and the shared applier does the rest. What is the reconciler's alone: every
 * field cites the page that stated it; the date comes graded (day, week, month), so only its day that
 * sharpens a list's stamp while citing the list is refused (the judge's wider echo guard does not
 * apply); an empty amount fills from the cited sentence; a record
 * investor the lists leave out is unsupported when the pages read say so (readCoverage); and the
 * verification names the model and how many sources it saw.
 */
export function applyReconciliation(record: FeedRecord, v: Reconciliation, opts: ApplyOptions): FeedRecord {
  // With the pages read, every correction stands on its sentence: the quote must be on the page it
  // cites and, for money, state the figure. A field stated without one keeps the record's value.
  const ungrounded: string[] = [];
  const checked = (
    name: string,
    f: { stated: boolean; value: string | null; source: string | null; quote: string | null },
    money = false,
  ) => {
    if (!opts.pages || !f.stated || !f.value) return true;
    const page = f.source ? opts.pages.find((p) => samePage(p.url, f.source as string)) : undefined;
    const ok = Boolean(
      f.quote &&
        page &&
        groundingCheck({ evidence_quote: f.quote }, `${page.title ?? ""}\n${page.markdown}`) &&
        (!money || amountInEvidence(f.value, f.quote)),
    );
    if (!ok) ungrounded.push(name);
    return ok;
  };
  const stated = (f: { stated: boolean; value: string | null; source: string | null }) => ({
    value: f.stated ? f.value : null,
    source: f.source,
  });
  const kept = (value: string | null) => ({ value, source: null });
  const stage = checked("stage", v.stage) ? stated(v.stage) : kept(record.stage_as_written);
  const amount = checked("amount", v.amount, true) ? stated(v.amount) : kept(record.amount.as_written);
  const dateGrounded = checked("date", v.announced_date);
  const date = dateGrounded ? stated(v.announced_date) : kept(record.announced_date);
  const valuation = checked("valuation", v.valuation, true) ? stated(v.valuation) : kept(record.valuation_as_written);
  const total = checked("financing total", v.financing_total, true) ? v.financing_total : null;
  const headquarters = checked("headquarters", v.headquarters) ? stated(v.headquarters) : kept(null);
  const notes = /^sources agree\.?$/i.test(v.notes.trim()) ? null : v.notes;
  const corrected = applyCorrection(
    record,
    {
      announcement: v.is_announcement,
      companyMatches: v.company_matches,
      stage,
      amount: { ...amount, fillsEmpty: true },
      valuation,
      date: {
        ...date,
        precision: dateGrounded ? v.announced_date.precision : record.date_precision === "unknown" ? null : record.date_precision,
      },
      leads: v.lead_investors,
      others: v.other_investors.map((n) => n.name),
      notThisRound: v.not_this_round,
      headquarters,
      // "Sources agree." with its period says nothing more either.
      notes:
        [notes, ungrounded.length ? `not on the page it cites, so not applied: ${ungrounded.join(", ")}` : null]
          .filter(Boolean)
          .join("; ") || null,
      cited: true,
      url: v.announced_date.source ?? v.stage.source ?? record.sources[0]?.url ?? null,
      coverage: opts.pages ? readCoverage(record, opts.pages) : undefined,
    },
    {
      rates: opts.rates,
      tiers: opts.tiers,
      verification: { verifier: opts.verifier, sources_seen: opts.sourcesSeen, sources_listed: record.sources.length },
    },
  );
  if (corrected.verification?.status !== "confirmed" && corrected.verification?.status !== "corrected") return corrected;
  const out: FeedRecord = { ...corrected };
  // A total the pages state beside the new money is kept with its sentence; it is never the amount or a valuation.
  if (total?.stated && total.value && total.quote) {
    out.financing_total_as_written = total.value;
    out.financing_total_quote = total.quote;
  }
  // The read-back's valuation is a claim like any reading's: its sentence, checked for this round, and its page.
  if (valuation.source && out.valuation_as_written && v.valuation.quote) {
    const cited = opts.pages?.find((p) => samePage(p.url, valuation.source as string));
    const named = cited ? namedNearby(v.valuation.quote, cited.markdown, cited.title, out.company_name) : false;
    const why = valuationSupport(out.valuation_as_written, v.valuation.quote, { ...roundContext(out), named });
    if (why) {
      out.valuation_as_written = null;
      out.valuation_ruled_out = why;
    } else {
      out.valuation_as_written = withBasis(out.valuation_as_written, v.valuation.quote);
      const host = hostOf(valuation.source);
      const tiers = opts.tiers ?? {};
      const claim = {
        value: out.valuation_as_written,
        quote: v.valuation.quote,
        url: valuation.source,
        tier: tiers[host] ?? tiers[host.replace(/^www\./, "")] ?? 0.3,
      };
      // A funding database's sentence is not a checked claim; the valuation stands on the read-back alone.
      if (!isFundingAggregatorUrl(valuation.source))
        out.valuation_claims = [...(out.valuation_claims ?? []).filter((c) => c.url !== claim.url), claim];
    }
  }
  return out;
}

/** Sites that republish wires and other outlets' stories: an original says the same first. */
const SYNDICATORS =
  /(?:^|\.)(?:finance\.yahoo\.com|yahoo\.com|msn\.com|marketscreener\.com|morningstar\.com|benzinga\.com|investing\.com|finanznachrichten\.de|streetinsider\.com|stocktitan\.net|marketwatch\.com|newsbreak\.com|ground\.news|biztoc\.com|digitaljournal\.com)$/;

/**
 * Which of a record's sources the model reads: never a corroboration duplicate of a page it has, at
 * most MAX_SOURCES, wires and the company's site first, originals before the syndicated copies of them
 * (a republisher's page under the same headline is left out when the original is read).
 */
export function sourcesToRead(record: FeedRecord): FeedRecord["sources"] {
  const seen = new Set<string>();
  const own = record.company_domain;
  const rank = (s: FeedRecord["sources"][number]) => {
    const host = s.host.replace(/^www\./, "");
    if (/(prnewswire|businesswire|globenewswire|prweb|accesswire|newswire\.ca)\.com$/.test(host)) return 0;
    if (own && host.endsWith(own)) return 0;
    if (isFundingAggregatorUrl(s.url)) return 4;
    if (SYNDICATORS.test(host)) return 3;
    if (s.query !== "corroborate") return 1;
    return 2;
  };
  const headline = (s: FeedRecord["sources"][number]) =>
    (s.title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const read: FeedRecord["sources"] = [];
  for (const s of [...record.sources].sort((a, b) => rank(a) - rank(b))) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    if (SYNDICATORS.test(s.host.replace(/^www\./, "")) && headline(s) && read.some((o) => headline(o) === headline(s))) continue;
    read.push(s);
  }
  return read.slice(0, MAX_SOURCES);
}

export type ReadPages = (urls: FeedRecord["sources"]) => Promise<SourceText[]>;

/** Firecrawl reads the pages: markdown only, main content, the extractor's cached copy when it has one. */
export function firecrawlReader(client: Firecrawl, maxAge = 7 * 86_400_000): ReadPages {
  return async (sources) => {
    const out: SourceText[] = [];
    await mapLimit(sources, 4, async (s) => {
      try {
        const doc = await client.scrape(s.url, { formats: ["markdown"], onlyMainContent: true, timeout: 45_000, maxAge });
        if (doc.markdown?.trim()) out.push({ url: s.url, host: s.host, title: s.title, published: s.published, markdown: doc.markdown });
      } catch {
        // An unreadable page is left out; the record is reconciled against the pages that could be read.
      }
    });
    return out;
  };
}

export interface ReconcileOptions {
  rates: RateTable | null;
  tiers?: Record<string, number>;
  concurrency?: number;
  /** Injected in tests; defaults to the AI SDK call against the configured model. */
  generate?: (prompt: string) => Promise<Reconciliation>;
}

export interface ReconcileResult {
  records: FeedRecord[];
  judged: number;
  confirmed: number;
  corrected: number;
  contradicted: number;
  notNews: number;
  failed: number;
  /** Firecrawl credits: one per page read. */
  creditsEstimated: number;
  /** Model tokens, when the provider reports them. */
  tokens: { input: number; output: number };
}

/** One model call: the structured verdict and the tokens it took. */
export async function generateReconciliation(
  model: ReconcileModel,
  prompt: string,
  opts: { maxRetries?: number; zeroDataRetention?: boolean } = {},
): Promise<{ output: Reconciliation | null; usage: { input: number; output: number } }> {
  const result = await generateText({
    model: model.model,
    output: Output.object({ schema: Reconciliation }),
    prompt,
    providerOptions: opts.zeroDataRetention && model.provider === "gateway" ? { gateway: { zeroDataRetention: true } } : undefined,
    maxRetries: opts.maxRetries ?? 2,
  });
  const output = (await result.output) ?? null;
  return { output, usage: { input: result.usage.inputTokens ?? 0, output: result.usage.outputTokens ?? 0 } };
}

export function modelGenerator(model: ReconcileModel): (prompt: string) => Promise<Reconciliation> {
  return async (prompt) => {
    const { output } = await generateReconciliation(model, prompt);
    if (!output) throw new Error("no output");
    return output;
  };
}

/**
 * Reconcile each record against all of its sources. A record with no readable page keeps its fields and
 * is marked skipped rather than confirmed.
 */
export async function reconcileRecords(
  records: FeedRecord[],
  read: ReadPages,
  model: ReconcileModel,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const out: FeedRecord[] = [];
  const tally = { judged: 0, confirmed: 0, corrected: 0, contradicted: 0, notNews: 0, failed: 0, credits: 0 };
  const tokens = { input: 0, output: 0 };
  const generate = opts.generate ?? modelGenerator(model);
  await mapLimit(records, opts.concurrency ?? 4, async (record) => {
    const sources = sourcesToRead(record);
    if (sources.length === 0) {
      out.push({
        ...record,
        verification: { status: "skipped", notes: ["no source to read"], url: null, verifier: model.label, sources_seen: 0 },
      });
      return;
    }
    const pages = await read(sources);
    tally.credits += sources.length;
    if (pages.length === 0) {
      tally.failed++;
      out.push({
        ...record,
        verification: {
          status: "skipped",
          notes: ["no source could be read"],
          url: sources[0]?.url ?? null,
          verifier: model.label,
          sources_seen: 0,
        },
      });
      return;
    }
    try {
      const verdict = await generate(reconcilePrompt(record, pages));
      const applied = applyReconciliation(record, verdict, {
        rates: opts.rates,
        tiers: opts.tiers,
        verifier: model.label,
        // What the model read: the pages it was given, not every source the record lists.
        sourcesSeen: pages.length,
        pages,
      });
      tally.judged++;
      switch (applied.verification?.status) {
        case "confirmed":
          tally.confirmed++;
          break;
        case "corrected":
          tally.corrected++;
          break;
        case "contradicted":
          tally.contradicted++;
          break;
        case "not_news":
          tally.notNews++;
          break;
      }
      out.push(applied);
    } catch (error) {
      tally.failed++;
      out.push({
        ...record,
        verification: {
          status: "skipped",
          notes: [`model error: ${error instanceof Error ? error.message : String(error)}`],
          url: sources[0]?.url ?? null,
          verifier: model.label,
          sources_seen: 0,
        },
      });
    }
  });
  // Keep the input order: persistence and the run summary read records positionally in places.
  const order = new Map(records.map((r, i) => [r.id, i]));
  out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { records: out, ...tally, creditsEstimated: tally.credits, tokens };
}

// The money-only read-back: the repair's re-ground mode for a stored valuation no stored sentence
// supports (older rows kept only the amount's sentence). The same blind, quote-checked reading, asked
// only for the round's new money, a larger total, and the valuation.

export const MoneyReading = z.object({
  amount: Reconciliation.shape.amount,
  financing_total: Reconciliation.shape.financing_total,
  valuation: Reconciliation.shape.valuation,
});
export type MoneyReading = z.infer<typeof MoneyReading>;

/** The money prompt: the company and the round's day to find it by, never the figures the record holds. */
export function moneyPrompt(
  record: Pick<FeedRecord, "company_name" | "company_website" | "company_domain" | "announced_date">,
  pages: SourceText[],
): string {
  const company = {
    company: record.company_name,
    website: record.company_website ?? record.company_domain,
    announced: record.announced_date,
  };
  const sources = pages
    .map((p, i) => `--- Source ${i + 1} ---\nURL: ${p.url}${p.title ? `\nTitle: ${p.title}` : ""}\n\n${p.markdown.slice(0, PAGE_CHARS)}`)
    .join("\n\n");
  return [
    "The sources below report a funding round of the company named after them, announced around the day given. State three figures for that round as the sources state them, each with the source URL and the sentence that states it, copied exactly: the new money raised in this round; a larger total a source states beside it (a series' running total), if any; and the company's valuation at this round. A figure no sentence states is not stated.",
    "Rules: copy values as a source writes them; never infer. New money added to a round is that new money, never the series' running total; one financing announced split into tranches is its total. A valuation is this round's only when a sentence states it for this round; a valuation recalled from another round, a total raised to date, or a round's amount is not one.",
    `Company: ${JSON.stringify(company)}`,
    sources,
  ].join("\n\n");
}

/**
 * What a re-ground found for a stored valuation: kept with its sentence, corrected to the one the pages
 * state, blank, or held: stated only by a funding database, so the value stays unconfirmed for a reader.
 */
export type Reground =
  | { outcome: "kept" | "corrected"; claim: ValuationClaim }
  | { outcome: "held"; value: string; url: string }
  | { outcome: "blanked"; reason: string; quote?: string | null };

/**
 * The stored valuation against the money reading: a valuation grounded on the page it cites (its quote
 * there, stating the figure) and checked for this round supports the stored one when the figures agree
 * (kept) or replaces it when they do not (corrected); with none, the stored valuation is blank.
 */
export function regroundValuation(
  record: Pick<FeedRecord, "company_name" | "stage" | "amount" | "announced_date" | "valuation_as_written" | "financing_total_as_written">,
  v: MoneyReading,
  pages: SourceText[],
  tiers: Record<string, number> = {},
): Reground {
  const f = v.valuation;
  if (!f.stated || !f.value) return { outcome: "blanked", reason: "no source states a valuation for this round" };
  const page = f.source ? pages.find((p) => samePage(p.url, f.source as string)) : undefined;
  if (
    !f.quote ||
    !page ||
    !groundingCheck({ evidence_quote: f.quote }, `${page.title ?? ""}\n${page.markdown}`) ||
    !amountInEvidence(f.value, f.quote)
  ) {
    return { outcome: "blanked", reason: "the valuation's sentence is not on the page it cites", quote: f.quote };
  }
  const total = v.financing_total.stated && v.financing_total.value ? v.financing_total.value : (record.financing_total_as_written ?? null);
  const why = valuationSupport(f.value, f.quote, {
    ...roundContext(record),
    total: parseAmount(total).value,
    named: namedNearby(f.quote, page.markdown, page.title, record.company_name),
  });
  if (why) return { outcome: "blanked", reason: why, quote: f.quote };
  const stored = parseAmount(record.valuation_as_written).value;
  const read = parseAmount(f.value).value;
  const agrees = stored !== null && read !== null && Math.abs(stored - read) <= 0.05 * Math.max(stored, read);
  // A funding database's sentence confirms nothing: the value stays as it is, unconfirmed.
  if (isFundingAggregatorUrl(page.url))
    return { outcome: "held", value: agrees ? (record.valuation_as_written as string) : f.value, url: page.url };
  const host = hostOf(page.url);
  const value = withBasis(agrees ? (record.valuation_as_written as string) : f.value, f.quote);
  return {
    outcome: agrees ? "kept" : "corrected",
    claim: { value, quote: f.quote, url: page.url, tier: tiers[host] ?? tiers[host.replace(/^www\./, "")] ?? 0.3 },
  };
}

/** One money reading from the configured model. */
export function moneyGenerator(model: ReconcileModel): (prompt: string) => Promise<MoneyReading> {
  return async (prompt) => {
    const result = await generateText({ model: model.model, output: Output.object({ schema: MoneyReading }), prompt, maxRetries: 2 });
    const output = await result.output;
    if (!output) throw new Error("no output");
    return output;
  };
}
