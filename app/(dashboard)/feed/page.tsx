import type { Stage } from "@fireround/core";
import { STAGES } from "@fireround/core";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { DataNotice } from "@/components/feed/data-notice";
import { DemoHero } from "@/components/feed/demo-hero";
import { ExportLinks } from "@/components/feed/export-links";
import { FeedFilters } from "@/components/feed/filters";
import { HouseBanner } from "@/components/feed/house-banner";
import { Pager } from "@/components/feed/pager";
import { RoundsTable } from "@/components/feed/rounds-table";
import { FirstRun } from "@/components/first-run";
import { PageBody } from "@/components/shell/page-body";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { PillSkeleton, TableSkeleton } from "@/components/ui/skeletons";
import { isLanding, isPublicDemo, seesReview, viewer } from "@/lib/access";
import { trackClick } from "@/lib/analytics";
import { cachedDemoStats, cachedFeedPage, cachedPresets, cachedSectors, cachedTrendingOn } from "@/lib/cached";
import { db } from "@/lib/db";
import { feedCertainty } from "@/lib/feed-certainty";
import { type FeedPageQuery, readFeedPage } from "@/lib/feed-page";
import { firstRunProps } from "@/lib/first-run";
import { feedScope, feedTitle } from "@/lib/format";
import { houseDomain, isFreshHouseRound } from "@/lib/house";
import { parsePage } from "@/lib/pages";
import { feedHistory, publicRoundQuery, toFeedRow } from "@/lib/persist";
import { PRESET_PARAM } from "@/lib/preset-param";
import { presetOptions } from "@/lib/presets";
import { defaultFeedView, FEED_VIEW_PANEL, type FeedNarrowing, isNarrowed, toFeedSort, toFeedView, viewTabId } from "@/lib/round-sort";
import { shareMetadata } from "@/lib/share";
import { TRENDING_EXPLAINER } from "@/lib/trending";

const FEED_PAGE_SIZE = 20;

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/** A real YYYY-MM-DD day, or undefined: a hand-typed date never narrows the feed to nothing by accident. */
function isoDay(v: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? undefined : v;
}

/**
 * The feed URL for a page: every filter and the sort carry over, page one drops the param. A
 * `cursor` from before numbered pages is left behind, so an old link lands on page one.
 */
function feedHref(search: Search, page: number): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) {
    const value = one(v);
    if (k !== "cursor" && k !== "page" && value) qs.set(k, value);
  }
  if (page > 1) qs.set("page", String(page));
  const s = qs.toString();
  return s ? `/feed?${s}` : "/feed";
}

/** The search without the filters feedScope names, for its way out. */
function withoutScope(search: Search): Search {
  const { since: _since, until: _until, source: _source, history: _history, ...rest } = search;
  return rest;
}

/** The URL's narrowing params, raw, as the filters bar reads them too, so server and client pick the same default view. */
function narrowingOf(search: Search): FeedNarrowing {
  return {
    q: one(search.q),
    stage: one(search.stage),
    sector: one(search.sector),
    min: one(search.min),
    preset: one(search[PRESET_PARAM]),
    since: one(search.since),
    until: one(search.until),
    source: one(search.source),
    certainty: one(search.certainty),
  };
}

