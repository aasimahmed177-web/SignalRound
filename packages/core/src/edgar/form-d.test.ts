// EDGAR addressing and paging without a network: the full-text search URL and its offset, the
// filing URLs derived from a hit, the User-Agent EDGAR requires, the throttle that spaces requests,
// and how a span is cut into week-long pieces. The disposition gate and the lane run live in the
// root suite against fixture filings.

import { describe, expect, test } from "vitest";
import {
  EDGAR_DEFAULT_USER_AGENT,
  EDGAR_PAGE_SIZE,
  EdgarClient,
  EdgarThrottle,
  edgarUserAgent,
  filingIndexUrl,
  formDResolveStart,
  formDSpanChunks,
  formViewUrl,
  primaryDocUrl,
  searchFormD,
  searchUrl,
} from "./form-d.ts";

describe("EDGAR addressing", () => {
  test("search URL carries the LIVE term, form D, and the custom date window; paging adds from", () => {
    const u = new URL(searchUrl("2026-09-02", "2026-09-04"));
    expect(u.origin + u.pathname).toBe("https://efts.sec.gov/LATEST/search-index");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      q: "LIVE",
      forms: "D",
      dateRange: "custom",
      startdt: "2026-09-02",
      enddt: "2026-09-04",
    });
    expect(new URL(searchUrl("2026-09-02", "2026-09-04", 100)).searchParams.get("from")).toBe("100");
  });

  test("filing URLs drop the CIK's leading zeros and the accession number's dashes", () => {
    const hit = { cik: "0001706556", adsh: "0001706556-26-000003" };
    expect(primaryDocUrl(hit)).toBe("https://www.sec.gov/Archives/edgar/data/1706556/000170655626000003/primary_doc.xml");
    expect(filingIndexUrl(hit)).toBe("https://www.sec.gov/Archives/edgar/data/1706556/000170655626000003/0001706556-26-000003-index.htm");
    expect(formViewUrl(hit)).toBe("https://www.sec.gov/Archives/edgar/data/1706556/000170655626000003/xslFormDX01/primary_doc.xml");
  });

  test("the User-Agent comes from EDGAR_USER_AGENT with a default", () => {
    expect(edgarUserAgent({})).toBe(EDGAR_DEFAULT_USER_AGENT);
    expect(edgarUserAgent({ EDGAR_USER_AGENT: "  " })).toBe(EDGAR_DEFAULT_USER_AGENT);
    expect(edgarUserAgent({ EDGAR_USER_AGENT: "fireround/0.1 (ops@acme.test)" })).toBe("fireround/0.1 (ops@acme.test)");
  });

  test("the throttle spaces request starts to the configured rate", async () => {
    const t = new EdgarThrottle(1000);
    const started = Date.now();
    for (let i = 0; i < 5; i++) await t.wait();
    // Five starts at 1000/s occupy at least four intervals of 1ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(3);
  });
});

