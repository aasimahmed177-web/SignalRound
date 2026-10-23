// The second reading: before a record is published, its primary page is read once more with one
// question per field. Does this page announce this company's round as news? Does it state this
// stage, this amount, this date? Which of these names does it call leads, and which of the
// participants are not investors in this round at all (partners, earlier backers, a founder's
// employer)? The extractor answered "what rounds are on this page"; the judge answers "is this
// record what the page says", with the record in front of it. A cached page plus the json format
// is about 5 credits per record. The verdict corrects what it can (a stage label, an amount, a
// date, the lead list), nulls what the page never states, and marks a record whose page is history
// or another company's as not news; publish requires a confirmed or corrected verdict.

import { z } from "zod";
import { applyCorrection } from "../records/correction.ts";
import type { RateTable } from "../records/fx.ts";
import { registrableDomain } from "../records/normalize.ts";
import { amountInEvidence } from "../records/resolve.ts";
import type { FeedRecord } from "../records/schema.ts";
import type { NativeWebClient } from "../web/client.ts";
import { mapLimit } from "./credits.ts";

const nullableString = z.union([z.string(), z.null()]);

const FieldVerdict = z.object({
  stated: z.boolean().describe("true when the page states this field for this round; false when the page does not say"),
  page_value: nullableString.describe("What the page says, copied as written; null when the page does not say"),
});

export const Verdict = z.object({
  is_announcement: z
    .enum(["yes", "history", "not_a_round", "unclear"])
    .describe(
      "About the record's round specifically (its stage and amount), not any round of the company. yes: this page reports that round as the news it announces. history: the page mentions that round as context or an earlier event (an earlier round recalled in a story about a new one, a profile, an acquisition story, a list of past deals). not_a_round: the page is not about a funding round for this company (a guide, an investor profile, a ranking, another company's news). unclear: cannot tell.",
    ),
  company_matches: z
    .boolean()
    .describe(
      "true when the page's company is the record's company (under its name or one it is also known as), not a namesake or a different entity",
    ),
  stage: FieldVerdict.describe("The round's label as the page gives it (Seed, Series A, Series B extension, pre-Series A)"),
  amount: FieldVerdict.describe(
    "The money raised in this round as the page states it, as written with its currency. A total raised to date, a series' running total, a valuation, a contract or partnership value, or a debt facility is not this amount: then stated is false and page_value is null. New money added to a round (an extension) is the new money; one financing announced split into tranches (a Series C and a Series C-1 together) is the financing's total.",
  ),
  announced_date: FieldVerdict.describe(
    "The day the page says the round was announced, YYYY-MM-DD, resolving 'today' or 'on Tuesday' against the page's own date. When the page gives only a month or nothing, stated is false and page_value is null.",
  ),
  investors: z.object({
    page_leads: z
      .array(z.string())
      .describe(
        "Every firm the page says led or co-led this round ('led by', 'co-led by', 'lead investor'), as the page names them. Empty when the page names no lead.",
      ),
    page_participants: z
      .array(z.string())
      .describe(
        "Every other firm or angel the page names as investing in this round ('with participation from', 'joined by', 'alongside', 'investors include'), as the page names them. Not partners or customers, not earlier-round backers the page recalls as history ('earlier investors include', 'previously backed by'), not the company's backers listed as background rather than as this round's ('existing investors include', 'is also backed by'), not a person's employer, not lenders on a debt facility, not placeholders.",
      ),
    not_this_round: z
      .array(z.string())
      .describe(
        "Names from the record that the page explicitly places outside this round: an earlier-round backer recalled as history, a partner or customer, a lender, an angel's employer. A name the page simply does not mention is unknown, not excluded: leave it out of every list.",
      ),
  }),
  notes: z.string().describe("One sentence on the biggest disagreement, or 'matches' when the record is what the page says"),
});
export type Verdict = z.infer<typeof Verdict>;
export const verdictJsonSchema = z.toJSONSchema(Verdict, { target: "draft-07", io: "output" });

export function judgePrompt(record: FeedRecord): string {
  const summary = {
    company: record.company_name,
    ...(record.company_aliases?.length ? { also_known_as: record.company_aliases } : {}),
    stage: record.stage_as_written,
    amount: record.amount.as_written,
    announced_date: record.announced_date,
    lead_investors: record.lead_investors,
    other_investors: record.other_investors,
    evidence: record.evidence_quotes[0] ?? null,
  };
  return [
    "A record was extracted from this page. Judge every field of the record against the page's own text, nothing else.",
    `Record: ${JSON.stringify(summary)}`,
    "First decide whether this page announces this company's round as news, mentions it as history or context, or is not about a funding round for this company at all.",
    "Then for stage, amount, and announced date: does the page state it for this round, and what exactly does it say?",
    "Then investors: list every firm the page calls a lead of this round, and every other firm or angel the page names as investing in this round. Leave out partners, customers, earlier-round backers the page recalls as history, the employer of an angel, lenders on a credit facility, and placeholders. Under not_this_round, name only record investors the page itself places outside this round; a name the page never mentions is unknown, not excluded.",
    "The amount is this round's alone: a total raised to date, a combined figure across rounds, or 'brings the round to' is not it.",
    "Copy values as the page writes them. Do not infer from the record; when the page does not say, stated is false.",
  ].join("\n");
}