/** The demo feed's H1, said from the view and filters in the URL (lib/format.ts feedTitle). */
async function FeedTitle({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const narrowing = narrowingOf(search);
  const view = toFeedView(one(search.view), one(search.sort), defaultFeedView(await cachedTrendingOn(), narrowing));
  const stages = one(search.stage)
    .split(",")
    .filter((s) => (STAGES as readonly string[]).includes(s));
  const { q: _q, stage: _stage, ...rest } = narrowing;
  return <>{feedTitle({ view, q: narrowing.q, stages, filtered: isNarrowed(rest) })}</>;
}

async function FeedBody({ searchParams }: { searchParams: Promise<Search> }) {
  await connection();
  const search = await searchParams;
  const stages = one(search.stage)
    .split(",")
    .filter((s): s is Stage => (STAGES as readonly string[]).includes(s));
  const status = one(search.status);
  const min = Number(one(search.min));
  const preset = one(search[PRESET_PARAM]);
  // `since` and `until` (YYYY-MM-DD) are the reader's own date range, from a link or the URL bar.
  const since = isoDay(one(search.since));
  const until = isoDay(one(search.until));
  // A publisher host, from an Overview link; lowercased like the stored hosts.
  const source = one(search.source).trim().toLowerCase() || undefined;
  const filters: FeedPageQuery["filters"] = publicRoundQuery({
    q: one(search.q) || undefined,
    stages: stages.length ? stages : undefined,
    status: status === "new" ? ["new", "updated"] : undefined,
    sector: one(search.sector) || undefined,
    preset: preset || undefined,
    minUsdMillions: Number.isFinite(min) && min > 0 ? min : undefined,
    since,
    until,
    source,
    certainty: feedCertainty(one(search.certainty)),
    // Latest lists what the lanes caught; an earlier round promoted from a dossier joins only a date
    // range, unless the link says history=exclude (the Overview's figures count news rounds only).
    history: one(search.history) === "exclude" ? "exclude" : feedHistory({ since, until }),
  });
  const scope = feedScope({ since, until, source });
  // A bare /feed opens Trending where this instance runs the lane (Latest where it would be empty);
  // a search, filter, or date range opens Latest, since Trending ranks only three days (lib/round-sort.ts).
  // `view` or a Latest order in the URL wins, and `sort=trending` still opens Trending as it did before the switch.
  const trendingOn = await cachedTrendingOn();
  const fallbackView = defaultFeedView(trendingOn, narrowingOf(search));
  const view = toFeedView(one(search.view), one(search.sort), fallbackView);
  const sort = view === "trending" ? "trending" : toFeedSort(one(search.sort));
  const query = { filters, sort, page: parsePage(one(search.page)), size: FEED_PAGE_SIZE };
  // A visitor's page is one shared cache entry a minute (lib/cached.ts); an admin reads it fresh.
  const v = await viewer();
  const [data, sectors, presets] = await Promise.all([
    seesReview(v) ? readFeedPage(await db(), query) : cachedFeedPage(query),
    // The sector menu and the demo hero are the same for every visitor: cached (lib/cached.ts).
    cachedSectors(),
    cachedPresets(),
  ]);
  const { rows, total, page, count, empty, buzz } = data;
  const house = houseDomain();
  // The entry may be a minute old, so the house round's freshness is judged again against the clock.
  const houseRound = house && data.houseRound && isFreshHouseRound(data.houseRound, new Date(), house) ? data.houseRound : null;
  // The demo visitor: read-only rows, no seen state, the sweep button stays with the admin tier.
  const readOnly = v.demo && !v.admin;
  if (empty) {
    return (
      <PageBody>
        <FirstRun {...(await firstRunProps())} readOnly={readOnly} />
      </PageBody>
    );
  }
  const options = presetOptions(presets);
  return (
    <PageBody className="space-y-4 py-4 sm:space-y-6 sm:py-6">
      {/* The demo's front door; the proxy rewrites `/` here, so the hero only shows in demo mode. */}
      {/* The house strip rides inside the hero in demo mode, so the page carries one card up top, not two. */}
      {v.demo ? (
        <DemoHero
          stats={await cachedDemoStats()}
          preset={preset}
          house={houseRound ? <HouseBanner r={toFeedRow(houseRound)} embedded /> : undefined}
        />
      ) : (
        houseRound && <HouseBanner r={toFeedRow(houseRound)} />
      )}
      <FeedFilters sectors={sectors} presets={options} readOnly={readOnly} trendingOn={trendingOn} />
      {/* The date range and the publisher have no control of their own, so the page says them and offers the way out. */}
      {scope && (
        <p className="text-body-small text-muted-foreground">
          {scope}{" "}
          <Link href={feedHref(withoutScope(search), 1)} className="text-foreground underline underline-offset-2">
            Clear
          </Link>
        </p>
      )}
      {/* The switch's panel: what the view shows. Trending opens with the line that says how it ranks. */}
      <div role="tabpanel" id={FEED_VIEW_PANEL} aria-labelledby={viewTabId(view)} className="space-y-4 sm:space-y-6">
        {view === "trending" && <p className="max-w-3xl text-body-small text-muted-foreground">{TRENDING_EXPLAINER}</p>}
        {view === "trending" && rows.length === 0 ? (
          <div className="rounded-12 border border-dashed border-border-muted p-12 text-center text-body-small text-muted-foreground">
            Nothing first seen in the last three days has been discussed enough to rank yet
            {isNarrowed(narrowingOf(search)) ? " under these filters" : ""}. The list fills in as each new round is searched on X.{" "}
            <Link href={feedHref({ ...search, view: "latest" }, 1)} className="text-foreground underline underline-offset-2">
              Search all rounds instead
            </Link>
          </div>
        ) : (
          <RoundsTable
            rows={rows.map(toFeedRow)}
            presets={preset ? [] : options}
            readOnly={readOnly}
            total={total}
            house={house}
            view={view}
            buzz={buzz.marks}
            scale={buzz.scale}
          />
        )}
        <Pager page={page} count={count} total={total} size={FEED_PAGE_SIZE} hrefFor={(n) => feedHref(search, n)} />
      </div>
      {/* The public demo says what the rows are; a visitor has no Report button, so the line links to the issues. */}
      {v.demo && <DataNotice report={readOnly} className="pt-2 text-center sm:text-left" />}
    </PageBody>
  );
}

/** Stage chips at the real labels' widths: All stages, then Pre-seed through Growth. */
const STAGE_CHIPS = ["w-24", "w-20", "w-14", "w-20", "w-20", "w-20", "w-22", "w-18"].map((w, i) => ({ key: `s${i}`, w }));

/**
 * The feed's shape while it loads: the Latest | Trending switch (under the search box on a phone),
 * the filter row (a Filters button on a phone), the stage ladder, then the table, or cards below
 * md, at the real row heights.
 */
function FeedSkeleton() {
  return (
    <PageBody className="space-y-4 py-4 sm:space-y-6 sm:py-6">
      <div className="flex flex-col gap-3">
        <div className="order-2 flex items-center md:order-1">
          <PillSkeleton className="h-9 w-full md:w-52" />
        </div>
        <div className="order-1 flex items-center gap-2 md:order-2">
          <PillSkeleton className="w-auto min-w-0 flex-1 md:w-72 md:flex-none" />
          <PillSkeleton className="md:hidden" />
          <div className="hidden items-center gap-2 md:flex">
            <PillSkeleton className="w-28" />
            <PillSkeleton className="w-32" />
            <PillSkeleton className="w-28" />
          </div>
        </div>
        <div className="order-3 flex gap-2 overflow-hidden">
          {STAGE_CHIPS.map((c) => (
            <PillSkeleton key={c.key} className={c.w} />
          ))}
        </div>
      </div>
      <TableSkeleton rows={10} indent cardMeta={2} cols={["w-28", "w-20 text-right", "hidden w-40 xl:block", "w-28", "w-28"]} />
    </PageBody>
  );
}

// In demo mode the feed is the front door, so it wears the product's name outright (the root
// template would otherwise append " · Fireround" to it). With LANDING=1 the landing page is the
// front door and wears the name; the feed goes back to being the Feed.
const FRONT_DOOR = isPublicDemo() && !isLanding();
export const metadata = {
  title: FRONT_DOOR ? { absolute: "Fireround" } : "Feed",
  ...shareMetadata({
    title: FRONT_DOOR ? "Fireround" : "Funding feed",
    description:
      "Funding announcements from across the open web, pre-seed to growth: found with Firecrawl search, extracted to a schema, and linked to the articles that reported it.",
    image: "root",
    canonical: "/feed",
  }),
};

export default function FeedPage({ searchParams }: PageProps<"/feed">) {
  const demo = isPublicDemo();
  return (
    <>
      <PageHeader
        section={1}
        title={
          demo ? (
            <Suspense fallback="Funding rounds">
              <FeedTitle searchParams={searchParams as Promise<Search>} />
            </Suspense>
          ) : undefined
        }
        description={
          demo
            ? "Every row was found by Firecrawl search and extracted with a schema, with the articles behind it one click away. A check mark means its sources confirmed it."
            : undefined
        }
        actions={
          <>
            <Suspense fallback={null}>
              <ExportLinks />
            </Suspense>
            {demo && (
              <Button asChild variant="outline" size="sm">
                <a
                  href="https://github.com/firecrawl/fireround#deploy"
                  target="_blank"
                  rel="noreferrer"
                  {...trackClick("fireround_deploy_clicked", { location: "feed_header" })}
                >
                  Deploy your own <ArrowUpRight className="size-3.5" />
                </a>
              </Button>
            )}
          </>
        }
      />
      <Suspense fallback={<FeedSkeleton />}>
        <FeedBody searchParams={searchParams as Promise<Search>} />
      </Suspense>
    </>
  );
}
