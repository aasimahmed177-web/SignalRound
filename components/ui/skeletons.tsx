import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Loading shapes built to the real layouts' measurements (the same cards, paddings, and type line
// heights), so a fallback reads as the page arriving and nothing moves when the data lands.
// Every piece is aria-hidden: the bones say nothing a screen reader needs.

/** Widths that vary row to row, so a column of bones reads as text rather than a grid of bars. */
const WIDTHS = ["w-40", "w-28", "w-48", "w-32", "w-36", "w-24"] as const;
const WIDE = ["w-4/5", "w-3/5", "w-2/3", "w-1/2", "w-3/4", "w-2/5"] as const;

/** Keys and widths for n rows; the key is data, so no row is keyed by its index. */
function bones(n: number) {
  return Array.from({ length: n }, (_, i) => ({ key: `b${i}`, w: WIDTHS[i % WIDTHS.length], wide: WIDE[i % WIDE.length] }));
}

/**
 * One line of text as a bone. The wrapper takes the house type style, and a zero-width space gives
 * it that style's line box, so the line is exactly as tall as the text that replaces it; the bone
 * sits inline at about x-height, so `text-right` aligns it as it would a figure.
 */
export function SkeletonLine({
  text = "text-body-small",
  width = "w-24",
  className,
}: {
  text?: string;
  width?: string;
  className?: string;
}) {
  return (
    <div className={cn(text, className)} aria-hidden>
      <Skeleton className={cn("inline-block h-[0.7em] max-w-full rounded-4 align-middle", width)} />
      {"\u200b"}
    </div>
  );
}

/** A filter pill, chip, or search box: the real ones are h-8 rounded-full on the faintest ink step. */
export function PillSkeleton({ className }: { className?: string }) {
  return <Skeleton aria-hidden className={cn("h-8 w-24 shrink-0 rounded-full bg-black-alpha-4", className)} />;
}

/** The preset switcher's chip row (All, then each preset), as the overview and news open with it. */
export function PresetChipsSkeleton() {
  return (
    <div className="flex gap-2 overflow-hidden" aria-hidden>
      <PillSkeleton className="w-10" />
      <PillSkeleton className="w-28" />
      <PillSkeleton className="w-32" />
      <PillSkeleton className="w-32" />
      <PillSkeleton className="w-36" />
    </div>
  );
}

/** A logo tile at its real size and radius. */
export function LogoSkeleton({ size = 28, className }: { size?: 16 | 28 | 32 | 48; className?: string }) {
  const box = { 16: "size-4", 28: "size-7", 32: "size-8", 48: "size-12" }[size];
  return <Skeleton aria-hidden className={cn("shrink-0 rounded-6", box, className)} />;
}

/** A row of house stat cards: eyebrow, figure, hint, at the Stat card's padding and line heights. */
export function StatRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-hidden>
      {bones(count).map((b) => (
        <div key={b.key} className="min-w-0 rounded-12 border border-border-faint bg-card p-5">
          <SkeletonLine text="text-mono-x-small" width="w-20" />
          <SkeletonLine text="text-title-h4" width="w-16" className="mt-2" />
          <SkeletonLine width={b.w === "w-48" ? "w-28" : b.w} className="mt-1" />
        </div>
      ))}
    </div>
  );
}

/**
 * A house Panel: the h-11 header row, then a body (bars by default). The title is static copy the
 * page already knows, so it renders as text and only the data pulses.
 */
export function PanelSkeleton({
  title,
  className,
  flush,
  children,
}: {
  title?: string;
  className?: string;
  flush?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className={cn("min-w-0 rounded-12 border border-border-faint bg-card", flush && "overflow-hidden", className)} aria-hidden>
      <header className="flex h-11 items-center border-b border-border-faint px-5">
        {title ? <h2 className="truncate text-label-medium">{title}</h2> : <SkeletonLine text="text-label-medium" width="w-28" />}
      </header>
      <div className={flush ? undefined : "p-5"}>{children ?? <BarListSkeleton />}</div>
    </section>
  );
}

/** BarList rows: a label and a figure over a track, the overview's and the investor page's bars. */
export function BarListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul className="space-y-2.5" aria-hidden>
      {bones(rows).map((b) => (
        <li key={b.key} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1">
          <SkeletonLine width={b.w} />
          <SkeletonLine text="text-mono-small" width="w-12" />
          <div className="col-span-2 h-1.5 rounded-full bg-black-alpha-4" />
        </li>
      ))}
    </ul>
  );
}

/** Two-line rows with a logo and trailing figures, divided by hairlines: a panel's list of rounds. */
export function ListSkeleton({ rows = 6, logo = true, trailing = ["w-12"] }: { rows?: number; logo?: boolean; trailing?: string[] }) {
  const figures = trailing.map((w, j) => ({ w, key: `t${j}` }));
  return (
    <ul className="divide-y divide-border-faint" aria-hidden>
      {bones(rows).map((b) => (
        <li key={b.key} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
          {logo && <LogoSkeleton />}
          <div className="min-w-0 flex-1">
            <SkeletonLine text="text-label-medium" width={b.w === "w-48" ? "w-32" : b.w} />
            <SkeletonLine width={b.wide} />
          </div>
          {figures.map((f) => (
            <SkeletonLine key={f.key} text="text-mono-small" width={f.w} className="shrink-0" />
          ))}
        </li>
      ))}
    </ul>
  );
}

