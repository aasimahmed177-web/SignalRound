"use client";

import { STAGES, sectorMenu } from "@fireround/core/client";
import { SlidersHorizontal, X } from "lucide-react";
import { parseAsString, useQueryStates } from "nuqs";
import { ViewSwitch } from "@/components/feed/view-switch";
import { PRESET_PARAM, presetParser } from "@/components/preset-switcher";
import { SearchBox, useUrlSearch } from "@/components/search/search-box";
import { Button } from "@/components/ui/button";
import { FilterSelect } from "@/components/ui/filter-select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { type AnalyticsEvents, track } from "@/lib/analytics";
import { stageLabel } from "@/lib/format";
import type { PresetOption } from "@/lib/presets";
import { defaultFeedView, toFeedView } from "@/lib/round-sort";
import { cn } from "@/lib/utils";

const params = {
  q: parseAsString.withDefault(""),
  stage: parseAsString.withDefault(""),
  status: parseAsString.withDefault(""),
  certainty: parseAsString.withDefault(""),
  sector: parseAsString.withDefault(""),
  min: parseAsString.withDefault(""),
  // The table's column headers set this on desktop; a phone has no header row, so the sheet does.
  sort: parseAsString.withDefault(""),
  // The Latest | Trending switch writes this; the filters only read it, to hide the orders Trending replaces.
  view: parseAsString.withDefault(""),
  [PRESET_PARAM]: presetParser,
  // A date range (YYYY-MM-DD) comes from a link or the URL bar; it also admits earlier rounds promoted from dossiers. Cleared here.
  since: parseAsString.withDefault(""),
  until: parseAsString.withDefault(""),
  // A publisher (a source host) and history=exclude come from the Overview's links, which count news rounds only. Cleared here.
  source: parseAsString.withDefault(""),
  history: parseAsString.withDefault(""),
  // Only ever cleared here: a page number (or a cursor from an older link) belongs to the set it was written for.
  page: parseAsString,
  cursor: parseAsString,
};

type FilterPatch = Partial<
  Record<"q" | "stage" | "status" | "certainty" | "sector" | "min" | "sort" | "preset" | "since" | "until" | "source" | "history", string>
>;

/** The product analytics name for each filter the controls set; a date range, a publisher, and history come only from links. */
const FILTER_NAMES: Partial<Record<keyof FilterPatch, AnalyticsEvents["fireround_feed_filtered"]["filter"]>> = {
  q: "search",
  stage: "stage",
  status: "unread",
  certainty: "certainty",
  sector: "sector",
  min: "amount",
  sort: "sort",
  preset: "preset",
};

/** One event per change: the filter and, for a choice from a list, what was chosen. A search sends no text. */
function trackFilter(patch: FilterPatch): void {
  const keys = Object.keys(patch) as Array<keyof FilterPatch>;
  const filter = keys.length > 1 ? "clear_all" : keys[0] && FILTER_NAMES[keys[0]];
  if (!filter) return;
  const value = filter === "search" || filter === "clear_all" ? undefined : patch[keys[0]] || (filter === "sort" ? "newest" : "any");
  track("fireround_feed_filtered", { filter, value });
}

/**
 * The Latest view's orders: "" is newest announced first and "amount" largest first (the table's
 * sortable headers write them on desktop). Trending is a view of its own with one order, its rank.
 */
const SORTS = [
  { value: "", label: "Newest" },
  { value: "amount", label: "Largest" },
];

/** The quiet pill fill every filter control shares. */
const PILL =
  "bg-black-alpha-4 text-black-alpha-56 hover:bg-black-alpha-8 hover:text-foreground dark:bg-white/6 dark:text-muted-foreground dark:hover:bg-white/10";

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "tap relative h-8 shrink-0 whitespace-nowrap rounded-full px-3 text-label-small transition-colors",
        active ? "bg-foreground text-background" : PILL,
      )}
    >
      {children}
    </button>
  );
}

/** The equity ladder the presets cover; bridge, debt, grant, and the rest stay reachable through the URL. */
const VISIBLE_STAGES = STAGES.filter((s) =>
  ["pre_seed", "seed", "series_a", "series_b", "series_c", "series_d_plus", "growth"].includes(s),
);

const AMOUNTS = [
  { value: "", label: "Any amount" },
  { value: "5", label: "$5M and up" },
  { value: "10", label: "$10M and up" },
  { value: "25", label: "$25M and up" },
  { value: "50", label: "$50M and up" },
  { value: "100", label: "$100M and up" },
];

/** One labelled control in the mobile sheet; the select stretches to the sheet's width. */
function SheetField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-label-small text-muted-foreground">{label}</span>
      <div className="[&>button]:h-10 [&>button]:w-full [&>button]:justify-between">{children}</div>
    </div>
  );
}

