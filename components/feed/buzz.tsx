import { Fragment } from "react";
import { XLogo } from "@/components/x-logo";
import { BUZZ_LEVELS, type BuzzPart, type BuzzScale, buzzLabel, buzzParts, markLevel, rankText } from "@/lib/buzz";
import type { TrendingMark } from "@/lib/trending";
import { cn } from "@/lib/utils";

/** Each bar's height, low to high, so the meter reads as rising heat at a glance. */
const BAR_HEIGHTS = ["h-1", "h-1.5", "h-2", "h-2.5", "h-3"] as const;

/**
 * The filled bars' colour by the meter's level: graphite while a round is quiet, then warming
 * through the heat ramp as it climbs, full heat on a labelled row. The meter reads as temperature,
 * and the hottest rows share the heat of the Trending tab that ranks them.
 */
const LEVEL_FILL = ["bg-black-alpha-40", "bg-black-alpha-56", "bg-heat-48", "bg-heat-80", "bg-heat-100"] as const;

/**
 * The heat meter: five rising bars, filled to the row's place among the rounds in the Trending
 * window (quintiles, lib/buzz.ts), in LEVEL_FILL's colour. Decoration: the facts it stands for are
 * in the cell's tooltip and screen reader label.
 */
export function BuzzMeter({ level, label = false, className }: { level: number; label?: boolean; className?: string }) {
  const fill = label ? "bg-heat-100" : LEVEL_FILL[Math.min(Math.max(level, 1), BUZZ_LEVELS) - 1];
  return (
    <span className={cn("inline-flex h-3 shrink-0 items-end gap-0.5", className)} aria-hidden>
      {BAR_HEIGHTS.slice(0, BUZZ_LEVELS).map((h, i) => (
        <span key={h} className={cn("w-[3px] rounded-[1px]", h, i < level ? fill : "bg-black-alpha-12")} />
      ))}
    </span>
  );
}

/** The Trending word beside a labelled row's meter: small, heat ink, sentence case. */
function TrendingWord() {
  return (
    <span className="text-label-x-small font-normal text-heat-ink" aria-hidden>
      Trending
    </span>
  );
}

/**
 * Figures in mono at full ink, the words after them at muted ink, the separators quieter still.
 * One line: the cell truncates the tail rather than wrapping the row taller. People on X read
 * "13 on" and X's logomark, the source named by its mark.
 */
function Readout({ parts }: { parts: BuzzPart[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={p.key}>
          {i > 0 && <span className="text-black-alpha-32"> · </span>}
          {p.key === "hn" ? (
            <>
              <span className="text-muted-foreground">{p.words} </span>
              <span className="text-mono-small text-foreground">{p.figure}</span>
            </>
          ) : p.key === "x" ? (
            <>
              <span className="text-mono-small text-foreground">{p.figure}</span>
              <span className="text-muted-foreground">
                {" on "}
                <XLogo />
              </span>
            </>
          ) : (
            <>
              <span className="text-mono-small text-foreground">{p.figure}</span>
              <span className="text-muted-foreground"> {p.words}</span>
            </>
          )}
        </Fragment>
      ))}
    </>
  );
}

/**
 * The Buzz cell on a desktop table. Latest: the meter at the cell's right edge, with the Trending
 * word before it on a labelled row, so every row's meter lines up. Trending, where the chatter is
 * the point: the rank and the meter on the first line, the concise counts under them, two lines like
 * every other cell in the row, so the column stays as narrow as it is under Latest. A row outside
 * the window or without a signal is an empty cell, with the reason for a screen reader. The full
 * breakdown and the rank are the tooltip.
 */
export function Buzz({ mark, scale, view = "latest" }: { mark: TrendingMark | undefined; scale: BuzzScale; view?: "latest" | "trending" }) {
  const level = markLevel(mark, scale);
  if (!mark || level === 0) return <span className="sr-only">No recent discussion</span>;
  if (view === "trending")
    return (
      <div className="flex min-w-0 flex-col items-end gap-0.5" title={buzzLabel(mark)}>
        <div className="flex h-5 items-center gap-2" aria-hidden>
          <span className="text-mono-small text-muted-foreground tabular-nums">{rankText(mark.rank)}</span>
          <BuzzMeter level={level} label={mark.label} />
        </div>
        <span className="max-w-full truncate text-body-small" aria-hidden>
          <Readout parts={buzzParts(mark)} />
        </span>
        <span className="sr-only">{buzzLabel(mark)}</span>
      </div>
    );
  return (
    <div className="flex h-5 items-center justify-end gap-2" title={buzzLabel(mark)}>
      {mark.label && <TrendingWord />}
      <BuzzMeter level={level} label={mark.label} />
      <span className="sr-only">{buzzLabel(mark)}</span>
    </div>
  );
}

/**
 * The same meter for a phone card's meta line, with the Trending word on a labelled row and no
 * readout. It draws nothing for a row without a signal: a card has no column to keep aligned.
 */
export function BuzzInline({ mark, scale, className }: { mark: TrendingMark | undefined; scale: BuzzScale; className?: string }) {
  const level = markLevel(mark, scale);
  if (!mark || level === 0) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5", className)} title={buzzLabel(mark)}>
      <BuzzMeter level={level} label={mark.label} />
      {mark.label && <TrendingWord />}
      <span className="sr-only">{buzzLabel(mark)}</span>
    </span>
  );
}
