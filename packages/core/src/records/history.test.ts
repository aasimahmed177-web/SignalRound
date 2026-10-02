import { describe, expect, test } from "vitest";
import {
  type HistoryCompany,
  historyQuery,
  historyWindow,
  knownRound,
  leadPrior,
  matchPriorRound,
  missingLeads,
  type PriorRound,
  priorAsKnown,
  priorDateRange,
  priorKey,
  priorStage,
  promotable,
  rankHistoryCandidates,
} from "./history.ts";
import type { FeedRecord } from "./schema.ts";

const NOW = new Date("2026-09-23T12:00:00Z");

const footprint: HistoryCompany = { name: "Footprint", nameKey: "footprint", domain: "onefootprint.com" };

function prior(p: Partial<PriorRound>): PriorRound {
  return {
    stage_as_written: "Seed",
    amount_as_written: "$6 million",
    announced_date: "2022-08-03",
    lead_investors: ["Index Ventures"],
    ...p,
  };
}

function rec(p: Partial<FeedRecord>): FeedRecord {
  return {
    id: "footprint:seed:2022-08-03",
    company_key: "footprint",
    company_name: "Footprint",
    company_domain: null,
    company_website: null,
    company_description: null,
    stage: "seed",
    stage_as_written: "Seed",
    is_extension: false,
    amount: { value: 6, currency: "USD", as_written: "$6M", usd_millions: 6, fx_rate: 1, fx_date: "2022-08-03" },
    valuation_as_written: null,
    lead_investors: ["Index Ventures"],
    other_investors: [],
    announced_date: "2022-08-03",
    date_precision: "day",
    headquarters: null,
    sector: null,
    evidence_quotes: ["Footprint raised $6M."],
    sources: [{ url: "https://techcrunch.com/2022/08/03/footprint-seed", host: "techcrunch.com" }],
    confidence: 0.85,
    status: "new",
    undated: false,
    ...p,
  };
}

describe("prior round keys and labels", () => {
  test("the key is the label, amount, and date as written, normalized, so a dossier saved again queues nothing new", () => {
    expect(priorKey(prior({}))).toBe("seed|$6 million|2022-08-03");
    expect(priorKey(prior({ stage_as_written: "  SEED ", amount_as_written: "$6  million" }))).toBe("seed|$6 million|2022-08-03");
    expect(priorKey(prior({ amount_as_written: null, announced_date: null }))).toBe("seed||");
    // A rewritten amount is another key: the check dropped what it could not source, so it is looked for again.
    expect(priorKey(prior({ amount_as_written: null }))).not.toBe(priorKey(prior({})));
  });

  test("a label naming two rounds, or none, has no stage; a specific one does", () => {
    expect(priorStage(prior({ stage_as_written: "Series A" }))).toEqual({ stage: "series_a", isExtension: false });
    expect(priorStage(prior({ stage_as_written: "Seed extension" }))?.isExtension).toBe(true);
    expect(priorStage(prior({ stage_as_written: "Pre-A and Pre-A+" }))).toBeNull();
    expect(priorStage(prior({ stage_as_written: "天使轮及天使+轮 / Angel and Angel+" }))).toBeNull();
    expect(priorStage(prior({ stage_as_written: "funding round" }))).toBeNull();
  });

  test("a round too vague to recognise is not promotable: no stage, no amount, no day", () => {
    expect(promotable(prior({}))).toBe(true);
    expect(promotable(prior({ stage_as_written: "Strategic investment", amount_as_written: null, announced_date: "2025" }))).toBe(false);
    expect(promotable(prior({ stage_as_written: "funding round", amount_as_written: "$117 million", announced_date: null }))).toBe(true);
    expect(promotable(prior({ stage_as_written: "funding round", amount_as_written: null, announced_date: "2026-04-24" }))).toBe(true);
  });

  test("a dossier date is a day, a month, or a year", () => {
    expect(priorDateRange("2022-08-03")?.precision).toBe("day");
    expect(priorDateRange("2025-07")).toMatchObject({
      precision: "month",
      from: new Date("2025-07-01T00:00:00Z"),
      to: new Date("2025-07-31T00:00:00Z"),
    });
    expect(priorDateRange("2025")?.precision).toBe("year");
    expect(priorDateRange(null)).toBeNull();
  });
});

