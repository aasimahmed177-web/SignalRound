// The Overview's public half: every panel a visitor sees. It reads only the market view
// (lib/stats.ts marketView), which counts the rounds the feed publishes; nothing here knows about
// the review queue, runs, or credits, so a visitor's page cannot show them.

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { CompanyLogo } from "@/components/company-logo";
import { RelativeDay } from "@/components/relative-day";
import { BarList, Panel, Stat } from "@/components/ui/stat";
import { hostLabel, roundStageLabel, sectorLabel, shortDay, stageLabel, usd } from "@/lib/format";
import { companyHref, investorHref } from "@/lib/links";
import type { RoundRow } from "@/lib/persist";
import { comparable, type Market, type MarketTotals, type MarketView, marketFeedHref, versusParts, weekLabel } from "@/lib/stats";
import { capitalizeFirst } from "@/lib/text";
import { cn } from "@/lib/utils";

// The ink steps are theme-aware (globals.css): faint is the label step (3.4:1), muted the AA secondary step.
export const faint = "text-black-alpha-32";
export const muted = "text-black-alpha-56";
/** Relative times are content, not status words: mono for the figure, the reader's own case. */
export const when = cn("text-mono-x-small normal-case", faint);
export const actionLink = "flex items-center gap-1 text-label-small text-muted-foreground hover:text-foreground";

type Filters = Record<string, string | undefined>;

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * "Up 24% on last week", linked to the span it was measured against. On a phone the card's hint
 * has room for the change alone; the rest stays for a screen reader and the title.
 */
function Versus({ href, current, previous, against }: { href: string; current: number; previous: number; against: string }) {
  const [change, rest] = versusParts(current, previous, against);
  return (
    <Link href={href} title={`${change} ${rest}`} className="hover:text-foreground hover:underline">
      {change}
      <span className="max-sm:sr-only"> {rest}</span>
    </Link>
  );
}

/** A stat hint in two lengths: a phone's two-column card fits about half of what a desktop card does. */
function Fit({ full, short }: { full: string; short: string }) {
  return (
    <span title={full}>
      <span className="sm:hidden">{short}</span>
      <span className="max-sm:hidden">{full}</span>
    </span>
  );
}

/**
 * The four headline figures: capital and rounds over the week and the month, each against the
 * span before when the store was already finding rounds then (lib/stats.ts comparable). A younger
 * store says what it can instead of a percentage that only measures its own start.
 */
function MarketStats({ m, preset }: { m: Market; preset: string }) {
  const f = { preset: preset || undefined };
  const byAmount = { ...f, sort: "amount" };
  const day = m.watching_since ? shortDay(m.watching_since, false) : "";
  const since = day ? <Fit full={`Sweeping since ${day}`} short={`Since ${day}`} /> : "";
  const amounts = (n: number) => <Fit full={`From ${plural(n, "stated amount")}`} short={plural(n, "amount")} />;
  const hint = (current: number, previous: number, span: MarketTotals, against: string, filters: Filters, fallback: ReactNode) =>
    comparable(span, m.watching_since) ? (
      <Versus href={marketFeedHref(span, filters)} current={current} previous={previous} against={against} />
    ) : (
      fallback
    );
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Stat
        label="CAPITAL · 7D"
        value={usd(m.week.usd_millions) || "$0"}
        href={marketFeedHref(m.week, byAmount)}
        hint={hint(m.week.usd_millions, m.prev_week.usd_millions, m.prev_week, "last week", byAmount, amounts(m.week.with_amount))}
      />
      <Stat
        label="ROUNDS · 7D"
        value={m.week.rounds}
        href={marketFeedHref(m.week, f)}
        hint={hint(m.week.rounds, m.prev_week.rounds, m.prev_week, "last week", f, since)}
      />
      <Stat
        label="CAPITAL · 30D"
        value={usd(m.month.usd_millions) || "$0"}
        href={marketFeedHref(m.month, byAmount)}
        hint={hint(m.month.usd_millions, m.prev_month.usd_millions, m.prev_month, "prior 30 days", byAmount, amounts(m.month.with_amount))}
      />
      <Stat
        label="ROUNDS · 30D"
        value={m.month.rounds}
        href={marketFeedHref(m.month, f)}
        hint={hint(m.month.rounds, m.prev_month.rounds, m.prev_month, "prior 30 days", f, since)}
      />
    </div>
  );
}

/**
 * Twelve weeks of rounds as bars; each bar opens the feed for its week. When the store began
 * inside the twelve weeks, a line under the chart says the earlier bars came from backfill.
 */
