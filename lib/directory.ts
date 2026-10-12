// The two directories (/companies, /investors) and the command palette's lookups. Each reads
// only the rounds the feed shows (publish and flagged), so a company or investor seen only on
// records in review or rejected has no row here, and every viewer, a demo visitor included,
// sees the same set the feed gives them.

import type { Stage } from "@fireround/core";
import { sectorLabel, sectorMembers } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { normalizedCompanyQuery } from "./company-request-ui.ts";
import { pageCount, pageSpan, parsePage } from "./pages.ts";

const { companies, fundingRounds, investors, roundInvestors } = schema;

/** The dispositions the feed lists; listRounds without includeReview reads the same pair. */
const VISIBLE = ["publish", "flagged"] as const;

export const DIRECTORY_PAGE_SIZE = 50;

export const COMPANY_SORTS = ["latest", "raised", "name"] as const;
export type CompanySort = (typeof COMPANY_SORTS)[number];

/** The first is the index's default: the firms that led the most rounds, as the API orders them, not the newest angel. */
export const INVESTOR_SORTS = ["led", "rounds", "latest", "name"] as const;
export type InvestorSort = (typeof INVESTOR_SORTS)[number];

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/**
 * A directory page's URL state, validated: `q` trimmed, `sort` one of the allowed values (the
 * first is the default), `page` a positive integer. Anything else in the URL reads as the default.
 */
export function parseDirectoryParams<S extends string>(search: Search, sorts: readonly S[]): { q: string; sort: S; page: number } {
  const q = one(search.q).trim().slice(0, 100);
  const wanted = one(search.sort);
  const sort = (sorts as readonly string[]).includes(wanted) ? (wanted as S) : sorts[0];
  return { q, sort, page: parsePage(one(search.page)) };
}

/**
 * Where a page sits in the whole list: the page clamped to what exists, its offset, and the 1-based
 * row span it shows. The arithmetic is the feed's (lib/pages.ts), so both paginate alike.
 */
export function pageWindow(total: number, page: number, size: number = DIRECTORY_PAGE_SIZE) {
  const pages = pageCount(total, size);
  const current = Math.min(Math.max(1, page), pages);
  return { page: current, pages, offset: (current - 1) * size, ...pageSpan(current, size, total) };
}

/** A directory page's URL: the carried state (q, sort) with empty values dropped, and page one bare. */
export function directoryHref(basePath: string, params: Record<string, string>, page: number): string {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== ""));
  if (page > 1) qs.set("page", String(page));
  const s = qs.toString();
  return s ? `${basePath}?${s}` : basePath;
}

/** An ILIKE pattern with the user's own wildcards stripped, as the feed's search does. */
export function likeTerm(q: string): string {
  return `%${q.replace(/[%_\\]/g, "")}%`;
}

export interface CompanyListing {
  id: string;
  name: string;
  domain: string | null;
  logo_url: string | null;
  description: string | null;
  sector: string | null;
  hq: string | null;
  rounds: number;
  /** Sum of the stated USD amounts; null when no visible round states one. */
  usd_millions_raised: number | null;
  /** `stage_as_written` lets the row name an unlettered round as the page did ("Strategic investment"), not "Other". */
  latest: {
    stage: Stage;
    stage_as_written: string;
    announced_on: string | null;
    date_precision: "day" | "week" | "month" | "unknown";
  } | null;
}

export interface DirectoryPage<T> {
  rows: T[];
  total: number;
  page: number;
  pages: number;
  from: number;
  to: number;
}

function companyMatch(q: string): SQL | undefined {
  if (!q) return undefined;
  const term = likeTerm(q);
  return sql`(${companies.name} ilike ${term} or coalesce(${companies.description}, '') ilike ${term} or coalesce(${companies.sector}, '') ilike ${term} or coalesce(${companies.domain}, '') ilike ${term} or coalesce(${companies.hq}, '') ilike ${term})`;
}

/** A name or domain prefix among all search results, including those beyond the current page. */
export async function hasNamedCompanyInResults(handle: Db, query: string): Promise<boolean> {
  const term = normalizedCompanyQuery(query);
  if (!term) return false;
  const prefix = `${term.replace(/[%_\\]/g, "\\$&")}%`;
  const [match] = await handle
    .select({ id: companies.id })
    .from(companies)
    .innerJoin(fundingRounds, eq(fundingRounds.companyId, companies.id))
    .where(
      and(
        inArray(fundingRounds.disposition, [...VISIBLE]),
        companyMatch(query),
        or(sql`${companies.name} ilike ${prefix}`, sql`${companies.domain} ilike ${prefix}`),
      ),
    )
    .limit(1);
  return Boolean(match);
}

