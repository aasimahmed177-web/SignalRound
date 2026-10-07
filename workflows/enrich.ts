// Enrich companies that have no profile yet: what they sell, who buys, whether
// they charge a subscription, and the pricing model when a pricing page exists.
// The homepage must verify as the record's company before any of it is written.
// Then the investors on those rounds get their website domain, and their logo off that homepage.

import { INVESTOR_BACKLOG_PER_RUN, investorDomainCap } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { start } from "workflow/api";
import { type AlexandriaCompany, alexandriaBatch, pendingAlexandria } from "@/lib/alexandria";
import { db } from "@/lib/db";
import { type EnrichCompany, enrichBatch } from "@/lib/enrich";
import { invalidateAllEntityPages, invalidateEntityPages } from "@/lib/entity-invalidation";
import { getFirecrawl } from "@/lib/firecrawl";
import { fetchInvestorLogos, resolveInvestorDomains } from "@/lib/investor-enrich";
import { bumpRunCount, recordRun } from "@/lib/persist";
import { getCoverage } from "@/lib/settings";
import { companyHistoryWorkflow } from "@/workflows/history";

const BATCH = 10;

export async function enrichWorkflow(
  presetSlug: string,
  runId: string,
  limit: number,
): Promise<{ companies: number; resolved: number; pricing: number; credits: number; alexandria: number }> {
  "use workflow";
  const startedAt = new Date().toISOString();
  const r = await enrichPending(presetSlug, limit);
  await recordStep(runId, presetSlug, startedAt, r.credits + r.alexandriaCredits + r.investorCredits, {
    companies: r.companies,
    resolved: r.resolved,
    pricing: r.pricing,
    alexandria: r.alexandria,
    investor_domains: r.investorDomains,
    investor_domains_resolved: r.investorDomainsResolved,
    investor_logos: r.investorLogos,
    investor_logos_found: r.investorLogosFound,
  });
  return r;
}

/** A company to enrich with what the record already knows about it, the context that grounds the website search. */
export type PendingCompany = EnrichCompany;

export interface EnrichPendingResult {
  companies: number;
  resolved: number;
  pricing: number;
  credits: number;
  alexandria: number;
  /** Every Alexandria credit this pass: the YC lookups. */
  alexandriaCredits: number;
  /** Investors searched for a website domain this pass, and how many resolved. */
  investorDomains: number;
  investorDomainsResolved: number;
  /** Investor homepages read for a logo this pass (branding scrapes), and how many had one. */
  investorLogos: number;
  investorLogosFound: number;
  /** The searches' credits and the logo reads', and their sum, which is what the run's estimate adds. */
  investorDomainCredits: number;
  investorLogoCredits: number;
  investorCredits: number;
}

/** The rounds a caller just persisted, whose investors this pass may search besides the enriched companies'. */
export interface EnrichScope {
  roundIds?: string[];
}

/**
 * Enrich this preset's companies that have no profile yet, up to `limit`, in batches. The sweep
 * and the single-candidate ingest call this after they persist, so a record reaches the feed
 * with its logo and description on the first read, not after someone presses a button. The
 * investors get their logos in the same pass, but only those named on the rounds in scope: the
 * companies just enriched and the rounds the caller just persisted. The backlog is the backfill
 * script's, so an ingest of one page searches only its own round's investors.
 */
export async function enrichPending(presetSlug: string, limit: number, scope: EnrichScope = {}): Promise<EnrichPendingResult> {
  const pending = await pendingStep(presetSlug, limit);
  let resolved = 0;
  let pricing = 0;
  let credits = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const r = await enrichStep(pending.slice(i, i + BATCH));
    resolved += r.resolved;
    pricing += r.pricing;
    credits += r.credits;
  }
  // Alexandria runs after the homepage pass so the batch's newly verified domains count; the
  // pending list also picks up the backlog of verified companies without a row.
  const alexPending = await pendingAlexandriaStep(presetSlug, limit);
  let alexandria = 0;
  let alexandriaCredits = 0;
  for (let i = 0; i < alexPending.length; i += BATCH) {
    const r = await alexandriaStep(alexPending.slice(i, i + BATCH));
    alexandria += r.companies;
    alexandriaCredits += r.credits;
  }
  await startLeadHistoryStep(
    pending.map((c) => c.id),
    scope.roundIds,
  );
  // Investor websites last: this pass's own investors, capped in proportion to it (20 a round or
  // company in scope, 60 at most), then a slice of the preset's backlog, then logo reads for what in
  // scope already had a domain.
  const roundIds = [...new Set(scope.roundIds ?? [])];
  const companyIds = pending.map((c) => c.id);
  const investorDomains = await investorDomainsStep(presetSlug, {
    roundIds,
    companyIds,
    limit: investorDomainCap(roundIds.length + companyIds.length),
  });
  const investorBacklog = await investorBacklogStep(presetSlug);
  for (const k of Object.keys(investorDomains) as Array<keyof InvestorStepResult>) investorDomains[k] += investorBacklog[k];
  return {
    companies: pending.length,
    resolved,
    pricing,
    credits,
    alexandria,
    alexandriaCredits,
    investorDomains: investorDomains.searched,
    investorDomainsResolved: investorDomains.resolved,
    investorLogos: investorDomains.logos,
    investorLogosFound: investorDomains.logosFound,
    investorDomainCredits: investorDomains.credits,
    investorLogoCredits: investorDomains.logoCredits,
    investorCredits: investorDomains.credits + investorDomains.logoCredits,
  };
}

