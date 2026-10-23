// The landing page's live parts: everything here reads the store at request time behind a
// Suspense boundary, so the page's static shell (the hero words, the sections, the snippets'
// frames) is prerendered and these stream in. The reads go through lib/cached.ts, so the store
// answers about once a minute however busy the page is, and React's cache shares each one between
// the parts that want it within a request.

import { ArrowRight, ArrowUpRight } from "lucide-react";
import { headers } from "next/headers";
import Link from "next/link";
import { connection } from "next/server";
import { cache } from "react";
import { FlameMark } from "@/components/brand/flame-mark";
import { CompanyLogo } from "@/components/company-logo";
import { RoundCheckMark } from "@/components/confidence";
import { CodeLines } from "@/components/marketing/code";
import { type CodeTab, CodeTabs } from "@/components/marketing/code-tabs";
import { SlackPreview } from "@/components/marketing/slack-preview";
import { RelativeDay } from "@/components/relative-day";
import { mcpTrusted } from "@/lib/access";
import { cachedHouseRound, cachedLandingHero, cachedLandingStats, cachedLatestRounds, cachedSeriesAPick } from "@/lib/cached";
import { compactJson } from "@/lib/code-tokens";
import { slackBlocks } from "@/lib/delivery";
import { relativeTime, reportedAmount, roundStageLabel, stageOf, usd } from "@/lib/format";
import { houseDomain, houseHeadline, isFreshHouseRound, isHouseCompany } from "@/lib/house";
import { apiExample, apiPreview, grouped, mcpConfig } from "@/lib/landing";
import { companyHref } from "@/lib/links";
import { publicOrigin } from "@/lib/origin";
import type { RoundRow } from "@/lib/persist";
import { TRENDING_VIEW_HREF } from "@/lib/round-sort";
import { capitalizeFirst } from "@/lib/text";
import { cn } from "@/lib/utils";

const GLIMPSE_ROWS = 6;

/** Request time, never the build: the cached reads below must not run while prerendering. */
const live = cache(() => connection());
const stats = cache(async () => {
  await live();
  return cachedLandingStats();
});
const latest = cache(async () => {
  await live();
  return cachedLatestRounds(GLIMPSE_ROWS);
});
const hero = cache(async () => {
  await live();
  return cachedLandingHero(GLIMPSE_ROWS);
});
const origin = cache(async () => publicOrigin(await headers()));

/** The house round while it is fresh (lib/house.ts), or null: the landing page's one-off moment. */
const houseRound = cache(async (): Promise<RoundRow | null> => {
  await live();
  const r = await cachedHouseRound();
  const house = houseDomain();
  // Judged again against the clock: an entry cached just before the window closed must not outlive it.
  return r && house && isFreshHouseRound(r, new Date(), house) ? r : null;
});

/** A small live dot: forest, with one soft ring that repeats unless the reader asked for less motion. */
function LiveDot() {
  return (
    <span aria-hidden className="relative flex size-2">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent-forest opacity-50 motion-reduce:hidden" />
      <span className="relative inline-flex size-2 rounded-full bg-accent-forest" />
    </span>
  );
}

function Logo({ r, size }: { r: RoundRow; size: number }) {
  // The house company wears the flame on its own, never boxed (docs/design.md).
  if (isHouseCompany(r.company)) return <FlameMark live size="inherit" className="size-7 shrink-0" />;
  return (
    <CompanyLogo
      id={r.company.id}
      name={r.company.name}
      domain={r.company.domain}
      logoUrl={r.company.logo_url}
      size={size}
      className="shrink-0"
    />
  );
}

function amountOf(r: RoundRow): string | null {
  return reportedAmount(r);
}

const glimpseCols = "md:grid-cols-[28px_minmax(0,1fr)_104px_72px_minmax(0,168px)_64px]";

/**
 * The hero's product glimpse: the most discussed rounds as the feed opens on them (the newest on a
 * store nothing has scored yet), because a round people are talking about has had time to gather its
 * sources (logo, stage with the check
 * and its source count beneath, amount, lead), in a window frame. Real rows, linked to their company
 * pages; an empty store says so instead of drawing a blank table.
 */
