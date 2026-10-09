// The public Overview: the market aggregates count only what the feed publishes (publish and
// flagged, never review or rejected) and only news rounds (never a history row), each figure
// matches the feed filtered the way its link filters, and the visitor's panels carry no operator
// text (credits, runs, the review queue).
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, test } from "vitest";
import { AdminPanels, AdminStats } from "../components/overview/admin";
import { MarketNote, MarketPanels } from "../components/overview/market";
import { corroborateRecord } from "../lib/corroborate";
import { feedScope } from "../lib/format";
import { countRounds, feedHistory, listRounds, persistRecords, setDisposition } from "../lib/persist";
import {
  comparable,
  demoStats,
  type Market,
  type MarketView,
  market,
  marketFeedHref,
  marketSpans,
  marketView,
  overview,
  versus,
  versusParts,
  weekGrid,
} from "../lib/stats";
import { record, testDb } from "./helpers";
import { isoDaysAgo } from "./history-fixtures";

const { fundingRounds, trendingRounds, runs } = schema;

let handle: Db;
let m: Market;
let view: MarketView;
const ids: Record<string, string> = {};

/** One round, persisted on its own so its id is known, then set to the disposition the test needs. */
async function add(
  name: string,
  opts: {
    daysAgo: number;
    usd: number | null;
    stage?: "seed" | "series_a" | "series_b";
    sector?: string;
    lead?: string;
    hosts?: string[];
    disposition?: "publish" | "flagged" | "review" | "rejected";
    history?: boolean;
  },
) {
  const hosts = opts.hosts ?? ["reuters.com"];
  const summary = await persistRecords(
    handle,
    [
      record({
        company_name: name,
        company_key: name.toLowerCase(),
        stage: opts.stage ?? "series_a",
        stage_as_written: opts.stage === "seed" ? "Seed" : "Series A",
        announced_date: isoDaysAgo(opts.daysAgo),
        sector: opts.sector ?? "fintech",
        lead_investors: [opts.lead ?? "Fund One"],
        amount:
          opts.usd === null
            ? { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null }
            : { value: opts.usd, currency: "USD", as_written: `$${opts.usd}M`, usd_millions: opts.usd, fx_rate: 1, fx_date: null },
        sources: hosts.map((host, i) => ({ url: `https://${host}/${name.toLowerCase()}-${i}`, host, title: `${name} raises` })),
      }),
    ],
    "series-a-b",
    `run-${name}`,
  );
  const id = summary.insertedIds[0];
  if (!id) throw new Error(`${name} was not inserted`);
  if (!opts.history && opts.disposition !== "review" && opts.disposition !== "rejected") {
    const searched = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
    await corroborateRecord(handle, searched, id, { broad: true, maxPages: 0 });
  }
  await setDisposition(handle, id, opts.disposition ?? "publish");
  if (opts.history) await handle.update(fundingRounds).set({ history: true }).where(eq(fundingRounds.id, id));
  ids[name] = id;
}

beforeAll(async () => {
  handle = await testDb();
  // This week: three news rounds the feed lists, one with no stated amount.
  await add("Alder", { daysAgo: 2, usd: 20, hosts: ["techcrunch.com"] });
  await add("Birch", {
    daysAgo: 3,
    usd: 5,
    stage: "seed",
    sector: "health",
    lead: "Fund Two",
    hosts: ["tech.eu", "sec.gov"],
    disposition: "flagged",
  });
  await add("Cedar", { daysAgo: 4, usd: null, sector: "health", lead: "Fund Two", hosts: ["tech.eu", "techcrunch.com"] });
  // Last week, and the 30 days before this month.
  await add("Dogwood", { daysAgo: 10, usd: 100, stage: "series_b", hosts: ["techcrunch.com"] });
  await add("Elm", { daysAgo: 40, usd: 50 });
  // A sector the classifier could not place: counted everywhere but the sector list.
  await add("Fern", { daysAgo: 12, usd: null, sector: "other", lead: "Fund Three", hosts: ["reuters.com"] });
  // Inside every window, and never counted: the queue, the rejected, and an earlier round from a dossier.
  await add("Queued", { daysAgo: 1, usd: 500, hosts: ["queued.example"], lead: "Hidden Fund", disposition: "review" });
  await add("Refused", { daysAgo: 1, usd: 300, hosts: ["refused.example"], lead: "Hidden Fund", disposition: "rejected" });
  await add("Dossierco", { daysAgo: 2, usd: 200, hosts: ["dossier.example"], lead: "Hidden Fund", history: true });
  m = await market(handle);
  view = await marketView(handle);
});