describe("the search and the pages it reads", () => {
  test("the query quotes the name, then the label, the amount, the year, and the first lead", () => {
    expect(historyQuery(footprint, prior({}))).toBe('"Footprint" Seed $6 million 2022 "Index" funding');
    expect(
      historyQuery(
        { name: "Voya Energy" },
        prior({
          stage_as_written: "Seed Round",
          amount_as_written: "$13 million",
          announced_date: "2025-07",
          lead_investors: ["Energy Impact Partners (EIP)"],
        }),
      ),
    ).toBe('"Voya Energy" Seed Round $13 million 2025 "Energy Impact"');
    // A combined label is left out rather than searched as one round.
    expect(
      historyQuery(
        { name: "Xingyun" },
        prior({ stage_as_written: "Pre-A and Pre-A+", amount_as_written: null, announced_date: "2026-04", lead_investors: [] }),
      ),
    ).toBe('"Xingyun" 2026 funding');
  });

  test("the company's own post ranks first, then wires and tier-1 press; directories and pages about others never", () => {
    const ranked = rankHistoryCandidates(
      [
        { url: "https://www.crunchbase.com/organization/footprint", title: "Footprint - Crunchbase", via: "search" },
        { url: "https://someblog.example/2022/08/other-startup-raises", title: "Other startup raises $6M", via: "search" },
        { url: "https://techcrunch.com/2022/08/03/footprint-seed-index", title: "Footprint raises $6M seed led by Index", via: "search" },
        { url: "https://www.onefootprint.com/blog/seed", title: "Announcing our seed", via: "site" },
        { url: "https://smallpaper.example/2022/footprint-funding", title: "Footprint gets funding", via: "search" },
      ],
      { company: footprint, prior: prior({}), max: 3 },
    );
    expect(ranked.map((c) => c.url)).toEqual([
      "https://www.onefootprint.com/blog/seed",
      "https://techcrunch.com/2022/08/03/footprint-seed-index",
      "https://smallpaper.example/2022/footprint-funding",
    ]);
  });

  test("a product page on the company's own site, or a page about another stage, never outranks the wire that states the round", () => {
    const seriesA = prior({ stage_as_written: "Series A", amount_as_written: "$13 million", announced_date: "2024-05-21" });
    const ranked = rankHistoryCandidates(
      [
        { url: "https://onefootprint.com/learn/series-b", title: "Footprint's Series B & The Race For Time", via: "site" },
        { url: "https://onefootprint.com/blog/vault-proxy", title: "Own the data, disown the risk - Footprint", via: "site" },
        {
          url: "https://www.businesswire.com/news/home/20240521080297/en/Footprint-Raises-%2413-Million-Series-A-led-by-QED-Investors",
          title: "Footprint Raises $13 Million Series A led by QED Investors",
          via: "search",
        },
      ],
      { company: footprint, prior: seriesA, tiers: { "businesswire.com": 1 } },
    );
    expect(ranked[0].url).toContain("businesswire.com");
    expect(ranked.at(-1)?.url).toContain("vault-proxy");
  });

  test("a page the dossier check cited is read even when its title does not name the company", () => {
    const ranked = rankHistoryCandidates([{ url: "https://news.example/2022/08/03/seed-round-report", via: "dossier" }], {
      company: footprint,
      prior: prior({}),
    });
    expect(ranked).toHaveLength(1);
  });

  test("a page is resolved inside the dossier's span with a year and a month either side, never past now", () => {
    const w = historyWindow(prior({}), NOW);
    expect(w.windowStart.toISOString().slice(0, 10)).toBe("2021-06-29");
    expect(w.windowEnd?.toISOString().slice(0, 10)).toBe("2023-09-07");
    expect(historyWindow(prior({ announced_date: "2026-04" }), NOW).windowEnd).toBeUndefined();
    expect(historyWindow(prior({ announced_date: null }), NOW).windowStart.getUTCFullYear()).toBe(2000);
  });
});

