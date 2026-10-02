// The X announcements lane end to end against the real store: a post becomes a lead, the lead is
// searched for its article on the backoff, the article is read through the pipeline and lands under
// the preset its amount's band names; a lead that never finds one expires after the schedule; and a
// post from an account the company's homepage links lands on its own in review, unverified, until
// its article confirms it. Firecrawl, the read-back, and the rates are faked; the rules, persist,
// and the database are real.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import type { AnnouncementLead, ExtractedItem, FeedRecord } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  posts: [] as Array<{ url: string; title: string; description: string }>,
  /** Article pages each lead's search returns, by company or author; empty until the article exists. */
  articles: new Map<string, string[]>(),
  homepage: [] as string[],
  bios: new Map<string, string>(),
  bioReads: [] as string[],
  searches: [] as string[],
  extracted: [] as string[],
}));

vi.mock("@fireround/core", async (original) => {
  const core = await original<typeof import("@fireround/core")>();
  const parallaxItem = (url: string): ExtractedItem => ({
    round: {
      company_name: "Parallax",
      company_website: "https://parallax.ai",
      company_description: "an AI energy company",
      round_type_as_written: "fundraise",
      amount_as_written: "$117 million",
      amount_kind: "round",
      valuation_as_written: null,
      lead_investors: ["Founders Fund", "Eclipse", "Lux"],
      other_investors: [],
      announced_date: "2026-09-24",
      headquarters: null,
      sector: null,
      evidence_quote: "Parallax has raised $117 million in a fundraise led by Founders Fund, Eclipse and Lux.",
      source_url: null,
      is_background: false,
      is_rumor: false,
    },
    source: { url, host: core.hostOf(url), published: "2026-09-24" },
    page_kind: "article",
    page_date: "2026-09-24",
    grounded: true,
  });
  return {
    ...core,
    fetchRates: async () => null,
    reconcileModel: () => null,
    searchAnnouncements: async (_client: unknown, now: Date) => {
      const leads: AnnouncementLead[] = [];
      for (const p of fake.posts) {
        const x = core.parseXResult(p, now);
        const l = x && core.readAnnouncement(x, p.title, now);
        if (l && typeof l !== "string") leads.push(l);
      }
      return {
        leads,
        rejected: {},
        calls: [{ key: "q", results: fake.posts.length, leads: leads.length, credits: 4, error: null }],
        credits: 4,
      };
    },
    searchLeadArticles: async (_client: unknown, lead: AnnouncementLead, read: readonly string[] = []) => {
      const subject = lead.company ?? lead.authorName ?? "";
      fake.searches.push(subject);
      const picks = (fake.articles.get(subject) ?? []).filter((u) => !read.includes(u)).map((url) => ({ url }));
      return { picks, results: picks.length, credits: 2, error: null };
    },
    extractRounds: async (_client: unknown, targets: Array<{ url: string }>) => {
      fake.extracted.push(...targets.map((t) => t.url));
      return {
        items: targets.map((t) => parallaxItem(t.url)),
        pages: targets.map((t) => ({ url: t.url, ok: true, rounds: 1, ungrounded: 0, cached: false })),
        creditsEstimated: 5 * targets.length,
        notArticle: 0,
      };
    },
    judgeRecords: async (_client: unknown, records: FeedRecord[]) => ({
      records: records.map((r) => ({ ...r, verification: { status: "confirmed" as const, notes: [], url: r.sources[0]?.url ?? null } })),
      judged: records.length,
      confirmed: records.length,
      corrected: 0,
      contradicted: 0,
      notNews: 0,
      failed: 0,
      creditsEstimated: 5 * records.length,
    }),
    homepageHandles: async () => ({ handles: fake.homepage, credits: 1, error: null }),
    profileBio: async (_client: unknown, handle: string) => {
      fake.bioReads.push(handle);
      return { bio: fake.bios.get(handle) ?? "", links: [], credits: 30, error: null };
    },
  };
});

