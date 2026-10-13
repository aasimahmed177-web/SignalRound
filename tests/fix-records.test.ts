// Hand-checked corrections to stored rows (lib/repair.ts applyRecordFixes), shaped like the Sep 23
// repairs: Xpeng Robotics dated by a trend story's byline, Creem on a rock magazine's domain.

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { persistRecords } from "../lib/persist";
import { applyRecordFixes, type RecordFix } from "../lib/repair";
import { record, testDb } from "./helpers";

const REUTERS =
  "https://www.reuters.com/business/retail-consumer/xpeng-says-its-robotics-business-raised-over-900-million-first-funding-round-2026-08-24/";

const XPENG: RecordFix = {
  kind: "redate",
  round: "xpeng-robotics:series_a:2026-09-23",
  from: "2026-09-22",
  announced_on: "2026-08-24",
  basis: "url",
  evidence: {
    url: REUTERS,
    title: "Xpeng's robotics unit valued at over $6.3 billion after record funding round",
    published: "2026-08-24",
  },
  note: "announced Aug 24; the row's sources were Sep 23 trend stories",
};

const CREEM: RecordFix = {
  kind: "domain",
  company: "creem.com",
  from: "creem.com",
  domain: "creem.io",
  website: "https://www.creem.io",
  clear: ["logo", "profile", "alexandria", "deep_dive"],
  note: "creem.com is a rock magazine",
};

async function seed() {
  const handle = await testDb();
  await persistRecords(
    handle,
    [
      record({
        id: "xpeng-robotics:series_a:2026-09-23",
        company_name: "Xpeng Robotics",
        company_key: "xpeng robotics",
        amount: { value: 900, currency: "USD", as_written: "$900 million", usd_millions: 900, fx_rate: 1, fx_date: "2026-09-23" },
        announced_date: "2026-09-22",
        date_precision: "day",
        date_basis: "page",
        evidence_quotes: ["Xpeng Robotics -- $900M Series A"],
        sources: [
          {
            url: "https://valueaddvc.com/pulse/jumbo-series-a-100m-rounds-2026",
            host: "valueaddvc.com",
            title: "Jumbo-Sized Series A Rounds Keep Getting Bigger",
          },
        ],
      }),
      record({
        company_name: "Creem",
        company_key: "creem",
        company_domain: "creem.com",
        company_website: "https://www.creem.com/",
        stage: "seed",
        stage_as_written: "seed",
      }),
      record({ company_name: "Castelion", company_key: "castelion", stage: "series_b", announced_date: "2026-09-22", confidence: 0.6 }),
    ],
    "series-a-b",
    "run-1",
  );
  await handle.update(schema.companies).set({ logoUrl: "https://www.creem.io/logo.svg" }).where(eq(schema.companies.id, "creem.com"));
  for (const kind of ["profile", "alexandria"] as const) {
    await handle.insert(schema.enrichments).values({ companyId: "creem.com", kind, data: { domain: "creem.com" } });
  }
  return handle;
}

