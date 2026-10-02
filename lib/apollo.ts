// Apollo through Alexandria, at the store. Companies whose domain the identity check verified are
// looked up ten to a call; each gets an `apollo` enrichment row (a miss and a namesake too, so the
// next pass does not pay to ask again). What a page may show from it was measured before it shipped
// (docs/data-quality.md): the LinkedIn page and a headcount where no other provider has one, and the
// logo where the company has none. Its headquarters and its funding figures are never shown: a
// disagreement with ours is a note for an admin, and a funding event the store lacks is a lead the
// history lane searches and verifies like a dossier's prior round.

import type { ApolloEnrichment, ApolloResult, KnownRound } from "@fireround/core";
import { apolloBulk, missingLeads, parseStoredDossier, priorAsKnown, priorKey, promotable } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { holdLateReports } from "./late-report.ts";
import { safeFetch } from "./safe-fetch.ts";

const { companies, enrichments, fundingRounds, historyPromotions } = schema;

export interface ApolloCompany {
  id: string;
  name: string;
  domain: string;
}

/** What an admin may want to look at: where Apollo and the store disagree. Never shown to a visitor. */
export interface ApolloSignals {
  /** Apollo's headquarters beside ours, when the two name different places. */
  hq_disagrees?: { ours: string; apollo: string };
  /** Apollo's total raised beside the sum of the rounds we verified, when it is more than twice as much. */
  funding_gap?: { apollo_usd_millions: number; ours_usd_millions: number };
}

/** The row as stored: the trimmed lookup, the admin signals, and how many leads it queued. */
export interface StoredApollo extends ApolloEnrichment {
  signals: ApolloSignals;
  leads_queued: number;
}

/**
 * Companies with a verified domain, a live round (in this preset, when one is named), and no apollo
 * row yet: the enrich pass's new companies and, for the backfill, the whole store.
 */
export async function pendingApollo(handle: Db, presetSlug: string | null, limit: number): Promise<ApolloCompany[]> {
  const rows = await handle
    .selectDistinct({ id: companies.id, name: companies.name, domain: companies.domain })
    .from(companies)
    .innerJoin(fundingRounds, eq(fundingRounds.companyId, companies.id))
    .leftJoin(enrichments, and(eq(enrichments.companyId, companies.id), eq(enrichments.kind, "apollo")))
    .where(
      and(
        isNotNull(companies.domain),
        ...(presetSlug ? [eq(fundingRounds.presetSlug, presetSlug)] : []),
        inArray(fundingRounds.disposition, ["publish", "flagged"]),
        isNull(enrichments.companyId),
      ),
    )
    .limit(limit);
  return rows.filter((r): r is ApolloCompany => r.domain !== null);
}

const COUNTRIES: Record<string, string> = {
  us: "united states",
  usa: "united states",
  "u s": "united states",
  "u s a": "united states",
  "united states": "united states",
  "united states of america": "united states",
  uk: "united kingdom",
  "u k": "united kingdom",
  "united kingdom": "united kingdom",
  england: "united kingdom",
  britain: "united kingdom",
  "great britain": "united kingdom",
  scotland: "united kingdom",
  wales: "united kingdom",
};