vi.mock("@/lib/firecrawl", () => ({ getFirecrawl: () => ({}) }));
vi.mock("@/lib/delivery", () => ({ enqueueDeliveries: async () => 0, flushDeliveries: async () => undefined }));
vi.mock("@/workflows/enrich", () => ({
  enrichPending: async () => ({ companies: 0, credits: 0, alexandriaCredits: 0, investorCredits: 0 }),
}));

import { resetDbForTests } from "@fireround/core/db";
import { db } from "../lib/db";
import { announcementsWorkflow } from "../workflows/announcements";

/** Seth Rosenberg's post quoting Carl Schoeller's launch, as the X search returned it. */
const PARALLAX_POST = {
  url: "https://x.com/sethgrosenberg/status/2103195007822000000",
  title: "Seth Rosenberg on X",
  description:
    "1 hour ago · @CarlSchoeller. Carl Schoeller · @CarlSchoeller · Now. Today we're launching Parallax, the AI energy company with a $117m fundraise led by Founders Fund, Eclipse, Lux, Diffusion, Greylock and General Catalyst.",
};
/** A founder's post naming no company: searched by the author's name, never found here. */
const AUTHOR_POST = {
  url: "https://x.com/BKRoberts/status/2103195007822000002",
  title: "Brian Roberts on X",
  description: "1 hour ago · We've raised $76M in initial funding from Caffeinated Capital, Founders Fund, Lux Capital, a16z, and others.",
};
const PARALLAX_RELEASE = "https://parallax.ai/news/launch";
const T0 = new Date("2026-09-24T20:30:00Z");
const at = (hours: number) => new Date(T0.getTime() + hours * 3_600_000);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  fake.posts = [];
  fake.articles = new Map();
  fake.homepage = [];
  fake.bios = new Map();
  fake.bioReads = [];
  fake.searches = [];
  fake.extracted = [];
  // A fresh in-memory store per test: lib/db keeps one migrated handle per process, so it is dropped with the old database.
  resetDbForTests();
  (globalThis as { __fundingFeedReady?: unknown }).__fundingFeedReady = undefined;
  await db();
});

afterEach(() => {
  vi.useRealTimers();
});

async function lead(key: string) {
  const [row] = await (await db()).select().from(schema.announcementLeads).where(eq(schema.announcementLeads.key, key));
  return row;
}

