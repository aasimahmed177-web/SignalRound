import type { FeedRecord } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import {
  companyMatch,
  isDuplicateRound,
  isSameRound,
  keepsStoredDay,
  listRounds,
  mergeDuplicateRounds,
  persistRecords,
  type RoundIdentity,
  stageSpecificity,
} from "../lib/persist";
import { describeRoundMerge, mergeRoundPairs } from "../lib/repair";
import { record, testDb } from "./helpers";

// Fixtures shaped like production's Ultraviolette pair (2026-09-23): the growth sweep at 08:11 read
// Moneycontrol's story as "Ultraviolette Automotive" with no domain; the growth sweep at 16:22 read the
// same story as "Ultraviolette", also with no domain yet, and inserted a second row for one round.

const MONEYCONTROL =
  "https://www.moneycontrol.com/news/business/startup/ultraviolette-bags-85-million-series-e-led-by-yali-tdk-ventures-lip-bu-tan-invests-14036186.html";
const UV_AMOUNT = { value: 85, currency: "USD", as_written: "$85 million", usd_millions: 85, fx_rate: 1, fx_date: "2026-09-23" };

function uvAutomotive(): FeedRecord {
  return record({
    id: "ultraviolette-automotive:series_d_plus:2026-09-23",
    company_name: "Ultraviolette Automotive",
    company_key: "ultraviolette automotive",
    stage: "series_d_plus",
    stage_as_written: "Series E",
    amount: UV_AMOUNT,
    announced_date: "2026-09-23",
    date_basis: "page",
    lead_investors: ["Yali Capital", "TDK Ventures"],
    other_investors: ["Lip-Bu Tan"],
    evidence_quotes: ["Ultraviolette raises $85M in Series E funding."],
    sources: [{ url: MONEYCONTROL, host: "moneycontrol.com", title: "Ultraviolette bags $85 million Series E led by Yali, TDK Ventures" }],
    confidence: 0.61,
    verification: { status: "corrected", notes: ["not leads: Lip-Bu Tan"], url: MONEYCONTROL },
  });
}

function uvShort(sources: FeedRecord["sources"]): FeedRecord {
  return record({
    id: "ultraviolette:series_d_plus:2026-09-23",
    company_name: "Ultraviolette",
    company_key: "ultraviolette",
    stage: "series_d_plus",
    stage_as_written: "Series E",
    amount: UV_AMOUNT,
    announced_date: "2026-09-23",
    date_basis: "page",
    lead_investors: ["Yali Capital", "TDK Ventures"],
    other_investors: ["Lip-Bu Tan"],
    evidence_quotes: ["Ultraviolette has raised a funding of $85 million led by deeptech fund Yali Capital and TDK Ventures."],
    sources,
    confidence: 0.86,
    verification: { status: "confirmed", notes: [], url: "https://entrackr.com/news/ultraviolette-raises-85-mn" },
  });
}

const CORROBORATION = [
  { url: MONEYCONTROL, host: "moneycontrol.com", title: "Ultraviolette bags $85 million Series E" },
  {
    url: "https://yourstory.com/2026/09/ultraviolette-raises-85-million-series-e",
    host: "yourstory.com",
    title: "Ultraviolette raises $85 million",
  },
  { url: "https://entrackr.com/news/ultraviolette-raises-85-mn", host: "entrackr.com", title: "Ultraviolette raises $85 Mn" },
];

async function count(db: Db, table: string): Promise<number> {
  const r = await db.execute(sql.raw(`select count(*)::int n from ${table}`));
  return Number((r.rows[0] as { n: number }).n);
}

/**
 * A pair stored the way the old persist path left it: two company rows, two rounds. Written through
 * the tables, not persistRecords, because the persist path now refuses to create the pair.
 */
