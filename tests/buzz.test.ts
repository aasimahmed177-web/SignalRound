import { describe, expect, test } from "vitest";
import { buzzLabel, buzzLevel, buzzParts, buzzScale, buzzText, buzzTitle, DEVELOPING, markLevel, rankText, roundCheck } from "../lib/buzz";

const mark = (people: number, outlets: number, hn_points: number) => ({ people, outlets, hn_points });

describe("the Buzz readout", () => {
  test("people on X, then outlets, then HN points only when there are any", () => {
    expect(buzzText(buzzParts(mark(13, 6, 0)))).toBe("13 on X · 6 outlets");
    expect(buzzText(buzzParts(mark(7, 11, 87)))).toBe("7 on X · 11 outlets · HN 87");
    expect(buzzText(buzzParts(mark(0, 1, 0)))).toBe("1 outlet");
    expect(buzzText(buzzParts(mark(1, 0, 0)))).toBe("1 on X");
  });

  test("no counts, or no mark at all, reads empty", () => {
    expect(buzzParts(mark(0, 0, 0))).toEqual([]);
    expect(buzzParts(undefined)).toEqual([]);
    expect(buzzParts(null)).toEqual([]);
  });

  test("the scale is the window's quintiles and its leader, positive scores only", () => {
    const scale = buzzScale([0, 5, 1, 4, 2, 3, -1, 6]);
    expect(scale.top).toBe(6);
    expect(scale.cuts.map((c) => Math.round(c * 100) / 100)).toEqual([2, 3, 4, 5]);
    expect(buzzScale([])).toEqual({ cuts: [], top: 0 });
    expect(buzzScale([0, 0])).toEqual({ cuts: [], top: 0 });
  });

  test("the meter fills to the row's place in the window: the leader full, a pile of equal low scores at one", () => {
    const scale = buzzScale([1, 2, 3, 4, 5, 6]);
    expect(buzzLevel(6, scale)).toBe(5);
    expect(buzzLevel(9, scale)).toBe(5);
    expect(buzzLevel(1, scale)).toBe(1);
    expect(buzzLevel(3.5, scale)).toBe(3);
    expect(buzzLevel(0, scale)).toBe(0);
    // A runaway leader does not flatten the rest: quantiles, not a share of the top score.
    const skewed = buzzScale([0.1, 0.2, 0.3, 0.4, 0.5, 40]);
    expect(buzzLevel(0.5, skewed)).toBe(4);
    // Most of the window at one score: those rows stay at one segment.
    const pile = buzzScale([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 1, 3]);
    expect(buzzLevel(0.2, pile)).toBe(1);
    expect(buzzLevel(3, pile)).toBe(5);
    // A lone round leads its window; a score with no window to read against shows one segment.
    expect(buzzLevel(0.7, buzzScale([0.7]))).toBe(5);
    expect(buzzLevel(0.7, buzzScale([]))).toBe(1);
  });

  test("a row with counts on record but no score still shows one segment; no mark shows none", () => {
    const scale = buzzScale([1, 2, 3]);
    const m = { label: false, rank: null, score: 0, people: 0, outlets: 1, hn_points: 0, summary: "1 outlet", scored_at: null };
    expect(markLevel(m, scale)).toBe(1);
    expect(markLevel({ ...m, outlets: 0, summary: "" }, scale)).toBe(0);
    expect(markLevel(undefined, scale)).toBe(0);
  });

  test("the rank prints in two digits at least", () => {
    expect(rankText(1)).toBe("01");
    expect(rankText(12)).toBe("12");
    expect(rankText(140)).toBe("140");
    expect(rankText(null)).toBe("");
  });

  test("the tooltip is the full summary, then the rank", () => {
    expect(buzzTitle({ summary: "13 people on X · 6 outlets · HN 3 pts", rank: 3, label: true })).toBe(
      "13 people on X · 6 outlets · HN 3 pts. #3 in Trending",
    );
    expect(buzzTitle({ summary: "2 outlets", rank: null, label: false })).toBe("2 outlets");
  });

  test("a screen reader hears the label, then the same facts", () => {
    expect(buzzLabel({ summary: "13 people on X · 6 outlets", rank: 1, label: true })).toBe(
      "Trending. 13 people on X · 6 outlets. #1 in Trending",
    );
    expect(buzzLabel({ summary: "2 outlets", rank: 9, label: false })).toBe("2 outlets. #9 in Trending");
  });
});

describe("the Round cell's check", () => {
  const sources = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ url: `https://s${i}.com`, title: null, host: `s${i}.com`, query: null }));
  const verification = (status: string, sources_seen?: number) => ({ status, notes: [], url: null, sources_seen });

  test("a verified row counts the sources it lists, and says when the verdict read fewer", () => {
    // Wealthcome (pre-launch audit): the badge said 1 source while its panel and RSS listed 2.
    const c = roundCheck({ disposition: "publish", verification: verification("confirmed", 1), sources: sources(2) });
    expect(c).toEqual({ kind: "verified", sources: 2, title: "Verified against 1 of 2 sources" });
    // A verdict that read more pages than the row still lists (one pruned since) claims only the list.
    expect(roundCheck({ disposition: "publish", verification: verification("confirmed", 6), sources: sources(4) })).toEqual({
      kind: "verified",
      sources: 4,
      title: "Verified against 4 sources",
    });
    expect(roundCheck({ disposition: "publish", verification: verification("corrected"), sources: sources(1) }).title).toBe(
      "Verified and corrected against 1 source",
    );
  });

  test("a flagged row reads as Developing whatever the verdict, with its count and no alarm word", () => {
    const c = roundCheck({ disposition: "flagged", verification: verification("confirmed", 3), sources: sources(5) });
    expect(c).toEqual({ kind: "flagged", sources: 5, title: DEVELOPING });
    expect(DEVELOPING).toBe("Developing: reported, and still being confirmed. Open the row for its sources.");
    expect(roundCheck({ disposition: "flagged", verification: null, sources: sources(2) }).sources).toBe(2);
    expect(c.title.toLowerCase()).not.toContain("flagged");
  });

  test("a contradicted row and a row never read are exceptions too", () => {
    expect(roundCheck({ disposition: "review", verification: verification("contradicted"), sources: sources(2) }).kind).toBe(
      "contradicted",
    );
    expect(roundCheck({ disposition: "publish", verification: null, sources: sources(2) })).toEqual({
      kind: "unverified",
      sources: 2,
      title: "Developing: still being confirmed against its 2 sources",
    });
  });
});
