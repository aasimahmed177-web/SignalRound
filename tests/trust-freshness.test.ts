import { registrableDomain } from "@fireround/core";
import { schema } from "@fireround/core/db";
import type { NativeWebClient as Firecrawl } from "@fireround/core/web";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { corroborateRecord, promoteCheckedRound } from "../lib/corroborate.ts";
import { staleForNews } from "../lib/deliverable.ts";
import { beforeEverySource, earliestReport, releaseDay, repairStaleReportDays } from "../lib/freshness.ts";
import { identityAgrees, listRounds, type MergeRow, persistRecords } from "../lib/persist.ts";
import { recordFromRow } from "../lib/reconcile.ts";
import { claimRoundVerification, seedRoundVerification, visibilityEvidence } from "../lib/round-verification.ts";
import { acceptCorroboration } from "../packages/core/src/firecrawl/corroborate.ts";
import { isAlias } from "../packages/core/src/records/resolve.ts";
import cases from "./fixtures/trust-freshness.json";
import weakRows from "./fixtures/weak-host-rows.json";
import { record, testDb } from "./helpers.ts";

describe("audit trust and freshness regressions", () => {
  test("the nine single-host af.net rows on the sanitized copy are fidelity, not independent confirmation", () => {
    for (const id of weakRows) {
      expect(visibilityEvidence([{ url: `https://af.net/round/${encodeURIComponent(id)}`, title: id }], null)).toBe(false);
    }
    expect(
      visibilityEvidence(
        [
          { url: "https://af.net/round", title: "Funding" },
          { url: "https://af.net/copy", title: "Repost" },
        ],
        null,
      ),
    ).toBe(false);
    expect(
      visibilityEvidence(
        [
          { url: "https://af.net/round", title: "Funding" },
          { url: "https://another.example/copy", title: "Funding" },
        ],
        null,
      ),
    ).toBe(false);
    expect(
      visibilityEvidence(
        [
          { url: "https://af.net/round", title: "Company raises capital", evidence: "Company raised $20 million in its Series A." },
          { url: "https://another.example/copy", title: "Startup closes a round", evidence: "Company raised $20 million in its Series A." },
        ],
        null,
      ),
    ).toBe(false);
    expect(
      visibilityEvidence(
        [
          { url: "https://af.net/round", title: "Funding" },
          { url: "https://another.example/report", title: "Independent report" },
        ],
        null,
      ),
    ).toBe(true);
    expect(visibilityEvidence([{ url: "https://prnewswire.com/release", title: "Release" }], null)).toBe(true);
    expect(visibilityEvidence([{ url: "https://reuters.com/report", title: "Report" }], null)).toBe(true);
  });

  test("a post from one of the company's own X accounts is the company's word, and stays so when the row is weighed again", async () => {
    const handle = await testDb();
    const post = "https://x.com/startupandrew/status/2107163635810472259";
    const tasklet = record({
      company_name: "Tasklet",
      announced_date: "2026-10-05",
      sources: [{ url: post, host: "x.com", title: "Andrew Lee on X" }],
      verification: { status: "unverified", notes: [], url: post },
    });
    expect(visibilityEvidence([{ url: post, title: "Andrew Lee on X" }], null)).toBe(false);
    expect(visibilityEvidence([{ url: post, title: "Andrew Lee on X" }], null, [], undefined, undefined, ["startupandrew"])).toBe(true);
    expect(
      visibilityEvidence([{ url: "https://x.com/someone/status/1", title: "x" }], null, [], undefined, undefined, ["startupandrew"]),
    ).toBe(false);

    await persistRecords(handle, [tasklet], "series-a", "x", { startIn: "flagged", ownAccounts: ["StartupAndrew"] });
    const held = (r: { verification: unknown }) => JSON.stringify(r.verification).includes("source fidelity");
    let [row] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, tasklet.id));
    expect(held(row)).toBe(false);
    // What is left is the earliest-report search every new row waits on before it is shown.
    expect((row.verification as { notes: string[] }).notes.filter((n) => n.startsWith("held for review:"))).toEqual([
      "held for review: earliest-report search pending",
    ]);
    // A later reading without the option still finds the account recorded on the company.
    await persistRecords(handle, [{ ...tasklet, evidence_quotes: ["Tasklet raised $12.8M."] }], "series-a", "again");
    [row] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, tasklet.id));
    expect(held(row)).toBe(false);
  });

  test("a checked historical announcement uses its issuer's sibling or verified alias without a news freshness search", async () => {
    const handle = await testDb();
    await handle.insert(schema.companies).values({ id: "tldraw.com", name: "tldraw", nameKey: "tldraw", domain: "tldraw.com" });
    await handle.insert(schema.companyAliases).values({
      companyId: "tldraw.com",
      kind: "domain",
      aliasKey: "sketchjournal.dev",
      alias: "sketchjournal.dev",
      sourceUrl: "https://tldraw.com/blog",
    });
    const sibling = record({
      company_name: "tldraw",
      company_key: "tldraw",
      company_domain: "tldraw.com",
      announced_date: "2023-11-22",
      sources: [{ url: "https://tldraw.dev/blog/tldraw-raised-another-2m", host: "tldraw.dev", title: "tldraw raised another $2M" }],
    });
    await persistRecords(handle, [sibling], "seed-pre-seed", "history:sibling", { history: true, companyId: "tldraw.com" });
    const [stored] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, sibling.id));
    expect(stored).toMatchObject({ history: true, disposition: "publish", freshnessCheckedOn: null });
    const alias = record({
      company_name: "tldraw",
      company_key: "tldraw",
      company_domain: "tldraw.com",
      stage: "series_a",
      stage_as_written: "Series A",
      announced_date: "2025-04-09",
      sources: [{ url: "https://sketchjournal.dev/blog/tldraw-series-a", host: "sketchjournal.dev", title: "tldraw announces Series A" }],
    });
    await persistRecords(handle, [alias], "series-a-b", "history:alias", { history: true, companyId: "tldraw.com" });
    expect((await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, alias.id)))[0]).toMatchObject({
      history: true,
      disposition: "publish",
      freshnessCheckedOn: null,
    });
    const weak = record({
      company_name: "Weak Past",
      company_domain: "weakpast.com",
      announced_date: "2023-11-22",
      sources: [{ url: "https://af.net/weak-past", host: "af.net", title: "Weak Past raised $20M" }],
    });
    await persistRecords(handle, [weak], "series-a-b", "history:weak", { history: true });
    expect((await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, weak.id)))[0]).toMatchObject({
      history: true,
      disposition: "review",
      freshnessCheckedOn: null,
    });
    expect(
      visibilityEvidence(
        [{ url: "https://tldraw.dev/blog/another-round", title: "Another company raises" }],
        "tldraw.com",
        [],
        {},
        {
          name: "tldraw",
          sites: [],
        },
      ),
    ).toBe(false);
    expect(
      visibilityEvidence(
        [{ url: "https://af.net/tldraw-round", title: "tldraw raised $2M" }],
        "tldraw.com",
        [],
        {},
        {
          name: "tldraw",
          sites: ["sketchjournal.dev"],
        },
      ),
    ).toBe(false);
  });

  test.each(cases)("earliest same-round report for $company", ({ company, stored, firstSeen, earliest, url }) => {
    const earlier = record({
      company_name: company,
      announced_date: earliest,
      sources: [{ url, host: new URL(url).hostname, title: `${company} funding` }],
      date_basis: "stated",
    });
    const later = record({
      company_name: company,
      announced_date: stored,
      sources: [{ url: "https://af.net/later", host: "af.net", title: `${company} funding later` }],
      date_basis: "page",
    });
    expect(earliestReport([later, earlier], registrableDomain(url), [], { [new URL(url).hostname]: 0.7 })).toBe(earliest);
    expect(staleForNews(earliest, new Date(`${firstSeen}T12:00:00Z`))).toBe(!["Aloja", "Go.AI"].includes(company));
  });

  test("two independent low-tier reports may establish an earlier day, syndicated copies may not", () => {
    const reports = [
      record({
        company_name: "Example",
        announced_date: "2026-09-10",
        date_basis: "page",
        sources: [
          {
            url: "https://first.test/example",
            host: "first.test",
            title: "Example financing",
            evidence: "Example raised $20 million with new investors.",
          },
        ],
      }),
      record({
        company_name: "Example",
        announced_date: "2026-09-12",
        date_basis: "page",
        sources: [
          {
            url: "https://second.test/example",
            host: "second.test",
            title: "Investors back Example",
            evidence: "Example closed a financing with its investors.",
          },
        ],
      }),
    ];
    expect(earliestReport(reports, null, [], {})).toBe("2026-09-10");
    expect(
      earliestReport(
        [reports[0], { ...reports[1], sources: [{ ...reports[1].sources[0], evidence: reports[0].sources[0].evidence }] }],
        null,
        [],
        {},
      ),
    ).toBeNull();
  });

  test("an equal-sized earlier round with another series letter is not the original announcement", () => {
    const september = record({
      company_name: "Cyera",
      company_domain: "cyera.com",
      stage: "series_d_plus",
      stage_as_written: "Series G",
      amount: { value: 400, currency: "USD", as_written: "$400 million", usd_millions: 400, fx_rate: null, fx_date: null },
      announced_date: "2026-09-22",
      lead_investors: ["Goldman Sachs"],
    });
    const january = record({
      ...september,
      stage_as_written: "Series F",
      announced_date: "2026-01-08",
      lead_investors: ["Blackstone"],
      sources: [{ url: "https://cyera.com/blog/fuel-for-what-comes-next", host: "cyera.com" }],
    });
    expect(
      acceptCorroboration(
        {
          company_name: september.company_name,
          company_domain: september.company_domain,
          stage: september.stage,
          stage_as_written: september.stage_as_written,
          amount_as_written: september.amount.as_written,
          announced_date: september.announced_date,
          lead_investors: september.lead_investors,
        },
        january,
      ),
    ).toEqual({ accept: false, reason: "round" });
  });

  test("SiliconFlow cannot inherit Silicon Mobility's company row from a similar name", () => {
    const stored = {
      domain: "silicon-mobility.com",
      description: "French EV chip unit",
      identityHeadquarters: "France",
      sourceIds: [],
    } as unknown as MergeRow;
    const reading = record({
      company_name: "SiliconFlow",
      company_key: "silicon mobility",
      company_domain: null,
      company_description: "Beijing AI inference infrastructure",
      headquarters: "Beijing",
      sources: [{ url: "https://af.net/silicon-flow", host: "af.net", title: "SiliconFlow funding" }],
    });
    expect(identityAgrees(stored, reading)).toBe(false);
    expect(
      identityAgrees(stored, { ...reading, sources: [{ url: "https://silicon-mobility.com/news", host: "silicon-mobility.com" }] }),
    ).toBe(true);
    const mobility = record({ company_name: "Silicon Mobility", company_key: "silicon mobility", company_domain: "silicon-mobility.com" });
    expect(isAlias(mobility, { ...mobility, company_domain: "siliconflow.ai" })).toBe(false);
    expect(
      acceptCorroboration(
        {
          company_name: mobility.company_name,
          company_domain: mobility.company_domain,
          stage: mobility.stage,
          stage_as_written: mobility.stage_as_written,
          amount_as_written: mobility.amount.as_written,
          announced_date: mobility.announced_date,
        },
        { ...mobility, company_domain: "siliconflow.ai" },
      ),
    ).toEqual({ accept: false, reason: "company" });
  });

  test("a weak-source row waits immediately, then auto-publishes after independent read-back and earliest search", async () => {
    const handle = await testDb();
    const today = new Date().toISOString().slice(0, 10);
    const item = record({
      company_name: "Independent",
      company_domain: "independent.test",
      announced_date: today,
      sources: [{ url: "https://af.net/independent", host: "af.net", title: "Independent raises $20M" }],
    });
    await persistRecords(handle, [item], "series-a-b", "audit:weak");
    let row = (await listRounds(handle, { ids: [item.id], includeReview: true })).rows[0];
    expect(row.disposition).toBe("review");
    expect(row.verification?.notes.some((note) => note.includes("source fidelity is not independent confirmation"))).toBe(true);
    const firstSeen = new Date(row.first_seen_at);
    await seedRoundVerification(handle, firstSeen);
    expect(await claimRoundVerification(handle, "immediate", 1, firstSeen)).toEqual([item.id]);
    const release = "https://independent.test/news/series-a";
    const searched: string[] = [];
    const read: string[] = [];
    const client = {
      async map() {
        return { links: [] };
      },
      async search(query: string) {
        searched.push(query);
        return { news: [{ url: release, title: "Independent raises $20 million Series A", date: today }], web: [] };
      },
      async scrape(url: string) {
        read.push(url);
        return {
          metadata: { title: "Independent raises $20 million Series A", publishedTime: today },
          json: {
            page_kind: "press_release",
            page_date: today,
            rounds: [
              {
                company_name: "Independent",
                company_website: "https://independent.test",
                company_description: "Independent builds software.",
                round_type_as_written: "Series A",
                amount_as_written: "$20 million",
                amount_kind: "round",
                valuation_as_written: null,
                lead_investors: ["Fund One"],
                other_investors: [],
                announced_date: today,
                headquarters: null,
                sector: "enterprise software",
                evidence_quote: "Independent raised $20 million in Series A funding.",
                source_url: null,
                is_background: false,
                is_rumor: false,
              },
            ],
          },
        };
      },
    } as unknown as Firecrawl;
    const outcome = await corroborateRecord(handle, client, item.id, { broad: true, tiers: {}, rates: null });
    expect(searched.length).toBeGreaterThan(0);
    expect(read).toEqual([release]);
    expect(outcome.rejected).toBe(0);
    expect(outcome.added.sources).toBe(1);
    row = (await listRounds(handle, { ids: [item.id], includeReview: true })).rows[0];
    expect(row.disposition).toBe("review");
    expect(row.freshness_checked_on).toBe(today);
    await promoteCheckedRound(handle, item.id, [], {});
    expect((await listRounds(handle, { ids: [item.id], includeReview: true })).rows[0].disposition).toBe("review");
    await persistRecords(
      handle,
      [
        {
          ...recordFromRow(row),
          verification: {
            status: "confirmed",
            url: release,
            notes: row.verification?.notes ?? [],
            sources_seen: row.sources.length,
          },
        },
      ],
      "series-a-b",
      "audit:read-back",
    );
    await promoteCheckedRound(handle, item.id, [], {});
    row = (await listRounds(handle, { ids: [item.id] })).rows[0];
    expect(row.disposition).toBe("publish");
    expect(row.sources).toHaveLength(2);
  });

  test("same-name facts without identifying agreement do not merge into an existing company", async () => {
    const handle = await testDb();
    const mobility = record({
      company_name: "Silicon Mobility",
      company_key: "silicon mobility",
      company_domain: "silicon-mobility.com",
      company_description: "French automotive chip unit",
      headquarters: "France",
      sources: [{ url: "https://silicon-mobility.com/news", host: "silicon-mobility.com", title: "Silicon Mobility funding" }],
    });
    await persistRecords(handle, [mobility], "series-a-b", "audit:mobility");
    const flow = record({
      company_name: "SiliconFlow",
      company_key: "silicon mobility",
      company_domain: null,
      company_description: "Beijing AI inference infrastructure",
      headquarters: "Beijing",
      sources: [{ url: "https://af.net/siliconflow", host: "af.net", title: "SiliconFlow financing" }],
    });
    await persistRecords(handle, [flow], "series-a-b", "audit:flow");
    const rows = (await listRounds(handle, { includeReview: true })).rows;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.company.id)).size).toBe(2);
    expect(rows.find((row) => row.company.name === "SiliconFlow")?.disposition).toBe("review");
  });

  test("an earlier report found before visibility moves an old round to history", async () => {
    const handle = await testDb();
    const recent = new Date().toISOString().slice(0, 10);
    const original = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const item = record({
      company_name: "Old Announcement",
      company_domain: "old-announcement.test",
      announced_date: recent,
      date_basis: "page",
      sources: [{ url: "https://old-announcement.test/news/round", host: "old-announcement.test", title: "Old Announcement financing" }],
    });
    await persistRecords(handle, [item], "series-a-b", "audit:late");
    expect((await listRounds(handle, { ids: [item.id], includeReview: true })).rows[0].disposition).toBe("review");
    await handle
      .update(schema.fundingRounds)
      .set({ announcedOn: original, dateBasis: "stated", freshnessCheckedOn: original })
      .where(eq(schema.fundingRounds.id, item.id));
    await promoteCheckedRound(handle, item.id, [], {});
    const [stored] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, item.id));
    expect(stored.history).toBe(true);
    expect(stored.announcedOn).toBe(original);
    expect(stored.disposition).toBe("review");
  });
});