describe("matchPriorRound", () => {
  test("the same stage, amount, and day match, with the evidence named", () => {
    const m = matchPriorRound(prior({}), rec({}), footprint);
    expect(m).toMatchObject({ ok: true, evidence: ["amount", "day", "stage", "lead"] });
  });

  test("another company is refused, even with the same round", () => {
    expect(
      matchPriorRound(
        prior({}),
        rec({ company_key: "footprint labs", company_name: "Footprint Labs", company_domain: "footprintlabs.io" }),
        footprint,
      ),
    ).toEqual({
      ok: false,
      reason: "company",
    });
  });

  test("the Series B article that recalls the seed yields the Series B, which is another round", () => {
    const seriesB = rec({
      stage: "series_b",
      stage_as_written: "Series B",
      amount: { value: 40, currency: "USD", as_written: "$40M", usd_millions: 40, fx_rate: 1, fx_date: "2025-01-10" },
      announced_date: "2025-01-10",
    });
    expect(matchPriorRound(prior({}), seriesB, footprint).ok).toBe(false);
  });

  test("amounts in one currency more than a quarter apart contradict; a day far outside the span contradicts", () => {
    expect(
      matchPriorRound(
        prior({}),
        rec({ amount: { value: 12, currency: "USD", as_written: "$12M", usd_millions: 12, fx_rate: 1, fx_date: null } }),
        footprint,
      ),
    ).toEqual({
      ok: false,
      reason: "amount",
    });
    expect(matchPriorRound(prior({}), rec({ announced_date: "2024-05-21" }), footprint)).toEqual({ ok: false, reason: "date" });
  });

  test("a generic label with an amount matches on the amount alone; with nothing to agree on it is too weak", () => {
    const generic = prior({ stage_as_written: "funding round", amount_as_written: "$117 million", announced_date: "2026-04-24" });
    const r = rec({
      stage: "other",
      stage_as_written: "funding",
      amount: { value: 117, currency: "USD", as_written: "$117M", usd_millions: 117, fx_rate: 1, fx_date: null },
      announced_date: "2026-04-24",
    });
    expect(matchPriorRound(generic, r, footprint).ok).toBe(true);
    const vague = prior({ stage_as_written: "funding round", amount_as_written: null, announced_date: "2026" });
    expect(
      matchPriorRound(
        vague,
        rec({
          stage: "other",
          amount: { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null },
          announced_date: "2026-03-01",
        }),
        footprint,
      ),
    ).toEqual({ ok: false, reason: "weak" });
  });

  test("when the amount and the stage agree, a dossier month months before the announcement does not refuse it", () => {
    // Voya Energy: the dossier says 2025-07 (the close); the release announcing the $13M seed is dated November.
    const voya = { name: "Voya Energy", nameKey: "voya energy", domain: "voya.energy" };
    const p = prior({
      stage_as_written: "Seed Round",
      amount_as_written: "$13 million",
      announced_date: "2025-07",
      lead_investors: ["Energy Impact Partners (EIP)"],
    });
    const r = rec({
      company_key: "voya energy",
      company_name: "Voya Energy",
      amount: { value: 13, currency: "USD", as_written: "$13 million", usd_millions: 13, fx_rate: 1, fx_date: null },
      announced_date: "2025-11-12",
      lead_investors: ["Energy Impact Partners"],
    });
    expect(matchPriorRound(p, r, voya)).toMatchObject({ ok: true, evidence: ["amount", "stage", "lead"] });
    // With the stage alone agreeing, the same gap is another round.
    expect(matchPriorRound({ ...p, amount_as_written: null }, r, voya)).toEqual({ ok: false, reason: "date" });
  });

  test("a dossier day keeps the ordinary slack even when everything else agrees: the page recalling the close months later is refused", () => {
    // AlleyWatch in August 2022 says the $6M seed was raised "in February"; the extractor read February 2023.
    expect(matchPriorRound(prior({}), rec({ announced_date: "2023-02-01", date_precision: "month" }), footprint)).toEqual({
      ok: false,
      reason: "date",
    });
  });

  test("a page that dates nothing never matches, even on the amount: the next page is read", () => {
    // Adaptive's own post announces "$6.5 million" with no day and no label; TechCrunch dates the seed.
    const r = rec({ stage: "other", stage_as_written: "Funding", announced_date: null, date_precision: "unknown" });
    expect(matchPriorRound(prior({}), r, footprint)).toEqual({ ok: false, reason: "undated" });
    expect(matchPriorRound(prior({ announced_date: null }), r, footprint)).toEqual({ ok: false, reason: "undated" });
  });

  test("a lead alone is never enough", () => {
    const vague = prior({ stage_as_written: "funding round", amount_as_written: null, announced_date: null });
    const r = rec({
      stage: "other",
      amount: { value: null, currency: null, as_written: null, usd_millions: null, fx_rate: null, fx_date: null },
    });
    expect(matchPriorRound(vague, r, footprint)).toEqual({ ok: false, reason: "weak" });
  });

  test("debt never promotes: the dossier keeps equity rounds only", () => {
    expect(matchPriorRound(prior({}), rec({ stage: "debt" }), footprint)).toEqual({ ok: false, reason: "stage" });
  });
});