function WeeksChart({ m, preset }: { m: Market; preset: string }) {
  const weeks = m.by_week;
  if (weeks.every((w) => w.count === 0)) {
    return <p className="text-body-small text-muted-foreground">No rounds announced in the last 12 weeks.</p>;
  }
  const weeksMax = Math.max(...weeks.map((w) => w.count), 1);
  // Past eight bars the axis thins to every other label, counted back from the newest week so the
  // current week always reads. Below sm a column is narrower than its label, so only every fourth shows.
  const labelEvery = weeks.length > 8 ? 2 : 1;
  const showLabel = (i: number) => (weeks.length - 1 - i) % labelEvery === 0;
  const showLabelOnPhone = (i: number) => (weeks.length - 1 - i) % (labelEvery * 2) === 0;
  return (
    <div>
      {/* Bars sit on a hairline baseline; the label row below shares the grid so each label centers under its bar. */}
      <div className="grid h-36 grid-cols-12 items-end gap-2 border-b border-border-faint [--bar-max:104px] lg:h-60 lg:[--bar-max:200px]">
        {weeks.map((w, i) => {
          const last = i === weeks.length - 1;
          const label = `Week of ${weekLabel(w.week)}${last ? " (this week)" : ""}: ${plural(w.count, "round")}${w.usd_millions ? `, ${usd(w.usd_millions)}` : ""}`;
          return (
            <Link
              key={w.week}
              href={marketFeedHref({ since: w.week, until: w.until }, { preset: preset || undefined })}
              aria-label={label}
              title={label}
              className="group flex h-full min-w-0 flex-col items-center justify-end gap-1.5 rounded-t-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <div
                className={cn(
                  "text-mono-x-small opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
                  muted,
                )}
              >
                {w.count}
              </div>
              <div
                className={cn(
                  "w-full max-w-8 rounded-t-4 transition-colors",
                  last ? "bg-heat-100" : "bg-black-alpha-12 group-hover:bg-black-alpha-24",
                )}
                style={{ height: w.count === 0 ? "2px" : `max(6px, calc(var(--bar-max) * ${w.count / weeksMax}))` }}
              />
            </Link>
          );
        })}
      </div>
      <div className="grid grid-cols-12 gap-2 pt-2" aria-hidden>
        {weeks.map((w, i) => (
          // Flex, not text-center: a label wider than its column overflows both sides evenly and
          // stays centered; the newest pins to the right edge so it never spills out of the panel.
          <div
            key={w.week}
            className={cn("flex min-w-0 whitespace-nowrap", i === weeks.length - 1 ? "justify-end" : "justify-center", when)}
          >
            {showLabel(i) ? <span className={cn(!showLabelOnPhone(i) && "invisible sm:visible")}>{weekLabel(w.week)}</span> : " "}
          </div>
        ))}
      </div>
      {m.watching_since && m.watching_since > weeks[0].week && (
        <p className="pt-4 text-body-small text-muted-foreground">
          Sweeping since {shortDay(m.watching_since, true)}. Earlier weeks hold what backfill sweeps found, so they may undercount.
        </p>
      )}
    </div>
  );
}

/** One round as a two-line row: logo, name and a detail line, then the figures on the right. */
export function RoundLine({ r, lead, detail, figure }: { r: RoundRow; lead?: ReactNode; detail: ReactNode; figure: ReactNode }) {
  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0 sm:gap-4">
      {lead}
      <CompanyLogo
        id={r.company.id}
        name={r.company.name}
        domain={r.company.domain}
        logoUrl={r.company.logo_url}
        size={28}
        className="shrink-0"
      />
      <div className="min-w-0 flex-1">
        <Link href={companyHref(r.company.id)} className="block truncate text-label-medium hover:underline">
          {r.company.name}
        </Link>
        <div className={cn("truncate text-body-small", muted)}>{detail}</div>
      </div>
      {figure}
    </li>
  );
}

/** "Led by A, B and 2 more", or what the company does when no lead was named. */
function leadLine(r: RoundRow): string {
  const leads = r.lead_investors;
  if (leads.length === 0) return capitalizeFirst(r.company.description) ?? r.company.domain ?? "";
  const more = leads.length > 2 ? ` and ${leads.length - 2} more` : "";
  return `Led by ${leads.slice(0, 2).join(", ")}${more}`;
}

