export const STAGE_LABEL: Record<string, string> = {
  pre_seed: "Pre-seed",
  seed: "Seed",
  series_a: "Series A",
  series_b: "Series B",
  series_c: "Series C",
  series_d_plus: "Series D+",
  growth: "Growth",
  bridge: "Bridge",
  pre_a: "Pre-A",
  debt: "Debt",
  grant: "Grant",
  convertible: "Convertible",
  secondary: "Secondary",
  undisclosed: "Undisclosed",
  other: "Other",
};

export function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage;
}

/** A clean later series as the page wrote it: "Series H", "series e", "Series F2". */
const LATER_SERIES = /^series\s+([d-z])(\d?)$/i;

/**
 * A named stage as one round shows it. "Series D+" is the filter's bucket for D and later; a round in
 * it shows its own letter when the page wrote a clean one, so Anthropic's Series H reads "Series H",
 * not "Series D+". Filters, facets, and counts keep `stageLabel`.
 */
export function stageOf(r: { stage: string; stage_as_written: string }): string {
  const later = r.stage === "series_d_plus" ? LATER_SERIES.exec(stageWords(r.stage_as_written)) : null;
  return later?.[1] ? `Series ${later[1].toUpperCase()}${later[2] ?? ""}` : stageLabel(r.stage);
}

/** Words that only say money was raised: "funding round", "new financing", "a round". */
const GENERIC_ROUND =
  /^(?:an?\s+|new\s+|latest\s+|equity\s+|venture\s+|private\s+)*(?:funding|financing|investment|capital|raise)?\s*(?:round|financing|funding|investment|raise)?(?:\s+of\s+(?:funding|financing|investment))?$/i;

/** A figure inside a stage label: "$50 million", "USD 150 Million", "€100m", "Rs 10 crore", "2 billion yuan". */
const LABEL_AMOUNT =
  /(?:(?:\bUS\$|\b(?:USD|EUR|GBP|INR|CNY|RMB|JPY|KRW|CAD|AUD|SGD|CHF|Rs\.?)\s?|[$€£¥₹₩])\s?\d[\d,.]*\s*(?:billion|bn|million|mn|m|thousand|k|crores?|cr|lakhs?)?\b|\b\d[\d,.]*\s*(?:billion|bn|million|mn|thousand|crores?|lakhs?)\b(?:\s*(?:US dollars|dollars|USD|euros?|EUR|pounds?|GBP|yuan|RMB|CNY|rupees?|INR))?)/gi;

/**
 * A stage label's words without the figure a page wrote into it. The extractor sometimes copies a
 * headline's "USD 150 Million funding round" or a bare "$50 million" into the label, and Brahma AI's
 * $150M round read "USD 150 million fu..." as its stage; the figure is the amount's to show.
 */
export function stageWords(written: string): string {
  return written
    .replace(LABEL_AMOUNT, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:in|of|worth|for)\s+/i, "");
}

/**
 * A round's stage as a row shows it. A lettered or named stage is its label; a round the record
 * could not name reads as what the page called it ("Form D (equity)", "Strategic investment"), or
 * "Funding round" when the page said no more than that. "Other · funding round" on OpenAI's $40
 * billion round said the same thing twice, and neither half well.
 */
export function roundStageLabel(r: { stage: string; stage_as_written: string }): string {
  if (r.stage !== "other" && r.stage !== "undisclosed") return stageOf(r);
  const written = stageWords(r.stage_as_written);
  if (!written || GENERIC_ROUND.test(written) || /^(?:other|undisclosed)(?:\s+round)?$/i.test(written)) return "Funding round";
  return written.charAt(0).toUpperCase() + written.slice(1);
}

/**
 * The stage words as the page wrote them, for a second line under the label, or null when they add
 * nothing: the label again, or a generic "latest funding round" that says less than the label does.
 */
export function stageAsWrittenNote(r: { stage: string; stage_as_written: string }): string | null {
  const written = stageWords(r.stage_as_written);
  if (!written || GENERIC_ROUND.test(written)) return null;
  // "Seed round" and "Series B funding" are the label with a word that says nothing more.
  const bare = written.replace(/\s+(?:round|funding|financing)$/i, "").toLowerCase();
  return bare === roundStageLabel(r).toLowerCase() ? null : written;
}

