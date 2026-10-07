// A round's record as a reader or an agent gets it: sources in reading order with the official
// announcement first, the company's earlier rounds, a withheld valuation told apart from an unknown
// one, investors under their full names, and the company's own one-line description. Firecrawl's own
// record (2026-10-07) is the case each rule came from.

import { siteOneLiner, thinDescription } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { fullerInvestorName, fullerNameIn } from "../lib/investor-names";
import { listRounds, persistRecords, renameCompany } from "../lib/persist";
import { confirmsRound, needsPrimarySource } from "../lib/primary-source";
import { applyRepair, planRepair, repairRows } from "../lib/round-record-repair";
import { orderSources, primarySourceOf, sourceKind } from "../lib/source-order";
import { statesValuationUndisclosed, undisclosedSentence, valuationDisclosed } from "../lib/valuation-disclosure";
import { record, testDb } from "./helpers";

describe("source order", () => {
  const src = (url: string, published: string | null = null) => ({ url, published });

  test("the company's own page, then a wire's release, then established outlets, then the rest", () => {
    const sources = [
      src("https://en.wowtale.net/2026/09/23/235198"),
      src("https://www.pr.com/press-release/979737"),
      src("https://siliconangle.com/2026/09/22/web-scraping-startup-firecrawl-closes-75m-investment"),
      src("https://alleywatch.com/2026/09/report"),
      src("https://www.firecrawl.dev/blog/introducing-alexandria-series-b"),
    ];
    expect(orderSources(sources, ["firecrawl.dev"]).map((s) => new URL(s.url).hostname)).toEqual([
      "www.firecrawl.dev",
      "www.pr.com",
      "siliconangle.com",
      "alleywatch.com",
      "en.wowtale.net",
    ]);
    expect(primarySourceOf(sources, ["firecrawl.dev"])).toEqual({
      url: "https://www.firecrawl.dev/blog/introducing-alexandria-series-b",
      kind: "company",
    });
    expect(primarySourceOf(sources.slice(0, 4), ["firecrawl.dev"])).toEqual({
      url: "https://www.pr.com/press-release/979737",
      kind: "wire",
    });
    expect(primarySourceOf([src("https://techcrunch.com/a")], ["firecrawl.dev"])).toBeNull();
  });

  test("a domain the company is known by counts as its own; the earlier page leads within a kind", () => {
    expect(sourceKind("https://firecrawl.com/blog/x", ["firecrawl.dev", "firecrawl.com"])).toBe("company");
    const ordered = orderSources([src("https://techcrunch.com/b", "2026-09-23"), src("https://reuters.com/a", "2026-09-22")], []);
    expect(ordered.map((s) => s.url)).toEqual(["https://reuters.com/a", "https://techcrunch.com/b"]);
  });
});

describe("a withheld valuation", () => {
  test("a sentence that names the company, or one on a page about its round", () => {
    expect(statesValuationUndisclosed("Firecrawl did not disclose its valuation.", "Firecrawl")).toBe(true);
    expect(statesValuationUndisclosed("Acme raised $20M at an undisclosed valuation.", "Acme")).toBe(true);
    expect(
      statesValuationUndisclosed("The financing was led by Smash Capital. The round's valuation was not disclosed.", "Firecrawl"),
    ).toBe(false);
    expect(
      undisclosedSentence(
        "The financing was led by Smash Capital. The round's valuation was not disclosed.",
        "Firecrawl",
        "Firecrawl raises $75M to turn web crawling into an agent data library",
      ),
    ).toBe("The round's valuation was not disclosed.");
  });

  test("a sentence about another of the company's rounds does not count", () => {
    const text = "The Y Combinator alum raised a $108 million Series A in January at an undisclosed valuation.";
    expect(undisclosedSentence(text, "Corgi", "Corgi raises $160M Series B", "series_b")).toBeNull();
    expect(undisclosedSentence(text, "Corgi", "Corgi raises $108M Series A", "series_a")).not.toBeNull();
    expect(undisclosedSentence("Groq did not disclose its new valuation.", "Groq", null, "growth")).not.toBeNull();
  });

  test("a roundup's other deals, a stated valuation, and silence never count", () => {
    expect(
      statesValuationUndisclosed("The valuation was not disclosed.", "Firecrawl", "Weekly funding roundup: Firecrawl, Acme and more"),
    ).toBe(false);
    expect(statesValuationUndisclosed("Firecrawl's valuation was disclosed at $1B.", "Firecrawl")).toBe(false);
    expect(statesValuationUndisclosed("Firecrawl raised $75M.", "Firecrawl")).toBe(false);
    expect(valuationDisclosed("$1B", [], "Firecrawl")).toBe(true);
    expect(valuationDisclosed(null, ["Firecrawl declined to disclose its valuation."], "Firecrawl")).toBe(false);
    expect(valuationDisclosed(null, ["Firecrawl raised $75M."], "Firecrawl")).toBeNull();
  });
});