describe("market", () => {
  test("the spans count publish and flagged news rounds only", () => {
    expect(m.week).toMatchObject({ rounds: 3, usd_millions: 25, with_amount: 2 });
    expect(m.prev_week).toMatchObject({ rounds: 2, usd_millions: 100 });
    expect(m.month).toMatchObject({ rounds: 5, usd_millions: 125, with_amount: 3 });
    expect(m.prev_month).toMatchObject({ rounds: 1, usd_millions: 50 });
  });

  test("the week is the landing page's and the demo hero's week, to the round and the dollar", async () => {
    const d = await demoStats(handle);
    expect(m.week.rounds).toBe(d.rounds_7d);
    expect(m.week.usd_millions).toBe(d.usd_7d);
  });

  test("stages in ladder order, sectors, leads, and publishers leave out the queue, the rejected, history, and filings", () => {
    expect(m.by_stage.map((s) => [s.stage, s.count, s.usd_millions])).toEqual([
      ["seed", 1, 5],
      ["series_a", 3, 20],
      ["series_b", 1, 100],
    ]);
    expect(m.top_sectors).toEqual([
      { sector: "fintech", count: 2 },
      { sector: "health", count: 2 },
    ]);
    expect(m.top_leads.map((l) => [l.name, l.leads, l.usd_millions])).toEqual([
      ["Fund One", 2, 120],
      ["Fund Two", 2, 5],
      ["Fund Three", 1, 0],
    ]);
    expect(m.top_publishers).toEqual([
      { host: "techcrunch.com", count: 3 },
      { host: "tech.eu", count: 2 },
      { host: "reuters.com", count: 1 },
    ]);
  });

  test("twelve zero-filled weeks hold exactly the visible news rounds", () => {
    expect(m.by_week).toHaveLength(12);
    expect(m.by_week.reduce((n, w) => n + w.count, 0)).toBe(6);
    for (const w of m.by_week) expect(new Date(`${w.week}T00:00:00Z`).getUTCDay()).toBe(1);
  });

  test("a preset narrows every aggregate", async () => {
    const seed = await market(handle, "seed");
    expect(seed.month.rounds).toBe(0);
    expect(seed.top_publishers).toEqual([]);
  });

  test("the biggest rounds are the week's stated amounts, largest first; trending never ranks a queued round", async () => {
    expect(view.biggest.map((r) => r.company.name)).toEqual(["Alder", "Birch"]);
    // A round still being raised is not money raised: the Capital figure leaves it out, and so does the list.
    await add("Expectco", { daysAgo: 1, usd: 12_000, hosts: ["expected.example"], disposition: "flagged" });
    await handle.update(fundingRounds).set({ certainty: "expected" }).where(eq(fundingRounds.id, ids.Expectco));
    expect((await marketView(handle)).biggest.map((r) => r.company.name)).toEqual(["Alder", "Birch"]);
    await setDisposition(handle, ids.Expectco, "rejected");
    const now = new Date();
    await handle.insert(trendingRounds).values([
      { roundId: ids.Alder, companyId: "alder", firstSeenAt: now, score: 2, people: 3, stale: false, scoredAt: now },
      { roundId: ids.Queued, companyId: "queued", firstSeenAt: now, score: 9, people: 9, stale: false, scoredAt: now },
      { roundId: ids.Dossierco, companyId: "dossierco", firstSeenAt: now, score: 8, people: 8, stale: false, scoredAt: now },
    ]);
    const fresh = await marketView(handle);
    expect(fresh.trending.rounds.map((r) => r.company.name)).toEqual(["Alder"]);
    expect(fresh.trending.total).toBe(1);
    expect(fresh.trending.rounds[0].trending.summary).toContain("3 people on X");
  });
});