describe("searchFormD paging", () => {
  /** A fake index of `total` filings served 100 a page through `from`, logging each request's offset. */
  function pagedFetch(total: number, offsets: number[]) {
    return async (url: string): Promise<Response> => {
      const from = Number(new URL(url).searchParams.get("from") ?? 0);
      offsets.push(from);
      const page = Array.from({ length: Math.max(0, Math.min(EDGAR_PAGE_SIZE, total - from)) }, (_, i) => {
        const n = from + i;
        return {
          _id: `${n}`,
          _source: {
            ciks: [String(1_000_000 + n)],
            display_names: [`Issuer ${n}  (CIK ${1_000_000 + n})`],
            file_date: "2026-07-15",
            form: n % 7 === 0 ? "D/A" : "D",
            adsh: `${String(1_000_000 + n).padStart(10, "0")}-26-${String(n).padStart(6, "0")}`,
            items: ["06b"],
          },
        };
      });
      return new Response(JSON.stringify({ hits: { total: { value: total, relation: "eq" }, hits: page } }), { status: 200 });
    };
  }

  test("reads every page of a span through the from offset, in order, and stops at the total", async () => {
    const offsets: number[] = [];
    const client = new EdgarClient({ fetch: pagedFetch(250, offsets), requestsPerSecond: 10_000 });
    const hits = await searchFormD(client, new Date("2026-06-06T00:00:00Z"), new Date("2026-09-04T00:00:00Z"));
    expect(offsets).toEqual([0, 100, 200]);
    expect(client.requests).toBe(3);
    expect(hits).toHaveLength(250);
    expect(new Set(hits.map((h) => h.adsh)).size).toBe(250);
    expect(hits[1]).toMatchObject({ cik: "0001000001", form: "D", fileDate: "2026-07-15", displayName: "Issuer 1" });
    expect(hits[7].form).toBe("D/A");
    expect(hits[249].cik).toBe("0001000249");
  });

  test("an exact multiple of the page size does not fetch an empty page; an empty span is one request", async () => {
    const exact: number[] = [];
    await searchFormD(new EdgarClient({ fetch: pagedFetch(200, exact), requestsPerSecond: 10_000 }), new Date(), new Date());
    expect(exact).toEqual([0, 100]);
    const none: number[] = [];
    const empty = await searchFormD(new EdgarClient({ fetch: pagedFetch(0, none), requestsPerSecond: 10_000 }), new Date(), new Date());
    expect(none).toEqual([0]);
    expect(empty).toEqual([]);
  });

  test("maxPages is a ceiling: the read stops there even when EDGAR reports more", async () => {
    const offsets: number[] = [];
    const hits = await searchFormD(
      new EdgarClient({ fetch: pagedFetch(1000, offsets), requestsPerSecond: 10_000 }),
      new Date(),
      new Date(),
      3,
    );
    expect(offsets).toEqual([0, 100, 200]);
    expect(hits).toHaveLength(300);
  });

  test("the throttle paces the pages: three pages at 100/s take at least two intervals", async () => {
    const offsets: number[] = [];
    const client = new EdgarClient({ fetch: pagedFetch(250, offsets), requestsPerSecond: 100 });
    const started = Date.now();
    await searchFormD(client, new Date(), new Date());
    expect(Date.now() - started).toBeGreaterThanOrEqual(18);
  });
});

describe("Form D spans", () => {
  test("a span is read a week at a time, oldest first, the last piece ending at the span's end", () => {
    const chunks = formDSpanChunks({ start: "2026-06-06T12:00:00.000Z", end: "2026-09-04T12:00:00.000Z" });
    expect(chunks).toHaveLength(13);
    expect(chunks[0]).toEqual({ start: "2026-06-06T12:00:00.000Z", end: "2026-06-13T12:00:00.000Z" });
    expect(chunks[1].start).toBe(chunks[0].end);
    expect(chunks.at(-1)).toEqual({ start: "2026-08-29T12:00:00.000Z", end: "2026-09-04T12:00:00.000Z" });
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].start).toBe(chunks[i - 1].end);
  });

  test("a scheduled check's two-day span is one piece; a degenerate span is itself", () => {
    const two = { start: "2026-09-02T12:00:00.000Z", end: "2026-09-04T12:00:00.000Z" };
    expect(formDSpanChunks(two)).toEqual([two]);
    const flat = { start: "2026-09-04T12:00:00.000Z", end: "2026-09-04T12:00:00.000Z" };
    expect(formDSpanChunks(flat)).toEqual([flat]);
    expect(formDSpanChunks({ start: "2026-01-01T00:00:00.000Z", end: "2026-01-21T00:00:00.000Z" }, 10)).toHaveLength(2);
  });

  test("the resolve window opens 30 days before the span's first filing day, so a July filing stays dated July", () => {
    expect(formDResolveStart({ start: "2026-07-01T00:00:00.000Z", end: "2026-09-04T00:00:00.000Z" }).toISOString()).toBe(
      "2026-06-01T00:00:00.000Z",
    );
    // A scheduled check (the last two days) keeps what it always kept: about a month back.
    const start = formDResolveStart({ start: "2026-09-02T12:00:00.000Z", end: "2026-09-04T12:00:00.000Z" });
    expect(start.toISOString()).toBe("2026-08-03T12:00:00.000Z");
  });
});
