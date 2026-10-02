// The Trending lane's store side, cron route, API sort, and feed order against an in-memory
// Postgres. No network: X search results are built from fixtures shaped like the spike's.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import type { RoundXSearch, XHit } from "@fireround/core";
import { classifyX, parseXResult } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

const started = vi.hoisted(() => [] as unknown[][]);
vi.mock("workflow/api", () => ({
  start: vi.fn(async (...args: unknown[]) => {
    started.push(args);
    return { runId: "mock" };
  }),
}));

import { GET as trendingCron } from "../app/api/cron/trending/route";
import { GET as roundsGet } from "../app/api/v1/rounds/route";
import { buzzLevel } from "../lib/buzz";
import { corroborateRecord } from "../lib/corroborate";
import { db } from "../lib/db";
import { persistRecords } from "../lib/persist";
import { setCoverageSetting } from "../lib/settings";
import {
  buzzFor,
  dueCheckpoint,
  estimateRun,
  followRounds,
  listTrending,
  pickDisplayPosts,
  rescore,
  roundsOnX,
  searchDue,
  showcaseTargets,
  storeEngagement,
  storeHn,
  storeSearch,
  subjectOf,
  trendingMarks,
  trendingRoundIds,
} from "../lib/trending";
import { trendingWorkflow } from "../workflows/trending";
import { record } from "./helpers";

const HOUR = 3_600_000;
const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);

/** A status id whose snowflake time is `at`: the inverse of snowflakeTime. */
function statusIdAt(at: Date, salt: number): string {
  return String(((BigInt(at.getTime()) - 1288834974657n) << 22n) + BigInt(salt));
}

/** One search hit by `handle` about `name`, `hoursAgo` old, classified against the round's subject. */
function hit(
  subject: ReturnType<typeof subjectOf>,
  handle: string,
  displayName: string,
  text: string,
  hoursAgo: number,
  salt: number,
): XHit {
  const at = new Date(NOW.getTime() - hoursAgo * HOUR);
  const r = parseXResult(
    { url: `https://x.com/${handle}/status/${statusIdAt(at, salt)}`, title: `${displayName} on X`, description: text },
    NOW,
  );
  if (!r) throw new Error("fixture did not parse");
  return { ...r, ...classifyX(r, subject), queries: ["name_fund"] };
}

function search(hits: XHit[], handle: RoundXSearch["handle"] = null): Pick<RoundXSearch, "hits" | "handle"> {
  return { hits, handle };
}

let acmeId = "";
let betaId = "";
let staleId = "";

beforeAll(async () => {
  const handle = await db();
  const sources = (company: string, hosts: string[]) =>
    hosts.map((h) => ({ url: `https://${h}/${company}-raises`, host: h, title: `${company} raises` }));
  await persistRecords(
    handle,
    [
      record({
        company_name: "Acmeloop",
        announced_date: TODAY,
        company_domain: "acmeloop.com",
        company_website: "https://acmeloop.com",
        lead_investors: ["Radical Ventures"],
        amount: { value: 40, currency: "USD", as_written: "$40M", usd_millions: 40, fx_rate: 1, fx_date: TODAY },
        sources: sources("acmeloop", ["techcrunch.com", "news.example", "wire.example", "x.com"]),
        verification: { status: "confirmed", notes: [], url: "https://techcrunch.com/acmeloop-raises", sources_seen: 4 },
      }),
      record({
        company_name: "Betaworks Robotics",
        announced_date: TODAY,
        amount: { value: 12, currency: "USD", as_written: "$12M", usd_millions: 12, fx_rate: 1, fx_date: TODAY },
        sources: sources("beta", ["reuters.com"]),
      }),
      record({
        company_name: "Stalecorp",
        announced_date: TODAY,
        amount: { value: 900, currency: "USD", as_written: "$900M", usd_millions: 900, fx_rate: 1, fx_date: TODAY },
        sources: sources("stale", ["news.example", "wire.example", "techcrunch.com"]),
        verification: { status: "confirmed", notes: [], url: "https://techcrunch.com/stale-raises", sources_seen: 3 },
      }),
    ],
    "series-a-b",
    "run-trending",
  );
  const searched = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
  for (const id of ["acmeloop:series_a", "betaworks-robotics:series_a", "stalecorp:series_a"])
    await corroborateRecord(handle, searched, `${id}:${TODAY}`, { broad: true, maxPages: 0 });
  const rows = await handle.select({ id: schema.fundingRounds.id, companyId: schema.fundingRounds.companyId }).from(schema.fundingRounds);
  acmeId = rows.find((r) => r.companyId.includes("acmeloop"))?.id ?? "";
  betaId = rows.find((r) => r.companyId.includes("betaworks"))?.id ?? "";
  staleId = rows.find((r) => r.companyId.includes("stalecorp"))?.id ?? "";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  started.length = 0;
});