const latestOn = sql<string | null>`max(${fundingRounds.announcedOn})`;
const raised = sql<
  string | null
>`sum(${fundingRounds.amountUsdMillions}) filter (where ${fundingRounds.certainty} in ('announced', 'reported'))`;
/**
 * Dozens of companies share a latest day (31 on Sep 23 alone), so "latest" needs a tie-break before
 * the name, or each day reads A to Z: the most recently found first, then the most raised.
 */
const lastFound = sql`max(${fundingRounds.firstSeenAt}) desc`;

function companyOrder(sort: CompanySort): SQL[] {
  const byName = [sql`lower(${companies.name})`, companies.id].map((c) => sql`${c} asc`);
  if (sort === "name") return byName;
  if (sort === "raised") return [sql`${raised} desc nulls last`, sql`${latestOn} desc nulls last`, ...byName];
  return [sql`${latestOn} desc nulls last`, lastFound, sql`${raised} desc nulls last`, ...byName];
}

/** The newest visible round per company, by the feed's own order (announced desc, undated last, id desc). */
async function latestRounds(handle: Db, companyIds: string[]): Promise<Map<string, CompanyListing["latest"]>> {
  const out = new Map<string, CompanyListing["latest"]>();
  if (companyIds.length === 0) return out;
  const rows = await handle
    .select({
      companyId: fundingRounds.companyId,
      stage: fundingRounds.stage,
      stageAsWritten: fundingRounds.stageAsWritten,
      announcedOn: fundingRounds.announcedOn,
      datePrecision: fundingRounds.datePrecision,
    })
    .from(fundingRounds)
    .where(and(inArray(fundingRounds.companyId, companyIds), inArray(fundingRounds.disposition, [...VISIBLE])))
    .orderBy(sql`${fundingRounds.announcedOn} desc nulls last`, sql`${fundingRounds.id} desc`);
  for (const r of rows) {
    if (out.has(r.companyId)) continue;
    out.set(r.companyId, {
      stage: r.stage,
      stage_as_written: r.stageAsWritten,
      announced_on: r.announcedOn,
      date_precision: r.datePrecision as NonNullable<CompanyListing["latest"]>["date_precision"],
    });
  }
  return out;
}

