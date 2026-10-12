// The questions people ask an assistant about startup funding, each with the Alexandria capability and
// options an agent should call, and the ground truth read from the database when the eval runs (the
// data changes daily, so no answer is written down here). Tags mark the edge cases: a misspelling, a
// name or alias for an id, a date phrase passed through as written, and questions whose honest
// answer is "none".

import { isListPage, sectorMembers } from "@fireround/core";
import { type SQL, sql } from "drizzle-orm";
import type { Expect, Fact } from "./judge.ts";

export const CAPABILITIES = [
  "rounds/search",
  "rounds/trending",
  "companies/rounds",
  "companies/search",
  "companies/profile",
  "investors/search",
  "investors/top",
  "investors/profile",
  "news/latest",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type Tag = "typo" | "alias" | "date-phrase" | "empty";

/** Runs one read-only query against the database and returns its rows. */
export type Query = <T>(query: SQL) => Promise<T[]>;

export interface Question {
  id: string;
  ask: string;
  capability: Capability;
  /** The capability's options as an agent passes them through Alexandria; `id` is the profile's path segment. */
  params: Record<string, string | number>;
  tags?: Tag[];
  truth: (q: Query) => Promise<Expect>;
}

/** The days the questions are asked relative to, in UTC as the API counts them. */
export interface Days {
  today: string;
  ago: (n: number) => string;
  monthStart: string;
  quarterStart: string;
}

export function days(now: Date): Days {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    today: iso(now),
    ago: (n) => iso(new Date(now.getTime() - n * 86_400_000)),
    monthStart: iso(new Date(Date.UTC(y, m, 1))),
    quarterStart: iso(new Date(Date.UTC(y, m - (m % 3), 1))),
  };
}

/** A round the public API lists: published or flagged, and never an unconfirmed one. */
const VISIBLE = sql`r.disposition in ('publish', 'flagged') and r.certainty <> 'unconfirmed'`;
/** A round the rankings count: closed (announced or reported) and recent news, not a company's earlier round. */
const CAUGHT = sql`r.disposition in ('publish', 'flagged') and r.history = false and r.certainty in ('announced', 'reported')`;
const CAPITAL = sql`r.certainty in ('announced', 'reported')`;

/** The id the API gives an investor: its stored id with spaces as hyphens. */
const slug = (id: string) => encodeURIComponent(id.trim().replace(/\s+/g, "-"));
const all = (parts: Array<SQL | undefined>) =>
  sql.join(
    parts.filter((p): p is SQL => p !== undefined),
    sql` and `,
  );
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const byScore = (rows: Array<{ key: string; score: number }>) => rows.sort((a, b) => b.score - a.score);

/**
 * The rounds matching the question. Without a date or a company the feed leaves companies' earlier
 * rounds out, so `recentOnly` marks a question with neither.
 */
function rounds(where: Array<SQL | undefined>, opts: { recentOnly?: boolean } = {}) {
  return async (q: Query): Promise<Expect> => {
    const rows = await q<{ id: string }>(
      sql`select r.id from funding_rounds r join companies c on c.id = r.company_id
          where ${all([VISIBLE, opts.recentOnly ? sql`r.history = false` : undefined, ...where])}`,
    );
    return { kind: "rows", keys: rows.map((r) => r.id) };
  };
}

/** The `n` largest rounds by USD amount; a round with no stated amount never ranks. */
function biggest(where: Array<SQL | undefined>, n: number) {
  return async (q: Query): Promise<Expect> => {
    const rows = await q<{ id: string; usd: number }>(
      sql`select r.id, r.amount_usd_millions::float as usd from funding_rounds r join companies c on c.id = r.company_id
          where ${all([VISIBLE, sql`r.amount_usd_millions is not null`, ...where])}`,
    );
    return { kind: "top", n, ranked: byScore(rows.map((r) => ({ key: r.id, score: r.usd }))) };
  };
}

