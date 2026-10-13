import type { FeedRecord } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { parseCursor, parseSort } from "../lib/api-params";
import { pageCount, pageList, pageSpan, parsePage } from "../lib/pages";
import { listRounds, persistRecords } from "../lib/persist";
import {
  compareRounds,
  defaultFeedView,
  isAfterCursor,
  isNarrowed,
  isProvisional,
  parseRoundCursor,
  type RoundSort,
  roundCursorAfter,
  TRENDING_VIEW_HREF,
  toFeedView,
  toRoundSort,
} from "../lib/round-sort";
import { record, testDb } from "./helpers";

const row = (
  id: string,
  announcedOn: string | null,
  amountUsdMillions: string | null,
  disposition = "publish",
  certainty = "announced",
) => ({ id, announcedOn, amountUsdMillions, disposition, certainty });

describe("round cursors", () => {
  test("each sort writes a cursor only it reads back", () => {
    expect(roundCursorAfter("", row("a", "2026-09-02", "20.000"))).toBe("2026-09-02|a");
    expect(roundCursorAfter("", row("a", null, "20.000"))).toBe("|a");
    expect(roundCursorAfter("amount", row("a", "2026-09-02", "20.000"))).toBe("amt:20.000|a");
    expect(roundCursorAfter("amount", row("a", "2026-09-02", null))).toBe("amt:|a");
    expect(roundCursorAfter("amount", row("a", "2026-09-02", "20.000", "flagged"))).toBe("amtp:20.000|a");
    expect(roundCursorAfter("amount", row("a", "2026-09-02", null, "publish", "expected"))).toBe("amtp:|a");
    expect(roundCursorAfter("", row("a", "2026-09-02", "20.000", "flagged"))).toBe("2026-09-02|a");

    expect(parseRoundCursor("2026-09-02|a")).toEqual({ sort: "", announced: "2026-09-02", id: "a" });
    expect(parseRoundCursor("|a")).toEqual({ sort: "", announced: null, id: "a" });
    expect(parseRoundCursor("amt:20.000|acme:series_a:2026-09-02")).toEqual({
      sort: "amount",
      provisional: false,
      usdMillions: "20.000",
      id: "acme:series_a:2026-09-02",
    });
    expect(parseRoundCursor("amt:|a")).toEqual({ sort: "amount", provisional: false, usdMillions: null, id: "a" });
    expect(parseRoundCursor("amtp:20.000|a")).toEqual({ sort: "amount", provisional: true, usdMillions: "20.000", id: "a" });
    expect(parseRoundCursor("amtp:|a")).toEqual({ sort: "amount", provisional: true, usdMillions: null, id: "a" });
    for (const bad of ["", "a", "2026-09|a", "amt:x|a", "amt:-5|a", "amtx:5|a", "amtp5|a", "2026-09-02|", "2026-09-02|a|b"]) {
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

  test("a round is provisional when it is flagged or not announced", () => {
    expect(isProvisional({ disposition: "publish", certainty: "announced" })).toBe(false);
    for (const certainty of ["expected", "reported", "unconfirmed"])
      expect(isProvisional({ disposition: "publish", certainty })).toBe(true);
    for (const disposition of ["flagged", "review", "rejected"]) expect(isProvisional({ disposition, certainty: "announced" })).toBe(true);
  });

  test("amount order: published announced rounds first, then the provisional ones, each largest first", () => {
    const rows = [
      row("deepseek", null, "11932", "flagged", "expected"),
      row("ramp", null, "1850", "publish", "reported"),
      row("manus", null, "500"),
      row("oxide", null, "445", "flagged"),
      row("cmr", null, "400", "publish", "expected"),
      row("voltus", null, "225"),
      row("rumor", null, "300", "publish", "unconfirmed"),
      row("undisclosed", null, null),
      row("hush", null, null, "publish", "reported"),
    ];
    expect(rows.sort((x, y) => compareRounds("amount", x, y)).map((r) => r.id)).toEqual([
      "manus",
      "voltus",
      "undisclosed",
      "deepseek",
      "ramp",
      "oxide",
      "cmr",
      "rumor",
      "hush",
    ]);
  });

  test("date order ignores certainty and disposition", () => {
    const rows = [row("a", "2026-09-01", "5"), row("b", "2026-09-03", "5", "flagged", "expected")];
    expect(rows.sort((x, y) => compareRounds("", x, y)).map((r) => r.id)).toEqual(["b", "a"]);
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

  test("an announced cursor admits every provisional round; a provisional cursor admits no announced round", () => {
    const announced = parseRoundCursor("amt:5|m");
    const announcedTail = parseRoundCursor("amt:|m");
    const later = parseRoundCursor("amtp:5|m");
    if (!announced || !announcedTail || !later) throw new Error("cursor did not parse");
    expect(isAfterCursor(announced, row("z", null, "9000", "flagged", "expected"))).toBe(true);
    expect(isAfterCursor(announcedTail, row("z", null, "9000", "publish", "reported"))).toBe(true);
    expect(isAfterCursor(later, row("a", null, "1"))).toBe(false);
    expect(isAfterCursor(later, row("a", null, null))).toBe(false);
    expect(isAfterCursor(later, row("z", null, "10", "flagged"))).toBe(false);
    expect(isAfterCursor(later, row("a", null, "5", "flagged"))).toBe(true);
    expect(isAfterCursor(later, row("z", null, null, "publish", "expected"))).toBe(true);
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
    expect(parseCursor("amtp:20|a", "amount")).toEqual({ ok: true, value: "amtp:20|a" });
    expect(parseCursor("amtp:20|a", "").ok).toBe(false);
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
            row(a.id, a.announced_on, a.amount.usd_millions?.toString() ?? null, a.disposition, a.certainty),
            row(b.id, b.announced_on, b.amount.usd_millions?.toString() ?? null, b.disposition, b.certainty),
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

describe("listRounds amount order across announced and provisional rounds", () => {
  // Three published announced rounds and five provisional ones, with amounts that interleave, a tie
  // on each side of the boundary, and unknown amounts on both sides.
  const fixtures: Array<[string, number | null, "publish" | "flagged", "announced" | "reported" | "expected" | "unconfirmed"]> = [
    ["Deepco", 12_000, "flagged", "expected"],
    ["Rampco", 1_850, "publish", "reported"],
    ["Manusco", 500, "publish", "announced"],
    ["Oxideco", 445, "flagged", "announced"],
    ["Cmrco", 400, "publish", "expected"],
    ["Atlasco", 400, "publish", "reported"],
    ["Voltco", 225, "publish", "announced"],
    ["Typeco", 225, "publish", "announced"],
    ["Quietco", null, "publish", "announced"],
    ["Hushco", null, "flagged", "reported"],
    ["Rumorco", 900, "publish", "unconfirmed"],
  ];

  async function seeded() {
    const db = await testDb();
    const records = fixtures.map(([name, usd]) => record({ company_name: name, amount: amount(usd) }));
    await persistRecords(db, records, "series-a-b", "run-1");
    for (const [i, [, , disposition, certainty]] of fixtures.entries()) {
      await db.update(schema.fundingRounds).set({ disposition, certainty }).where(eq(schema.fundingRounds.id, records[i].id));
    }
    return db;
  }

  const announcedFirst = ["Manusco", "Voltco", "Typeco", "Quietco", "Deepco", "Rampco", "Rumorco", "Oxideco", "Cmrco", "Atlasco", "Hushco"];

  test("published announced rounds rank first, then the rest, each largest first, with certainty and disposition unchanged", async () => {
    const db = await seeded();
    const rows = (await listRounds(db, { sort: "amount", certainty: "all", limit: 200 })).rows;
    expect(rows.map((r) => r.company.name)).toEqual(announcedFirst);
    const byName = new Map(fixtures.map(([name, , disposition, certainty]) => [name, { disposition, certainty }]));
    for (const r of rows) expect({ disposition: r.disposition, certainty: r.certainty }).toEqual(byName.get(r.company.name));
  });

  test("cursor pages cross the boundary with no row twice and none dropped", async () => {
    const db = await seeded();
    for (const limit of [1, 2, 3, 4]) {
      const seen: string[] = [];
      const cursors: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const page = await listRounds(db, { sort: "amount", certainty: "all", limit, cursor });
        seen.push(...page.rows.map((r) => r.company.name));
        if (!page.nextCursor) break;
        cursors.push(page.nextCursor);
        cursor = page.nextCursor;
      }
      expect(seen).toEqual(announcedFirst);
      expect(cursors.some((c) => c.startsWith("amt:"))).toBe(true);
      expect(cursors.some((c) => c.startsWith("amtp:"))).toBe(true);
    }
  });

  test("the last announced round's cursor opens on the largest provisional round", async () => {
    const db = await seeded();
    const first = await listRounds(db, { sort: "amount", certainty: "all", limit: 4 });
    expect(first.rows.map((r) => r.company.name)).toEqual(["Manusco", "Voltco", "Typeco", "Quietco"]);
    expect(first.nextCursor).toMatch(/^amt:\|/);
    const next = await listRounds(db, { sort: "amount", certainty: "all", limit: 2, cursor: first.nextCursor ?? undefined });
    expect(next.rows.map((r) => r.company.name)).toEqual(["Deepco", "Rampco"]);
    expect(next.nextCursor).toMatch(/^amtp:1850/);
  });

  test("a certainty filter narrows to the same rows, and a flagged announced round still sorts after the published ones", async () => {
    const db = await seeded();
    const names = (await listRounds(db, { sort: "amount", certainty: "announced", limit: 200 })).rows.map((r) => r.company.name);
    expect(names).toEqual(["Manusco", "Voltco", "Typeco", "Quietco", "Oxideco"]);
    const closed = (await listRounds(db, { sort: "amount", certainty: "closed", limit: 200 })).rows.map((r) => r.company.name);
    expect(closed).toEqual(["Manusco", "Voltco", "Typeco", "Quietco", "Rampco", "Oxideco", "Atlasco", "Hushco"]);
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
