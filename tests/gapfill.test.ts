import { DEFAULT_TIERS, type GapFill } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { applyFill, applyGapFill, gapFillToFill, toGapFillInput } from "../lib/gapfill.ts";
import { listRounds, persistRecords } from "../lib/persist.ts";
import { record, testDb } from "./helpers.ts";

const fill = (partial: Partial<GapFill> = {}): GapFill => ({
  announced_date: null,
  amount_as_written: null,
  lead_investors: [],
  other_investors: [],
  company_website: null,
  headquarters: null,
  sector: null,
  evidence_quote: null,
  source_url: null,
  is_rumor: false,
  not_found: false,
  ...partial,
});

async function seedGap(handle: Awaited<ReturnType<typeof testDb>>) {
  // Undated, no amount, no lead: the shape that lands in the queue.
  await persistRecords(
    handle,
    [
      record({
        company_name: "Gapco",
        announced_date: null,
        amount: { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null },
        lead_investors: [],
        evidence_quotes: [],
        confidence: 0.3,
      }),
    ],
    "series-a-b",
    "run-1",
  );
  const { rows } = await listRounds(handle, { includeReview: true });
  return rows[0];
}

describe("applyGapFill", () => {
  it("upgrades only an official closing with a matching amount and keeps the original report date", async () => {
    const handle = await testDb();
    await persistRecords(
      handle,
      [record({ company_name: "Signal", company_domain: "signal.ai", certainty: "expected" })],
      "series-a-b",
      "run-1",
    );
    const [row] = (await listRounds(handle, { includeReview: true })).rows;
    const later = fill({
      source_url: "https://signal.ai/news/series-a",
      evidence_quote: "Signal announced it closed a $20M Series A led by Fund One.",
      announced_date: "2026-09-04",
    });
    const result = await applyGapFill(handle, row, later, { rates: null, tiers: DEFAULT_TIERS });
    expect(result.filled).toContain("certainty");
    const [after] = (await listRounds(handle, { includeReview: true })).rows;
    expect(after.certainty).toBe("announced");
    expect(after.reported_on).toBe("2026-09-02");
    expect(after.verification?.notes).toContain("Reported before its announcement on 2026-09-02");
    expect(after.announced_on).toBe("2026-09-04");
    expect(after.first_seen_at).toBe(row.first_seen_at);
  });

  // Each case boots and migrates an independent database; give each the normal test budget.
  it.each([
    ["an unnamed-source report", "https://signal.ai/news/series-a", "Sources familiar with the matter say Signal raised $20M Series A."],
    ["a future raise", "https://signal.ai/news/series-a", "Signal is raising $20M Series A."],
    ["a mismatched figure", "https://signal.ai/news/series-a", "Signal announced it closed a $50M Series A."],
    ["a non-official page", "https://reporter.test/signal", "Signal announced it closed a $20M Series A."],
  ])("does not upgrade from %s", async (_reason, url, quote) => {
    const handle = await testDb();
    await persistRecords(
      handle,
      [record({ company_name: "Signal", company_domain: "signal.ai", certainty: "reported" })],
      "series-a-b",
      "run-1",
    );
    const [row] = (await listRounds(handle, { includeReview: true })).rows;
    await applyGapFill(handle, row, fill({ source_url: url, evidence_quote: quote }), { rates: null, tiers: DEFAULT_TIERS });
    expect((await listRounds(handle, { includeReview: true })).rows[0].certainty).toBe("reported");
  });

  it("keeps a disputed round's certainty and a person's pinned date while attaching the release", async () => {
    const handle = await testDb();
    await persistRecords(
      handle,
      [record({ company_name: "Signal", company_domain: "signal.ai", certainty: "reported" })],
      "series-a-b",
      "run-1",
    );
    const [row] = (await listRounds(handle, { includeReview: true })).rows;
    const release = fill({
      source_url: "https://signal.ai/news/series-a",
      evidence_quote: "Signal announced it closed a $20M Series A led by Fund One.",
      announced_date: "2026-09-04",
    });
    const result = await applyFill(
      handle,
      { ...row, pinned: { announced_on: "2026-09-02" } },
      { ...gapFillToFill(release), officialAnnouncementUrl: release.source_url ?? undefined },
      { rates: null, tiers: DEFAULT_TIERS, protectFacts: true },
    );
    expect(result.filled).not.toContain("certainty");
    const [after] = (await listRounds(handle, { includeReview: true })).rows;
    expect(after.certainty).toBe("reported");
    expect(after.announced_on).toBe("2026-09-02");
    expect(after.sources).toHaveLength(2);
  });
  it("fills the gaps and rescores while the unverified record stays in review", async () => {
    const handle = await testDb();
    const row = await seedGap(handle);
    const announced = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(row.disposition).toBe("review");
    expect(toGapFillInput(row).known.announced_date).toBeNull();

    const result = await applyGapFill(
      handle,
      row,
      fill({
        announced_date: announced,
        amount_as_written: "$8 million",
        lead_investors: ["Lead Capital"],
        other_investors: ["Angel One"],
        company_website: "https://gapco.com",
        headquarters: "Austin, TX",
        evidence_quote: "Gapco announced an $8 million Series A led by Lead Capital.",
        source_url: "https://gapco.com/blog/series-a",
      }),
      { rates: null, tiers: DEFAULT_TIERS },
    );

    expect(result.filled).toEqual(["date", "amount", "lead", "investors", "website", "source"]);
    expect(result.announced_on).toBe(announced);
    expect(result.confidence.after).toBeGreaterThan(result.confidence.before);
    expect(result.disposition.after).toBe("review");

    const { rows } = await listRounds(handle, { includeReview: true });
    const after = rows[0];
    expect(after.announced_on).toBe(announced);
    expect(after.amount).toMatchObject({ value: 8, currency: "USD", as_written: "$8 million", usd_millions: 8 });
    expect(after.lead_investors).toEqual(["Lead Capital"]);
    expect(after.other_investors).toEqual(["Angel One"]);
    expect(after.company.website).toBe("https://gapco.com");
    expect(after.company.domain).toBe("gapco.com");
    expect(after.company.hq).toBe("Austin, TX");
    expect(after.evidence_quotes).toHaveLength(1);
    // The company's own page leads the sources (lib/source-order.ts).
    expect(after.sources.map((s) => s.host)).toEqual(["gapco.com", "reuters.com"]);
    // A change to a row nobody has read stays new; a seen row would flip to updated.
    expect(after.status).toBe("new");
  });

  it("never overwrites a value the record already has", async () => {
    const handle = await testDb();
    await persistRecords(handle, [record({ company_name: "Known Co", confidence: 0.4, evidence_quotes: [] })], "series-a-b", "run-1");
    const [row] = (await listRounds(handle, { includeReview: true })).rows;
    const result = await applyGapFill(
      handle,
      row,
      fill({ announced_date: "2020-01-01", amount_as_written: "$999M", lead_investors: ["Someone Else"] }),
      { rates: null, tiers: DEFAULT_TIERS },
    );
    expect(result.filled).toEqual([]);
    const [after] = (await listRounds(handle, { includeReview: true })).rows;
    expect(after.announced_on).toBe("2026-09-02");
    expect(after.amount.as_written).toBe("$20M");
    expect(after.lead_investors).toEqual(["Fund One"]);
  });

  it("takes the amount the company's own release states over another page's figure (Taktile, P1-18)", async () => {
    const handle = await testDb();
    await persistRecords(
      handle,
      [
        record({
          company_name: "Taktile",
          company_domain: "taktile.com",
          company_website: "https://taktile.com",
          amount: { value: 120, currency: "USD", as_written: "$120 million", usd_millions: 120, fx_rate: 1, fx_date: null },
          confidence: 0.4,
        }),
      ],
      "series-a-b",
      "run-1",
    );
    const [row] = (await listRounds(handle, { includeReview: true })).rows;
    const quote = "NEW YORK, JUNE 22, 2026, Taktile today announced its $110 million Series C fundraise.";
    // Another page's figure never overwrites; the company's release does.
    const elsewhere = await applyGapFill(
      handle,
      row,
      fill({ amount_as_written: "$110 million", evidence_quote: quote, source_url: "https://news.example/taktile-110m" }),
      { rates: null, tiers: DEFAULT_TIERS },
    );
    expect(elsewhere.filled).not.toContain("amount");
    const own = await applyGapFill(
      handle,
      (await listRounds(handle, { includeReview: true })).rows[0],
      fill({ amount_as_written: "$110 million", evidence_quote: quote, source_url: "https://taktile.com/articles/series-c" }),
      { rates: null, tiers: DEFAULT_TIERS },
    );
    expect(own.filled).toContain("amount");
    const [after] = (await listRounds(handle, { includeReview: true })).rows;
    expect(after.amount).toMatchObject({ value: 110, as_written: "$110 million", usd_millions: 110 });
  });

  it("adds no investors to a row the cross-source read verified; its sources still land for the read-back", async () => {
    const handle = await testDb();
    // Ultraviolette: verified against four sources, then corroboration read a page listing the company's existing backers.
    await persistRecords(
      handle,
      [
        record({
          company_name: "Ultraviolette",
          lead_investors: ["Yali Capital", "TDK Ventures"],
          other_investors: ["Lip-Bu Tan"],
          verification: { status: "confirmed", notes: [], url: null, verifier: "gateway:openai/gpt-6-luna", sources_seen: 1 },
        }),
      ],
      "growth",
      "run-1",
    );
    const [row] = (await listRounds(handle, { includeReview: true })).rows;
    const result = await applyFill(
      handle,
      row,
      {
        announced_date: null,
        amount_as_written: null,
        lead_investors: [],
        other_investors: ["Lingotto", "Qualcomm Ventures", "Zoho Corporation"],
        company_website: null,
        headquarters: null,
        sector: null,
        evidence_quotes: [],
        sources: [{ url: "https://entrackr.com/news/ultraviolette-raises-85-mn", title: "Ultraviolette raises $85 Mn" }],
        query: "corroborate",
      },
      { rates: null, tiers: DEFAULT_TIERS },
    );
    expect(result.added).toEqual({ sources: 1, investors: 0 });
    const [after] = (await listRounds(handle, { includeReview: true })).rows;
    expect(after.other_investors).toEqual(["Lip-Bu Tan"]);
    expect(after.sources).toHaveLength(2);
    // The row now holds more sources than its verifier read: the next read-back picks it up.
    expect(after.sources.length).toBeGreaterThan(after.verification?.sources_seen ?? 0);
  });

  it("treats placeholder text from the agent as nothing found", async () => {
    const handle = await testDb();
    const row = await seedGap(handle);
    const r = await applyGapFill(
      handle,
      row,
      fill({
        announced_date: "Not stated",
        amount_as_written: "Undisclosed",
        lead_investors: ["N/A"],
        company_website: "none",
        headquarters: "Unknown",
      }),
      { rates: null, tiers: DEFAULT_TIERS },
    );
    expect(r.filled).toEqual([]);
    const [after] = (await listRounds(handle, { includeReview: true })).rows;
    expect(after.announced_on).toBeNull();
    expect(after.amount.as_written).toBeNull();
    expect(after.lead_investors).toEqual([]);
    expect(after.company.hq).toBeNull();
  });

  it("rejects a website on a publisher or directory host", async () => {
    const handle = await testDb();
    const row = await seedGap(handle);
    for (const site of ["https://reuters.com/gapco", "https://www.linkedin.com/company/gapco"]) {
      const r = await applyGapFill(handle, row, fill({ company_website: site }), { rates: null, tiers: DEFAULT_TIERS });
      expect(r.filled).not.toContain("website");
    }
    const [after] = (await listRounds(handle, { includeReview: true })).rows;
    expect(after.company.website).toBeNull();
  });

  it("leaves a domain another company already owns alone", async () => {
    const handle = await testDb();
    await handle.insert(schema.companies).values({ id: "other", name: "Other", nameKey: "other", domain: "gapco.com" });
    const row = await seedGap(handle);
    const r = await applyGapFill(handle, row, fill({ company_website: "https://gapco.com" }), { rates: null, tiers: DEFAULT_TIERS });
    expect(r.filled).toEqual(["website"]);
    const [me] = await handle.select().from(schema.companies).where(eq(schema.companies.id, row.company.id));
    expect(me.website).toBe("https://gapco.com");
    expect(me.domain).toBeNull();
  });

  it("does not touch a reviewer's disposition once set", async () => {
    const handle = await testDb();
    const row = await seedGap(handle);
    await handle.update(schema.fundingRounds).set({ disposition: "rejected" }).where(eq(schema.fundingRounds.id, row.id));
    const [rejected] = (await listRounds(handle, { ids: [row.id], includeReview: true })).rows;
    const r = await applyGapFill(handle, rejected, fill({ announced_date: "2026-09-01" }), { rates: null, tiers: DEFAULT_TIERS });
    expect(r.disposition).toEqual({ before: "rejected", after: "rejected" });
  });

  it("attaches only pages about the company: a job posting, a front page, and a roundup that never names it stay off", async () => {
    const handle = await testDb();
    await persistRecords(handle, [record({ company_name: "Known Co", confidence: 0.4 })], "series-a-b", "run-1");
    const [row] = (await listRounds(handle, { includeReview: true })).rows;
    const roundup = "https://techstartups.com/2026/09/02/venture-capital-startup-funding-roundup-september-2-2026";
    const result = await applyFill(
      handle,
      row,
      {
        announced_date: null,
        amount_as_written: null,
        lead_investors: [],
        other_investors: [],
        company_website: null,
        headquarters: null,
        sector: null,
        evidence_quotes: [],
        sources: [
          {
            url: "https://jobs.ashbyhq.com/known-co/5c8e9cb3",
            title: "Executive Assistant and Office Manager",
            evidence: "Known Co raised $20M.",
          },
          { url: "https://techmeme.com/index.html", title: "Techmeme" },
          { url: roundup, title: "Venture Capital & Startup Funding Roundup, September 2, 2026", evidence: "Other Co raised $5M." },
          {
            url: `${roundup}-more`,
            title: "Venture Capital & Startup Funding Roundup, part two",
            evidence: "Known Co raised a $20M Series A.",
          },
          { url: "https://entrackr.com/news/known-co-raises-20m", title: "Known Co raises $20M" },
        ],
        query: "corroborate",
      },
      { rates: null, tiers: DEFAULT_TIERS },
    );
    expect(result.refused).toEqual([
      { url: "https://jobs.ashbyhq.com/known-co/5c8e9cb3", reason: "job_posting" },
      { url: "https://techmeme.com/index.html", reason: "not_article" },
      { url: roundup, reason: "not_about_company" },
    ]);
    expect(result.added.sources).toBe(2);
    const [after] = (await listRounds(handle, { includeReview: true })).rows;
    expect(after.sources.map((s) => s.url).sort()).toEqual(
      [`${roundup}-more`, "https://entrackr.com/news/known-co-raises-20m", "https://reuters.com/acme"].sort(),
    );
    const [link] = await handle
      .select()
      .from(schema.roundSources)
      .where(eq(schema.roundSources.sourceId, `${roundup}-more`));
    expect(link.fieldClaims).toEqual({
      evidence: "Known Co raised a $20M Series A.",
      title: "Venture Capital & Startup Funding Roundup, part two",
    });
  });
});