/** Hosts whose page is the announcement itself: the wires. A company's own site joins them per record. */
const RELEASE_HOSTS = new Set([
  "businesswire.com",
  "globenewswire.com",
  "prnewswire.com",
  "prweb.com",
  "accesswire.com",
  "newswire.ca",
  "einpresswire.com",
  "newsfilecorp.com",
]);

/**
 * The page to judge against: the release itself when the record carries one (a wire or the company's
 * own site), else the earliest dated source, else the first source that was not a corroboration. A
 * republisher's page two weeks after a release that sat second in the record's sources gave its own day as the round's.
 */
export function primarySource(record: FeedRecord): string | null {
  const own = record.company_domain;
  const candidates = record.sources.filter((s) => s.query !== "corroborate");
  const pool = candidates.length ? candidates : record.sources;
  const release = pool.find((s) => {
    const d = registrableDomain(s.url);
    return d !== null && (RELEASE_HOSTS.has(d) || (own !== null && d === own));
  });
  if (release) return release.url;
  const dated = pool.filter((s) => s.published).sort((a, b) => (a.published ?? "").localeCompare(b.published ?? ""));
  return (dated[0] ?? pool[0])?.url ?? null;
}

/**
 * The record after the verdict: pure, so the same verdict always gives the same record. The verdict maps
 * into a Correction and the shared applier does the rest. What is the judge's alone: it read one page, so
 * every field cites that page; it grades no date, so a day that only echoes a list page's own date is
 * refused; and it fills an empty amount only when the record's own sentence carries the figure (one
 * page's figure for a tranche was the round's cumulative total).
 */
export function applyVerdict(
  record: FeedRecord,
  verdict: Verdict,
  url: string | null,
  opts: { rates: RateTable | null; tiers?: Record<string, number> },
): FeedRecord {
  const stated = (f: { stated: boolean; page_value: string | null }) => ({ value: f.stated ? f.page_value : null, source: url });
  const amount = stated(verdict.amount);
  return applyCorrection(
    record,
    {
      announcement: verdict.is_announcement,
      companyMatches: verdict.company_matches,
      stage: stated(verdict.stage),
      amount: { ...amount, fillsEmpty: record.evidence_quotes.some((q) => amountInEvidence(amount.value, q)) },
      date: { ...stated(verdict.announced_date), precision: null },
      leads: verdict.investors.page_leads.map((name) => ({ name, source: url })),
      others: verdict.investors.page_participants,
      notThisRound: verdict.investors.not_this_round,
      headquarters: { value: null, source: null },
      notes: /^matches\.?$/i.test(verdict.notes.trim()) ? null : verdict.notes,
      cited: false,
      url,
    },
    opts,
  );
}

export interface JudgeOptions {
  concurrency?: number;
  /** Cached pages are fine: the page was scraped minutes ago by the extractor. */
  maxAge?: number;
  rates: RateTable | null;
  tiers?: Record<string, number>;
}

export interface JudgeResult {
  records: FeedRecord[];
  /** Records the judge read, and how many of each verdict. */
  judged: number;
  confirmed: number;
  corrected: number;
  contradicted: number;
  notNews: number;
  failed: number;
  creditsEstimated: number;
}

/** 5 credits: the page (cached or not) plus the json format. */
export const JUDGE_CREDITS_PER_RECORD = 0;

/**
 * Read each record's primary page once more with the record in hand. A record with no source, or
 * whose page cannot be read, keeps its fields and is marked skipped rather than confirmed.
 */
export async function judgeRecords(client: NativeWebClient, records: FeedRecord[], opts: JudgeOptions): Promise<JudgeResult> {
  const out: FeedRecord[] = [];
  const tally = { judged: 0, confirmed: 0, corrected: 0, contradicted: 0, notNews: 0, failed: 0 };
  await mapLimit(records, opts.concurrency ?? 6, async (record) => {
    const url = primarySource(record);
    if (!url) {
      out.push({ ...record, verification: { status: "skipped", notes: ["no source to read"], url: null } });
      return;
    }
    try {
      const doc = await client.scrape(url, {
        formats: [{ type: "json", schema: verdictJsonSchema, prompt: judgePrompt(record) }],
        onlyMainContent: true,
        timeout: 60_000,
        maxAge: opts.maxAge ?? 7 * 86_400_000,
      });
      const parsed = Verdict.safeParse(doc.json);
      if (!parsed.success) {
        tally.failed++;
        out.push({ ...record, verification: { status: "skipped", notes: ["the judge returned no verdict"], url } });
        return;
      }
      const judged = applyVerdict(record, parsed.data, url, { rates: opts.rates, tiers: opts.tiers });
      tally.judged++;
      const status = judged.verification?.status;
      if (status === "confirmed") tally.confirmed++;
      else if (status === "corrected") tally.corrected++;
      else if (status === "contradicted") tally.contradicted++;
      else if (status === "not_news") tally.notNews++;
      out.push(judged);
    } catch (err) {
      tally.failed++;
      out.push({
        ...record,
        verification: { status: "skipped", notes: [`page could not be read: ${err instanceof Error ? err.message : String(err)}`], url },
      });
    }
  });
  // mapLimit completes out of order; the caller's order is the record order.
  const byId = new Map(out.map((r) => [r.id, r]));
  return {
    records: records.map((r) => byId.get(r.id) ?? r),
    ...tally,
    creditsEstimated: (tally.judged + tally.failed) * JUDGE_CREDITS_PER_RECORD,
  };
}