describe("every figure matches the feed its link opens", () => {
  /** The feed's count for a marketFeedHref, read the way app/(dashboard)/feed/page.tsx reads the URL. */
  const feedCount = (href: string) => {
    const q = new URL(href, "http://app.test").searchParams;
    const since = q.get("since") ?? undefined;
    const until = q.get("until") ?? undefined;
    return countRounds(handle, {
      since,
      until,
      stages: q.get("stage") ? [q.get("stage") as "seed"] : undefined,
      sector: q.get("sector") ?? undefined,
      source: q.get("source") ?? undefined,
      history: q.get("history") === "exclude" ? "exclude" : feedHistory({ since, until }),
    });
  };

  test("the spans, the stages, the sectors, the publishers, and each week", async () => {
    expect(await feedCount(marketFeedHref(m.week))).toBe(m.week.rounds);
    expect(await feedCount(marketFeedHref(m.prev_week))).toBe(m.prev_week.rounds);
    expect(await feedCount(marketFeedHref(m.month))).toBe(m.month.rounds);
    for (const s of m.by_stage) expect(await feedCount(marketFeedHref(m.month, { stage: s.stage }))).toBe(s.count);
    for (const s of m.top_sectors) expect(await feedCount(marketFeedHref(m.month, { sector: s.sector }))).toBe(s.count);
    for (const p of m.top_publishers) expect(await feedCount(marketFeedHref(m.month, { source: p.host }))).toBe(p.count);
    for (const w of m.by_week) expect(await feedCount(marketFeedHref({ since: w.week, until: w.until }))).toBe(w.count);
  });

  test("without history=exclude a date range brings in the earlier round, which is why the links carry it", async () => {
    const since = m.week.since;
    expect(await countRounds(handle, { since, history: feedHistory({ since }) })).toBe(m.week.rounds + 1);
  });

  test("the source filter lists the rounds a publisher reported", async () => {
    const { rows } = await listRounds(handle, { source: "techcrunch.com", history: "exclude" });
    expect(rows.map((r) => r.company.name).sort()).toEqual(["Alder", "Cedar", "Dogwood"]);
  });

  test("a store that began this week compares against no earlier span and says since when instead", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(m.watching_since).toBe(today);
    expect(comparable(m.prev_week, m.watching_since)).toBe(false);
    expect(comparable(m.prev_week, m.prev_week.since)).toBe(true);
    expect(comparable(m.prev_week, null)).toBe(true);
    const text = renderToStaticMarkup(createElement(MarketPanels, { view, preset: "", laneOn: true }));
    expect(text).toContain("Sweeping since");
    expect(text).toContain("From 2 stated amounts");
    expect(text).not.toMatch(/(Up|Down) \d+%/);
  });
});

describe("what a visitor reads", () => {
  const html = () =>
    renderToStaticMarkup(
      createElement("div", null, createElement(MarketPanels, { view, preset: "", laneOn: true }), createElement(MarketNote)),
    );

  test("the market figures, and no word about credits, runs, costs, models, or the review queue", () => {
    const text = html();
    expect(text).toContain("CAPITAL · 7D");
    expect(text).toContain("$25M");
    expect(text).toContain("Biggest rounds");
    expect(text).toContain("Top publishers");
    expect(text).not.toMatch(/credit|review|queue|spend|\bcost|\bmodel|\bruns?\b|\bcr\b/i);
    for (const hidden of ["Queued", "Refused", "Dossierco", "Hidden Fund", "queued.example", "sec.gov"]) expect(text).not.toContain(hidden);
  });

  test("the links open the Latest view filtered to the span, with history left out", () => {
    const text = html();
    expect(text).toContain(`href="/feed?view=latest&amp;since=${m.week.since}&amp;history=exclude"`);
    expect(text).toContain(`/feed?view=latest&amp;source=techcrunch.com&amp;since=${m.month.since}&amp;history=exclude`);
    expect(text).toContain('href="/investors/fund-one"');
  });

  test("an empty market says so in every panel instead of drawing zeros as data", async () => {
    const empty = await marketView(await testDb());
    const text = renderToStaticMarkup(createElement(MarketPanels, { view: empty, preset: "", laneOn: false }));
    expect(text).toContain("No rounds announced in the last 12 weeks.");
    expect(text).toContain("No round with a stated amount in the last 7 days.");
    expect(text).toContain("This instance does not run the Trending lane.");
    expect(text).toContain("No publisher reported a round in the last 30 days.");
  });
});

