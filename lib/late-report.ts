// The late re-report hold. A page's byline can date an old round as today's (Assort Health's June 24
// Series C came back from a September 25 profile as "$120M funding", and went to Slack as new). The
// store often already holds the evidence: the company's history rows, its checked dossier's prior
// rounds, the history ledger's leads, and its rows whose day a page states (a Form D filing's among
// them). Here, any of those that reports the same round well before a day the company never stated
// holds the row: out of delivery, and in review when it has not gone out yet (flagged, with the note,
// when it has).

import type { FeedRecord, PriorRound, Stage } from "@fireround/core";
import {
  BAND_OF_STAGE,
  classifyStage,
  extractRounds,
  isArticleUrl,
  isStageless,
  normalizeCompanyKey,
  parseStoredDossier,
  priorAsKnown,
  priorDateRange,
  resolveRounds,
  STAGES,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { staleForNews } from "./deliverable.ts";
import { getFirecrawl } from "./firecrawl.ts";
import { REREPORT_CORROBORATED_WINDOW_DAYS, SAME_STAGE_WINDOW_DAYS } from "./persist.ts";

const { fundingRounds, enrichments, historyPromotions, deliveries, sources, roundSources, companies } = schema;

const DAY = 86_400_000;

/** One report of a round from a lead or history source: its stage when it names one, its figure, and its day or month. */
export interface RoundLead {
  stage: Stage | null;
  usdMillions: number | null;
  /** YYYY-MM-DD, YYYY-MM, or YYYY. */
  date: string | null;
  /** Where the report came from, as the hold note names it ("the company dossier", a ledger lead, a row id). */
  origin: string;
  /** The label and figure as the source writes them, for the note. */
  label: string;
  /** A stored round whose day a page states (or a verified history round): strong enough to hold a row with a stated day too. */
  stated?: boolean;
  sourceUrl?: string;
}

/** A participation post reports an already named financing, rather than announcing the financing. */
export function participantReport(evidence: string, stage: string): boolean {
  if (!/\b(?:series\s+[a-z]|(?:pre-)?seed)\b/i.test(stage)) return false;
  if (!evidence.toLowerCase().includes(stage.toLowerCase())) return false;
  return /\b(?:as part of (?:its|the|\w+['’]s)?\s*(?:recently announced\s+)?(?:series\s+[a-z]|(?:pre-)?seed)|join(?:s|ed|ing)?\s+(?:the|its)?\s*(?:series\s+[a-z]|(?:pre-)?seed)|participat(?:ed|es|ing)\s+in\s+(?:the|its)?\s*(?:series\s+[a-z]|(?:pre-)?seed)|adds?\s+to\s+its\s+recently\s+announced\s+(?:series\s+[a-z]|(?:pre-)?seed)|latest\s+close\s+of\s+(?:its|the)?\s*(?:series\s+[a-z]|(?:pre-)?seed))\b/i.test(
    evidence,
  );
}

export interface OriginalAnnouncement extends RoundLead {
  sourceUrl: string;
  amount?: FeedRecord["amount"];
  evidence?: string;
}

/** Search only a participant's named stage, then read an actual grounded announcement, never a search snippet as fact. */
export async function findOriginalAnnouncement(
  company: string,
  domain: string | null,
  stage: string,
  reportedOn?: string,
): Promise<OriginalAnnouncement | null> {
  const client = getFirecrawl();
  const result = await client.search(`"${company}" ${stage} funding`, { sources: ["web", "news"], limit: 10, highlights: true });
  const candidates = [...(result.web ?? []), ...(result.news ?? [])]
    .map((s) => ({
      url: "url" in s ? s.url : "metadata" in s ? s.metadata?.sourceURL : undefined,
      title: "title" in s ? s.title : "metadata" in s ? s.metadata?.title : undefined,
    }))
    .filter((s): s is { url: string; title: string } =>
      Boolean(s.url && s.title && isArticleUrl(s.url) && s.title.toLowerCase().includes(stage.toLowerCase())),
    );
  // The company's own announcement is preferred to syndication or an investor's follow-on note.
  candidates.sort((a, b) => Number(Boolean(domain && b.url.includes(domain))) - Number(Boolean(domain && a.url.includes(domain))));
  for (const candidate of candidates.slice(0, 4)) {
    const extraction = await extractRounds(
      client,
      [{ url: candidate.url, title: candidate.title, query: `original: ${company} ${stage}` }],
      {
        concurrency: 1,
        maxAge: 7 * DAY,
      },
    );
    const original = resolveRounds(extraction.items, { stages: [...STAGES], windowStart: new Date("2000-01-01T00:00:00Z") }).kept.find(
      (r) =>
        normalizeCompanyKey(r.company_name) === normalizeCompanyKey(company) &&
        classifyStage(r.stage_as_written).stage === classifyStage(stage).stage &&
        r.date_precision === "day" &&
        r.announced_date &&
        r.date_basis !== "result" &&
        r.evidence_quotes.some((q) => /\b(?:announc\w*|rais\w*|complet\w*|clos\w*)\b/i.test(q) && !participantReport(q, stage)),
    );
    if (original?.announced_date && (!reportedOn || staleForNews(original.announced_date, new Date(`${reportedOn}T00:00:00Z`))))
      return {
        stage: original.stage,
        usdMillions: original.amount.usd_millions,
        date: original.announced_date,
        origin: "the original announcement",
        label: [original.stage_as_written, original.amount.as_written].filter(Boolean).join(" "),
        stated: original.date_basis === "stated",
        sourceUrl: candidate.url,
        amount: original.amount,
        evidence: original.evidence_quotes[0],
      };
  }
  return null;
}

/** A row the hold may apply to, with what the rule compares. */
export interface HoldCandidate {
  id: string;
  stage: string;
  announcedOn: string | null;
  dateBasis: string | null;
  amountUsdMillions: number | null;
  history: boolean;
}

/** The stage family a hold compares: the band of a named equity stage, the stage itself for debt and the like, none when stageless. */
function family(stage: string | null): string | null {
  if (!stage || isStageless(stage as Stage)) return null;
  return BAND_OF_STAGE[stage as Stage] ?? stage;
}

/**
 * The lead that makes this row a late re-report, or null. The row is not history and has a day and a
 * known figure; the lead states the same figure within a tenth, the same stage family when both name
 * one, and its latest possible day (the end of its month when it gives only a month) is more than 45
 * days before the row's and inside three years. A day the row's page states ("launched today with
 * $5.5 million") yields only to a stored round whose own day is stated: a lead's month is weeks
 * off often enough that it holds only a borrowed day (a byline, a URL, a search result, a list). Pure.
 */
export function lateReportLead(row: HoldCandidate, leads: RoundLead[]): RoundLead | null {
  if (row.history || !row.announcedOn || row.amountUsdMillions === null || row.amountUsdMillions <= 0) return null;
  const rowAt = new Date(`${row.announcedOn}T00:00:00Z`).getTime();
  if (Number.isNaN(rowAt)) return null;
  const rowFamily = family(row.stage);
  for (const lead of leads) {
    if (row.dateBasis === "stated" && !lead.stated) continue;
    if (lead.usdMillions === null || lead.usdMillions <= 0) continue;
    const larger = Math.max(lead.usdMillions, row.amountUsdMillions);
    if (Math.abs(lead.usdMillions - row.amountUsdMillions) > larger * 0.1) continue;
    const leadFamily = family(lead.stage);
    if (rowFamily && leadFamily && rowFamily !== leadFamily) continue;
    const end = priorDateRange(lead.date)?.to.getTime();
    if (end === undefined) continue;
    const days = (rowAt - end) / DAY;
    if (days > SAME_STAGE_WINDOW_DAYS && days <= REREPORT_CORROBORATED_WINDOW_DAYS) return lead;
  }
  return null;
}

/** The note a held row carries: which source reported the round, when, and why the row's own day is not the round's. */
export function holdNote(row: Pick<HoldCandidate, "announcedOn" | "dateBasis">, lead: RoundLead): string {
  const basis = row.dateBasis === "stated" ? "a day its page states" : `a ${row.dateBasis ?? "borrowed"} date, not one the company stated`;
  return `held: ${lead.origin} reports ${lead.label} dated ${lead.date}, more than ${SAME_STAGE_WINDOW_DAYS} days before this row's ${row.announcedOn} (${basis}); likely a late re-report of that round, so it is not delivered until a person checks it`;
}

function priorLead(p: PriorRound, origin: string): RoundLead {
  const known = priorAsKnown(p);
  return {
    stage: known.stage,
    usdMillions: known.usd_millions,
    date: p.announced_date,
    origin,
    label: [p.stage_as_written, p.amount_as_written].filter(Boolean).join(" ") || "a round",
  };
}

/**
 * Every report of this company's rounds the store holds apart from its feed rows: the checked
 * dossier's prior rounds, the history ledger's priors, and the company's history rows and rows whose
 * day the company stated.
 */
export async function companyLeads(handle: Db, companyId: string): Promise<RoundLead[]> {
  const [dossiers, ledger, rows] = await Promise.all([
    handle
      .select({ data: enrichments.data })
      .from(enrichments)
      .where(and(eq(enrichments.companyId, companyId), eq(enrichments.kind, "deep_dive"))),
    handle
      .select({ prior: historyPromotions.prior, origin: historyPromotions.origin })
      .from(historyPromotions)
      .where(eq(historyPromotions.companyId, companyId)),
    handle
      .select({
        id: fundingRounds.id,
        stage: fundingRounds.stage,
        stageAsWritten: fundingRounds.stageAsWritten,
        amountAsWritten: fundingRounds.amountAsWritten,
        usd: fundingRounds.amountUsdMillions,
        on: fundingRounds.announcedOn,
      })
      .from(fundingRounds)
      .where(
        and(
          eq(fundingRounds.companyId, companyId),
          ne(fundingRounds.disposition, "rejected"),
          sql`(${fundingRounds.history} or ${fundingRounds.dateBasis} = 'stated')`,
        ),
      ),
  ]);
  const out: RoundLead[] = [];
  for (const d of dossiers) for (const p of parseStoredDossier(d.data)?.prior_rounds ?? []) out.push(priorLead(p, "the company dossier"));
  for (const l of ledger) out.push(priorLead(l.prior as PriorRound, `the history ledger (${l.origin})`));
  for (const r of rows)
    out.push({
      stage: r.stage,
      usdMillions: r.usd === null ? null : Number(r.usd),
      date: r.on,
      origin: `round ${r.id}`,
      label: [r.stageAsWritten, r.amountAsWritten].filter(Boolean).join(" "),
      stated: true,
    });
  return out;
}

/**
 * Hold every row of these companies that a lead source shows is a late re-report: the reason on the
 * row (hold, and the note in its verification), out of delivery from then on, and in review unless it
 * already went out to a channel, when it stays visible as flagged with the note. A row already held,
 * rejected, or history is left alone. Returns the ids held now.
 */
export async function holdLateReports(
  handle: Db,
  companyIds: string[],
  options: {
    searchOriginal?: (company: string, domain: string | null, stage: string, reportedOn: string) => Promise<OriginalAnnouncement | null>;
  } = {},
): Promise<string[]> {
  const held: string[] = [];
  for (const companyId of new Set(companyIds)) {
    const rows = await handle
      .select()
      .from(fundingRounds)
      .where(and(eq(fundingRounds.companyId, companyId), eq(fundingRounds.history, false), ne(fundingRounds.disposition, "rejected")));
    const open = rows.filter((r) => r.announcedOn);
    if (open.length === 0) continue;
    const leads = await companyLeads(handle, companyId);
    for (const r of open) {
      if (r.hold && !r.hold.startsWith("held: ")) continue;
      const links = await handle.select({ evidence: roundSources.fieldClaims }).from(roundSources).where(eq(roundSources.roundId, r.id));
      const participant = links.some((l) => participantReport(String(l.evidence?.evidence ?? ""), r.stageAsWritten));
      const lead = lateReportLead(
        {
          id: r.id,
          stage: r.stage,
          announcedOn: r.announcedOn,
          dateBasis: r.dateBasis,
          amountUsdMillions: r.amountUsdMillions === null ? null : Number(r.amountUsdMillions),
          history: r.history,
        },
        leads.filter((l) => l.origin !== `round ${r.id}`),
      );
      if (!lead && !participant) continue;
      if (r.hold && !participant) continue;
      const note = lead
        ? holdNote(r, lead)
        : `held: ${r.stageAsWritten} appears as a participant in an already named round; checking the original announcement before treating it as news`;
      const [sent] = await handle
        .select({ roundId: deliveries.roundId })
        .from(deliveries)
        .where(and(eq(deliveries.roundId, r.id), eq(deliveries.status, "sent")))
        .limit(1);
      const verification = (r.verification as { status: string; notes: string[]; url: string | null } | null) ?? {
        status: "unverified",
        notes: [],
        url: null,
      };
      await handle
        .update(fundingRounds)
        .set({
          hold: note,
          disposition: sent ? (r.disposition === "review" ? "review" : "flagged") : "review",
          verification: { ...verification, notes: verification.notes.includes(note) ? verification.notes : [...verification.notes, note] },
          updatedAt: new Date(),
        })
        .where(eq(fundingRounds.id, r.id));
      held.push(r.id);
      if (!participant) continue;
      const [company] = await handle
        .select({ name: companies.name, domain: companies.domain })
        .from(companies)
        .where(eq(companies.id, companyId));
      if (!company || (!process.env.FIRECRAWL_API_KEY && !options.searchOriginal)) continue;
      const original = await (options.searchOriginal ?? findOriginalAnnouncement)(
        company.name,
        company.domain,
        r.stageAsWritten,
        r.announcedOn as string,
      ).catch(() => null);
      if (!original?.date || !staleForNews(original.date, new Date(`${r.announcedOn}T00:00:00Z`))) continue;
      const confirmed = `history: ${original.origin} dated ${original.date} (${original.sourceUrl}); participant report is not a new round`;
      const amount = original.amount?.as_written && original.amount.value !== null ? original.amount : null;
      await handle
        .update(fundingRounds)
        .set({
          history: true,
          ...(r.pinned?.announced_on ? {} : { announcedOn: original.date, dateBasis: original.stated ? "stated" : "page" }),
          ...(amount
            ? {
                amountValue: amount.value?.toString(),
                amountCurrency: amount.currency,
                amountAsWritten: amount.as_written,
                amountUsdMillions: amount.usd_millions?.toString() ?? null,
                fxRate: amount.fx_rate?.toString() ?? null,
                fxDate: amount.fx_date,
                evidenceQuotes: [...new Set([...(r.evidenceQuotes ?? []), ...(original.evidence ? [original.evidence] : [])])],
              }
            : {}),
          hold: confirmed,
          disposition: sent ? "flagged" : "review",
          verification: { ...verification, notes: [...new Set([...verification.notes, confirmed])] },
          updatedAt: new Date(),
        })
        .where(eq(fundingRounds.id, r.id));
      const sourceId = original.sourceUrl;
      await handle
        .insert(sources)
        .values({ id: sourceId, url: sourceId, host: new URL(sourceId).hostname, title: original.label, publishedAt: original.date })
        .onConflictDoNothing();
      await handle
        .insert(roundSources)
        .values({ roundId: r.id, sourceId, fieldClaims: { title: original.label, evidence: original.evidence ?? null } })
        .onConflictDoNothing();
    }
  }
  return held;
}
