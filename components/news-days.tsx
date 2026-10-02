"use client";

import { type ReactNode, useMemo, useSyncExternalStore } from "react";
import { dayHeading, newsDay } from "@/lib/news-format";

export interface NewsDayEntry {
  key: string;
  /** The article's published time (or when it was read, undated): a date or a timestamp. */
  at: string;
  /** The card, rendered on the server. */
  node: ReactNode;
}

const noSubscribe = () => () => {};

/**
 * The News list under its day headings, grouped on the reader's calendar. The server knows only
 * UTC, so it groups and heads by UTC days; hydration regroups by the browser's zone, as RelativeDay
 * does for each card's own "today". Before this the header was cut on the server, and an American
 * evening read "Yesterday" over thirty cards that each said "today". Order is the server's.
 */
export function NewsDays({ entries }: { entries: NewsDayEntry[] }) {
  const utc = useSyncExternalStore(
    noSubscribe,
    () => false,
    () => true,
  );
  const groups = useMemo(() => {
    const byDay = new Map<string, NewsDayEntry[]>();
    for (const e of entries) {
      const day = newsDay(e.at, { utc });
      byDay.set(day, [...(byDay.get(day) ?? []), e]);
    }
    return [...byDay.entries()];
  }, [entries, utc]);
  const now = new Date();
  return groups.map(([day, list]) => (
    <section key={day}>
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-label-small" title={day}>
          {dayHeading(day, now, { utc })}
        </h2>
        <span className="h-px flex-1 bg-border-faint" />
        <span className="text-label-x-small text-black-alpha-56">
          <span className="font-mono tabular-nums">{list.length}</span> {list.length === 1 ? "article" : "articles"}
        </span>
      </div>
      <ul className="divide-y divide-border-faint overflow-hidden rounded-12 border border-border-faint bg-card">
        {list.map((e) => (
          <li key={e.key}>{e.node}</li>
        ))}
      </ul>
    </section>
  ));
}