/** The week's largest rounds by stated amount. */
function BiggestRounds({ rows, href }: { rows: RoundRow[]; href: string }) {
  return (
    <Panel
      title="Biggest rounds"
      code="7D"
      className="lg:col-span-2"
      action={
        <Link href={href} className={actionLink}>
          All by amount <ArrowUpRight className="size-3.5" />
        </Link>
      }
    >
      {rows.length === 0 ? (
        <p className="text-body-small text-muted-foreground">No round with a stated amount in the last 7 days.</p>
      ) : (
        <ul className="divide-y divide-border-faint">
          {rows.map((r) => (
            <RoundLine
              key={r.id}
              r={r}
              detail={leadLine(r)}
              figure={
                <div className="flex shrink-0 flex-col items-end gap-0.5 sm:flex-row sm:items-center sm:gap-4">
                  <div className={cn("hidden w-24 truncate text-right text-body-small sm:block", muted)}>{roundStageLabel(r)}</div>
                  <div className="text-right text-mono-small sm:w-16">{usd(r.amount.usd_millions)}</div>
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
  );
}

/** The Trending lane's top rounds, in the rank and with the counts the feed's Trending view shows. */
function TrendingPanel({ data, href, laneOn }: { data: MarketView["trending"]; href: string; laneOn: boolean }) {
  return (
    <Panel
      title="Trending"
      code="72H"
      action={
        data.total > 0 ? (
          <Link href={href} className={actionLink}>
            All {data.total} <ArrowUpRight className="size-3.5" />
          </Link>
        ) : undefined
      }
    >
      {data.rounds.length === 0 ? (
        <p className="text-body-small text-muted-foreground">
          {laneOn
            ? "Nothing first seen in the last three days has been discussed enough to rank yet."
            : "This instance does not run the Trending lane."}
        </p>
      ) : (
        <ul className="divide-y divide-border-faint">
          {data.rounds.map((r, i) => (
            <RoundLine
              key={r.id}
              r={r}
              lead={<span className={cn("w-3 shrink-0 text-right text-mono-small", faint)}>{i + 1}</span>}
              detail={r.trending.summary || roundStageLabel(r)}
              figure={
                <div className="shrink-0 text-right text-mono-small">
                  {usd(r.amount.usd_millions) || <span className={faint}>n/a</span>}
                </div>
              }
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * The market panels, in reading order: the four headline figures, rounds by week beside the stage
 * mix, the biggest rounds beside what is trending, then leads, sectors, and publishers. Every
 * figure links to the feed (or the investor's page) filtered to what it counts.
 */
export function MarketPanels({ view, preset, laneOn }: { view: MarketView; preset: string; laneOn: boolean }) {
  const { market: m, biggest, trending } = view;
  const f = { preset: preset || undefined };
  const trendingHref = `/feed?${new URLSearchParams({ view: "trending", ...(preset ? { preset } : {}) })}`;
  return (
    <>
      <MarketStats m={m} preset={preset} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Rounds by week" code="12W" className="lg:col-span-2">
          <WeeksChart m={m} preset={preset} />
        </Panel>
        <Panel title="By stage" code="30D">
          <BarList
            empty="No rounds in the last 30 days."
            items={m.by_stage.map((s) => ({
              key: s.stage,
              label: stageLabel(s.stage),
              href: marketFeedHref(m.month, { ...f, stage: s.stage }),
              value: s.count,
              detail: `${s.count} · ${usd(s.usd_millions) || "$0"}`,
            }))}
          />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <BiggestRounds rows={biggest} href={marketFeedHref(m.week, { ...f, sort: "amount" })} />
        <TrendingPanel data={trending} href={trendingHref} laneOn={laneOn} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Most active leads" code="30D">
          <BarList
            empty="No lead investor named on a round in the last 30 days."
            items={m.top_leads.map((i) => ({
              key: i.id,
              label: i.name,
              href: investorHref(i.id),
              value: i.leads,
              detail: `${plural(i.leads, "lead")}${i.usd_millions ? ` · ${usd(i.usd_millions)} lead share` : ""}`,
            }))}
          />
        </Panel>
        <Panel title="Sectors" code="30D">
          <BarList
            empty="No sector on a round in the last 30 days."
            items={m.top_sectors.map((s) => ({
              key: s.sector,
              label: sectorLabel(s.sector),
              href: marketFeedHref(m.month, { ...f, sector: s.sector }),
              value: s.count,
            }))}
          />
        </Panel>
        <Panel title="Top publishers" code="30D">
          <BarList
            empty="No publisher reported a round in the last 30 days."
            items={m.top_publishers.map((p) => ({
              key: p.host,
              label: hostLabel(p.host),
              lead: <CompanyLogo name={hostLabel(p.host)} domain={p.host} size={16} className="shrink-0" />,
              href: marketFeedHref(m.month, { ...f, source: p.host }),
              value: p.count,
              detail: plural(p.count, "round"),
            }))}
          />
        </Panel>
      </div>
    </>
  );
}

/** What the figures count, for the reader who will quote one. */
export function MarketNote() {
  return (
    <p className="max-w-3xl text-body-small text-muted-foreground">
      Every figure counts the rounds the feed publishes, by the day each was announced, and opens the feed filtered to the rounds it counts.
      Earlier rounds found later in a company's record are left out. Capital adds up the rounds with a stated amount, in US dollars.
    </p>
  );
}
