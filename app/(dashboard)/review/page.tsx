import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AccuracyList } from "@/components/review/accuracy-list";
import { AddUrl } from "@/components/review/add-url";
import { ReviewList } from "@/components/review/review-list";
import { PageBody } from "@/components/shell/page-body";
import { PageHeader } from "@/components/shell/page-header";
import { CardListSkeleton, PillSkeleton } from "@/components/ui/skeletons";
import { Panel } from "@/components/ui/stat";
import { type AccuracyView, listAccuracy, openAccuracyCount } from "@/lib/accuracy";
import { db } from "@/lib/db";
import { relativeDay } from "@/lib/format";
import { listRounds } from "@/lib/persist";
import { listPresets } from "@/lib/presets";
import { cn } from "@/lib/utils";

/** The Research action runs one agent call inline; give it room on serverless hosts. */
export const maxDuration = 300;

const FORM_D = "form-d";
type Kind = "news" | "filings" | "all" | "accuracy";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function kindOf(value: string | string[] | undefined): Kind {
  const v = first(value);
  return v === "filings" || v === "all" || v === "accuracy" ? v : "news";
}

function viewOf(value: string | string[] | undefined): AccuracyView {
  const v = first(value);
  return v === "dismissed" || v === "cleared" ? v : "open";
}

const CHIP = "inline-flex h-8 items-center gap-2 rounded-full px-3 text-label-small transition-colors";
const CHIP_ON = "bg-foreground text-background";
const CHIP_OFF =
  "bg-black-alpha-4 text-black-alpha-56 hover:bg-black-alpha-8 hover:text-foreground dark:bg-white/6 dark:text-muted-foreground dark:hover:bg-white/10";

/**
 * Four reads of the queue: what the press reported, what was filed with the SEC, both, and the daily
 * accuracy check's flags on the companies a reader is most likely to look up.
 */
function KindChips({ kind, counts }: { kind: Kind; counts: Record<Kind, number> }) {
  const chips: Array<{ id: Kind; label: string }> = [
    { id: "news", label: "News" },
    { id: "filings", label: "Filings" },
    { id: "all", label: "All" },
    { id: "accuracy", label: "Accuracy" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <Link
          key={c.id}
          href={c.id === "news" ? "/review" : `/review?kind=${c.id}`}
          aria-current={c.id === kind ? "page" : undefined}
          className={cn(CHIP, c.id === kind ? CHIP_ON : CHIP_OFF)}
        >
          {c.label}
          <span className={cn("text-mono-x-small", c.id === kind ? "text-background/70" : "text-muted-foreground")}>{counts[c.id]}</span>
        </Link>
      ))}
    </div>
  );
}

/** Open flags by default; the dismissed ones with their notes, and what cleared on its own this week. */
function ViewLinks({ view, counts }: { view: AccuracyView; counts: Record<AccuracyView, number> }) {
  const views: Array<{ id: AccuracyView; label: string }> = [
    { id: "open", label: "Open" },
    { id: "dismissed", label: "Dismissed" },
    { id: "cleared", label: "Cleared this week" },
  ];
  return (
    <nav aria-label="Accuracy flags" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body-small">
      {views.map((v) => (
        <Link
          key={v.id}
          href={v.id === "open" ? "/review?kind=accuracy" : `/review?kind=accuracy&view=${v.id}`}
          aria-current={v.id === view ? "page" : undefined}
          className={cn(
            "underline-offset-4 hover:underline",
            v.id === view ? "text-foreground underline" : "text-black-alpha-56 dark:text-muted-foreground",
          )}
        >
          {v.label} <span className="text-mono-x-small">{counts[v.id]}</span>
        </Link>
      ))}
    </nav>
  );
}

/** The last run in one line: when, how many companies, what changed. */
function lastRunLine(run: { started_at: string; counts: Record<string, number> | null } | null): string {
  if (!run)
    return "The check has not run yet. It runs daily at 05:00 UTC and reads the companies with the largest rounds and the most raised.";
  const c = run.counts ?? {};
  const bits = [`${c.companies_checked ?? 0} companies read`, `${c.flags_new ?? 0} new`, `${c.flags_cleared ?? 0} cleared`];
  const fixes = (c.remedies_profile ?? 0) + (c.remedies_dossier ?? 0) + (c.remedies_history ?? 0);
  if (fixes > 0) bits.push(`${fixes} automatic ${fixes === 1 ? "fix" : "fixes"} started`);
  return `Last check ${relativeDay(run.started_at, { utc: true })}: ${bits.join(", ")}.`;
}

async function ReviewBody({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const sp = await searchParams;
  const kind = kindOf(sp.kind);
  const handle = await db();
  const [news, filings, presets, accuracyOpen] = await Promise.all([
    listRounds(handle, { reviewOnly: true, excludePreset: FORM_D, limit: 100 }),
    listRounds(handle, { reviewOnly: true, preset: FORM_D, limit: 100 }),
    listPresets(handle),
    openAccuracyCount(handle),
  ]);
  const counts = {
    news: news.rows.length,
    filings: filings.rows.length,
    all: news.rows.length + filings.rows.length,
    accuracy: accuracyOpen,
  };
  if (kind === "accuracy") {
    const view = viewOf(sp.view);
    const accuracy = await listAccuracy(handle, view);
    return (
      <PageBody width="narrow">
        <KindChips kind={kind} counts={counts} />
        <div className="space-y-2">
          <p className="text-body-small text-black-alpha-56 dark:text-muted-foreground">
            {lastRunLine(accuracy.lastRun)} A flag clears on its own once its condition no longer holds; dismiss one with a note when it is
            right as it is.
          </p>
          <ViewLinks view={view} counts={accuracy.counts} />
        </div>
        <AccuracyList companies={accuracy.companies} view={view} />
      </PageBody>
    );
  }
  const rows = kind === "news" ? news.rows : kind === "filings" ? filings.rows : [...news.rows, ...filings.rows];
  return (
    <PageBody width="narrow">
      <KindChips kind={kind} counts={counts} />
      {kind === "filings" && (
        <p className="text-body-small text-black-alpha-56 dark:text-muted-foreground">
          Form D filings prove a sale of securities, not a venture round. Publish the operating companies; reject the vehicles the filter
          let through.
        </p>
      )}
      <ReviewList rows={rows} />
      {/* The queue is the page's job; pasting in an article the sweep missed is the occasional extra, so it sits after. */}
      <Panel title="Add a URL" code="MANUAL">
        <AddUrl presets={presets.map((p) => ({ slug: p.slug, name: p.name }))} />
      </Panel>
    </PageBody>
  );
}

export const metadata = { title: "Review" };

export default function ReviewPage({ searchParams }: PageProps<"/review">) {
  return (
    <>
      <PageHeader section={5} description="Undated or low-confidence records. Every decision is data the next run reads." />
      <Suspense
        fallback={
          <PageBody width="narrow">
            <div className="flex gap-1.5" aria-hidden>
              <PillSkeleton className="w-20" />
              <PillSkeleton className="w-20" />
              <PillSkeleton className="w-16" />
            </div>
            <CardListSkeleton rows={3} />
          </PageBody>
        }
      >
        <ReviewBody searchParams={searchParams as Promise<Record<string, string | string[] | undefined>>} />
      </Suspense>
    </>
  );
}
