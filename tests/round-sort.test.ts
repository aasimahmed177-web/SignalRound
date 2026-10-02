import type { FeedRecord } from "@fireround/core";
import { describe, expect, test } from "vitest";
import { parseCursor, parseSort } from "../lib/api-params";
import { pageCount, pageList, pageSpan, parsePage } from "../lib/pages";
import { listRounds, persistRecords } from "../lib/persist";
import {
  compareRounds,
  defaultFeedView,
  isAfterCursor,
  isNarrowed,
  parseRoundCursor,
  type RoundSort,
  roundCursorAfter,
  TRENDING_VIEW_HREF,
  toFeedView,
  toRoundSort,
} from "../lib/round-sort";
import { record, testDb } from "./helpers";

const row = (id: string, announcedOn: string | null, amountUsdMillions: string | null) => ({ id, announcedOn, amountUsdMillions });

describe("round cursors", () => {
  test("each sort writes a cursor only it reads back", () => {
    expect(roundCursorAfter("", row("a", "2026-09-02", "20.000"))).toBe("2026-09-02|a");
    expect(roundCursorAfter("", row("a", null, "20.000"))).toBe("|a");
    expect(roundCursorAfter("amount", row("a", "2026-09-02", "20.000"))).toBe("amt:20.000|a");
    expect(roundCursorAfter("amount", row("a", "2026-09-02", null))).toBe("amt:|a");

    expect(parseRoundCursor("2026-09-02|a")).toEqual({ sort: "", announced: "2026-09-02", id: "a" });
    expect(parseRoundCursor("|a")).toEqual({ sort: "", announced: null, id: "a" });
    expect(parseRoundCursor("amt:20.000|acme:series_a:2026-09-02")).toEqual({
      sort: "amount",
      usdMillions: "20.000",
      id: "acme:series_a:2026-09-02",
    });
    expect(parseRoundCursor("amt:|a")).toEqual({ sort: "amount", usdMillions: null, id: "a" });
    for (const bad of ["", "a", "2026-09|a", "amt:x|a", "amt:-5|a", "2026-09-02|", "2026-09-02|a|b"]) {
      expect(parseRoundCursor(bad)).toBeNull();
    }
  });

  test("an unknown sort reads as the default", () => {
    expect(toRoundSort("amount")).toBe("amount");
    expect(toRoundSort("AMOUNT")).toBe("");
    expect(toRoundSort(undefined)).toBe("");
  });

  test("amount order: largest first, equal amounts by id desc, unknown amounts last", () => {
    const rows = [row("b", null, null), row("a", null, "5"), row("c", null, "100"), row("d", null, "5.000"), row("e", null, null)];
    expect(rows.sort((x, y) => compareRounds("amount", x, y)).map((r) => r.id)).toEqual(["c", "d", "a", "e", "b"]);
  });

  test("date order: newest first, undated last", () => {
    const rows = [row("a", null, null), row("b", "2026-09-01", null), row("c", "2026-09-03", null), row("d", "2026-09-01", null)];
    expect(rows.sort((x, y) => compareRounds("", x, y)).map((r) => r.id)).toEqual(["c", "d", "b", "a"]);
  });

  test("isAfterCursor admits the null tail from a keyed cursor, and only the rest of the tail from a tail cursor", () => {
    const keyed = parseRoundCursor("amt:5|m");
    const tail = parseRoundCursor("amt:|m");
    if (!keyed || !tail) throw new Error("cursor did not parse");
    expect(isAfterCursor(keyed, row("z", null, "10"))).toBe(false);
    expect(isAfterCursor(keyed, row("n", null, "5"))).toBe(false);
    expect(isAfterCursor(keyed, row("a", null, "5"))).toBe(true);
    expect(isAfterCursor(keyed, row("z", null, null))).toBe(true);
    expect(isAfterCursor(tail, row("a", null, "1"))).toBe(false);
    expect(isAfterCursor(tail, row("a", null, null))).toBe(true);
    expect(isAfterCursor(tail, row("z", null, null))).toBe(false);
  });
});