interface TableSkeletonProps {
  rows?: number;
  /**
   * The columns after the first, as the real table's width classes (`w-24`, `hidden w-44 xl:block`);
   * add `text-right` for a figure column. The first column takes the rest.
   */
  cols?: string[];
  /** The first column's logo tile, or none. */
  logo?: boolean;
  /** Lines in the first column: a name alone, or a name over a description. */
  lines?: 1 | 2;
  /** The h-11 tally bar the feed and the directories carry above the header. */
  bar?: boolean;
  /** Below md the real tables become cards; these are their bones. */
  cards?: boolean;
  /** Meta lines a card carries under its name and description: the feed's figures, then its preset. */
  cardMeta?: 0 | 1 | 2;
  /** Anything a card carries under its two lines (the runs cards' figure grid). */
  cardExtra?: ReactNode;
  /** A blank lead before the first column, where the feed keeps its expand chevron. */
  indent?: boolean;
  /** Vertical padding of body and header cells, when the real table's differ from the feed's. */
  rowPad?: string;
  headPad?: string;
  className?: string;
}

/** A card-wrapped table: the tally bar, the header row, then rows; cards in its place below md. */
export function TableSkeleton({
  rows = 8,
  cols = [],
  logo = true,
  lines = 2,
  bar = true,
  cards = true,
  cardMeta = 0,
  cardExtra,
  indent = false,
  rowPad = "py-2.5",
  headPad = "py-2",
  className,
}: TableSkeletonProps) {
  const list = bones(rows);
  // Two columns can share a width class, so each takes a key of its own.
  const columns = cols.map((c, j) => ({ c, key: `c${j}` }));
  return (
    <div className={cn("overflow-hidden rounded-12 border border-border-faint bg-card", className)} aria-hidden>
      {bar && (
        <div className="flex h-11 items-center border-b border-border-faint px-5">
          <SkeletonLine text="text-mono-x-small" width="w-40" />
        </div>
      )}
      {cards && (
        <ul className="md:hidden">
          {list.map((b) => (
            <li key={b.key} className="flex items-start gap-3 border-b border-border-faint px-4 py-3 last:border-b-0">
              {logo && <LogoSkeleton size={32} className="mt-0.5" />}
              <div className="min-w-0 flex-1">
                <SkeletonLine text="text-label-medium" width={b.w === "w-48" ? "w-32" : b.w} />
                <SkeletonLine width={b.wide} />
                {cardMeta > 0 && (
                  <div className="mt-1.5 flex gap-3">
                    <SkeletonLine width="w-12" />
                    <SkeletonLine text="text-mono-small" width="w-12" />
                    <SkeletonLine text="text-mono-small" width="w-20" />
                  </div>
                )}
                {cardMeta > 1 && <SkeletonLine width="w-28" className="mt-1" />}
                {cardExtra}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className={cn(cards && "hidden md:block")}>
        <div className={cn("flex gap-4 border-b border-border-faint px-5", headPad)}>
          {indent && <div className="w-2 shrink-0" />}
          <div className="min-w-0 flex-1">
            <SkeletonLine text="text-mono-x-small" width="w-16" />
          </div>
          {columns.map(({ c, key }) => (
            <div key={key} className={cn("shrink-0", c)}>
              <SkeletonLine text="text-mono-x-small" width="w-12" />
            </div>
          ))}
        </div>
        {list.map((b) => (
          <div key={b.key} className={cn("flex items-start gap-4 border-b border-border-faint px-5 last:border-b-0", rowPad)}>
            {indent && <div className="w-2 shrink-0" />}
            <div className="flex min-w-0 flex-1 items-start gap-3">
              {logo && <LogoSkeleton className="mt-1" />}
              <div className="min-w-0 flex-1">
                <SkeletonLine text={lines === 1 ? "text-label-small" : "text-label-medium"} width={lines === 1 ? "w-28" : b.w} />
                {lines === 2 && <SkeletonLine width={b.wide} />}
              </div>
            </div>
            {columns.map(({ c, key }) => (
              <div key={key} className={cn("shrink-0", c)}>
                <SkeletonLine width="w-3/4" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Article cards in one hairline-divided card: a title, a meta line, then the round pills. */
export function CardListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ul className="divide-y divide-border-faint overflow-hidden rounded-12 border border-border-faint bg-card" aria-hidden>
      {bones(rows).map((b, i) => (
        <li key={b.key} className="px-5 py-4">
          <SkeletonLine text="text-label-medium" width={b.wide} />
          <SkeletonLine text="text-label-x-small" width="w-44" className="mt-1.5" />
          <div className="mt-3 flex gap-1.5">
            <Skeleton className="h-6 w-36 rounded-full bg-black-alpha-4" />
            {i % 2 === 0 && <Skeleton className="h-6 w-32 rounded-full bg-black-alpha-4" />}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A day heading over a group: the word, a hairline to the edge, the count. */
export function SectionHeadingSkeleton() {
  return (
    <div className="mb-3 flex items-center gap-3" aria-hidden>
      <SkeletonLine text="text-label-small" width="w-16" />
      <span className="h-px flex-1 bg-border-faint" />
      <SkeletonLine text="text-label-x-small" width="w-16" />
    </div>
  );
}

/** A detail page's header card: the 48px tile, then what the record says and one quiet meta line. */
export function HeaderCardSkeleton() {
  return (
    <div className="flex items-start gap-4 rounded-12 border border-border-faint bg-card p-5 sm:gap-5 sm:p-6" aria-hidden>
      <LogoSkeleton size={48} className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-2">
        <SkeletonLine text="text-body-medium" width="w-3/4" />
        <SkeletonLine width="w-64" />
      </div>
    </div>
  );
}