describe("a page's day far before the round's own release is not an earlier report", () => {
  const stuut = (partial: Parameters<typeof record>[0]) =>
    record({
      company_key: "stuut",
      company_domain: "stuut.ai",
      stage: "series_b",
      stage_as_written: "Series B",
      lead_investors: ["Insight Partners"],
      ...partial,
    });
  const RELEASE = "https://www.globenewswire.com/news-release/2026/10/07/3376511/0/en/ai-order-to-cash-platform-stuut-raises-52-5m";
  // An older company post whose banner names the round, dated by the post's own metadata.
  const blog = stuut({
    company_name: "Stuut",
    announced_date: "2026-03-11",
    date_basis: "page",
    sources: [{ url: "https://www.stuut.ai/blog/the-dark-side-of-ar-automation", host: "stuut.ai", published: "2026-03-11" }],
  });
  const wire = stuut({
    company_name: "Stuut",
    announced_date: "2026-10-07",
    date_basis: "page",
    sources: [{ url: RELEASE, host: "globenewswire.com", evidence: "the company is announcing a $52.5 million Series B" }],
  });

  test("releaseDay: a wire's copy, or the company or an established outlet calling the round today's news", () => {
    expect(releaseDay(wire.sources, "stuut.ai")).toBe("2026-10-07");
    const arceus = [
      {
        url: "https://siliconangle.com/2026/10/01/ai-driven-law-firm-arceus-legal-raises-17m",
        evidence: "Arceus Legal today disclosed that it has raised $17 million in funding.",
      },
      {
        url: "https://www.businessinsider.com/ai-native-law-firm-arceus-series-a",
        published: "2026-06-18",
        evidence: "Arceus raised $17 million.",
      },
    ];
    expect(releaseDay(arceus, "arceus.legal")).toBe("2026-10-01");
    expect(releaseDay(arceus.slice(1), "arceus.legal")).toBeNull();
  });

  test("Stuut: the March post's day yields to the October release; a stated earlier day stands", () => {
    const release = releaseDay(wire.sources, "stuut.ai");
    expect(earliestReport([wire, blog], "stuut.ai")).toBe("2026-03-11");
    expect(earliestReport([wire, blog], "stuut.ai", [], {}, release)).toBe("2026-10-07");
    expect(earliestReport([wire, { ...blog, date_basis: "stated" }], "stuut.ai", [], {}, release)).toBe("2026-03-11");
    // Coverage a few days ahead of the release is still the earliest report.
    expect(earliestReport([wire, { ...blog, announced_date: "2026-10-05" }], "stuut.ai", [], {}, release)).toBe("2026-10-05");
  });

  test("beforeEverySource: two days or more before every dated page of the round", () => {
    const pages = [
      { url: "https://www.prnewswire.com/news-releases/konst-raises-30m-series-b-302903455.html", published: "2026-10-09" },
      { url: "https://www.kosmo.com.my/2026/10/09/konst-raises-30m-series-b" },
    ];
    expect(beforeEverySource("2026-10-06", pages)).toBe(true);
    expect(beforeEverySource("2026-10-07", pages)).toBe(true);
    expect(beforeEverySource("2026-10-08", pages)).toBe(false);
    expect(beforeEverySource("2026-10-06", [...pages, { url: "https://konst.ai/news/series-b", published: "2026-10-06" }])).toBe(false);
    expect(beforeEverySource("2026-10-06", [{ url: "https://example.test/undated" }])).toBe(false);
  });

  test("KONST: a day no page states, three days before every page of the round, is not an earlier report", () => {
    const wire = record({
      company_name: "KONST",
      announced_date: "2026-10-09",
      date_basis: "page",
      sources: [
        {
          url: "https://www.prnewswire.com/news-releases/konst-raises-30m-series-b-302903455.html",
          host: "prnewswire.com",
          published: "2026-10-09",
        },
      ],
    });
    const republished = record({
      company_name: "KONST",
      announced_date: "2026-10-06",
      date_basis: "page",
      sources: [
        { url: "https://www.citybiz.co/article/917050/konst-raises-30-million-series-b", host: "citybiz.co", published: "2026-10-09" },
      ],
    });
    const tiers = { "citybiz.co": 0.7 };
    const pages = [...wire.sources, ...republished.sources];
    expect(earliestReport([wire, republished], null, [], tiers, null, pages)).toBe("2026-10-09");
    // A page that states the day still dates the round, and so does a page published that day.
    expect(earliestReport([wire, { ...republished, date_basis: "stated" }], null, [], tiers, null, pages)).toBe("2026-10-06");
    const datedThatDay = [...wire.sources, { ...republished.sources[0], published: "2026-10-06" }];
    expect(earliestReport([wire, republished], null, [], tiers, null, datedThatDay)).toBe("2026-10-06");
  });

  test("a later reading's unstated day three days before every page does not move a stored day earlier", async () => {
    const handle = await testDb();
    const konst = (partial: Parameters<typeof record>[0]) =>
      record({
        company_key: "konst",
        company_domain: "konst.ai",
        stage: "series_b",
        stage_as_written: "Series B",
        amount: { value: 30, currency: "USD", as_written: "$30 million", usd_millions: 30, fx_rate: null, fx_date: null },
        lead_investors: ["ADATA Technology"],
        ...partial,
      });
    const wire = konst({
      company_name: "KONST",
      announced_date: "2026-10-09",
      date_basis: "page",
      sources: [
        {
          url: "https://www.prnewswire.com/news-releases/konst-raises-30m-series-b-302903455.html",
          host: "prnewswire.com",
          published: "2026-10-09",
        },
      ],
    });
    await persistRecords(handle, [wire], "series-a-b", "audit:konst");
    const republished = konst({
      company_name: "KONST",
      announced_date: "2026-10-06",
      date_basis: "page",
      sources: [
        { url: "https://www.citybiz.co/article/917050/konst-raises-30-million-series-b", host: "citybiz.co", published: "2026-10-09" },
      ],
    });
    await persistRecords(handle, [republished], "series-a-b", "audit:konst");
    const rows = await handle.select().from(schema.fundingRounds);
    expect(rows).toHaveLength(1);
    expect(rows[0].announcedOn).toBe("2026-10-09");
  });

  test("Pro Shop: a page whose URL dates it Oct 5 does not lend the May 10 its metadata read", () => {
    const sbj = record({
      company_name: "Pro Shop",
      announced_date: "2026-05-10",
      date_basis: "page",
      sources: [
        {
          url: "https://www.sportsbusinessjournal.com/Articles/2026/10/05/pro-shops-latest-funding-round",
          host: "sportsbusinessjournal.com",
        },
      ],
    });
    expect(earliestReport([sbj], null, [], { "sportsbusinessjournal.com": 0.7 })).toBeNull();
    expect(earliestReport([{ ...sbj, announced_date: "2026-10-05" }], null, [], { "sportsbusinessjournal.com": 0.7 })).toBe("2026-10-05");
  });

  test("the repair re-dates a news round to its release and back to the feed, leaves a history-lane round, and runs once", async () => {
    const handle = await testDb();
    const today = new Date().toISOString().slice(0, 10);
    const url = `https://www.globenewswire.com/news-release/${today.replaceAll("-", "/")}/1/0/en/stuut-raises`;
    const round = stuut({
      company_name: "Stuut",
      announced_date: today,
      date_basis: "stated",
      sources: [{ url, host: "globenewswire.com", evidence: "the company is announcing a $52.5 million Series B" }],
    });
    await persistRecords(handle, [round], "series-a-b", "run-1");
    // What the earliest-report check left: the March post's day, stored as stated, and the late-report flag it set.
    await handle.update(schema.fundingRounds).set({ announcedOn: "2026-03-11" }).where(eq(schema.fundingRounds.id, round.id));
    const old = record({
      company_name: "Older",
      company_key: "older",
      announced_date: "2024-02-01",
      date_basis: "stated",
      sources: [{ url, host: "globenewswire.com", evidence: "Older, an earlier backer, also raised $20M in 2024." }],
    });
    await persistRecords(handle, [old], "series-a-b", "history:older", { history: true });
    const [before] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, round.id));
    expect(before).toMatchObject({ history: true, hold: expect.stringMatching(/^reported later:/) });
    const changes = await repairStaleReportDays(handle);
    expect(changes).toEqual([{ id: round.id, from: "2026-03-11", to: today, backToFeed: true }]);
    expect(await repairStaleReportDays(handle, true)).toEqual(changes);
    const [after] = await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, round.id));
    expect(after).toMatchObject({ announcedOn: today, history: false, hold: null });
    expect((await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, old.id)))[0].announcedOn).toBe("2024-02-01");
    expect(await repairStaleReportDays(handle, true)).toEqual([]);
  });
});
