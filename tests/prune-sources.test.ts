import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { persistRecords } from "../lib/persist";
import { auditRound, evidenceOnPage, pruneUnrelatedSources, readVerdict } from "../lib/prune-sources";
import { record, testDb } from "./helpers";

// Basecamp Research's Series C as production held it on 2026-09-23 (a subset of its seventeen links).
const RELEASE = "https://www.prnewswire.com/news-releases/basecamp-research-raises-140m-to-advance-ai-designed-therapeutics-302887617.html";
const JOB = "https://jobs.ashbyhq.com/basecamp-research/5c8e9cb3-f02c-4938-aa8b-8dd4c5fe61ca";
const FRONT = "https://techmeme.com/index.html";
const RIVER = "https://www.techmeme.com/260923/p28";
const ROUNDUP =
  "https://techstartups.com/2026/09/23/venture-capital-startup-funding-roundup-september-23-2026-accel-jpmorgan-s32-t-rowe-price-y-combinator-more";
const OTHER_ROUNDUP = "https://www.todaysstartupnews.com/news/september-13-20-2026-startup-funding-news-recap";

const basecamp = () =>
  record({
    company_name: "Basecamp Research",
    company_key: "basecamp research",
    company_domain: "basecamp-research.com",
    stage: "series_c",
    announced_date: "2026-09-23",
    amount: { value: 140, currency: "USD", as_written: "$140M", usd_millions: 140, fx_rate: 1, fx_date: "2026-09-23" },
    evidence_quotes: ["Basecamp Research raised $140M in a Series C."],
    sources: [
      { url: RELEASE, host: "prnewswire.com", title: "Basecamp Research raises $140M to advance AI-designed therapeutics" },
      { url: JOB, host: "jobs.ashbyhq.com", title: "Executive Assistant and Office Manager" },
      { url: FRONT, host: "techmeme.com", title: "Techmeme" },
      {
        url: RIVER,
        host: "techmeme.com",
        title: "Coachella promoter Goldenvoice renews its livestreaming partnership with YouTube through 2030",
      },
      { url: ROUNDUP, host: "techstartups.com", title: "Venture Capital & Startup Funding Roundup, September 23, 2026" },
      { url: OTHER_ROUNDUP, host: "todaysstartupnews.com", title: "September 13 to 20, 2026: Crusoe's $30.9 Billion Valuation Leads" },
    ],
  });

const PAGES: Record<string, string | null> = {
  [ROUNDUP]:
    "# Roundup\n\n**Basecamp Research** raised [$140 million](https://x.example) in a Series C led by Singular. Snorkel AI raised $350M.",
  // A full page (a teaser is too short to show the company is absent).
  [OTHER_ROUNDUP]: "Crusoe raised $1.4B. Temporal raised $300M in a Series D. ".repeat(40),
};

describe("evidenceOnPage", () => {
  test("a sentence that names the company and a figure; a bare mention does not count", () => {
    const company = { name: "Basecamp Research", domain: "basecamp-research.com", aliases: [] };
    expect(evidenceOnPage(PAGES[ROUNDUP] as string, company)).toBe("Basecamp Research raised $140 million in a Series C led by Singular.");
    expect(evidenceOnPage("Related: Basecamp Research profile\nSnorkel AI raised $350M.", company)).toBeNull();
  });

  test("a roundup entry: the company as a heading, its figure on the lines under it (Moneycontrol's weekly roundup)", () => {
    const page =
      "**Minimac Systems**\n\n**Funding:** Rs 30 crore, pre-Series A\n\n**Medulance**\n\n**Funding:** Rs 24 crore, Series A2\n\n**Key investors:** Auxano Capital";
    expect(evidenceOnPage(page, { name: "Medulance", domain: null, aliases: [] })).toBe("Medulance: Funding: Rs 24 crore, Series A2");
  });
});

describe("readVerdict", () => {
  const corma = { name: "Corma", domain: null, aliases: [] };
  const filler = "Unrelated reporting about the markets and the weather. ".repeat(40);
  test("only a full page in the Latin script that never names the company lets a link go", () => {
    expect(readVerdict(filler, corma)).toEqual({ detach: true });
    expect(readVerdict(null, corma)).toEqual({ unverified: "unread" });
    expect(readVerdict("Subscribe to read.", corma)).toEqual({ unverified: "too_short" });
    // Wrtn's release on a Japanese wire names it リートンテクノロジーズ.
    expect(
      readVerdict(`${"リートンテクノロジーズ、シリーズCラウンドで総額を調達".repeat(80)} ${filler.slice(0, 400)}`, {
        name: "Wrtn Technologies",
        domain: null,
        aliases: [],
      }),
    ).toEqual({
      unverified: "other_script",
    });
    // An interview with the CEO names the company and no figure: about the company, maybe not the round.
    expect(readVerdict(`Corma CEO Alon Pluda says the startup aims to close the defense gap. ${filler}`, corma)).toEqual({
      unverified: "named_without_figure",
    });
  });
});

