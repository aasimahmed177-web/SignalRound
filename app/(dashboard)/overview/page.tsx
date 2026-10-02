import { connection } from "next/server";
import { Suspense } from "react";
import { FirstRun } from "@/components/first-run";
import { AdminPanels, AdminStats } from "@/components/overview/admin";
import { MarketNote, MarketPanels } from "@/components/overview/market";
import { PresetSwitcher } from "@/components/preset-switcher";
import { PageBody } from "@/components/shell/page-body";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { BarListSkeleton, ListSkeleton, PanelSkeleton, PresetChipsSkeleton, StatRowSkeleton } from "@/components/ui/skeletons";
import { OVERVIEW_PATH, seesReview, viewer } from "@/lib/access";
import { cachedMarket, cachedPresets, cachedTrendingOn } from "@/lib/cached";
import { db } from "@/lib/db";
import { firstRunProps, storeIsEmpty } from "@/lib/first-run";
import { listRounds, type RoundRow } from "@/lib/persist";
import { PRESET_PARAM } from "@/lib/preset-param";
import { presetOptions } from "@/lib/presets";
import { shareMetadata } from "@/lib/share";
import { type Overview, overview } from "@/lib/stats";

type Search = Record<string, string | string[] | undefined>;

interface AdminData {
  o: Overview;
  latest: RoundRow[];
}

function one(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

async function AdminStatsBlock({ ops, demo }: { ops: Promise<AdminData>; demo: boolean }) {
  return <AdminStats o={(await ops).o} demo={demo} />;
}

async function AdminPanelsBlock({ ops, feedHref, demo }: { ops: Promise<AdminData>; feedHref: string; demo: boolean }) {
  const { o, latest } = await ops;
  return <AdminPanels o={o} latest={latest} feedHref={feedHref} demo={demo} />;
}

async function OverviewBody({ searchParams }: { searchParams: Promise<Search> }) {
  await connection();
  const [search, presets, v] = await Promise.all([searchParams, cachedPresets(), viewer()]);
  // The `preset` param narrows every panel; a slug no preset matches reads as all, so the cached
  // read below is keyed on a known slug or on nothing.
  const wanted = one(search[PRESET_PARAM]);
  const preset = presets.some((p) => p.slug === wanted) ? wanted : "";
  // The operator (an admin, or anyone on a private instance) also sees the review queue, the runs,
  // and the credits; a demo visitor gets the market alone, and none of those reads run for them.
  let ops: Promise<AdminData> | null = null;
  if (seesReview(v)) {
    const handle = await db();
    // A store with no rounds at all shows what a sweep does and the button that runs it, not a page of zeros.
    if (await storeIsEmpty(handle)) {
      return (
        <PageBody>
          <FirstRun {...(await firstRunProps())} />
        </PageBody>
      );
    }
    // Started here and awaited by the two admin blocks behind their own Suspense, so the cached
    // market view never waits on these fresh reads.
    ops = Promise.all([
      overview(handle, 30, preset || undefined),
      listRounds(handle, { limit: 6, preset: preset || undefined, history: "exclude" }),
    ]).then(([o, latest]) => ({ o, latest: latest.rows }));
  }
  const [view, laneOn] = await Promise.all([cachedMarket(preset), cachedTrendingOn()]);
  const feedHref = preset ? `/feed?${new URLSearchParams({ [PRESET_PARAM]: preset })}` : "/feed";

  return (
    <PageBody>
      <PresetSwitcher presets={presetOptions(presets)} />
      {ops && (
        <Suspense fallback={<StatRowSkeleton />}>
          <AdminStatsBlock ops={ops} demo={v.demo} />
        </Suspense>
      )}
      <MarketPanels view={view} preset={preset} laneOn={laneOn} />
      {ops && (
        <Suspense
          fallback={
            <div className="grid gap-4 lg:grid-cols-3">
              <PanelSkeleton title="Latest rounds" className="lg:col-span-2">
                <ListSkeleton trailing={["w-12", "w-10"]} />
              </PanelSkeleton>
              <PanelSkeleton title="Recent runs">
                <ListSkeleton logo={false} />
              </PanelSkeleton>
            </div>
          }
        >
          <AdminPanelsBlock ops={ops} feedHref={feedHref} demo={v.demo} />
        </Suspense>
      )}
      <MarketNote />
    </PageBody>
  );
}

/** Twelve bar heights for the loading chart: a plausible run of weeks, not a flat wall. */
const CHART_BONES = [34, 18, 22, 26, 20, 30, 16, 52, 70, 28, 82, 44].map((h, i) => ({ key: `w${i}`, h }));

/** The overview's own shape while it loads: chips, stats, the chart and stage panels, the two round lists, then the three bar lists. */
function OverviewSkeleton() {
  return (
    <PageBody>
      <PresetChipsSkeleton />
      <StatRowSkeleton />
      <div className="grid gap-4 lg:grid-cols-3">
        <PanelSkeleton title="Rounds by week" className="lg:col-span-2">
          <div className="grid h-36 grid-cols-12 items-end gap-2 border-b border-border-faint lg:h-60">
            {CHART_BONES.map((b) => (
              <div key={b.key} className="flex h-full justify-center">
                <Skeleton className="mt-auto w-full max-w-8 rounded-none rounded-t-4" style={{ height: `${b.h}%` }} />
              </div>
            ))}
          </div>
          <div className="h-6" />
        </PanelSkeleton>
        <PanelSkeleton title="By stage">
          <BarListSkeleton rows={7} />
        </PanelSkeleton>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <PanelSkeleton title="Biggest rounds" className="lg:col-span-2">
          <ListSkeleton rows={5} trailing={["w-12", "w-10"]} />
        </PanelSkeleton>
        <PanelSkeleton title="Trending">
          <ListSkeleton rows={5} />
        </PanelSkeleton>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <PanelSkeleton title="Most active leads">
          <BarListSkeleton rows={6} />
        </PanelSkeleton>
        <PanelSkeleton title="Sectors">
          <BarListSkeleton rows={6} />
        </PanelSkeleton>
        <PanelSkeleton title="Top publishers">
          <BarListSkeleton rows={6} />
        </PanelSkeleton>
      </div>
    </PageBody>
  );
}

export const metadata = {
  title: "Overview",
  alternates: { canonical: OVERVIEW_PATH },
  ...shareMetadata({
    title: "The funding market this week",
    description:
      "Capital and rounds this week against last week, the biggest rounds, rounds by week, the stage and sector mix, the most active lead investors, and what is trending, from the funding rounds Fireround found on the open web and checked against their sources.",
    image: "root",
  }),
};

export default function OverviewPage({ searchParams }: PageProps<"/overview">) {
  return (
    <>
      <PageHeader section={0} />
      <Suspense fallback={<OverviewSkeleton />}>
        <OverviewBody searchParams={searchParams as Promise<Search>} />
      </Suspense>
    </>
  );
}