export async function pendingStep(presetSlug: string, limit: number): Promise<PendingCompany[]> {
  "use step";
  const handle = await db();
  const rows = await handle
    .selectDistinct({
      id: schema.companies.id,
      name: schema.companies.name,
      website: schema.companies.website,
      description: schema.companies.description,
      hq: schema.companies.hq,
      sector: schema.companies.sector,
    })
    .from(schema.companies)
    .innerJoin(schema.fundingRounds, eq(schema.fundingRounds.companyId, schema.companies.id))
    .leftJoin(schema.enrichments, and(eq(schema.enrichments.companyId, schema.companies.id), eq(schema.enrichments.kind, "profile")))
    .where(
      and(
        eq(schema.fundingRounds.presetSlug, presetSlug),
        inArray(schema.fundingRounds.disposition, ["publish", "flagged"]),
        // No profile row, or the retry row a clear leaves with the old row's refused hosts. A company
        // a repair has just cleared keeps a row the whole time, so the lane never takes it mid-repair.
        or(isNull(schema.enrichments.companyId), sql`${schema.enrichments.data} ->> 'retry' = 'true'`),
      ),
    )
    .limit(limit);
  return rows;
}

export async function enrichStep(companies: PendingCompany[]): Promise<{ resolved: number; pricing: number; credits: number }> {
  "use step";
  const handle = await db();
  // The Lite rung reads the homepage only; every other rung follows the pricing link too.
  const plan = await getCoverage(handle);
  const { resolved, pricing, credits } = await enrichBatch(handle, getFirecrawl(), companies, {
    pricingPage: plan.enrichment !== "homepage",
  });
  if (companies.length) await invalidateEntityPages(handle, { companyIds: companies.map((company) => company.id) });
  return { resolved, pricing, credits };
}

/**
 * The companies Alexandria runs for this pass: those with a verified domain and no row yet.
 * The list doubles as the gate: the Lite rung buys none of it, so it returns empty.
 */
export async function pendingAlexandriaStep(presetSlug: string, limit: number): Promise<AlexandriaCompany[]> {
  "use step";
  const handle = await db();
  const plan = await getCoverage(handle);
  if (plan.alexandria === "off") return [];
  return pendingAlexandria(handle, presetSlug, limit);
}

export async function alexandriaStep(companies: AlexandriaCompany[]): Promise<{ companies: number; credits: number }> {
  "use step";
  if (companies.length === 0) return { companies: 0, credits: 0 };
  const handle = await db();
  const { companies: n, credits } = await alexandriaBatch(handle, getFirecrawl(), companies);
  await invalidateEntityPages(handle, { companyIds: companies.map((company) => company.id) });
  return { companies: n, credits };
}

/** Start timeline recall for the feed's companies without making the sweep wait on the searches. */
export async function startLeadHistoryStep(companyIds: string[], roundIds: string[] = []): Promise<void> {
  "use step";
  const handle = await db();
  const scoped =
    roundIds.length === 0
      ? []
      : await handle
          .select({ companyId: schema.fundingRounds.companyId })
          .from(schema.fundingRounds)
          .where(and(inArray(schema.fundingRounds.id, roundIds), eq(schema.fundingRounds.history, false)));
  for (const id of new Set([...companyIds, ...scoped.map((r) => r.companyId)])) await start(companyHistoryWorkflow, [id]);
}

export interface InvestorStepResult {
  searched: number;
  resolved: number;
  credits: number;
  logos: number;
  logosFound: number;
  logoCredits: number;
}

/**
 * The Lite rung's investor pass, as it ran before homepages were read: one search each and the
 * snippet's pick, 25 a pass and 10 from the backlog, so the cheapest rung stays a few pages a week.
 */
const LITE_INVESTORS_PER_RUN = 25;
const LITE_BACKLOG_PER_RUN = 10;

/** Whether this instance's rung reads investor homepages for a verdict (every rung but Lite). */
async function verifiesInvestors(handle: Awaited<ReturnType<typeof db>>): Promise<boolean> {
  return (await getCoverage(handle)).enrichment !== "homepage";
}

/**
 * Resolutions a step runs at once. Each is a search and a homepage verdict or two (tens of seconds),
 * so a pass of 60 at four at a time would outlast a step; eight keeps the scoped pass to a few minutes.
 */
const INVESTOR_CONCURRENCY = 8;

function tally(out: InvestorStepResult, r: Awaited<ReturnType<typeof resolveInvestorDomains>>): void {
  out.searched += r.searched;
  out.resolved += r.resolved;
  out.credits += r.credits;
  out.logos += r.logos?.scraped ?? 0;
  out.logosFound += r.logos?.found ?? 0;
  out.logoCredits += r.logos?.credits ?? 0;
}