describe("applyRecordFixes", () => {
  test("a dry run only reads; apply re-dates in place with the evidence as a source, moves a domain, rejects; a second apply skips all", async () => {
    const handle = await seed();
    const reject: RecordFix = { kind: "reject", round: "castelion:series_b:2026-09-22", reason: "an interview remark, not a round" };
    const fixes = [XPENG, CREEM, reject];

    const dry = await applyRecordFixes(handle, fixes, { apply: false });
    expect(dry.lines.join("\n")).toContain("2026-09-22 (day, page) -> 2026-08-24 (day, url); review stays");
    const [untouched] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, XPENG.round));
    expect(untouched?.announcedOn).toBe("2026-09-22");

    const applied = await applyRecordFixes(handle, fixes, { apply: true });
    expect(applied).toMatchObject({ applied: 3, skipped: 0, refused: 0 });
    const [xpeng] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, XPENG.round));
    // The id stays, as the dating repairs keep it; the day, its precision, and where it came from move.
    expect(xpeng?.announcedOn).toBe("2026-08-24");
    expect(xpeng?.datePrecision).toBe("day");
    expect(xpeng?.dateBasis).toBe("url");
    expect(xpeng?.disposition).toBe("review");
    expect(xpeng?.verification?.notes.at(-1)).toContain("read as 2026-08-24 (day, reuters.com)");
    const links = await handle.select().from(schema.roundSources).where(eq(schema.roundSources.roundId, XPENG.round));
    expect(links.map((l) => l.sourceId)).toContain(REUTERS.replace(/\/$/, ""));

    const [creem] = await handle.select().from(schema.companies).where(eq(schema.companies.id, "creem.com"));
    expect(creem?.domain).toBe("creem.io");
    expect(creem?.website).toBe("https://www.creem.io");
    expect(creem?.logoUrl).toBeNull();
    expect(await handle.select().from(schema.enrichments).where(eq(schema.enrichments.companyId, "creem.com"))).toHaveLength(0);
    const [castelion] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, reject.round));
    expect(castelion?.disposition).toBe("rejected");
    expect(castelion?.verification?.status).toBe("not_news");

    // Idempotent: what the next enrichment rebuilds on the right domain is not cleared again.
    await handle.insert(schema.enrichments).values({ companyId: "creem.com", kind: "profile", data: { domain: "creem.io" } });
    const again = await applyRecordFixes(handle, fixes, { apply: true });
    expect(again).toMatchObject({ applied: 0, skipped: 3, refused: 0 });
    expect(await handle.select().from(schema.enrichments).where(eq(schema.enrichments.companyId, "creem.com"))).toHaveLength(1);
  });

  test("a re-date that lands on a round the store already holds merges the two", async () => {
    const handle = await testDb();
    const keyfactor = {
      company_name: "Keyfactor",
      company_key: "keyfactor",
      company_domain: "keyfactor.com",
      stage: "growth" as const,
      stage_as_written: "growth investment",
      amount: { value: 1000, currency: "USD", as_written: "$1 billion", usd_millions: 1000, fx_rate: 1, fx_date: "2026-07-06" },
      date_precision: "day" as const,
      date_basis: "page" as const,
    };
    await persistRecords(
      handle,
      [
        record({
          ...keyfactor,
          id: "keyfactor:growth:2026-07-31",
          announced_date: "2026-07-06",
          sources: [{ url: "https://www.prnewswire.com/keyfactor-summit", host: "prnewswire.com", title: "Keyfactor secures $1B" }],
        }),
      ],
      "growth",
      "run-1",
    );
    await persistRecords(
      handle,
      [
        record({
          ...keyfactor,
          id: "keyfactor:growth:2026-09-16",
          announced_date: "2026-09-16",
          // The recap gave no figure, so the re-report rule (one stage, one amount) cannot join it before the re-date does.
          amount: { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null },
          sources: [{ url: "https://example.com/weekly-recap", host: "example.com", title: "The week in funding" }],
        }),
      ],
      "growth",
      "run-2",
    );
    const fix: RecordFix = {
      kind: "redate",
      round: "keyfactor:growth:2026-09-16",
      from: "2026-09-16",
      announced_on: "2026-07-06",
      basis: "stated",
      evidence: { url: "https://www.prnewswire.com/keyfactor-summit", title: "Keyfactor secures $1B", published: "2026-07-06" },
      note: "announced Jul 6; the row took a weekly recap's day",
    };
    const result = await applyRecordFixes(handle, [fix], { apply: true });
    expect(result.lines.join("\n")).toContain("merged 1 round(s) of keyfactor.com");
    const rows = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.companyId, "keyfactor.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.announcedOn).toBe("2026-07-06");
  });

  test("a row that moved on since the fix was written is refused, not overwritten", async () => {
    const handle = await seed();
    await handle.update(schema.fundingRounds).set({ announcedOn: "2026-09-20" }).where(eq(schema.fundingRounds.id, XPENG.round));
    const result = await applyRecordFixes(handle, [XPENG, { ...CREEM, from: "creem.net" }], { apply: true });
    expect(result).toMatchObject({ applied: 0, refused: 2 });
    const [xpeng] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, XPENG.round));
    expect(xpeng?.announcedOn).toBe("2026-09-20");
  });

  test("the OpenAI repair: a domain set on a company that had none, a round restaged, a bogus row rejected with its evidence", async () => {
    const handle = await testDb();
    await persistRecords(
      handle,
      [
        record({
          id: "openai:other:2025-03-31",
          company_name: "OpenAI",
          company_key: "openai",
          stage: "other",
          stage_as_written: "funding round",
          announced_date: "2025-03-31",
          amount: { value: 40, currency: "USD", as_written: "$40 billion", usd_millions: 40000, fx_rate: 1, fx_date: "2025-03-31" },
        }),
      ],
      "series-a-b",
      "run-1",
    );
    await handle.insert(schema.enrichments).values({ companyId: "openai", kind: "profile", data: { website_source: "none" } });
    const fixes: RecordFix[] = [
      {
        kind: "domain",
        company: "openai",
        from: null,
        domain: "openai.com",
        website: "https://openai.com",
        clear: ["profile"],
        note: "the identity check never placed OpenAI",
        evidence: "https://openai.com/about/",
      },
      {
        kind: "restage",
        round: "openai:other:2025-03-31",
        from: "other",
        stage: "growth",
        stage_as_written: "funding round",
        evidence: "https://openai.com/index/march-funding-updates/",
        note: "an unlettered $40 billion round is a growth round",
      },
      { kind: "reject", round: "openai:other:2025-03-31", reason: "test only", evidence: "https://example.com/proof" },
      {
        kind: "describe",
        company: "openai",
        from: null,
        description: "OpenAI is an AI research and deployment company that builds the GPT models, ChatGPT, and an API.",
        evidence: "https://openai.com/",
        note: "no description on the row",
      },
    ];
    const dry = await applyRecordFixes(handle, fixes.slice(0, 2), { apply: false });
    expect(dry.lines.join("\n")).toContain("domain openai (OpenAI): none -> openai.com");
    expect(dry.lines.join("\n")).toContain("restage openai:other:2025-03-31: other (funding round) -> growth (funding round)");
    expect(dry.refused).toBe(0);
    const applied = await applyRecordFixes(handle, fixes, { apply: true });
    expect(applied).toMatchObject({ applied: 4, refused: 0 });
    const [company] = await handle.select().from(schema.companies).where(eq(schema.companies.id, "openai"));
    expect(company).toMatchObject({ domain: "openai.com", website: "https://openai.com" });
    expect(company?.description).toContain("AI research and deployment company");
    expect(await handle.select().from(schema.enrichments).where(eq(schema.enrichments.companyId, "openai"))).toHaveLength(0);
    const [row] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, "openai:other:2025-03-31"));
    expect(row?.stage).toBe("growth");
    expect(row?.disposition).toBe("rejected");
    const notes = (row?.verification as { notes: string[] } | undefined)?.notes ?? [];
    expect(notes.some((n) => n.startsWith("stage other (funding round) read as growth"))).toBe(true);
    expect(notes).toContain("rejected: test only (https://example.com/proof)");
    const again = await applyRecordFixes(handle, fixes, { apply: true });
    expect(again).toMatchObject({ applied: 0, skipped: 4, refused: 0 });
    // A description that moved on since the fix was written is refused, not overwritten.
    const moved = await applyRecordFixes(
      handle,
      [{ kind: "describe", company: "openai", from: null, description: "Something else.", evidence: "https://openai.com/", note: "stale" }],
      { apply: true },
    );
    expect(moved.refused).toBe(1);
  });

  test("a round shown as announced that its source says is still being raised becomes expected and stays so", async () => {
    const handle = await testDb();
    const fieldai = () =>
      record({
        id: "fieldai:growth:2026-10-02",
        company_name: "FieldAI",
        company_key: "fieldai",
        company_domain: "fieldai.com",
        stage: "growth",
        stage_as_written: "funding round",
        announced_date: "2026-10-02",
        amount: { value: 700, currency: "USD", as_written: "$700 million", usd_millions: 700, fx_rate: 1, fx_date: "2026-10-02" },
        sources: [
          {
            url: "https://traded.co/vc/deal/fieldai-raises-700-million-at-10-billion-valuation",
            host: "traded.co",
            title: "FieldAI Raises $700 Million At $10 Billion Valuation",
            evidence: "FieldAI closed a $700 million round at a $10 billion valuation.",
          },
        ],
      });
    await persistRecords(handle, [fieldai()], "growth", "run-1");
    const fix: RecordFix = {
      kind: "certainty",
      round: "fieldai:growth:2026-10-02",
      from: "announced",
      certainty: "expected",
      evidence: "https://www.businessinsider.com/robotics-startup-fieldai-raises-at-10b-valuation-in-new-round-2026-10",
      quote: "FieldAI is raising $700 million at a $10 billion valuation, according to a person familiar with the deal",
      note: "the established report says the round is still being raised",
    };
    const dry = await applyRecordFixes(handle, [fix], { apply: false });
    expect(dry.lines.join("\n")).toContain("certainty fieldai:growth:2026-10-02: announced -> expected");
    const read = async () => (await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, fix.round)))[0];
    expect((await read())?.certainty).toBe("announced");
    expect(await applyRecordFixes(handle, [fix], { apply: true })).toMatchObject({ applied: 1, refused: 0 });
    const row = await read();
    expect(row).toMatchObject({ certainty: "expected", reportedOn: "2026-10-02", pinned: { certainty: "expected" } });
    const notes = (row?.verification as { notes: string[] } | undefined)?.notes ?? [];
    expect(notes.some((n) => n.startsWith("certainty announced read as expected (businessinsider.com)"))).toBe(true);
    expect(await applyRecordFixes(handle, [fix], { apply: true })).toMatchObject({ applied: 0, skipped: 1 });
    expect(await applyRecordFixes(handle, [{ ...fix, from: "reported", certainty: "unconfirmed" }], { apply: true })).toMatchObject({
      refused: 1,
    });
    // A later "closed" reading, even an established outlet's, does not move a pinned certainty back.
    const closed = fieldai();
    closed.certainty = "announced";
    closed.sources = [
      {
        url: "https://www.reuters.com/technology/fieldai-closes-700-million-round-2026-10-03/",
        host: "reuters.com",
        title: "FieldAI closes $700 million round",
        evidence: "FieldAI closed a $700 million round at a $10 billion valuation.",
      },
    ];
    await persistRecords(handle, [closed], "growth", "run-2");
    expect(await handle.select().from(schema.fundingRounds)).toHaveLength(1);
    expect((await read())?.certainty).toBe("expected");
  });

  test("a valuation its announcement states is written in the page's words, kept as a claim, and pinned", async () => {
    const handle = await testDb();
    const brex = () =>
      record({
        id: "brex:series_c:2019-06-11",
        company_name: "Brex",
        company_key: "brex",
        company_domain: "brex.com",
        stage: "series_c",
        stage_as_written: "Series C-2",
        announced_date: "2019-06-11",
        amount: { value: 100, currency: "USD", as_written: "$100 million", usd_millions: 100, fx_rate: 1, fx_date: "2019-06-11" },
        sources: [
          {
            url: "https://www.brex.com/journal/press/series-c-2",
            host: "brex.com",
            title: "Brex raises $100 million Series C-2",
            evidence: "Brex has raised $100 million in a Series C-2 round led by Kleiner Perkins.",
          },
        ],
      });
    await persistRecords(handle, [brex()], "growth", "run-1");
    const fix: RecordFix = {
      kind: "valuation",
      round: "brex:series_c:2019-06-11",
      from: null,
      valuation: "$2.6 billion",
      evidence: "https://www.brex.com/journal/press/series-c-2",
      quote: "The round brings Brex to a valuation of $2.6 billion.",
      note: "the announcement states the valuation",
    };
    const read = async () => (await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, fix.round)))[0];
    expect(await applyRecordFixes(handle, [{ ...fix, quote: "Brex has raised $100 million." }], { apply: true })).toMatchObject({
      refused: 1,
    });
    const dry = await applyRecordFixes(handle, [fix], { apply: false });
    expect(dry.lines.join("\n")).toContain("valuation brex:series_c:2019-06-11: none -> $2.6 billion");
    expect((await read())?.valuationAsWritten).toBeNull();
    expect(await applyRecordFixes(handle, [fix], { apply: true })).toMatchObject({ applied: 1, refused: 0 });
    const row = await read();
    expect(row).toMatchObject({ valuationAsWritten: "$2.6 billion", valuationDisclosed: true, pinned: { valuation: "$2.6 billion" } });
    expect(row?.valuationClaims).toContainEqual(expect.objectContaining({ value: "$2.6 billion", url: fix.evidence, quote: fix.quote }));
    expect(await applyRecordFixes(handle, [fix], { apply: true })).toMatchObject({ applied: 0, skipped: 1 });
    expect(
      await applyRecordFixes(
        handle,
        [{ ...fix, from: "$3 billion", valuation: "$2.7 billion", quote: "Brex is valued at $2.7 billion." }],
        { apply: true },
      ),
    ).toMatchObject({
      refused: 1,
    });
    // A later reading with no valuation, or another one, leaves the pinned valuation as it is.
    await persistRecords(handle, [brex()], "growth", "run-2");
    expect((await read())?.valuationAsWritten).toBe("$2.6 billion");
  });

  test("a flagged row checked against a page it cites is published as a person would, with the check in its notes", async () => {
    const handle = await testDb();
    const release = "https://www.brex.com/journal/press/series-c-2";
    await persistRecords(
      handle,
      [
        record({
          id: "brex:series_c:2019-06-11",
          company_name: "Brex",
          company_key: "brex",
          company_domain: "brex.com",
          stage: "series_c",
          stage_as_written: "Series C-2",
          announced_date: "2019-06-11",
          amount: { value: 100, currency: "USD", as_written: "$100 million", usd_millions: 100, fx_rate: 1, fx_date: "2019-06-11" },
          confidence: 0.61,
          verification: { status: "confirmed", notes: [], url: release },
          sources: [{ url: release, host: "brex.com", title: "Brex raises $100 million Series C-2" }],
        }),
      ],
      "growth",
      "run-1",
      { history: true },
    );
    const read = async () =>
      (await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, "brex:series_c:2019-06-11")))[0];
    expect((await read())?.disposition).toBe("flagged");
    const fix: RecordFix = {
      kind: "publish",
      round: "brex:series_c:2019-06-11",
      from: "flagged",
      evidence: release,
      quote: "Brex has raised $100 million in a Series C-2 round.",
      note: "the company's own release states the round",
    };
    expect(await applyRecordFixes(handle, [{ ...fix, quote: "Brex raised a Series C-2." }], { apply: true })).toMatchObject({ refused: 1 });
    expect(await applyRecordFixes(handle, [{ ...fix, evidence: "https://news.example/brex-c2" }], { apply: true })).toMatchObject({
      refused: 1,
    });
    expect(await applyRecordFixes(handle, [fix], { apply: false })).toMatchObject({ applied: 0, refused: 0 });
    expect((await read())?.disposition).toBe("flagged");
    expect(await applyRecordFixes(handle, [fix], { apply: true })).toMatchObject({ applied: 1 });
    const row = await read();
    expect(row).toMatchObject({ disposition: "publish", audit: { status: "human" } });
    expect((row?.verification as { notes: string[] } | undefined)?.notes.at(-1)).toContain("published by hand (brex.com)");
    expect(await applyRecordFixes(handle, [fix], { apply: true })).toMatchObject({ applied: 0, skipped: 1 });
  });

  test("unlink takes a second deal's page and quote off a row, keeps its last source, and is idempotent", async () => {
    const handle = await testDb();
    const september = "https://immunomatics.com/press/dr-keith-robison-invests-25000-in-immunomatics";
    const october = "https://www.prnewswire.com/news-releases/gendx-co-founder-invests-100-000-in-immunomatics-302900371.html";
    const robison = "Computational Biologist Dr. Keith Robison Invests $25,000 in Immunomatics";
    const mulder = "Immunomatics today announced a $100,000 strategic investment from Myosotis Investments B.V.";
    await persistRecords(
      handle,
      [
        record({
          id: "immunomatics:other:2026-10-07",
          company_name: "Immunomatics",
          company_key: "immunomatics",
          company_domain: "immunomatics.com",
          stage: "other",
          stage_as_written: "strategic investment",
          announced_date: "2026-10-07",
          amount: { value: 0.1, currency: "USD", as_written: "$100,000", usd_millions: 0.1, fx_rate: 1, fx_date: "2026-10-07" },
          evidence_quotes: [mulder, robison],
          sources: [
            { url: october, host: "prnewswire.com" },
            { url: september, host: "immunomatics.com" },
          ],
        }),
      ],
      "seed",
      "run-1",
    );
    const fix: RecordFix = {
      kind: "unlink",
      round: "immunomatics:other:2026-10-07",
      source: september,
      quotes: [robison],
      note: "Keith Robison's $25,000 of September 3 is its own investment",
    };
    const links = async () =>
      (await handle.select().from(schema.roundSources).where(eq(schema.roundSources.roundId, fix.round))).map((l) => l.sourceId);
    expect(await applyRecordFixes(handle, [fix], { apply: false })).toMatchObject({ applied: 0, refused: 0 });
    expect(await links()).toHaveLength(2);
    expect(await applyRecordFixes(handle, [fix], { apply: true })).toMatchObject({ applied: 1 });
    expect(await links()).toEqual([october]);
    const [row] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, fix.round));
    expect(row?.evidenceQuotes).toEqual([mulder]);
    expect(await applyRecordFixes(handle, [fix], { apply: true })).toMatchObject({ applied: 0, skipped: 1 });
    expect(await applyRecordFixes(handle, [{ ...fix, source: october, quotes: [] }], { apply: true })).toMatchObject({ refused: 1 });
  });

  test("a round's syndicate is replaced from its announcement, a company's headquarters and sector move; a second apply skips", async () => {
    const handle = await testDb();
    const round = "positron:series_c:2026-09-11";
    await persistRecords(
      handle,
      [record({ id: round, company_name: "Positron", company_key: "positron", stage: "series_c", lead_investors: [], sector: "ai" })],
      "series-a-b",
      "run-1",
    );
    // The row as a read-back left it: one person under two spellings, one co-lead of six.
    for (const [id, name, role] of [
      ["james clark", "James Clark", "lead"],
      ["jim clark", "Jim Clark", "lead"],
      ["new enterprise associates", "New Enterprise Associates", "lead"],
      ["cisco", "Cisco Investments", "participant"],
    ] as const) {
      await handle.insert(schema.investors).values({ id, name }).onConflictDoNothing();
      await handle.insert(schema.roundInvestors).values({ roundId: round, investorId: id, role });
    }
    const fixes: RecordFix[] = [
      {
        kind: "investors",
        round,
        from: { leads: ["James Clark", "Jim Clark", "New Enterprise Associates"], participants: ["Cisco Investments"] },
        to: { leads: ["NEA", "Atreides Management", "Jim Clark"], participants: ["Cisco Investments", "DFJ Growth"] },
        evidence: "https://www.prnewswire.com/news-releases/positron-ai-raises-875-million-302874601.html",
        note: "the release names six co-leads; James Clark and Jim Clark are one person",
      },
      {
        kind: "hq",
        company: "positron",
        from: null,
        hq: "Reno, Nevada, USA",
        evidence: "https://www.positron.ai/",
        note: "no headquarters on the row",
      },
      {
        kind: "sector",
        company: "positron",
        from: "ai",
        sector: "semiconductors",
        evidence: "https://www.positron.ai/",
        note: "it builds inference chips",
      },
    ];
    const links = async () =>
      (
        await handle
          .select({ id: schema.roundInvestors.investorId, role: schema.roundInvestors.role })
          .from(schema.roundInvestors)
          .where(eq(schema.roundInvestors.roundId, round))
      )
        .map((l) => `${l.id}:${l.role}`)
        .sort();

    const dry = await applyRecordFixes(handle, fixes, { apply: false });
    expect(dry.refused).toBe(0);
    expect(dry.lines.join("\n")).toContain(
      "investors positron:series_c:2026-09-11: leads [James Clark, Jim Clark, New Enterprise Associates], participants [Cisco Investments] -> leads [Jim Clark, New Enterprise Associates, Atreides Management], participants [Cisco Investments, DFJ Growth]",
    );
    expect(dry.lines.join("\n")).toContain('sector positron (Positron): "ai" -> "semiconductors"');
    expect(await links()).toContain("james clark:lead");

    const applied = await applyRecordFixes(handle, fixes, { apply: true });
    expect(applied).toMatchObject({ applied: 3, skipped: 0, refused: 0 });
    expect(await links()).toEqual([
      "atreides:lead",
      "cisco:participant",
      "dfj growth:participant",
      "jim clark:lead",
      "new enterprise associates:lead",
    ]);
    // The spelling the row already had shows; the person no round names anymore goes.
    expect(await handle.select().from(schema.investors).where(eq(schema.investors.id, "james clark"))).toHaveLength(0);
    const [row] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, round));
    expect(row?.verification?.notes.at(-1)).toMatch(/^investors read as leads \[.*\] \(prnewswire\.com\): the release names six co-leads/);
    const [company] = await handle.select().from(schema.companies).where(eq(schema.companies.id, "positron"));
    expect(company).toMatchObject({ hq: "Reno, Nevada, USA", sector: "semiconductors" });

    const again = await applyRecordFixes(handle, fixes, { apply: true });
    expect(again).toMatchObject({ applied: 0, skipped: 3, refused: 0 });
  });

  test("an investors fix is refused when the row moved on or when hygiene would not write its lists; a sector outside the vocabulary is refused", async () => {
    const handle = await testDb();
    const round = "river:series_a:2026-09-23";
    await persistRecords(
      handle,
      [record({ id: round, company_name: "River AI", company_key: "river", lead_investors: [], announced_date: "2026-08-11" })],
      "series-a-b",
      "run-1",
    );
    const river: RecordFix = {
      kind: "investors",
      round,
      from: { leads: [], participants: [] },
      to: { leads: ["General Catalyst", "AMP PBC"], participants: ["NVIDIA", "Temasek"] },
      evidence: "https://www.businesswire.com/news/home/20260811845258/en/River-AI-Raises",
      note: "the release names the leads",
    };
    const placeholder: RecordFix = { ...river, to: { leads: ["General Catalyst"], participants: ["existing investors"] } };
    const rocket: RecordFix = {
      kind: "sector",
      company: "river",
      from: "fintech",
      sector: "rockets" as never,
      evidence: "https://river.ai",
      note: "x",
    };
    const result = await applyRecordFixes(handle, [placeholder, rocket], { apply: true });
    expect(result).toMatchObject({ applied: 0, refused: 2 });
    expect(result.lines.join("\n")).toContain("the write would leave leads [General Catalyst], participants []");

    // A read-back that wrote its own list since the fix was written wins: the fix is refused.
    await handle.insert(schema.investors).values({ id: "general catalyst", name: "General Catalyst" });
    await handle.insert(schema.roundInvestors).values({ roundId: round, investorId: "general catalyst", role: "lead" });
    const moved = await applyRecordFixes(handle, [river], { apply: true });
    expect(moved).toMatchObject({ applied: 0, refused: 1 });
    expect(moved.lines[0]).toContain("the row holds leads [General Catalyst], participants []");
  });

  test("requeue puts a lead that ended without a source back to pending with a new page, once", async () => {
    const handle = await testDb();
    await persistRecords(handle, [record({ company_name: "OpenAI", company_key: "openai" })], "series-a-b", "run-1");
    const microsoft: RecordFix = {
      kind: "history_lead",
      company: "openai",
      stage_as_written: "multiyear, multibillion dollar investment",
      amount_as_written: "$10 billion",
      announced_date: "2023-01-23",
      lead_investors: ["Microsoft"],
      evidence: "https://blogs.microsoft.com/blog/2023/01/23/microsoftandopenaiextendpartnership/",
      note: "Microsoft's 2023 investment",
    };
    await applyRecordFixes(handle, [microsoft], { apply: true });
    const ledger = () => handle.select().from(schema.historyPromotions).where(eq(schema.historyPromotions.companyId, "openai"));
    const [queued] = await ledger();
    // The lane read the cited post, which never states the figure.
    await handle
      .update(schema.historyPromotions)
      .set({ status: "no_source", attempts: 1 })
      .where(eq(schema.historyPromotions.priorKey, queued?.priorKey ?? ""));

    const semafor = "https://www.semafor.com/article/01/23/2023/microsoft-openai-10-billion";
    const requeue: RecordFix = { ...microsoft, evidence: semafor, requeue: true };
    // Without the flag, or with the page it already tried, the ended lead stays as it is.
    const plain = await applyRecordFixes(
      handle,
      [
        { ...microsoft, evidence: semafor },
        { ...microsoft, requeue: true },
      ],
      { apply: true },
    );
    expect(plain).toMatchObject({ applied: 0, skipped: 2 });

    const dry = await applyRecordFixes(handle, [requeue], { apply: false });
    expect(dry.lines[0]).toContain("requeue no_source -> pending with a new page");
    expect((await ledger())[0]?.status).toBe("no_source");

    const applied = await applyRecordFixes(handle, [requeue], { apply: true });
    expect(applied.applied).toBe(1);
    const [row] = await ledger();
    expect(row).toMatchObject({ status: "pending", attempts: 0, origin: "audit" });
    expect(row?.prior.source_url).toBe(semafor);
    expect(await applyRecordFixes(handle, [requeue], { apply: true })).toMatchObject({ applied: 0, skipped: 1 });
  });
});