describe("auditRound", () => {
  const round = (links: Array<{ url: string; title: string | null; claims?: Record<string, unknown> }>) => ({
    roundId: "r",
    company: { name: "Basecamp Research", domain: "basecamp-research.com", aliases: [] },
    amountValue: 140,
    amountCurrency: "USD",
    disposition: "publish",
    links: links.map((l) => ({ sourceId: l.url, url: l.url, title: l.title, claims: l.claims ?? null })),
  });

  test("without a reader, a page nothing stored ties to the company is unverified, never detached", async () => {
    const a = await auditRound(
      round([
        { url: RELEASE, title: "Basecamp Research raises $140M" },
        { url: ROUNDUP, title: "Funding Roundup" },
      ]),
    );
    expect(a.detach).toEqual([]);
    expect(a.unverified.map((u) => u.url)).toEqual([ROUNDUP]);
  });

  test("the evidence a link recorded when it was attached keeps it without a read", async () => {
    const a = await auditRound(
      round([
        { url: ROUNDUP, title: "Funding Roundup", claims: { evidence: "Basecamp Research raised $140M.", title: "Funding Roundup" } },
      ]),
      async () => {
        throw new Error("no read expected");
      },
    );
    expect(a).toMatchObject({ detach: [], held: [], unverified: [], evidenced: [] });
  });

  test("a page read too short to judge (a paywall's teaser) leaves the link unverified", async () => {
    const a = await auditRound(
      round([
        { url: RELEASE, title: "Basecamp Research raises $140M" },
        { url: ROUNDUP, title: "Funding Roundup" },
      ]),
      async () => "Subscribe to read this week's deals.",
    );
    expect(a.detach).toEqual([]);
    expect(a.unverified.map((u) => u.url)).toEqual([ROUNDUP]);
  });

  test("a round whose every source would go keeps them all and is held", async () => {
    const a = await auditRound(round([{ url: JOB, title: "Executive Assistant and Office Manager" }]));
    expect(a.detach).toEqual([]);
    expect(a.held).toEqual([expect.objectContaining({ url: JOB, reason: "job_posting" })]);
  });
});

describe("pruneUnrelatedSources", () => {
  test("dry run lists each link and reason and writes nothing; apply detaches, records the roundup's sentence, and is idempotent", async () => {
    const handle = await testDb();
    await persistRecords(handle, [basecamp()], "growth", "run-1");
    const reads: string[] = [];
    const readPage = async (url: string) => {
      reads.push(url);
      return PAGES[url] ?? null;
    };

    const dry = await pruneUnrelatedSources(handle, { readPage });
    expect(dry.audits).toHaveLength(1);
    const [audit] = dry.audits;
    expect(Object.fromEntries(audit.detach.map((d) => [d.url, d.reason]))).toEqual({
      [JOB]: "job_posting",
      [FRONT]: "not_article",
      [RIVER]: "aggregator",
      [OTHER_ROUNDUP]: "page_never_names_company",
    });
    expect(audit.evidenced.map((e) => e.url)).toEqual([ROUNDUP]);
    expect(dry.orphans).toBe(4);
    expect(await handle.select().from(schema.roundSources)).toHaveLength(6);

    const applied = await pruneUnrelatedSources(handle, { apply: true, readPage });
    expect(applied.orphans).toBe(4);
    const links = await handle.select().from(schema.roundSources);
    expect(links.map((l) => l.sourceId).sort()).toEqual([RELEASE, ROUNDUP].sort());
    const [roundup] = await handle.select().from(schema.roundSources).where(eq(schema.roundSources.sourceId, ROUNDUP));
    expect(roundup.fieldClaims).toEqual({
      evidence: "Basecamp Research raised $140 million in a Series C led by Singular.",
      title: "Venture Capital & Startup Funding Roundup, September 23, 2026",
    });
    expect(await handle.select().from(schema.sources).where(eq(schema.sources.id, JOB))).toEqual([]);

    reads.length = 0;
    const again = await pruneUnrelatedSources(handle, { apply: true, readPage });
    expect(again.audits).toEqual([]);
    expect(reads).toEqual([]);
  });

  test("a source another round still links stays as a row when one round lets go of it", async () => {
    const handle = await testDb();
    await persistRecords(
      handle,
      [
        record({
          company_name: "Acme",
          sources: [
            { url: FRONT, host: "techmeme.com", title: "Techmeme" },
            { url: "https://news.example/acme-raises", host: "news.example", title: "Acme raises $20M" },
          ],
        }),
        record({
          company_name: "Techmeme Co",
          company_key: "techmeme co",
          sources: [{ url: FRONT, host: "techmeme.com", title: "Techmeme" }],
        }),
      ],
      "series-a-b",
      "run-1",
    );
    const r = await pruneUnrelatedSources(handle, { apply: true });
    // Techmeme Co's only source is the front page: held, so the row stays for that link.
    expect(r.audits.find((a) => a.company === "Techmeme Co")?.held).toHaveLength(1);
    expect(r.orphans).toBe(0);
    expect(await handle.select().from(schema.sources).where(eq(schema.sources.id, FRONT))).toHaveLength(1);
  });
});