/**
 * One capped pass over the investors on the rounds in scope (this preset's, visible): a website
 * resolution for those without one, whose homepage verdict also brings the logo and profile, then
 * logo reads for those in scope that already had a domain, capped at `limit` too. The backlog is
 * its own step after it. Every rung runs both. A logo is cosmetic, so a failure here (the store, the API)
 * is logged and never fails the sweep it rides on.
 */
export async function investorDomainsStep(
  presetSlug: string,
  scope: { roundIds: string[]; companyIds: string[]; limit: number },
): Promise<InvestorStepResult> {
  "use step";
  const out: InvestorStepResult = { searched: 0, resolved: 0, credits: 0, logos: 0, logosFound: 0, logoCredits: 0 };
  if (scope.limit > 0) {
    const inScope = { presetSlug, roundIds: scope.roundIds, companyIds: scope.companyIds, concurrency: INVESTOR_CONCURRENCY };
    try {
      const handle = await db();
      const verify = await verifiesInvestors(handle);
      const limit = verify ? scope.limit : Math.min(scope.limit, LITE_INVESTORS_PER_RUN);
      tally(out, await resolveInvestorDomains(handle, getFirecrawl(), { ...inScope, limit, verify }));
      const backlog = await fetchInvestorLogos(handle, getFirecrawl(), { ...inScope, limit: scope.limit });
      out.logos += backlog.scraped;
      out.logosFound += backlog.found;
      out.logoCredits += backlog.credits;
    } catch (err) {
      console.error(`investor domains: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (out.resolved || out.logosFound) await invalidateAllEntityPages();
  return out;
}

/** Days before a miss is resolved again by the backlog pass: a firm's site or the search's index may have changed. */
const INVESTOR_RETRY_DAYS = 30;

/**
 * Up to INVESTOR_BACKLOG_PER_RUN of this preset's investors beyond the pass's own scope that no pass
 * has checked, or whose miss is a month old, newest rounds first. The history and watch lanes add
 * rounds without an enrichment pass of their own, and a capped pass leaves the rest; before this ran,
 * those investors were never searched at all (880 of the 1,050 unchecked on 2026-09-25 came from
 * the history lane). Logged, never thrown, like the scoped pass.
 */
export async function investorBacklogStep(presetSlug: string): Promise<InvestorStepResult> {
  "use step";
  const out: InvestorStepResult = { searched: 0, resolved: 0, credits: 0, logos: 0, logosFound: 0, logoCredits: 0 };
  try {
    const handle = await db();
    const verify = await verifiesInvestors(handle);
    tally(
      out,
      await resolveInvestorDomains(handle, getFirecrawl(), {
        presetSlug,
        limit: verify ? INVESTOR_BACKLOG_PER_RUN : LITE_BACKLOG_PER_RUN,
        retryAfterDays: INVESTOR_RETRY_DAYS,
        concurrency: INVESTOR_CONCURRENCY,
        verify,
      }),
    );
  } catch (err) {
    console.error(`investor backlog: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (out.resolved || out.logosFound) await invalidateAllEntityPages();
  return out;
}

/**
 * Record an enrichment pass on the run of the lane that triggered it, for a caller that keeps no
 * run of its own (a monitor check's or a manual ingest's page): the counts, and the credits added
 * to the run's estimate, so Runs shows what the page's enrichment and investor logos cost. The run
 * row must exist; an ingest records its check first.
 */
export async function recordEnrichmentStep(runId: string, r: EnrichPendingResult): Promise<void> {
  "use step";
  const handle = await db();
  const credits = r.credits + r.alexandriaCredits + r.investorCredits;
  if (credits > 0) {
    await handle
      .update(schema.runs)
      .set({ creditsEstimated: sql`coalesce(${schema.runs.creditsEstimated}, 0) + ${credits}` })
      .where(eq(schema.runs.id, runId));
  }
  const counts: Record<string, number> = {
    enriched: r.companies,
    enrichment_credits: r.credits,
    alexandria: r.alexandria,
    alexandria_credits: r.alexandriaCredits,
    investor_domains: r.investorDomains,
    investor_domains_resolved: r.investorDomainsResolved,
    investor_domain_credits: r.investorDomainCredits,
    investor_logos: r.investorLogos,
    investor_logos_found: r.investorLogosFound,
    investor_logo_credits: r.investorLogoCredits,
  };
  for (const [key, by] of Object.entries(counts)) await bumpRunCount(handle, runId, key, by);
}

async function recordStep(
  runId: string,
  presetSlug: string,
  startedAt: string,
  credits: number,
  counts: Record<string, number>,
): Promise<void> {
  "use step";
  const handle = await db();
  await recordRun(handle, {
    id: runId,
    presetSlug,
    lane: "enrich",
    startedAt: new Date(startedAt),
    finishedAt: new Date(),
    creditsEstimated: credits,
    counts,
  });
}