describe("numbered pages", () => {
  test("a page from the URL is a whole number from 1 up, else page one", () => {
    expect(parsePage("3")).toBe(3);
    for (const bad of [undefined, null, "", "0", "-2", "1.5", "two"]) expect(parsePage(bad)).toBe(1);
  });

  test("page count and the row span a page shows", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(350, 50)).toBe(7);
    expect(pageCount(351, 50)).toBe(8);
    expect(pageSpan(2, 50, 350)).toEqual({ from: 51, to: 100 });
    expect(pageSpan(8, 50, 351)).toEqual({ from: 351, to: 351 });
    expect(pageSpan(1, 50, 0)).toEqual({ from: 0, to: 0 });
  });

  test("the pager keeps the ends and the current page's neighbours, and never hides one page behind a gap", () => {
    expect(pageList(1, 1)).toEqual([1]);
    expect(pageList(1, 5)).toEqual([1, 2, "gap", 5]);
    expect(pageList(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageList(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pageList(5, 9)).toEqual([1, "gap", 4, 5, 6, "gap", 9]);
    expect(pageList(7, 7)).toEqual([1, "gap", 6, 7]);
    expect(pageList(3, 7)).toEqual([1, 2, 3, 4, "gap", 7]);
  });
});

describe("the API's sort and cursor params", () => {
  test("sort is amount, trending, or absent; a cursor must match the sort", () => {
    expect(parseSort(null)).toEqual({ ok: true, value: "" });
    expect(parseSort("amount")).toEqual({ ok: true, value: "amount" });
    expect(parseSort("trending")).toEqual({ ok: true, value: "trending" });
    expect(parseCursor("trend:50", "trending")).toEqual({ ok: true, value: "trend:50" });
    expect(parseCursor("amt:20|a", "trending").ok).toBe(false);
    expect(parseCursor("trend:50", "").ok).toBe(false);
    expect(parseSort("date").ok).toBe(false);
    expect(parseCursor("amt:20|a", "amount")).toEqual({ ok: true, value: "amt:20|a" });
    expect(parseCursor("2026-09-02|a", "")).toEqual({ ok: true, value: "2026-09-02|a" });
    expect(parseCursor("2026-09-02|a", "amount").ok).toBe(false);
    expect(parseCursor("amt:20|a", "").ok).toBe(false);
  });
});

function amount(usd: number | null): FeedRecord["amount"] {
  return usd === null
    ? { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null }
    : { value: usd, currency: "USD", as_written: `$${usd}M`, usd_millions: usd, fx_rate: 1, fx_date: "2026-09-02" };
}