describe("Apollo leads", () => {
  const lead = (type: string, amount: string | null, date: string | null, source_url: string | null = null) => ({
    type,
    amount,
    date,
    source_url,
  });

  test("only a specific equity stage becomes a prior round; Other, unspecified venture, and debt do not", () => {
    expect(leadPrior(lead("Series B", "$35M", "2025-08", "https://fortune.com/x"))).toEqual({
      stage_as_written: "Series B",
      amount_as_written: "$35M",
      announced_date: "2025-08",
      lead_investors: [],
      source_url: "https://fortune.com/x",
    });
    expect(leadPrior(lead("Other", "$15B", "2025-11"))).toBeNull();
    expect(leadPrior(lead("Venture (Round not Specified)", "$50M", "2024-07"))).toBeNull();
    expect(leadPrior(lead("Debt Financing", "$33.8M", "2025-03"))).toBeNull();
  });

  test("a round the store holds is not a lead: the same stage near in time, or the same figure under another label", () => {
    const known = [
      { stage: "series_c" as const, usd_millions: 70, announced_on: "2026-09-03" },
      { stage: "seed" as const, usd_millions: 9.25, announced_on: "2023-06-27" },
    ];
    const out = missingLeads(
      [
        // Apollo's "Series D" for the $70M round the store files as the Series C.
        lead("Series D", "$70M", "2026-09"),
        // The same stage six months earlier at $48M is another round.
        lead("Series C", "$48M", "2026-03", "https://yourstory.com/c"),
        lead("Seed", "$9.3M", "2023-06"),
        lead("Series B", "$28M", "2024-03", "https://entrackr.com/b"),
      ],
      known,
    );
    expect(out.map((p) => `${p.stage_as_written} ${p.amount_as_written}`)).toEqual(["Series C $48M", "Series B $28M"]);
  });

  test("the provider's repeats fold to one, the one with a news link kept", () => {
    const out = missingLeads(
      [
        lead("Series A", "$13.5M", "2022-06"),
        lead("Series A", "$13.5M", "2019-06", "https://www.clay.com/blog/a"),
        lead("Seed", "$2.5M", "2018-05"),
        lead("Seed", "$2.5M", "2017-06"),
      ],
      [],
    );
    expect(out.map((p) => `${p.stage_as_written} ${p.announced_date} ${p.source_url ?? ""}`.trim())).toEqual([
      "Series A 2019-06 https://www.clay.com/blog/a",
      "Seed 2018-05",
    ]);
  });

  test("a dossier's undated prior round of the same stage counts as known", () => {
    const known = [priorAsKnown({ stage_as_written: "Series A", amount_as_written: null, announced_date: null, lead_investors: [] })];
    expect(missingLeads([lead("Series A", "$124M", "2021-05")], known)).toEqual([]);
    expect(knownRound({ stage: "seed", usd_millions: null, announced_on: "2021-05" }, known)).toBe(false);
  });
});

