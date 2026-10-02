// The Overview's operator half: the review queue, unread rounds, credits, and runs. The page renders
// it only for a viewer who sees review rows (lib/access.ts seesReview): an admin, or anyone on a
// private instance. A demo visitor never gets these components, nor the reads behind them.

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { actionLink, faint, muted, plural, RoundLine, when } from "@/components/overview/market";
import { RelativeDay } from "@/components/relative-day";
import { Panel, Stat } from "@/components/ui/stat";
import { compact, relativeTime, roundStageLabel, usd } from "@/lib/format";
import type { RoundRow } from "@/lib/persist";
import { type Overview, runLaneLabel } from "@/lib/stats";
import { capitalizeFirst } from "@/lib/text";
import { cn } from "@/lib/utils";

/** Marks what a demo visitor does not see, so an admin knows which parts of the page are theirs alone. */
function AdminHeading() {
  return (
    <div className="flex items-center gap-3">
      <h2 className="text-label-small">This instance</h2>
      <span className="h-px flex-1 bg-border-faint" />
      <span className="text-label-x-small text-muted-foreground">Admins only</span>
    </div>
  );
}

/** The operator's figures: the review queue, unread rounds, credits, and the latest run. Never rendered for a demo visitor. */
export function AdminStats({ o, demo }: { o: Overview; demo: boolean }) {
  const last = o.recent_runs[0];
  const lane = last ? runLaneLabel(last.lane, last.window, last.preset, last.started_at) : null;
  return (
    <section aria-label="This instance" className="space-y-3">
      {demo && <AdminHeading />}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="NEEDS REVIEW"
          value={o.review_count}
          href={o.review_count ? "/review" : undefined}
          hint={
            o.review_count ? (
              <Link href="/review" className="hover:underline">
                {o.review_filings
                  ? `${o.review_count - o.review_filings} news, ${o.review_filings} ${o.review_filings === 1 ? "filing" : "filings"}`
                  : "Open the queue"}
              </Link>
            ) : (
              "Queue is clear"
            )
          }
          accent={o.review_count > 0}
        />
        <Stat label="UNREAD · 30D" value={o.new_rounds} href="/feed?view=latest&status=new" hint={`of ${plural(o.rounds, "round")}`} />
        <Stat
          label="CREDITS · 30D"
          value={compact(o.credits_30d)}
          href="/runs"
          hint={last ? `Last run ${relativeTime(last.started_at)}` : "No runs yet"}
        />
        <Stat
          label="LAST RUN"
          value={lane ? lane.name : "None"}
          href={last ? "/runs" : undefined}
          hint={last ? (last.finished_at === null ? "Running now" : plural(last.records ?? 0, "record")) : "Run a sweep from Presets"}
        />
      </div>
      {process.env.NODE_ENV === "production" && !process.env.CRON_SECRET && (
        <p className="text-body-small text-crimson-ink">
          <Link href="/settings" className="underline">
            Scheduled sweeps are off: set CRON_SECRET.
          </Link>
        </p>
      )}
    </section>
  );
}

/** The operator's lists: the newest rounds with their unread dots, and the latest runs with their credits. */
export function AdminPanels({ o, latest, feedHref, demo }: { o: Overview; latest: RoundRow[]; feedHref: string; demo: boolean }) {
  return (
    <section aria-label="This instance: rounds and runs" className="space-y-3">
      {demo && <AdminHeading />}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          title="Latest rounds"
          code="FEED"
          className="lg:col-span-2"
          action={
            <Link href={feedHref} className={actionLink}>
              All rounds <ArrowUpRight className="size-3.5" />
            </Link>
          }
        >
          {latest.length === 0 ? (
            <p className="text-body-small text-muted-foreground">
              No rounds yet. Run <code className="rounded-4 bg-muted px-1.5 py-0.5 font-mono text-[12px]">pnpm sweep</code> or create a
              monitor under Presets.
            </p>
          ) : (
            <ul className="divide-y divide-border-faint">
              {latest.map((r) => (
                <RoundLine
                  key={r.id}
                  r={r}
                  detail={
                    <>
                      {r.status === "new" && (
                        <span role="img" className="mr-1.5 inline-block size-1.5 rounded-full bg-heat-100 align-middle" aria-label="new" />
                      )}
                      {capitalizeFirst(r.company.description) ?? r.company.domain ?? r.stage_as_written}
                    </>
                  }
                  figure={
                    <div className="flex shrink-0 flex-col items-end gap-0.5 sm:flex-row sm:items-center sm:gap-4">
                      <div className={cn("hidden w-20 shrink-0 truncate text-body-small xl:block", muted)}>{roundStageLabel(r)}</div>
                      <div className="max-w-24 truncate text-right text-mono-small sm:w-16">
                        {usd(r.amount.usd_millions) || r.amount.as_written || <span className={faint}>n/a</span>}
                      </div>
                      <div className={cn("whitespace-nowrap text-right sm:w-16", when)}>
                        <RelativeDay iso={r.announced_on} />
                      </div>
                    </div>
                  }
                />
              ))}
            </ul>
          )}
        </Panel>
        <Panel
          title="Recent runs"
          code="CREDITS"
          action={
            <Link href="/runs" className={actionLink}>
              All runs <ArrowUpRight className="size-3.5" />
            </Link>
          }
        >
          {o.recent_runs.length === 0 ? (
            <p className="text-body-small text-muted-foreground">No runs yet.</p>
          ) : (
            <ul className="divide-y divide-border-faint">
              {o.recent_runs.map((r) => {
                const lane = runLaneLabel(r.lane, r.window, r.preset, r.started_at);
                return (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <div className="truncate text-label-small">
                        {lane.name}
                        {lane.qualifier && <span className={muted}> · {lane.qualifier}</span>}
                      </div>
                      <div className={cn("truncate", when)}>{relativeTime(r.started_at)}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      {/* A run in flight has no measurement yet; its estimate waits in the Est. column on /runs. */}
                      <div className="text-mono-small">
                        {r.finished_at === null ? "running" : `${r.credits_measured ?? r.credits_estimated ?? "?"} cr`}
                      </div>
                      <div className={cn("text-mono-x-small normal-case", muted)}>{plural(r.records ?? 0, "record")}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </section>
  );
}