/** Companies with a listed round, where `company` narrows the company and `round` which round must exist. */
function companies(company: Array<SQL | undefined>, round: Array<SQL | undefined> = []) {
  return async (q: Query): Promise<Expect> => {
    const rows = await q<{ id: string }>(
      sql`select c.id from companies c where ${all([
        ...company,
        sql`exists (select 1 from funding_rounds r where r.company_id = c.id and ${all([VISIBLE, ...round])})`,
      ])}`,
    );
    return { kind: "rows", keys: rows.map((r) => r.id) };
  };
}

/** The `n` companies that raised the most in announced and reported rounds. */
function mostRaised(company: Array<SQL | undefined>, n: number) {
  return async (q: Query): Promise<Expect> => {
    const rows = await q<{ id: string; usd: number }>(
      sql`select c.id, sum(r.amount_usd_millions) filter (where ${CAPITAL})::float as usd
          from companies c join funding_rounds r on r.company_id = c.id
          where ${all([VISIBLE, ...company])}
          group by c.id having sum(r.amount_usd_millions) filter (where ${CAPITAL}) is not null`,
    );
    return { kind: "top", n, ranked: byScore(rows.map((r) => ({ key: r.id, score: r.usd }))) };
  };
}

/** The company a person means by this name or domain: the one with listed rounds, the most of them first. */
async function companyId(q: Query, nameOrDomain: string): Promise<string | null> {
  const [hit] = await q<{ id: string }>(
    sql`select c.id from companies c join funding_rounds r on r.company_id = c.id
        where (lower(c.name) = lower(${nameOrDomain}) or c.domain = lower(${nameOrDomain})) and ${VISIBLE}
        group by c.id order by count(*) desc limit 1`,
  );
  return hit?.id ?? null;
}

async function investorId(q: Query, name: string): Promise<string | null> {
  const [hit] = await q<{ id: string }>(
    sql`select i.id from investors i join round_investors ri on ri.investor_id = i.id join funding_rounds r on r.id = ri.round_id
        where lower(i.name) = lower(${name}) and ${VISIBLE} group by i.id order by count(*) desc limit 1`,
  );
  return hit?.id ?? null;
}

/** A company's profile as the database states it: total raised, rounds, latest day, every investor. */
function companyProfile(nameOrDomain: string) {
  return async (q: Query): Promise<Expect> => {
    const id = await companyId(q, nameOrDomain);
    if (!id) return { kind: "none" };
    const [row] = await q<{ total: number; n: number; latest: string | null }>(
      sql`select coalesce(sum(r.amount_usd_millions) filter (where ${CAPITAL}), 0)::float as total, count(*)::int as n,
                 max(r.announced_on) as latest
          from funding_rounds r where r.company_id = ${id} and ${VISIBLE}`,
    );
    const inv = await q<{ id: string }>(
      sql`select distinct ri.investor_id as id from round_investors ri join funding_rounds r on r.id = ri.round_id
          where r.company_id = ${id} and ${VISIBLE}`,
    );
    const facts: Record<string, Fact> = {
      total_raised_usd_millions: round3(row?.total ?? 0),
      rounds: row?.n ?? 0,
      latest_announced_on: row?.latest ?? null,
      investors: inv.map((i) => slug(i.id)),
    };
    return { kind: "entity", key: id, facts };
  };
}

/** An investor's profile as the database states it: the closed rounds it led and the ones it joined. */
function investorProfile(name: string) {
  return async (q: Query): Promise<Expect> => {
    const id = await investorId(q, name);
    if (!id) return { kind: "none" };
    const [row] = await q<{ led: number; joined: number }>(
      sql`select count(distinct r.id) filter (where ri.role = 'lead')::int as led,
                 count(distinct r.id) filter (where ri.role <> 'lead')::int as joined
          from round_investors ri join funding_rounds r on r.id = ri.round_id
          where ri.investor_id = ${id} and ${VISIBLE} and ${CAPITAL}`,
    );
    return { kind: "entity", key: slug(id), facts: { rounds_led: row?.led ?? 0, rounds_participated: row?.joined ?? 0 } };
  };
}

