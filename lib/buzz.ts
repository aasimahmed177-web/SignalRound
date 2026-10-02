// What a round table shows for the chatter around a row (the Buzz column) and for its check against
// its sources (the Round cell). Pure, so the words and the scale are unit-tested without a render.

import { grouped } from "@/lib/format";
import type { FeedRow } from "@/lib/persist";
import { readAgainst, sourceCount, sourcesLabel } from "@/lib/source-count";
import type { TrendingMark } from "@/lib/trending";

/** One count in the compact readout: the figure (set in mono) and the words after it. */
export interface BuzzPart {
  key: "x" | "outlets" | "hn";
  figure: string;
  words: string;
}

/**
 * The compact readout, "13 on X · 6 outlets · HN 40": people on X, then outlets, then Hacker News
 * points when there are any. Empty when the row has no chatter on record.
 */
export function buzzParts(mark: Pick<TrendingMark, "people" | "outlets" | "hn_points"> | undefined | null): BuzzPart[] {
  if (!mark) return [];
  const parts: BuzzPart[] = [];
  if (mark.people > 0) parts.push({ key: "x", figure: grouped(mark.people), words: "on X" });
  if (mark.outlets > 0) parts.push({ key: "outlets", figure: grouped(mark.outlets), words: mark.outlets === 1 ? "outlet" : "outlets" });
  if (mark.hn_points > 0) parts.push({ key: "hn", figure: grouped(mark.hn_points), words: "HN" });
  return parts;
}

/** The readout as plain text, for a label or a test. HN reads "HN 40", figure after the word. */
export function buzzText(parts: BuzzPart[]): string {
  return parts.map((p) => (p.key === "hn" ? `${p.words} ${p.figure}` : `${p.figure} ${p.words}`)).join(" · ");
}

/** One count in the long form: the number and the words after it. */
export interface CountPart {
  key: "x" | "outlets" | "hn";
  n: number;
  /** For `x` the words stop at "on": the component draws X's logomark after them. */
  words: string;
}

/**
 * The long form, "13 people on X · 6 outlets · 40 HN points", for the company page's On X block
 * and the landing page's Trending band. The X part ends at "on" so the component can set the
 * logomark where the name was; zero counts are left out, not printed as zero.
 */
export function countParts(mark: Pick<TrendingMark, "people" | "outlets" | "hn_points"> | undefined | null): CountPart[] {
  if (!mark) return [];
  const parts: CountPart[] = [
    { key: "x", n: mark.people, words: mark.people === 1 ? "person on" : "people on" },
    { key: "outlets", n: mark.outlets, words: mark.outlets === 1 ? "outlet" : "outlets" },
    { key: "hn", n: mark.hn_points, words: mark.hn_points === 1 ? "HN point" : "HN points" },
  ];
  return parts.filter((p) => p.n > 0);
}

/** Segments in the Buzz meter. */
export const BUZZ_LEVELS = 5;

/**
 * Where the meter's segments break, read once per page from every scored round in the Trending
 * window: the scores at the 20th, 40th, 60th, and 80th percentiles, and the leader's score.
 */
export interface BuzzScale {
  cuts: number[];
  top: number;
}

export const EMPTY_SCALE: BuzzScale = { cuts: [], top: 0 };

/**
 * The scale from the window's scores. Quantiles, not a share of the leader: one runaway round
 * would leave every other meter at one segment, while the fifths spread the window across the
 * meter whatever its shape. Non-positive scores are not in the window's ranking and are left out.
 */
export function buzzScale(scores: readonly number[]): BuzzScale {
  const sorted = scores.filter((s) => s > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return EMPTY_SCALE;
  const at = (q: number) => {
    const i = (sorted.length - 1) * q;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  };
  const cuts = Array.from({ length: BUZZ_LEVELS - 1 }, (_, k) => at((k + 1) / BUZZ_LEVELS));
  return { cuts, top: sorted[sorted.length - 1] };
}

/**
 * How many of the meter's segments a row fills: none without a score, all five for the leader,
 * otherwise one plus the cuts the score clears. A score has to beat a cut, not tie it, so a pile
 * of rounds at the same low score stays at one segment rather than climbing with the pile.
 */
export function buzzLevel(score: number, scale: BuzzScale): number {
  if (!(score > 0)) return 0;
  if (!(scale.top > 0)) return 1;
  if (score >= scale.top) return BUZZ_LEVELS;
  return Math.min(BUZZ_LEVELS, 1 + scale.cuts.filter((c) => score > c).length);
}

/** A row's level in the column: a row with counts on record but no score still shows one segment. */
export function markLevel(mark: TrendingMark | undefined | null, scale: BuzzScale): number {
  if (!mark) return 0;
  const level = buzzLevel(mark.score, scale);
  return level === 0 && buzzParts(mark).length > 0 ? 1 : level;
}

/** The tooltip: the full summary ("13 people on X · 6 outlets · HN 40 pts"), then the rank when it has one. */
export function buzzTitle(mark: Pick<TrendingMark, "summary" | "rank" | "label">): string {
  const rank = mark.rank ? `#${mark.rank} in Trending` : "";
  return [mark.summary, rank].filter(Boolean).join(". ");
}

/** The cell's tooltip and screen reader label: the Trending label when it has one, the summary, the rank. */
export function buzzLabel(mark: Pick<TrendingMark, "summary" | "rank" | "label">): string {
  return `${mark.label ? "Trending. " : ""}${buzzTitle(mark) || "Discussed recently"}`;
}

/** The rank as the Trending view prints it: two digits at least, "01", "12", "140". */
export function rankText(rank: number | null | undefined): string {
  return rank ? String(rank).padStart(2, "0") : "";
}

/** How a row's check against its sources reads in a Round cell. */
export type RoundCheckKind = "verified" | "flagged" | "contradicted" | "unverified";

export interface RoundCheck {
  kind: RoundCheckKind;
  /** The sources the verdict read (or the row carries, when it was never read). */
  sources: number;
  title: string;
}

/** The tooltip a flagged row's check carries: what it means, and where its sources are. */
export const DEVELOPING = "Developing: reported, and still being confirmed. Open the row for its sources.";

/**
 * The Round cell's verification mark. A flagged row (published on a score between 0.50 and 0.75)
 * reads as Developing whatever the verdict; otherwise a verified row shows the sources the
 * verdict read, and a contradicted or never-read row says that. Every kind is a quiet glyph and a
 * count; the full verdict stays in the expanded row.
 */
export function roundCheck(r: Pick<FeedRow, "verification" | "sources" | "disposition">): RoundCheck {
  const status = r.verification?.status ?? "unverified";
  // The count is the sources listed, as in the open row and every feed (lib/source-count.ts); the
  // verdict's reach, when it read fewer, is in the tooltip.
  const sources = sourceCount(r);
  const noun = sourcesLabel(r);
  if (r.disposition === "flagged") return { kind: "flagged", sources, title: DEVELOPING };
  const reach = readAgainst(r);
  if (reach !== null)
    return { kind: "verified", sources, title: `${status === "corrected" ? "Verified and corrected" : "Verified"} against ${reach}` };
  if (status === "contradicted" || status === "not_news")
    return { kind: "contradicted", sources, title: "The sources contradict this record" };
  return { kind: "unverified", sources, title: `Developing: still being confirmed against its ${noun}` };
}
