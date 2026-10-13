import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { flushDeliveries } from "../lib/delivery";
import { applyRoundMerge, listRounds, persistRecords, planRoundMerge, type RoundRow } from "../lib/persist";
import { createTarget, setTargetEnabled } from "../lib/settings";
import {
  leadName,
  nextPost,
  oauthHeader,
  oauthSignature,
  postText,
  runXPosts,
  spacingMs,
  withoutLegalSuffix,
  X_API,
  type XConfig,
  xConfig,
  xLength,
  xRefusal,
  xRules,
} from "../lib/x-posts";
import { record, testDb } from "./helpers";

const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const ORIGIN = "https://fireround.dev";
const usd = (m: number) => ({ value: m, currency: "USD", as_written: `$${m} million`, usd_millions: m, fx_rate: 1, fx_date: TODAY });
const CREDS = { consumerKey: "ck", consumerSecret: "cs", accessToken: "at", accessTokenSecret: "ats" };
const cfg = (over: Partial<XConfig> = {}): XConfig => ({
  mode: "dry_run",
  minUsdMillions: 50,
  trendingTop: 5,
  maxPerDay: 6,
  credentials: null,
  reviewTarget: null,
  ...over,
});
const quiet = () => {};

/** Persist rounds and publish them as the pipeline would after a confirmed read-back. */
async function published(db: Db, ...records: ReturnType<typeof record>[]): Promise<RoundRow[]> {
  await persistRecords(db, records, "series-a-b", "run-1");
  for (const r of records)
    await db
      .update(schema.fundingRounds)
      .set({ disposition: "publish", verification: { status: "confirmed", notes: [], url: null } })
      .where(eq(schema.fundingRounds.id, r.id));
  return (await listRounds(db, { ids: records.map((r) => r.id), limit: 50 })).rows;
}

const spiko = (over: Partial<Parameters<typeof record>[0]> = {}) =>
  record({
    company_name: "Spiko",
    company_key: "spiko",
    stage: "series_b",
    stage_as_written: "Series B",
    amount: usd(90),
    lead_investors: ["New Enterprise Associates"],
    announced_date: TODAY,
    sources: [{ url: "https://www.businesswire.com/news/home/spiko", host: "businesswire.com", title: "Spiko raises $90M" }],
    ...over,
  });