/** The investors that led the most closed rounds since `from`, as the ranking counts them. */
function topLeads(from: string, where: Array<SQL | undefined>, n: number) {
  return async (q: Query): Promise<Expect> => {
    const rows = await q<{ id: string; led: number }>(
      sql`select ri.investor_id as id, count(distinct r.id)::int as led
          from round_investors ri join funding_rounds r on r.id = ri.round_id join companies c on c.id = r.company_id
          where ${all([CAUGHT, sql`ri.role = 'lead'`, sql`r.announced_on >= ${from}`, ...where])}
          group by ri.investor_id`,
    );
    return { kind: "top", n, ranked: byScore(rows.map((r) => ({ key: slug(r.id), score: r.led }))) };
  };
}

/** The one company or investor a search for this name should list first. */
function first(kind: "company" | "investor", name: string) {
  return async (q: Query): Promise<Expect> => {
    const id = kind === "company" ? await companyId(q, name) : await investorId(q, name);
    if (!id) return { kind: "none" };
    return { kind: "match", key: kind === "company" ? id : slug(id) };
  };
}

/** The rounds in the trending window (72 hours), ranked by score. */
function trending(where: Array<SQL | undefined>, n: number) {
  return async (q: Query): Promise<Expect> => {
    const rows = await q<{ id: string; score: number }>(
      sql`select r.id, t.score from trending_rounds t join funding_rounds r on r.id = t.round_id join companies c on c.id = r.company_id
          where ${all([
            sql`t.first_seen_at > now() - interval '72 hours'`,
            sql`t.stale = false`,
            sql`t.score > 0`,
            VISIBLE,
            sql`r.history = false`,
            ...where,
          ])}`,
    );
    return { kind: "top", n, ranked: byScore(rows.map((r) => ({ key: r.id, score: r.score }))) };
  };
}

/** An article's day: its own published day, else the day it was read. */
const ARTICLE_DAY = sql`coalesce(nullif(left(s.published_at, 10), ''), to_char(s.fetched_at at time zone 'UTC', 'YYYY-MM-DD'))`;

/** The articles (never filings, roundups or newsletters, as /api/v1/news leaves them out) that report a listed round matching `round`, from `from` on. */
function news(round: Array<SQL | undefined>, from?: string) {
  return async (q: Query): Promise<Expect> => {
    const rows = await q<{ url: string; title: string | null; rounds: number }>(
      sql`select s.url, s.title, (select count(*) from round_sources rs where rs.source_id = s.id)::int as rounds from sources s where ${all(
        [
          sql`s.host not in ('sec.gov', 'www.sec.gov')`,
          from ? sql`${ARTICLE_DAY} >= ${from}` : undefined,
          sql`exists (select 1 from round_sources rs join funding_rounds r on r.id = rs.round_id join companies c on c.id = r.company_id
                    where ${all([sql`rs.source_id = s.id`, VISIBLE, sql`r.history = false`, ...round])})`,
        ],
      )}`,
    );
    return {
      kind: "rows",
      keys: rows.filter((r) => !isListPage({ url: r.url, title: r.title }, null, r.rounds)).map((r) => r.url),
    };
  };
}

const none = async (): Promise<Expect> => ({ kind: "none" });
/** A sector, or a group of sectors as the taxonomy defines it ("fintech" holds payments, insurtech and crypto). */
const sector = (s: string) =>
  sql`c.sector in (${sql.join(
    sectorMembers(s).map((m) => sql`${m}`),
    sql`, `,
  )})`;
const stageIn = (...stages: string[]) =>
  sql`r.stage::text in (${sql.join(
    stages.map((s) => sql`${s}`),
    sql`, `,
  )})`;
const since = (day: string) => sql`r.announced_on >= ${day}`;
const investorNamed = (term: string) =>
  sql`exists (select 1 from round_investors ri join investors i on i.id = ri.investor_id where ri.round_id = r.id and i.name ilike ${`%${term}%`})`;
