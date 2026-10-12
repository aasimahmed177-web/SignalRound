// The company, investor and news reads of the public API (/api/v1/companies, /api/v1/companies/{id},
// /api/v1/investors, /api/v1/investors/top, /api/v1/investors/{id}, /api/v1/news). Each returns the shape a reader or an agent uses: names,
// counts, amounts, dates, and a link to the page on the site, never a round's internal id or any
// operator detail. An investor is named by its URL slug ("sequoia-capital-india").

import { isListPage, normalizeInvestorKey, type Stage, sectorMembers } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { getCompany } from "./company.ts";
import { type CompanySort, likeTerm, listCompanies, listInvestors } from "./directory.ts";
import { companyRedirect } from "./entity-exists.ts";
import { getInvestor, investorTypeLabel } from "./investor.ts";
import { companyHref, investorHref, investorIdFromParam, investorSlug } from "./links.ts";
import { FILING_HOSTS } from "./news.ts";
import { siteOrigin } from "./origin.ts";
import { caught } from "./stats.ts";

const { fundingRounds, companies, investors, roundInvestors, sources, roundSources } = schema;

const DAY_MS = 86_400_000;

/** A round as these reads list it: whose, what, how much, when, and where to read more. */
export interface ApiRoundRef {
  company: string;
  company_domain: string | null;
  company_url: string;
  stage: string;
  stage_as_written: string;
  amount: { as_written: string | null; usd_millions: number | null };
  announced_on: string | null;
}

function roundRef(r: {
  companyId: string;
  company: string;
  domain: string | null;
  stage: string;
  stageAsWritten: string;
  amountAsWritten: string | null;
  usd: string | number | null;
  announcedOn: string | null;
}): ApiRoundRef {
  return {
    company: r.company,
    company_domain: r.domain,
    company_url: `${siteOrigin()}${companyHref(r.companyId)}`,
    stage: r.stage,
    stage_as_written: r.stageAsWritten,
    amount: { as_written: r.amountAsWritten, usd_millions: r.usd === null ? null : Number(r.usd) },
    announced_on: r.announcedOn,
  };
}

// ---------------------------------------------------------------------------------------------
// Companies

export interface ApiCompany {
  id: string;
  name: string;
  domain: string | null;
  logo_url: string | null;
  url: string;
  description: string | null;
  sector: string | null;
  headquarters: string | null;
  rounds_total: number;
  /** Stated USD amounts of the announced and reported rounds; null when none states one. */
  total_raised_usd_millions: number | null;
  latest_round: { stage: string; stage_as_written: string; announced_on: string | null } | null;
}

/** One page of companies the feed lists rounds for, newest raise first unless sorted otherwise. */
export async function apiCompanies(
  handle: Db,
  q: { q?: string; sector?: string; stages?: Stage[]; since?: string; sort: CompanySort; page: number; limit: number },
): Promise<{ data: ApiCompany[]; total: number; next_page: number | null; did_you_mean?: Array<{ id: string; name: string }> }> {
  const page = await listCompanies(handle, { ...q, pageSize: q.limit });
  const origin = siteOrigin();
  return {
    data: page.rows.map((r) => ({
      id: r.id,
      name: r.name,
      domain: r.domain,
      logo_url: r.logo_url,
      url: `${origin}${companyHref(r.id)}`,
      description: r.description,
      sector: r.sector,
      headquarters: r.hq,
      rounds_total: r.rounds,
      total_raised_usd_millions: r.usd_millions_raised,
      latest_round: r.latest
        ? { stage: r.latest.stage, stage_as_written: r.latest.stage_as_written, announced_on: r.latest.announced_on }
        : null,
    })),
    total: page.total,
    next_page: q.page * q.limit < page.total ? q.page + 1 : null,
    ...(page.total === 0 && q.q ? { did_you_mean: await didYouMean(handle, "companies", q.q) } : {}),
  };
}

/**
 * A site as people paste it ("https://www.firecrawl.dev/blog", "www.firecrawl.dev") read as its bare
 * host ("firecrawl.dev"), the way /api/v1/rounds reads `company`. Anything without a scheme, a
 * leading www. or a path after a host is returned as given, so an id or a name passes through.
 */