/** 12,480: a count grouped the way the reader's eye counts it (lib/text.ts groupDigits), under the name the landing page gave it. */
export { groupDigits as grouped } from "./text.ts";

/** $46M, $1.2B, $850K. Millions in, human out. */
export function usd(millions: number | null | undefined): string {
  if (millions === null || millions === undefined) return "";
  if (millions >= 1000) return `$${(millions / 1000).toFixed(millions >= 10_000 ? 0 : 1)}B`;
  if (millions >= 1) return `$${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  return `$${Math.round(millions * 1000)}K`;
}

/** A valuation in its source's words, with pre- or post-money when a source says which: "$5.8 billion post-money". */
export function valuationLabel(v: { as_written: string; basis: "post" | "pre" | "unknown" }): string {
  const figure = v.as_written.replace(/\s*valuation\s*$/i, "");
  return v.basis === "unknown" || /\b(?:pre|post)[\s-]?money\b/i.test(figure) ? figure : `${figure} ${v.basis}-money`;
}

/** A mixed financing shows its reported total, clearly marked as not isolated new primary money. */
export function reportedAmount(r: {
  amount: { usd_millions: number | null; as_written: string | null };
  financing_total_as_written?: string | null;
  amount_scope?: string | null;
}): string | null {
  const primary = usd(r.amount.usd_millions) || r.amount.as_written;
  if (primary) return primary;
  if (!r.financing_total_as_written) return null;
  const figure = r.financing_total_as_written
    .replace(/(\d)\s?MM\b/, "$1M")
    .replace(/\s+millions?\b/i, "M")
    .replace(/\s+billions?\b/i, "B");
  const suffix =
    r.amount_scope === "includes_grants"
      ? " incl. grants"
      : r.amount_scope === "includes_secondary"
        ? " incl. secondary"
        : r.amount_scope === "cumulative"
          ? " total raised"
          : r.amount_scope === "combined_rounds"
            ? " combined rounds"
            : " financing total";
  return `${figure}${suffix}`;
}

export function compact(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** A Date's calendar day, YYYY-MM-DD, in UTC or in the runtime's own time zone. */
/** The YYYY-MM-DD a moment falls on, on the UTC calendar or the runtime's own. */
export function calendarDay(d: Date, utc: boolean): string {
  const [y, m, day] = utc ? [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()] : [d.getFullYear(), d.getMonth(), d.getDate()];
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * How far back a day is, in calendar days: "today", "yesterday", "3d ago", then "Sep 12". A date
 * (YYYY-MM-DD) is a calendar day as written; a timestamp becomes the day it fell on. "Today" is the
 * reader's today only where the reader's clock runs (a browser); a server has only UTC, which is
 * already tomorrow for an American evening, so the pages draw this through RelativeDay, which
 * renders the UTC answer first and the reader's own after hydration. `utc` pins both days to UTC.
 */
export function relativeDay(iso: string | null, opts: { now?: Date; utc?: boolean } = {}): string {
  if (!iso) return "undated";
  const utc = opts.utc ?? false;
  let day: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) day = iso;
  else {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "undated";
    day = calendarDay(d, utc);
  }
  const days = Math.round((Date.parse(calendarDay(opts.now ?? new Date(), utc)) - Date.parse(day)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function hostLabel(host: string): string {
  return host.replace(/^www\./, "");
}

/**
 * The lane that found a source, as a human word, from the `query` its row was written with:
 * `formd` is the Form D lane, `watch:<host>` a watched publisher section, `x:@handle` an X
 * account, `agent:gap-fill` the Research play, `corroborate` the second reading, `manual` a URL
 * an admin pasted, a monitor or check id the monitor. Anything else is a sweep search query,
 * labelled Search; the query text itself is returned as `detail` for a tooltip. No query, no label.
 */
export function laneLabel(query: string | null | undefined): { label: string; detail?: string } | null {
  if (!query) return null;
  if (query === "formd") return { label: "Form D" };
  if (query === "corroborate") return { label: "Corroboration" };
  if (query === "manual") return { label: "Manual" };
  if (query.startsWith("agent:")) return { label: "Research" };
  if (query.startsWith("watch:")) return { label: `Watch: ${hostLabel(query.slice("watch:".length))}` };
  if (query.startsWith("x:")) return { label: `X: ${query.slice("x:".length)}` };
  if (query.startsWith("monitor:") || query.startsWith("check:")) return { label: "Monitor" };
  return { label: "Search", detail: query };
}

export { sectorLabel } from "@fireround/core/client";

/**
 * A date with its precision worn on its sleeve: "2026-09-04" when the day is known, "~ 2026-09-04"
 * when it is the date of the roundup or monthly list the round was read from.
 */
/**
 * A round's day as a row shows it. A month-precision day is stored as the first of the month it
 * names (a monthly list's month, a "September 2026" in the text, a `/2026/09/` URL), so it reads as
 * that month: "~ 2026-09-01" with a note of "the month before this date" put Synapse Analytics's
 * September round in August.
 */
export function approxDate(iso: string | null, precision: "day" | "week" | "month" | "unknown"): string {
  if (!iso) return "undated";
  if (precision === "month") return `~ ${iso.slice(0, 7)}`;
  return precision === "day" ? iso : `~ ${iso}`;
}

export function precisionNote(precision: "day" | "week" | "month" | "unknown"): string | null {
  if (precision === "week") return "from a weekly roundup: the round was announced in the week before this date";
  if (precision === "month") return "known only to the month: the round was announced in this month";
  return null;
}

/** The delivery floor as a reader would say it: the three thresholds the dispositions use, never the decimal. */
export function floorLabel(minConfidence: number): string {
  if (minConfidence >= 0.75) return "verified only";
  if (minConfidence >= 0.5) return "verified and checked";
  return "everything";
}

const SCOPE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "17 Sep 2026", or "17 Sep" when the year goes without saying. */
export function shortDay(iso: string, withYear: boolean): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${SCOPE_MONTHS[m - 1]}${withYear ? ` ${y}` : ""}`;
}