/** A visible round of the company at one of the stages, announced on or after the day; undefined when neither is asked. */
function raisedMatch(stages: readonly Stage[] | undefined, since: string | undefined): SQL | undefined {
  if (!stages?.length && !since) return undefined;
  const conds = [
    sql`r.company_id = ${companies.id}`,
    sql`r.disposition in (${sql.join(
      VISIBLE.map((d) => sql`${d}`),
      sql`, `,
    )})`,
  ];
  if (stages?.length)
    conds.push(
      sql`r.stage::text in (${sql.join(
        stages.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  if (since) conds.push(sql`r.announced_on >= ${since}`);
  return sql`exists (select 1 from funding_rounds r where ${sql.join(conds, sql` and `)})`;
}

/**
 * One page of companies with at least one visible round, searched over name, description, sector,
 * domain, and headquarters. `sector` narrows to one sector; `stages` and `since` to companies with a
 * visible round at one of those stages announced on or after that day. Counts and totals stay over
 * all of a company's visible rounds.
 */
export async function listCompanies(
  handle: Db,
  query: {
    q?: string;
    sector?: string;
    stages?: readonly Stage[];
    since?: string;
    sort?: CompanySort;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<DirectoryPage<CompanyListing>> {
  const size = query.pageSize ?? DIRECTORY_PAGE_SIZE;
  const where = and(
    inArray(fundingRounds.disposition, [...VISIBLE]),
    companyMatch(query.q ?? ""),
    query.sector ? inArray(companies.sector, sectorMembers(query.sector)) : undefined,
    raisedMatch(query.stages, query.since),
  );
  const [count] = await handle
    .select({ n: sql<number>`count(distinct ${companies.id})::int` })
    .from(companies)
    .innerJoin(fundingRounds, eq(fundingRounds.companyId, companies.id))
    .where(where);
  const total = count?.n ?? 0;
  const win = pageWindow(total, query.page ?? 1, size);
  if (total === 0) return { rows: [], total, ...win };

  const rows = await handle
    .select({
      id: companies.id,
      name: companies.name,
      domain: companies.domain,
      logoUrl: companies.logoUrl,
      description: companies.description,
      sector: companies.sector,
      hq: companies.hq,
      rounds: sql<number>`count(*)::int`,
      raised,
    })
    .from(companies)
    .innerJoin(fundingRounds, eq(fundingRounds.companyId, companies.id))
    .where(where)
    .groupBy(companies.id)
    .orderBy(...companyOrder(query.sort ?? "latest"))
    .limit(size)
    .offset(win.offset);
  const latest = await latestRounds(
    handle,
    rows.map((r) => r.id),
  );
  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      domain: r.domain,
      logo_url: r.logoUrl,
      description: r.description,
      sector: r.sector,
      hq: r.hq,
      rounds: r.rounds,
      usd_millions_raised: r.raised === null ? null : Math.round(Number(r.raised) * 1000) / 1000,
      latest: latest.get(r.id) ?? null,
    })),
    total,
    ...win,
  };
}

export interface InvestorListing {
  id: string;
  name: string;
  /** The investor's own site, bare ("a16z.com"), for its logo; null until a search resolves it. */
  domain: string | null;
  /** The logo the branding format read off that site; null until read. */
  logo_url: string | null;
  led: number;
  participated: number;
  total: number;
  /** The newest visible round the investor is named on: the day, and whose round it was. */
  latest: {
    announced_on: string | null;
    date_precision: "day" | "week" | "month" | "unknown";
    company_id: string;
    company: string;
    stage: Stage;
    stage_as_written: string;
  } | null;
}

function investorMatch(q: string): SQL | undefined {
  if (!q) return undefined;
  const term = likeTerm(q);
  return sql`(${investors.name} ilike ${term} or coalesce(${investors.domain}, '') ilike ${term})`;
}

const led = sql<number>`(count(*) filter (where ${roundInvestors.role} = 'lead'))::int`;
const seats = sql<number>`count(*)::int`;

function investorOrder(sort: InvestorSort): SQL[] {
  const byName = [sql`lower(${investors.name}) asc`, sql`${investors.id} asc`];
  if (sort === "name") return byName;
  if (sort === "rounds") return [sql`${seats} desc`, sql`${latestOn} desc nulls last`, ...byName];
  if (sort === "led") return [sql`${led} desc`, sql`${seats} desc`, ...byName];
  return [sql`${latestOn} desc nulls last`, lastFound, sql`${seats} desc`, ...byName];
}

/** One page of investors named on visible rounds, with the seats they took (anything but lead counts as participated, as on the investor page). */
export async function listInvestors(
  handle: Db,
  query: { q?: string; sort?: InvestorSort; page?: number; pageSize?: number } = {},
): Promise<DirectoryPage<InvestorListing>> {
  const size = query.pageSize ?? DIRECTORY_PAGE_SIZE;
  const where = and(inArray(fundingRounds.disposition, [...VISIBLE]), investorMatch(query.q ?? ""));
  const [count] = await handle
    .select({ n: sql<number>`count(distinct ${investors.id})::int` })
    .from(investors)
    .innerJoin(roundInvestors, eq(roundInvestors.investorId, investors.id))
    .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
    .where(where);
  const total = count?.n ?? 0;
  const win = pageWindow(total, query.page ?? 1, size);
  if (total === 0) return { rows: [], total, ...win };

  const rows = await handle
    .select({ id: investors.id, name: investors.name, domain: investors.domain, logoUrl: investors.logoUrl, led, seats })
    .from(investors)
    .innerJoin(roundInvestors, eq(roundInvestors.investorId, investors.id))
    .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
    .where(where)
    .groupBy(investors.id)
    .orderBy(...investorOrder(query.sort ?? "latest"))
    .limit(size)
    .offset(win.offset);

  const ids = rows.map((r) => r.id);
  const recent = ids.length
    ? await handle
        .select({
          investorId: roundInvestors.investorId,
          announcedOn: fundingRounds.announcedOn,
          datePrecision: fundingRounds.datePrecision,
          stage: fundingRounds.stage,
          stageAsWritten: fundingRounds.stageAsWritten,
          companyId: companies.id,
          company: companies.name,
        })
        .from(roundInvestors)
        .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
        .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
        .where(and(inArray(roundInvestors.investorId, ids), inArray(fundingRounds.disposition, [...VISIBLE])))
        .orderBy(sql`${fundingRounds.announcedOn} desc nulls last`, sql`${fundingRounds.id} desc`)
    : [];
  const latest = new Map<string, InvestorListing["latest"]>();
  for (const r of recent) {
    if (!latest.has(r.investorId))
      latest.set(r.investorId, {
        announced_on: r.announcedOn,
        date_precision: r.datePrecision as NonNullable<InvestorListing["latest"]>["date_precision"],
        company_id: r.companyId,
        company: r.company,
        stage: r.stage,
        stage_as_written: r.stageAsWritten,
      });
  }

  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      domain: r.domain,
      logo_url: r.logoUrl,
      led: r.led,
      participated: r.seats - r.led,
      total: r.seats,
      latest: latest.get(r.id) ?? null,
    })),
    total,
    ...win,
  };
}

export interface SearchHit {
  kind: "company" | "investor";
  id: string;
  name: string;
  /** The quiet second line: a company's domain or sector, an investor's round count. */
  detail: string | null;
  domain: string | null;
  logo_url: string | null;
}

/** Exact name, then prefix, then a word inside the name, then anywhere: what a reader typing a name expects at the top. */
function nameRank(column: typeof companies.name | typeof investors.name, q: string): SQL {
  const bare = q.replace(/[%_\\]/g, "");
  return sql`case when lower(${column}) = ${bare.toLowerCase()} then 0 when ${column} ilike ${`${bare}%`} then 1 when ${column} ilike ${`% ${bare}%`} then 2 else 3 end`;
}

/**
 * The command palette's lookup: up to `limit` companies and investors whose names match, over the
 * same visible rounds as the directories. Companies also match on domain, so "acme.com" finds Acme.
 */
export async function searchDirectory(handle: Db, rawQ: string, limit = 6): Promise<{ companies: SearchHit[]; investors: SearchHit[] }> {
  const q = rawQ.trim().slice(0, 100);
  if (!q.replace(/[%_\\]/g, "")) return { companies: [], investors: [] };
  const term = likeTerm(q);
  const [companyRows, investorRows] = await Promise.all([
    handle
      .select({
        id: companies.id,
        name: companies.name,
        domain: companies.domain,
        logoUrl: companies.logoUrl,
        sector: companies.sector,
      })
      .from(companies)
      .innerJoin(fundingRounds, eq(fundingRounds.companyId, companies.id))
      .where(
        and(
          inArray(fundingRounds.disposition, [...VISIBLE]),
          or(sql`${companies.name} ilike ${term}`, sql`coalesce(${companies.domain}, '') ilike ${term}`),
        ),
      )
      .groupBy(companies.id)
      .orderBy(nameRank(companies.name, q), sql`${latestOn} desc nulls last`, sql`lower(${companies.name})`)
      .limit(limit),
    handle
      .select({ id: investors.id, name: investors.name, domain: investors.domain, logoUrl: investors.logoUrl, seats })
      .from(investors)
      .innerJoin(roundInvestors, eq(roundInvestors.investorId, investors.id))
      .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
      .where(and(inArray(fundingRounds.disposition, [...VISIBLE]), sql`${investors.name} ilike ${term}`))
      .groupBy(investors.id)
      .orderBy(nameRank(investors.name, q), sql`${seats} desc`, sql`lower(${investors.name})`)
      .limit(limit),
  ]);
  return {
    companies: companyRows.map((c) => ({
      kind: "company",
      id: c.id,
      name: c.name,
      detail: c.domain ?? (sectorLabel(c.sector) || null),
      domain: c.domain,
      logo_url: c.logoUrl,
    })),
    investors: investorRows.map((i) => ({
      kind: "investor",
      id: i.id,
      name: i.name,
      detail: `${i.seats} ${i.seats === 1 ? "round" : "rounds"}`,
      domain: i.domain,
      logo_url: i.logoUrl,
    })),
  };
}
