"use client";

import type { Preset } from "@fireround/core";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { type ReactNode, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { setCoverage } from "@/app/(dashboard)/settings/actions";
import { Disclosure } from "@/components/settings/disclosure";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Panel } from "@/components/ui/stat";
import { Switch } from "@/components/ui/switch";
import { Tag } from "@/components/ui/tag";
import {
  COVERAGE_BLURBS,
  COVERAGE_LABELS,
  COVERAGE_TIERS,
  type CoveragePlan,
  type CoverageSetting,
  type CoverageTier,
  coverageFor,
  diffCoverage,
  estimateMonthlyCredits,
  resolveCoverage,
} from "@/lib/coverage";
import { compact } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Whole thousands once a figure passes 100K: "477K to 488K" reads faster than "476.7K to 487.5K" and fits a rung card. */
function figure(n: number): string {
  return n >= 100_000 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 0 }).format(n) : compact(n);
}

function range(low: number, high: number): string {
  const a = figure(low);
  const b = figure(high);
  return a === b ? a : `${a} to ${b}`;
}

type SweepWindows = CoveragePlan["sweep"]["windows"];

/** Window combinations the sweep clock understands, as one select. */
const WINDOW_CHOICES: Array<{ value: string; label: string; windows: SweepWindows }> = [
  { value: "week", label: "week window", windows: ["week"] },
  { value: "day", label: "day window", windows: ["day"] },
  { value: "day+week", label: "day window, plus the week window on Monday", windows: ["day", "week"] },
];

