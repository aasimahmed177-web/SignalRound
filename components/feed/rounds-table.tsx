"use client";

import { ArrowDown, ArrowUpRight, ChevronRight, ExternalLink } from "lucide-react";
import Link from "next/link";
import { parseAsString, useQueryStates } from "nuqs";
import { Fragment, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { markSeen, markUnread } from "@/app/actions";
import { FlameMark } from "@/components/brand/flame-mark";
import { ShowMore } from "@/components/company/show-more";
import { CompanyLogo } from "@/components/company-logo";
import { RoundCheckMark } from "@/components/confidence";
import { DispositionTag } from "@/components/disposition-tag";
import { BuiltWith } from "@/components/feed/built-with";
import { Buzz, BuzzInline } from "@/components/feed/buzz";
import { RoundCertainty, RoundCertaintyDetail } from "@/components/feed/round-certainty";
import { Verified } from "@/components/feed/verified";
import { HistoryMark } from "@/components/history-mark";
import { PricingPlans } from "@/components/pricing-plans";
import { RelativeDay } from "@/components/relative-day";
import { IntentLink } from "@/components/shell/intent-link";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { track } from "@/lib/analytics";
import { type BuzzScale, EMPTY_SCALE } from "@/lib/buzz";
import { factChips, LINKEDIN_TITLE } from "@/lib/company-facts";
import { foldCopies } from "@/lib/fold-copies";
import { approxDate, hostLabel, precisionNote, reportedAmount, roundStageLabel, sectorLabel, valuationLabel } from "@/lib/format";
import { isHouseCompany } from "@/lib/house";
import { companyHref, investorHrefByName } from "@/lib/links";
import type { FeedRow } from "@/lib/persist";
import type { PresetOption } from "@/lib/presets";
import { pricingModelLabel, pricingView } from "@/lib/pricing";
import type { FeedView } from "@/lib/round-sort";
import { capitalizeFirst, groupDigits } from "@/lib/text";
import type { TrendingMark } from "@/lib/trending";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";

/**
 * The feed's order, shared with the page that reads it: "" is newest announced first, "amount" is
 * largest USD first. A new order starts from the top, so setting it drops the page and the cursor.
 * `view` is here for the Buzz header, which opens the Trending view rather than sorting in place.
 */
const sortParams = {
  sort: parseAsString.withDefault(""),
  view: parseAsString.withDefault(""),
  cursor: parseAsString.withDefault(""),
  page: parseAsString.withDefault(""),
};

/** The focus ring every in-row control wears; the row itself is not focusable, its controls are. */
const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The flame's box at each logo size the table draws, so the house row's mark lines up with the tiles. */
const FLAME_BOX: Record<number, string> = { 28: "size-7", 32: "size-8", 36: "size-9" };

/**
 * The company's logo tile, or for the house company (lib/house.ts) the Firecrawl flame on its own:
 * never boxed, never recolored, in the tile's footprint so the column keeps its alignment.
 */
function RowLogo({ r, house, size, className }: { r: FeedRow; house: boolean; size: 28 | 32 | 36; className?: string }) {
  if (house) return <FlameMark size="inherit" className={cn(FLAME_BOX[size], className)} />;
  return (
    <CompanyLogo
      id={r.company.id}
      name={r.company.name}
      domain={r.company.domain}
      logoUrl={r.company.logo_url}
      size={size}
      className={className}
    />
  );
}

/**
 * The house row's mark: a heat tick on the row's left edge, as the sidebar marks the active page. The
 * table row centres it; a card is taller, so it sits level with the name instead.
 */
function HouseTick({ className = "top-1/2 -translate-y-1/2" }: { className?: string }) {
  return <span className={cn("absolute left-0 h-5 w-0.5 rounded-r-full bg-heat-100", className)} aria-hidden />;
}

/** Sources the expanded row lists before "Show all": enough to see the spread, short enough to scan. */
const SOURCES_SHOWN = 5;

/** The tick and the flame are decorative; a screen reader hears what they say. */
function HouseLabel() {
  return <span className="sr-only">, the company whose API powers this feed</span>;
}

function Detail({ r, readOnly, house, preset }: { r: FeedRow; readOnly: boolean; house: boolean; preset?: string }) {
  const facts = factChips(r.alexandria?.yc, r.company_facts);
  const linkedin = r.company_facts?.linkedin_url ? { url: r.company_facts.linkedin_url, title: LINKEDIN_TITLE } : null;
  const plans = pricingView(r.enrichment?.plans ?? []);
  const pricingModel = pricingModelLabel(r.enrichment?.pricing_model);
  return (
    <div className="grid gap-6 border-t border-border-faint bg-bg-lighter px-4 py-5 md:px-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-mono-x-small text-black-alpha-32 dark:text-muted-foreground">[ COMPANY ]</div>
          <IntentLink
            href={companyHref(r.company.id)}
            className={cn("flex items-center gap-1 rounded-4 text-label-small text-muted-foreground hover:text-foreground", focusRing)}
          >
            Open company <ArrowUpRight className="size-3.5" />
          </IntentLink>
        </div>
        <div className="flex items-start gap-3">
          <RowLogo r={r} house={house} size={36} className="mt-0.5" />
          <div className="min-w-0 text-body-medium">
            {capitalizeFirst(r.company.description) ?? <span className="text-muted-foreground">No description yet.</span>}
          </div>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-body-small">
          {(r.company.website || linkedin) && (
            <>
              <dt className="text-muted-foreground">Site</dt>
              <dd className="truncate">
                {r.company.website && (
                  <a href={r.company.website} target="_blank" rel="noreferrer" className="hover:underline">
                    {r.company.domain ?? r.company.website}
                  </a>
                )}
                {/* The LinkedIn page the company's own site links rides on the site line. */}
                {linkedin && (
                  <>
                    {r.company.website && <span className="text-muted-foreground"> · </span>}
                    <a href={linkedin.url} title={linkedin.title} target="_blank" rel="noreferrer" className="hover:underline">
                      LinkedIn
                    </a>
                  </>
                )}
              </dd>
            </>
          )}
          {r.company.hq && (
            <>
              <dt className="text-muted-foreground">HQ</dt>
              <dd>{r.company.hq}</dd>
            </>
          )}
          {r.company.sector && r.company.sector !== "other" && (
            <>
              <dt className="text-muted-foreground">Sector</dt>
              <dd>{sectorLabel(r.company.sector)}</dd>
            </>
          )}
          <dt className="text-muted-foreground">As written</dt>
          <dd>{r.stage_as_written}</dd>
          {preset && (
            <>
              <dt className="text-muted-foreground">{readOnly ? "Watchlist" : "Preset"}</dt>
              <dd>{preset}</dd>
            </>
          )}
          {r.enrichment && (pricingModel || plans.rows.length > 0) && (
            <>
              <dt className="text-muted-foreground">Pricing</dt>
              <dd className="min-w-0">
                {r.enrichment.pricing_page_url ? (
                  <a
                    href={r.enrichment.pricing_page_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 hover:underline"
                  >
                    {pricingModel ?? "Pricing page"}
                    <ArrowUpRight className="size-3 text-muted-foreground" />
                  </a>
                ) : (
                  pricingModel
                )}
                {/* A Free row already says it; the tag covers a free tier the plan list does not show. */}
                {r.enrichment.has_free_tier && !plans.showsFree ? <span className="text-muted-foreground"> · free tier</span> : null}
                <PricingPlans plans={r.enrichment.plans} className="mt-1" />
              </dd>
            </>
          )}
          {r.valuation && (
            <>
              <dt className="text-muted-foreground">Valuation</dt>
              <dd>{valuationLabel(r.valuation)}</dd>
            </>
          )}
          {/* Sourced facts on this company, each naming its source in the tooltip. */}
          {facts.length > 0 && (
            <>
              <dt className="text-muted-foreground">Facts</dt>
              <dd>
                {facts.map((f, i) => (
                  <Fragment key={f.label}>
                    {i > 0 && <span className="text-muted-foreground"> · </span>}
                    <span title={f.title} className="whitespace-nowrap">
                      {f.label}
                    </span>
                  </Fragment>
                ))}
                <span className="text-muted-foreground"> · via Alexandria</span>
              </dd>
            </>
          )}
        </dl>
      </div>
      <div className="min-w-0 space-y-3">
        <div className="text-mono-x-small text-black-alpha-32 dark:text-muted-foreground">[ INVESTORS ]</div>
        {r.lead_investors.length + r.other_investors.length === 0 ? (
          <p className="text-body-small text-muted-foreground">None named.</p>
        ) : (
          <ul className="space-y-1 text-body-small">
            {r.lead_investors.map((i) => (
              <li key={`l-${i}`} className="flex items-center gap-2">
                <span className="text-mono-x-small text-heat-ink">LEAD</span>
                <IntentLink href={investorHrefByName(i)} className="hover:underline">
                  {i}
                </IntentLink>
              </li>
            ))}
            {r.other_investors.map((i) => (
              <li key={`p-${i}`} className="flex items-center gap-2 text-black-alpha-72 dark:text-muted-foreground">
                <span className="text-mono-x-small text-muted-foreground">PART</span>
                <IntentLink href={investorHrefByName(i)} className="hover:underline">
                  {i}
                </IntentLink>
              </li>
            ))}
          </ul>
        )}
        {r.evidence_quotes.length > 0 && (
          <>
            <div className="pt-2 text-mono-x-small text-black-alpha-32 dark:text-muted-foreground">[ EVIDENCE ]</div>
            <blockquote className="border-l-2 border-heat-40 pl-3 text-body-small text-black-alpha-72 dark:text-muted-foreground">
              {r.evidence_quotes[0]}
            </blockquote>
          </>
        )}
        <div className="pt-2">
          <Verified r={r} readOnly={readOnly} />
        </div>
      </div>
      <div className="min-w-0 space-y-3">
        <div className="text-mono-x-small text-black-alpha-32 dark:text-muted-foreground">[ SOURCES · {r.sources.length} ]</div>
        <RoundCertaintyDetail r={r} />
        <ShowMore
          className="space-y-1.5"
          initial={SOURCES_SHOWN}
          more={`Show all ${r.sources.length} sources`}
          less="Show fewer sources"
          items={foldCopies(r.sources).map(({ primary: s, also }) => (
            <li key={s.url}>
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                onClick={() => track("fireround_source_clicked", { location: "feed", source_host: hostLabel(s.host) })}
                className="group flex items-start gap-2 text-body-small"
              >
                <ExternalLink className="mt-1 size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 break-words">
                  <span className="group-hover:underline">{s.title ?? s.url}</span>
                  <span className="ml-1.5 text-muted-foreground">{hostLabel(s.host)}</span>
                </span>
              </a>
              {also.length > 0 && (
                <div className="ml-5 text-label-small text-muted-foreground">
                  also on{" "}
                  {also.map((a, i) => (
                    <Fragment key={a.url}>
                      {i > 0 && ", "}
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => track("fireround_source_clicked", { location: "feed", source_host: hostLabel(a.host) })}
                        className="hover:text-foreground hover:underline"
                      >
                        {hostLabel(a.host)}
                      </a>
                    </Fragment>
                  ))}
                </div>
              )}
            </li>
          ))}
        />
        {/* The record id is for an operator matching a row to the store; a visitor reads when it was found. */}
        <div className="break-all pt-2 text-body-small text-muted-foreground">
          First seen <RelativeDay iso={r.first_seen_at} />
          {!readOnly && (
            <>
              {" · "}
              <span className="font-mono text-[12px]">{r.id}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The Firecrawl primitives the row passed through, closed by default under the detail's three columns. */
function BuiltWithStrip({ r, xPeople }: { r: FeedRow; xPeople: number }) {
  return (
    <div className="border-t border-border-faint bg-bg-lighter px-4 py-2.5 md:px-6">
      <BuiltWith r={r} disclosure xPeople={xPeople} />
    </div>
  );
}

/** What a reader can do with an open row, under its detail in both layouts. */
function DetailActions({ r, readOnly, onUnread }: { r: FeedRow; readOnly: boolean; onUnread: () => void }) {
  return (
    <div className="flex items-center gap-2 border-t border-border-faint bg-bg-lighter px-4 py-3 md:px-6">
      {!readOnly && (
        <Button
          variant="outline"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onUnread();
          }}
        >
          Mark unread
        </Button>
      )}
      {r.company.website && (
        <Button asChild variant="ghost" size="sm">
          <a href={r.company.website} target="_blank" rel="noreferrer">
            Visit site <ExternalLink className="size-3.5" />
          </a>
        </Button>
      )}
    </div>
  );
}

/**
 * Everything open in a row, in both layouts: the detail, the closed build trace, and the actions.
 * `preset` is the preset that wrote the row, named only when the feed mixes presets.
 */
function Expanded({
  r,
  readOnly,
  house,
  onUnread,
  xPeople,
  preset,
}: {
  r: FeedRow;
  readOnly: boolean;
  house: boolean;
  onUnread: () => void;
  xPeople: number;
  preset?: string;
}) {
  return (
    <>
      <Detail r={r} readOnly={readOnly} house={house} preset={preset} />
      <BuiltWithStrip r={r} xPeople={xPeople} />
      {(!readOnly || r.company.website) && <DetailActions r={r} readOnly={readOnly} onUnread={onUnread} />}
    </>
  );
}

/**
 * The status marks a row wears beside its name: a heat dot when new, the word when updated. Both
 * track one reader's queue (seen or not), so a read-only visitor, who can mark nothing seen, gets neither.
 */
function StatusMark({ status, readOnly }: { status: FeedRow["status"]; readOnly: boolean }) {
  if (readOnly) return null;
  if (status === "new") return <span role="img" className="size-1.5 shrink-0 rounded-full bg-heat-100" aria-label="new" />;
  if (status === "updated") return <Tag>UPDATED</Tag>;
  return null;
}

/** The amount as a figure, the words when no USD figure was stated, or a plain "not stated". */
function Amount({ r }: { r: FeedRow }) {
  const amount = reportedAmount(r);
  if (amount)
    return (
      <span className="block truncate" title={amount}>
        {amount}
      </span>
    );
  return <span className="font-sans font-normal text-muted-foreground">not stated</span>;
}

/**
 * A column header that sets the feed's order. The active order wears an arrow and `aria-sort` on its
 * `th`; every order runs one way (newest first, largest first, most discussed first), so a second
 * click is a no-op. `disabled` is an order the current view does not offer: the label stays, the
 * control goes.
 */
function SortHeader({
  label,
  active,
  onClick,
  disabled = false,
  title,
  align = "left",
  className,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  /** A right-aligned column carries its arrow before the label, so the label ends on the column's edge. */
  align?: "left" | "right";
  className?: string;
}) {
  const arrow = <ArrowDown className={cn("size-3", !active && "opacity-0")} aria-hidden />;
  if (disabled) return <th className={cn(className, align === "right" && "text-right")}>{label}</th>;
  return (
    <th className={cn(className, align === "right" && "text-right")} aria-sort={active ? "descending" : "none"}>
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={cn(
          "-mx-1 inline-flex cursor-pointer items-center gap-1 rounded-4 px-1 uppercase hover:text-foreground",
          // The header row is label ink; the sort control is something a reader acts on, so it reads at AA.
          active ? "text-foreground" : "text-muted-foreground",
          focusRing,
        )}
      >
        {align === "right" && arrow}
        {/* The label sets the button's baseline, so the header row lines up whichever side the arrow is on. */}
        <span className="self-baseline">{label}</span>
        {align === "left" && arrow}
      </button>
    </th>
  );
}

function EmptyState({ readOnly }: { readOnly: boolean }) {
  return (
    <div className="rounded-12 border border-dashed border-border-muted p-12 text-center text-body-small text-muted-foreground">
      No rounds match these filters. {/* A client navigation is safe: the search box drops its draft when the URL's q changes under it. */}
      <Link href="/feed" className="text-foreground underline underline-offset-4">
        Clear the filters
      </Link>
      {readOnly ? (
        "."
      ) : (
        <>
          , or run <code className="rounded-4 bg-muted px-1.5 py-0.5 font-mono text-[12px]">pnpm sweep</code> to pull the last week.
        </>
      )}
    </div>
  );
}

/**
 * `presets` names the preset that wrote a row, in its open detail. Pass the list when the feed
 * mixes presets; pass none (the default) when the feed is already filtered to one. `readOnly`
 * is the demo visitor: no seen state, no marks, no writes. `house` is the house company's domain
 * (lib/house.ts, resolved on the server): its row wears the flame, a heat tick, and a tag.
 */
export function RoundsTable({
  rows,
  presets = [],
  readOnly = false,
  total,
  house = null,
  view = "latest",
  buzz = {},
  scale = EMPTY_SCALE,
}: {
  rows: FeedRow[];
  presets?: PresetOption[];
  readOnly?: boolean;
  /** The filter's whole match when the page is a slice of it: the header reads "N OF M ROWS". */
  total?: number;
  house?: string | null;
  /** The view the server rendered: in Trending the rank is the order, so the other headers stop sorting. */
  view?: FeedView;
  /** The Trending lane's mark per round id, for the Buzz column and the Trending tag. */
  buzz?: Record<string, TrendingMark>;
  /** The Trending window's quantiles right now: every Buzz meter is read against them. */
  scale?: BuzzScale;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [{ sort }, setSort] = useQueryStates(sortParams, { shallow: false });
  const trendingView = view === "trending";
  const ids = useId();
  const unreadRows = rows.filter((r) => r.status !== "seen");
  const unread = unreadRows.map((r) => r.id);
  const presetName = new Map(presets.map((p) => [p.slug, p.name]));
  // Below md the columns have nowhere to go, so the same rows also render as cards; CSS shows one.
  // Lead is hidden below xl. A colSpan wider than the visible columns makes the browser add
  // phantom columns and squeeze the real ones, so the detail row spans what is shown.
  const xl = useMediaQuery("(min-width: 1280px)");
  // In Trending the Buzz column carries the rank and the counts, so below xl Announced gives it the room.
  const visibleColumns = xl ? 7 : trendingView ? 5 : 6;

  const toggle = (r: FeedRow) => {
    const isOpen = open === r.id;
    setOpen(isOpen ? null : r.id);
    // Opening a row is the read; it only speaks up when the write fails.
    if (!readOnly && !isOpen && r.status !== "seen")
      start(async () => {
        const res = await markSeen([r.id]);
        if (!res.ok) toast.error("Could not mark the row seen", { description: res.error });
      });
  };
  const unreadOne = (r: FeedRow) =>
    start(async () => {
      const res = await markUnread([r.id]);
      if (res.ok) toast.success(`${r.company.name} marked unread`);
      else toast.error("Could not mark unread", { description: res.error });
    });
  // Undo sets rows back to new, which would turn an updated row into a new one; offer it only when that loses nothing.
  const undoable = unreadRows.every((r) => r.status === "new");
  const markPageSeen = () =>
    start(async () => {
      const res = await markSeen(unread);
      if (!res.ok) {
        toast.error("Could not mark these seen", { description: res.error });
        return;
      }
      toast.success(`${unread.length} ${unread.length === 1 ? "round" : "rounds"} marked seen`, {
        action: undoable
          ? {
              label: "Undo",
              onClick: () =>
                start(async () => {
                  const back = await markUnread(unread);
                  if (!back.ok) toast.error("Could not undo", { description: back.error });
                }),
            }
          : undefined,
      });
    });
  const onSort = (value: string) => {
    if (value === sort) return;
    setSort({ sort: value, cursor: null, page: null });
    track("fireround_feed_filtered", { filter: "sort", value: value || "newest" });
  };
  // Buzz is not an order over the whole store: its header opens the Trending view, which ranks by it.
  const openTrending = () => {
    if (trendingView) return;
    setSort({ view: "trending", sort: null, cursor: null, page: null });
    track("fireround_feed_filtered", { filter: "view", value: "trending" });
  };
  const rowSecondLine = (r: FeedRow) => capitalizeFirst(r.company.description) ?? r.company.domain ?? r.stage_as_written;

  if (rows.length === 0) return <EmptyState readOnly={readOnly} />;

  // Fixed layout: the header row sets every column's width, so the table is exactly as wide as
  // its card and the company column absorbs the difference. Lead leaves below xl; the expanded
  // row still carries it. The check and its source count ride in the Round cell.
  const head = "py-2 text-left font-normal";
  const cell = "py-2.5 align-top";
  const muted = "text-black-alpha-56 dark:text-muted-foreground";
  const faint = "text-black-alpha-32 dark:text-muted-foreground";
  // The Buzz cell sits right-aligned in both views, the meter at the column's edge.
  const buzzPad = "pr-4 pl-3 xl:pr-5 xl:pl-4";

  return (
    <div className="overflow-hidden rounded-12 border border-border-faint bg-card">
      <div className="flex h-11 items-center justify-between gap-3 border-b border-border-faint pl-5 pr-3">
        <div className={cn("min-w-0 truncate text-mono-x-small", faint)}>
          [ {rows.length}
          {total !== undefined && total > rows.length ? ` OF ${groupDigits(total)}` : ""}
          {/* A phone keeps the figures and drops the noun, so the tally fits beside the button. */}
          <span className="hidden sm:inline"> {(total ?? rows.length) === 1 ? "ROW" : "ROWS"}</span>
          {readOnly ? "" : ` · ${unread.length} UNREAD`} ]
        </div>
        {!readOnly && (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending || unread.length === 0}
            onClick={markPageSeen}
            title="Marks the unread rows on this page seen; rows on other pages keep their state."
          >
            {unread.length === 0 ? (
              "All seen"
            ) : unread.length === 1 ? (
              "Mark this one seen"
            ) : (
              // A phone has room for the count or the "these", not both beside the row tally.
              <>
                Mark <span className="hidden sm:inline">these </span>
                {unread.length} seen
              </>
            )}
          </Button>
        )}
      </div>
      {/* Both layouts render and CSS picks one, so the first paint is right on every width: a media query read on the client would paint cards on a desktop for a frame. */}
      <div className="text-body-small md:hidden">
        {rows.map((r, i) => {
          const isOpen = open === r.id;
          const detailId = `${ids}-card-${i}`;
          const secondLine = rowSecondLine(r);
          const preset = presetName.get(r.preset_slug) ?? r.preset_slug;
          const isHouse = isHouseCompany(r.company, house);
          return (
            <div key={r.id} className={cn("border-b border-border-faint last:border-b-0", isOpen && "bg-black-alpha-4 dark:bg-white/4")}>
              {/* The whole card body toggles, as the table row does. The chevron is the one control: its ::after stretches
                  over the card so a tap anywhere lands on the button, and a keyboard reaches the same button. The company
                  link sits above that layer so it stays a link. */}
              <div className="relative flex items-start gap-3 px-4 py-3 transition-colors hover:bg-black-alpha-4 dark:hover:bg-white/4">
                {isHouse && <HouseTick className="top-4" />}
                <RowLogo r={r} house={isHouse} size={32} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <IntentLink
                      href={companyHref(r.company.id)}
                      className={cn(
                        "relative z-10 truncate text-label-medium hover:underline",
                        (r.status === "seen" || readOnly) && "font-normal",
                      )}
                    >
                      {r.company.name}
                    </IntentLink>
                    <StatusMark status={r.status} readOnly={readOnly} />
                    {isHouse && <HouseLabel />}
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={isOpen ? detailId : undefined}
                      aria-label={`${isOpen ? "Hide" : "Show"} details for ${r.company.name}`}
                      onClick={() => toggle(r)}
                      className={cn("-m-2 ml-auto shrink-0 cursor-pointer rounded-4 p-2 after:absolute after:inset-0", focusRing)}
                    >
                      <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                    </button>
                  </div>
                  {/* The second line carries the meter at its right end; the counts and the rank are its tooltip. */}
                  <div className="flex min-w-0 items-center gap-3">
                    <div className={cn("min-w-0 flex-1 truncate", muted)}>{secondLine}</div>
                    <BuzzInline mark={buzz[r.id]} scale={scale} />
                  </div>
                  <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="whitespace-nowrap">
                      {roundStageLabel(r)}
                      {r.is_extension && <span className={muted}> ext.</span>}
                    </span>
                    <span className="max-w-full truncate text-mono-small">
                      <Amount r={r} />
                    </span>
                    <span
                      className="text-mono-small font-normal text-muted-foreground"
                      title={precisionNote(r.date_precision) ?? undefined}
                    >
                      {r.announced_on ? approxDate(r.announced_on, r.date_precision) : <span className="font-sans">undated</span>}
                    </span>
                    {/* The count alone beside the glyph, so the line fits a phone; the words stay for a screen reader. The preset is in the open row. */}
                    <RoundCheckMark r={r} compact />
                    <RoundCertainty r={r} />
                    <DispositionTag value={r.disposition} />
                    <HistoryMark history={r.history} reportedLater={r.reported_later} />
                  </div>
                </div>
              </div>
              {isOpen && (
                <div id={detailId}>
                  <Expanded
                    r={r}
                    readOnly={readOnly}
                    house={isHouse}
                    onUnread={() => unreadOne(r)}
                    xPeople={buzz[r.id]?.people ?? 0}
                    preset={presets.length > 0 ? preset : undefined}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <table className="hidden w-full table-fixed text-body-small md:table">
        <thead className={cn("text-mono-x-small", faint)}>
          <tr className="border-b border-border-faint">
            <th className={cn(head, "w-11 pl-4")}>
              <span className="sr-only">Expand</span>
            </th>
            <th className={cn(head, "w-auto")}>Company</th>
            <th className={cn(head, "w-28 xl:w-32")}>Round</th>
            <SortHeader
              label="Amount"
              active={!trendingView && sort === "amount"}
              disabled={trendingView}
              onClick={() => onSort("amount")}
              align="right"
              className={cn(head, "w-24")}
            />
            <th className={cn(head, "hidden w-44 pl-6 xl:table-cell")}>Lead</th>
            <SortHeader
              label="Date"
              active={!trendingView && sort === ""}
              disabled={trendingView}
              onClick={() => onSort("")}
              className={cn(head, "w-28 pl-4 xl:w-32 xl:pl-6", trendingView && "hidden xl:table-cell")}
            />
            <SortHeader
              label="Buzz"
              active={trendingView}
              onClick={openTrending}
              title={trendingView ? undefined : "Rank by buzz: opens the Trending view"}
              align="right"
              className={cn(head, buzzPad, trendingView ? "w-44 xl:w-56" : "w-28 xl:w-32")}
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isOpen = open === r.id;
            const detailId = `${ids}-row-${i}`;
            const secondLine = rowSecondLine(r);
            const preset = presetName.get(r.preset_slug) ?? r.preset_slug;
            const isHouse = isHouseCompany(r.company, house);
            return (
              <Fragment key={r.id}>
                <tr
                  className={cn(
                    "cursor-pointer border-b border-border-faint transition-colors hover:bg-black-alpha-4 dark:hover:bg-white/4",
                    isOpen && "bg-black-alpha-4 dark:bg-white/4",
                  )}
                  onClick={() => toggle(r)}
                >
                  <td className={cn(cell, "pl-4", isHouse && "relative")}>
                    {isHouse && <HouseTick />}
                    {/* The row is clickable for the mouse; this button is the same toggle for a keyboard or a screen reader. */}
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={isOpen ? detailId : undefined}
                      aria-label={`${isOpen ? "Hide" : "Show"} details for ${r.company.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(r);
                      }}
                      className={cn("tap relative mt-1 flex size-6 cursor-pointer items-center justify-center rounded-4", focusRing)}
                    >
                      <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                    </button>
                  </td>
                  <td className={cn(cell, "pr-4")}>
                    <div className="flex items-start gap-3">
                      <RowLogo r={r} house={isHouse} size={28} className="mt-1" />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                          <IntentLink
                            href={companyHref(r.company.id)}
                            onClick={(e) => e.stopPropagation()}
                            className={cn("truncate text-label-medium hover:underline", (r.status === "seen" || readOnly) && "font-normal")}
                          >
                            {r.company.name}
                          </IntentLink>
                          <StatusMark status={r.status} readOnly={readOnly} />
                          {/* Below xl the column is too narrow for name and tag; the flame and the heat tick still mark the row. */}
                          {isHouse && <HouseLabel />}
                        </div>
                        <div className={cn("truncate", muted)}>{secondLine}</div>
                      </div>
                    </div>
                  </td>
                  {/* Two lines, stage and check, so the row stays as short as the company cell; the preset is the tooltip and the open row. */}
                  <td className={cell} title={presets.length > 0 ? `${readOnly ? "Watchlist" : "Preset"}: ${preset}` : undefined}>
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                      <span className="max-w-full truncate">
                        {roundStageLabel(r)}
                        {r.is_extension && <span className={muted}> ext.</span>}
                      </span>
                      <RoundCertainty r={r} className="shrink-0 text-label-x-small font-normal text-muted-foreground" />
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                      <RoundCheckMark r={r} />
                      <DispositionTag value={r.disposition} />
                      <HistoryMark history={r.history} reportedLater={r.reported_later} />
                    </div>
                  </td>
                  <td className={cn(cell, "text-right text-mono-small")}>
                    <Amount r={r} />
                  </td>
                  <td className={cn(cell, "hidden pl-6 xl:table-cell")}>
                    {r.lead_investors.length > 0 ? (
                      <>
                        <div className="truncate">{r.lead_investors[0]}</div>
                        {r.lead_investors.length > 1 && (
                          <div className={cn("truncate", muted)}>
                            {r.lead_investors.length === 2 ? r.lead_investors[1] : `+${r.lead_investors.length - 1} more`}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">not stated</span>
                    )}
                  </td>
                  <td className={cn(cell, "pl-4 text-mono-small xl:pl-6", trendingView && "hidden xl:table-cell")}>
                    {r.announced_on ? (
                      <>
                        <div className="whitespace-nowrap" title={precisionNote(r.date_precision) ?? undefined}>
                          {approxDate(r.announced_on, r.date_precision)}
                        </div>
                        <div className="font-sans text-label-x-small font-normal text-muted-foreground">
                          {r.date_precision === "day" ? (
                            <RelativeDay iso={r.announced_on} />
                          ) : r.date_precision === "week" ? (
                            "that week"
                          ) : (
                            "that month"
                          )}
                        </div>
                      </>
                    ) : (
                      <span className="font-sans font-normal text-muted-foreground">undated</span>
                    )}
                  </td>
                  <td className={cn(cell, buzzPad)}>
                    <Buzz mark={buzz[r.id]} scale={scale} view={view} />
                  </td>
                </tr>
                {isOpen && (
                  <tr id={detailId} className="border-b border-border-faint">
                    <td colSpan={visibleColumns} className="p-0">
                      <Expanded
                        r={r}
                        readOnly={readOnly}
                        house={isHouse}
                        onUnread={() => unreadOne(r)}
                        xPeople={buzz[r.id]?.people ?? 0}
                        preset={presets.length > 0 ? preset : undefined}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