/** A fetch that records every call and answers like X. */
function fakeX(
  answer: (method: string) => Response = (m) =>
    new Response(JSON.stringify(m === "POST" ? { data: { id: "1001", text: "" } } : { data: { deleted: true } }), {
      status: m === "POST" ? 201 : 200,
    }),
) {
  const calls: Array<{ method: string; url: string; auth: string; body: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: String(url),
      auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? "",
      body: String(init?.body ?? ""),
    });
    return answer(method);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("OAuth 1.0a", () => {
  // X's documented example ("Creating a signature": api.x.com, the consumer and token secrets below).
  const creds = {
    consumerKey: "xvz1evFS4wEEPTGEFPHBog",
    consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    accessTokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
  };
  const url = "https://api.x.com/1.1/statuses/update.json?include_entities=true";
  const form = { status: "Hello Ladies + Gentlemen, a signed OAuth request!" };
  const opts = { nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", timestamp: 1318622958, form };

  test("the signature matches X's example", () => {
    const sig = oauthSignature(
      "POST",
      url,
      {
        ...form,
        oauth_consumer_key: creds.consumerKey,
        oauth_nonce: opts.nonce,
        oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp: "1318622958",
        oauth_token: creds.accessToken,
        oauth_version: "1.0",
      },
      creds.consumerSecret,
      creds.accessTokenSecret,
    );
    expect(sig).toBe("Ls93hJiZbQ3akF3HF3x1Bz8/zU4=");
  });

  test("the header matches X's example", () => {
    expect(oauthHeader("POST", url, creds, opts)).toBe(
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", oauth_signature="Ls93hJiZbQ3akF3HF3x1Bz8%2FzU4%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"',
    );
  });

  test("a fresh nonce and timestamp every call", () => {
    expect(oauthHeader("POST", X_API, creds)).not.toBe(oauthHeader("POST", X_API, creds));
  });
});

describe("config", () => {
  test("off by default, with the documented thresholds", () => {
    expect(xConfig({})).toEqual({ mode: "off", minUsdMillions: 50, trendingTop: 5, maxPerDay: 6, credentials: null, reviewTarget: null });
    expect(xConfig({ X_POSTING: "yes please" }).mode).toBe("off");
  });

  test("reads the four developer portal credentials and the thresholds", () => {
    const c = xConfig({
      X_POSTING: "live",
      X_CONSUMER_KEY: "a",
      X_CONSUMER_SECRET: "b",
      X_ACCESS_TOKEN: "c",
      X_ACCESS_TOKEN_SECRET: "d",
      X_MIN_USD_MILLIONS: "100",
      X_TRENDING_TOP: "3",
      X_MAX_POSTS_PER_DAY: "4",
    });
    expect(c).toMatchObject({ mode: "live", minUsdMillions: 100, trendingTop: 3, maxPerDay: 4 });
    expect(c.credentials).toEqual({ consumerKey: "a", consumerSecret: "b", accessToken: "c", accessTokenSecret: "d" });
    expect(xConfig({ X_POSTING: "live", X_CONSUMER_KEY: "a" }).credentials).toBeNull();
    expect(xConfig({ X_TRENDING_TOP: "0" }).trendingTop).toBe(0);
  });
});

describe("post text", () => {
  test("the house shape: the raise, the leads, the company page", async () => {
    const db = await testDb();
    const [r] = await published(db, spiko());
    expect(postText(r, ORIGIN)).toBe(
      "Spiko raised a $90M Series B led by New Enterprise Associates.\nhttps://fireround.dev/companies/spiko",
    );
  });

  test("a short line from a verified homepage, never a hyped or unverified one", async () => {
    const db = await testDb();
    const [r] = await published(db, spiko());
    const verified = { ...r, company: { ...r.company, description: "a tokenized cash fund" }, enrichment: { verified: true } } as RoundRow;
    expect(postText(verified, ORIGIN)).toBe(
      "Spiko raised a $90M Series B led by New Enterprise Associates. Tokenized cash fund.\nhttps://fireround.dev/companies/spiko",
    );
    const hyped = { ...verified, company: { ...r.company, description: "the world's leading cash platform" } } as RoundRow;
    expect(postText(hyped, ORIGIN)).not.toContain("leading");
    const unverified = { ...verified, enrichment: { verified: false } } as RoundRow;
    expect(postText(unverified, ORIGIN)).not.toContain("Tokenized");
  });

  test("two leads named, then 'and others'; no @, #, or cashtag reaches X", async () => {
    const db = await testDb();
    const [r] = await published(db, spiko());
    const three = { ...r, lead_investors: ["@a16z", "Index #Ventures", "$SEQ Capital"] } as RoundRow;
    const text = postText(three, ORIGIN);
    expect(text).toContain("led by a16z, Index Ventures and others.");
    expect(text).not.toMatch(/[@#]|\$[A-Za-z]/);
    expect(postText({ ...r, lead_investors: ["A", "B"] } as RoundRow, ORIGIN)).toContain("led by A and B.");
  });

  test("qualified, foreign, and missing figures read naturally", async () => {
    const db = await testDb();
    const [r] = await published(db, spiko());
    const upTo = {
      ...r,
      stage: "growth",
      amount: { value: 4000, currency: "USD", as_written: "up to $4 billion", usd_millions: 4000 },
    } as RoundRow;
    expect(postText(upTo, ORIGIN)).toMatch(/^Spiko raised up to \$4\.0B in a growth round led by/);
    const euro = { ...r, amount: { value: 80, currency: "EUR", as_written: "€80 million", usd_millions: 93 } } as RoundRow;
    expect(postText(euro, ORIGIN)).toMatch(/^Spiko raised an €80M Series B/);
    const none = { ...r, amount: { value: null, currency: null, as_written: null, usd_millions: null } } as RoundRow;
    expect(postText(none, ORIGIN)).toMatch(/^Spiko raised a Series B led by/);
  });

  test("a billion figure keeps the digit rounding would lose; a converted figure says about", async () => {
    const db = await testDb();
    const [r] = await published(db, spiko());
    const billion = (m: number) => ({ ...r, amount: { value: m, currency: "USD", as_written: `$${m}M`, usd_millions: m } }) as RoundRow;
    expect(postText(billion(1850), ORIGIN)).toMatch(/^Spiko raised a \$1\.85B Series B/);
    expect(postText(billion(1500), ORIGIN)).toMatch(/^Spiko raised a \$1\.5B Series B/);
    expect(postText(billion(12_500), ORIGIN)).toMatch(/^Spiko raised a \$13B Series B/);
    expect(postText(billion(42), ORIGIN)).toMatch(/^Spiko raised a \$42M Series B/);
    const yuan = {
      ...r,
      amount: { value: 2300, currency: "CNY", as_written: "2.3 billion yuan (approximately $344.2 million)", usd_millions: 343.689 },
    } as RoundRow;
    expect(postText(yuan, ORIGIN)).toMatch(/^Spiko raised about \$344M in a Series B/);
    const overYuan = { ...yuan, amount: { ...yuan.amount, as_written: "over 1 billion yuan", usd_millions: 149.414 } } as RoundRow;
    expect(postText(overYuan, ORIGIN)).toMatch(/^Spiko raised over \$149M in a Series B/);
  });

  test("a lead another lead already names is said once", async () => {
    const db = await testDb();
    const [r] = await published(db, spiko());
    const led = (lead_investors: string[]) => postText({ ...r, lead_investors } as RoundRow, ORIGIN);
    expect(led(["Patrick Soon-Shiong's NantWorks", "Patrick Soon-Shiong"])).toContain("led by Patrick Soon-Shiong's NantWorks.");
    expect(led(["Vinod Khosla", "Khosla Ventures"])).toContain("led by Khosla Ventures.");
    expect(led(["Index", "Index Ventures", "Accel"])).toContain("led by Index Ventures and Accel.");
    expect(led(["GV", "Lightspeed Venture Partners"])).toContain("led by GV and Lightspeed Venture Partners.");
    expect(led(["General Catalyst", "Catalyst Health Ventures"])).toContain("led by General Catalyst and Catalyst Health Ventures.");
  });

  test("never past 280: the line goes first, then the leads", async () => {
    const db = await testDb();
    const [r] = await published(db, spiko());
    const long = {
      ...r,
      company: { ...r.company, description: "cash funds" },
      enrichment: { verified: true },
      lead_investors: ["A".repeat(120), "B".repeat(120)],
    } as RoundRow;
    const text = postText(long, ORIGIN);
    expect(xLength(text)).toBeLessThanOrEqual(280);
    expect(text).not.toContain("Cash funds");
    expect(xLength(`hi https://example.com/${"x".repeat(100)}`)).toBe(3 + 23);
  });
});

describe("names", () => {
  test("a trailing legal form and its comma come off the company name, nothing else does", () => {
    expect(withoutLegalSuffix("NexBank Capital, Inc.")).toBe("NexBank Capital");
    expect(withoutLegalSuffix("Jeeves Inc.")).toBe("Jeeves");
    expect(withoutLegalSuffix("Zenflow, Inc")).toBe("Zenflow");
    expect(withoutLegalSuffix("SignSplit PBC")).toBe("SignSplit");
    expect(withoutLegalSuffix("Acme Co., Ltd.")).toBe("Acme");
    expect(withoutLegalSuffix("Northland Power Corporation")).toBe("Northland Power");
    expect(withoutLegalSuffix("General Intuition Holding B.V.")).toBe("General Intuition Holding");
    expect(withoutLegalSuffix("Siemens AG")).toBe("Siemens");
    expect(withoutLegalSuffix("Mistral SAS")).toBe("Mistral");
    expect(withoutLegalSuffix("Wise plc")).toBe("Wise");
    expect(withoutLegalSuffix("Acme Limited")).toBe("Acme");
    expect(withoutLegalSuffix("Acme GmbH")).toBe("Acme");
    expect(withoutLegalSuffix("SolSource Solutions Holdings, LLC")).toBe("SolSource Solutions Holdings");
    expect(withoutLegalSuffix("AnaCardio AB")).toBe("AnaCardio");
    expect(withoutLegalSuffix("Wolt Oy")).toBe("Wolt");
    expect(withoutLegalSuffix("Nokia Oyj")).toBe("Nokia");
    expect(withoutLegalSuffix("Breye Therapeutics ApS")).toBe("Breye Therapeutics");
    expect(withoutLegalSuffix("Novo Nordisk A/S")).toBe("Novo Nordisk");
    expect(withoutLegalSuffix("Kahoot AS")).toBe("Kahoot");
    expect(withoutLegalSuffix("Philips N.V.")).toBe("Philips");
    expect(withoutLegalSuffix("Adyen NV")).toBe("Adyen");
    expect(withoutLegalSuffix("Satispay S.p.A.")).toBe("Satispay");
    expect(withoutLegalSuffix("Scalapay SpA")).toBe("Scalapay");
    expect(withoutLegalSuffix("Canva Pty Ltd")).toBe("Canva");
    expect(withoutLegalSuffix("Airwallex Pty")).toBe("Airwallex");
    expect(withoutLegalSuffix("Preferred Networks KK")).toBe("Preferred Networks");
    expect(withoutLegalSuffix("Celonis SE")).toBe("Celonis");
    expect(withoutLegalSuffix("Nexthink Sàrl")).toBe("Nexthink");
    expect(withoutLegalSuffix("Eco5Tech, S.A.")).toBe("Eco5Tech");
    // Only at the end, only a whole word, and never down to nothing.
    expect(withoutLegalSuffix("Inc. Labs")).toBe("Inc. Labs");
    expect(withoutLegalSuffix("Corpus AI")).toBe("Corpus AI");
    expect(withoutLegalSuffix("Mesa")).toBe("Mesa");
    expect(withoutLegalSuffix("Visa")).toBe("Visa");
    expect(withoutLegalSuffix("Inc.")).toBe("Inc.");
    expect(withoutLegalSuffix("AB")).toBe("AB");
    expect(withoutLegalSuffix("Kodiak")).toBe("Kodiak");
    expect(withoutLegalSuffix("Grab")).toBe("Grab");
    expect(withoutLegalSuffix("SE Ventures")).toBe("SE Ventures");
    expect(withoutLegalSuffix("Atlas")).toBe("Atlas");
    expect(withoutLegalSuffix("Nova Spa")).toBe("Nova Spa");
    expect(withoutLegalSuffix("Base")).toBe("Base");
  });

  test("a lead's descriptor clause is cut, so one investor never reads as two", () => {
    expect(leadName("Kembara, Mundi Ventures’ European scale-up fund")).toBe("Kembara");
    expect(leadName("Kembara, Mundi Ventures' European scale-up fund")).toBe("Kembara");
    expect(leadName("EIFO, the Export and Investment Fund of Denmark")).toBe("EIFO");
    expect(leadName("Partech, through its impact fund")).toBe("Partech");
    expect(leadName("Laboratory Corporation of America Holdings, or Labcorp")).toBe("Laboratory Corporation of America Holdings");
    expect(leadName("Dr Arokiaswamy Velumani, Founder of Thyrocare’s Family Office")).toBe("Dr Arokiaswamy Velumani");
    expect(leadName("lululemon athletica, inc")).toBe("lululemon athletica");
    expect(leadName("Accel, Inc.")).toBe("Accel");
    // A comma that is part of the name stays.
    expect(leadName("The Oliver R. Grace, Jr. Millennium Trust")).toBe("The Oliver R. Grace, Jr. Millennium Trust");
    expect(leadName("Bank Hapoalim, BM")).toBe("Bank Hapoalim, BM");
  });

  test("the post uses both", async () => {
    const db = await testDb();
    const [r] = await published(db, spiko());
    const row = {
      ...r,
      company: { ...r.company, name: "NexBank Capital, Inc." },
      lead_investors: ["Kembara, Mundi Ventures’ European scale-up fund"],
    } as RoundRow;
    expect(postText(row, ORIGIN)).toBe("NexBank Capital raised a $90M Series B led by Kembara.\nhttps://fireround.dev/companies/spiko");
  });
});

describe("selection", () => {
  test("announced, published, confirmed, with a lead or amount, and $50M+ or Trending's top five", async () => {
    const db = await testDb();
    const [r] = await published(db, spiko());
    const c = cfg();
    expect(xRefusal(r, c, null, NOW)).toBeNull();
    expect(xRules(r, c, null)).toEqual(["amount"]);
    const small = { ...r, amount: { ...r.amount, usd_millions: 20 } } as RoundRow;
    expect(xRefusal(small, c, null, NOW)).toMatch(/under \$50M/);
    expect(xRefusal(small, c, 6, NOW)).toMatch(/not in Trending's top 5/);
    expect(xRefusal(small, c, 5, NOW)).toBeNull();
    expect(xRules(small, c, 2)).toEqual(["trending"]);
    expect(xRefusal(small, { ...c, trendingTop: 0 }, 1, NOW)).not.toBeNull();
    expect(xRefusal({ ...r, certainty: "reported" } as RoundRow, c, null, NOW)).toMatch(/not announced/);
    expect(xRefusal({ ...r, primary_source: null } as RoundRow, c, null, NOW)).toBe("no announcement from the company or a wire");
    expect(xRefusal({ ...r, disposition: "flagged" } as RoundRow, c, null, NOW)).toBe("flagged");
    expect(xRefusal({ ...r, verification: { status: "unverified", notes: [], url: null } } as RoundRow, c, null, NOW)).toMatch(/read-back/);
    expect(xRefusal({ ...r, history: true } as RoundRow, c, null, NOW)).toBe("history round");
    expect(xRefusal({ ...r, announced_on: "2026-01-01" } as RoundRow, c, null, NOW)).toMatch(/not fresh/);
    const bare = { ...r, lead_investors: [], amount: { value: null, currency: null, as_written: null, usd_millions: null } } as RoundRow;
    expect(xRefusal(bare, c, 1, NOW)).toMatch(/no lead investor and no amount/);
  });

  const row = (roundId: string, at: Date, over: Record<string, unknown> = {}) =>
    ({
      roundId,
      channel: "x",
      target: "x",
      status: "sent",
      attempts: 1,
      nextAttemptAt: at,
      lastError: null,
      externalId: "1",
      snapshot: { mode: "live", at: at.toISOString(), text: "", facts: { company: "", stage: "", amount: "" } },
      deliveredCertainty: "announced",
      createdAt: at,
      updatedAt: at,
      ...over,
    }) as Parameters<typeof nextPost>[1][number];

  test("the cap and the spacing: at most six a day, no sooner than four hours apart", () => {
    const c = cfg({ mode: "live" });
    expect(spacingMs(6)).toBe(4 * 3_600_000);
    const eligible = [{ id: "a" }, { id: "b" }];
    expect(nextPost(eligible, [], c, NOW)).toEqual({ round: { id: "a" } });
    const hourAgo = new Date(NOW.getTime() - 3_600_000);
    expect(nextPost(eligible, [row("z", hourAgo)], c, NOW)).toMatchObject({ wait: expect.stringMatching(/no sooner than/) });
    const fiveAgo = new Date(NOW.getTime() - 5 * 3_600_000);
    expect(nextPost(eligible, [row("z", fiveAgo)], c, NOW)).toEqual({ round: { id: "a" } });
    const day = Array.from({ length: 6 }, (_, i) => row(`p${i}`, new Date(NOW.getTime() - (5 + i * 3) * 3_600_000)));
    expect(nextPost(eligible, day, c, NOW)).toEqual({ wait: "6 posts in the last 24 hours" });
  });

  test("never the same round twice; a live run may post what a dry run previewed", () => {
    const old = new Date(NOW.getTime() - 10 * 3_600_000);
    const eligible = [{ id: "a" }, { id: "b" }];
    expect(nextPost(eligible, [row("a", old)], cfg({ mode: "live" }), NOW)).toEqual({ round: { id: "b" } });
    expect(
      nextPost(eligible, [row("a", old, { target: "x:dup" }), row("b", old, { status: "retracted" })], cfg({ mode: "live" }), NOW),
    ).toEqual({
      wait: "no eligible round",
    });
    const preview = row("a", old, {
      status: "previewed",
      externalId: null,
      snapshot: { mode: "dry_run", at: old.toISOString(), text: "", facts: {} },
    });
    expect(nextPost(eligible, [preview], cfg({ mode: "live" }), NOW)).toEqual({ round: { id: "a" } });
    expect(nextPost(eligible, [preview], cfg({ mode: "dry_run" }), NOW)).toEqual({ round: { id: "b" } });
  });

  test("a failed post backs off the whole lane until its retry time", () => {
    const later = new Date(NOW.getTime() + 600_000);
    const failed = row("a", later, { status: "failed", lastError: "X 429: slow down", snapshot: null });
    expect(nextPost([{ id: "a" }], [failed], cfg({ mode: "live" }), NOW)).toMatchObject({
      wait: expect.stringMatching(/backing off .*429/),
    });
    expect(nextPost([{ id: "a" }], [{ ...failed, nextAttemptAt: NOW }], cfg({ mode: "live" }), NOW)).toEqual({ round: { id: "a" } });
  });
});

describe("the run", () => {
  const xRows = (db: Db) => db.select().from(schema.deliveries).where(eq(schema.deliveries.channel, "x"));

  test("a round whose company URL carries an internal id or a space is skipped and logged", async () => {
    const db = await testDb();
    // A row stored before company ids were clean: a namesake's id with a news site's host in it.
    const legacy = "spiko:identity:news.example";
    const [stored] = await published(db, spiko());
    await db.insert(schema.companies).values({ id: legacy, name: "Spiko", nameKey: "spiko" });
    await db
      .update(schema.fundingRounds)
      .set({ companyId: legacy })
      .where(eq(schema.fundingRounds.id, stored?.id as string));
    const [r] = (await listRounds(db, { ids: [stored?.id as string], limit: 1 })).rows;
    expect(r?.company.id).toBe(legacy);
    expect(xRefusal(r as RoundRow, cfg(), null, NOW)).toBe("unclean company url");
    expect(xRefusal({ ...r, company: { ...r?.company, id: "nexbank capital" } } as RoundRow, cfg(), null, NOW)).toBe("unclean company url");
    const lines: string[] = [];
    const { calls, fetchImpl } = fakeX();
    const out = await runXPosts(db, ORIGIN, { cfg: cfg(), fetchImpl, log: (l) => lines.push(l), now: NOW });
    expect(out.posted).toEqual([]);
    expect(lines).toContain(`x: skipped (unclean company url): ${r?.id} (/companies/spiko%3Aidentity%3Anews.example)`);
    expect(calls).toHaveLength(0);
  });

  test("a duplicate row still in review is never posted, live or dry", async () => {
    const db = await testDb();
    const [kept] = await published(db, spiko({ company_name: "SignSplit", company_key: "signsplit", stage: "seed", amount: usd(400) }));
    const dupId = `signsplit:seed:${TODAY}:identity:news.example`;
    await db.execute(sql`create temp table copy as select * from funding_rounds where id = ${kept?.id}`);
    await db.execute(sql`update copy set id = ${dupId}, disposition = 'review'`);
    await db.execute(sql`insert into funding_rounds select * from copy`);
    await db
      .update(schema.fundingRounds)
      .set({ disposition: "rejected" })
      .where(eq(schema.fundingRounds.id, kept?.id as string));
    const [dup] = (await listRounds(db, { ids: [dupId], includeReview: true, limit: 1 })).rows;
    expect(xRefusal(dup as RoundRow, cfg(), 1, NOW)).toBe("review");
    const { calls, fetchImpl } = fakeX();
    for (const mode of ["dry_run", "live"] as const) {
      const out = await runXPosts(db, ORIGIN, { cfg: cfg({ mode, credentials: CREDS }), fetchImpl, log: quiet, now: NOW });
      expect(out).toMatchObject({ posted: [], waiting: "no eligible round" });
    }
    expect(calls).toHaveLength(0);
    expect(await xRows(db)).toHaveLength(0);
  });

  test("off reads nothing and sends nothing", async () => {
    const db = await testDb();
    await published(db, spiko());
    const { calls, fetchImpl } = fakeX();
    expect(await runXPosts(db, ORIGIN, { cfg: cfg({ mode: "off" }), fetchImpl, log: quiet })).toMatchObject({ mode: "off", posted: [] });
    expect(calls).toHaveLength(0);
    expect(await xRows(db)).toHaveLength(0);
  });

  test("a dry run writes what it would post, calls nothing, and waits its turn", async () => {
    const db = await testDb();
    await published(db, spiko(), spiko({ company_name: "Acme", company_key: "acme", amount: usd(60) }));
    const { calls, fetchImpl } = fakeX();
    const lines: string[] = [];
    const first = await runXPosts(db, ORIGIN, { cfg: cfg(), fetchImpl, log: (l) => lines.push(l), now: NOW });
    expect(first.posted).toEqual([
      { round: `spiko:series_b:${TODAY}`, text: expect.stringContaining("Spiko raised a $90M"), postId: null },
    ]);
    expect(lines.some((l) => l.includes("would post") && l.includes("Spiko raised a $90M Series B"))).toBe(true);
    expect(calls).toHaveLength(0);
    const [row] = await xRows(db);
    expect(row).toMatchObject({
      status: "previewed",
      externalId: null,
      snapshot: { mode: "dry_run", facts: { company: "Spiko", stage: "Series B", amount: "$90M" } },
    });
    expect((await runXPosts(db, ORIGIN, { cfg: cfg(), fetchImpl, log: quiet, now: NOW })).waiting).toMatch(/no sooner than/);
    const later = new Date(NOW.getTime() + 5 * 3_600_000);
    expect((await runXPosts(db, ORIGIN, { cfg: cfg(), fetchImpl, log: quiet, now: later })).posted[0]?.round).toBe(
      `acme:series_b:${TODAY}`,
    );
    // The outbox sender leaves X rows alone.
    await flushDeliveries(db, ORIGIN, fetchImpl);
    expect(calls).toHaveLength(0);
  });

  test("a dry run goes to the review Slack target by its label, even a disabled one", async () => {
    const db = await testDb();
    await published(db, spiko());
    const t = await createTarget(db, { channel: "slack", target: "https://hooks.slack.com/services/T/B/review", label: "#x-review" });
    await setTargetEnabled(db, t.id, false);
    const { calls, fetchImpl } = fakeX(() => new Response("ok", { status: 200 }));
    await runXPosts(db, ORIGIN, { cfg: cfg({ reviewTarget: "#x-review" }), fetchImpl, log: quiet, now: NOW });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://hooks.slack.com/services/T/B/review");
    expect(JSON.parse(calls[0]?.body ?? "{}").text).toMatch(/^Would post on X:\nSpiko raised a \$90M Series B/);
  });

  test("live posts once with an OAuth header and stores the post id", async () => {
    const db = await testDb();
    await published(db, spiko());
    const { calls, fetchImpl } = fakeX();
    const live = cfg({ mode: "live", credentials: CREDS });
    const out = await runXPosts(db, ORIGIN, { cfg: live, fetchImpl, log: quiet, now: NOW });
    expect(out.posted).toEqual([{ round: `spiko:series_b:${TODAY}`, text: expect.any(String), postId: "1001" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: X_API });
    expect(calls[0]?.auth).toMatch(/^OAuth oauth_consumer_key="ck", .*oauth_signature="[^"]+".*oauth_token="at"/);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ text: out.posted[0]?.text });
    expect(await xRows(db)).toMatchObject([{ status: "sent", externalId: "1001", attempts: 1 }]);
    const tomorrow = new Date(NOW.getTime() + 20 * 3_600_000);
    expect((await runXPosts(db, ORIGIN, { cfg: live, fetchImpl, log: quiet, now: tomorrow })).waiting).toBe("no eligible round");
    expect(calls).toHaveLength(1);
  });

  test("live without all four credentials posts nothing", async () => {
    const db = await testDb();
    await published(db, spiko());
    const { calls, fetchImpl } = fakeX();
    const out = await runXPosts(db, ORIGIN, { cfg: cfg({ mode: "live" }), fetchImpl, log: quiet });
    expect(out.error).toMatch(/X_CONSUMER_KEY/);
    expect(calls).toHaveLength(0);
  });

  test("a 429 backs off to X's reset; a 403 takes the outbox backoff", async () => {
    const db = await testDb();
    await published(db, spiko());
    const reset = Math.floor(NOW.getTime() / 1000) + 900;
    const limited = fakeX(
      () => new Response('{"title":"Too Many Requests"}', { status: 429, headers: { "x-rate-limit-reset": String(reset) } }),
    );
    const live = cfg({ mode: "live", credentials: CREDS });
    const out = await runXPosts(db, ORIGIN, { cfg: live, fetchImpl: limited.fetchImpl, log: quiet, now: NOW });
    expect(out.error).toMatch(/^X 429/);
    const [row] = await xRows(db);
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
    expect(row?.nextAttemptAt.getTime()).toBe(reset * 1000);
    expect((await runXPosts(db, ORIGIN, { cfg: live, fetchImpl: limited.fetchImpl, log: quiet, now: NOW })).waiting).toMatch(/backing off/);
    expect(limited.calls).toHaveLength(1);

    const forbidden = fakeX(() => new Response('{"detail":"duplicate content"}', { status: 403 }));
    const afterReset = new Date(reset * 1000 + 1000);
    await runXPosts(db, ORIGIN, { cfg: live, fetchImpl: forbidden.fetchImpl, log: quiet, now: afterReset });
    const [again] = await xRows(db);
    expect(again).toMatchObject({ status: "failed", attempts: 2, lastError: expect.stringContaining("403") });
    expect(again?.nextAttemptAt.getTime()).toBe(afterReset.getTime() + 30 * 60_000);
  });

  test("a corrected amount takes the post down and records why", async () => {
    const db = await testDb();
    await published(db, spiko());
    const { calls, fetchImpl } = fakeX();
    const live = cfg({ mode: "live", credentials: CREDS });
    await runXPosts(db, ORIGIN, { cfg: live, fetchImpl, log: quiet, now: NOW });
    await db
      .update(schema.fundingRounds)
      .set({ amountUsdMillions: "80", amountValue: "80" })
      .where(eq(schema.fundingRounds.id, `spiko:series_b:${TODAY}`));
    const out = await runXPosts(db, ORIGIN, { cfg: live, fetchImpl, log: quiet, now: new Date(NOW.getTime() + 3_600_000) });
    expect(out.retracted).toEqual([{ round: `spiko:series_b:${TODAY}`, reason: 'amount changed from "$90M" to "$80M"', postId: "1001" }]);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: `${X_API}/1001` });
    expect(await xRows(db)).toMatchObject([{ status: "retracted", externalId: "1001", lastError: 'amount changed from "$90M" to "$80M"' }]);
    // Never posted again, and never deleted twice.
    await runXPosts(db, ORIGIN, { cfg: live, fetchImpl, log: quiet, now: new Date(NOW.getTime() + 10 * 3_600_000) });
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(2);
  });

  test("a rejected round's post comes down; a dry run only says it would", async () => {
    const db = await testDb();
    await published(db, spiko());
    const { calls, fetchImpl } = fakeX();
    await runXPosts(db, ORIGIN, { cfg: cfg(), fetchImpl, log: quiet, now: NOW });
    await db
      .update(schema.fundingRounds)
      .set({ disposition: "rejected" })
      .where(eq(schema.fundingRounds.id, `spiko:series_b:${TODAY}`));
    const lines: string[] = [];
    const out = await runXPosts(db, ORIGIN, { cfg: cfg(), fetchImpl, log: (l) => lines.push(l), now: NOW });
    expect(out.retracted).toEqual([{ round: `spiko:series_b:${TODAY}`, reason: "round rejected", postId: null }]);
    expect(lines.some((l) => l.includes("would delete"))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("after a merge the survivor is never posted again, and a second post of the same round comes down", async () => {
    const db = await testDb();
    const yesterday = new Date(NOW.getTime() - 86_400_000).toISOString().slice(0, 10);
    const keepId = `spiko:series_b:${TODAY}`;
    const dupId = `spiko:series_b:${yesterday}`;
    await published(db, spiko());
    // A second copy of the round that slipped past persist's own dedupe, as merges exist to fold.
    await db.execute(sql`create temp table copy as select * from funding_rounds where id = ${keepId}`);
    await db.execute(sql`update copy set id = ${dupId}, announced_on = ${yesterday}`);
    await db.execute(sql`insert into funding_rounds select * from copy`);
    await db.execute(sql`create temp table copied_sources as select * from round_sources where round_id = ${keepId}`);
    await db.execute(sql`update copied_sources set round_id = ${dupId}`);
    await db.execute(sql`insert into round_sources select * from copied_sources`);
    let n = 0;
    const { calls, fetchImpl } = fakeX((m) =>
      m === "POST" ? new Response(JSON.stringify({ data: { id: `${++n}` } }), { status: 201 }) : new Response("{}", { status: 200 }),
    );
    const live = cfg({ mode: "live", credentials: CREDS });
    await runXPosts(db, ORIGIN, { cfg: live, fetchImpl, log: quiet, now: NOW });
    await runXPosts(db, ORIGIN, { cfg: live, fetchImpl, log: quiet, now: new Date(NOW.getTime() + 5 * 3_600_000) });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);

    const plan = await planRoundMerge(db, keepId, dupId);
    if (!plan) throw new Error("no merge plan");
    await applyRoundMerge(db, plan);
    const rows = await xRows(db);
    expect(rows.map((r) => [r.roundId, r.target, r.externalId]).sort()).toEqual([
      [keepId, "x", "1"],
      [keepId, `x:${dupId}`, "2"],
    ]);
    const out = await runXPosts(db, ORIGIN, { cfg: live, fetchImpl, log: quiet, now: new Date(NOW.getTime() + 10 * 3_600_000) });
    expect(out.retracted).toEqual([{ round: keepId, reason: "duplicate of post 1 after a merge", postId: "2" }]);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: `${X_API}/2` });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  test("the X channel and the new statuses exist in the database", async () => {
    const db = await testDb();
    const res = await db.execute(sql`select unnest(enum_range(null::delivery_status))::text as v`);
    expect((res.rows as Array<{ v: string }>).map((r) => r.v)).toEqual(expect.arrayContaining(["previewed", "retracted"]));
  });
});