/** Lowercase ASCII words, for comparing place names written two ways ("Cantù" and "Cantu"). */
function plain(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function country(s: string): string {
  const p = plain(s);
  return COUNTRIES[p] ?? p;
}

/**
 * Whether Apollo's headquarters and ours name the same place: our first place ("Antwerp" in
 * "Antwerp, Belgium", "Israel" on its own) appears as a whole word among Apollo's city, region, and
 * country, or Apollo's city appears in ours, or ours is a bare country that is Apollo's country
 * ("UK" and "United Kingdom"). Pure: the tests pin it.
 */
export function hqAgrees(ours: string, apollo: { hq: string | null; country: string | null }): boolean {
  if (!apollo.hq) return true;
  const segments = ours
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const first = plain(segments[0]?.split(/\s+and\s+/i)[0] ?? "");
  if (!first) return true;
  const theirs = ` ${plain(`${apollo.hq} ${apollo.country ?? ""}`)} ${country(apollo.country ?? "")} `;
  if (theirs.includes(` ${first} `)) return true;
  const apolloCity = plain(apollo.hq.split(",")[0] ?? "");
  if (apolloCity && ` ${plain(ours)} `.includes(` ${apolloCity} `)) return true;
  return segments.length === 1 && Boolean(apollo.country) && country(first) === country(apollo.country ?? "");
}

/** Apollo's total counts as a gap when it is more than twice ours and at least $10M more. */
const FUNDING_GAP_MULTIPLE = 2;
const FUNDING_GAP_MIN_USD_MILLIONS = 10;

/**
 * Apollo's funding gap against the total the store holds now. The signal is written when Apollo is
 * read, and history rounds promoted since then raise the store's total: OpenAI's note still said
 * $47B "in the rounds here" beside a $170B Total raised card. Null once the gap no longer holds.
 */
export function currentFundingGap(
  gap: ApolloSignals["funding_gap"],
  oursUsdMillions: number,
): { apollo_usd_millions: number; ours_usd_millions: number } | null {
  if (!gap) return null;
  const apollo = gap.apollo_usd_millions;
  if (apollo > oursUsdMillions * FUNDING_GAP_MULTIPLE && apollo - oursUsdMillions >= FUNDING_GAP_MIN_USD_MILLIONS) {
    return { apollo_usd_millions: apollo, ours_usd_millions: Math.round(oursUsdMillions * 10) / 10 };
  }
  return null;
}

/** The admin signals for one matched lookup against what the store holds. Pure. */
export function apolloSignals(
  result: Extract<ApolloResult, { status: "matched" }>,
  store: { hq: string | null; verifiedUsdMillions: number },
): ApolloSignals {
  const out: ApolloSignals = {};
  if (store.hq && result.hq && !hqAgrees(store.hq, result)) {
    out.hq_disagrees = { ours: store.hq, apollo: [result.hq, result.country].filter(Boolean).join(", ") };
  }
  if (result.total_funding_usd) {
    const apollo = result.total_funding_usd / 1_000_000;
    const ours = store.verifiedUsdMillions;
    if (apollo > ours * FUNDING_GAP_MULTIPLE && apollo - ours >= FUNDING_GAP_MIN_USD_MILLIONS) {
      out.funding_gap = { apollo_usd_millions: Math.round(apollo * 10) / 10, ours_usd_millions: Math.round(ours * 10) / 10 };
    }
  }
  return out;
}

/** Image signatures a logo may carry: JPEG, PNG, GIF, WebP. */
function isImage(bytes: Uint8Array): boolean {
  const at = (i: number, ...b: number[]) => b.every((v, j) => bytes[i + j] === v);
  return (
    at(0, 0xff, 0xd8, 0xff) ||
    at(0, 0x89, 0x50, 0x4e, 0x47) ||
    at(0, 0x47, 0x49, 0x46) ||
    (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
  );
}

/** A real logo weighs more than this; a spacer or a blank tile does not. */
const LOGO_MIN_BYTES = 1024;

/**
 * Whether Apollo's logo URL serves an image worth showing: it loads inside five seconds, its bytes
 * are an image (the S3 URL has no extension and no content type), and it is not a tiny placeholder.
 * The tile component still hides one that leaves no mark.
 */
export async function apolloLogoLoads(url: string): Promise<boolean> {
  try {
    const res = await safeFetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res?.ok) return false;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length >= LOGO_MIN_BYTES && isImage(bytes);
  } catch {
    return false;
  }
}

/** Every round the store, the ledger, and the dossiers already know for a company, as the lead check reads them. */
export async function knownRounds(handle: Db, companyId: string): Promise<KnownRound[]> {
  const [rounds, ledger, dossiers] = await Promise.all([
    handle
      .select({
        stage: fundingRounds.stage,
        label: fundingRounds.stageAsWritten,
        ext: fundingRounds.isExtension,
        usd: fundingRounds.amountUsdMillions,
        on: fundingRounds.announcedOn,
      })
      .from(fundingRounds)
      .where(eq(fundingRounds.companyId, companyId)),
    handle
      .select({ prior: historyPromotions.prior, status: historyPromotions.status })
      .from(historyPromotions)
      .where(eq(historyPromotions.companyId, companyId)),
    handle
      .select({ data: enrichments.data })
      .from(enrichments)
      .where(and(eq(enrichments.companyId, companyId), eq(enrichments.kind, "deep_dive"))),
  ]);
  const unavailable = new Set(ledger.filter((l) => l.status === "no_source" || l.status === "skipped").map((l) => priorKey(l.prior)));
  return [
    ...rounds.map((r) => ({
      stage: r.stage,
      stage_as_written: r.label,
      is_extension: r.ext,
      usd_millions: r.usd === null ? null : Number(r.usd),
      announced_on: r.on,
    })),
    ...ledger.filter((l) => !unavailable.has(priorKey(l.prior))).map((l) => priorAsKnown(l.prior)),
    ...dossiers.flatMap((d) =>
      (parseStoredDossier(d.data)?.prior_rounds ?? []).filter((p) => !unavailable.has(priorKey(p))).map(priorAsKnown),
    ),
  ];
}

/**
 * Put the funding events the store lacks on the history ledger as prior rounds of origin apollo:
 * each is searched, read, and verified like a dossier's, and only a page that states it writes a
 * row. A lead too vague to recognise is written skipped. Returns how many were queued.
 */
export async function queueApolloLeads(
  handle: Db,
  companyId: string,
  result: Extract<ApolloResult, { status: "matched" }>,
  now: Date = new Date(),
): Promise<number> {
  const leads = missingLeads(
    result.funding_events.map((e) => ({ type: e.type, amount: e.amount, date: e.date, source_url: e.source_url })),
    await knownRounds(handle, companyId),
  );
  let queued = 0;
  for (const p of leads) {
    const vague = !promotable(p);
    const rows = await handle
      .insert(historyPromotions)
      .values({
        companyId,
        priorKey: priorKey(p),
        prior: p,
        origin: "apollo",
        status: vague ? "skipped" : "pending",
        nextAttemptAt: now,
        outcome: vague ? { reason: "too vague to recognise: no stage, amount, or day" } : null,
      })
      .onConflictDoNothing()
      .returning({ key: historyPromotions.priorKey });
    if (rows.length > 0 && !vague) queued++;
  }
  return queued;
}

export interface ApolloBatchResult {
  companies: number;
  matched: number;
  credits: number;
  /** Funding events queued as history leads, and the companies they belong to. */
  leads: number;
  leadCompanies: string[];
  /** Rows held as late re-reports on what Apollo reported (lib/late-report.ts). */
  held: string[];
}

/**
 * One pass over a list of companies: the bulk lookups, a row per company (a miss and a namesake
 * too; a failed call writes nothing, so the next pass asks again), the logo where the company has
 * none and Apollo's loads, the admin signals, and, when `leads` is set, the funding events the store
 * lacks queued on the history ledger.
 */
export async function apolloBatch(
  handle: Db,
  client: Firecrawl,
  batch: ApolloCompany[],
  opts: { leads: boolean; checkLogo?: (url: string) => Promise<boolean>; now?: Date },
): Promise<ApolloBatchResult> {
  const out: ApolloBatchResult = { companies: 0, matched: 0, credits: 0, leads: 0, leadCompanies: [], held: [] };
  if (batch.length === 0) return out;
  const checkLogo = opts.checkLogo ?? apolloLogoLoads;
  const results = await apolloBulk(
    client,
    batch.map((c) => ({ company_key: c.id, company_name: c.name, domain: c.domain })),
  );
  for (const e of results) {
    out.credits += e.credits;
    if (e.apollo.status === "error") continue;
    out.companies++;
    const companyId = e.company_key;
    let signals: ApolloSignals = {};
    let leadsQueued = 0;
    if (e.apollo.status === "matched") {
      out.matched++;
      const [company] = await handle
        .select({
          hq: companies.hq,
          logoUrl: companies.logoUrl,
          verified: sql<
            string | null
          >`(select sum(f.amount_usd_millions) from funding_rounds f where f.company_id = ${companyId} and f.disposition in ('publish', 'flagged'))`,
        })
        .from(companies)
        .where(eq(companies.id, companyId));
      signals = apolloSignals(e.apollo, { hq: company?.hq ?? null, verifiedUsdMillions: Number(company?.verified ?? 0) });
      if (company && !company.logoUrl && e.apollo.logo_url && (await checkLogo(e.apollo.logo_url))) {
        await handle
          .update(companies)
          .set({ logoUrl: sql`coalesce(${companies.logoUrl}, ${e.apollo.logo_url})`, updatedAt: new Date() })
          .where(eq(companies.id, companyId));
      }
      if (opts.leads) {
        leadsQueued = await queueApolloLeads(handle, companyId, e.apollo, opts.now);
        if (leadsQueued > 0) {
          out.leads += leadsQueued;
          out.leadCompanies.push(companyId);
        }
      }
    }
    const data: StoredApollo = { ...e, signals, leads_queued: leadsQueued };
    const sourceUrl = e.apollo.status === "matched" ? e.apollo.linkedin_url : null;
    await handle
      .insert(enrichments)
      .values({ companyId, kind: "apollo", data, schemaVersion: e.schema_version, sourceUrl })
      .onConflictDoUpdate({
        target: [enrichments.companyId, enrichments.kind],
        set: { data, schemaVersion: e.schema_version, sourceUrl, fetchedAt: new Date() },
      });
    // Apollo's events are a lead source: a row they show is a late re-report is held before this
    // sweep delivers (Assort Health's Series C, listed for 2026-06, came back dated 2026-09-25).
    if (e.apollo.status === "matched") out.held.push(...(await holdLateReports(handle, [companyId])));
  }
  out.credits = Math.round(out.credits);
  return out;
}

export interface ApolloCoverage {
  /** Visible companies with a verified domain, and how many have an apollo row. */
  companies: number;
  looked_up: number;
  matched: number;
  namesake: number;
  none: number;
  credits: number;
  /** Matched rows whose LinkedIn page passed the check, and those that fill a gap FullEnrich left. */
  linkedin: number;
  linkedin_gap_filled: number;
  headcount_gap_filled: number;
  hq_disagrees: number;
  funding_gap: number;
  /** Apollo leads on the history ledger, by status. */
  leads: Record<string, number>;
}

/** Where the store stands with Apollo: the backfill route's progress read. */
export async function apolloCoverage(handle: Db): Promise<ApolloCoverage> {
  const [[visible], rows, leadRows] = await Promise.all([
    handle
      .execute<{ n: number }>(
        sql`select count(distinct c.id)::int as n from companies c join funding_rounds f on f.company_id = c.id where c.domain is not null and f.disposition in ('publish', 'flagged')`,
      )
      .then((r) => r.rows),
    handle
      .select({ companyId: enrichments.companyId, kind: enrichments.kind, data: enrichments.data })
      .from(enrichments)
      .where(inArray(enrichments.kind, ["apollo", "alexandria"])),
    handle
      .select({ status: historyPromotions.status, n: sql<number>`count(*)::int` })
      .from(historyPromotions)
      .where(eq(historyPromotions.origin, "apollo"))
      .groupBy(historyPromotions.status),
  ]);
  type Firmographics = { status: string; linkedin_url?: string | null; headcount?: number | null };
  const fullEnrich = new Map(
    rows
      .filter((r) => r.kind === "alexandria")
      .map((r) => [r.companyId, (r.data as { firmographics?: Firmographics }).firmographics ?? null]),
  );
  const apolloRows = rows.filter((r) => r.kind === "apollo");
  const out: ApolloCoverage = {
    companies: Number(visible?.n ?? 0),
    looked_up: apolloRows.length,
    matched: 0,
    namesake: 0,
    none: 0,
    credits: 0,
    linkedin: 0,
    linkedin_gap_filled: 0,
    headcount_gap_filled: 0,
    hq_disagrees: 0,
    funding_gap: 0,
    leads: Object.fromEntries(leadRows.map((r) => [r.status, r.n])),
  };
  for (const r of apolloRows) {
    const d = r.data as StoredApollo;
    out.credits += d.credits ?? 0;
    if (d.apollo.status === "namesake") out.namesake++;
    if (d.apollo.status === "none") out.none++;
    if (d.apollo.status !== "matched") continue;
    out.matched++;
    const firmo = fullEnrich.get(r.companyId);
    const fe = firmo?.status === "matched" ? firmo : null;
    if (d.apollo.linkedin_url) {
      out.linkedin++;
      if (!fe?.linkedin_url) out.linkedin_gap_filled++;
    }
    if (d.apollo.headcount && !fe?.headcount) out.headcount_gap_filled++;
    if (d.signals?.hq_disagrees) out.hq_disagrees++;
    if (d.signals?.funding_gap) out.funding_gap++;
  }
  out.credits = Math.round(out.credits);
  return out;
}

/** The backfill's knobs, as the route reads them. */
export interface ApolloBackfillParams {
  /** Companies to look up at most; null for every one without a row. */
  limit: number | null;
  /** No new call starts once the credits spent reach this. */
  maxCredits: number;
  /** Queue the funding events the store lacks as history leads (the history backfill searches them). */
  leads: boolean;
}

/** A ceiling above a full pass over today's store: about 430 companies at 30 credits for each match. */
export const APOLLO_BACKFILL_MAX_CREDITS = 15_000;

/** The route's params from a query string or a JSON body; an error names the bad one. Pure. */
export function parseApolloBackfillParams(input: Record<string, unknown>): ApolloBackfillParams | { error: string } {
  const int = (key: string, fallback: number | null, min: number, max: number): number | null | { error: string } => {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return { error: `${key} must be a whole number from ${min} to ${max}` };
    return n;
  };
  const limit = int("limit", null, 1, 100_000);
  const maxCredits = int("maxCredits", APOLLO_BACKFILL_MAX_CREDITS, 0, 1_000_000);
  for (const v of [limit, maxCredits]) if (v !== null && typeof v === "object") return v;
  const leadsRaw = input.leads;
  const leads = leadsRaw === undefined || leadsRaw === null || leadsRaw === "" ? true : !["0", "false", false].includes(leadsRaw as string);
  return { limit: limit as number | null, maxCredits: maxCredits as number, leads };
}
