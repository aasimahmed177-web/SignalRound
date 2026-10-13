// What a company request adds around the history lane: a quick branding read so the page has a face
// before the identity check answers, and a quick funding search whose candidate rounds join the
// ledger as leads (origin search) while the Deep dive is still running. Neither decides anything: the
// identity check gates the request, and every lead is verified by the lane like any other.

import type { Enrichment, ExtractedItem, FundingLead, HistoryCandidate, KnownRound, Stage } from "@fireround/core";
import {
  brandFrom,
  canonicalUrl,
  companySite,
  extractionCredits,
  homepageLogo,
  linkedSites,
  missingLeads,
  namesCompany,
  normalizeCompanyKey,
  normalizeSector,
  parseStoredDossier,
  priorKey,
  promotable,
  rankHistoryCandidates,
  registrableDomain,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import type { CompanyRequestBrand } from "@fireround/core/db/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { cleanBrandName, searchName } from "./brand-name.ts";
import { isVerified, readProfiles, saveProfiles } from "./enrich.ts";
import { classifyCandidates, type HistoryReader } from "./history.ts";
import { knownRounds } from "./known-rounds.ts";
import { holdLateReports } from "./late-report.ts";

const { companies, companyAliases, enrichments, historyPromotions } = schema;

/** The homepage's brand as the branding format reads it, or null when the read fails or finds none. */
export async function readBrand(client: Pick<Firecrawl, "scrape">, url: string): Promise<CompanyRequestBrand | null> {
  try {
    const home = await client.scrape(url, { formats: ["branding", "links"], onlyMainContent: false, timeout: 20_000 });
    const brand = brandFrom(home.branding, url);
    const logo = homepageLogo(home, url);
    const domain = registrableDomain(url);
    const sites = domain ? linkedSites(home.links ?? [], domain) : [];
    if (!brand && !logo && sites.length === 0) return null;
    const name = brand?.name ? cleanBrandName(brand.name, domain) : null;
    return { name, logo, color: brand?.primary_color ?? null, ...(sites.length > 0 ? { sites } : {}) };
  } catch {
    return null;
  }
}

/**
 * The company a homepage belongs to, through the identity check a request runs: a stored company (by
 * its domain, or the domain as its id, the ids most stored companies carry) with a verified profile is
 * taken as it is; otherwise the homepage is read, and only a verified profile adds the company (named
 * by its brand without the tagline, "Resend · Email for developers") and saves the profile. `sites` are
 * the sibling sites the homepage links, where the company publishes too (tldraw.dev for tldraw.com).
 * `fresh` is true when the profile was read and saved now.
 */
export async function companyFromHomepage(
  handle: Db,
  client: Firecrawl,
  site: { domain: string; url: string; sites: string[] },
): Promise<{ status: "verified"; companyId: string; fresh: boolean } | { status: "refused" }> {
  const [existing] = await handle
    .select()
    .from(companies)
    .where(or(eq(companies.domain, site.domain), eq(companies.id, site.domain)))
    .limit(1);
  const companyId = existing?.id ?? site.domain;
  const saveSites = async (owner: string) => {
    if (site.sites.length === 0) return;
    await handle
      .insert(companyAliases)
      .values(site.sites.map((s) => ({ companyId: owner, kind: "domain" as const, aliasKey: s, alias: s, sourceUrl: site.url })))
      .onConflictDoNothing();
  };
  if (existing) {
    const [profile] = await handle
      .select({ data: enrichments.data })
      .from(enrichments)
      .where(and(eq(enrichments.companyId, companyId), eq(enrichments.kind, "profile")))
      .limit(1);
    if (profile && isVerified(profile.data as Enrichment) && (profile.data as Enrichment).profile) {
      await saveSites(companyId);
      return { status: "verified", companyId, fresh: false };
    }
  }
  const name = existing?.name ?? site.domain.split(".")[0];
  const result = await readProfiles(
    handle,
    client,
    [{ id: companyId, name, website: site.url, description: null, hq: null, sector: null }],
    { pricingPage: false },
  );
  const verified = result.enrichments.find((enrichment) => isVerified(enrichment) && enrichment.profile);
  if (!verified) return { status: "refused" };
  const brandName = verified.brand?.name ? cleanBrandName(verified.brand.name, site.domain) : null;
  const companyName = brandName && brandName.length <= 80 ? brandName : name;
  if (!existing) {
    await handle
      .insert(companies)
      .values({ id: companyId, name: companyName, nameKey: normalizeCompanyKey(companyName), domain: site.domain, website: site.url })
      .onConflictDoNothing();
  }
  await saveProfiles(handle, result);
  const [owner] = await handle.select({ id: companies.id }).from(companies).where(eq(companies.domain, site.domain)).limit(1);
  await saveSites(owner?.id ?? companyId);
  return { status: "verified", companyId: owner?.id ?? companyId, fresh: true };
}

/** The classifier's is_round below this: sure the result states no round of the company. Above SURE_ROUND: sure it does. */
export const NO_ROUND = 0.2;
const SURE_ROUND = 0.8;

const STAGE =
  /\b(?:(?:first|second|third|another)\s+extension\s+of\s+(?:its|the)\s+)?(pre-?seed|seed|angel|series\s+[a-k](?:[- ]?\d+)?)\b(?:\s+(?:extension|round|funding|financing))?/i;
const AMOUNT = /(?:US|CA|AU)?[$€£]\s?\d+(?:[.,]\d+)?\s?(?:million|billion|mn|bn|m|b|k)\b/i;
const FUNDING = /\b(?:rais\w*|fund\w*|round|invest\w*|backed|closes?|secures?)\b/i;

/** The searches a request runs for a company's funding announcements, beside the Deep dive. */
export function fundingQueries(name: string): string[] {
  return [`"${name}" raises`, `"${name}" funding`, `"${name}" seed round`];
}

/**
 * A search result as funding leads. The first round its title or snippet states is the page's own,
 * with its amount and the page's day. A snippet can state more: a query-relevant highlight quotes a
 * funding table ("Seed Round, $3M, December 2018") or an earlier round ("a $30 million Series B it
 * announced five months ago"). Each other stage stated with an amount beside it becomes a lead too,
 * undated; a bare "a Series C company" is not one. Every lead is checked against its own announcement before it becomes a round.
 * With the classifier's verdict: a result it is sure states no round of the company ("in talks to
 * raise", "which raised $20M last year") is no lead, and one it is sure states one is a lead even
 * when only its snippet names the company or it names no stage (a database's "raised $10M"), still only a lead.
 */
export function leadsFromCandidate(candidate: HistoryCandidate, company: { name: string; domain: string | null }): FundingLead[] {
  const text = `${candidate.title ?? ""}. ${candidate.description ?? ""}`.replace(
    new RegExp(`(?:at|worth|valued at)\\s+${AMOUNT.source}|${AMOUNT.source}\\s+(?:valuation|valued)`, "gi"),
    "valuation",
  );
  const verdict = candidate.verdict;
  if (verdict && verdict.isRound < NO_ROUND) return [];
  const sure = Boolean(verdict && verdict.isRound >= SURE_ROUND);
  // A sibling site (tldraw.dev) is the company's too; a lead is only something to verify, and the verification holds it to the company's name.
  const own = companySite(candidate.url, company) !== null;
  const named = namesCompany(candidate.title ?? "", company.name, { share: 1 }) || (sure && namesCompany(text, company.name, { share: 1 }));
  if (!own && !named) return [];
  const firstStage = STAGE.exec(text);
  const nearbyAmount = (index: number, label: string) => {
    const before = new RegExp(`(${AMOUNT.source})\\s+(?:in\\s+)?$`, "i").exec(text.slice(Math.max(0, index - 40), index));
    const after = new RegExp(`^[\\s|,:*-]*(?:of\\s+)?(${AMOUNT.source})`, "i").exec(
      text.slice(index + label.length, index + label.length + 40),
    );
    return (before ?? after)?.[1].trim() ?? null;
  };
  const amountStated = firstStage
    ? (nearbyAmount(firstStage.index, firstStage[0]) ?? AMOUNT.exec(text.slice(0, firstStage.index))?.[0].trim() ?? null)
    : (AMOUNT.exec(text)?.[0].trim() ?? null);
  const stage = STAGE.exec(text)?.[0] ?? (sure && amountStated ? "Funding round" : undefined);
  if (!stage || !(FUNDING.test(text) || sure)) return [];
  const day = /^\d{4}-\d{2}-\d{2}/.exec(candidate.published ?? "")?.[0];
  const fromUrl = /\/(20\d{2})\/(\d{2})(?:\/(\d{2}))?\//.exec(candidate.url);
  const date = day ?? (fromUrl ? [fromUrl[1], fromUrl[2], fromUrl[3]].filter(Boolean).join("-") : null);
  const leads: FundingLead[] = [{ type: stage.trim(), amount: amountStated, date, source_url: candidate.url }];
  const seen = new Set([`${stageKey(stage)}|${amountStated}`]);
  for (const m of text.matchAll(new RegExp(STAGE.source, "gi"))) {
    const amount = nearbyAmount(m.index, m[0]);
    if (!amount) continue;
    const key = `${stageKey(m[0])}|${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    leads.push({ type: m[0].trim(), amount, date: null, source_url: candidate.url });
  }
  return leads;
}

function stageKey(stage: string): string {
  return stage
    .toLowerCase()
    .replace(/\s+(?:extension|round|funding|financing)$/, "")
    .replace(/[\s-]+/g, "");
}

/** Search results as leads the store, the dossier, and the ledger do not already hold, queued under `origin`. */
async function queueLeads(
  handle: Db,
  reader: HistoryReader,
  companyId: string,
  found: HistoryCandidate[],
  origin: "search" | "gap",
  now: Date,
  limit = Number.POSITIVE_INFINITY,
) {
  const [company] = await handle.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) return 0;
  const classified = await classifyCandidates(reader, searchName(company.name, company.domain), found);
  return queueRoundLeads(
    handle,
    companyId,
    classified.flatMap((c) => leadsFromCandidate(c, { ...company, name: searchName(company.name, company.domain) })),
    origin,
    now,
    limit,
  );
}

async function queueRoundLeads(handle: Db, companyId: string, found: FundingLead[], origin: "search" | "gap", now: Date, limit: number) {
  const leads = missingLeads(found, await knownRounds(handle, companyId)).slice(0, Math.max(0, limit));
  let queued = 0;
  for (const p of leads) {
    if (!promotable(p)) continue;
    // A merge can fold the company into another while the search runs; the survivor keeps its own ledger, so the leads end here.
    const rows = await handle
      .insert(historyPromotions)
      .values({ companyId, priorKey: priorKey(p), prior: p, origin, status: "pending", nextAttemptAt: now })
      .onConflictDoUpdate({
        target: [historyPromotions.companyId, historyPromotions.priorKey],
        set: { prior: p, origin, status: "pending", nextAttemptAt: now, attempts: 0, lastError: null, outcome: null, updatedAt: now },
        setWhere: sql`${historyPromotions.status} = 'no_source' and ${p.source_url ?? null}::text is not null and coalesce(${historyPromotions.prior}->>'source_url', '') <> ${p.source_url ?? ""}`,
      })
      .returning({ key: historyPromotions.priorKey })
      .catch((err: unknown) => {
        if ((err as { cause?: { code?: unknown } }).cause?.code === "23503") return null;
        throw err;
      });
    if (!rows) break;
    queued += rows.length;
  }
  // A lead can show that a feed row is a late re-report of an older round: held before it is delivered.
  if (queued > 0) await holdLateReports(handle, [companyId]);
  return queued;
}

/** A company's new post may explicitly recount an old round; it joins the history ledger, never the news feed. */
export async function queueNewsroomHistoryLeads(handle: Db, companyId: string, items: ExtractedItem[], now = new Date()): Promise<number> {
  const [company] = await handle.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) return 0;
  const leads = items
    .filter((item) => item.grounded !== false && namesCompany(item.round.company_name, company.name, { share: 1 }))
    .filter((item) => item.round.announced_date && new Date(item.round.announced_date).getTime() < now.getTime() - 7 * 86_400_000)
    .map(({ round, source }) => ({
      type: round.round_type_as_written,
      amount: round.amount_kind === "valuation" || round.amount_kind === "total_funding" ? null : round.amount_as_written,
      date: round.announced_date,
      source_url: source.url,
    }));
  return queueRoundLeads(handle, companyId, leads, "search", now, 3);
}

/**
 * The quick funding search: a few searches and the company's own site map, each result that states a
 * round of this company becoming a lead the store, the dossier, and the ledger do not already hold.
 * Returns the leads queued and the credits spent.
 */
export async function queueFundingSearch(handle: Db, reader: HistoryReader, companyId: string, now = new Date()) {
  const [company] = await handle.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) return { queued: 0, credits: 0 };
  const name = searchName(company.name, company.domain);
  // Its own site and the first sibling its homepage links (tldraw.dev for tldraw.com), each mapped for its funding posts.
  const [sibling] = await handle
    .select({ site: companyAliases.aliasKey })
    .from(companyAliases)
    .where(and(eq(companyAliases.companyId, companyId), eq(companyAliases.kind, "domain")))
    .limit(1);
  const sites = company.domain ? [company.domain, ...(sibling ? [sibling.site] : [])] : [];
  const found = await Promise.all([
    ...fundingQueries(name).map((q) => reader.search(q, 10).catch(() => [])),
    ...sites.map((site) => reader.map(site, `${name} funding raises series seed`).catch(() => [])),
  ]);
  const credits = fundingQueries(name).length * 2 + sites.length;
  return { queued: await queueLeads(handle, reader, companyId, found.flat(), "search", now), credits };
}

/** The lettered ladder a company climbs; a gap is a rung below the highest one known with nothing on it. */
const LADDER: Stage[] = ["seed", "series_a", "series_b", "series_c", "series_d_plus"];
const LADDER_QUERY: Partial<Record<Stage, string>> = {
  seed: "seed round",
  series_a: "Series A",
  series_b: "Series B",
  series_c: "Series C",
};
/** At most this many gap searches per request: each is one search, two credits. */
export const MAX_GAP_QUERIES = 4;

/**
 * The searches for rounds the known ones imply but nobody found: every rung below the highest known
 * with nothing on it (a Series C with no Series B, a Series A with no seed), and, when the earliest
 * known round is not a seed, the year before it. Nothing when there is no gap.
 */
export function gapQueries(name: string, known: KnownRound[]): string[] {
  const rungs: Stage[] = [];
  for (const k of known) {
    const stage: Stage | null = k.stage === "pre_seed" ? "seed" : k.stage;
    if (stage && LADDER.includes(stage)) rungs.push(stage);
  }
  if (rungs.length === 0) return [];
  const top = Math.max(...rungs.map((s) => LADDER.indexOf(s)));
  const queries = LADDER.slice(0, top)
    .filter((s) => !rungs.includes(s) && LADDER_QUERY[s])
    .map((s) => `"${name}" ${LADDER_QUERY[s]}`);
  const years = known.map((k) => Number(k.announced_on?.slice(0, 4))).filter((y) => y > 1990);
  if (!rungs.includes("seed") && years.length > 0) queries.push(`"${name}" raises ${Math.min(...years) - 1}`);
  return queries.slice(0, MAX_GAP_QUERIES);
}

export const TIMELINE_PAGES = 12;
export const TIMELINE_LEADS = 32;
export const TIMELINE_RECHECK_DAYS = 7;
/**
 * A forced pass (a new round landed) still skips a company whose last pass started within the hour:
 * forced passes wait out workflows/history.ts TIMELINE_SETTLE first, so two lanes landing one
 * company's round in the same hour would otherwise both pay for one.
 */
export const TIMELINE_FORCE_GAP_MS = 60 * 60_000;

export async function queueCompanyTimeline(handle: Db, reader: HistoryReader, companyId: string, now = new Date(), force = false) {
  const [company] = await handle.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) return { queued: 0, credits: 0, pages: 0 };
  const runId = `history-timeline:${companyId}`;
  const claimed = await handle
    .insert(schema.runs)
    .values({ id: runId, presetSlug: "history-timeline", lane: "history", startedAt: now })
    .onConflictDoUpdate({
      target: schema.runs.id,
      set: { startedAt: now, finishedAt: null, error: null },
      setWhere: sql`(${schema.runs.finishedAt} < ${new Date(now.getTime() - (force ? TIMELINE_FORCE_GAP_MS : TIMELINE_RECHECK_DAYS * 86_400_000))} or (${schema.runs.finishedAt} is null and ${schema.runs.startedAt} < ${new Date(now.getTime() - 30 * 60_000)}))`,
    })
    .returning({ id: schema.runs.id });
  if (claimed.length === 0) return { queued: 0, credits: 0, pages: 0 };
  let queued = 0;
  let credits = 0;
  let pages = 0;
  try {
    const name = searchName(company.name, company.domain);
    const [aliases, articles] = await Promise.all([
      handle
        .select({ site: companyAliases.aliasKey })
        .from(companyAliases)
        .where(and(eq(companyAliases.companyId, companyId), eq(companyAliases.kind, "domain")))
        .limit(3),
      handle
        .select({
          url: schema.sources.url,
          title: schema.sources.title,
          published: schema.sources.publishedAt,
          evidence: schema.fundingRounds.evidenceQuotes,
        })
        .from(schema.fundingRounds)
        .innerJoin(schema.roundSources, eq(schema.roundSources.roundId, schema.fundingRounds.id))
        .innerJoin(schema.sources, eq(schema.sources.id, schema.roundSources.sourceId))
        .where(and(eq(schema.fundingRounds.companyId, companyId), eq(schema.fundingRounds.history, false)))
        .limit(6),
    ]);
    const sites = [...new Set([...(company.domain ? [company.domain] : []), ...aliases.map((a) => a.site)])].slice(0, 3);
    const queries = fundingQueries(name);
    credits += queries.length * 2 + sites.length;
    const found = (
      await Promise.all([
        ...queries.map((q) => reader.search(q, 10)),
        ...sites.map((site) => reader.map(site, `${name} funding raises series seed`)),
      ])
    ).flat();
    const feed: HistoryCandidate[] = articles.map((a) => ({
      url: a.url,
      title: a.title ?? undefined,
      published: a.published ?? undefined,
      description: a.evidence.join(" "),
      via: "lead",
    }));
    queued += await queueLeads(handle, reader, companyId, [...found, ...feed], "search", now, TIMELINE_LEADS);
    const known = await knownRounds(handle, companyId);
    const letters = [...new Set(known.flatMap((k) => /\bseries\s+([a-k])/i.exec(k.stage_as_written ?? "")?.[1]?.toUpperCase() ?? []))];
    const extensions = letters.flatMap((letter) => [`"${letter}1"`, `"${letter}-2"`]).join(" OR ");
    const gaps = [
      ...gapQueries(name, known).slice(0, MAX_GAP_QUERIES - 1),
      `"${name}" funding "extension" OR "another extension"${extensions ? ` OR ${extensions}` : ""}`,
    ];
    credits += gaps.length * 2;
    const gapResults = (await Promise.all(gaps.map((q) => reader.search(q, 10)))).flat();
    queued += await queueLeads(handle, reader, companyId, gapResults, "gap", now, TIMELINE_LEADS - queued);
    const classified = await classifyCandidates(reader, name, [...feed, ...found, ...gapResults]);
    const ranked = rankHistoryCandidates(classified, {
      company: { name, domain: company.domain, sites },
      prior: { stage_as_written: "Funding round", amount_as_written: null, announced_date: null, lead_investors: [] },
      max: TIMELINE_PAGES,
    });
    const candidates = [...new Map([...feed, ...ranked].map((c) => [canonicalUrl(c.url), c])).values()].slice(0, TIMELINE_PAGES);
    for (const candidate of candidates) {
      // Enrichment can fold a new company into the row that owns its domain while this reads; the fold
      // moves the ledger, so pages read after it would only be paid for.
      const [still] = await handle.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).limit(1);
      if (!still) break;
      const extraction = await reader.extract([
        { url: candidate.url, title: candidate.title, published: candidate.published, query: `${name} funding history` },
      ]);
      credits += extractionCredits(extraction.pages.filter((p) => p.ok).map((p) => p.url));
      pages++;
      const leads = extraction.items
        .filter((i) => namesCompany(i.round.company_name, name, { share: 1 }))
        .map(({ round }) => ({
          type: round.round_type_as_written,
          amount: round.amount_kind === "valuation" || round.amount_kind === "total_funding" ? null : round.amount_as_written,
          date: round.announced_date,
          source_url: candidate.url,
        }));
      queued += await queueRoundLeads(handle, companyId, leads, "search", now, TIMELINE_LEADS - queued);
    }
    await handle
      .update(schema.runs)
      .set({ finishedAt: now, creditsEstimated: credits, counts: { queued, pages } })
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.startedAt, now)));
    return { queued, credits, pages };
  } catch (error) {
    await handle
      .update(schema.runs)
      .set({
        startedAt: new Date(now.getTime() - 31 * 60_000),
        creditsEstimated: credits,
        counts: { queued, pages },
        error: error instanceof Error ? error.message : String(error),
      })
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.startedAt, now)));
    throw error;
  }
}

/** The gap searches, after the first pass: their leads join the ledger as origin gap and are verified like any other. */
export async function queueGapSearch(handle: Db, reader: HistoryReader, companyId: string, now = new Date()) {
  const [company] = await handle.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) return { queued: 0, credits: 0, queries: [] as string[] };
  const queries = gapQueries(searchName(company.name, company.domain), await knownRounds(handle, companyId));
  if (queries.length === 0) return { queued: 0, credits: 0, queries };
  const found = await Promise.all(queries.map((q) => reader.search(q, 10).catch(() => [])));
  return { queued: await queueLeads(handle, reader, companyId, found.flat(), "gap", now), credits: queries.length * 2, queries };
}

/**
 * A requested company whose rounds left its sector empty or "other" takes one from what it sells:
 * the verified profile's words, then the dossier's one-liner, then the profile's customer type,
 * through the same sector rules the extraction uses. A sector the rounds did set is left alone.
 */
export async function fillRequestSector(handle: Db, companyId: string): Promise<string | null> {
  const [[company], rows] = await Promise.all([
    handle.select({ sector: companies.sector }).from(companies).where(eq(companies.id, companyId)).limit(1),
    handle
      .select({ kind: enrichments.kind, data: enrichments.data })
      .from(enrichments)
      .where(and(eq(enrichments.companyId, companyId), or(eq(enrichments.kind, "profile"), eq(enrichments.kind, "deep_dive")))),
  ]);
  if (!company || (company.sector && company.sector !== "other")) return company?.sector ?? null;
  const profile = (
    rows.find((r) => r.kind === "profile")?.data as
      | { profile?: { what_they_sell?: string; customer_type?: string; same_company?: boolean } }
      | undefined
  )?.profile;
  const verified = profile && profile.same_company !== false ? profile : null;
  const dossier = parseStoredDossier(rows.find((r) => r.kind === "deep_dive")?.data);
  const sector = [verified?.what_they_sell, dossier?.one_liner, verified?.customer_type]
    .map((text) => normalizeSector(text))
    .find((s) => s && s !== "other");
  if (!sector) return company.sector;
  await handle
    .update(companies)
    .set({ sector, updatedAt: new Date() })
    .where(and(eq(companies.id, companyId), or(isNull(companies.sector), eq(companies.sector, "other"))));
  return sector;
}

/**
 * Companies a request created before names were cleaned may carry the homepage's tagline ("Resend ·
 * Email for developers"): each takes its clean name. Display name and name key only; the id, and so
 * every URL, stays as it is. Idempotent: a clean name is left alone. Returns the companies renamed.
 */
export async function repairRequestCompanyNames(handle: Db): Promise<Array<{ id: string; from: string; to: string }>> {
  const rows = await handle
    .selectDistinct({ id: companies.id, name: companies.name, domain: companies.domain })
    .from(companies)
    .innerJoin(schema.companyRequests, eq(schema.companyRequests.companyId, companies.id));
  const renamed: Array<{ id: string; from: string; to: string }> = [];
  for (const row of rows) {
    const to = cleanBrandName(row.name, row.domain);
    if (to === row.name) continue;
    await handle
      .update(companies)
      .set({ name: to, nameKey: normalizeCompanyKey(to), updatedAt: new Date() })
      .where(eq(companies.id, row.id));
    renamed.push({ id: row.id, from: row.name, to });
  }
  return renamed;
}