describe("checkpoints", () => {
  const seen = new Date("2026-09-22T00:00:00Z");
  const at = (h: number) => new Date(seen.getTime() + h * HOUR);

  test("first seen, +6h, +24h, +48h, and nothing after 72 hours", () => {
    expect(dueCheckpoint(seen, at(0))).toBe(0);
    expect(dueCheckpoint(seen, at(5))).toBe(0);
    expect(dueCheckpoint(seen, at(6))).toBe(1);
    expect(dueCheckpoint(seen, at(30))).toBe(2);
    expect(dueCheckpoint(seen, at(50))).toBe(3);
    expect(searchDue(0, seen, at(0))).toBe(true);
    expect(searchDue(1, seen, at(5))).toBe(false);
    expect(searchDue(1, seen, at(6))).toBe(true);
    // Never searched and 30 hours old: one search, for the +24h checkpoint, not three.
    expect(searchDue(0, seen, at(30))).toBe(true);
    expect(searchDue(3, seen, at(30))).toBe(false);
    expect(searchDue(4, seen, at(60))).toBe(false);
    expect(searchDue(0, seen, at(72))).toBe(false);
  });

  test("a run's estimate prices the queries each due round will run, its handle read, and the showcase", () => {
    const fresh = { xHandle: null, handleCheckedAt: null, amounts: ["$40M"] };
    const known = { xHandle: "acme", handleCheckedAt: "2026-09-22T00:00:00Z", amounts: ["$40M"] };
    const none = { xHandle: null, handleCheckedAt: "2026-09-22T00:00:00Z", amounts: [] };
    expect(estimateRun([fresh], 0)).toBe(3 * 4 + 1);
    expect(estimateRun([known], 0)).toBe(3 * 4);
    expect(estimateRun([none], 2)).toBe(4 + 2 * 30);
  });
});

