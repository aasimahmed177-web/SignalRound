import {
  amountInEvidence,
  canonicalUrl,
  classifyStage,
  cleanInvestors,
  dateFromUrl,
  dollarFromEvidence,
  type ExtractedRound,
  hasLeadLanguage,
  hostOf,
  investorKeyForMerge,
  isArticleUrl,
  type MoneyKind,
  moneyKindFromSentence,
  namesCompany,
  normalizeCompanyKey,
  pageSentences,
  parseAmount,
  type Stage,
  safeMoneyKind,
  visibleArticleDate,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray } from "drizzle-orm";
import { syncRoundInvestors } from "./persist.ts";

const { companies, fundingRounds, investors, roundInvestors, roundSources, sources } = schema;

interface VisibleMoney {
  id: string;
  company: string;
  amount: string | null;
  currency: string | null;
  value: string | null;
  usd: string | null;
  total: string | null;
  quotes: string[];
  pinned: unknown;
  disposition: "publish" | "flagged" | "review" | "rejected";
  stage?: string;
  announced?: string | null;
  firstSeen?: string | null;
  leadNames?: string[];
  otherNames?: string[];
  isExtension?: boolean;
}

export interface FinancingChange {
  id: string;
  company: string;
  reason: string;
  amount?: { from: string | null; to: string | null; total: string | null };
  currency?: { from: string | null; to: string; usd: number | null; rate: number | null; date: string | null };
  review?: boolean;
  leads?: { from: string[]; to: string[]; others: string[] };
  stage?: { from: string; to: Stage; asWritten: string };
  evidence: string;
  sourceUrl?: string;
}

export interface SourceMoneyReading {
  round: ExtractedRound;
  url: string;
  reviewReason?: string;
  published?: string | null;
  markdown?: string;
}

export interface FinancingReplay {
  scanned: number;
  amountCorrections: number;
  toReview: number;
  currencyFixes: number;
  leadCorrections: number;
  stageCorrections: number;
  changes: FinancingChange[];
}

const NOT_ROUND: MoneyKind[] = ["ipo_allocation", "internal_spending", "project_cost", "secondary", "debt", "grant"];

/** A stored sentence can correct a row only if it states that exact figure, not merely another number. */
export function financingChange(row: VisibleMoney): FinancingChange | null {
  if (!row.amount) return null;
  const mentions = row.quotes.filter((quote) => amountInEvidence(row.amount, quote));
  const readings = mentions.map((quote) => moneyKindFromSentence(quote, row.amount));
  const reliable = readings.filter((kind) => kind !== "unknown");
  const change: FinancingChange = { id: row.id, company: row.company, reason: "", evidence: mentions.join(" | ") };
  if (reliable.length > 0 && reliable.every((kind) => NOT_ROUND.includes(kind))) {
    change.review = true;
    change.reason = `the stored evidence describes ${reliable.join(", ")}, not primary new money`;
  } else if (reliable.length > 0 && reliable.every((kind) => kind === "combined" || kind === "cumulative")) {
    change.amount = { from: row.amount, to: null, total: row.amount };
    change.reason = `the figure is ${reliable.join(", ")}, not this round's amount`;
  } else if (reliable.length > 0 && reliable.every((kind) => kind === "future_commitment")) {
    change.review = true;
    change.reason = "the stored sentence describes a commitment, not clearly closed money";
  }
  const parsed = dollarFromEvidence(row.amount, parseAmount(row.amount), mentions.join(" "));
  if (parsed.value !== null && parsed.currency && parsed.currency !== row.currency && !change.review && !change.amount) {
    change.currency = { from: row.currency, to: parsed.currency, usd: null, rate: null, date: null };
    change.reason = `the stated figure is ${parsed.currency}, not ${row.currency ?? "unspecified"}`;
  }
  return change.reason ? change : null;
}

