// The company, investor and news reads of the public API (/api/v1/companies, /api/v1/companies/{id},
// /api/v1/investors, /api/v1/investors/top, /api/v1/investors/{id}, /api/v1/news). Each returns the shape a reader or an agent uses: names,
// counts, amounts, dates, and a link to the page on the site, never a round's internal id or any
// operator detail. An investor is named by its URL slug ("sequoia-capital-india").

import {
  articleKey,
  investorKeyForMerge,
  isListPage,
  normalizeCompanyKey,
  normalizeInvestorKey,
  type Stage,
  samePageKey,
  sectorMembers,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { getCompany } from "./company.ts";
import { totalToDate } from "./company-groups.ts";
import { companySlug } from "./company-ids.ts";
import { type CompanySort, likeTerm, listCompanies, listInvestors } from "./directory.ts";
import { companyRedirect, investorRedirect } from "./entity-exists.ts";
import { getInvestor, investorTypeLabel } from "./investor.ts";
import { companyHref, investorHref, investorIdFromParam, investorSlug } from "./links.ts";
import { NOT_NEWS_HOSTS } from "./news.ts";
import { siteOrigin } from "./origin.ts";
import { companyNamed, type RoundRow } from "./persist.ts";
import { caught } from "./stats.ts";

const { fundingRounds, companies, companyAliases, investors, roundInvestors, sources, roundSources } = schema;

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

/** A sentence that states the company's funding to date, not one series' running total or a round still closing. */
const COMPANY_TOTAL =
  /\b(?:total(?:\s+(?:disclosed|known|reported|equity|outside|external))?\s+(?:funding|capital|financing|investment|raised|amount raised)|raised\s+(?:a\s+)?total|in total|cumulative\s+(?:funding|financing|capital)|to[- ]date|so far|since\s+(?:its\s+|the\s+company'?s?\s+)?(?:launch|inception|founding|founded|start))\b/i;
const SERIES_TOTAL =
  /\btotal\s+(?:series\s+[a-z]\d*|seed|pre-seed|round)\b|\bcumulative\s+amount\s+(?:raised\s+)?(?:in|of)\s+(?:the|its)\s+series\b|\b(?:series\s+[a-z]\d*|round)\s+(?:total|to\s+a\s+total)\b/i;

/**
 * The company's own stated funding to date, from its newest announced or reported round that states
 * one in USD beside its money (Harmonic Security's "$76 million" beside its $50M Series B), or null.
 * rounds_sum_usd_millions adds the rounds on record up to that day, so exceeds_rounds_sum says an
 * earlier round is missing from the record (beyond a 2% rounding margin).
 */
export function statedTotalRaised(rounds: RoundRow[]) {
  const closed = rounds.filter((r) => r.certainty === "announced" || r.certainty === "reported");
  const stating = closed.find(
    (r) =>
      totalToDate(r) !== null &&
      (r.amount_scope === "cumulative" ||
        (COMPANY_TOTAL.test(r.financing_total_quote ?? "") && !SERIES_TOTAL.test(r.financing_total_quote ?? ""))),
  );
  const usdMillions = stating ? totalToDate(stating) : null;
  if (!stating || usdMillions === null) return null;
  const through = closed.filter((r) => !stating.announced_on || (r.announced_on !== null && r.announced_on <= stating.announced_on));
  const sum = Math.round(through.reduce((n, r) => n + (r.amount.usd_millions ?? 0), 0) * 1000) / 1000;
  return {
    usd_millions: usdMillions,
    as_written: stating.financing_total_as_written,
    quote: stating.financing_total_quote,
    stated_on: stating.announced_on,
    stage: stating.stage,
    stage_as_written: stating.stage_as_written,
    source: stating.primary_source?.url ?? stating.sources[0]?.url ?? null,
    rounds_sum_usd_millions: sum,
    exceeds_rounds_sum: usdMillions > sum * 1.02,
  };
}

/**
 * A company's funding, by its id, or by a domain (a URL works too), earlier id, or name it is also known by (as its page
 * redirects them): who it is, what it raised (announced and reported rounds only, as its page
 * counts it), every round the feed lists for it, newest first, each with its leads, its official
 * announcement, and its valuation where one is citable, the valuations again as a history (never summed
 * into what it raised), and the investors on those rounds, leads first.
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
    valuation: r.valuation,
    certainty: r.certainty,
    lead_investors: r.lead_investors,
    other_investors: r.other_investors,
    primary_source: r.primary_source?.url ?? null,
    earlier_round: r.history,
  }));
  // Newest first, as the rounds are: every round with a citable valuation, kept apart from what it raised.
  const valuations = rounds.flatMap((r) =>
    r.valuation
      ? [{ ...r.valuation, announced_on: r.announced_on, stage: r.stage, stage_as_written: r.stage_as_written, certainty: r.certainty }]
      : [],
  );
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
    stated_total_raised: statedTotalRaised(page.rounds),
    valuation_history: { latest: valuations[0] ?? null, stated: valuations },
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
  const keys = [...new Set([investorIdFromParam(raw).toLowerCase(), normalizeInvestorKey(raw), investorKeyForMerge(raw)])].filter(Boolean);
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
  return (await nearNames(handle, kind, text)).map(({ id, name }) => ({ id, name }));
}

/** didYouMean's matches with how many edits each is away. */
export async function nearNames(
  handle: Db,
  kind: "companies" | "investors",
  text: string,
): Promise<Array<{ id: string; name: string; edits: number }>> {
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
    .map(({ r, d }) => ({ id: kind === "investors" ? investorSlug(r.id) : r.id, name: r.name, edits: d }));
}

/**
 * The one name a miss plainly meant: the only near match a single edit away ("supabse" for
 * Supabase). Null when none is, or when two are and picking one would be a guess.
 */
export function oneEditAway<T extends { edits: number }>(near: T[]): T | null {
  const one = near.filter((n) => n.edits === 1);
  return one.length === 1 ? (one[0] ?? null) : null;
}

const looksLikeSite = (wanted: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(bareSite(wanted));

/** A company name as an id would spell it: "Alice & Bob" is alice-and-bob, "Character.AI" character-ai. */
const nameSlug = (name: string) => companySlug(name.replace(/&/g, " and "));

/** A company's name key with "Lab" off its tail too, so "Thinking Machines" and "Thinking Machines Lab" meet. */
const lookupKey = (name: string) => normalizeCompanyKey(name).replace(/ lab$/, "");

/**
 * The company a name asks for once no id, site or earlier id matched: the id its name would be spelled as
 * ("hugging-face"), or the one company whose name or a name it is known by is the same once case,
 * punctuation and a trailing Inc, AI, Labs, Technologies and the like are off both ("TypeSafe AI" for
 * TypeSafe AI, "Black Forest" for Black Forest Labs). Only companies with a published round count. Two
 * that answer are namesakes, and the one whose name is exactly what was asked wins ("Scale AI" over a
 * "Scale"); otherwise the namesakes come back to choose from, never one of them picked. A site is a name
 * here only when a company's name is that site as written ("Character.AI"). Null when none answers.
 */
async function companyByName(handle: Db, wanted: string): Promise<string | Array<{ id: string; name: string }> | null> {
  const key = lookupKey(wanted);
  if (!key) return null;
  const keys = [key, `${key} lab`];
  const slug = nameSlug(wanted);
  const aliases = await handle
    .select({ id: companyAliases.companyId, alias: companyAliases.alias })
    .from(companyAliases)
    .where(and(eq(companyAliases.kind, "name"), inArray(companyAliases.aliasKey, keys)));
  const rows = await handle
    .select({ id: companies.id, name: companies.name, rounds: sql<number>`count(*)::int` })
    .from(companies)
    .innerJoin(fundingRounds, eq(fundingRounds.companyId, companies.id))
    .where(
      and(
        inArray(fundingRounds.disposition, ["publish", "flagged"]),
        or(
          eq(companies.id, slug),
          inArray(companies.nameKey, keys),
          aliases.length ? inArray(companies.id, [...new Set(aliases.map((a) => a.id))]) : undefined,
        ),
      ),
    )
    .groupBy(companies.id)
    .orderBy(desc(sql`count(*)`), companies.id);
  const names = (r: { id: string; name: string }) => [r.name, ...aliases.filter((a) => a.id === r.id).map((a) => a.alias)];
  const site = looksLikeSite(wanted);
  const asked = site ? rows.filter((r) => names(r).some((n) => n.toLowerCase() === wanted)) : rows;
  const exact = asked.filter((r) => r.id === slug || names(r).some((n) => nameSlug(n) === slug));
  const only = asked.length === 1 ? asked[0] : exact.length === 1 ? exact[0] : undefined;
  if (only) return only.id;
  return asked.length ? asked.slice(0, 5).map(({ id, name }) => ({ id, name })) : null;
}

/**
 * A profile by what was asked; for a company, else by its name (companyByName); else the one name a single
 * edit away, read under that name and saying so (matched_from, note); else the 404 body naming the near
 * ones, and for a company what a search for it finds, up to five. A site (linear.app) names one page
 * exactly, so a miss on it is never read as a near name's profile (Liner) and only lists the near ones.
 */
async function profileOrNear<T extends { name: string }>(
  handle: Db,
  kind: "companies" | "investors",
  wanted: string,
  read: (id: string) => Promise<T | null>,
  miss: string,
) {
  const found = await read(wanted);
  if (found) return found;
  const noun = kind === "companies" ? "company" : "investor";
  const named = kind === "companies" ? await companyByName(handle, wanted) : null;
  if (Array.isArray(named)) return notFound(`More than one company goes by "${wanted}"`, named);
  const byName = named ? await read(named) : null;
  if (byName) return byName;
  const near = await nearNames(handle, kind, wanted);
  const meant = looksLikeSite(wanted) ? null : oneEditAway(near);
  const matched = meant ? await read(meant.id) : null;
  if (matched) return { ...matched, matched_from: wanted, note: `No ${noun} goes by "${wanted}"; this is ${matched.name}, one edit away.` };
  const candidates = near.map(({ id, name }) => ({ id, name }));
  if (kind === "companies") {
    for (const q of new Set([wanted, lookupKey(wanted)].filter(Boolean))) {
      const { rows } = await listCompanies(handle, { q, pageSize: 5 });
      candidates.push(...rows.map(({ id, name }) => ({ id, name })));
    }
  }
  return notFound(miss, candidates.filter((c, i) => candidates.findIndex((d) => d.id === c.id) === i).slice(0, 5));
}

/** A company's profile, or the one company a misspelled id plainly meant, or the 404 body naming the near ones. */
export function companyProfileOrNear(handle: Db, wanted: string) {
  return profileOrNear(
    handle,
    "companies",
    wanted,
    (id) => apiCompanyProfile(handle, id),
    `No company matches "${wanted}" by id, domain or name; try its domain or a company search`,
  );
}

/** An investor's profile, or the one investor a misspelled id plainly meant, or the 404 body naming the near ones. */
export function investorProfileOrNear(handle: Db, wanted: string) {
  return profileOrNear(
    handle,
    "investors",
    wanted,
    (id) => apiInvestorProfile(handle, id),
    "No investor with that id is named on a published round",
  );
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
  if (!page) {
    const moved = await investorRedirect(handle, investorIdFromParam(idOrSlug));
    if (moved) page = await getInvestor(handle, moved);
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
      led_rounds: led.filter((l) => l.investorId === r.id).map(roundRef),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// News

export interface ApiNewsQuery {
  since?: string;
  sector?: string;
  q?: string;
  /** One company's id (newsCompanyId): only articles about its rounds, its earlier rounds included. */
  companyId?: string;
  /** "YYYY-MM-DD|url" from the previous page's next_cursor. */
  cursor?: { day: string; url: string };
  limit: number;
}

/**
 * The company a news request names, read the way the company profile reads it (companyProfileOrNear):
 * its id, domain, earlier id, or name, or the one name a single edit away (with matched_from and note);
 * else the profile's 404 body naming the companies to retry with.
 */
export async function newsCompany(
  handle: Db,
  raw: string,
): Promise<{ id: string; matched_from?: string; note?: string } | ReturnType<typeof notFound>> {
  const found = await companyProfileOrNear(handle, raw.trim().toLowerCase());
  if ("error" in found) return found;
  const { matched_from, note } = found as { matched_from?: string; note?: string };
  return { id: found.id, ...(matched_from ? { matched_from, note } : {}) };
}

/** "YYYY-MM-DD|url": the last article's day and URL, the order the list is read in. */
export function parseNewsCursor(raw: string): { day: string; url: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})\|(https?:\/\/.+)$/.exec(raw);
  return m?.[1] && m[2] ? { day: m[1], url: m[2] } : null;
}

/**
 * The latest articles about the rounds the feed lists, newest first: each with its publisher, its
 * day, and the rounds it reports, each round with its certainty (an expected round is news too, and
 * says so) and the sentence its record cites. Filings (a Form D) are records, not news, and are left out, as are
 * pages that only recall an earlier round, untitled pages, and roundups, newsletters, and listicles (isListPage): a
 * source on each round they list, but not an article about any one company. One article read under
 * several addresses (its AMP copy, a tracking parameter) is listed once (articleKey). A request that names a
 * company (companyId, or a q that names one exactly) counts its earlier rounds too, as /api/v1/rounds does.
 */
export async function apiNews(handle: Db, q: ApiNewsQuery) {
  const named = q.companyId
    ? [q.companyId]
    : q.q
      ? (await handle.select({ id: companies.id }).from(companies).where(companyNamed(q.q))).map((c) => c.id)
      : [];
  const current = named.length
    ? sql`(r.history = false or r.company_id in (${sql.join(
        named.map((id) => sql`${id}`),
        sql`, `,
      )}))`
    : sql`r.history = false`;
  // A page that states no day of its own is dated by the newest round it reports, never later than the
  // day it was read: a profile or library page read today about a round from last month is not today's news.
  const day = sql<string>`coalesce(nullif(left(${sources.publishedAt}, 10), ''), least(to_char(${sources.fetchedAt} at time zone 'UTC', 'YYYY-MM-DD'), (select max(r.announced_on) from round_sources rs join funding_rounds r on r.id = rs.round_id where rs.source_id = sources.id and r.disposition in ('publish', 'flagged') and ${current} and r.certainty <> 'unconfirmed')))`;
  const roundConds = [
    sql`rs.source_id = ${sources.id}`,
    sql`r.disposition in ('publish', 'flagged')`,
    current,
    sql`r.certainty <> 'unconfirmed'`,
  ];
  if (q.companyId) roundConds.push(sql`r.company_id = ${q.companyId}`);
  if (q.sector)
    roundConds.push(
      sql`c.sector in (${sql.join(
        sectorMembers(q.sector).map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  if (q.q) roundConds.push(sql`(c.name ilike ${likeTerm(q.q)} or ${sources.title} ilike ${likeTerm(q.q)})`);
  const reports = sql`exists (select 1 from round_sources rs join funding_rounds r on r.id = rs.round_id join companies c on c.id = r.company_id where ${sql.join(roundConds, sql` and `)})`;
  // Read in batches until a page and one more survive the list-page rule and the copies fold, so the cursor stays exact.
  type Article = { id: string; url: string; host: string; title: string | null; day: string; sourceIds: string[] };
  const rows: Article[] = [];
  const byKey = new Map<string, Article>();
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
            NOT_NEWS_HOSTS.map((h) => sql`${h}`),
            sql`, `,
          )})`,
          sql`btrim(coalesce(${sources.title}, '')) <> ''`,
          reports,
          q.since ? sql`${day} >= ${q.since}` : undefined,
          after ? sql`(${day}, ${sources.id}) < (${after.day}, ${after.url})` : undefined,
        ),
      )
      .orderBy(desc(day), desc(sources.id))
      .limit(2 * (q.limit + 1));
    for (const r of batch) {
      if (isListPage({ url: r.url, title: r.title }, null, r.rounds)) continue;
      const key = articleKey(r.url);
      const kept = byKey.get(key);
      if (!kept) {
        const article = { id: r.id, url: r.url, host: r.host, title: r.title, day: r.day, sourceIds: [r.id] };
        byKey.set(key, article);
        rows.push(article);
        continue;
      }
      kept.sourceIds.push(r.id);
      // The page itself over its AMP copy.
      if (articleKey(kept.url) !== samePageKey(kept.url) && articleKey(r.url) === samePageKey(r.url))
        Object.assign(kept, { url: r.url, host: r.host, title: r.title });
    }
    const last = batch[batch.length - 1];
    if (rows.length > q.limit || batch.length < 2 * (q.limit + 1) || !last) break;
    after = { day: last.day, url: last.id };
  }
  const page = rows.slice(0, q.limit);
  const ids = page.flatMap((r) => r.sourceIds);
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
            named.length ? or(eq(fundingRounds.history, false), inArray(fundingRounds.companyId, named)) : eq(fundingRounds.history, false),
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
      const linked = [...new Map(links.filter((l) => a.sourceIds.includes(l.sourceId)).map((l) => [l.roundId, l])).values()];
      return {
        title: a.title,
        url: a.url,
        publisher: a.host.replace(/^www\./, ""),
        published_on: a.day,
        // No article's own description is stored, so none is shown as one; each round carries its own evidence.
        excerpt: null,
        rounds: linked.map((l) => ({
          ...roundRef(l),
          certainty: l.certainty,
          sector: l.sector,
          lead_investors: leadsOf(l.roundId),
          evidence: l.quotes[0] ?? null,
        })),
      };
    }),
    next_cursor: rows.length > q.limit && last ? `${last.day}|${last.id}` : null,
  };
}
