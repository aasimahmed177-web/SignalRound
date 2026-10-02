// The historical backfill: the past N calendar months, one month sweep per preset per month,
// and one Form D run over the same span. `GET /api/cron/sweep?backfill=N` starts it and
// `?estimate=1` prices it; `scripts/backfill.ts` is the terminal in front of both.

import type { FormDSpan, Preset, WindowSpec } from "@fireround/core";
import { formatWindow, monthRange } from "@fireround/core";
import type { CoverageEstimate, CoveragePlan } from "@/lib/coverage";
import { sweepCredits } from "@/lib/coverage";

/** A year is the ceiling: EDGAR pages stop at 10,000 hits, and twelve months of every preset is already a large bill. */
export const BACKFILL_MAX_MONTHS = 12;

/** The `backfill` query value as a month count, or null when it is not a whole number from 1 to the ceiling. */
export function parseBackfillMonths(value: string | null): number | null {
  if (value === null) return null;
  if (!/^\d{1,2}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= BACKFILL_MAX_MONTHS ? n : null;
}

/** The month windows a backfill sweeps, newest first: "month", "month-1", ... "month-{n-1}". */
export function backfillWindows(months: number): WindowSpec[] {
  return Array.from({ length: months }, (_, back) => formatWindow({ kind: "month", back }));
}

/** The Form D span over the same months: the first day of the oldest month through now. */
export function backfillSpan(months: number, now: Date = new Date()): FormDSpan {
  return { start: monthRange(months - 1, now).start.toISOString(), end: now.toISOString() };
}

/**
 * Rate-card estimate for a backfill: every preset's month sweep, `months` times, priced like a
 * week sweep each (see `sweepCredits`), plus the X accounts each sweep reads; Form D is free.
 */
export function estimateBackfillCredits(plan: CoveragePlan, presets: Preset[], months: number): CoverageEstimate {
  const lines: CoverageEstimate["lines"] = [];
  let x = 0;
  for (const preset of presets) {
    const one = sweepCredits(preset, plan, { kind: "month", back: 0 });
    lines.push({
      label: `${preset.name}: ${months} month ${months === 1 ? "sweep" : "sweeps"}`,
      low: one.low * months,
      high: one.high * months,
    });
    x += one.x * months;
  }
  if (x > 0) lines.push({ label: "X accounts", low: x, high: x });
  lines.push({ label: "SEC Form D (EDGAR, no Firecrawl credits)", low: 0, high: 0 });
  return {
    low: lines.reduce((n, l) => n + l.low, 0),
    high: lines.reduce((n, l) => n + l.high, 0),
    lines,
  };
}
