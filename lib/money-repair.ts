// Stored rows replayed under the money and visibility rules (records/valuation.ts, invariants.ts,
// source-fit.ts secondhandOnly), for rows written before them. A valuation no sentence the row keeps
// supports for this round is blanked (a contradicted one also flags the row); a row that breaks an
// invariant, or that only databases, profile pages, or forums state, goes to Review with the reason.
// A pinned valuation and a row a person already rejected are left alone. Dry run by default: the
// script lists what would change and writes nothing (`pnpm repair-money`).
//
// Re-ground mode (`--reground`): a valuation no stored sentence supports is most often right, from a
// row that kept only its amount's sentence (Anthropic's $8B, Stoke Space's $10B). Such a row's own
// sources are read again, originals first and at most four, by the blind money read-back
// (regroundValuation): a grounded sentence that states the stored figure keeps it with its quote, one
// that states another figure corrects it and flags the row, and none blanks it. A valuation a sentence
// places at another round, or that is a total, is affirmative evidence and is blanked without a read.

import {
  canonicalUrl,
  DEFAULT_TIERS,
  type FeedRecord,
  invariantBreach,
  type MoneyReading,
  moneyPrompt,
  type ReadPages,
  regroundValuation,
  type SiblingRound,
  secondhandOnly,
  sourcesToRead,
  type ValuationClaim,
  valuationVerdict,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { eq, inArray, ne } from "drizzle-orm";
import { loadPublisherTiers } from "./rules.ts";

const { companies, fundingRounds, pageVerdicts, roundSources, sources } = schema;

export interface MoneyChange {
  id: string;
  company: string;
  /** What the replay would do to the valuation, and why: blank it, keep it with the sentence a re-ground found, or correct it. */
  valuation?: {
    from: string;
    reason: string;
    contradicted: boolean;
    action: "blank" | "keep" | "correct" | "hold";
    claim?: ValuationClaim;
    /** The sentence that decided a blank: the stored one the rule read, or the one the re-ground cited. */
    quote?: string | null;
  };
  review?: string;
  /** A re-ground that could not run (no page read, a model error): the row is left as it is. */
  error?: string;
}

export interface MoneyRepair {
  rows: number;
  valuations: number;
  valuationsBlanked: number;
  toReview: number;
  /** Re-ground mode's outcomes; zero without it. */
  reground: { tried: number; kept: number; corrected: number; held: number; blanked: number; errors: number };
  changes: MoneyChange[];
}

/** What re-ground mode reads with: the pages, the money reading, and a pause between rows so the model and Firecrawl are asked gently. */
export interface RegroundDeps {
  read: ReadPages;
  generate: (prompt: string) => Promise<MoneyReading>;
  pauseMs?: number;
}

/** Whether a reason says the valuation is another round's or a total, not just unstated. */
function contradicts(reason: string): boolean {
  return /another round|an earlier round|dates another|total/.test(reason);
}

/** A total is affirmative evidence even for re-ground: the figure is money raised, never a valuation, and no read can make it one. */
function isTotal(reason: string): boolean {
  return /total raised|financing's total/.test(reason);
}

/**
 * Replay every stored round (a rejected one aside) under the rules; with `apply`, write the changes.
 * Returns the counts and each change with its reason.
 */
export async function replayMoneyRules(handle: Db, opts: { apply?: boolean; reground?: RegroundDeps } = {}): Promise<MoneyRepair> {
  const rows = await handle
    .select({ round: fundingRounds, company: companies.name, domain: companies.domain, website: companies.website })
    .from(fundingRounds)
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    .where(ne(fundingRounds.disposition, "rejected"));
  const links = rows.length
    ? await handle
        .select({ roundId: roundSources.roundId, url: sources.url, title: sources.title, host: sources.host })
        .from(roundSources)
        .innerJoin(sources, eq(sources.id, roundSources.sourceId))
        .where(
          inArray(
            roundSources.roundId,
            rows.map((r) => r.round.id),
          ),
        )
    : [];
  const byRound = new Map<string, typeof links>();
  for (const l of links) byRound.set(l.roundId, [...(byRound.get(l.roundId) ?? []), l]);
  const urls = [...new Set(links.map((l) => canonicalUrl(l.url)))];
  const kinds = new Map<string, string>();
  if (urls.length) {
    for (const v of await handle
      .select({ url: pageVerdicts.url, kind: pageVerdicts.kind })
      .from(pageVerdicts)
      .where(inArray(pageVerdicts.url, urls))
      .orderBy(pageVerdicts.createdAt))
      kinds.set(canonicalUrl(v.url), v.kind);
  }
  const tiers = { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
  const siblingsOf = new Map<string, SiblingRound[]>();
  for (const { round } of rows) {
    siblingsOf.set(round.companyId, [
      ...(siblingsOf.get(round.companyId) ?? []),
      {
        id: round.id,
        stage: round.stage,
        stageAsWritten: round.stageAsWritten,
        isExtension: round.isExtension,
        announcedOn: round.announcedOn,
        amountScope: round.amountScope,
      },
    ]);
  }

  const out: MoneyRepair = {
    rows: rows.length,
    valuations: 0,
    valuationsBlanked: 0,
    toReview: 0,
    reground: { tried: 0, kept: 0, corrected: 0, held: 0, blanked: 0, errors: 0 },
    changes: [],
  };
  for (const { round, company, domain, website } of rows) {
    const roundLinks = byRound.get(round.id) ?? [];
    const record = {
      id: round.id,
      company_name: company,
      stage: round.stage as FeedRecord["stage"],
      stage_as_written: round.stageAsWritten,
      is_extension: round.isExtension,
      announced_date: round.announcedOn,
      amount: {
        value: round.amountValue === null ? null : Number(round.amountValue),
        currency: round.amountCurrency,
        as_written: round.amountAsWritten,
        usd_millions: round.amountUsdMillions === null ? null : Number(round.amountUsdMillions),
        fx_rate: null,
        fx_date: null,
      },
      valuation_as_written: round.valuationAsWritten,
      valuation_claims: (round.valuationClaims ?? undefined) as ValuationClaim[] | undefined,
      financing_total_as_written: round.financingTotalAsWritten,
      amount_scope: round.amountScope as FeedRecord["amount_scope"],
      evidence_quotes: round.evidenceQuotes ?? [],
      sources: roundLinks.map((l) => ({ url: l.url, host: l.host, title: l.title ?? undefined })),
    };
    const change: MoneyChange = { id: round.id, company };
    if (round.valuationAsWritten) out.valuations++;
    const pinned = round.pinned && "valuation" in round.pinned;
    const verdict = pinned ? null : valuationVerdict(record);
    const why = verdict?.reason ?? null;
    // Re-ground reads every unsupported valuation again, "another round" ones too, except a total.
    if (why && round.valuationAsWritten && !isTotal(why) && opts.reground) {
      out.reground.tried++;
      const found = await reground({ ...record, company_domain: domain, company_website: website }, opts.reground, tiers);
      if ("error" in found) {
        change.error = found.error;
        out.reground.errors++;
      } else if (found.outcome === "held") {
        // Only a funding database states it: the value stays, unconfirmed, and a reader checks it.
        change.valuation = {
          from: round.valuationAsWritten,
          reason: `only a funding database states it (${found.url})`,
          contradicted: true,
          action: "hold",
        };
        out.reground.held++;
      } else if (found.outcome === "blanked") {
        change.valuation = {
          from: round.valuationAsWritten,
          reason: found.reason,
          contradicted: false,
          action: "blank",
          quote: found.quote ?? null,
        };
        out.reground.blanked++;
        out.valuationsBlanked++;
      } else if (
        found.outcome === "corrected" &&
        invariantBreach({ ...record, valuation_as_written: found.claim.value }, siblingsOf.get(round.companyId) ?? []) &&
        !invariantBreach(record, siblingsOf.get(round.companyId) ?? [])
      ) {
        // A page's figure that breaks a hard rule (a valuation below the round's own amount) is a typo on the page, not a correction.
        change.valuation = {
          from: round.valuationAsWritten,
          reason: `the page states ${found.claim.value}, which breaks a hard rule, so the stored value stays for a reader to check`,
          contradicted: true,
          action: "hold",
        };
        out.reground.held++;
      } else {
        const corrected = found.outcome === "corrected";
        change.valuation = {
          from: round.valuationAsWritten,
          reason: corrected ? `the pages state ${found.claim.value}` : "a sentence on its own sources states it",
          contradicted: corrected,
          action: corrected ? "correct" : "keep",
          claim: found.claim,
        };
        out.reground[corrected ? "corrected" : "kept"]++;
      }
      if (opts.reground.pauseMs) await new Promise((r) => setTimeout(r, opts.reground?.pauseMs));
    } else if (why && round.valuationAsWritten) {
      change.valuation = {
        from: round.valuationAsWritten,
        reason: why,
        contradicted: contradicts(why),
        action: "blank",
        quote: verdict?.quote ?? null,
      };
      out.valuationsBlanked++;
    }
    const review =
      invariantBreach(
        {
          ...record,
          valuation_as_written:
            change.valuation?.action === "blank"
              ? null
              : change.valuation?.action === "correct"
                ? (change.valuation.claim?.value ?? null)
                : record.valuation_as_written,
        },
        siblingsOf.get(round.companyId) ?? [],
      ) ??
      (secondhandOnly(
        roundLinks.map((l) => l.url),
        tiers,
        kinds,
      )
        ? "only funding databases, profile pages, or forums state it"
        : null);
    if (review && round.disposition !== "review") {
      change.review = review;
      out.toReview++;
    }
    if (!change.valuation && !change.review && !change.error) continue;
    out.changes.push(change);
    if (!opts.apply) continue;
    const v = (round.verification as { status: string; notes: string[]; url: string | null } | null) ?? {
      status: "unverified",
      notes: [],
      url: null,
    };
    if (!change.valuation && !change.review) continue;
    const a = change.valuation;
    const notes = [
      ...v.notes,
      ...(a?.action === "blank" ? [`valuation ${a.from} dropped: ${a.reason}`] : []),
      ...(a?.action === "correct" ? [`valuation ${a.from} read as ${a.claim?.value} (${a.claim?.url})`] : []),
      ...(a?.action === "hold" ? [`valuation ${a.from} unconfirmed: ${a.reason}`] : []),
      ...(change.review ? [`held for review: ${change.review}`] : []),
    ];
    await handle
      .update(fundingRounds)
      .set({
        ...(a?.action === "blank" ? { valuationAsWritten: null, valuationClaims: null } : {}),
        ...(a?.claim ? { valuationAsWritten: a.claim.value, valuationClaims: [a.claim] } : {}),
        disposition: change.review
          ? "review"
          : change.valuation?.contradicted && round.disposition === "publish"
            ? "flagged"
            : round.disposition,
        verification: { ...v, notes: [...new Set(notes)] },
      })
      .where(eq(fundingRounds.id, round.id));
  }
  return out;
}

/** One row's re-ground: its sources read (originals first, at most four) and the money reading checked against them. */
async function reground(
  record: Parameters<typeof regroundValuation>[0] &
    Pick<FeedRecord, "company_domain" | "company_website"> & { sources: Array<{ url: string; host: string; title?: string }> },
  deps: RegroundDeps,
  tiers: Record<string, number>,
): Promise<ReturnType<typeof regroundValuation> | { error: string }> {
  const first = sourcesToRead({ ...(record as unknown as FeedRecord), sources: record.sources });
  if (first.length === 0) return { error: "no source to read" };
  // The next pages, originals first, for a second read; with none left, the same pages are read once more.
  const rest = record.sources.filter((s) => !first.some((f) => f.url === s.url));
  const second = rest.length > 0 ? sourcesToRead({ ...(record as unknown as FeedRecord), sources: rest }) : first;
  try {
    let result: ReturnType<typeof regroundValuation> | { error: string } = { error: "no source could be read" };
    for (const batch of [first, second]) {
      const pages = await deps.read(batch);
      if (pages.length === 0) continue;
      result = regroundValuation(record, await deps.generate(moneyPrompt(record, pages)), pages, tiers);
      // A read that grounds no valuation is tried once more before the valuation is blanked.
      if (result.outcome !== "blanked") return result;
    }
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
