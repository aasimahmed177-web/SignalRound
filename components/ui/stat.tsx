import Link from "next/link";
import type { ReactNode } from "react";
import { Tag } from "@/components/ui/tag";
import { cn } from "@/lib/utils";

interface StatProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: boolean;
  /** The value links here: a latest round's company, say. */
  href?: string;
  className?: string;
}

/**
 * A house stat card: mono eyebrow, a large 500-weight number in tabular figures, a quiet hint.
 * The hint is one line and truncates, so a row of cards is one height whatever each one says;
 * a card without a hint keeps the line so its neighbors do not tower over it.
 */
export function Stat({ label, value, hint, accent, href, className }: StatProps) {
  return (
    <div className={cn("min-w-0 rounded-12 border border-border-faint bg-card p-5", className)}>
      <div className="truncate text-mono-x-small text-black-alpha-32 dark:text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-2 truncate tabular-nums",
          typeof value === "string" && /[a-z]/i.test(value) ? "text-title-h5 sm:text-title-h4" : "text-title-h4",
          accent && "text-heat-100",
        )}
        title={typeof value === "string" ? value : undefined}
      >
        {href ? (
          <Link href={href} className="hover:underline">
            {value}
          </Link>
        ) : (
          value
        )}
      </div>
      <div className="mt-1 truncate text-body-small text-muted-foreground" title={typeof hint === "string" ? hint : undefined}>
        {hint ?? "\u00a0"}
      </div>
    </div>
  );
}

interface PanelProps {
  /** Usually words; a node when the title carries a mark (On X wears X's logomark). */
  title: ReactNode;
  code?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** No body padding: for a table that runs edge to edge under the header. */
  flush?: boolean;
}

/**
 * A card with a hairline header row. The header is one line at h-11 (the feed table's bar): the
 * title truncates, the bracket code leaves below xl (a third-width panel at 1100 has no room for
 * both), and the action never shrinks.
 */
export function Panel({ title, code, action, children, className, flush }: PanelProps) {
  return (
    <section className={cn("min-w-0 rounded-12 border border-border-faint bg-card", flush && "overflow-hidden", className)}>
      <header className="flex h-11 items-center justify-between gap-4 border-b border-border-faint px-5">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 className="truncate text-label-medium" title={typeof title === "string" ? title : undefined}>
            {title}
          </h2>
          {code && (
            <Tag tone="faint" className="hidden shrink-0 xl:inline">
              {code}
            </Tag>
          )}
        </div>
        {action && <div className="flex shrink-0 items-center">{action}</div>}
      </header>
      <div className={flush ? undefined : "p-5"}>{children}</div>
    </section>
  );
}

interface BarListProps {
  /**
   * An item with an href renders its label as a link. The key is whatever made the row unique upstream: a stage, a sector, an id.
   * A lead (a logo tile) sits before the label outside the link and the truncation, so a long name cuts off, never the tile.
   */
  items: Array<{ key: string; label: ReactNode; value: number; detail?: ReactNode; href?: string; lead?: ReactNode }>;
  max?: number;
  empty?: string;
}

/**
 * Horizontal bars in Graphite alpha. The largest bar is Heat at 40 percent only when it strictly
 * leads, so the orange means "this one, most". When every value is the same (or none passes 1),
 * bars would all read full and say nothing: the list renders as plain rows, label and count.
 */
export function BarList({ items, max, empty = "Nothing yet." }: BarListProps) {
  if (items.length === 0) return <p className="text-body-small text-muted-foreground">{empty}</p>;
  const values = items.map((i) => i.value);
  const highest = Math.max(...values);
  const flat = highest <= 1 || values.every((v) => v === highest);
  const top = max ?? Math.max(highest, 1);
  const leader = values.filter((v) => v === highest).length === 1 ? highest : null;
  const link = (item: BarListProps["items"][number]) =>
    item.href ? (
      <Link href={item.href} className="hover:underline">
        {item.label}
      </Link>
    ) : (
      item.label
    );
  const label = (item: BarListProps["items"][number]) =>
    item.lead ? (
      <div className="flex min-w-0 items-center gap-2">
        {item.lead}
        <div className="truncate text-body-small">{link(item)}</div>
      </div>
    ) : (
      <div className="truncate text-body-small">{link(item)}</div>
    );
  if (flat) {
    // Six rows of "1 round" repeat one fact six times; a column that never changes is left out.
    const shown = items.map((i) => i.detail ?? i.value);
    const repeats = items.length > 1 && shown.every((d) => (typeof d === "string" || typeof d === "number") && d === shown[0]);
    return (
      <ul className="divide-y divide-border-faint">
        {items.map((item, i) => (
          <li key={item.key} className="grid grid-cols-[1fr_auto] items-center gap-x-4 py-2 first:pt-0 last:pb-0">
            {label(item)}
            {!repeats && <div className="text-mono-small text-black-alpha-56 dark:text-muted-foreground">{shown[i]}</div>}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.key} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1">
          {label(item)}
          <div className="text-mono-small text-black-alpha-56 dark:text-muted-foreground">{item.detail ?? item.value}</div>
          <div className="col-span-2 h-1.5 overflow-hidden rounded-full bg-black-alpha-4 dark:bg-white/6">
            <div
              className={cn(
                "h-full rounded-full",
                item.value === leader ? "bg-heat-40 dark:bg-heat-80" : "bg-black-alpha-16 dark:bg-white/20",
              )}
              style={{ width: `${Math.max(3, (item.value / top) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