async function storeUltraviolettePair(db: Db): Promise<void> {
  const { companies, fundingRounds, sources, roundSources, investors, roundInvestors, enrichments } = schema;
  await db.insert(companies).values([
    { id: "ultraviolette automotive", name: "Ultraviolette Automotive", nameKey: "ultraviolette automotive" },
    {
      id: "ultraviolette",
      name: "Ultraviolette",
      nameKey: "ultraviolette",
      domain: "ultraviolette.com",
      website: "https://ultraviolette.com",
    },
  ]);
  const base = {
    presetSlug: "growth",
    stage: "series_d_plus" as const,
    stageAsWritten: "Series E",
    amountValue: "85",
    amountCurrency: "USD",
    amountAsWritten: "$85 million",
    amountUsdMillions: "85",
    announcedOn: "2026-09-23",
    datePrecision: "day",
    dateBasis: "page",
  };
  await db.insert(fundingRounds).values([
    {
      ...base,
      id: "ultraviolette-automotive:series_d_plus:2026-09-23",
      companyId: "ultraviolette automotive",
      confidence: "0.61",
      disposition: "flagged",
      status: "seen",
      verification: { status: "corrected", notes: [], url: MONEYCONTROL },
      evidenceQuotes: ["Ultraviolette raises $85M in Series E funding."],
      firstSeenAt: new Date("2026-09-23T08:16:29Z"),
      lastSeenAt: new Date("2026-09-23T08:16:29Z"),
    },
    {
      ...base,
      id: "ultraviolette:series_d_plus:2026-09-23",
      companyId: "ultraviolette",
      confidence: "0.86",
      disposition: "publish",
      status: "new",
      verification: { status: "confirmed", notes: [], url: CORROBORATION[2].url },
      evidenceQuotes: [
        "Ultraviolette raises $85M in Series E funding.",
        "Ultraviolette has raised a funding of $85 million led by deeptech fund Yali Capital and TDK Ventures.",
      ],
      firstSeenAt: new Date("2026-09-23T16:27:05Z"),
      lastSeenAt: new Date("2026-09-23T16:27:52Z"),
    },
  ]);
  await db.insert(sources).values(CORROBORATION.map((s) => ({ id: s.url, url: s.url, host: s.host, title: s.title })));
  await db
    .insert(roundSources)
    .values([
      { roundId: "ultraviolette-automotive:series_d_plus:2026-09-23", sourceId: MONEYCONTROL },
      ...CORROBORATION.map((s) => ({ roundId: "ultraviolette:series_d_plus:2026-09-23", sourceId: s.url })),
    ]);
  await db.insert(investors).values([
    { id: "yali", name: "Yali Capital" },
    { id: "tdk", name: "TDK Ventures" },
    { id: "lip bu tan", name: "Lip-Bu Tan" },
  ]);
  await db.insert(roundInvestors).values([
    { roundId: "ultraviolette-automotive:series_d_plus:2026-09-23", investorId: "yali", role: "lead" },
    { roundId: "ultraviolette-automotive:series_d_plus:2026-09-23", investorId: "tdk", role: "lead" },
    { roundId: "ultraviolette-automotive:series_d_plus:2026-09-23", investorId: "lip bu tan", role: "participant" },
    { roundId: "ultraviolette:series_d_plus:2026-09-23", investorId: "yali", role: "lead" },
    { roundId: "ultraviolette:series_d_plus:2026-09-23", investorId: "tdk", role: "participant" },
  ]);
  await db.insert(enrichments).values([
    { companyId: "ultraviolette automotive", kind: "profile", data: { website_source: "none" } },
    { companyId: "ultraviolette automotive", kind: "deep_dive", data: { sources: [] } },
    { companyId: "ultraviolette", kind: "profile", data: { website_source: "search" } },
  ]);
  await db.execute(
    sql`insert into deliveries (round_id, channel, target, status) values ('ultraviolette-automotive:series_d_plus:2026-09-23', 'webhook', 'https://hooks.example/a', 'sent')`,
  );
}

/** Every row of every table the merge touches, for a byte-for-byte "nothing changed" check. */
async function snapshot(db: Db): Promise<string> {
  const tables = [
    "companies",
    "company_aliases",
    "funding_rounds",
    "round_sources",
    "round_investors",
    "investors",
    "deliveries",
    "enrichments",
  ];
  const out: unknown[] = [];
  for (const t of tables) out.push((await db.execute(sql.raw(`select * from ${t} order by 1, 2`))).rows);
  return JSON.stringify(out);
}