/** What /api/v1/news's q matches: the company's name or the article's headline. */
const mentions = (term: string) => sql`(c.name ilike ${`%${term}%`} or s.title ilike ${`%${term}%`})`;
const named = (nameOrDomain: string) => sql`(lower(c.name) = lower(${nameOrDomain}) or c.domain = lower(${nameOrDomain}))`;

/** A misspelled name: the rows are the right company's, and a did-you-mean naming it earns partial credit. */
function misspelled(truth: (q: Query) => Promise<Expect>, meant: string) {
  return async (q: Query): Promise<Expect> => {
    const expect = await truth(q);
    const id = await companyId(q, meant);
    return expect.kind === "rows" && id ? { ...expect, suggest: id } : expect;
  };
}

export function questions(d: Days): Question[] {
  const week = d.ago(7);
  const month30 = d.ago(30);
  const quarter90 = d.ago(90);
  return [
    // rounds/search
    {
      id: "rounds-ai-week",
      ask: "Which AI startups raised money this week?",
      capability: "rounds/search",
      params: { sector: "ai", since: week, limit: 100 },
      truth: rounds([sector("ai"), since(week)]),
    },
    {
      id: "rounds-ai-infra-week",
      ask: "Who raised in AI infrastructure this week?",
      capability: "rounds/search",
      params: { sector: "ai infrastructure", since: week, limit: 100 },
      truth: rounds([sector("ai infrastructure"), since(week)]),
    },
    {
      id: "rounds-ai-infra-capitalised",
      ask: "AI Infrastructure rounds this month",
      capability: "rounds/search",
      params: { sector: "AI infrastructure", since: d.monthStart, limit: 100 },
      tags: ["alias"],
      truth: rounds([sector("ai infrastructure"), since(d.monthStart)]),
    },
    {
      id: "rounds-ai-infra-slug",
      ask: "ai-infra funding since the start of the quarter",
      capability: "rounds/search",
      params: { sector: "ai-infra", since: d.quarterStart, limit: 100 },
      tags: ["alias"],
      truth: rounds([sector("ai infrastructure"), since(d.quarterStart)]),
    },
    {
      id: "rounds-biggest-month",
      ask: "What were the five biggest funding rounds this month?",
      capability: "rounds/search",
      params: { since: d.monthStart, sort: "amount", limit: 5 },
      truth: biggest([since(d.monthStart)], 5),
    },
    {
      id: "rounds-series-a-week",
      ask: "List every Series A from the last 7 days.",
      capability: "rounds/search",
      params: { stage: "series_a", since: week, limit: 100 },
      truth: rounds([stageIn("series_a"), since(week)]),
    },
    {
      id: "rounds-series-a-as-written",
      ask: "Series A rounds in the past week",
      capability: "rounds/search",
      params: { stage: "Series A", since: week, limit: 100 },
      tags: ["alias"],
      truth: rounds([stageIn("series_a"), since(week)]),
    },
    {
      id: "rounds-pre-seed-hyphen",
      ask: "Pre-seed rounds this week",
      capability: "rounds/search",
      params: { stage: "pre-seed", since: week, limit: 100 },
      tags: ["alias"],
      truth: rounds([stageIn("pre_seed"), since(week)]),
    },
    {
      id: "rounds-late-stage-quarter",
      ask: "Which Series D and later rounds happened this quarter?",
      capability: "rounds/search",
      params: { stage: "Series D+", since: d.quarterStart, limit: 100 },
      tags: ["alias"],
      truth: rounds([stageIn("series_d_plus"), since(d.quarterStart)]),
    },
    {
      id: "rounds-fintech-seed-month",
      ask: "Seed rounds in fintech this month",
      capability: "rounds/search",
      params: { stage: "seed", sector: "fintech", since: d.monthStart, limit: 100 },
      truth: rounds([stageIn("seed"), sector("fintech"), since(d.monthStart)]),
    },
    {
      id: "rounds-over-100m-30d",
      ask: "Which rounds of $100M or more were announced in the last 30 days?",
      capability: "rounds/search",
      params: { min_usd: 100, since: month30, limit: 100 },
      truth: rounds([sql`r.amount_usd_millions >= 100`, since(month30)]),
    },
    {
      id: "rounds-announced-over-50m-month",
      ask: "Confirmed (not just reported) rounds over $50M this month",
      capability: "rounds/search",
      params: { certainty: "announced", min_usd: 50, since: d.monthStart, limit: 100 },
      truth: rounds([sql`r.certainty = 'announced'`, sql`r.amount_usd_millions >= 50`, since(d.monthStart)]),
    },
    {
      id: "rounds-healthtech-yesterday",
      ask: "Any healthtech rounds since yesterday?",
      capability: "rounds/search",
      params: { sector: "healthtech", since: d.ago(1), limit: 100 },
      truth: rounds([sector("healthtech"), since(d.ago(1))]),
    },
    {
      id: "rounds-healthcare-word",
      ask: "Healthcare startups that raised this month",
      capability: "rounds/search",
      params: { sector: "healthcare", since: d.monthStart, limit: 100 },
      tags: ["alias"],
      truth: rounds([sector("health"), since(d.monthStart)]),
    },
    {
      id: "rounds-robotics-biggest-month",
      ask: "Biggest robotics rounds this month",
      capability: "rounds/search",
      params: { sector: "robotics", since: d.monthStart, sort: "amount", limit: 5 },
      truth: biggest([sector("robotics"), since(d.monthStart)], 5),
    },
    {
      id: "rounds-sequoia-recent",
      ask: "Which rounds has Sequoia been in recently?",
      capability: "rounds/search",
      params: { q: "Sequoia", limit: 20 },
      truth: rounds([investorNamed("sequoia")], { recentOnly: true }),
    },
    {
      id: "rounds-quantum-seed-week",
      ask: "Quantum computing seed rounds this week",
      capability: "rounds/search",
      params: { sector: "quantum", stage: "seed", since: week, limit: 100 },
      tags: ["empty"],
      truth: rounds([sector("quantum"), stageIn("seed"), since(week)]),
    },
    {
      id: "rounds-q-anthropic",
      ask: "What rounds has Anthropic raised?",
      capability: "rounds/search",
      params: { q: "Anthropic", limit: 20 },
      truth: rounds([named("anthropic.com")]),
    },
    {
      id: "rounds-typo-antropic",
      ask: "Antropic funding rounds",
      capability: "rounds/search",
      params: { q: "Antropic", limit: 20 },
      tags: ["typo"],
      truth: misspelled(rounds([named("anthropic.com")]), "anthropic.com"),
    },
    {
      id: "rounds-nonsense",
      ask: "Rounds for Zqxvtronics",
      capability: "rounds/search",
      params: { q: "Zqxvtronics", limit: 20 },
      tags: ["empty"],
      truth: none,
    },
    {
      id: "rounds-since-7d",
      ask: "Series A rounds in the last 7 days (the agent passes since=7d)",
      capability: "rounds/search",
      params: { stage: "series_a", since: "7d", limit: 100 },
      tags: ["date-phrase"],
      truth: rounds([stageIn("series_a"), since(week)]),
    },
    {
      id: "rounds-since-month",
      ask: "Fintech rounds this month (the agent passes since=YYYY-MM)",
      capability: "rounds/search",
      params: { sector: "fintech", since: d.monthStart.slice(0, 7), limit: 100 },
      tags: ["date-phrase"],
      truth: rounds([sector("fintech"), since(d.monthStart)]),
    },

    // rounds/trending
    {
      id: "trending-now",
      ask: "What funding rounds are trending right now?",
      capability: "rounds/trending",
      params: { limit: 10 },
      truth: trending([], 10),
    },
    {
      id: "trending-ai",
      ask: "Which AI rounds are people talking about?",
      capability: "rounds/trending",
      params: { sector: "ai", limit: 10 },
      truth: trending([sector("ai")], 10),
    },
    {
      id: "trending-seed",
      ask: "Trending seed rounds",
      capability: "rounds/trending",
      params: { stage: "seed", limit: 10 },
      truth: trending([stageIn("seed")], 10),
    },

    // companies/rounds
    {
      id: "company-rounds-anthropic",
      ask: "Show me Anthropic's funding rounds with sources",
      capability: "companies/rounds",
      params: { company: "Anthropic", limit: 50 },
      truth: rounds([named("Anthropic")]),
    },
    {
      id: "company-rounds-supabase",
      ask: "Every round Supabase has raised",
      capability: "companies/rounds",
      params: { company: "supabase.com", limit: 50 },
      truth: rounds([named("supabase.com")]),
    },
    {
      id: "company-rounds-ramp-url",
      ask: "Ramp's funding history (the agent passes the site's URL)",
      capability: "companies/rounds",
      params: { company: "https://www.ramp.com/", limit: 50 },
      tags: ["alias"],
      truth: rounds([named("ramp.com")]),
    },
    {
      id: "company-rounds-typo",
      ask: "Supabse funding rounds",
      capability: "companies/rounds",
      params: { company: "Supabse", limit: 50 },
      tags: ["typo"],
      truth: misspelled(rounds([named("supabase.com")]), "supabase.com"),
    },
    {
      id: "company-rounds-openai",
      ask: "OpenAI's rounds and who led them",
      capability: "companies/rounds",
      params: { company: "openai.com", limit: 50 },
      truth: rounds([named("openai.com")]),
    },

    // companies/search
    {
      id: "companies-london-fintech-month",
      ask: "Which fintech startups in London raised this month?",
      capability: "companies/search",
      params: { q: "London", sector: "fintech", since: d.monthStart, limit: 100 },
      truth: companies([sector("fintech"), sql`c.hq ilike '%london%'`], [since(d.monthStart)]),
    },
    {
      id: "companies-ai-most-raised",
      ask: "Which AI companies have raised the most?",
      capability: "companies/search",
      params: { sector: "ai", sort: "raised", limit: 10 },
      truth: mostRaised([sector("ai")], 10),
    },
    {
      id: "companies-climate-seed-quarter",
      ask: "Seed-stage climate companies that raised this quarter",
      capability: "companies/search",
      params: { sector: "climate", stage: "seed", since: d.quarterStart, limit: 100 },
      truth: companies([sector("climate")], [stageIn("seed"), since(d.quarterStart)]),
    },
    {
      id: "companies-berlin-series-a",
      ask: "Berlin startups that raised a Series A",
      capability: "companies/search",
      params: { q: "Berlin", stage: "series_a", limit: 100 },
      truth: companies([sql`c.hq ilike '%berlin%'`], [stageIn("series_a")]),
    },
    {
      id: "companies-robotics-30d",
      ask: "Robotics companies that raised in the last 30 days",
      capability: "companies/search",
      params: { sector: "robotics", since: month30, limit: 100 },
      truth: companies([sector("robotics")], [since(month30)]),
    },
    {
      id: "companies-dev-tools-alias",
      ask: "Dev tools startups funded this quarter",
      capability: "companies/search",
      params: { sector: "dev tools", since: d.quarterStart, limit: 100 },
      tags: ["alias"],
      truth: companies([sector("developer tools")], [since(d.quarterStart)]),
    },
    {
      id: "companies-typo-antropic",
      ask: "Look up the startup Antropic",
      capability: "companies/search",
      params: { q: "Antropic", limit: 10 },
      tags: ["typo"],
      truth: first("company", "anthropic.com"),
    },
    {
      id: "companies-mistral",
      ask: "Look up the startup Mistral",
      capability: "companies/search",
      params: { q: "Mistral", limit: 10 },
      truth: first("company", "mistral.ai"),
    },
    {
      id: "companies-nonsense",
      ask: "Look up the startup Zqxvtronics",
      capability: "companies/search",
      params: { q: "Zqxvtronics", limit: 10 },
      tags: ["empty"],
      truth: none,
    },

    // companies/profile
    {
      id: "profile-supabase",
      ask: "Tell me about Supabase's funding",
      capability: "companies/profile",
      params: { id: "supabase.com" },
      truth: companyProfile("supabase.com"),
    },
    {
      id: "profile-anthropic-name",
      ask: "How much has Anthropic raised in total?",
      capability: "companies/profile",
      params: { id: "Anthropic" },
      tags: ["alias"],
      truth: companyProfile("anthropic.com"),
    },
    {
      id: "profile-ramp",
      ask: "Who has invested in Ramp?",
      capability: "companies/profile",
      params: { id: "ramp.com" },
      truth: companyProfile("ramp.com"),
    },
    {
      id: "profile-openai",
      ask: "What was OpenAI's last round?",
      capability: "companies/profile",
      params: { id: "openai.com" },
      truth: companyProfile("openai.com"),
    },
    {
      id: "profile-databricks",
      ask: "Databricks total funding",
      capability: "companies/profile",
      params: { id: "databricks.com" },
      truth: companyProfile("databricks.com"),
    },
    {
      id: "profile-firecrawl-url",
      ask: "Firecrawl's funding (the agent passes the full URL)",
      capability: "companies/profile",
      params: { id: "https://www.firecrawl.dev/" },
      tags: ["alias"],
      truth: companyProfile("firecrawl.dev"),
    },
    {
      id: "profile-typo-supabse",
      ask: "supabse funding",
      capability: "companies/profile",
      params: { id: "supabse" },
      tags: ["typo"],
      truth: companyProfile("supabase.com"),
    },
    {
      id: "profile-no-rounds",
      ask: "How much has Linear raised? (linear.app has no listed round)",
      capability: "companies/profile",
      params: { id: "linear.app" },
      tags: ["empty"],
      truth: companyProfile("linear.app"),
    },

    // investors/search
    {
      id: "investors-sequoia",
      ask: "Look up the VC firm Sequoia",
      capability: "investors/search",
      params: { q: "sequoia" },
      truth: first("investor", "Sequoia Capital"),
    },
    {
      id: "investors-a16z",
      ask: "Look up the VC firm a16z",
      capability: "investors/search",
      params: { q: "a16z" },
      tags: ["alias"],
      truth: first("investor", "Andreessen Horowitz"),
    },
    {
      id: "investors-typo-sequioa",
      ask: "Look up the VC firm Sequioa",
      capability: "investors/search",
      params: { q: "Sequioa" },
      tags: ["typo"],
      truth: first("investor", "Sequoia Capital"),
    },
    {
      id: "investors-yc",
      ask: "Look up the investor Y Combinator",
      capability: "investors/search",
      params: { q: "Y Combinator" },
      truth: first("investor", "Y Combinator"),
    },
    {
      id: "investors-most-led",
      ask: "Which investors have led the most rounds?",
      capability: "investors/search",
      params: { sort: "led", limit: 10 },
      truth: async (q) => {
        const rows = await q<{ id: string; led: number }>(
          sql`select ri.investor_id as id, count(*) filter (where ri.role = 'lead')::int as led
              from round_investors ri join funding_rounds r on r.id = ri.round_id
              where r.disposition in ('publish', 'flagged') group by ri.investor_id`,
        );
        return { kind: "top", n: 10, ranked: byScore(rows.map((r) => ({ key: slug(r.id), score: r.led }))) };
      },
    },

    // investors/top
    {
      id: "top-ai-30d",
      ask: "Which VCs led the most AI rounds this month?",
      capability: "investors/top",
      params: { window: "30d", sector: "ai", limit: 10 },
      truth: topLeads(month30, [sector("ai")], 10),
    },
    {
      id: "top-seed-7d",
      ask: "Who is leading the most seed deals this week?",
      capability: "investors/top",
      params: { window: "7d", stage: "seed", limit: 10 },
      truth: topLeads(week, [stageIn("seed")], 10),
    },
    {
      id: "top-90d",
      ask: "Most active lead investors this quarter",
      capability: "investors/top",
      params: { window: "90d", limit: 10 },
      truth: topLeads(quarter90, [], 10),
    },
    {
      id: "top-fintech-seed-30d",
      ask: "Most active seed fintech leads in the last 30 days",
      capability: "investors/top",
      params: { window: "30d", sector: "fintech", stage: "seed", limit: 10 },
      truth: topLeads(month30, [sector("fintech"), stageIn("seed")], 10),
    },
    {
      id: "top-sector-capitalised",
      ask: "Top AI leads this quarter (the agent passes sector=AI)",
      capability: "investors/top",
      params: { window: "90d", sector: "AI", limit: 10 },
      tags: ["alias"],
      truth: topLeads(quarter90, [sector("ai")], 10),
    },
    {
      id: "top-window-month",
      ask: "Top lead investors this month (the agent passes window=month)",
      capability: "investors/top",
      params: { window: "month", limit: 10 },
      tags: ["date-phrase"],
      truth: topLeads(month30, [], 10),
    },

    // investors/profile
    {
      id: "investor-sequoia",
      ask: "Show me Sequoia's track record",
      capability: "investors/profile",
      params: { id: "sequoia" },
      truth: investorProfile("Sequoia Capital"),
    },
    {
      id: "investor-a16z-nickname",
      ask: "What has a16z invested in?",
      capability: "investors/profile",
      params: { id: "a16z" },
      tags: ["alias"],
      truth: investorProfile("Andreessen Horowitz"),
    },
    {
      id: "investor-a16z-name",
      ask: "Andreessen Horowitz portfolio",
      capability: "investors/profile",
      params: { id: "Andreessen Horowitz" },
      tags: ["alias"],
      truth: investorProfile("Andreessen Horowitz"),
    },
    {
      id: "investor-a16z-site",
      ask: "a16z.com investments",
      capability: "investors/profile",
      params: { id: "a16z.com" },
      tags: ["alias"],
      truth: investorProfile("Andreessen Horowitz"),
    },
    {
      id: "investor-yc-nickname",
      ask: "What has YC backed recently?",
      capability: "investors/profile",
      params: { id: "YC" },
      tags: ["alias"],
      truth: investorProfile("Y Combinator"),
    },
    {
      id: "investor-accel",
      ask: "Accel's recent deals",
      capability: "investors/profile",
      params: { id: "accel" },
      truth: investorProfile("Accel"),
    },
    {
      id: "investor-typo-sequioa",
      ask: "Sequioa Capital portfolio",
      capability: "investors/profile",
      params: { id: "Sequioa Capital" },
      tags: ["typo"],
      truth: investorProfile("Sequoia Capital"),
    },

    // news/latest
    {
      id: "news-today",
      ask: "What's the latest startup funding news today?",
      capability: "news/latest",
      params: { since: d.today, limit: 100 },
      truth: news([], d.today),
    },
    {
      id: "news-ai-week",
      ask: "AI funding news from this week",
      capability: "news/latest",
      params: { sector: "ai", since: week, limit: 20 },
      truth: news([sector("ai")], week),
    },
    {
      id: "news-anthropic",
      ask: "News coverage of Anthropic's raises",
      capability: "news/latest",
      params: { q: "Anthropic", limit: 20 },
      truth: news([mentions("Anthropic")]),
    },
    {
      id: "news-since-today-word",
      ask: "Funding news today (the agent passes since=today)",
      capability: "news/latest",
      params: { since: "today", limit: 100 },
      tags: ["date-phrase"],
      truth: news([], d.today),
    },
    {
      id: "news-nonsense",
      ask: "News about Zqxvtronics funding",
      capability: "news/latest",
      params: { q: "Zqxvtronics", limit: 20 },
      tags: ["empty"],
      truth: none,
    },
  ];
}