describe("persistence, the rescore, and the reads", () => {
  test("the lane follows today's visible rounds once, with their amounts as posts write them", async () => {
    const handle = await db();
    const first = await followRounds(handle, NOW);
    const again = await followRounds(handle, NOW);
    expect(first.map((r) => r.roundId).sort()).toEqual([acmeId, betaId, staleId].sort());
    expect(again).toHaveLength(3);
    const acme = first.find((r) => r.roundId === acmeId);
    expect(acme).toMatchObject({ name: "Acmeloop", checkpoints: 0, xHandle: null, website: "https://acmeloop.com" });
    expect(acme?.amounts[0]).toBe("$40M");
  });

  test("a search stores each post once by status id, advances the checkpoint, and keeps the handle", async () => {
    const handle = await db();
    const followed = await followRounds(handle, NOW);
    const acme = followed.find((r) => r.roundId === acmeId);
    if (!acme) throw new Error("not followed");
    const subject = { ...subjectOf(acme), handle: "acmeloop" };
    const people = Array.from({ length: 11 }, (_, i) =>
      hit(subject, `person${i}`, `Person ${i}`, `Acmeloop raised $40M, congrats`, 2 + i, i),
    );
    const hits = [
      hit(subject, "acmeloop", "Acmeloop", "We raised a $40M Series A", 3, 50),
      ...people,
      hit(subject, "techfundingnews", "Tech Funding News", "Acmeloop raises $40M", 1, 60),
      hit(subject, "radicalventures", "Radical Ventures", "Proud to lead Acmeloop's $40M round", 2, 70),
      hit(subject, "bystander", "Bystander", "Acmeloop is a nice product", 1, 80),
    ];
    await storeSearch(handle, acmeId, search(hits, { handle: "acmeloop", source: "homepage" }), 0, NOW, true);
    // The same search stored twice (a retried step) adds nothing.
    await storeSearch(handle, acmeId, search(hits, { handle: "acmeloop", source: "homepage" }), 0, NOW, true);
    const posts = await handle.select().from(schema.trendingPosts).where(eq(schema.trendingPosts.roundId, acmeId));
    expect(posts).toHaveLength(hits.length);
    expect(posts.filter((p) => p.relevant)).toHaveLength(hits.length - 1);
    const [row] = await handle.select().from(schema.trendingRounds).where(eq(schema.trendingRounds.roundId, acmeId));
    expect(row).toMatchObject({ checkpoints: 1, xHandle: "acmeloop", xHandleSource: "homepage" });
    expect(searchDue(row.checkpoints, row.firstSeenAt, NOW)).toBe(false);
  });

  test("the rescore counts people (outlets out, the lead investor in), outlets from the press, and labels the round", async () => {
    const handle = await db();
    const followed = await followRounds(handle, NOW);
    const beta = followed.find((r) => r.roundId === betaId);
    const stale = followed.find((r) => r.roundId === staleId);
    if (!beta || !stale) throw new Error("not followed");
    const bs = subjectOf(beta);
    await storeSearch(handle, betaId, search([hit(bs, "fan", "Fan", "Betaworks Robotics raised $12M", 1, 1)]), 0, NOW, true);
    await storeHn(
      handle,
      betaId,
      [{ id: "1", title: "Betaworks Robotics raises $12M", url: null, points: 40, comments: 3, at: NOW.toISOString() }],
      NOW,
    );
    // Most posts naming Stalecorp and its amount are from weeks ago: the day on record is late.
    const ss = subjectOf(stale);
    const old = [1, 2, 3].map((i) => hit(ss, `early${i}`, `Early ${i}`, "Stalecorp raised $900M", 24 * 30 + i, i));
    await storeSearch(handle, staleId, search([...old, hit(ss, "late", "Late", "Stalecorp raised $900M", 2, 9)]), 0, NOW, true);

    const summary = await rescore(handle, NOW);
    expect(summary.scored).toBe(3);
    expect(summary.labelled).toEqual([acmeId]);
    expect(summary.stale).toBe(1);

    const marks = await trendingMarks(handle, [acmeId, betaId, staleId], NOW);
    // 11 people, the company's own account, and its lead investor; the news desk is an outlet; x.com is not press.
    expect(marks.get(acmeId)).toMatchObject({ label: true, rank: 1, people: 13, outlets: 3, summary: "13 people on X · 3 outlets" });
    expect(marks.get(betaId)).toMatchObject({ label: false, rank: 2, people: 1, hn_points: 40 });
    expect(marks.has(staleId)).toBe(false);
    const [staleRow] = await handle.select().from(schema.trendingRounds).where(eq(schema.trendingRounds.roundId, staleId));
    expect(staleRow.stale).toBe(true);
    expect(staleRow.staleReason).toContain("3 of 4 X posts");
    const outlets = await handle.select().from(schema.trendingPosts).where(eq(schema.trendingPosts.isOutlet, true));
    expect(outlets.map((p) => p.handle)).toEqual(["techfundingnews"]);
  });

  test("the trending order leaves out stale rounds and honours the feed's filters", async () => {
    const handle = await db();
    expect(await trendingRoundIds(handle, NOW)).toEqual([acmeId, betaId]);
    const all = await listTrending(handle, {}, { offset: 0, limit: 50 }, NOW);
    expect(all.rows.map((r) => r.id)).toEqual([acmeId, betaId]);
    expect(all.total).toBe(2);
    const page2 = await listTrending(handle, {}, { offset: 1, limit: 1 }, NOW);
    expect(page2.rows.map((r) => r.id)).toEqual([betaId]);
    const filtered = await listTrending(handle, { q: "Betaworks" }, { offset: 0, limit: 50 }, NOW);
    expect(filtered.rows.map((r) => r.id)).toEqual([betaId]);
    // Three days on, nothing is in the window.
    expect(await trendingRoundIds(handle, new Date(NOW.getTime() + 73 * HOUR))).toEqual([]);
  });

  test("the company page shows the company's own post first, then its investor's, one post per voice", async () => {
    const handle = await db();
    const [acme] = await roundsOnX(handle, [acmeId]);
    expect(acme.posts).toHaveLength(3);
    expect(acme.posts[0]).toMatchObject({ handle: "acmeloop", self: true });
    expect(acme.posts[1]).toMatchObject({ handle: "radicalventures" });
    expect(acme.posts.map((p) => p.handle)).not.toContain("techfundingnews");
    expect(acme).toMatchObject({ people: 13, label: true, stale_reason: null });
    const [stale] = await roundsOnX(handle, [staleId]);
    expect(stale.stale_reason).toContain("predate");
  });

  test("the showcase reads a labelled round's top three posts, then waits six hours per post", async () => {
    const handle = await db();
    const targets = await showcaseTargets(handle, [acmeId], NOW);
    expect(targets).toHaveLength(3);
    for (const t of targets)
      await storeEngagement(handle, t, { likes: 120, reposts: 9, text: "We raised a $40M Series A to build loops." }, NOW);
    expect(await showcaseTargets(handle, [acmeId], new Date(NOW.getTime() + 5 * HOUR))).toHaveLength(0);
    expect(await showcaseTargets(handle, [acmeId], new Date(NOW.getTime() + 6 * HOUR))).toHaveLength(3);
    const [acme] = await roundsOnX(handle, [acmeId]);
    expect(acme.posts[0]).toMatchObject({ likes: 120, reposts: 9, snippet: "We raised a $40M Series A to build loops." });
  });

  test("the Buzz column reads each row's mark and the leader's score, with nothing for a round out of the window", async () => {
    const handle = await db();
    const buzz = await buzzFor(handle, [acmeId, betaId, staleId], NOW);
    expect(Object.keys(buzz.marks).sort()).toEqual([acmeId, betaId].sort());
    // Acmeloop leads, so its meter is full and the scale's top is its score; Beta sits lower.
    expect(buzz.scale.top).toBeCloseTo(buzz.marks[acmeId].score, 2);
    expect(buzzLevel(buzz.marks[acmeId].score, buzz.scale)).toBe(5);
    expect(buzz.marks[betaId].score).toBeLessThan(buzz.scale.top);
    expect(buzzLevel(buzz.marks[betaId].score, buzz.scale)).toBeLessThan(5);
    expect(buzz.scale.cuts).toHaveLength(4);
    // Ranks are read live from the window, in the Trending view's order.
    expect(buzz.marks[acmeId].rank).toBe(1);
    expect(buzz.marks[betaId].rank).toBe(2);
    expect(await buzzFor(handle, [], NOW)).toEqual({ marks: {}, scale: { cuts: [], top: 0 } });
    expect((await buzzFor(handle, [acmeId], new Date(NOW.getTime() + 73 * HOUR))).marks).toEqual({});
  });

  test("display order: own post, then named people, then liked, then earliest; one per author", () => {
    const p = (postKey: string, handle: string, extra: Partial<{ isSelf: boolean; authorName: string; likes: number; h: number }>) => ({
      postKey,
      handle,
      authorName: extra.authorName ?? handle,
      isSelf: extra.isSelf ?? false,
      likes: extra.likes ?? null,
      postedAt: new Date(NOW.getTime() - (extra.h ?? 1) * HOUR),
    });
    const order = pickDisplayPosts(
      [
        p("1", "early", { h: 9 }),
        p("2", "liked", { likes: 50 }),
        p("3", "founder", { authorName: "Jane Doe" }),
        p("4", "acme", { isSelf: true }),
        p("5", "acme", { isSelf: true, h: 2 }),
      ],
      ["Jane Doe"],
    ).map((x) => x.postKey);
    expect(order).toEqual(["5", "3", "2", "1"]);
  });
});