describe("investor names", () => {
  test("only vehicle words added, only the same investor, and only when its own domain spells the fuller name", () => {
    expect(fullerInvestorName("Nexus", "Nexus Venture Partners", "nexusvp.com")).toBe("Nexus Venture Partners");
    expect(fullerInvestorName("Uncork", "Uncork Capital", "uncorkcapital.com")).toBe("Uncork Capital");
    expect(fullerInvestorName("Salesforce", "Salesforce Ventures", "salesforceventures.com")).toBe("Salesforce Ventures");
    // The short name is the firm's own domain: the fuller one is another firm (a venture arm, a sibling fund).
    expect(fullerInvestorName("Google", "Google Ventures", "google.com")).toBeNull();
    expect(fullerInvestorName("Bain Capital", "Bain Capital Ventures", "baincapital.com")).toBeNull();
    expect(fullerInvestorName("Nvidia", "Nvidia Ventures", "nvidia.com")).toBeNull();
    // A domain that spells neither, or none at all, changes nothing.
    expect(fullerInvestorName("Freestyle", "Freestyle Capital", "freestyle.vc")).toBeNull();
    expect(fullerInvestorName("Nexus", "Nexus Venture Partners", null)).toBeNull();
    expect(fullerInvestorName("Nexus", "Nexus VP", "nexusvp.com")).toBeNull();
    expect(fullerInvestorName("Sequoia Capital", "Sequoia Capital China", "sequoiacap.com")).toBeNull();
    expect(fullerInvestorName("Accel", "Accelerate Partners", "acceleratepartners.com")).toBeNull();
  });

  test("a round's text must settle on one confirmed spelling that ends the name", () => {
    expect(fullerNameIn("Nexus", ["with Altos, Nexus Venture Partners, Y Combinator"], "nexusvp.com")).toBe("Nexus Venture Partners");
    expect(fullerNameIn("Nexus", ["Nexus Venture Partners led", "Nexus Ventures joined"], "nexusvp.com")).toBe("Nexus Venture Partners");
    expect(fullerNameIn("Nexus", ["Nexus led the round"], "nexusvp.com")).toBeNull();
    expect(fullerNameIn("China Merchants", ["China Merchants Venture Capital Fund"], "cmvc.com")).toBeNull();
    expect(fullerNameIn("J.P. Morgan", ["J.P. Morgan Investment Management led"], "jpmorgan.com")).toBeNull();
  });
});

describe("the company's own line", () => {
  test("a meta sentence that names the company, else its title beside its name; never a slogan or self-praise", () => {
    expect(
      siteOneLiner(
        { title: "Firecrawl | Web Data API for AI Agents", description: "Supercharge your AI agents with data from the web and beyond." },
        "Firecrawl",
      ),
    ).toBe("Web Data API for AI Agents");
    expect(siteOneLiner({ description: "PlannerPal automates admin tasks for financial advisers. Book a demo." }, "PlannerPal")).toBe(
      "PlannerPal automates admin tasks for financial advisers.",
    );
    expect(siteOneLiner({ description: "Your strategy deserves execution." }, "Myca")).toBeNull();
    expect(
      siteOneLiner({ description: "Ledgebrook delivers the fastest, easiest quoting experience for wholesale brokers." }, "Ledgebrook"),
    ).toBeNull();
    expect(siteOneLiner({ title: "Home | Acme" }, "Acme")).toBeNull();
  });

  test("it replaces only the press's thin appositive", () => {
    expect(thinDescription("an AI data access company")).toBe(true);
    expect(thinDescription(null)).toBe(true);
    expect(thinDescription("Sunfox Technologies sells portable ECG devices for home and professional healthcare monitoring.")).toBe(false);
    expect(thinDescription("a startup that makes agribusiness operations software")).toBe(false);
  });
});