/** A grounded primary-source reading may repair stored snippets, but no unsupported model figure is written. */
export function regroundedChange(row: VisibleMoney, reading: SourceMoneyReading): FinancingChange | null {
  const readKey = normalizeCompanyKey(reading.round.company_name);
  const storedKey = normalizeCompanyKey(row.company);
  if (
    !row.amount ||
    !readKey ||
    !(
      readKey === storedKey ||
      storedKey.endsWith(` ${readKey}`) ||
      ["inc", "corp", "ltd", "llc"].some((suffix) => readKey === `${storedKey} ${suffix}`)
    )
  )
    return null;
  const { round } = reading;
  const expected = row.announced ? Date.parse(row.announced) : Number.NaN;
  if (row.firstSeen && Number.isFinite(expected) && expected < Date.parse(row.firstSeen) - 14 * 86_400_000) return null;
  const dates = [reading.published, round.announced_date, dateFromUrl(reading.url)?.toISOString().slice(0, 10)].filter(
    (date): date is string => Boolean(date),
  );
  if (
    !Number.isFinite(expected) ||
    dates.length === 0 ||
    dates.some((date) => !Number.isFinite(Date.parse(date)) || Math.abs(Date.parse(date) - expected) > 21 * 86_400_000)
  )
    return null;
  const stage = classifyStage(round.round_type_as_written).stage;
  if (row.stage && row.stage !== "other" && stage !== row.stage) return null;
  const figure = round.amount_as_written;
  const quote = round.money_kind_quote ?? round.field_quotes?.amount ?? round.evidence_quote;
  if (!quote || !amountInEvidence(figure, quote)) return null;
  const quotedFigure = dollarFromEvidence(figure, parseAmount(figure), quote);
  const statedFigure = parseAmount(figure);
  const evidence = { evidence: quote, sourceUrl: reading.url };
  const leadSentences = [round.evidence_quote, ...(round.lead_evidence ?? [])]
    .flatMap((sentence) => sentence.split(/\b(?:while|whereas)\s+(?=(?:the\s+)?(?:first|second|former|latter)\b)/i))
    .filter(hasLeadLanguage);
  const currentLeads = leadSentences.filter((sentence) => amountInEvidence(row.amount, sentence));
  const amountLeads = currentLeads.length
    ? currentLeads
    : figure
      ? leadSentences.filter((sentence) => amountInEvidence(figure, sentence))
      : [];
  const explicitLead = (round.lead_evidence ?? []).filter(
    (sentence) =>
      /\b(?:the |as (?:the|a) )?lead investor(?: in this round)?\b/i.test(sentence) &&
      amountLeads.some((amountSentence) =>
        (round.lead_investors ?? []).some(
          (name) => sentence.toLowerCase().includes(name.toLowerCase()) && amountSentence.toLowerCase().includes(name.toLowerCase()),
        ),
      ),
  );
  const leadEvidence = (explicitLead.length ? explicitLead : amountLeads).filter(hasLeadLanguage).join(". ");
  const candidates = [...new Set([...(row.leadNames ?? []), ...(row.otherNames ?? []), ...round.lead_investors, ...round.other_investors])];
  const namedCandidates = candidates.filter(
    (name) =>
      leadEvidence.toLowerCase().includes(name.toLowerCase()) ||
      round.lead_investors.includes(name) ||
      round.other_investors.includes(name),
  );
  const leads = leadEvidence
    ? cleanInvestors({
        lead_investors: [],
        other_investors: namedCandidates,
        evidence: leadEvidence,
        amount_as_written: figure,
        round: { stage, stage_as_written: round.round_type_as_written, amount_as_written: figure },
      }).lead_investors
    : [];
  const keyset = (names: string[]) => names.map(investorKeyForMerge).sort().join("|");
  const changedLeads =
    !row.isExtension &&
    leads.length > 0 &&
    !(/\bco-led\b/i.test(leadEvidence) && leads.length < 2) &&
    keyset(leads) !== keyset(row.leadNames ?? []);
  const attachLeads = (change: FinancingChange): FinancingChange =>
    changedLeads
      ? {
          ...change,
          leads: {
            from: row.leadNames ?? [],
            to: leads,
            others: [...new Set([...(row.otherNames ?? []), ...(row.leadNames ?? []), ...round.other_investors])].filter(
              (name) => !leads.some((lead) => investorKeyForMerge(name) === investorKeyForMerge(lead)),
            ),
          },
          reason: `${change.reason}; source names ${leads.join(", ")} as leads`,
          evidence: [...new Set([change.evidence, leadEvidence].filter(Boolean))].join(" | "),
        }
      : change;
  if (reading.reviewReason && amountInEvidence(row.amount, quote)) {
    return attachLeads({ id: row.id, company: row.company, review: true, reason: `${reading.url}: ${reading.reviewReason}`, ...evidence });
  }
  const kind = safeMoneyKind(quote, figure, round.money_kind_checked ?? null);
  if (NOT_ROUND.includes(moneyKindFromSentence(quote, row.amount)) && amountInEvidence(row.amount, quote)) {
    return attachLeads({
      id: row.id,
      company: row.company,
      review: true,
      reason: `${reading.url} says this is ${kind}, not a private primary round`,
      ...evidence,
    });
  }
  if (
    (kind === "combined" || kind === "cumulative") &&
    figure &&
    quotedFigure.currency === parseAmount(row.amount).currency &&
    quotedFigure.value === parseAmount(row.amount).value &&
    amountInEvidence(row.amount, quote)
  ) {
    return attachLeads({
      id: row.id,
      company: row.company,
      amount: { from: row.amount, to: null, total: row.amount },
      reason: `${reading.url} states an aggregate, not this round's new money`,
      ...evidence,
    });
  }
  if (
    figure &&
    ["primary", "tranche"].includes(moneyKindFromSentence(quote, figure)) &&
    statedFigure.value !== null &&
    quotedFigure.currency === statedFigure.currency &&
    (statedFigure.value !== parseAmount(row.amount).value || statedFigure.currency !== parseAmount(row.amount).currency) &&
    !(amountLeads.length > 0 && row.stage && amountLeads.some((sentence) => classifyStage(sentence).stage === row.stage)) &&
    !mixedEquityDebtTotal(row.amount, figure, reading.markdown)
  ) {
    return attachLeads({
      id: row.id,
      company: row.company,
      amount: {
        from: row.amount,
        to: figure,
        total: statedFigure.currency !== parseAmount(row.amount).currency ? row.total : row.amount,
      },
      reason: `${reading.url} states ${figure} as the new primary money: ${quote}`,
      ...evidence,
      ...(row.stage === "other" &&
      classifyStage(round.round_type_as_written).stage !== "other" &&
      !(row.pinned && typeof row.pinned === "object" && "stage" in row.pinned)
        ? { stage: { from: row.stage, to: classifyStage(round.round_type_as_written).stage, asWritten: round.round_type_as_written } }
        : {}),
    });
  }
  return changedLeads
    ? attachLeads({ id: row.id, company: row.company, reason: `${reading.url} settles the lead role`, ...evidence })
    : null;
}