describe("what an admin reads besides", () => {
  test("the queue, unread, credits, and runs", async () => {
    const h = await testDb();
    await persistRecords(h, [record({ company_name: "Queued Co", confidence: 0.3 })], "series-a-b", "run-q", { startIn: "review" });
    await h
      .insert(runs)
      .values({ id: "run-x", presetSlug: "series-a-b", lane: "sweep", window: "week", finishedAt: new Date(), creditsMeasured: 120 });
    const o = await overview(h);
    const stats = renderToStaticMarkup(createElement(AdminStats, { o, demo: true }));
    expect(stats).toContain("NEEDS REVIEW");
    expect(stats).toContain("CREDITS · 30D");
    expect(stats).toContain("Admins only");
    const panels = renderToStaticMarkup(createElement(AdminPanels, { o, latest: [], feedHref: "/feed", demo: false }));
    expect(panels).toContain("Recent runs");
    expect(panels).toContain("120 cr");
    expect(panels).not.toContain("Admins only");
  });
});

describe("helpers", () => {
  test("versus says the change in words that fit a hint", () => {
    expect(versus(124, 100, "last week")).toBe("Up 24% on last week");
    expect(versus(92, 100, "last week")).toBe("Down 8% on last week");
    expect(versus(100, 100, "last week")).toBe("Level with last week");
    expect(versus(3, 0, "last week")).toBe("None last week");
    expect(versus(0, 0, "last week")).toBe("None last week either");
    expect(versusParts(124, 100, "prior 30 days")).toEqual(["Up 24%", "on prior 30 days"]);
  });

  test("each span is compared with one of the same length", () => {
    const s = marketSpans(new Date("2026-09-24T15:00:00Z"));
    expect(s.week).toEqual({ since: "2026-09-17", until: null });
    expect(s.prev_week).toEqual({ since: "2026-09-09", until: "2026-09-16" });
    expect(s.month).toEqual({ since: "2026-08-25", until: null });
    expect(s.prev_month).toEqual({ since: "2026-07-25", until: "2026-08-24" });
  });

  test("the week grid is twelve Monday-to-Sunday weeks ending with the current one", () => {
    const grid = weekGrid(new Date("2026-09-24T15:00:00Z"));
    expect(grid).toHaveLength(12);
    expect(grid[11]).toEqual({ since: "2026-09-21", until: "2026-09-27" });
    expect(grid[0]).toEqual({ since: "2026-07-06", until: "2026-07-12" });
  });

  test("marketFeedHref opens Latest unless it sorts, and drops empty filters", () => {
    expect(marketFeedHref({ since: "2026-09-17", until: null })).toBe("/feed?view=latest&since=2026-09-17&history=exclude");
    expect(marketFeedHref({ since: "2026-09-09", until: "2026-09-16" }, { sort: "amount", preset: undefined })).toBe(
      "/feed?sort=amount&since=2026-09-09&until=2026-09-16&history=exclude",
    );
    expect(marketFeedHref(null, { stage: "seed" })).toBe("/feed?view=latest&stage=seed");
  });

  test("feedScope names the filters the feed has no control for", () => {
    expect(feedScope({ since: "2026-09-10", until: "2026-09-16" })).toBe("Announced 10 Sep to 16 Sep 2026.");
    expect(feedScope({ since: "2025-12-29", until: "2026-01-04" })).toBe("Announced 29 Dec 2025 to 4 Jan 2026.");
    expect(feedScope({ since: "2026-09-17", source: "www.tech.eu" })).toBe("Announced since 17 Sep 2026, reported by tech.eu.");
    expect(feedScope({ source: "tech.eu" })).toBe("Reported by tech.eu.");
    expect(feedScope({})).toBeNull();
  });
});