describe("an announcement's reading confirms the round", () => {
  const row = {
    stage: "series_b" as const,
    amount: { value: 75, currency: "USD", as_written: "$75M", usd_millions: 75 },
    company: { name: "Firecrawl", domain: "firecrawl.dev" },
    announced_on: "2026-09-22",
  } as Parameters<typeof confirmsRound>[0];
  const reading = (over: Partial<ReturnType<typeof record>>) =>
    record({
      company_name: "Firecrawl",
      company_key: "firecrawl",
      stage: "series_b",
      amount: { value: 75, currency: "USD", as_written: "$75M", usd_millions: 75, fx_rate: 1, fx_date: null },
      announced_date: "2026-09-22",
      ...over,
    });

  test("company, stage, and amount", () => {
    expect(confirmsRound(row, reading({}))).toBeNull();
    expect(confirmsRound(row, reading({ stage: "series_a" }))).toMatch(/stage/);
    expect(
      confirmsRound(
        row,
        reading({ amount: { value: 14.5, currency: "USD", as_written: "$14.5M", usd_millions: 14.5, fx_rate: 1, fx_date: null } }),
      ),
    ).toMatch(/amount/);
    expect(confirmsRound(row, reading({ company_name: "Alexandria", company_key: "alexandria" }))).toMatch(/company/);
  });

  test("the company's own post, read under its product's name, when it speaks as the company within a week", () => {
    const own = reading({
      company_name: "Alexandria",
      company_key: "alexandria",
      sources: [
        {
          url: "https://www.firecrawl.dev/blog/introducing-alexandria-series-b",
          host: "firecrawl.dev",
          title: "Introducing Alexandria and our $75M Series B",
        },
      ],
      evidence_quotes: ["We raised a $75M Series B led by Smash Capital."],
    });
    expect(confirmsRound(row, own, { ownSite: true })).toBeNull();
    expect(confirmsRound(row, { ...own, announced_date: "2026-06-01" }, { ownSite: true })).toMatch(/dated/);
    const silent = {
      ...own,
      evidence_quotes: ["Alexandria raised $75M."],
      sources: [{ url: own.sources[0]?.url ?? "", host: "firecrawl.dev", title: "Alexandria" }],
    };
    expect(confirmsRound(row, silent, { ownSite: true })).toMatch(/speaks/);
  });

  test("a round with the company's own page needs nothing; a wire's release still looks for it", () => {
    const base = { disposition: "publish" as const, company: { domain: "firecrawl.dev" } } as Parameters<typeof needsPrimarySource>[0];
    expect(needsPrimarySource({ ...base, primary_source: null })).toBe(true);
    expect(needsPrimarySource({ ...base, primary_source: { url: "https://www.pr.com/x", kind: "wire" } })).toBe(true);
    expect(needsPrimarySource({ ...base, primary_source: { url: "https://www.firecrawl.dev/x", kind: "company" } })).toBe(false);
    expect(needsPrimarySource({ ...base, disposition: "review", primary_source: null })).toBe(false);
  });
});

