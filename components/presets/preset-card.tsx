"use client";

import type { Preset } from "@fireround/core";
import { Bot, ChevronDown, ChevronRight, Ellipsis, FileJson, Pencil, Play, Radio, Sparkles, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";
import { createMonitor, deleteMonitor, deletePreset, runMonitorCheck, startEnrich, startSweep } from "@/app/(dashboard)/presets/actions";
import { PresetDialog } from "@/components/presets/preset-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tag } from "@/components/ui/tag";
import { stageLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Estimate {
  searches: number;
  results: number;
  pagesLow: number;
  pagesHigh: number;
  xAccounts: number;
  xCredits: number;
  records: number;
  sweepLow: number;
  sweepHigh: number;
  verificationCredits: number;
  corroborationCredits: number;
  enrichmentCredits: number;
  alexandriaCredits: number;
  creditsLow: number;
  creditsHigh: number;
  watchSites: number;
  watchEnabled: boolean;
  watchCadence: "daily" | "hourly";
  watchReadCredits: number;
}

interface MonitorInfo {
  monitor_id: string;
  estimated_credits_per_month: number | null;
  created_at: string;
}

const SECONDARY = "text-black-alpha-56 dark:text-muted-foreground";

/** How many rows a list shows at rest; the rest sit behind a "show all" disclosure. */
const LIST_REST = 6;

/**
 * A mono list under a bracket eyebrow. Past LIST_REST items it folds, so a preset with a dozen
 * queries or watch sites keeps the card at a readable height. Items are the preset's own strings,
 * so each is its row's key; render dresses one up when the row is more than the text.
 */
function ListBlock({
  eyebrow,
  items,
  render = (item) => item,
  className,
}: {
  eyebrow: string;
  items: string[];
  render?: (item: string) => ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, LIST_REST);
  const hidden = items.length - LIST_REST;
  return (
    <div className={className}>
      <div className="mb-1.5">
        <Tag>{eyebrow}</Tag>
      </div>
      <ul className={cn("space-y-1 text-mono-small font-normal", SECONDARY)}>
        {shown.map((item) => (
          <li key={item} className="min-w-0 truncate">
            {render(item)}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn("mt-1.5 flex h-6 items-center gap-1 text-label-x-small hover:text-foreground", SECONDARY)}
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          {open ? "show fewer" : `show all (${items.length})`}
        </button>
      )}
    </div>
  );
}

/** Whole credits with a thousands separator: "1,808 to 1,928" scans faster than "1808 to 1928". */
function credits(n: number): string {
  return n.toLocaleString("en-US");
}

function creditRange(low: number, high: number): string {
  return low === high ? credits(low) : `${credits(low)} to ${credits(high)}`;
}

/** A credit range with the figures in mono and the joining word in the text face. */
function Range({ low, high }: { low: number; high: number }) {
  return (
    <>
      <span className="font-mono tabular-nums">{credits(low)}</span>
      {high !== low && (
        <>
          {" "}
          to <span className="font-mono tabular-nums">{credits(high)}</span>
        </>
      )}
    </>
  );
}

/** One line of the estimate breakdown: what it pays for, what drives it, and the credits in mono. */
function CostRow({ label, detail, value }: { label: string; detail?: string; value: ReactNode }) {
  return (
    <li className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="min-w-0">
        <span className="text-label-small">{label}</span>
        {detail && <span className={cn("block text-label-x-small font-normal", SECONDARY)}>{detail}</span>}
      </span>
      <span className="shrink-0 text-label-small">{value}</span>
    </li>
  );
}

/**
 * The run estimate: one headline figure, and the lines that make it up behind a popover so the
 * card header stays two lines tall. Watch sites sit apart because they bill per check, not per run.
 */
function EstimateSummary({ estimate }: { estimate: Estimate }) {
  const e = estimate;
  return (
    <div className="flex shrink-0 flex-col items-start sm:items-end sm:text-right">
      <Tag>run estimate</Tag>
      <div className="mt-0.5 text-title-h6">
        <Range low={e.creditsLow} high={e.creditsHigh} />{" "}
        <span className={cn("text-body-small font-normal", SECONDARY)}>credits a run</span>
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn("-mx-1 mt-0.5 flex h-6 items-center gap-1 rounded-6 px-1 text-label-x-small hover:text-foreground", SECONDARY)}
          >
            What it pays for <ChevronDown className="size-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
          <div className="text-label-medium">What a run costs</div>
          <p className={cn("mt-0.5 text-label-x-small font-normal", SECONDARY)}>
            A week sweep priced from the rate card, for about {e.records} new records.
          </p>
          <ul className="mt-2 divide-y divide-border-faint">
            <CostRow
              label="Search and pages"
              detail={`${e.searches} searches, ${e.results} results, ${creditRange(e.pagesLow, e.pagesHigh)} pages`}
              value={<Range low={e.sweepLow} high={e.sweepHigh} />}
            />
            {e.xCredits > 0 && (
              <CostRow
                label="X timelines"
                detail={`${e.xAccounts} ${e.xAccounts === 1 ? "account" : "accounts"}`}
                value={<Range low={e.xCredits} high={e.xCredits} />}
              />
            )}
            <CostRow
              label="Verification"
              detail="Each record read back before it publishes"
              value={<Range low={e.verificationCredits} high={e.verificationCredits} />}
            />
            {e.corroborationCredits > 0 && (
              <CostRow
                label="Corroboration"
                detail="Second sources for each record"
                value={<Range low={e.corroborationCredits} high={e.corroborationCredits} />}
              />
            )}
            <CostRow
              label="Enrichment"
              detail="Company profile and logo"
              value={<Range low={e.enrichmentCredits} high={e.enrichmentCredits} />}
            />
            {e.alexandriaCredits > 0 && (
              <CostRow
                label="Alexandria"
                detail="Sourced company facts"
                value={<Range low={e.alexandriaCredits} high={e.alexandriaCredits} />}
              />
            )}
          </ul>
          <div className="mt-1 flex items-baseline justify-between gap-4 border-t border-border-muted pt-2">
            <span className="text-label-small">A run</span>
            <span className="text-label-small">
              <Range low={e.creditsLow} high={e.creditsHigh} />
            </span>
          </div>
          {e.watchSites > 0 && (
            <p className={cn("mt-3 border-t border-border-faint pt-2 text-label-x-small font-normal", SECONDARY)}>
              <span className="text-foreground">
                {e.watchSites} watch {e.watchSites === 1 ? "site" : "sites"}
              </span>{" "}
              {e.watchEnabled
                ? `checked ${e.watchCadence}, billed apart from the run: ${credits(e.watchReadCredits)} credits a check, plus 5 for each new page.`
                : "are off at this coverage rung."}
            </p>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Anything a preset action returns: the ActionResult shape, success carrying whatever the action adds. */
type Result = { ok: true } | { ok: false; error: string };

/** `custom` marks a database preset: it can be edited and deleted here, where a file preset is edited on disk. */
export function PresetCard({
  preset,
  estimate,
  monitor,
  custom = false,
}: {
  preset: Preset;
  estimate: Estimate;
  monitor: MonitorInfo | null;
  custom?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const { confirm, dialog } = useConfirm();

  /**
   * Every action reports through one toast: loading while the server works, then success or the
   * error. Work that lands on the Runs page (sweeps, enrichment, checks) carries a link there.
   */
  const act = <R extends Result>(
    loading: string,
    fn: () => Promise<R>,
    done: (r: Extract<R, { ok: true }>) => { title: string; description?: string },
    { runs = false }: { runs?: boolean } = {},
  ) =>
    start(async () => {
      const id = toast.loading(loading, { description: preset.name });
      try {
        const r = await fn();
        if (!r.ok) {
          toast.error(r.error, { id, description: preset.name });
          return;
        }
        const { title, description } = done(r as Extract<R, { ok: true }>);
        toast.success(title, {
          id,
          description: description ?? preset.name,
          action: runs ? { label: "Open Runs", onClick: () => router.push("/runs") } : undefined,
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err), { id, description: preset.name });
      }
    });

  const sweep = (window: "day" | "week") =>
    act(
      window === "week" ? "Starting a week sweep" : "Starting a day sweep",
      () => startSweep(preset.slug, window),
      (r) => ({ title: window === "week" ? "Week sweep started" : "Day sweep started", description: `Run ${r.value.runId.slice(0, 8)}` }),
      { runs: true },
    );

  const removePreset = async () => {
    const ok = await confirm({
      title: `Delete ${preset.name}?`,
      description: "The preset and its monitor go. Rounds it already found stay in the feed.",
      confirmLabel: "Delete preset",
    });
    if (!ok) return;
    act(
      "Deleting preset",
      () => deletePreset(preset.slug),
      () => ({ title: "Preset deleted" }),
    );
  };

  const removeMonitor = async () => {
    const ok = await confirm({
      title: `Delete the monitor for ${preset.name}?`,
      description:
        "native web tools stops checking for new rounds between sweeps. Rounds it found stay; you can create the monitor again later.",
      confirmLabel: "Delete monitor",
    });
    if (!ok) return;
    act(
      "Deleting monitor",
      () => deleteMonitor(preset.slug),
      () => ({ title: "Monitor deleted" }),
    );
  };

  return (
    <article className="rounded-12 border border-border-faint bg-card">
      <header className="flex flex-col gap-4 border-b border-border-faint px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="min-w-0 truncate text-title-h6">{preset.name}</h2>
            <Tag tone="faint" preserveCase>
              {preset.slug}
            </Tag>
            {custom && <Tag tone="heat">custom</Tag>}
          </div>
          <p className={cn("mt-1 text-body-small", SECONDARY)}>{preset.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Tag>stages</Tag>
            {preset.stages.map((s) => (
              <Badge key={s} variant="outline" className="text-label-x-small font-normal">
                {stageLabel(s)}
              </Badge>
            ))}
          </div>
        </div>
        <EstimateSummary estimate={estimate} />
      </header>

      {/* Recall on the left (queries, timelines), precision on the right (goal, the sections it watches). */}
      <div className="grid gap-6 px-5 py-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <ListBlock eyebrow="queries · recall" items={preset.queries} />
          {preset.xAccounts.length > 0 && (
            <ListBlock
              eyebrow="X accounts · timelines"
              items={preset.xAccounts}
              render={(h) => (
                <a href={`https://x.com/${h}`} target="_blank" rel="noreferrer" className="hover:underline">
                  @{h}
                </a>
              )}
            />
          )}
        </div>
        <div className="min-w-0 space-y-4">
          <div>
            <div className="mb-1.5">
              <Tag>goal · precision</Tag>
            </div>
            <p className={cn("text-body-small", SECONDARY)}>{preset.goal}</p>
            <p className={cn("mt-2 text-label-x-small font-normal", SECONDARY)}>
              Monitor: {preset.monitor.schedule} ({preset.monitor.timezone}), window {preset.monitor.searchWindow}, up to{" "}
              {preset.monitor.maxResults} results a check
            </p>
          </div>
          {preset.watchSites.length > 0 && (
            <ListBlock
              eyebrow="watch sites · sections"
              items={preset.watchSites}
              render={(u) => (
                <a href={u} target="_blank" rel="noreferrer" className="hover:underline" title={u}>
                  {u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                </a>
              )}
            />
          )}
        </div>
      </div>

      {/* One primary per card (the sweep, with its window folded into a split button), one secondary,
          the monitor as a single group, and everything rarer or destructive behind the overflow. */}
      {/* Below sm the monitor group drops to its own row so the overflow stays beside the sweep. */}
      <footer className="flex flex-wrap items-center gap-2 rounded-b-12 border-t border-border-faint bg-bg-lighter px-5 py-3">
        <div className="inline-flex">
          <Button size="sm" className="rounded-r-none" disabled={pending} onClick={() => sweep("week")} title="Sweep the past week">
            <Play className="size-3.5" /> Run sweep
          </Button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                className="w-6 rounded-l-none border-l-primary-foreground/30"
                disabled={pending}
                aria-label="Choose the sweep window"
              >
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Sweep window</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => sweep("week")}>
                Past week <span className={cn("ml-auto text-label-x-small font-normal", SECONDARY)}>default</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => sweep("day")}>Past day</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            act(
              "Starting enrichment",
              () => startEnrich(preset.slug),
              (r) => ({ title: "Enrichment started", description: `Run ${r.value.runId.slice(0, 8)}` }),
              { runs: true },
            )
          }
        >
          {/* "Enrich" alone below sm keeps the sweep, enrich, and overflow on one row at 390px. */}
          <Sparkles className="size-3.5" /> Enrich<span className="hidden sm:inline"> companies</span>
        </Button>
        {monitor ? (
          <div className="order-last inline-flex h-7 items-center overflow-hidden sm:order-none rounded-[min(var(--radius-md),12px)] border border-border bg-background dark:border-input dark:bg-input/30">
            <span className="flex items-center gap-1.5 pr-2 pl-2.5 text-label-small" title={`Monitor ${monitor.monitor_id}`}>
              <Radio className="size-3.5 text-forest-ink" /> Monitor live
              <span className={cn("font-mono text-label-x-small font-normal tabular-nums", SECONDARY)}>
                ~{monitor.estimated_credits_per_month != null ? credits(monitor.estimated_credits_per_month) : "?"} cr/mo
              </span>
            </span>
            <span className="h-full w-px bg-border" aria-hidden />
            <Button
              size="sm"
              variant="ghost"
              className="h-full rounded-none"
              disabled={pending}
              onClick={() =>
                act(
                  "Running a monitor check",
                  () => runMonitorCheck(preset.slug),
                  (r) => ({
                    title: `${r.value.alerted} ${r.value.alerted === 1 ? "alert" : "alerts"}, ${r.value.started} new ${r.value.started === 1 ? "candidate" : "candidates"}`,
                    description: `Check ${r.value.checkId.slice(0, 8)}, ${r.value.credits ?? "?"} credits`,
                  }),
                  { runs: true },
                )
              }
            >
              <Bot className="size-3.5" /> Check now
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="order-last sm:order-none"
            disabled={pending}
            onClick={() =>
              act(
                "Creating monitor",
                () => createMonitor(preset.slug),
                (r) => ({
                  title: "Monitor created",
                  description: `About ${r.value.estimatedCreditsPerMonth != null ? credits(r.value.estimatedCreditsPerMonth) : "?"} credits a month`,
                }),
              )
            }
          >
            <Radio className="size-3.5" /> Create monitor
          </Button>
        )}
        {/* Non-modal so the edit dialog and the confirm can take focus as the menu closes. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" className="ml-auto" disabled={pending} aria-label={`More actions for ${preset.name}`}>
              <Ellipsis className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {custom ? (
              <>
                <DropdownMenuItem onSelect={() => setEditing(true)}>
                  <Pencil /> Edit preset
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={removePreset}>
                  <Trash2 /> Delete preset
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem disabled>
                <FileJson /> File preset: edit presets/{preset.slug}.json
              </DropdownMenuItem>
            )}
            {monitor && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={removeMonitor}>
                  <Trash2 /> Delete monitor
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </footer>
      {custom && <PresetDialog preset={preset} open={editing} onOpenChange={setEditing} />}
      {dialog}
    </article>
  );
}