describe("tldraw: sibling sites, a seed extension, and app pages", () => {
  const tldraw: HistoryCompany = { name: "tldraw", nameKey: "tldraw", domain: "tldraw.com" };
  const tl = (p: Partial<FeedRecord>) => rec({ company_key: "tldraw", company_name: "tldraw", ...p });

  test("a page on tldraw.dev naming tldraw is tldraw's; another company on a same-label domain is not, nor is an unrelated domain", () => {
    const at = { announced_date: "2025-04-09", stage: "series_a" as const, stage_as_written: "Series A" };
    const a = prior({ stage_as_written: "Series A", amount_as_written: "$10M", announced_date: "2025-04", lead_investors: [] });
    const ten = { value: 10, currency: "USD", as_written: "$10M", usd_millions: 10, fx_rate: 1, fx_date: null };
    expect(matchPriorRound(a, tl({ ...at, amount: ten, company_domain: "tldraw.dev" }), tldraw).ok).toBe(true);
    expect(
      matchPriorRound(a, tl({ ...at, amount: ten, company_domain: "tldraw.dev", company_key: "tl labs", company_name: "TL Labs" }), tldraw),
    ).toEqual({
      ok: false,
      reason: "company",
    });
    expect(matchPriorRound(a, tl({ ...at, amount: ten, company_domain: "canvas.io" }), tldraw)).toEqual({ ok: false, reason: "company" });
  });

  test("a lead's bare seed and an announced seed extension of the same amount are one round; a different amount is not", () => {
    const lead = prior({ stage_as_written: "seed round", amount_as_written: "$2 million", announced_date: "2023-11", lead_investors: [] });
    const extension = tl({
      is_extension: true,
      announced_date: "2023-11-22",
      amount: { value: 2, currency: "USD", as_written: "two million dollars", usd_millions: 2, fx_rate: 1, fx_date: null },
    });
    expect(matchPriorRound(lead, extension, tldraw)).toMatchObject({ ok: true, evidence: ["amount"] });
    expect(matchPriorRound({ ...lead, amount_as_written: "$2.7M" }, extension, tldraw)).toEqual({ ok: false, reason: "amount" });
    // An extension the lead names is not a plain seed page.
    expect(
      matchPriorRound(
        { ...lead, stage_as_written: "Seed extension", amount_as_written: null },
        tl({ announced_date: "2023-11-22" }),
        tldraw,
      ),
    ).toEqual({
      ok: false,
      reason: "stage",
    });
  });

  test("app pages on the company's own site are dropped when an announcement is offered, and a funding database is read last", () => {
    const ranked = rankHistoryCandidates(
      [
        { url: "https://examples.tldraw.com/custom-shape", title: "Custom shape", via: "site" },
        { url: "https://offline.tldraw.com/manual", title: "Manual", via: "site" },
        { url: "https://trysignalbase.com/news/funding/tldraw-raises-10m", title: "tldraw raises $10M Series A", via: "search" },
        { url: "https://tldraw.dev/blog/announcing-tldraw-series-a", title: "tldraw raises $10M", via: "search" },
        { url: "https://tldraw.substack.com/p/tiny-little-seed-round", title: "Announcing tldraw's $2.7M seed", via: "search" },
      ],
      { company: tldraw, prior: prior({ stage_as_written: "Series A", amount_as_written: "$10M", announced_date: "2025-04" }) },
    );
    expect(ranked.map((c) => c.url)).toEqual([
      "https://tldraw.dev/blog/announcing-tldraw-series-a",
      "https://tldraw.substack.com/p/tiny-little-seed-round",
      "https://trysignalbase.com/news/funding/tldraw-raises-10m",
    ]);
    // With nothing better, the own pages are still read.
    expect(
      rankHistoryCandidates([{ url: "https://offline.tldraw.com/manual", title: "Manual", via: "site" }], {
        company: tldraw,
        prior: prior({}),
      }),
    ).toHaveLength(1);
  });
});