describe("in the store", () => {
  async function firecrawl() {
    const db = await testDb();
    const seriesB = record({
      company_name: "Firecrawl",
      company_key: "firecrawl",
      company_domain: "firecrawl.dev",
      stage: "series_b",
      stage_as_written: "Series B",
      announced_date: "2026-09-22",
      amount: { value: 75, currency: "USD", as_written: "$75M", usd_millions: 75, fx_rate: 1, fx_date: "2026-09-22" },
      lead_investors: ["Smash Capital"],
      other_investors: ["Nexus"],
      evidence_quotes: ["Firecrawl raised a $75M Series B led by Smash Capital. Firecrawl did not disclose its valuation."],
      sources: [
        { url: "https://en.wowtale.net/2026/09/23/235198", host: "en.wowtale.net", title: "Firecrawl raises $75M" },
        {
          url: "https://www.firecrawl.dev/blog/introducing-alexandria-series-b",
          host: "firecrawl.dev",
          title: "Introducing Alexandria and our $75M Series B",
        },
        { url: "https://siliconangle.com/2026/09/22/firecrawl", host: "siliconangle.com", title: "Firecrawl closes $75M" },
      ],
    });
    const seriesA = record({
      company_name: "Firecrawl",
      company_key: "firecrawl",
      company_domain: "firecrawl.dev",
      stage: "series_a",
      stage_as_written: "Series A",
      announced_date: "2025-08-19",
      amount: { value: 14.5, currency: "USD", as_written: "$14.5 million", usd_millions: 14.5, fx_rate: 1, fx_date: "2025-08-19" },
      lead_investors: ["Nexus Venture Partners"],
      sources: [
        {
          url: "https://www.firecrawl.dev/blog/firecrawl-v2-series-a-announcement",
          host: "firecrawl.dev",
          title: "Firecrawl v2 and our Series A",
        },
      ],
    });
    // The firm is first seen as "Nexus"; its own site, nexusvp.com, spells the full name.
    await db.insert(schema.investors).values({ id: "nexus", name: "Nexus", domain: "nexusvp.com" });
    await persistRecords(db, [seriesB, seriesA], "series-a-b", "run-1");
    await db.update(schema.fundingRounds).set({ disposition: "publish" }).where(eq(schema.fundingRounds.id, seriesB.id));
    return { db, seriesB, seriesA };
  }

  test("sources in reading order, the official announcement, a withheld valuation, and a fuller investor name", async () => {
    const { db, seriesB } = await firecrawl();
    const [row] = (await listRounds(db, { ids: [seriesB.id], includeReview: true })).rows;
    expect(row?.sources.map((s) => s.host)).toEqual(["firecrawl.dev", "siliconangle.com", "en.wowtale.net"]);
    expect(row?.primary_source).toEqual({ url: "https://www.firecrawl.dev/blog/introducing-alexandria-series-b", kind: "company" });
    expect(row?.valuation_disclosed).toBe(false);
    // The Series A spelled Nexus out: the one investor row shows the full name on both rounds.
    expect(row?.other_investors).toEqual(["Nexus Venture Partners"]);
  });

  test("earlier rounds: visible ones, history included, never one in review", async () => {
    const { db, seriesA, seriesB } = await firecrawl();
    await db.update(schema.fundingRounds).set({ disposition: "review", history: true }).where(eq(schema.fundingRounds.id, seriesA.id));
    const read = async () => (await listRounds(db, { ids: [seriesB.id], includeReview: true })).rows[0]?.previous_rounds;
    expect(await read()).toEqual([]);
    await db.update(schema.fundingRounds).set({ disposition: "publish" }).where(eq(schema.fundingRounds.id, seriesA.id));
    expect(await read()).toEqual([
      {
        id: seriesA.id,
        stage: "series_a",
        stage_as_written: "Series A",
        amount: { as_written: "$14.5 million", usd_millions: 14.5 },
        announced_on: "2025-08-19",
        lead_investors: ["Nexus Venture Partners"],
        url: "https://www.firecrawl.dev/blog/firecrawl-v2-series-a-announcement",
      },
    ]);
  });

  test("the repair lifts a namesake hold the company's own site settled, when nothing else holds it", async () => {
    const { db, seriesA } = await firecrawl();
    const hold = "held for review: same-name company identity is unverified";
    await db
      .update(schema.fundingRounds)
      .set({
        disposition: "review",
        history: true,
        confidence: "0.9",
        verification: { status: "corrected", notes: ["The release states $14.5 million.", hold], url: null },
      })
      .where(eq(schema.fundingRounds.id, seriesA.id));
    const plan = await planRepair(db, await repairRows(db, {}));
    expect(plan.holds).toEqual([
      {
        roundId: seriesA.id,
        company: "Firecrawl",
        ownPage: "https://www.firecrawl.dev/blog/firecrawl-v2-series-a-announcement",
        to: "publish",
      },
    ]);
    await applyRepair(db, plan);
    const [after] = await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, seriesA.id));
    expect(after?.disposition).toBe("publish");
    expect((after?.verification as { notes: string[] } | undefined)?.notes).toEqual(["The release states $14.5 million."]);
    expect((await planRepair(db, await repairRows(db, {}))).holds).toEqual([]);
  });

  test("a rename keeps a passed audit's fingerprint, so the publication gate lets the round stand", async () => {
    const { db, seriesB } = await firecrawl();
    await db.execute(sql`insert into settings (key, value) values ('publication_audit', 'true'::jsonb)`);
    await db
      .update(schema.fundingRounds)
      .set({ audit: { status: "pass" }, disposition: "publish" })
      .where(eq(schema.fundingRounds.id, seriesB.id));
    const [stamped] = await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, seriesB.id));
    expect(stamped?.disposition).toBe("publish");
    expect(await renameCompany(db, "firecrawl.dev", "firecrawl")).toBe(true);
    const [after] = await db.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.id, seriesB.id));
    expect(after).toMatchObject({ companyId: "firecrawl", disposition: "publish", pendingDisposition: null });
    expect(after?.auditFacts).not.toBe(stamped?.auditFacts);
  });
});