export async function LiveGlimpse() {
  const [{ rows, trending }, s, o] = await Promise.all([hero(), stats(), origin()]);
  const host = o.replace(/^https?:\/\//, "");
  return (
    <div className="overflow-hidden rounded-16 border border-border-faint bg-card text-left shadow-[0_24px_48px_-28px_rgba(0,0,0,0.18)] dark:shadow-none">
      <div className="flex h-11 items-center justify-between gap-3 border-b border-border-faint px-4">
        {/* This week's count where a window's controls would sit: the scale of the feed, read before the rows. */}
        {s.rounds_7d > 0 ? (
          <span className="shrink-0 text-label-x-small text-muted-foreground">
            <span className="font-mono tabular-nums text-foreground">{grouped(s.rounds_7d)}</span> {s.rounds_7d === 1 ? "round" : "rounds"}{" "}
            in the last 7 days
          </span>
        ) : (
          <span aria-hidden className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full border border-border-muted" />
            <span className="size-2.5 rounded-full border border-border-muted" />
            <span className="size-2.5 rounded-full border border-border-muted" />
          </span>
        )}
        <span className="hidden h-6 min-w-0 items-center truncate rounded-6 bg-black-alpha-4 px-3 font-mono text-[12px] text-muted-foreground sm:flex">
          {host}/feed
        </span>
        <span className="flex items-center gap-2 text-label-x-small text-muted-foreground">
          <LiveDot />
          <span>
            Live
            {s.last_run_at && <span className="hidden sm:inline"> · last run {relativeTime(s.last_run_at)}</span>}
          </span>
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="px-5 py-14 text-center">
          <p className="text-label-medium">No rounds yet.</p>
          <p className="mt-1 text-body-small text-muted-foreground">
            The first sweep fills this in: last week of Series A and B, in about ten minutes.
          </p>
        </div>
      ) : (
        <>
          <div
            className={cn(
              "hidden gap-x-4 border-b border-border-faint px-5 py-2 text-mono-x-small text-black-alpha-32 md:grid",
              glimpseCols,
            )}
          >
            <span className="col-span-2">Company</span>
            <span>Stage</span>
            <span className="text-right">Amount</span>
            <span>Lead</span>
            <span className="text-right">Date</span>
          </div>
          <ul className="divide-y divide-border-faint">
            {rows.map((r) => {
              const amount = amountOf(r);
              const lead = r.lead_investors[0] ?? null;
              return (
                <li
                  key={r.id}
                  className={cn(
                    "relative grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3 transition-colors hover:bg-black-alpha-4 sm:px-5 md:gap-x-4",
                    glimpseCols,
                  )}
                >
                  <span className="grid size-7 place-items-center">
                    <Logo r={r} size={28} />
                  </span>
                  <div className="min-w-0">
                    <Link
                      href={companyHref(r.company.id)}
                      className="block truncate text-label-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:underline"
                    >
                      {r.company.name}
                    </Link>
                    <p className="truncate text-body-small text-muted-foreground md:hidden">
                      {roundStageLabel(r)}
                      {lead && ` · ${lead}`}
                    </p>
                    <p className="hidden truncate text-body-small text-muted-foreground md:block">
                      {capitalizeFirst(r.company.description) ?? r.company.domain ?? r.stage_as_written}
                    </p>
                  </div>
                  {/* Phone: the amount over the verdict and the day, at the row's right edge. */}
                  <div className="flex flex-col items-end gap-0.5 md:hidden">
                    <span className="text-mono-small">{amount ?? <span className="text-black-alpha-32">n/a</span>}</span>
                    <span className="flex items-center gap-2">
                      <RoundCheckMark r={r} compact />
                      <span className="text-mono-x-small normal-case text-black-alpha-32">
                        <RelativeDay iso={r.announced_on} />
                      </span>
                    </span>
                  </div>
                  <span className="hidden min-w-0 md:block">
                    <span className="block truncate text-body-small text-black-alpha-72">{roundStageLabel(r)}</span>
                    <RoundCheckMark r={r} />
                  </span>
                  <span className="hidden text-right text-mono-small md:block">
                    {amount ?? <span className="text-black-alpha-32">n/a</span>}
                  </span>
                  <span className="hidden truncate text-body-small text-black-alpha-72 md:block">
                    {lead ?? <span className="text-black-alpha-32">not stated</span>}
                  </span>
                  <span className="hidden text-right text-mono-x-small normal-case text-black-alpha-32 md:block">
                    <RelativeDay iso={r.announced_on} />
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-between gap-3 border-t border-border-faint px-4 py-3 sm:px-5">
            <span className="text-body-small text-muted-foreground">
              The {rows.length} {trending ? "most discussed" : "newest"} of{" "}
              <span className="font-mono tabular-nums text-foreground">{grouped(s.records)}</span> rounds in the feed
            </span>
            <Link
              href={trending ? TRENDING_VIEW_HREF : "/feed"}
              className="tap relative inline-flex shrink-0 items-center gap-1 rounded-4 text-label-small text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Open the feed <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

/** The glimpse's frame at its loaded height while the rows stream in. */
export function LiveGlimpseSkeleton() {
  return (
    <div aria-hidden className="overflow-hidden rounded-16 border border-border-faint bg-card">
      <div className="h-11 border-b border-border-faint" />
      <div className="hidden h-9 border-b border-border-faint md:block" />
      <div className="divide-y divide-border-faint">
        {Array.from({ length: GLIMPSE_ROWS }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
          <div key={i} className="flex h-[65px] items-center gap-4 px-5">
            <span className="size-7 rounded-6 bg-black-alpha-4" />
            <span className="h-3 w-40 rounded-4 bg-black-alpha-4" />
          </div>
        ))}
      </div>
      <div className="h-12 border-t border-border-faint" />
    </div>
  );
}

function Counter({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="bg-background px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
      <div className="text-mono-x-small text-black-alpha-32">{label}</div>
      <div className="mt-3 font-mono text-[28px] leading-none font-medium tracking-[-0.02em] tabular-nums sm:text-[36px]">{value}</div>
      <div className="mt-2 text-body-small text-muted-foreground">{hint}</div>
    </div>
  );
}

const counterGrid = "grid grid-cols-2 gap-px bg-border-faint lg:grid-cols-4";

/**
 * The four live counters under the glimpse, in mono: the week, the money, the reading, the people.
 * "Verified" is the feed's own check mark, so the count matches what a reader counts there: a
 * Developing (flagged) row does not count. The articles are the pages behind those same rounds
 * (lib/landing.ts), so the card's figure and its hint describe one set.
 */
export async function Counters() {
  const s = await stats();
  return (
    <div className={counterGrid}>
      <Counter label="Rounds · 7d" value={grouped(s.rounds_7d)} hint="Reported in the last 7 days" />
      <Counter label="Capital · 7d" value={usd(s.usd_7d) || "$0"} hint="Across those rounds" />
      <Counter
        label="Articles read"
        value={grouped(s.articles)}
        hint={s.verified > 0 ? `Behind ${grouped(s.verified)} verified ${s.verified === 1 ? "round" : "rounds"}` : "No verified round yet"}
      />
      <Counter label="Investors" value={grouped(s.investors)} hint="Named on a round" />
    </div>
  );
}

export function CountersSkeleton() {
  return (
    <div aria-hidden className={counterGrid}>
      {["Rounds · 7d", "Capital · 7d", "Articles read", "Investors"].map((l) => (
        <Counter key={l} label={l} value=" " hint=" " />
      ))}
    </div>
  );
}

const ALEXANDRIA_POST = "https://www.firecrawl.dev/blog/introducing-alexandria-series-b";

/**
 * native web tools's own round, while it is fresh: the lit flame, the sentence the feed strip uses, and
 * Alexandria, which launched the same day and fills the company pages. Renders nothing once the
 * round is older than HOUSE_FRESH_DAYS or the treatment is off.
 */
export async function HouseMoment() {
  const r = await houseRound();
  if (!r) return null;
  const { lead, figure, rest, by } = houseHeadline({
    name: r.company.name,
    amount: reportedAmount(r) ?? "",
    stage: stageOf(r),
    leads: r.lead_investors,
  });
  return (
    <div className="relative grid gap-6 px-5 py-10 sm:px-8 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center lg:gap-8 lg:px-10">
      <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-heat-48 via-heat-12 to-transparent" />
      <FlameMark live size="inherit" className="size-10" />
      <div className="min-w-0 space-y-1.5">
        <p className="text-label-small text-muted-foreground">Today&apos;s feed includes the company it&apos;s built on.</p>
        <p className="text-[20px] leading-7 font-medium tracking-[-0.01em] sm:text-[22px] sm:leading-8">
          {lead}
          {figure && <span className="font-mono tabular-nums">{figure}</span>}
          {rest}
          {by}.
        </p>
        <p className="max-w-3xl text-body-medium text-muted-foreground">
          Alexandria launched alongside it: sourced facts like a company&apos;s Y Combinator batch, founding year, and headcount, read for
          every company Fireround has verified.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Link
          href={companyHref(r.company.id)}
          className="tap relative inline-flex items-center gap-1 rounded-4 text-label-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Open {r.company.name} <ArrowRight className="size-3.5" aria-hidden />
        </Link>
        <a
          href={ALEXANDRIA_POST}
          target="_blank"
          rel="noreferrer"
          className="tap relative inline-flex items-center gap-1 rounded-4 text-label-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Read the announcement <ArrowUpRight className="size-3.5" aria-hidden />
        </a>
      </div>
    </div>
  );
}

/** One column per card from lg (up to five), so a strip of two never leaves an empty cell. */
const STRIP_COLS: Record<number, string> = {
  1: "",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-2 lg:grid-cols-5",
};

const JUST_IN_ROWS = 5;

/**
 * "Just in": the newest rounds, below the hero's most discussed ones. Each shows its check and
 * source count, because a round found minutes ago often has one source and gains more as
 * corroboration reads further pages. Nothing when the store is empty, so the band hides.
 */
export async function JustIn() {
  const rounds = (await latest()).slice(0, JUST_IN_ROWS);
  if (rounds.length === 0) return null;
  return (
    <div>
      <div className={cn("flex flex-col gap-3 pt-10 pb-6 sm:flex-row sm:items-end sm:justify-between sm:gap-8", "px-5 sm:px-8 lg:px-10")}>
        <div className="max-w-2xl space-y-2">
          <h2 className="flex items-center gap-2.5 text-title-h5">
            <LiveDot />
            Just in
          </h2>
          <p className="text-body-medium text-muted-foreground">
            The newest rounds, as the hourly sweep finds them. A new round often starts with one source and gains more as native web tools
            reads the rest of the coverage.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2">
          <Link
            href="/feed?view=latest"
            className="tap relative inline-flex items-center gap-1 rounded-4 text-label-small text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            All the latest <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </div>
      </div>
      <ol className={cn("grid gap-px border-t border-border-faint bg-border-faint", STRIP_COLS[rounds.length] ?? STRIP_COLS[5])}>
        {rounds.map((r) => {
          const amount = amountOf(r);
          return (
            <li
              key={r.id}
              // Two columns from sm: an odd last card takes the row, so no empty cell shows the rule colour.
              className="relative flex flex-col gap-3 bg-background px-5 py-6 transition-colors hover:bg-black-alpha-4 sm:px-6 sm:[&:last-child:nth-child(odd)]:col-span-2 lg:[&:last-child:nth-child(odd)]:col-span-1"
            >
              <span className="grid size-7 place-items-center">
                <Logo r={r} size={28} />
              </span>
              <div className="min-w-0">
                <Link
                  href={companyHref(r.company.id)}
                  className="block truncate text-label-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:underline"
                >
                  {r.company.name}
                </Link>
                <p className="truncate text-body-small text-muted-foreground">
                  {roundStageLabel(r)}
                  {amount && (
                    <>
                      {" · "}
                      <span className="font-mono tabular-nums text-foreground">{amount}</span>
                    </>
                  )}
                </p>
              </div>
              <div className="mt-auto flex items-center justify-between gap-3">
                <RoundCheckMark r={r} compact />
                <span className="text-mono-x-small normal-case text-black-alpha-56">
                  <RelativeDay iso={r.announced_on} />
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const MCP_TOOLS: Array<[string, string]> = [
  ["list_rounds", "Recent rounds, filtered by stage, sector, amount, date, or watchlist"],
  ["search_rounds", "Free text over company names, descriptions, and investors"],
  ["get_company", "Every round on record for one company"],
  ["list_trending", "The most discussed rounds first seen in the last three days, with their counts"],
  ["list_companies", "Companies by search, sector, stage, or date, with what each raised"],
  ["get_company_profile", "One company's rounds, leads, announcements, and investors"],
  ["list_investors", "Investors by name, with the rounds each led and joined"],
  ["get_investor", "One investor's rounds, sectors, stages, and co-investors"],
  ["top_investors", "The most active leads over 7, 30, or 90 days, by sector or stage"],
  ["list_news", "The latest articles behind the rounds, with the rounds each reports"],
  ["mark_seen", "Take rounds out of the unread set"],
  ["list_presets", "The watchlists and their slugs"],
];

function PaneLabel({ children }: { children: React.ReactNode }) {
  return <div className="border-b border-border-faint px-5 py-2.5 text-mono-x-small text-black-alpha-32">{children}</div>;
}

/**
 * The API and MCP window: the request on the left, what comes back on the right. The response is
 * a real row from this store cut to a few fields (lib/landing.ts, apiPreview), so the example is
 * always true of the instance it is read on.
 */
export async function ApiExamples() {
  await live();
  const [o, pick] = await Promise.all([origin(), cachedSeriesAPick(5)]);
  const row = pick.rows[0] ?? (await latest())[0];
  // A week back, so the date example returns rows on any instance that swept this week.
  const curl = apiExample(o, new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  const mcp = mcpConfig(o);
  // A keyless public demo serves no write (lib/access.ts mcpTrusted), so the list names what this instance answers.
  const tools = MCP_TOOLS.filter(([name]) => name !== "mark_seen" || mcpTrusted());
  const response = compactJson(row ? apiPreview(row, pick.rows[0] ? pick.nextCursor : null) : { data: [], next_cursor: null }, 72);
  const split = "grid xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:divide-x divide-border-faint";
  const tabs: CodeTab[] = [
    {
      id: "curl",
      label: "cURL",
      copy: curl,
      panel: (
        <div className={split}>
          <div className="min-w-0">
            <PaneLabel>Request</PaneLabel>
            <CodeLines code={curl} lang="shell" />
            <p className="border-t border-border-faint px-5 py-4 text-body-small text-muted-foreground xl:border-t-0 xl:pt-0">
              JSON, CSV, or JSONL with <code className="font-mono text-[12px] text-foreground">format=</code>, cursor pagination, and the
              filters the feed has: stage, sector, amount, date, watchlist, free text.
            </p>
          </div>
          <div className="min-w-0 border-t border-border-faint xl:border-t-0">
            <PaneLabel>Response · trimmed from a live row</PaneLabel>
            <CodeLines code={response} lang="json" label="Example response" />
          </div>
        </div>
      ),
    },
    {
      id: "mcp",
      label: "MCP",
      copy: mcp,
      panel: (
        <div className={split}>
          <div className="min-w-0">
            <PaneLabel>Client config</PaneLabel>
            <CodeLines code={mcp} lang="json" label="MCP client config" />
          </div>
          <div className="min-w-0 border-t border-border-faint xl:border-t-0">
            <PaneLabel>{tools.length} tools</PaneLabel>
            <ul className="divide-y divide-border-faint">
              {tools.map(([name, what]) => (
                <li key={name} className="grid gap-1 px-5 py-3 sm:grid-cols-[168px_minmax(0,1fr)] sm:gap-4">
                  <code className="font-mono text-[13px] text-foreground">{name}</code>
                  <span className="text-body-small text-muted-foreground">{what}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ),
    },
  ];
  return <CodeTabs tabs={tabs} />;
}

export function ApiExamplesSkeleton() {
  return <div aria-hidden className="h-[420px] rounded-12 border border-border-faint bg-card" />;
}

/** The closing line's figure: this week's count, or a plain sentence on an empty week. */
export async function WeekLine() {
  const s = await stats();
  if (s.rounds_7d === 0) return <>Every round links to the articles that reported it.</>;
  return (
    <>
      <span className="font-mono tabular-nums text-foreground">{grouped(s.rounds_7d)}</span> {s.rounds_7d === 1 ? "round" : "rounds"} in the
      last 7 days, each linked to the articles that reported it.
    </>
  );
}

/**
 * The delivery section's Slack message: the payload delivery.ts would post for the house round
 * while it is fresh, else for the newest published round. An empty store draws no message.
 */
export async function LiveSlackPreview() {
  const [house, rows, o] = await Promise.all([houseRound(), latest(), origin()]);
  const r = house ?? rows[0];
  if (!r) {
    return (
      <div className="rounded-12 border border-border-faint bg-card px-5 py-14 text-center">
        <p className="text-label-medium">No rounds yet.</p>
        <p className="mt-1 text-body-small text-muted-foreground">
          The first round the first sweep finds posts here as it would to a channel.
        </p>
      </div>
    );
  }
  return <SlackPreview message={slackBlocks(r, o)} sentAt={r.first_seen_at} />;
}