describe("listRounds paging under each sort", () => {
  // Ties on both keys and a null tail on both, so a page boundary lands inside each.
  const fixtures: Array<[string, string | null, number | null]> = [
    ["Alpha", "2026-09-05", 50],
    ["Bravo", "2026-09-05", 20],
    ["Charlie", "2026-09-04", 20],
    ["Delta", "2026-09-04", null],
    ["Echo", null, 20],
    ["Foxtrot", null, null],
    ["Golf", "2026-09-01", 200],
    ["Hotel", null, 5],
    ["India", "2026-09-03", null],
  ];

  async function seeded() {
    const db = await testDb();
    const records = fixtures.map(([name, announced, usd]) =>
      record({ company_name: name, announced_date: announced, amount: amount(usd) }),
    );
    await persistRecords(db, records, "series-a-b", "run-1");
    return db;
  }

  for (const sort of ["", "amount"] as RoundSort[]) {
    test(`sort=${sort || "default"}: every page follows on, no row twice, none dropped`, async () => {
      const db = await seeded();
      const all = (await listRounds(db, { sort, limit: 200, includeReview: true })).rows;
      expect(all).toHaveLength(fixtures.length);
      const expected = [...all]
        .sort((a, b) =>
          compareRounds(
            sort,
            row(a.id, a.announced_on, a.amount.usd_millions?.toString() ?? null),
            row(b.id, b.announced_on, b.amount.usd_millions?.toString() ?? null),
          ),
        )
        .map((r) => r.id);
      expect(all.map((r) => r.id)).toEqual(expected);

      for (const limit of [1, 2, 4]) {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 20; i++) {
          const page = await listRounds(db, { sort, limit, cursor, includeReview: true });
          seen.push(...page.rows.map((r) => r.id));
          if (!page.nextCursor) break;
          expect(parseRoundCursor(page.nextCursor)?.sort).toBe(sort);
          cursor = page.nextCursor;
        }
        expect(seen).toEqual(expected);
      }
    });
  }

  test("amount sort puts the largest first and unknown amounts last", async () => {
    const db = await seeded();
    const names = (await listRounds(db, { sort: "amount", includeReview: true })).rows.map((r) => r.company.name);
    expect(names.slice(0, 2)).toEqual(["Golf", "Alpha"]);
    expect(new Set(names.slice(-3))).toEqual(new Set(["Delta", "Foxtrot", "India"]));
  });

  test("offset pages under both sorts are slices of the full order", async () => {
    const db = await seeded();
    for (const sort of ["", "amount"] as RoundSort[]) {
      const all = (await listRounds(db, { sort, limit: 200, includeReview: true })).rows.map((r) => r.id);
      const pages: string[] = [];
      for (let page = 0; page * 4 < all.length; page++) {
        pages.push(...(await listRounds(db, { sort, limit: 4, offset: page * 4, includeReview: true })).rows.map((r) => r.id));
      }
      expect(pages).toEqual(all);
    }
  });

  test("a cursor from the other sort starts from the top instead of skipping rows", async () => {
    const db = await seeded();
    const first = await listRounds(db, { sort: "amount", limit: 3, includeReview: true });
    const mismatched = await listRounds(db, { sort: "", limit: 3, cursor: first.nextCursor ?? undefined, includeReview: true });
    const top = await listRounds(db, { sort: "", limit: 3, includeReview: true });
    expect(mismatched.rows.map((r) => r.id)).toEqual(top.rows.map((r) => r.id));
  });
});

describe("the feed's views", () => {
  test("view=trending opens Trending, sort=trending still does, anything else is Latest", () => {
    expect(toFeedView("trending", "")).toBe("trending");
    expect(toFeedView("", "trending")).toBe("trending");
    expect(toFeedView("trending", "amount")).toBe("trending");
    expect(toFeedView("", "amount")).toBe("latest");
    expect(toFeedView("latest", "")).toBe("latest");
    expect(toFeedView(null, undefined)).toBe("latest");
    expect(TRENDING_VIEW_HREF).toBe("/feed?view=trending");
  });

  test("a bare /feed opens the fallback; an explicit view or a Latest order in the URL wins", () => {
    expect(toFeedView("", "", "trending")).toBe("trending");
    expect(toFeedView(null, undefined, "trending")).toBe("trending");
    expect(toFeedView("latest", "", "trending")).toBe("latest");
    expect(toFeedView("", "amount", "trending")).toBe("latest");
    expect(toFeedView("", "", "latest")).toBe("latest");
  });
});

describe("the view a feed without `view` opens", () => {
  test("a bare feed opens Trending where the lane runs, Latest where it does not", () => {
    expect(defaultFeedView(true, {})).toBe("trending");
    expect(defaultFeedView(false, {})).toBe("latest");
    expect(defaultFeedView(true, { q: "  ", stage: "" })).toBe("trending");
  });
  test("any search, filter, or date range opens Latest, which walks every round", () => {
    for (const n of [
      { q: "groq" },
      { stage: "seed" },
      { sector: "fintech" },
      { min: "10" },
      { preset: "seed" },
      { since: "2026-09-01" },
      { until: "2026-09-07" },
      { source: "techcrunch.com" },
    ]) {
      expect(isNarrowed(n)).toBe(true);
      expect(defaultFeedView(true, n)).toBe("latest");
    }
  });
  test("an explicit view still wins over the default", () => {
    expect(toFeedView("trending", "", defaultFeedView(true, { q: "groq" }))).toBe("trending");
    expect(toFeedView("", "", defaultFeedView(true, { q: "groq" }))).toBe("latest");
  });
});