/**
 * Three rows with one job each. The first is the Latest | Trending switch, with the read state on
 * the right on desktop; on a phone it drops under the search box. The second narrows the set:
 * search, then on desktop the preset, amount, and sector selects. Below `md` those sit in a bottom
 * sheet behind one Filters button that counts what it hides, so the first round stays near the
 * fold. The last is the stage ladder: it wraps on desktop and scrolls sideways on a phone. Every
 * filter applies in both views.
 */
export function FeedFilters({
  sectors,
  presets,
  readOnly = false,
  trendingOn = false,
}: {
  sectors: string[];
  presets: PresetOption[];
  readOnly?: boolean;
  /** Whether this instance runs the Trending lane; a bare /feed opens Trending only then. */
  trendingOn?: boolean;
}) {
  const [f, setFilters] = useQueryStates(params, { shallow: false });
  // Any filter change starts the list from page one; page 4 of the old set means nothing in the new one.
  const setF = (patch: FilterPatch) => {
    setFilters({ ...patch, page: null, cursor: null });
    trackFilter(patch);
  };
  const search = useUrlSearch(f.q, (q) => setF({ q }));

  const stages = f.stage ? f.stage.split(",") : [];
  const toggleStage = (s: string) => {
    const next = stages.includes(s) ? stages.filter((x) => x !== s) : [...stages, s];
    setFilters({ stage: next.join(","), page: null, cursor: null });
    track("fireround_feed_filtered", { filter: "stage", value: s });
  };
  const any = f.q || f.stage || f.status || f.certainty || f.sector || f.min || f.preset || f.since || f.until || f.source;
  // The same rule the page reads (lib/round-sort.ts): a search or filter opens Latest, so typing a
  // name on the bare feed switches the view visibly instead of searching three days of Trending.
  const fallbackView = defaultFeedView(trendingOn, {
    q: f.q,
    stage: f.stage,
    sector: f.sector,
    min: f.min,
    preset: f.preset,
    since: f.since,
    until: f.until,
    source: f.source,
    certainty: f.certainty,
  });
  const trending = toFeedView(f.view, f.sort, fallbackView) === "trending";
  // What the sheet hides; search and stages stay on screen, so they do not count. A non-default
  // order counts too: on a phone the sheet is the only place that says the list is by amount.
  // Trending is on screen in the switch, so it does not.
  const tucked = [f.preset, f.min, f.sector, f.certainty, trending ? "" : f.sort, readOnly ? "" : f.status].filter(Boolean).length;
  const clearAll = () => {
    search.reset();
    setF({ q: "", stage: "", status: "", certainty: "", sector: "", min: "", preset: "", since: "", until: "", source: "", history: "" });
  };

  // "Preset" is the operator's word for a search set; a visitor picks a watchlist.
  const presetWord = readOnly ? "Watchlist" : "Preset";
  const presetSelect = presets.length > 1 && (
    <FilterSelect
      label={presetWord}
      value={f.preset}
      onChange={(v) => setF({ preset: v })}
      options={[
        { value: "", label: readOnly ? "All watchlists" : "All presets" },
        ...presets.map((p) => ({ value: p.slug, label: p.name })),
      ]}
    />
  );
  const amountSelect = <FilterSelect label="Minimum amount" value={f.min} onChange={(v) => setF({ min: v })} options={AMOUNTS} />;
  const sectorSelect = sectors.length > 0 && (
    <FilterSelect
      label="Sector"
      value={f.sector}
      onChange={(v) => setF({ sector: v })}
      options={[{ value: "", label: "Any sector" }, ...sectorMenu(sectors)]}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      {/* First in the DOM and on a desktop; a phone shows it under the search box, where the thumb is. */}
      <div className="order-2 flex items-center gap-2 md:order-1">
        <ViewSwitch className="w-full md:w-auto" fallback={fallbackView} />
        <div className="ml-auto hidden items-center gap-2 md:flex">
          <label htmlFor="feed-include-unannounced-desktop" className="flex items-center gap-2 text-label-small text-muted-foreground">
            <Switch
              id="feed-include-unannounced-desktop"
              checked={f.certainty !== "announced"}
              onCheckedChange={(on) => setF({ certainty: on ? "" : "announced" })}
            />
            Include early reports
          </label>
          <label htmlFor="feed-include-unconfirmed-desktop" className="flex items-center gap-2 text-label-small text-muted-foreground">
            <Switch
              id="feed-include-unconfirmed-desktop"
              checked={f.certainty === "all"}
              onCheckedChange={(on) => setF({ certainty: on ? "all" : "" })}
            />
            Include unconfirmed
          </label>
          {!readOnly && (
            <Chip active={f.status === "new"} onClick={() => setF({ status: f.status === "new" ? "" : "new" })}>
              Unread only
            </Chip>
          )}
          {any && (
            <Button variant="ghost" size="sm" onClick={clearAll}>
              <X className="size-3.5" /> Clear
            </Button>
          )}
        </div>
      </div>
      <div className="order-1 flex items-center gap-2 md:order-2 md:flex-wrap">
        <SearchBox
          value={search.draft}
          onChange={search.setDraft}
          onClear={() => {
            search.reset();
            setF({ q: "" });
          }}
          placeholder="Company, description, investor"
          label="Search rounds"
          className="min-w-0 flex-1 md:w-72 md:flex-none"
        />

        <Sheet>
          <SheetTrigger asChild>
            <button
              type="button"
              className={cn(
                "tap relative flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-label-small transition-colors md:hidden",
                tucked ? "bg-black-alpha-8 text-foreground dark:bg-white/10" : PILL,
              )}
            >
              <SlidersHorizontal className="size-3.5" />
              Filters
              {tucked > 0 && (
                <span className="flex size-4 items-center justify-center rounded-full bg-foreground text-mono-x-small text-background">
                  {tucked}
                </span>
              )}
            </button>
          </SheetTrigger>
          <SheetContent side="bottom" className="max-h-[85dvh] gap-0 rounded-t-12 pb-[env(safe-area-inset-bottom)]">
            <SheetHeader className="pb-2">
              <SheetTitle>Filters</SheetTitle>
              <SheetDescription className="text-body-small">Changes apply as you pick them.</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-4 overflow-y-auto px-4 py-2">
              {/* Trending has one order, its rank, so the sheet offers a sort only in the Latest view. */}
              {!trending && (
                <div className="flex flex-col gap-1.5">
                  <span id="feed-sort-label" className="text-label-small text-muted-foreground">
                    Sort
                  </span>
                  {/* Sorting is not a filter, so Clear all leaves it; every order runs one way, as the headers do. */}
                  <div role="group" aria-labelledby="feed-sort-label" className="flex gap-1.5">
                    {SORTS.map((o) => (
                      <Chip key={o.value} active={f.sort === o.value} onClick={() => setF({ sort: o.value })}>
                        {o.label}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}
              {presetSelect && <SheetField label={presetWord}>{presetSelect}</SheetField>}
              <SheetField label="Minimum amount">{amountSelect}</SheetField>
              {sectorSelect && <SheetField label="Sector">{sectorSelect}</SheetField>}
              <div className="flex items-center justify-between gap-3 py-1">
                <label htmlFor="feed-include-unannounced" className="text-label-medium">
                  Include early reports
                </label>
                <Switch
                  id="feed-include-unannounced"
                  checked={f.certainty !== "announced"}
                  onCheckedChange={(on) => setF({ certainty: on ? "" : "announced" })}
                />
              </div>
              <div className="flex items-center justify-between gap-3 py-1">
                <label htmlFor="feed-include-unconfirmed" className="text-label-medium">
                  Include unconfirmed
                </label>
                <Switch
                  id="feed-include-unconfirmed"
                  checked={f.certainty === "all"}
                  onCheckedChange={(on) => setF({ certainty: on ? "all" : "" })}
                />
              </div>
              {!readOnly && (
                <div className="flex items-center justify-between gap-3 py-1">
                  <label htmlFor="feed-unread-only" className="text-label-medium">
                    Unread only
                  </label>
                  <Switch id="feed-unread-only" checked={f.status === "new"} onCheckedChange={(on) => setF({ status: on ? "new" : "" })} />
                </div>
              )}
            </div>
            <SheetFooter className="flex-row items-center justify-between border-t border-border-faint">
              <Button variant="ghost" size="sm" onClick={clearAll} disabled={!any}>
                <X className="size-3.5" /> Clear all
              </Button>
              <SheetClose asChild>
                <Button size="sm">Done</Button>
              </SheetClose>
            </SheetFooter>
          </SheetContent>
        </Sheet>

        <div className="hidden items-center gap-2 md:flex">
          {presetSelect}
          {amountSelect}
          {sectorSelect}
        </div>
      </div>
      {/* Bleeds to the screen edge on a phone and fades there, so the row reads as one that scrolls. */}
      <div
        className={cn(
          "order-3 -mx-4 flex items-center gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          "[mask-image:linear-gradient(to_right,transparent,black_1rem,black_calc(100%-2rem),transparent)]",
          "md:mx-0 md:flex-wrap md:overflow-visible md:px-0 md:[mask-image:none]",
        )}
      >
        <Chip active={stages.length === 0} onClick={() => setF({ stage: "" })}>
          All stages
        </Chip>
        <span className="mx-1 h-4 w-px shrink-0 bg-border-muted" aria-hidden />
        {VISIBLE_STAGES.map((s) => (
          <Chip key={s} active={stages.includes(s)} onClick={() => toggleStage(s)}>
            {stageLabel(s)}
          </Chip>
        ))}
      </div>
    </div>
  );
}