describe("GET /api/v1/rounds?sort=trending", () => {
  test("ranked rows, each with its trending object, paged by position", async () => {
    const res = await roundsGet(new Request("http://app.test/api/v1/rounds?sort=trending&limit=1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; trending: { label: boolean; people: number } | null }>;
      next_cursor: string;
    };
    expect(body.data.map((r) => r.id)).toEqual([acmeId]);
    expect(body.data[0].trending).toMatchObject({ label: true, people: 13 });
    expect(body.next_cursor).toBe("trend:1");
    const next = (await (
      await roundsGet(new Request(`http://app.test/api/v1/rounds?sort=trending&cursor=${body.next_cursor}`))
    ).json()) as {
      data: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(next.data.map((r) => r.id)).toEqual([betaId]);
    expect(next.next_cursor).toBeNull();
  });

  test("every order carries the trending object (null for a round outside it); a cursor from another order is a 400", async () => {
    const body = (await (await roundsGet(new Request("http://app.test/api/v1/rounds"))).json()) as {
      data: Array<{ id: string; trending: unknown }>;
    };
    expect(body.data.find((r) => r.id === staleId)?.trending).toBeNull();
    expect(body.data.find((r) => r.id === acmeId)?.trending).toMatchObject({ label: true });
    expect((await roundsGet(new Request("http://app.test/api/v1/rounds?sort=trending&cursor=2026-09-02|a"))).status).toBe(400);
    expect((await roundsGet(new Request("http://app.test/api/v1/rounds?cursor=trend:3"))).status).toBe(400);
    expect((await roundsGet(new Request("http://app.test/api/v1/rounds?sort=hot"))).status).toBe(400);
  });
});

describe("GET /api/cron/trending", () => {
  test("refuses a call without the cron bearer when CRON_SECRET is set", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret-s3cret-s3cret");
    expect((await trendingCron(new Request("http://app.test/api/cron/trending"))).status).toBe(401);
    expect(
      (await trendingCron(new Request("http://app.test/api/cron/trending", { headers: { authorization: "Bearer wrong" } }))).status,
    ).toBe(401);
    expect(started).toHaveLength(0);
  });

  test("off at Lite unless forced; on at Deep, one workflow run per tick", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret-s3cret-s3cret");
    const auth = { headers: { authorization: "Bearer s3cret-s3cret-s3cret" } };
    const off = await (await trendingCron(new Request("http://app.test/api/cron/trending", auth))).json();
    expect(off).toMatchObject({ ok: true, skipped: expect.any(String) });
    expect(started).toHaveLength(0);

    const forced = (await (await trendingCron(new Request("http://app.test/api/cron/trending?force=1", auth))).json()) as {
      lanes: Array<{ lane: string; runId: string }>;
    };
    expect(forced.lanes[0].lane).toBe("trending");
    expect(started).toHaveLength(1);
    expect(started[0][0]).toBe(trendingWorkflow);
    expect(started[0][1]).toEqual([forced.lanes[0].runId]);

    await setCoverageSetting(await db(), { tier: "deep", overrides: {} });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 60_000));
    await trendingCron(new Request("http://app.test/api/cron/trending", auth));
    expect(started).toHaveLength(2);
    await setCoverageSetting(await db(), { tier: "lite", overrides: {} });
  });
});