function mixedEquityDebtTotal(original: string, proposed: string, markdown: string | undefined): boolean {
  if (!markdown) return false;
  const amounts = (text: string) =>
    [...text.matchAll(/(?:US|AU|NZ|CA|SG|HK|A|C|S)?[$€£]\s*\d[\d,.]*\s*(?:million|billion|bn|m)\b/gi)]
      .map(([figure]) => parseAmount(figure))
      .filter((amount) => amount.value !== null);
  const sentences = pageSentences(markdown);
  if (
    sentences.some(
      (sentence) =>
        amountInEvidence(proposed, sentence) &&
        /\b(?:mix|combination|blend) of (?:primary )?equity and debt\b|\b(?:equity and debt|debt and equity) (?:financing|package)\b/i.test(
          sentence,
        ),
    )
  )
    return true;
  const equity = sentences.filter((sentence) => /\bequity\b/i.test(sentence)).flatMap(amounts);
  const debt = sentences.filter((sentence) => /\bdebt\b/i.test(sentence)).flatMap(amounts);
  const current = parseAmount(original);
  const total = parseAmount(proposed);
  return equity.some(
    (e) =>
      e.currency === current.currency &&
      e.value === current.value &&
      debt.some(
        (d) =>
          d.currency === e.currency &&
          total.currency === e.currency &&
          d.value !== null &&
          total.value !== null &&
          e.value !== null &&
          Math.abs(e.value + d.value - total.value) < 0.01,
      ),
  );
}

