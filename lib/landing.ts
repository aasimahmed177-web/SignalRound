// The landing page's data and its copyable snippets (app/(marketing)/home). Every figure is a read
// of the same store the feed renders, over the rows the feed publishes (publish and flagged), so a
// number on the landing page never disagrees with the dashboard a click away. The snippets are
// built from the instance's own origin, so what a reader copies works against the page they read.

import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { FILING_HOSTS } from "@/lib/news";
import type { RoundRow } from "@/lib/persist";
import { demoStats } from "@/lib/stats";

const { fundingRounds, roundInvestors, roundSources, runs, sources } = schema;

export const REPO_URL = "https://github.com/aasimahmed177-web/SignalRound";

/** The README's Deploy with Vercel button, character for character: the repo, the three env vars it asks for, and a Neon database. */
export const DEPLOY_URL =
  "https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Faasimahmed177-web%2FSignalRound&env=FIRECRAWL_API_KEY%2CDASHBOARD_PASSWORD%2CCRON_SECRET%2CSIGNAL_INGEST_KEY&envDescription=Your%20Firecrawl%20API%20key%2C%20dashboard%20password%2C%20cron%20secret%2C%20and%20a%20dedicated%20bearer%20key%20for%20signal%20ingestion&envLink=https%3A%2F%2Fwww.firecrawl.dev%2Fapp%2Fapi-keys&stores=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%5D";

export const API_KEYS_URL = "https://www.firecrawl.dev/app/api-keys";

/** Fireround's page in Firecrawl Alexandria, where ChatGPT, Claude, and other agents query this feed through Firecrawl. */
export const ALEXANDRIA_URL = "https://www.firecrawl.dev/alexandria/fireround";

/** The README's quick start, with the comment on the key line cut to fit a phone. */
export const QUICK_START = [
  "git clone https://github.com/aasimahmed177-web/SignalRound.git && cd SignalRound",
  "pnpm install",
  "cp .env.example .env   # paste your Firecrawl key",
  "pnpm dev               # http://localhost:3000",
].join("\n");

/**
 * The three variables the Deploy button asks for, with the README's word on each. Each comment sits
 * on its own line above its variable, short enough that a 390px screen never wraps one mid-phrase.
 */
export const ENV_EXAMPLE = [
  "# the one you need",
  "FIRECRAWL_API_KEY=fc-...",
  "# optional: locks the dashboard",
  "DASHBOARD_PASSWORD=...",
  "# any random string, 16+ characters",
  "CRON_SECRET=...",
].join("\n");

const visible = inArray(fundingRounds.disposition, ["publish", "flagged"]);
/** The feed's own rows: what Latest lists with no date range, history rows left out (lib/persist.ts feedHistory). */
const inFeed = and(visible, eq(fundingRounds.history, false));

export interface LandingStats {
  rounds_7d: number;
  usd_7d: number;
  /** The article pages behind the verified rounds, filings aside: the same population as `verified`, so the card's two figures describe one set. */
  articles: number;
  /** The rounds the feed lists, the "N OF M ROWS" of its Latest view. */
  records: number;
  /** Of those, the ones the feed marks verified: published, and confirmed or corrected against their sources. Flagged rows are not. */
  verified: number;
  /** Distinct investors named on a published record: what the Investors index lists. */
  investors: number;
  /** When the newest run started, any lane; null on a store that has never run. */
  last_run_at: string | null;
}

/**
 * The hero's counters. Each shares its definition with the page a click away, so no two pages
 * quote different figures for one thing: the week is the demo hero's aggregate (lib/stats.ts), the
 * rounds are the feed's Latest count, and "verified" is the feed's check mark (a flagged row is not
 * verified). The articles are the distinct pages linked to those verified rounds, so "N articles
 * behind M verified rounds" counts one population.
 */
export async function landingStats(handle: Db): Promise<LandingStats> {
  const verified = sql`${fundingRounds.disposition} = 'publish' and ${fundingRounds.verification}->>'status' in ('confirmed', 'corrected')`;
  const [week, [records], [articles], [people], [last]] = await Promise.all([
    demoStats(handle),
    handle
      .select({
        n: sql<number>`count(*)::int`,
        verified: sql<number>`count(*) filter (where ${verified})::int`,
      })
      .from(fundingRounds)
      .where(inFeed),
    handle
      .select({ n: sql<number>`count(distinct ${roundSources.sourceId})::int` })
      .from(roundSources)
      .innerJoin(fundingRounds, eq(fundingRounds.id, roundSources.roundId))
      .innerJoin(sources, eq(sources.id, roundSources.sourceId))
      .where(and(inFeed, verified, notInArray(sources.host, [...FILING_HOSTS]))),
    handle
      .select({ n: sql<number>`count(distinct ${roundInvestors.investorId})::int` })
      .from(roundInvestors)
      .innerJoin(fundingRounds, sql`${fundingRounds.id} = ${roundInvestors.roundId}`)
      .where(visible),
    handle.select({ at: runs.startedAt }).from(runs).orderBy(desc(runs.startedAt)).limit(1),
  ]);
  return {
    rounds_7d: week.rounds_7d,
    usd_7d: week.usd_7d,
    articles: articles?.n ?? 0,
    records: records?.n ?? 0,
    verified: records?.verified ?? 0,
    investors: people?.n ?? 0,
    last_run_at: last?.at ? last.at.toISOString() : null,
  };
}

/** 12,480: a counter's figure. It lives in lib/format.ts, which client components can import; re-exported for the landing's callers. */
export { grouped } from "@/lib/format";

/**
 * The API calls the landing page shows: the first is the one a reader tries, the other two show a
 * format and the date filter. URLs are quoted: bare, the shell would read `&` as the end of the command.
 */
export function apiExample(origin: string, since: string): string {
  const base = `${origin}/api/v1/rounds`;
  return [
    "# Series A rounds, newest first",
    `curl "${base}?stage=series_a&limit=5"`,
    "",
    "# The same filter as CSV, for a spreadsheet",
    `curl "${base}?stage=series_a&format=csv"`,
    "",
    "# Everything announced since a date",
    `curl "${base}?since=${since}"`,
  ].join("\n");
}

/** An MCP client's config for this instance's server (streamable HTTP at /api/mcp). */
export function mcpConfig(origin: string): string {
  return JSON.stringify({ mcpServers: { fireround: { url: `${origin}/api/mcp` } } }, null, 2);
}

/**
 * One real row as `GET /api/v1/rounds` returns it, cut to the fields a reader checks first. The
 * keys and nesting are the API's own, so the preview is a true subset, not a paraphrase.
 */
export function apiPreview(r: RoundRow, nextCursor: string | null) {
  return {
    data: [
      {
        company: { name: r.company.name, domain: r.company.domain },
        stage: r.stage,
        amount: { as_written: r.amount.as_written, usd_millions: r.amount.usd_millions },
        announced_on: r.announced_on,
        lead_investors: r.lead_investors,
        verification: r.verification
          ? {
              status: r.verification.status,
              ...(r.verification.sources_seen === undefined ? {} : { sources_seen: r.verification.sources_seen }),
            }
          : null,
        sources: r.sources.slice(0, 2).map((s) => ({ url: s.url })),
      },
    ],
    next_cursor: nextCursor,
  };
}