describe("one round under two company names", () => {
  test("the Ultraviolette case: a later run naming the company differently joins the stored round", async () => {
    const db = await testDb();
    await persistRecords(db, [uvAutomotive()], "growth", "56e77a6e");
    const second = await persistRecords(db, [uvShort(CORROBORATION)], "growth", "573cd7c2");
    expect(second.inserted).toBe(0);
    const { rows } = await listRounds(db, { includeReview: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("ultraviolette-automotive:series_d_plus:2026-09-23");
    expect(rows[0].company.name).toBe("Ultraviolette Automotive");
    expect(rows[0].sources).toHaveLength(3);
    // Even a confirmed reading waits for the earliest-report check.
    expect(rows[0].disposition).toBe("review");
    // The row remembers the other name, so a third run that says "Ultraviolette" finds it by key alone.
    const aliases = await db.execute(sql`select company_id, alias_key from company_aliases`);
    expect(aliases.rows).toEqual([{ company_id: "ultraviolette automotive", alias_key: "ultraviolette" }]);
  });

  test("without a shared source or identifying fact, one stage and amount do not join two names", async () => {
    const db = await testDb();
    await persistRecords(db, [uvAutomotive()], "growth", "run-1");
    await persistRecords(db, [uvShort([CORROBORATION[2]])], "growth", "run-2");
    expect((await listRounds(db, { includeReview: true })).rows).toHaveLength(2);
  });

  test("the alias rule refuses a different amount, a different domain, and a short name with no shared source", async () => {
    const db = await testDb();
    await persistRecords(db, [uvAutomotive()], "growth", "run-1");
    // A different amount is a different round (or a different company).
    await persistRecords(
      db,
      [{ ...uvShort([CORROBORATION[2]]), amount: { ...UV_AMOUNT, value: 40, as_written: "$40 million", usd_millions: 40 } }],
      "growth",
      "run-2",
    );
    expect((await listRounds(db, { includeReview: true })).rows).toHaveLength(2);

    const base: RoundIdentity = {
      companyId: "nova",
      nameKey: "nova",
      domain: null,
      aliasKeys: [],
      stage: "series_a",
      announcedOn: "2026-09-02",
      amountUsdMillions: 20,
      amountValue: 20,
      amountCurrency: "USD",
      sourceIds: ["https://a.example/nova"],
    };
    const other = { ...base, companyId: "nova credit", nameKey: "nova credit", sourceIds: ["https://b.example/nova-credit"] };
    expect(companyMatch(base, other)).toBe("alias");
    // "Nova" is one short word: two rows need a shared source, not just a matching amount and day.
    expect(isDuplicateRound(base, other)).toBe(false);
    expect(isDuplicateRound(base, { ...other, sourceIds: base.sourceIds })).toBe(true);
    // Two domains are two companies whatever the names say.
    const long = { ...base, companyId: "harbor.com", nameKey: "harbor", domain: "harbor.com" };
    expect(isDuplicateRound(long, { ...long, companyId: "harborhealth.com", nameKey: "harbor health", domain: "harborhealth.com" })).toBe(
      false,
    );
    // An unknown amount across two names is not enough without a shared source.
    const unknown = { ...base, companyId: "ultraviolette", nameKey: "ultraviolette", amountUsdMillions: null, amountValue: null };
    const unknown2 = { ...unknown, companyId: "ultraviolette automotive", nameKey: "ultraviolette automotive", sourceIds: [] };
    expect(isDuplicateRound(unknown, unknown2)).toBe(false);
    expect(isDuplicateRound(unknown, { ...unknown2, sourceIds: base.sourceIds })).toBe(false);
    // With no USD on either side the stated values compare, in one currency or in none read at all
    // (Eco5Tech's "PLN 1,080,000" is stored with a null currency on both of its rows).
    const pln = { ...base, companyId: "eco5tech", nameKey: "eco5tech", amountUsdMillions: null, amountValue: 1.08, amountCurrency: "PLN" };
    expect(isDuplicateRound(pln, { ...pln, companyId: "eco5tech s a", nameKey: "eco5tech s a" })).toBe(true);
    const unread = { ...pln, amountCurrency: null };
    expect(isDuplicateRound(unread, { ...unread, companyId: "eco5tech s a", nameKey: "eco5tech s a" })).toBe(true);
    expect(isDuplicateRound(unread, { ...pln, companyId: "eco5tech s a", nameKey: "eco5tech s a" })).toBe(false);
  });

  test("the Heidi case: a name the company row was seen under is remembered, so a domainless record finds it", async () => {
    const db = await testDb();
    const heidiHealth = record({
      company_name: "Heidi Health",
      company_key: "heidi health",
      company_domain: "heidihealth.com",
      company_website: "https://heidihealth.com",
      headquarters: "Melbourne, Australia",
      stage: "series_c",
      announced_date: "2026-09-22",
      amount: { value: 100, currency: "USD", as_written: "$100 million", usd_millions: 100, fx_rate: 1, fx_date: "2026-09-22" },
      sources: [{ url: "https://siliconangle.com/2026/09/22/heidi-health-nabs-340m", host: "siliconangle.com" }],
    });
    await persistRecords(db, [heidiHealth], "growth", "run-1");
    // A run that says "Heidi" and knows the domain lands on the same row by domain; the key is remembered.
    await persistRecords(
      db,
      [{ ...heidiHealth, id: "heidi:series_c:2026-09-22", company_name: "Heidi", company_key: "heidi" }],
      "growth",
      "run-2",
    );
    // A run that says "Heidi" with no domain and no source in common still finds the row by that key.
    const third = await persistRecords(
      db,
      [
        {
          ...heidiHealth,
          id: "heidi:series_c:2026-09-24",
          company_name: "Heidi",
          company_key: "heidi",
          company_domain: null,
          company_website: null,
          announced_date: "2026-09-24",
          sources: [{ url: "https://www.finsmes.com/2026/09/heidi-raises-100m-in-series-c-funding.html", host: "finsmes.com" }],
        },
      ],
      "growth",
      "run-3",
    );
    expect(third.inserted).toBe(0);
    const { rows } = await listRounds(db, { includeReview: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].company.id).toBe("heidihealth.com");
  });

  test("two names the resolver kept apart in one batch merge once written, and the summary names the survivor", async () => {
    const db = await testDb();
    const shared = [{ url: "https://www.dealstreetasia.com/stories/heidi-series-c-funding-round-495906", host: "dealstreetasia.com" }];
    const amount = { value: 100, currency: "USD", as_written: "$100 million", usd_millions: 100, fx_rate: 1, fx_date: "2026-09-22" };
    const a = record({ company_name: "Heidi", stage: "series_c", announced_date: "2026-09-22", amount, sources: shared, confidence: 1 });
    const b = record({
      company_name: "Heidi Health",
      company_key: "heidi health",
      stage: "series_c",
      announced_date: "2026-09-22",
      amount,
      sources: shared,
      confidence: 0.61,
    });
    const summary = await persistRecords(db, [b, a], "growth", "run-1");
    const { rows } = await listRounds(db, { includeReview: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(a.id);
    expect(summary.insertedIds).toEqual([a.id]);
    expect(summary.changedIds).toEqual([a.id]);
  });

  test("two lanes writing the same round at once end with one row and no key collision", async () => {
    const db = await testDb();
    const results = await Promise.all([
      persistRecords(db, [uvAutomotive()], "growth", "lane-1"),
      persistRecords(db, [uvShort(CORROBORATION)], "growth", "lane-2"),
      persistRecords(db, [uvShort(CORROBORATION)], "growth", "lane-3"),
    ]);
    expect(results).toHaveLength(3);
    const { rows } = await listRounds(db, { includeReview: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].sources).toHaveLength(3);
  });
});

describe("merging a stored duplicate pair", () => {
  test("the dry run describes the Ultraviolette merge and writes nothing", async () => {
    const db = await testDb();
    await storeUltraviolettePair(db);
    const before = await snapshot(db);
    const result = await mergeRoundPairs(db, { apply: false });
    expect(await snapshot(db)).toBe(before);
    expect(result.merged).toBe(0);
    expect(result.planned).toHaveLength(1);
    const [m] = result.planned;
    expect(m.keep.id).toBe("ultraviolette:series_d_plus:2026-09-23");
    expect(m.dup.id).toBe("ultraviolette-automotive:series_d_plus:2026-09-23");
    expect(m.match).toBe("alias");
    expect(m.company).toEqual({ from: "ultraviolette automotive", into: "ultraviolette" });
    expect(m.enrichments).toEqual({ moved: ["deep_dive"], dropped: ["profile"] });
    expect(m.sources).toEqual([]);
    expect(m.investors).toEqual([
      { investorId: "tdk", name: "TDK Ventures", role: "lead" },
      { investorId: "lip bu tan", name: "Lip-Bu Tan", role: "participant" },
    ]);
    expect(m.deliveries).toBe(1);
    expect(m.set.status).toBe("seen");
    expect(m.set.firstSeenAt).toEqual(new Date("2026-09-23T08:16:29Z"));
    const text = describeRoundMerge(m).join("\n");
    expect(text).toContain('fold "ultraviolette automotive" into "ultraviolette"');
    // House prose: no en or em dash in anything an operator reads.
    for (const dash of [String.fromCharCode(0x2013), String.fromCharCode(0x2014)]) expect(text).not.toContain(dash);
  });

  test("a verified survivor takes no investor from a duplicate no reader verified: its names wait for the read-back", async () => {
    const db = await testDb();
    await storeUltraviolettePair(db);
    // The duplicate was never read back, and it carries a backer the round's sources do not place in it.
    await db.execute(sql`update funding_rounds set verification = null where id = 'ultraviolette-automotive:series_d_plus:2026-09-23'`);
    await db.execute(sql`insert into investors (id, name) values ('lingotto', 'Lingotto')`);
    await db.execute(
      sql`insert into round_investors (round_id, investor_id, role) values ('ultraviolette-automotive:series_d_plus:2026-09-23', 'lingotto', 'participant')`,
    );
    const [m] = (await mergeRoundPairs(db, { apply: false })).planned;
    expect(m.keep.id).toBe("ultraviolette:series_d_plus:2026-09-23");
    expect(m.investors).toEqual([]);
    await mergeRoundPairs(db, { apply: true });
    const [row] = (await listRounds(db, { includeReview: true })).rows;
    expect(row.lead_investors).toEqual(["Yali Capital"]);
    expect(row.other_investors).toEqual(["TDK Ventures"]);
    // Sources still union: the survivor holds every page either row had.
    expect(row.sources).toHaveLength(3);
  });

  test("apply keeps the better-verified row, unions what the other knew, and folds the company", async () => {
    const db = await testDb();
    await storeUltraviolettePair(db);
    const result = await mergeRoundPairs(db, { apply: true });
    expect(result.merged).toBe(1);
    const { rows } = await listRounds(db, { includeReview: true });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.id).toBe("ultraviolette:series_d_plus:2026-09-23");
    expect(row.company).toMatchObject({ id: "ultraviolette", name: "Ultraviolette Automotive", domain: "ultraviolette.com" });
    expect(row.disposition).toBe("publish");
    expect(row.status).toBe("seen");
    expect(row.first_seen_at).toBe("2026-09-23T08:16:29.000Z");
    expect(row.sources).toHaveLength(3);
    expect(row.lead_investors.sort()).toEqual(["TDK Ventures", "Yali Capital"]);
    expect(row.other_investors).toEqual(["Lip-Bu Tan"]);
    expect(row.evidence_quotes).toHaveLength(2);
    expect(await count(db, "companies")).toBe(1);
    expect(await count(db, "deliveries")).toBe(1);
    const kinds = await db.execute(sql`select company_id, kind from enrichments order by kind::text`);
    expect(kinds.rows).toEqual([
      { company_id: "ultraviolette", kind: "deep_dive" },
      { company_id: "ultraviolette", kind: "profile" },
    ]);
    const aliases = await db.execute(sql`select company_id, alias_key from company_aliases`);
    expect(aliases.rows).toEqual([{ company_id: "ultraviolette", alias_key: "ultraviolette automotive" }]);
    // Run again: nothing left to merge.
    expect((await mergeRoundPairs(db, { apply: true })).planned).toEqual([]);
  });

  test("a named pair merges alone; a pair the rule does not join is refused unless forced", async () => {
    const db = await testDb();
    await storeUltraviolettePair(db);
    await persistRecords(db, [record({ company_name: "Other Co", announced_date: "2026-09-23" })], "growth", "run-1");
    const refused = await mergeRoundPairs(db, {
      apply: false,
      pairs: [["other-co:series_a:2026-09-23", "ultraviolette:series_d_plus:2026-09-23"]],
    });
    expect(refused.planned).toEqual([]);
    expect(refused.refused[0]).toContain("the rule does not call these one round");
    const named = await mergeRoundPairs(db, {
      apply: true,
      pairs: [["ultraviolette-automotive:series_d_plus:2026-09-23", "ultraviolette:series_d_plus:2026-09-23"]],
    });
    expect(named.merged).toBe(1);
    expect((await listRounds(db, { includeReview: true })).rows.map((r) => r.id).sort()).toEqual([
      "other-co:series_a:2026-09-23",
      "ultraviolette:series_d_plus:2026-09-23",
    ]);
  });

  test("the IPID case: whichever row survives a forced merge, the round keeps the stage one of them named", async () => {
    const db = await testDb();
    const amount = { value: 16, currency: "USD", as_written: "$16 million", usd_millions: 16, fx_rate: 1, fx_date: "2026-09-24" };
    await persistRecords(
      db,
      [
        record({
          company_name: "IPID",
          company_key: "ipid",
          stage: "series_a",
          stage_as_written: "Series A",
          announced_date: "2026-09-24",
          amount,
        }),
        record({
          company_name: "International Payments Identity Pte. Ltd.",
          company_key: "international payments identity",
          stage: "other",
          stage_as_written: "funding",
          announced_date: "2026-09-24",
          amount,
          confidence: 0.9,
        }),
      ],
      "series-a-b",
      "run-1",
    );
    const ids = (await listRounds(db, { includeReview: true })).rows.map((r) => r.id).sort();
    expect(ids).toHaveLength(2);
    const result = await mergeRoundPairs(db, { apply: true, force: true, pairs: [[ids[0], ids[1]]] });
    expect(result.merged).toBe(1);
    const [row] = (await listRounds(db, { includeReview: true })).rows;
    expect(row).toMatchObject({ stage: "series_a", stage_as_written: "Series A" });
  });

  test("mergeDuplicateRounds (the pnpm merge-duplicates pass) finds the pair across two company rows", async () => {
    const db = await testDb();
    await storeUltraviolettePair(db);
    const { merged, mergedInto } = await mergeDuplicateRounds(db);
    expect(merged).toBe(1);
    expect(mergedInto).toEqual({ "ultraviolette-automotive:series_d_plus:2026-09-23": "ultraviolette:series_d_plus:2026-09-23" });
  });
});

// The pre-launch audit's four pairs (2026-09-24): each one round stored twice, so "Total raised"
// counted it twice. The fixtures carry the production rows' own stages, amounts, days, and bases.
describe("re-reports and re-dated rows", () => {
  const usd = (m: number, day: string) => ({ value: m, currency: "USD", as_written: `$${m}M`, usd_millions: m, fx_rate: 1, fx_date: day });
  const none = { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null };
  const rows = async (db: Db) => (await listRounds(db, { includeReview: true })).rows;

  test("Greyparrot: a row re-dated by its read-back onto a stored round merges with it", async () => {
    const db = await testDb();
    const base = { company_name: "Greyparrot", company_key: "greyparrot", company_domain: "greyparrot.ai", stage: "series_b" as const };
    await persistRecords(
      db,
      [
        record({
          ...base,
          id: "greyparrot:series_b:2026-09-01",
          announced_date: "2026-07-28",
          date_basis: "page",
          amount: usd(27, "2026-07-28"),
          sources: [{ url: "https://news.example/greyparrot", host: "news.example" }],
        }),
      ],
      "series-a-b",
      "run-1",
    );
    // A later article read first with no figure and its own byline's day: 57 days on, not yet one round.
    const later = { ...base, id: "greyparrot:series_b:2026-09-23", sources: [{ url: "https://later.example/gp", host: "later.example" }] };
    await persistRecords(db, [record({ ...later, announced_date: "2026-09-23", date_basis: "page", amount: none })], "series-a-b", "run-2");
    expect(await rows(db)).toHaveLength(2);
    // Its read-back states the July 28 day and the $27M: the updated row now matches, and is checked.
    await persistRecords(
      db,
      [record({ ...later, announced_date: "2026-07-28", date_basis: "stated", amount: usd(27, "2026-07-28") })],
      "series-a-b",
      "run-3",
    );
    const [row, ...rest] = await rows(db);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({ announced_on: "2026-07-28", date_basis: "stated" });
    expect(row.sources.map((s) => s.host).sort()).toEqual(["later.example", "news.example"]);
  });

  test("Millie: a roundup re-reporting an old Series A with its leads and page joins it and keeps its day", async () => {
    const db = await testDb();
    const dealbreaker = {
      url: "https://dealbreaker.com/2025/02/millie-raises-12m-to-advance-maternal-healthcare",
      host: "dealbreaker.com",
    };
    const base = { company_name: "Millie", company_key: "millie", stage: "series_a" as const, lead_investors: ["TMV", "Foreground"] };
    await persistRecords(
      db,
      [
        record({
          ...base,
          id: "millie:series_a:2026-09-23",
          announced_date: "2025-02-20",
          date_basis: "url",
          amount: usd(12, "2025-02-20"),
          sources: [{ url: "https://www.businesswire.com/news/home/20250220127655/en/Millie", host: "businesswire.com" }, dealbreaker],
        }),
      ],
      "series-a-b",
      "run-1",
    );
    const second = await persistRecords(
      db,
      [
        record({
          ...base,
          id: "millie:series_a:2026-09-24",
          announced_date: "2026-09-24",
          date_precision: "week",
          date_basis: "page",
          amount: usd(12, "2026-09-24"),
          sources: [dealbreaker],
        }),
      ],
      "series-a-b",
      "run-2",
    );
    expect(second.inserted).toBe(0);
    const [row, ...rest] = await rows(db);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({ id: "millie:series_a:2026-09-23", announced_on: "2025-02-20", date_precision: "day" });
  });

  test("Higharc: a monthly list's reading of a July release is one round, and the release's day stands", async () => {
    const db = await testDb();
    const base = {
      company_name: "Higharc",
      company_key: "higharc",
      company_domain: "higharc.com",
      stage: "series_c" as const,
      stage_as_written: "Series C",
    };
    await persistRecords(
      db,
      [record({ ...base, announced_date: "2026-07-02", date_basis: "stated", amount: usd(95, "2026-07-02") })],
      "growth",
      "run-1",
    );
    await persistRecords(
      db,
      [
        record({
          ...base,
          id: "higharc:series_c:2026-08-31",
          announced_date: "2026-08-31",
          date_precision: "month",
          date_basis: "page",
          amount: usd(95, "2026-08-31"),
          sources: [{ url: "https://list.example/august", host: "list.example" }],
        }),
      ],
      "growth",
      "run-2",
    );
    const [row, ...rest] = await rows(db);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({ announced_on: "2026-07-02", date_precision: "day" });
  });

  test("Fearn: a launch story months after the seed joins it; restaged later, a stageless copy merges too", async () => {
    const db = await testDb();
    const base = { company_name: "Fearn", company_key: "fearn", company_domain: "fearn.ai", lead_investors: ["Kindred"] };
    const release = record({
      ...base,
      stage: "seed",
      stage_as_written: "seed",
      announced_date: "2026-06-10",
      date_basis: "stated",
      amount: usd(5.5, "2026-06-10"),
    });
    await persistRecords(db, [release], "seed", "run-1");
    const story = { ...base, id: "fearn:other:2026-09-24", sources: [{ url: "https://www.forbes.com/fearn", host: "forbes.com" }] };
    // Read as "other" first: 105 days from the seed, but the same figure and the same lead make it the seed re-reported.
    await persistRecords(
      db,
      [
        record({
          ...story,
          stage: "other",
          stage_as_written: "funding",
          announced_date: "2026-09-23",
          date_basis: "url",
          amount: usd(5.5, "2026-09-23"),
        }),
      ],
      "seed",
      "run-2",
    );
    expect(await rows(db)).toHaveLength(1);
    // Its read-back names the seed: still one round with June's, which keeps its stated day.
    await persistRecords(
      db,
      [
        record({
          ...story,
          stage: "seed",
          stage_as_written: "seed",
          announced_date: "2026-09-23",
          date_basis: "url",
          amount: usd(5.5, "2026-09-23"),
        }),
      ],
      "seed",
      "run-3",
    );
    const [row, ...rest] = await rows(db);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({ announced_on: "2026-06-10", date_basis: "stated", stage: "seed" });
  });

  test("Fearn again (2026-09-25): a digest's unlabelled copy of a merged-away row joins the seed on a shared page", async () => {
    const db = await testDb();
    const digest = "https://www.bizjournals.com/sanfrancisco/news/2026/09/24/sfbt-digest-thursday-databricks-uc-berkeley.html";
    const base = { company_name: "Fearn", company_key: "fearn", company_domain: "fearn.ai" };
    await persistRecords(
      db,
      [
        record({
          ...base,
          id: "fearn:seed:2026-09-23",
          stage: "seed",
          stage_as_written: "seed",
          announced_date: "2026-06-10",
          date_basis: "stated",
          lead_investors: ["Kindred Ventures"],
          amount: usd(5.5, "2026-06-10"),
          sources: [
            { url: "https://www.prnewswire.com/news-releases/fearn-raises-5-5-million-seed-302796012.html", host: "prnewswire.com" },
            { url: digest, host: "bizjournals.com" },
          ],
        }),
      ],
      "seed",
      "run-1",
    );
    // The series-a-b sweep's ledger had never read the digest: it reads "raised $5.5 million", no label, no lead.
    await persistRecords(
      db,
      [
        record({
          ...base,
          id: "fearn:other:2026-09-24",
          stage: "other",
          stage_as_written: "funding round",
          announced_date: "2026-09-24",
          date_basis: "page",
          amount: usd(5.5, "2026-09-24"),
          sources: [{ url: digest, host: "bizjournals.com" }],
        }),
      ],
      "seed",
      "run-2",
    );
    const [row, ...rest] = await rows(db);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({ id: "fearn:seed:2026-09-23", announced_on: "2026-06-10", stage: "seed" });
  });

  test("a stageless reading far from a named round needs a shared page or lead to join it", () => {
    const seed = { stage: "seed", announcedOn: "2026-06-10", amountUsdMillions: 5.5, sourceIds: ["https://a"], leadKeys: ["kindred"] };
    const later = { stage: "other", announcedOn: "2026-09-24", amountUsdMillions: 5.5 };
    expect(isSameRound(seed, later)).toBe(false);
    expect(isSameRound(seed, { ...later, sourceIds: ["https://a"] })).toBe(true);
    expect(isSameRound({ ...later, leadKeys: ["kindred"] }, seed)).toBe(true);
    expect(isSameRound(seed, { ...later, sourceIds: ["https://a"], amountUsdMillions: 8 })).toBe(false);
    expect(isSameRound(seed, { ...later, sourceIds: ["https://a"], announcedOn: "2029-09-24" })).toBe(false);
    expect(isSameRound({ ...seed, stage: "debt" }, { ...later, sourceIds: ["https://a"] })).toBe(false);
  });

  test("isSameRound keeps separate rounds separate", () => {
    const r = (over: Partial<Parameters<typeof isSameRound>[0]>) => ({
      stage: "series_b",
      announcedOn: "2026-01-10",
      amountUsdMillions: 100,
      ...over,
    });
    // One stage, one amount, within a year: one round.
    expect(isSameRound(r({}), r({ announcedOn: "2026-09-10" }))).toBe(true);
    // Quaise: its $134M first close (July 7) and its $46M final close, from a list's week of August 24,
    // are two closes; the list's span alone does not bring figures this far apart into one round.
    expect(
      isSameRound(
        r({ announcedOn: "2026-07-07", amountUsdMillions: 134 }),
        r({ announcedOn: "2026-08-24", datePrecision: "week", amountUsdMillions: 46 }),
      ),
    ).toBe(false);
    expect(
      isSameRound(r({ announcedOn: "2026-07-07" }), r({ announcedOn: "2026-08-24", datePrecision: "week", amountUsdMillions: 90 })),
    ).toBe(true);
    // Series D and Series E share the D+ bucket but are two rounds.
    expect(
      isSameRound(
        r({ stage: "series_d_plus", stageAsWritten: "Series D" }),
        r({ stage: "series_d_plus", stageAsWritten: "Series E", announcedOn: "2026-09-10" }),
      ),
    ).toBe(false);
    // An extension is its own raise; a stageless round names nothing to join on; nor does an unknown amount.
    expect(isSameRound(r({}), r({ announcedOn: "2026-09-10", isExtension: true }))).toBe(false);
    expect(isSameRound(r({ stage: "other" }), r({ stage: "other", announcedOn: "2026-09-10" }))).toBe(false);
    expect(isSameRound(r({}), r({ announcedOn: "2026-09-10", amountUsdMillions: null }))).toBe(false);
    // Past a year the two need a shared page, a shared lead, or a list's date; never past three years.
    expect(isSameRound(r({}), r({ announcedOn: "2027-09-10" }))).toBe(false);
    expect(isSameRound(r({ leadKeys: ["tmv"] }), r({ announcedOn: "2027-09-10", leadKeys: ["tmv"] }))).toBe(true);
    expect(isSameRound(r({ sourceIds: ["https://a"] }), r({ announcedOn: "2027-09-10", sourceIds: ["https://a"] }))).toBe(true);
    expect(isSameRound(r({}), r({ announcedOn: "2027-09-10", datePrecision: "week" }))).toBe(true);
    expect(isSameRound(r({ leadKeys: ["tmv"] }), r({ announcedOn: "2029-09-10", leadKeys: ["tmv"] }))).toBe(false);
    // A monthly list's day is any day of its month: August 31 is 29 days from July 2, not 60.
    expect(
      isSameRound(
        r({ announcedOn: "2026-07-02", amountUsdMillions: null }),
        r({ announcedOn: "2026-08-31", datePrecision: "month", amountUsdMillions: null }),
      ),
    ).toBe(true);
    expect(
      isSameRound(r({ announcedOn: "2026-07-02", amountUsdMillions: null }), r({ announcedOn: "2026-08-31", amountUsdMillions: null })),
    ).toBe(false);
  });

  test("Sammmm: a snippet re-reporting a history round folds into it, and the round stays history", async () => {
    const db = await testDb();
    const base = {
      company_name: "Sammmm",
      company_key: "sammmm",
      company_domain: "sammmm.com",
      stage: "seed" as const,
      stage_as_written: "seed",
    };
    const inr = (day: string) => ({
      value: 100,
      currency: "INR",
      as_written: "Rs 10 crore ($1.2 million)",
      usd_millions: 1.2,
      fx_rate: 83,
      fx_date: day,
    });
    await persistRecords(
      db,
      [record({ ...base, announced_date: "2025-01-30", date_basis: "page", amount: inr("2025-01-30") })],
      "seed",
      "run-1",
      {
        history: true,
      },
    );
    await persistRecords(
      db,
      [
        record({
          ...base,
          id: "sammmm:seed:2026-09-22",
          announced_date: "2026-09-22",
          date_precision: "week",
          date_basis: "page",
          amount: inr("2026-09-22"),
          sources: [{ url: "https://entrackr.com/snippets/lumikai", host: "entrackr.com" }],
        }),
      ],
      "seed",
      "run-2",
    );
    const [row, ...rest] = await rows(db);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({ announced_on: "2025-01-30", history: true });
  });

  test("keepsStoredDay: a stated day stands, a far later reading is a re-report, a near one updates", () => {
    const stored = (announcedOn: string, dateBasis: string, datePrecision = "day") => ({ announcedOn, dateBasis, datePrecision });
    const reading = (announced_date: string, date_basis: "stated" | "page" | "url", date_precision: "day" | "week" | "month" = "day") => ({
      announced_date,
      date_basis,
      date_precision,
    });
    expect(keepsStoredDay(stored("2026-06-10", "stated"), reading("2026-09-23", "url"))).toBe(true);
    expect(keepsStoredDay(stored("2026-07-28", "page"), reading("2026-07-28", "stated"))).toBe(false);
    expect(keepsStoredDay(stored("2025-02-20", "url"), reading("2026-09-24", "page"))).toBe(true);
    expect(keepsStoredDay(stored("2026-09-10", "page"), reading("2026-09-02", "page"))).toBe(false);
    expect(keepsStoredDay(stored("2026-09-24", "page", "week"), reading("2025-02-20", "url"))).toBe(false);
  });

  test("stageSpecificity: a merge keeps the stage that says more", () => {
    expect(stageSpecificity("series_d_plus", "Series E")).toBeGreaterThan(stageSpecificity("growth", "growth round"));
    expect(stageSpecificity("seed", "Seed")).toBeGreaterThan(stageSpecificity("seed", "funding round"));
    expect(stageSpecificity("growth", "funding")).toBeGreaterThan(stageSpecificity("other", "funding"));
  });
});