/** One row per control: the label left, the h-8 control right, on the same hairline list as its siblings. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 py-2">
      <span className="min-w-0 text-body-small">{label}</span>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
}) {
  return (
    <NativeSelect aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </NativeSelect>
  );
}

export function CoveragePanel({ setting, presets, monitors }: { setting: CoverageSetting; presets: Preset[]; monitors: number }) {
  const [pending, start] = useTransition();
  const [tier, setTier] = useState<CoverageTier>(setting.tier);
  const [plan, setPlan] = useState<CoveragePlan>(() => resolveCoverage(setting));
  const [saved, setSaved] = useState<CoverageSetting>(setting);
  const [advanced, setAdvanced] = useState(false);

  const overrides = useMemo(() => diffCoverage(tier, plan), [tier, plan]);
  const overrideCount = Object.keys(overrides).length;
  const dirty = JSON.stringify({ tier, overrides }) !== JSON.stringify(saved);
  const tierEstimates = useMemo(
    () =>
      Object.fromEntries(COVERAGE_TIERS.map((t) => [t, estimateMonthlyCredits(coverageFor(t), presets, monitors)])) as Record<
        CoverageTier,
        ReturnType<typeof estimateMonthlyCredits>
      >,
    [presets, monitors],
  );
  const estimate = useMemo(() => estimateMonthlyCredits(plan, presets, monitors), [plan, presets, monitors]);

  const pickTier = (t: CoverageTier) => {
    setTier(t);
    setPlan(coverageFor(t));
  };
  const edit = (fn: (p: CoveragePlan) => void) => {
    setPlan((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  };
  const windowChoice =
    WINDOW_CHOICES.find((c) => JSON.stringify(c.windows) === JSON.stringify([...plan.sweep.windows].sort()))?.value ?? "day+week";

  return (
    <Panel
      title="Coverage"
      code="LITE · STANDARD · DEEP · MAX"
      action={
        <Button
          size="sm"
          disabled={pending || !dirty}
          onClick={() =>
            start(async () => {
              const next = { tier, overrides };
              const id = toast.loading("Saving coverage");
              try {
                const r = await setCoverage(next);
                if (r.ok) {
                  setSaved(next);
                  toast.success("Saved", { id, description: `The next cron tick runs ${COVERAGE_LABELS[tier]}.` });
                } else {
                  toast.error(r.error, { id });
                }
              } catch (err) {
                toast.error(err instanceof Error ? err.message : String(err), { id });
              }
            })
          }
        >
          Save
        </Button>
      }
    >
      <p className="text-body-small text-muted-foreground">One knob for how wide the net, how deep each read, and how often it all runs.</p>
      <Disclosure summary="How the estimate works" className="mt-1 mb-4">
        <p>
          Every rung is the same product; credits scale with the rung. The estimate is for the current{" "}
          {presets.length === 1 ? "preset" : `${presets.length} presets`}
          {monitors > 0 ? ` and ${monitors} live ${monitors === 1 ? "monitor" : "monitors"}` : ""}, priced from the rate card; the method is
          in <code className="font-mono">docs/coverage.md</code>.
        </p>
      </Disclosure>

      {/* Every rung card shares one skeleton: a title row that keeps its height with or without a tag, a
          figure row, a fixed unit line, and a clamped blurb, so the four prices sit on one baseline. */}
      <div role="radiogroup" aria-label="Coverage rung" className="grid items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {COVERAGE_TIERS.map((t) => {
          const selected = t === tier;
          const e = tierEstimates[t];
          return (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => pickTier(t)}
              className={cn(
                "flex h-full flex-col rounded-12 border p-4 text-left transition-colors",
                selected ? "border-heat-100 bg-heat-4" : "border-border-faint bg-card hover:bg-bg-lighter",
              )}
            >
              <div className="flex h-5 items-center justify-between gap-2">
                <span className={cn("truncate text-label-medium", selected && "text-heat-ink")}>{COVERAGE_LABELS[t]}</span>
                {t === "lite" && <Tag>DEFAULT</Tag>}
              </div>
              <div className="mt-2 truncate text-title-h6 tabular-nums">{range(e.low, e.high)}</div>
              <div className="text-body-small text-black-alpha-56 dark:text-muted-foreground">credits / month</div>
              <p className="mt-2 line-clamp-3 text-body-small text-black-alpha-56 dark:text-muted-foreground">{COVERAGE_BLURBS[t]}</p>
            </button>
          );
        })}
      </div>

      <div className="mt-6">
        <div className="mb-1">
          <Tag>
            ESTIMATE · {COVERAGE_LABELS[tier]}
            {overrideCount > 0 ? ` · ${overrideCount} ${overrideCount === 1 ? "override" : "overrides"}` : ""}
          </Tag>
        </div>
        <ul className="divide-y divide-border-faint">
          {estimate.lines.map((l) => (
            <li key={l.label} className="flex items-center justify-between gap-4 py-2.5 text-body-small">
              <span className="min-w-0 truncate">{l.label}</span>
              <span className="shrink-0 text-mono-small text-black-alpha-56 dark:text-muted-foreground">{range(l.low, l.high)}</span>
            </li>
          ))}
          <li className="flex items-center justify-between gap-4 border-t border-border-muted py-2.5 text-label-medium">
            <span>A month</span>
            <span className="shrink-0 text-mono-small">{range(estimate.low, estimate.high)} credits</span>
          </li>
        </ul>
      </div>

      <div className="mt-6 border-t border-border-faint pt-4">
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="flex h-8 items-center gap-2 text-label-small text-black-alpha-72 hover:text-foreground dark:text-muted-foreground"
          aria-expanded={advanced}
        >
          {advanced ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          Advanced
          <span className="text-label-x-small font-normal text-muted-foreground">every field as an override</span>
        </button>
        {advanced && (
          <div className="mt-3 grid gap-x-8 lg:grid-cols-2">
            <div className="divide-y divide-border-faint">
              <Field label="Sweep cadence">
                <Select
                  label="Sweep cadence"
                  value={plan.sweep.cadence}
                  options={[
                    ["weekly", "weekly"],
                    ["daily", "daily"],
                    ["twice_daily", "twice daily"],
                    ["hourly", "hourly"],
                  ]}
                  onChange={(v) => edit((p) => (p.sweep.cadence = v))}
                />
              </Field>
              <Field label="Sweep windows">
                <Select
                  label="Sweep windows"
                  value={windowChoice}
                  options={WINDOW_CHOICES.map((c) => [c.value, c.label])}
                  onChange={(v) => edit((p) => (p.sweep.windows = WINDOW_CHOICES.find((c) => c.value === v)?.windows ?? ["week"]))}
                />
              </Field>
              <Field label="Search sources">
                <Select
                  label="Search sources"
                  value={plan.sources.includes("web") ? "news+web" : "news"}
                  options={[
                    ["news", "news"],
                    ["news+web", "news + web"],
                  ]}
                  onChange={(v) => edit((p) => (p.sources = v === "news" ? ["news"] : ["news", "web"]))}
                />
              </Field>
              <Field label="X accounts read per sweep, at most">
                <Input
                  aria-label="X accounts read per sweep, at most"
                  type="number"
                  min={0}
                  max={10}
                  value={plan.xAccountsMax}
                  onChange={(e) => edit((p) => (p.xAccountsMax = Math.max(0, Math.min(10, Number(e.target.value) || 0))))}
                  className="h-8 w-20"
                />
              </Field>
              <Field label="Watch sites">
                <Switch
                  aria-label="Watch sites"
                  checked={plan.watchSites.enabled}
                  onCheckedChange={(v) => edit((p) => (p.watchSites.enabled = v))}
                />
                <Select
                  label="Watch sites cadence"
                  value={plan.watchSites.cadence}
                  options={[
                    ["daily", "daily"],
                    ["hourly", "hourly"],
                  ]}
                  onChange={(v) => edit((p) => (p.watchSites.cadence = v))}
                />
              </Field>
              <Field label="SEC Form D">
                <Switch aria-label="SEC Form D" checked={plan.formD.enabled} onCheckedChange={(v) => edit((p) => (p.formD.enabled = v))} />
                <Select
                  label="SEC Form D cadence"
                  value={plan.formD.cadence}
                  options={[
                    ["daily", "daily"],
                    ["hourly", "hourly"],
                  ]}
                  onChange={(v) => edit((p) => (p.formD.cadence = v))}
                />
              </Field>
              <Field label="Monitor cadence">
                <Select
                  label="Monitor cadence"
                  value={plan.monitorSchedule}
                  options={[
                    ["daily at 9am", "daily"],
                    ["every 6 hours", "four times a day"],
                    ["hourly", "hourly"],
                  ]}
                  onChange={(v) => edit((p) => (p.monitorSchedule = v))}
                />
              </Field>
            </div>
            <div className="divide-y divide-border-faint">
              <Field label="Corroboration">
                <Select
                  label="Corroboration"
                  value={plan.corroboration}
                  options={[
                    ["off", "off"],
                    ["new", "new records"],
                    ["new_and_updated", "new and updated records"],
                    ["all", "every record"],
                  ]}
                  onChange={(v) => edit((p) => (p.corroboration = v))}
                />
              </Field>
              <Field label="Enrichment">
                <Select
                  label="Enrichment"
                  value={plan.enrichment}
                  options={[
                    ["homepage", "homepage profile and logo"],
                    ["homepage_pricing", "plus the pricing page"],
                    ["plus_corroboration", "plus corroboration sources"],
                    ["weekly_reenrich", "plus weekly re-enrichment"],
                  ]}
                  onChange={(v) => edit((p) => (p.enrichment = v))}
                />
              </Field>
              <Field label="Alexandria">
                <Select
                  label="Alexandria"
                  value={plan.alexandria}
                  options={[
                    ["off", "off"],
                    ["yc", "Y Combinator records"],
                    ["yc_firmographics", "plus FullEnrich and Apollo firmographics"],
                  ]}
                  onChange={(v) => edit((p) => (p.alexandria = v))}
                />
              </Field>
              <Field label="Trending (X, press, Hacker News)">
                <Switch aria-label="Trending" checked={plan.trending} onCheckedChange={(v) => edit((p) => (p.trending = v))} />
              </Field>
              <Field label="Agent gap-fill on review items">
                <Select
                  label="Agent gap-fill on review items"
                  value={plan.agent.gapFill}
                  options={[
                    ["manual", "manual (Research button)"],
                    ["auto", "automatic"],
                  ]}
                  onChange={(v) => edit((p) => (p.agent.gapFill = v))}
                />
              </Field>
              <Field label="Agent deep dive">
                <Select
                  label="Agent deep dive"
                  value={plan.agent.deepDive}
                  options={[
                    ["manual", "manual"],
                    ["threshold", "above a round size"],
                    ["all", "every company"],
                  ]}
                  onChange={(v) => edit((p) => (p.agent.deepDive = v))}
                />
                {plan.agent.deepDive === "threshold" && (
                  <span className="flex items-center gap-1 text-body-small text-muted-foreground">
                    $
                    <Input
                      aria-label="Deep dive minimum round size, USD millions"
                      type="number"
                      min={0}
                      value={plan.agent.deepDiveMinUsdMillions}
                      onChange={(e) => edit((p) => (p.agent.deepDiveMinUsdMillions = Math.max(0, Number(e.target.value) || 0)))}
                      className="h-8 w-20"
                    />
                    M
                  </span>
                )}
              </Field>
              <Field label="Agent discovery sweep">
                <Select
                  label="Agent discovery sweep"
                  value={plan.agent.discoverySweep}
                  options={[
                    ["off", "off"],
                    ["weekly", "weekly"],
                    ["daily", "daily"],
                  ]}
                  onChange={(v) => edit((p) => (p.agent.discoverySweep = v))}
                />
              </Field>
              <div className="flex items-center justify-end py-2">
                <Button size="sm" variant="ghost" disabled={overrideCount === 0} onClick={() => pickTier(tier)}>
                  <RotateCcw className="size-3.5" /> Reset to {COVERAGE_LABELS[tier]}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {dirty && (
        <div className="mt-3 flex flex-wrap items-center gap-x-2 text-body-small text-black-alpha-56 dark:text-muted-foreground">
          <Tag tone="honey">unsaved</Tag>
          The next cron tick still runs the saved rung.
        </div>
      )}
    </Panel>
  );
}
