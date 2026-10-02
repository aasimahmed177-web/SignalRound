import Link from "next/link";
import { cn } from "@/lib/utils";

export const LANE_PARAM = "lane";
export const EMPTY_PARAM = "empty";

/** The page's URL for a lane and the empty-run toggle; the defaults (all lanes, empties hidden) leave no param. */
export function runsHref(lane: string, showEmpty: boolean): string {
  const q = new URLSearchParams();
  if (lane) q.set(LANE_PARAM, lane);
  if (showEmpty) q.set(EMPTY_PARAM, "1");
  const s = q.toString();
  return s ? `/runs?${s}` : "/runs";
}

const chip = "tap relative inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-full px-3 text-label-small transition-colors";
const on = "bg-foreground text-background";
const off =
  "bg-black-alpha-4 text-black-alpha-56 hover:bg-black-alpha-8 hover:text-foreground dark:bg-white/6 dark:text-muted-foreground dark:hover:bg-white/10";

/**
 * The review page's chips, as links: a lane is a URL a reader can share, and the server reads it
 * with no client state. The empty-run toggle sits at the end of the row in the same shape.
 */
export function RunFilters({
  lane,
  showEmpty,
  total,
  lanes,
  emptyCount,
}: {
  lane: string;
  showEmpty: boolean;
  /** The rows the All chip covers, under the current empty-run toggle. */
  total: number;
  lanes: Array<{ lane: string; label: string; count: number }>;
  /** Empty runs in the current lane, shown or not. */
  emptyCount: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <FilterChip href={runsHref("", showEmpty)} active={lane === ""} label="All" count={total} />
      {lanes.length > 0 && <span className="mx-1 h-4 w-px bg-border-muted" aria-hidden />}
      {lanes.map((l) => (
        <FilterChip key={l.lane} href={runsHref(l.lane, showEmpty)} active={lane === l.lane} label={l.label} count={l.count} />
      ))}
      {emptyCount > 0 && (
        <Link
          href={runsHref(lane, !showEmpty)}
          className={cn(chip, "sm:ml-auto", showEmpty ? on : off)}
          title="Finished runs that read no pages, found no rounds, and hit no error"
        >
          {showEmpty ? "Hide empty runs" : `Show ${emptyCount} empty ${emptyCount === 1 ? "run" : "runs"}`}
        </Link>
      )}
    </div>
  );
}

function FilterChip({ href, active, label, count }: { href: string; active: boolean; label: string; count: number }) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={cn(chip, active ? on : off)}>
      {label}
      <span className={cn("text-mono-x-small", active ? "text-background/70" : "text-muted-foreground")}>{count}</span>
    </Link>
  );
}