/** A source's own sentences can overrule its JSON reader when it conflates a closing and a commitment. */
export function sourceSentenceDecision(
  row: VisibleMoney,
  markdown: string,
  url: string,
  published?: string | null,
): SourceMoneyReading | null {
  if (!row.amount) return null;
  const sentences = pageSentences(markdown);
  const pagePublished = visibleArticleDate(markdown) ?? dateFromUrl(url)?.toISOString().slice(0, 10) ?? published;
  const original = parseAmount(row.amount);
  const mentions = sentences.filter((sentence) => amountInEvidence(row.amount, sentence) && namesCompany(sentence, row.company));
  const own =
    mentions.find((sentence) => !["unknown", "primary"].includes(moneyKindFromSentence(sentence, row.amount))) ??
    mentions.find((sentence) => /\b(?:more than|over|in excess of)\b/i.test(sentence)) ??
    mentions[0];
  const kind = own ? moneyKindFromSentence(own, row.amount) : "unknown";
  if (
    own &&
    /\b(?:more than|over|in excess of)\b/i.test(own) &&
    /\bmajority shareholder\b/i.test(markdown) &&
    !/\b(?:new primary equity|fresh capital of)\b/i.test(own)
  ) {
    return {
      url,
      published: pagePublished,
      markdown,
      reviewReason: "an approximate majority-stake transaction does not isolate new primary proceeds",
      round: {
        company_name: row.company,
        company_website: null,
        company_description: null,
        round_type_as_written: row.stage ?? "funding",
        amount_as_written: null,
        amount_kind: "unknown",
        money_kind_quote: own,
        valuation_as_written: null,
        lead_investors: [],
        other_investors: [],
        announced_date: null,
        headquarters: null,
        sector: null,
        evidence_quote: own,
        source_url: null,
        is_background: false,
        is_rumor: false,
      },
    };
  }
  let quote: string | undefined = own;
  let figure: string | null = null;
  if (own && (NOT_ROUND.includes(kind) || kind === "combined" || kind === "cumulative")) {
    if (kind === "cumulative" && row.stage && row.stage !== "other") {
      const candidates = [...own.matchAll(/(?:US|AU|NZ|CA|SG|HK|A|C|S)?\$\s*\d[\d,.]*\s*(?:million|billion|bn|m)\b/gi)]
        .map((m) => m[0])
        .filter((text) => parseAmount(text).value !== original.value && moneyKindFromSentence(own, text) === "primary");
      figure = candidates.length === 1 && classifyStage(own).stage === row.stage ? candidates[0] : null;
    }
    if (kind === "cumulative" && row.stage === "other") {
      const stageRank: Record<string, number> = { pre_seed: 0, seed: 1, series_a: 2, series_b: 3, series_c: 4, series_d_plus: 5 };
      const nearby = sentences.slice(sentences.indexOf(own), sentences.indexOf(own) + 3).flatMap((sentence) =>
        [...sentence.matchAll(/(?:US|AU|NZ|CA|SG|HK|A|C|S)?\$\s*\d[\d,.]*\s*(?:million|billion|bn|m)\b/gi)]
          .map((m) => ({
            text: m[0],
            sentence,
            rank: stageRank[classifyStage(sentence.slice(m.index + m[0].length, m.index + m[0].length + 32)).stage] ?? -1,
          }))
          .filter((entry) => entry.rank >= 2 && moneyKindFromSentence(entry.sentence, entry.text) === "primary"),
      );
      const highest = Math.max(-1, ...nearby.map((entry) => entry.rank));
      const latest = nearby.filter((entry) => entry.rank === highest);
      if (latest.length === 1) {
        figure = latest[0].text;
        quote = latest[0].sentence;
      }
    }
  } else {
    quote = undefined;
    if (own && original.value !== null && original.currency) {
      const alternative = [...own.matchAll(/(?:US|AU|NZ|CA|SG|HK|A|C|S)?\$\s*\d[\d,.]*\s*(?:million|billion|bn|m)\b/gi)]
        .map((m) => m[0])
        .find((text) => {
          const parsed = parseAmount(text);
          return (
            parsed.value === original.value &&
            parsed.currency !== original.currency &&
            ["primary", "tranche"].includes(moneyKindFromSentence(own, text))
          );
        });
      if (alternative) {
        quote = own;
        figure = alternative;
      }
    }
    if (!quote) {
      for (const sentence of sentences) {
        if (
          !/\b(?:initial|first|second|final)\b.{0,35}\btranche\b/i.test(sentence) ||
          !/\b(?:commitment|committed|expected|future)\b/i.test(sentence)
        )
          continue;
        const figures = [...sentence.matchAll(/(?:US|AU|NZ|CA|SG|HK|A|C|S)?\$\s*\d[\d,.]*\s*(?:million|billion|bn|m)\b/gi)].map((m) => ({
          text: m[0],
          ...parseAmount(m[0]),
        }));
        const closed = figures.find((f) => moneyKindFromSentence(sentence, f.text) === "tranche");
        const future = figures.find((f) => moneyKindFromSentence(sentence, f.text) === "future_commitment");
        if (
          closed?.value === null ||
          future?.value === null ||
          !closed ||
          !future ||
          !original.value ||
          closed.currency !== original.currency ||
          future.currency !== original.currency ||
          Math.abs(closed.value + future.value - original.value) > 0.2
        )
          continue;
        quote = sentence;
        figure = closed.text;
        break;
      }
    }
  }
  if (!quote) return null;
  return {
    url,
    published: pagePublished,
    markdown,
    round: {
      company_name: row.company,
      company_website: null,
      company_description: null,
      round_type_as_written:
        (figure && quote ? /\b(?:pre[ -]?seed|seed|series\s+[a-z](?:[+-]\d+)?)\b/i.exec(quote)?.[0] : null) ?? row.stage ?? "funding",
      amount_as_written: figure,
      amount_kind: figure ? "round" : "unknown",
      money_kind_quote: quote,
      valuation_as_written: null,
      lead_investors: [],
      other_investors: [],
      announced_date: null,
      headquarters: null,
      sector: null,
      evidence_quote: quote,
      source_url: null,
      is_background: false,
      is_rumor: false,
    },
  };
}