/**
 * The feed's filters that have no control of their own, as a sentence: the date range and the
 * publisher an Overview figure links with. "Announced 10 Sep to 16 Sep 2026, reported by
 * tech.eu." Null when neither is set.
 */
export function feedScope({ since, until, source }: { since?: string; until?: string; source?: string }): string | null {
  const parts: string[] = [];
  if (since && until) {
    const sameYear = since.slice(0, 4) === until.slice(0, 4);
    parts.push(`Announced ${shortDay(since, !sameYear)} to ${shortDay(until, true)}`);
  } else if (since) parts.push(`Announced since ${shortDay(since, true)}`);
  else if (until) parts.push(`Announced by ${shortDay(until, true)}`);
  if (source) parts.push(parts.length ? `reported by ${hostLabel(source)}` : `Reported by ${hostLabel(source)}`);
  return parts.length ? `${parts.join(", ")}.` : null;
}

/** A search term as a title quotes it: trimmed, and cut on a word past 40 characters. */
function quotedTerm(q: string): string {
  const t = q.trim().replace(/\s+/g, " ");
  if (t.length <= 40) return `"${t}"`;
  const cut = t.slice(0, 40);
  const end = cut.lastIndexOf(" ");
  return `"${(end > 20 ? cut.slice(0, end) : cut).trimEnd()}..."`;
}

/**
 * The public feed's H1 for what is in view. It used to promise "this week, verified" on every
 * view, a search for last year's round and page 11 included. `stages` are stage slugs; `filtered`
 * is any other narrowing (sector, amount, watchlist, a date range, a publisher), which the page
 * spells out under the filters.
 */
export function feedTitle({
  view,
  q,
  stages,
  filtered,
}: {
  view: "latest" | "trending";
  q?: string;
  stages: string[];
  filtered: boolean;
}): string {
  const labels = stages.map(stageLabel);
  const noun =
    labels.length === 1 ? `${labels[0]} rounds` : labels.length === 2 ? `${labels[0]} and ${labels[1]} rounds` : "Funding rounds";
  const term = q?.trim();
  if (term) return `${noun} matching ${quotedTerm(term)}`;
  const narrowed = labels.length > 0 || filtered;
  if (view === "trending") return narrowed ? `${noun} people are discussing` : "The rounds people are discussing now";
  if (!narrowed) return "The latest funding rounds";
  return filtered ? `${noun} matching your filters` : noun;
}
