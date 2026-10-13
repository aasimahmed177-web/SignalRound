"use client";

import { Clock, TrendingUp } from "lucide-react";
import { parseAsString, useQueryStates } from "nuqs";
import { type KeyboardEvent, useRef } from "react";
import { track } from "@/lib/analytics";
import { FEED_VIEW_PANEL, type FeedView, toFeedView, viewTabId } from "@/lib/round-sort";
import { cn } from "@/lib/utils";

const VIEWS: Array<{ value: FeedView; label: string; icon: typeof Clock }> = [
  { value: "latest", label: "Latest", icon: Clock },
  { value: "trending", label: "Trending", icon: TrendingUp },
];

/**
 * `view` is the switch's own param; `sort` is read for its older `sort=trending` spelling and is
 * reset on every switch, since an order belongs to the view it was picked in. A new view starts
 * from page one, so the page and any cursor go too.
 */
const viewParams = {
  view: parseAsString.withDefault(""),
  sort: parseAsString.withDefault(""),
  page: parseAsString,
  cursor: parseAsString,
};

/**
 * Latest | Trending, the feed's two views, as a segmented control: a pill track with the active
 * view raised on it. The WAI-ARIA tabs pattern with automatic activation, as the landing page's
 * code tabs do it: one tab stop, arrow keys (and Home, End) move and switch.
 */
export function ViewSwitch({ className, fallback = "latest" }: { className?: string; fallback?: FeedView }) {
  const [p, set] = useQueryStates(viewParams, { shallow: false });
  const view = toFeedView(p.view, p.sort, fallback);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  // The view a bare /feed opens stays out of the URL; the other one is written, so a shared link keeps it.
  const go = (next: FeedView) => {
    if (next === view) return;
    set({ view: next === fallback ? null : next, sort: null, page: null, cursor: null });
    track("fireround_feed_filtered", { filter: "view", value: next });
  };
  const onKey = (e: KeyboardEvent) => {
    const at = VIEWS.findIndex((v) => v.value === view);
    const to =
      e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? VIEWS.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const i = (to + VIEWS.length) % VIEWS.length;
    go(VIEWS[i].value);
    refs.current[i]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label="Feed view"
      onKeyDown={onKey}
      className={cn("grid grid-cols-2 gap-0.5 rounded-full bg-black-alpha-4 p-0.5 text-label-small dark:bg-white/6", className)}
    >
      {VIEWS.map((v, i) => {
        const active = v.value === view;
        // Trending selected takes the heat tint, so the ranked view reads as on at a glance; Latest stays neutral.
        const hot = active && v.value === "trending";
        const Icon = v.icon;
        return (
          <button
            key={v.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={viewTabId(v.value)}
            aria-selected={active}
            aria-controls={FEED_VIEW_PANEL}
            tabIndex={active ? 0 : -1}
            onClick={() => go(v.value)}
            className={cn(
              "tap relative flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-full px-4 whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              hot
                ? "bg-card text-heat-ink shadow-xs ring-1 ring-heat-40 dark:bg-heat-12 dark:text-heat-100 dark:ring-heat-40"
                : active
                  ? "bg-card text-foreground shadow-xs ring-1 ring-black-alpha-8 dark:bg-white/14 dark:ring-white/10"
                  : "text-black-alpha-56 hover:bg-black-alpha-4 hover:text-foreground dark:text-muted-foreground dark:hover:bg-white/6",
            )}
          >
            <Icon className={cn("size-3.5", hot && "text-heat-100")} aria-hidden />
            {v.label}
          </button>
        );
      })}
    </div>
  );
}