/** Replays only visible rows; rejects uncertainty instead of guessing an amount from another round. */
export async function replayFinancing(
  handle: Db,
  opts: {
    apply?: boolean;
    rateFor?: (date: string, currency: string, value: number) => Promise<{ usd: number; rate: number; date: string } | null>;
    readSource?: (
      row: VisibleMoney,
      links: Array<{ url: string; host: string; published: string | null }>,
      domain: string | null,
      investorDomains: string[],
    ) => Promise<SourceMoneyReading | null>;
  } = {},
): Promise<FinancingReplay> {
  const rows = await handle
    .select({ round: fundingRounds, company: companies.name, domain: companies.domain })
    .from(fundingRounds)
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    .where(and(inArray(fundingRounds.disposition, ["publish", "flagged"]), eq(fundingRounds.history, false)));
  const links = rows.length
    ? await handle
        .select({ roundId: roundSources.roundId, host: sources.host, url: sources.url, published: sources.publishedAt })
        .from(roundSources)
        .innerJoin(sources, eq(sources.id, roundSources.sourceId))
        .where(
          inArray(
            roundSources.roundId,
            rows.map((r) => r.round.id),
          ),
        )
    : [];
  const linksByRound = new Map<string, Array<{ url: string; host: string; published: string | null }>>();
  for (const link of links) linksByRound.set(link.roundId, [...(linksByRound.get(link.roundId) ?? []), link]);
  const investorLinks = rows.length
    ? await handle
        .select({ roundId: roundInvestors.roundId, domain: investors.domain, name: investors.name, role: roundInvestors.role })
        .from(roundInvestors)
        .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
        .where(
          inArray(
            roundInvestors.roundId,
            rows.map((r) => r.round.id),
          ),
        )
    : [];
  const investorDomainsByRound = new Map<string, string[]>();
  const investorsByRound = new Map<string, typeof investorLinks>();
  for (const link of investorLinks)
    if (link.domain)
      investorDomainsByRound.set(link.roundId, [...new Set([...(investorDomainsByRound.get(link.roundId) ?? []), link.domain])]);
  for (const link of investorLinks) investorsByRound.set(link.roundId, [...(investorsByRound.get(link.roundId) ?? []), link]);
  const out: FinancingReplay = {
    scanned: rows.length,
    amountCorrections: 0,
    toReview: 0,
    currencyFixes: 0,
    leadCorrections: 0,
    stageCorrections: 0,
    changes: [],
  };
  for (const { round, company, domain } of rows) {
    const entry: VisibleMoney = {
      id: round.id,
      company,
      amount: round.amountAsWritten,
      currency: round.amountCurrency,
      value: round.amountValue,
      usd: round.amountUsdMillions,
      total: round.financingTotalAsWritten,
      quotes: round.evidenceQuotes ?? [],
      pinned: round.pinned,
      disposition: round.disposition,
      stage: round.stage,
      announced: round.announcedOn,
      firstSeen: round.firstSeenAt.toISOString(),
      leadNames: (investorsByRound.get(round.id) ?? []).filter((i) => i.role === "lead").map((i) => i.name),
      otherNames: (investorsByRound.get(round.id) ?? []).filter((i) => i.role !== "lead").map((i) => i.name),
      isExtension: round.isExtension,
    };
    const roundLinks = linksByRound.get(round.id) ?? [];
    let change = financingChange(entry);
    let groundedSource: SourceMoneyReading | null = null;
    if (
      opts.readSource &&
      round.amountAsWritten &&
      (Number(round.amountUsdMillions ?? round.amountValue ?? 0) >= 20 ||
        ["AUD", "CAD", "SGD", "NZD", "HKD"].includes(round.amountCurrency ?? "") ||
        entry.leadNames?.length === 0)
    ) {
      const reading = await opts.readSource(entry, roundLinks, domain, investorDomainsByRound.get(round.id) ?? []);
      const reread = reading ? regroundedChange(entry, reading) : null;
      if (reread?.amount || reread?.review || reread?.leads) {
        change = reread;
        groundedSource = reading;
      }
    }
    if (!change) continue;
    if (change.currency && round.amountValue) {
      if (change.currency.to === "USD") {
        change.currency = { ...change.currency, usd: Number(round.amountValue), rate: 1, date: null };
      } else if (opts.rateFor) {
        const converted = await opts.rateFor(
          round.announcedOn ?? round.firstSeenAt.toISOString().slice(0, 10),
          change.currency.to,
          Number(round.amountValue),
        );
        if (converted) change.currency = { ...change.currency, ...converted };
      }
    }
    let corrected: { value: number; currency: string; usd: number | null; rate: number | null; date: string | null } | null = null;
    if (change.amount?.to) {
      const parsed = parseAmount(change.amount.to);
      if (parsed.value === null || !parsed.currency) continue;
      const rate =
        parsed.currency !== "USD" && opts.rateFor
          ? await opts.rateFor(round.announcedOn ?? round.firstSeenAt.toISOString().slice(0, 10), parsed.currency, parsed.value)
          : null;
      corrected = {
        value: parsed.value,
        currency: parsed.currency,
        usd: parsed.currency === "USD" ? parsed.value : (rate?.usd ?? null),
        rate: parsed.currency === "USD" ? 1 : (rate?.rate ?? null),
        date: rate?.date ?? null,
      };
    }
    if (change.amount) out.amountCorrections++;
    if (change.review) out.toReview++;
    if (change.currency || (corrected && corrected.currency !== round.amountCurrency)) out.currencyFixes++;
    if (change.leads) out.leadCorrections++;
    if (change.stage) out.stageCorrections++;
    out.changes.push(change);
    if (!opts.apply) continue;
    const verification = round.verification ?? { status: "unverified", notes: [], url: null };
    await handle
      .update(fundingRounds)
      .set({
        ...(change.amount
          ? {
              amountValue: corrected?.value.toString() ?? null,
              amountAsWritten: change.amount.to,
              amountCurrency: corrected?.currency ?? null,
              amountUsdMillions: corrected?.usd?.toString() ?? null,
              fxRate: corrected?.rate?.toString() ?? null,
              fxDate: corrected?.date ?? null,
              financingTotalAsWritten: change.amount.total,
              amountScope: change.amount.to ? "tranche" : "financing_total",
            }
          : {}),
        ...(change.currency
          ? {
              amountCurrency: change.currency.to,
              amountUsdMillions: change.currency.usd?.toString() ?? null,
              fxRate: change.currency.rate?.toString() ?? null,
              fxDate: change.currency.date,
            }
          : {}),
        disposition: change.review ? "review" : round.disposition,
        ...(change.stage ? { stage: change.stage.to, stageAsWritten: change.stage.asWritten } : {}),
        ...(groundedSource?.round.evidence_quote && !round.evidenceQuotes.includes(groundedSource.round.evidence_quote)
          ? { evidenceQuotes: [...round.evidenceQuotes, groundedSource.round.evidence_quote] }
          : {}),
        verification: { ...verification, notes: [...new Set([...verification.notes, `financing repair: ${change.reason}`])] },
      })
      .where(eq(fundingRounds.id, round.id));
    if (change.leads && !change.review) await syncRoundInvestors(handle, round.id, change.leads.to, change.leads.others, { replace: true });
    if (groundedSource && isArticleUrl(groundedSource.url)) {
      const sourceId = canonicalUrl(groundedSource.url);
      await handle
        .insert(sources)
        .values({ id: sourceId, url: sourceId, host: hostOf(sourceId) })
        .onConflictDoNothing();
      await handle
        .insert(roundSources)
        .values({
          roundId: round.id,
          sourceId,
          fieldClaims: { evidence: groundedSource.round.money_kind_quote ?? groundedSource.round.evidence_quote },
        })
        .onConflictDoNothing();
    }
  }
  return out;
}