export function bareSite(raw: string): string {
  const t = raw.trim();
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?([/?#].*)?$/i.exec(t);
  if (!m?.[1] || !(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^www\./i.test(t) || m[2])) return t;
  return m[1].toLowerCase();
}

/**
 * A company's funding, by its id, or by a domain (a URL works too), earlier id, or name it is also known by (as its page
 * redirects them): who it is, what it raised (announced and reported rounds only, as its page
 * counts it), every round the feed lists for it, newest first, each with its leads and its official
 * announcement, and the investors on those rounds, leads first.
 */
export async function apiCompanyProfile(handle: Db, wanted: string) {
  const id = bareSite(wanted);
  let page = await getCompany(handle, id);
  if (!page) {
    const moved = await companyRedirect(handle, id);
    if (moved) page = await getCompany(handle, moved.id);
  }
  if (!page) return null;
  const origin = siteOrigin();
  const { company } = page;
  const rounds = page.rounds.map((r) => ({
    ...roundRef({
      companyId: company.id,
      company: company.name,
      domain: company.domain,
      stage: r.stage,
      stageAsWritten: r.stage_as_written,
      amountAsWritten: r.amount.as_written,
      usd: r.amount.usd_millions,
      announcedOn: r.announced_on,
    }),
    certainty: r.certainty,
    lead_investors: r.lead_investors,
    other_investors: r.other_investors,
    primary_source: r.primary_source?.url ?? null,
    earlier_round: r.history,
  }));
  return {
    id: company.id,
    name: company.name,
    domain: company.domain,
    logo_url: company.logo_url,
    url: `${origin}${companyHref(company.id)}`,
    description: company.description,
    sector: company.sector,
    headquarters: company.hq,
    total_raised_usd_millions: page.totals.usd_millions_raised,
    latest_round: rounds[0] ?? null,
    rounds,
    investors: page.investors.map((i) => ({
      id: investorSlug(i.id),
      name: i.name,
      domain: i.domain,
      logo_url: i.logo_url,
      url: `${origin}${investorHref(i.id)}`,
      rounds_led: i.leads,
      rounds_participated: i.participations,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Investors

export const API_INVESTOR_SORTS = ["led", "rounds", "latest", "name"] as const;
export type ApiInvestorSort = (typeof API_INVESTOR_SORTS)[number];

export interface ApiInvestor {
  id: string;
  name: string;
  domain: string | null;
  logo_url: string | null;
  url: string;
  rounds_led: number;
  rounds_participated: number;
  rounds_total: number;
  /** The newest round the investor is named on. */
  latest_round: { company: string; company_url: string; stage: string; stage_as_written: string; announced_on: string | null } | null;
}

/** One page of investors named on the rounds the feed lists, searched by name. */
export async function apiInvestors(
  handle: Db,
  q: { q?: string; sort: ApiInvestorSort; page: number; limit: number },
): Promise<{ data: ApiInvestor[]; total: number; next_page: number | null; did_you_mean?: Array<{ id: string; name: string }> }> {
  const page = await listInvestors(handle, { q: q.q, sort: q.sort, page: q.page, pageSize: q.limit });
  const origin = siteOrigin();
  return {
    data: page.rows.map((r) => ({
      id: investorSlug(r.id),
      name: r.name,
      domain: r.domain,
      logo_url: r.logo_url,
      url: `${origin}${investorHref(r.id)}`,
      rounds_led: r.led,
      rounds_participated: r.participated,
      rounds_total: r.total,
      latest_round: r.latest
        ? {
            company: r.latest.company,
            company_url: `${origin}${companyHref(r.latest.company_id)}`,
            stage: r.latest.stage,
            stage_as_written: r.latest.stage_as_written,
            announced_on: r.latest.announced_on,
          }
        : null,
    })),
    total: page.total,
    next_page: q.page * q.limit < page.total ? q.page + 1 : null,
    ...(page.total === 0 && q.q ? { did_you_mean: await didYouMean(handle, "investors", q.q) } : {}),
  };
}

/**
 * The investor a caller means when the id itself misses: its name as written ("Andreessen
 * Horowitz", "Sequoia Capital") or its site ("a16z.com", "a16z"). The id, or null when no investor
 * named on a published round answers to it.
 */
async function investorIdFor(handle: Db, raw: string): Promise<string | null> {
  const keys = [...new Set([investorIdFromParam(raw).toLowerCase(), normalizeInvestorKey(raw)])].filter(Boolean);
  const site = raw.trim().toLowerCase();
  const seats = sql<number>`count(*)::int`;
  const hits = await handle
    .select({ id: investors.id, seats })
    .from(investors)
    .innerJoin(roundInvestors, eq(roundInvestors.investorId, investors.id))
    .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
    .where(
      and(
        inArray(fundingRounds.disposition, ["publish", "flagged"]),
        or(inArray(investors.id, keys), eq(investors.domain, site), sql`split_part(${investors.domain}, '.', 1) = ${site}`),
      ),
    )
    .groupBy(investors.id)
    .orderBy(desc(seats));
  return keys.find((k) => hits.some((h) => h.id === k)) ?? hits[0]?.id ?? null;
}

/** Edit distance with an adjacent swap counted as one edit ("sequioa"), or max + 1 once it is past max. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], prev2[j - 2] + 1);
    }
    if (Math.min(...row) > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * What a name that matched nothing was probably meant to be ("supabse", "Antropic", "Sequioa"): up
 * to three companies or investors on published rounds whose name, id or site is a typo or two away
 * from it, nearest first, then the most rounds. Empty when nothing is that close, and empty when the
 * name is exactly right (another filter ruled it out, so a near name would mislead).
 */
export async function didYouMean(handle: Db, kind: "companies" | "investors", text: string): Promise<Array<{ id: string; name: string }>> {
  const want = compact(text.replace(/^https?:\/\/(www\.)?/i, "").replace(/\.[a-z.]+\/?$/i, ""));
  if (want.length < 5) return [];
  const max = want.length < 8 ? 1 : 2;
  const rounds = sql<number>`count(*)::int`;
  const visible = inArray(fundingRounds.disposition, ["publish", "flagged"]);
  const rows =
    kind === "companies"
      ? await handle
          .select({ id: companies.id, name: companies.name, domain: companies.domain, rounds })
          .from(companies)
          .innerJoin(fundingRounds, eq(fundingRounds.companyId, companies.id))
          .where(visible)
          .groupBy(companies.id)
      : await handle
          .select({ id: investors.id, name: investors.name, domain: investors.domain, rounds })
          .from(investors)
          .innerJoin(roundInvestors, eq(roundInvestors.investorId, investors.id))
          .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
          .where(visible)
          .groupBy(investors.id);
  const scored = rows.map((r) => {
    const forms = [r.name, r.id.split(".")[0], r.domain?.split(".")[0] ?? ""].map(compact).filter(Boolean);
    return { r, d: Math.min(...forms.map((f) => editDistance(want, f, max))) };
  });
  if (scored.some(({ d }) => d === 0)) return [];
  return scored
    .filter(({ d }) => d <= max)
    .sort((a, b) => a.d - b.d || b.r.rounds - a.r.rounds)
    .slice(0, 3)
    .map(({ r }) => ({ id: kind === "investors" ? investorSlug(r.id) : r.id, name: r.name }));
}

/** A 404 body that names the closest matches, in the message too, so a caller that only reads the message sees them. */
export function notFound(message: string, near: Array<{ id: string; name: string }>) {
  const hint = near.length ? ` Did you mean ${near.map((n) => `${n.name} (id ${n.id})`).join(", ")}?` : "";
  return { error: `${message}.${hint}`, did_you_mean: near };
}

/** How many of an investor's rounds its profile lists, newest first. */
const PROFILE_ROUNDS = 25;

/** An investor's profile, by its id, name or site (a URL works too): who it is, what it led and joined, its sectors and stages, and who it invests beside. */
export async function apiInvestorProfile(handle: Db, wanted: string) {
  const idOrSlug = bareSite(wanted);
  let page = await getInvestor(handle, investorIdFromParam(idOrSlug));
  if (!page) {
    const id = await investorIdFor(handle, idOrSlug);
    if (id) page = await getInvestor(handle, id);
  }
  if (!page) return null;
  const origin = siteOrigin();
  const { investor, totals } = page;
  return {
    id: investorSlug(investor.id),
    name: investor.name,
    domain: investor.domain,
    logo_url: investor.logo_url,
    url: `${origin}${investorHref(investor.id)}`,
    kind: investor.kind,
    kind_label: investorTypeLabel(investor.kind),
    description: investor.description,
    headquarters: investor.headquarters,
    totals: {
      rounds_led: totals.led,
      rounds_co_led: totals.co_led,
      rounds_participated: totals.participated,
      lead_share_usd_millions: totals.lead_share_usd_millions,
    },
    sectors: page.sectors,
    stages: page.stages,
    co_investors: page.co_investors.map((c) => ({
      id: investorSlug(c.id),
      name: c.name,
      url: `${origin}${investorHref(c.id)}`,
      shared_rounds: c.rounds,
    })),
    recent_rounds: page.rounds.slice(0, PROFILE_ROUNDS).map((r) => ({
      ...roundRef({
        companyId: r.company.id,
        company: r.company.name,
        domain: r.company.domain,
        stage: r.stage,
        stageAsWritten: r.stage_as_written,
        amountAsWritten: r.amount.as_written,
        usd: r.amount.usd_millions,
        announcedOn: r.announced_on,
      }),
      role: r.role,
      certainty: r.certainty,
      lead_investors: r.lead_investors,
      sector: r.company.sector,
      earlier_round: r.history,
    })),
  };
}

export const TOP_WINDOWS = { "7d": 7, "30d": 30, "90d": 90 } as const;
export type TopWindow = keyof typeof TOP_WINDOWS;

/** How many of an investor's led rounds the ranking shows beside its count. */
const TOP_LED_SHOWN = 3;

/**
 * The investors that led the most rounds in the window: announced or reported rounds the feed lists,
 * history left out, as the Overview's "Most active leads" counts them. `lead_share_usd_millions`
 * splits each led round's stated amount evenly between its leads, so the figures add up to the money
 * led. Optionally within one sector or set of stages.
 */
export async function apiTopLeads(
  handle: Db,
  q: { window: TopWindow; sector?: string; stages?: Stage[]; limit: number },
  now: Date = new Date(),
) {
  const since = new Date(now.getTime() - TOP_WINDOWS[q.window] * DAY_MS).toISOString().slice(0, 10);
  const where = and(
    caught,
    gte(fundingRounds.announcedOn, since),
    eq(roundInvestors.role, "lead"),
    q.sector ? inArray(companies.sector, sectorMembers(q.sector)) : undefined,
    q.stages?.length ? inArray(fundingRounds.stage, q.stages) : undefined,
  );
  const leadShareUsd = sql<number>`coalesce(sum(${fundingRounds.amountUsdMillions} / (select count(*) from round_investors l where l.round_id = ${fundingRounds.id} and l.role = 'lead')), 0)::float`;
  const leads = sql<number>`count(distinct ${fundingRounds.id})::int`;
  const ranked = await handle
    .select({ id: investors.id, name: investors.name, domain: investors.domain, logoUrl: investors.logoUrl, leads, usd: leadShareUsd })
    .from(roundInvestors)
    .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
    .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    .where(where)
    .groupBy(investors.id, investors.name, investors.domain, investors.logoUrl)
    .orderBy(desc(leads), desc(leadShareUsd), investors.name)
    .limit(q.limit);
  const ids = ranked.map((r) => r.id);
  const led = ids.length
    ? await handle
        .select({
          investorId: roundInvestors.investorId,
          companyId: companies.id,
          company: companies.name,
          domain: companies.domain,
          stage: fundingRounds.stage,
          stageAsWritten: fundingRounds.stageAsWritten,
          amountAsWritten: fundingRounds.amountAsWritten,
          usd: fundingRounds.amountUsdMillions,
          announcedOn: fundingRounds.announcedOn,
        })
        .from(roundInvestors)
        .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
        .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
        .where(and(where, inArray(roundInvestors.investorId, ids)))
        .orderBy(desc(fundingRounds.announcedOn), desc(fundingRounds.amountUsdMillions))
    : [];
  const origin = siteOrigin();
  return {
    window: q.window,
    since,
    sector: q.sector ?? null,
    data: ranked.map((r, i) => ({
      rank: i + 1,
      id: investorSlug(r.id),
      name: r.name,
      domain: r.domain,
      logo_url: r.logoUrl,
      url: `${origin}${investorHref(r.id)}`,
      rounds_led: r.leads,
      lead_share_usd_millions: Math.round(r.usd * 1000) / 1000,
      led_rounds: led
        .filter((l) => l.investorId === r.id)
        .slice(0, TOP_LED_SHOWN)
        .map(roundRef),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// News

export interface ApiNewsQuery {
  since?: string;
  sector?: string;
  q?: string;
  /** "YYYY-MM-DD|url" from the previous page's next_cursor. */
  cursor?: { day: string; url: string };
  limit: number;
}

/** "YYYY-MM-DD|url": the last article's day and URL, the order the list is read in. */
export function parseNewsCursor(raw: string): { day: string; url: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})\|(https?:\/\/.+)$/.exec(raw);
  return m?.[1] && m[2] ? { day: m[1], url: m[2] } : null;
}

/**
 * The latest articles about the rounds the feed lists, newest first: each with its publisher, its
 * day, and the rounds it reports, each round with its certainty (an expected round is news too, and
 * says so). Filings (a Form D) are records, not news, and are left out, as are
 * pages that only recall an earlier round, and roundups, newsletters, and listicles (isListPage): a
 * source on each round they list, but not an article about any one company.
 */
export async function apiNews(handle: Db, q: ApiNewsQuery) {
  const day = sql<string>`coalesce(nullif(left(${sources.publishedAt}, 10), ''), to_char(${sources.fetchedAt} at time zone 'UTC', 'YYYY-MM-DD'))`;
  const roundConds = [
    sql`rs.source_id = ${sources.id}`,
    sql`r.disposition in ('publish', 'flagged')`,
    sql`r.history = false`,
    sql`r.certainty <> 'unconfirmed'`,
  ];
  if (q.sector)
    roundConds.push(
      sql`c.sector in (${sql.join(
        sectorMembers(q.sector).map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  if (q.q) roundConds.push(sql`(c.name ilike ${likeTerm(q.q)} or ${sources.title} ilike ${likeTerm(q.q)})`);
  const reports = sql`exists (select 1 from round_sources rs join funding_rounds r on r.id = rs.round_id join companies c on c.id = r.company_id where ${sql.join(roundConds, sql` and `)})`;
  // Read in batches until a page and one more survive the list-page rule, so the cursor stays exact.
  const rows: Array<{ id: string; url: string; host: string; title: string | null; day: string }> = [];
  let after = q.cursor;
  for (;;) {
    const batch = await handle
      .select({
        id: sources.id,
        url: sources.url,
        host: sources.host,
        title: sources.title,
        day,
        rounds: sql<number>`(select count(*) from round_sources rs where rs.source_id = ${sources.id})::int`,
      })
      .from(sources)
      .where(
        and(
          sql`${sources.host} not in (${sql.join(
            FILING_HOSTS.map((h) => sql`${h}`),
            sql`, `,
          )})`,
          reports,
          q.since ? sql`${day} >= ${q.since}` : undefined,
          after ? sql`(${day}, ${sources.id}) < (${after.day}, ${after.url})` : undefined,
        ),
      )
      .orderBy(desc(day), desc(sources.id))
      .limit(2 * (q.limit + 1));
    for (const r of batch) if (!isListPage({ url: r.url, title: r.title }, null, r.rounds)) rows.push(r);
    const last = batch[batch.length - 1];
    if (rows.length > q.limit || batch.length < 2 * (q.limit + 1) || !last) break;
    after = { day: last.day, url: last.id };
  }
  const page = rows.slice(0, q.limit);
  const ids = page.map((r) => r.id);
  const links = ids.length
    ? await handle
        .select({
          sourceId: roundSources.sourceId,
          roundId: fundingRounds.id,
          companyId: companies.id,
          company: companies.name,
          domain: companies.domain,
          sector: companies.sector,
          stage: fundingRounds.stage,
          stageAsWritten: fundingRounds.stageAsWritten,
          amountAsWritten: fundingRounds.amountAsWritten,
          usd: fundingRounds.amountUsdMillions,
          announcedOn: fundingRounds.announcedOn,
          certainty: fundingRounds.certainty,
          quotes: fundingRounds.evidenceQuotes,
        })
        .from(roundSources)
        .innerJoin(fundingRounds, eq(fundingRounds.id, roundSources.roundId))
        .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
        .where(
          and(
            inArray(roundSources.sourceId, ids),
            inArray(fundingRounds.disposition, ["publish", "flagged"]),
            eq(fundingRounds.history, false),
            sql`${fundingRounds.certainty} <> 'unconfirmed'`,
          ),
        )
    : [];
  const roundIds = [...new Set(links.map((l) => l.roundId))];
  const leadRows = roundIds.length
    ? await handle
        .select({ roundId: roundInvestors.roundId, name: investors.name })
        .from(roundInvestors)
        .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
        .where(and(inArray(roundInvestors.roundId, roundIds), eq(roundInvestors.role, "lead")))
    : [];
  const leadsOf = (roundId: string) => leadRows.filter((l) => l.roundId === roundId).map((l) => l.name);
  const last = page[page.length - 1];
  return {
    data: page.map((a) => {
      const linked = links.filter((l) => l.sourceId === a.id);
      return {
        title: a.title,
        url: a.url,
        publisher: a.host.replace(/^www\./, ""),
        published_on: a.day,
        // The round's own sentence when the article reports one round; a roundup has no single excerpt.
        excerpt: linked.length === 1 ? (linked[0]?.quotes[0] ?? null) : null,
        rounds: linked.map((l) => ({ ...roundRef(l), certainty: l.certainty, sector: l.sector, lead_investors: leadsOf(l.roundId) })),
      };
    }),
    next_cursor: rows.length > q.limit && last ? `${last.day}|${last.id}` : null,
  };
}