describe("the X announcements lane", () => {
  test("Parallax: a post is a lead, the article comes on the backoff, and the round lands under growth", async () => {
    fake.posts = [PARALLAX_POST, AUTHOR_POST];
    const first = await announcementsWorkflow("x-run-1", "http://localhost", 12);
    expect(first).toMatchObject({ leads: 2, newLeads: 2, attempted: 2, corroborated: 0 });
    let parallax = await lead("2103195007822000000");
    expect(parallax).toMatchObject({ status: "pending", attempts: 1, company: "Parallax", handle: "carlschoeller" });
    // The founder is quoted by an investor; parallax.ai links no account, so the post never lands on its own.
    expect(parallax?.selfVerified).toBe(false);
    expect(parallax?.nextAttemptAt?.toISOString()).toBe(at(2).toISOString());

    // An hour later the same post comes back from the search: still one lead, and not due yet.
    vi.setSystemTime(at(1));
    const second = await announcementsWorkflow("x-run-2", "http://localhost", 12);
    expect(second).toMatchObject({ newLeads: 0, attempted: 0 });

    // The article appears; the two-hour attempt reads it through the pipeline.
    fake.articles.set("Parallax", [PARALLAX_RELEASE]);
    vi.setSystemTime(at(2));
    const third = await announcementsWorkflow("x-run-3", "http://localhost", null);
    expect(third).toMatchObject({ attempted: 2, corroborated: 1 });
    expect(fake.extracted).toEqual([PARALLAX_RELEASE]);
    parallax = await lead("2103195007822000000");
    expect(parallax).toMatchObject({ status: "corroborated", attempts: 2, articleUrl: PARALLAX_RELEASE, nextAttemptAt: null });
    const rows = await (await db()).select().from(schema.fundingRounds);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId: "parallax.ai", presetSlug: "growth", stage: "other", stageAsWritten: "fundraise" });
    expect(rows[0].verification).toMatchObject({ status: "confirmed", url: PARALLAX_RELEASE });
    expect(parallax?.roundId).toBe(rows[0].id);

    const runs = await (await db()).select().from(schema.runs).where(eq(schema.runs.id, "x-run-3"));
    expect(runs[0]).toMatchObject({ lane: "announcements", presetSlug: "x-announcements" });
    expect(runs[0].counts?.corroborated).toBe(1);
  });

  test("a lead no article ever corroborates is searched six times over 48 hours, then expires", async () => {
    fake.posts = [AUTHOR_POST];
    await announcementsWorkflow("x-run-a", "http://localhost", 12);
    fake.posts = [];
    for (const h of [2, 6, 12, 24, 48]) {
      vi.setSystemTime(at(h));
      await announcementsWorkflow(`x-run-${h}`, "http://localhost", null);
    }
    const row = await lead("2103195007822000002");
    expect(row).toMatchObject({ status: "expired", attempts: 6, nextAttemptAt: null, company: null, authorName: "Brian Roberts" });
    expect(fake.searches).toEqual(Array(6).fill("Brian Roberts"));
    vi.setSystemTime(at(72));
    expect(await announcementsWorkflow("x-run-72", "http://localhost", null)).toMatchObject({ attempted: 0 });
  });

  test("the company's own post, its account linked from its homepage, stays in review until its release confirms it", async () => {
    fake.posts = [
      {
        url: "https://x.com/parallaxenergy/status/2103195007822000001",
        title: "Parallax on X",
        description:
          "1 hour ago · Today we're launching Parallax, the AI energy company with a $117m fundraise led by Founders Fund, Eclipse and Lux. More at parallax.ai",
      },
    ];
    fake.homepage = ["parallaxenergy"];
    const run = await announcementsWorkflow("x-self-1", "http://localhost", 12);
    expect(run).toMatchObject({ published: 1, corroborated: 0 });
    const handle = await db();
    let [round] = await handle.select().from(schema.fundingRounds);
    expect(round).toMatchObject({ presetSlug: "growth", disposition: "review", stage: "other" });
    expect(round.verification).toMatchObject({ status: "unverified", url: "https://x.com/parallaxenergy/status/2103195007822000001" });
    expect(round.verification?.notes[0]).toContain("@parallaxenergy");
    const row = await lead("2103195007822000001");
    expect(row).toMatchObject({ status: "published", selfVerified: true, roundId: round.id });

    // The post alone never verifies it; the article, when it comes, does.
    fake.articles.set("Parallax", [PARALLAX_RELEASE]);
    vi.setSystemTime(at(2));
    expect(await announcementsWorkflow("x-self-2", "http://localhost", null)).toMatchObject({ corroborated: 1 });
    const rounds = await handle.select().from(schema.fundingRounds);
    expect(rounds).toHaveLength(1);
    [round] = rounds;
    expect(round.verification).toMatchObject({ status: "confirmed", url: PARALLAX_RELEASE });
    expect(await lead("2103195007822000001")).toMatchObject({ status: "corroborated" });
  });

  describe("a founder's post, confirmed by a second account, lands on its own", () => {
    /** A status id for a post at `when`: X's snowflake carries the time. */
    const statusAt = (when: Date) => ((BigInt(when.getTime()) - 1288834974657n) << 22n).toString();
    const launch =
      "Today we're launching Parallax, the AI energy company with a $117m fundraise led by Founders Fund, Eclipse, Lux, Diffusion, Greylock and General Catalyst.";
    const post = (handle: string, name: string, when: Date) => ({
      url: `https://x.com/${handle}/status/${statusAt(when)}`,
      title: `${name} on X`,
      description: `1 hour ago · ${launch}`,
    });
    const carl = post("CarlSchoeller", "Carl Schoeller", at(-1));
    const victor = post("victoralazarte", "Victor Lazarte", at(-0.5));

    test("a bio that links the company and a confirmation within twelve hours land it in review, dated by the page", async () => {
      fake.posts = [carl, victor];
      fake.bios.set("carlschoeller", "CEO @ Parallax");
      const run = await announcementsWorkflow("x-founder-1", "http://localhost", 12);
      expect(run).toMatchObject({ published: 1 });
      const rows = await (await db()).select().from(schema.fundingRounds);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ companyId: "parallax", disposition: "review", dateBasis: "page", announcedOn: "2026-09-24" });
      expect(rows[0].verification).toMatchObject({ status: "unverified" });
      expect(rows[0].verification?.notes[0]).toMatch(
        /^announced on X by @carlschoeller, whose X bio links the company, and confirmed within 12 hours by @victoralazarte/,
      );
      // The confirming post is the same round, found in the store.
      expect(await lead(statusAt(at(-0.5)))).toMatchObject({ status: "known", roundId: rows[0].id });
    });

    test("no confirmation, no landing, and no bio read", async () => {
      fake.posts = [carl];
      fake.bios.set("carlschoeller", "CEO @ Parallax");
      expect(await announcementsWorkflow("x-founder-2", "http://localhost", 12)).toMatchObject({ published: 0 });
      expect(fake.bioReads).toEqual([]);
      expect(await (await db()).select().from(schema.fundingRounds)).toHaveLength(0);
    });

    test("a bio that does not link the company never lands it, and is not read again", async () => {
      fake.posts = [carl, victor];
      fake.bios.set("carlschoeller", "Energy, materials, and good coffee.");
      fake.bios.set("victoralazarte", "Partner at Primary. Views mine.");
      await announcementsWorkflow("x-founder-3", "http://localhost", 12);
      expect(await (await db()).select().from(schema.fundingRounds)).toHaveLength(0);
      expect(await lead(statusAt(at(-1)))).toMatchObject({ status: "pending", note: "founder bio: does not link the company" });
      const reads = fake.bioReads.length;
      vi.setSystemTime(at(2));
      await announcementsWorkflow("x-founder-4", "http://localhost", null);
      expect(fake.bioReads.length).toBe(reads);
    });

    test("a confirmation that arrives after the founder's post is a day old leaves it for the article", async () => {
      fake.posts = [carl];
      fake.bios.set("carlschoeller", "CEO @ Parallax");
      await announcementsWorkflow("x-founder-5", "http://localhost", 12);
      for (const h of [2, 6, 12]) {
        vi.setSystemTime(at(h));
        await announcementsWorkflow(`x-founder-6-${h}`, "http://localhost", null);
      }
      // A second account's post from 11.5 hours after Carl's, first returned by the search at hour 22.
      vi.setSystemTime(at(22));
      fake.posts = [post("victoralazarte", "Victor Lazarte", at(10.5))];
      fake.bios.set("victoralazarte", "Partner at Primary. Views mine.");
      await announcementsWorkflow("x-founder-7", "http://localhost", 12);
      // Carl's next attempt is at hour 24, when his post is 25 hours old: no bio read, no landing.
      vi.setSystemTime(at(24));
      await announcementsWorkflow("x-founder-8b", "http://localhost", null);
      expect(fake.bioReads).not.toContain("carlschoeller");
      expect(await (await db()).select().from(schema.fundingRounds)).toHaveLength(0);
    });

    test("an X-landed round the store already knows from months before is held in review, never visible", async () => {
      const handle = await db();
      const { persistRecords } = await import("../lib/persist");
      const { record } = await import("./helpers");
      // Parallax's $117M, stated five months ago: a founder re-posting it today is old news.
      await persistRecords(
        handle,
        [
          record({
            company_name: "Parallax",
            company_key: "parallax",
            stage: "other",
            stage_as_written: "fundraise",
            announced_date: "2026-04-20",
            date_basis: "stated",
            amount: { value: 117, currency: "USD", as_written: "$117m", usd_millions: 117, fx_rate: 1, fx_date: "2026-04-20" },
          }),
        ],
        "growth",
        "run-0",
      );
      fake.posts = [carl, victor];
      fake.bios.set("carlschoeller", "CEO @ Parallax");
      await announcementsWorkflow("x-founder-8", "http://localhost", 12);
      const landed = (await handle.select().from(schema.fundingRounds)).find((r) => r.announcedOn === "2026-09-24");
      expect(landed).toBeDefined();
      expect(landed?.disposition).toBe("review");
      expect(landed?.hold).toBeNull();
    });
  });
});
