// The dossier check against fixtures drawn from the failure modes a survey of production dossiers
// found: funders listed as customers, our own round listed again as a prior round, a total raised
// from before our round, an employee called a founder, a directory's list called competitors, a
// dossier about a namesake. No network: the pages and the model are fakes.

import { describe, expect, test } from "vitest";
import type { CompanyDossier } from "../firecrawl/deepdive.ts";
import { parseStoredDossier } from "../firecrawl/deepdive.ts";
import {
  applyDossierVerdict,
  type DossierContext,
  DossierRecheck,
  type DossierVerdict,
  DossierVerdict as DossierVerdictSchema,
  duplicatesOurRound,
  oneLinerFault,
  quoteFound,
  rankDossierSources,
  recordEvidence,
  totalBelowOurRound,
  type VerifyDossierDeps,
  verifyDossier,
} from "./dossier-verify.ts";
import { dossierVerifyProviderFor } from "./model.ts";

const ABOUT = [
  "Acme builds invoicing software for small businesses. Founded in 2021 in Berlin.",
  "Ada Example is our co-founder and CEO; she previously led payments at Big Bank.",
  "Ben Example, co-founder and CTO.",
  "Carla Example is our Head of Sales.",
  "Customers include Globex and Initech. Supported by EIT Food and Seedhouse. We partner with Stripe.",
  "Our team of 40 people works from Berlin.",
].join("\n");
const PRESS = [
  "Acme raises $30 million Series B led by Big Fund.",
  "The round brings Acme's total funding to $45 million.",
  "Acme previously raised a $10 million Series A led by First Fund in March 2024.",
  "Acme competes with Invoicely.",
].join("\n");

const dossier: CompanyDossier = {
  one_liner: "Acme builds invoicing software for small businesses.",
  founded_year: 2021,
  founders: [
    { name: "Ada Example", role: "CEO", background: "Previously led payments at Big Bank." },
    { name: "Ben Example", role: "CTO", background: "Ran a unicorn." },
    { name: "Carla Example", role: "Head of Sales", background: null },
  ],
  headcount_estimate: "40 people",
  total_raised_as_written: "$45 million",
  prior_rounds: [
    { stage_as_written: "Series A", amount_as_written: "$10 million", announced_date: "2024-03", lead_investors: ["First Fund"] },
    { stage_as_written: "Series B", amount_as_written: "$30 million", announced_date: "2026-09-01", lead_investors: ["Big Fund"] },
    { stage_as_written: "Venture debt", amount_as_written: "$5 million", announced_date: "2025", lead_investors: [] },
  ],
  customers: ["Globex", "Initech", "EIT Food", "Stripe", "Priya S."],
  investors_and_backers: ["Seedhouse", "Big Fund"],
  competitors: ["Invoicely", "Salesforce"],
  business_model: "Subscription.",
  why_it_matters: "Invoicing is a wedge. Acme owns it for SMBs.",
  sources: ["https://acme.com/about", "https://news.example/acme-series-b"],
};

const ctx: DossierContext = {
  company: {
    name: "Acme",
    domain: "acme.com",
    website: "https://acme.com",
    description: "invoicing software",
    hq: "Berlin",
    sector: "fintech",
  },
  rounds: [
    {
      stage_as_written: "Series B",
      amount_as_written: "$30 million",
      amount_value: 30,
      amount_currency: "USD",
      usd_millions: 30,
      announced_on: "2026-09-02",
      lead_investors: ["Big Fund"],
      other_investors: [],
      verified: true,
      evidence: ["Acme raises $30 million Series B led by Big Fund."],
    },
  ],
  facts: null,
  today: "2026-09-23",
};

const pages = [
  { url: "https://acme.com/about", title: "About Acme", markdown: ABOUT },
  { url: "https://news.example/acme-series-b", title: "Acme raises $30M", markdown: PRESS },
];

const ok = (source: string, quote: string) => ({
  verdict: "supported" as const,
  source,
  quote,
  confidence: "high" as const,
  reason: "stated",
});
const no = (verdict: "unsupported" | "contradicted", reason: string) => ({
  verdict,
  source: null,
  quote: null,
  confidence: "high" as const,
  reason,
});

/** A verdict that rules the way a careful reader would on the fixture above. */
function verdict(overrides: Partial<DossierVerdict> = {}): DossierVerdict {
  return {
    identity: { same_company: "yes", reason: "Same invoicing company in Berlin with our Series B." },
    one_liner: ok("S1", "Acme builds invoicing software for small businesses"),
    founded_year: ok("S1", "Founded in 2021"),
    headcount_estimate: ok("S1", "Our team of 40 people"),
    total_raised: { ...ok("S2", "brings Acme's total funding to $45 million"), includes_our_latest_round: "yes" },
    business_model: no("unsupported", "no page says how it charges"),
    why_it_matters: no("unsupported", "the ownership claim is not stated"),
    founders: [
      {
        index: 0,
        ...ok("S1", "Ada Example is our co-founder and CEO"),
        is_founder: true,
        role_supported: true,
        background_supported: true,
      },
      { index: 1, ...ok("S1", "Ben Example, co-founder and CTO"), is_founder: true, role_supported: true, background_supported: false },
      { index: 2, ...ok("S1", "Carla Example is our Head of Sales"), is_founder: false, role_supported: true, background_supported: false },
    ],
    prior_rounds: [
      {
        index: 0,
        ...ok("S2", "previously raised a $10 million Series A led by First Fund in March 2024"),
        is_equity_round: true,
        same_as_our_round: false,
        amount_supported: true,
        date_supported: true,
        leads_supported: ["First Fund"],
      },
      {
        index: 1,
        ...ok("S2", "Acme raises $30 million Series B led by Big Fund"),
        is_equity_round: true,
        same_as_our_round: true,
        amount_supported: true,
        date_supported: false,
        leads_supported: ["Big Fund"],
      },
      {
        index: 2,
        ...no("unsupported", "no page mentions debt"),
        is_equity_round: false,
        same_as_our_round: false,
        amount_supported: false,
        date_supported: false,
        leads_supported: [],
      },
    ],
    customers: [
      { index: 0, ...ok("S1", "Customers include Globex and Initech"), kind: "customer" },
      { index: 1, ...ok("S1", "Customers include Globex and Initech"), kind: "customer" },
      { index: 2, ...ok("S1", "Supported by EIT Food"), kind: "investor_or_backer" },
      { index: 3, ...ok("S1", "We partner with Stripe"), kind: "partner_or_supplier" },
      { index: 4, ...no("unsupported", "a testimonial name"), kind: "person" },
    ],
    investors_and_backers: [
      { index: 0, ...ok("S1", "Supported by EIT Food and Seedhouse") },
      { index: 1, ...ok("S2", "led by Big Fund") },
    ],
    competitors: [
      { index: 0, ...ok("S2", "Acme competes with Invoicely") },
      { index: 1, ...no("unsupported", "no page names Salesforce as a rival") },
    ],
    ...overrides,
  };
}

function evidenceMap(): Map<string, { url: string | null; text: string }> {
  return new Map([
    ["R", { url: null, text: recordEvidence(ctx) }],
    ["S1", { url: pages[0].url, text: `${pages[0].title}\n${pages[0].markdown}` }],
    ["S2", { url: pages[1].url, text: `${pages[1].title}\n${pages[1].markdown}` }],
  ]);
}

describe("applyDossierVerdict", () => {
  const applied = applyDossierVerdict(dossier, verdict(), ctx, evidenceMap());
  const reasons = (field: string) => applied.dropped.filter((d) => d.field === field);

  test("an investor or accelerator listed as a customer moves to backers; a partner and a testimonial name go", () => {
    expect(applied.dossier.customers).toEqual(["Globex", "Initech"]);
    expect(applied.dossier.investors_and_backers).toContain("EIT Food");
    expect(reasons("customers").map((d) => d.item)).toEqual(["Stripe", "Priya S."]);
    expect(reasons("customers")[0].reason).toContain("partner or supplier");
  });

  test("a funder the model calls a contradicted customer still moves to backers on its quote; without one it goes to a second reading", () => {
    const customers = verdict().customers.map((c) =>
      c.index === 2 ? { ...c, verdict: "contradicted" as const, reason: "a backer, not a customer" } : c,
    );
    const moved = applyDossierVerdict(dossier, verdict({ customers }), ctx, evidenceMap());
    expect(moved.dossier.investors_and_backers).toContain("EIT Food");
    expect(moved.dossier.customers).not.toContain("EIT Food");
    const unquoted = customers.map((c) => (c.index === 2 ? { ...c, quote: "Backed by EIT Food" } : c));
    const weak = applyDossierVerdict(dossier, verdict({ customers: unquoted }), ctx, evidenceMap());
    expect(weak.needsRecheck).toContain("customers[2]");
    expect(weak.backerIds).toContain("customers[2]");
    expect(weak.dossier.investors_and_backers).not.toContain("EIT Food");
  });

  test("our own round listed as a prior round goes, and so does debt; the earlier equity round stays", () => {
    expect(applied.dossier.prior_rounds).toEqual([
      { stage_as_written: "Series A", amount_as_written: "$10 million", announced_date: "2024-03", lead_investors: ["First Fund"] },
    ]);
    expect(reasons("prior_rounds").map((d) => d.reason)).toEqual([
      expect.stringContaining("our record has this round"),
      "not an equity round",
    ]);
  });

  test("an employee is not a founder; an unsupported background is cleared, the founder kept", () => {
    expect(applied.dossier.founders.map((f) => f.name)).toEqual(["Ada Example", "Ben Example"]);
    expect(applied.dossier.founders[1]).toEqual({ name: "Ben Example", role: "CTO", background: null });
    expect(reasons("founders")).toEqual([{ field: "founders", item: "Carla Example", reason: "not a founder by the evidence" }]);
  });

  test("a competitor no page names goes; unsupported prose goes", () => {
    expect(applied.dossier.competitors).toEqual(["Invoicely"]);
    expect(applied.dossier.business_model).toBeNull();
    expect(applied.dossier.why_it_matters).toBe("");
  });

  test("backers our rounds already name are left to the rounds", () => {
    expect(applied.dossier.investors_and_backers).not.toContain("Big Fund");
    expect(applied.dossier.investors_and_backers).toEqual(["Seedhouse", "EIT Food"]);
  });

  test("a consistent total stays, and the sources are the pages behind what was kept", () => {
    expect(applied.dossier.total_raised_as_written).toBe("$45 million");
    expect(applied.dossier.sources).toEqual(["https://acme.com/about", "https://news.example/acme-series-b"]);
    expect(applied.citations["founders[0]"]).toBe("https://acme.com/about");
    expect(applied.needsRecheck).toEqual([]);
  });

  test("it never adds: every kept list is a subset of what the dossier said", () => {
    const sub = (a: string[], b: string[]) => a.every((x) => b.includes(x));
    expect(sub(applied.dossier.customers, dossier.customers)).toBe(true);
    expect(sub(applied.dossier.competitors, dossier.competitors)).toBe(true);
    expect(sub(applied.dossier.investors_and_backers, [...dossier.investors_and_backers, ...dossier.customers])).toBe(true);
    expect(
      sub(
        applied.dossier.founders.map((f) => f.name),
        dossier.founders.map((f) => f.name),
      ),
    ).toBe(true);
  });

  test("a total from before our round goes, whether the model says so or the arithmetic does", () => {
    const stale = applyDossierVerdict(
      { ...dossier, total_raised_as_written: "$45 million" },
      verdict({ total_raised: { ...ok("S2", "brings Acme's total funding to $45 million"), includes_our_latest_round: "no" } }),
      ctx,
      evidenceMap(),
    );
    expect(stale.dossier.total_raised_as_written).toBeNull();
    expect(stale.dropped.find((d) => d.field === "total_raised_as_written")?.reason).toBe("predates our Series B round");
    const below = applyDossierVerdict({ ...dossier, total_raised_as_written: "$16.2M" }, verdict(), ctx, evidenceMap());
    expect(below.dossier.total_raised_as_written).toBeNull();
    expect(below.dropped.find((d) => d.field === "total_raised_as_written")?.reason).toBe("below our Series B round alone");
  });

  test("a stale or contradicted figure goes", () => {
    const r = applyDossierVerdict(
      dossier,
      verdict({ headcount_estimate: no("contradicted", "a newer page says 120") }),
      ctx,
      evidenceMap(),
    );
    expect(r.dossier.headcount_estimate).toBeNull();
    expect(r.dropped.find((d) => d.field === "headcount_estimate")?.reason).toContain("contradicted");
  });

  test("a quote not found in the page it cites, or low confidence, goes to a second reading; a quoted yes keeps it, anything else drops it", () => {
    const shaky = verdict({
      competitors: [
        { index: 0, verdict: "supported", source: "S2", quote: "Acme is the leader against Invoicely", confidence: "high", reason: "x" },
        { index: 1, verdict: "supported", source: "S2", quote: "Acme competes with Invoicely", confidence: "low", reason: "directory" },
      ],
    });
    const first = applyDossierVerdict(dossier, shaky, ctx, evidenceMap());
    expect(first.needsRecheck).toEqual(["competitors[0]", "competitors[1]"]);
    const second = applyDossierVerdict(
      dossier,
      shaky,
      ctx,
      evidenceMap(),
      new Map([
        ["competitors[0]", { verdict: "supported", source: "S2", quote: "Acme competes with Invoicely" }],
        ["competitors[1]", { verdict: "supported", source: "S2", quote: "Salesforce is the market leader" }],
      ]),
    );
    expect(second.dossier.competitors).toEqual(["Invoicely"]);
    expect(second.dropped.find((d) => d.item === "Salesforce")?.reason).toBe("not confirmed on a second reading");
  });

  test("a claim the model skipped is not checked, so it goes", () => {
    const r = applyDossierVerdict(dossier, verdict({ competitors: [] }), ctx, evidenceMap());
    expect(r.dossier.competitors).toEqual([]);
    expect(r.dropped.filter((d) => d.field === "competitors").map((d) => d.reason)).toEqual(["not checked", "not checked"]);
  });
});

describe("a prior round the pages were silent on is still a lead", () => {
  test("dropped as unsupported, it keeps the round whole for the history pass; dropped as debt or as ours, it does not", () => {
    const silent = verdict({
      prior_rounds: [
        {
          index: 0,
          ...no("unsupported", "no page read states the Series A"),
          is_equity_round: true,
          same_as_our_round: false,
          amount_supported: false,
          date_supported: false,
          leads_supported: [],
        },
        ...verdict().prior_rounds.slice(1),
      ],
    });
    const applied = applyDossierVerdict(dossier, silent, ctx, evidenceMap());
    const drops = applied.dropped.filter((d) => d.field === "prior_rounds");
    expect(drops.find((d) => d.item?.startsWith("Series A"))?.prior).toEqual(dossier.prior_rounds[0]);
    expect(drops.find((d) => d.item?.startsWith("Series B"))?.prior).toBeUndefined();
    expect(drops.find((d) => d.item?.startsWith("Venture debt"))?.prior).toBeUndefined();
  });
});

describe("our record wins", () => {
  test("a prior round is ours when the stage matches inside four months, or the amount matches", () => {
    const ours = ctx.rounds;
    expect(
      duplicatesOurRound({ stage_as_written: "Series B", amount_as_written: null, announced_date: "2026-08-11", lead_investors: [] }, ours),
    ).not.toBeNull();
    expect(
      duplicatesOurRound(
        { stage_as_written: "Series B", amount_as_written: "$31M", announced_date: "2026-03-12", lead_investors: [] },
        ours,
      ),
    ).not.toBeNull();
    expect(
      duplicatesOurRound({ stage_as_written: "Series A", amount_as_written: "$10M", announced_date: "2024-03", lead_investors: [] }, ours),
    ).toBeNull();
  });

  test("a total below our biggest round in its currency cannot be the total", () => {
    expect(totalBelowOurRound("$16.2M", ctx.rounds)?.stage_as_written).toBe("Series B");
    expect(totalBelowOurRound("$45 million", ctx.rounds)).toBeNull();
    expect(totalBelowOurRound("€20 million", ctx.rounds)).toBeNull();
  });
});

describe("quoteFound", () => {
  test("ignores case, punctuation, markdown, and accents; a few characters prove nothing", () => {
    expect(quoteFound("co-founder and CEO", "**Ada Example** is our Co‑Founder & CEO")).toBe(false);
    expect(quoteFound("our co founder and ceo", "Ada Example is our **co-founder and CEO**.")).toBe(true);
    expect(quoteFound("Gründer", "Tim Paulke, CEO / Grunder")).toBe(true);
    expect(quoteFound("CEO", "CEO")).toBe(false);
    expect(quoteFound(null, "anything")).toBe(false);
  });

  test("a link reads as its text: OpenAI's founders are quoted from an article whose names are links", () => {
    const page =
      'Co-chaired by [Sam Altman](https://observer.com/person/sam-altman/ "Sam Altman") and [Elon Musk](https://observer.com/person/elon-musk/ "Elon Musk"), it counted ...\n' +
      'Before co-founding OpenAI, [Greg Brockman](https://observer.com/person/greg-brockman/ "Greg Brockman") was the chief technology officer of the fintech company [Stripe](https://observer.com/company/stripe/ "Stripe").\n' +
      "![Two men](https://observer.com/a.jpeg?quality=80&w=970)He was introduced to fellow co-founders Altman, Sutskever, Schulman and Karpathy at a get-together in Napa.";
    expect(quoteFound("Co-chaired by Sam Altman and Elon Musk", page)).toBe(true);
    expect(
      quoteFound("Before co-founding OpenAI, Greg Brockman was the chief technology officer of the fintech company Stripe", page),
    ).toBe(true);
    // The model may copy the link too; it still reads as the sentence.
    expect(
      quoteFound('Before co-founding OpenAI, [Greg Brockman](https://observer.com/person/greg-brockman/ "Greg Brockman") was', page),
    ).toBe(true);
    expect(quoteFound("Co-chaired by Sam Altman and Greg Brockman", page)).toBe(false);
  });

  test("an ellipsis joins pieces found in order, each of real length", () => {
    const page = "He was introduced to fellow co-founders Altman, Sutskever, Schulman and Karpathy at a get-together in Napa.";
    expect(quoteFound("fellow co-founders Altman, Sutskever ... Karpathy", page)).toBe(true);
    expect(quoteFound("fellow co-founders Altman… and Karpathy at a get-together", page)).toBe(true);
    expect(quoteFound("Karpathy ... fellow co-founders Altman", page)).toBe(false);
    expect(quoteFound("fellow co-founders ... Musk", page)).toBe(false);
    expect(quoteFound("fellow co-founders ... in", page)).toBe(false);
  });
});

describe("rankDossierSources", () => {
  test("the company's pages first (about before the homepage, four at most), then wires and news, directories last, walls never", () => {
    const urls = [
      "https://www.crunchbase.com/organization/acme",
      "https://www.cbinsights.com/company/acme",
      "https://news.example/acme",
      "https://acme.com/",
      "https://acme.com/pricing",
      "https://acme.com/about",
      "https://acme.com/blog/series-b",
      "https://acme.com/careers",
      "https://www.businesswire.com/news/acme",
      "https://www.linkedin.com/company/acme",
    ];
    expect(rankDossierSources(urls, { name: "Acme", domain: "acme.com" })).toEqual([
      "https://acme.com/about",
      "https://acme.com/",
      "https://acme.com/blog/series-b",
      "https://acme.com/pricing",
      "https://www.businesswire.com/news/acme",
      "https://news.example/acme",
      "https://www.cbinsights.com/company/acme",
      "https://acme.com/careers",
    ]);
  });

  test("a host that spells the name counts as the company's site when the domain on record is wrong", () => {
    const picked = rankDossierSources(["https://news.example/x", "https://basecamp-research.com/"], {
      name: "Basecamp Research",
      domain: "basecamp.com",
    });
    expect(picked[0]).toBe("https://basecamp-research.com/");
  });
});

/** Fakes for the reads and the model: the first call answers the verdict, the second the recheck. */
function deps(
  first: DossierVerdict,
  opts: { recheck?: DossierRecheck; read?: typeof pages; searchResults?: typeof pages; fail?: Error } = {},
) {
  const calls = { read: [] as string[][], search: [] as string[], generate: [] as string[] };
  const d: VerifyDossierDeps = {
    read: async (urls) => {
      calls.read.push(urls);
      return (opts.read ?? pages).filter((p) => urls.includes(p.url));
    },
    search: async (query) => {
      calls.search.push(query);
      return opts.searchResults ?? [];
    },
    model: { label: "test:model" },
    generate: async <T>(prompt: string, schema: unknown): Promise<T> => {
      calls.generate.push(prompt);
      if (opts.fail) throw opts.fail;
      if (schema === DossierVerdictSchema) return first as T;
      if (schema === DossierRecheck) return (opts.recheck ?? { claims: [] }) as T;
      throw new Error("unknown schema");
    },
  };
  return { d, calls };
}

describe("verifyDossier", () => {
  test("a dossier about another company is rejected, with nothing kept", async () => {
    const { d } = deps(verdict({ identity: { same_company: "no", reason: "Acme Robotics in Ohio, not the Berlin invoicing company" } }));
    const r = await verifyDossier(dossier, ctx, d);
    expect(r.status).toBe("rejected");
    if (r.status !== "rejected") return;
    expect(r.reason).toBe("different company");
    expect(r.verification.kept).toBe(0);
  });

  test("identity the model cannot place is rejected too", async () => {
    const { d } = deps(verdict({ identity: { same_company: "unclear", reason: "no page names the company" } }));
    const r = await verifyDossier(dossier, ctx, d);
    expect(r.status === "rejected" && r.reason).toBe("identity unclear");
  });

  test("verified: the cleaned dossier and the record of what was read, kept, and dropped", async () => {
    const { d, calls } = deps(verdict());
    const r = await verifyDossier(dossier, ctx, d, { ourSourceUrls: ["https://news.example/acme-series-b", "https://wire.example/acme"] });
    expect(r.status).toBe("verified");
    if (r.status !== "verified") return;
    // Our source already among the dossier's is read once; the other one is added.
    expect(calls.read[0]).toEqual(["https://acme.com/about", "https://news.example/acme-series-b", "https://wire.example/acme"]);
    expect(r.verification).toMatchObject({
      model: "test:model",
      sources_checked: [pages[0].url, pages[1].url],
      searched: true,
      rechecked: 0,
    });
    expect(r.verification.dropped.length).toBeGreaterThan(0);
    expect(r.dossier.customers).toEqual(["Globex", "Initech"]);
  });

  test("thin evidence adds a search on the name and the domain", async () => {
    const { d, calls } = deps(verdict(), {
      read: [pages[1]],
      searchResults: [{ url: "https://acme.com/about", title: "About", markdown: ABOUT }],
    });
    const r = await verifyDossier(dossier, ctx, d);
    expect(calls.search).toEqual(['"Acme" acme.com']);
    expect(r.verification.searched).toBe(true);
    expect(r.verification.sources_checked).toContain("https://acme.com/about");
  });

  test("the second reading runs only for the claims that need it", async () => {
    const shaky = verdict({ founded_year: { ...ok("S1", "Founded in 2021"), confidence: "low" } });
    const { d, calls } = deps(shaky, {
      recheck: { claims: [{ id: "founded_year", verdict: "supported", source: "S1", quote: "Founded in 2021 in Berlin" }] },
    });
    const r = await verifyDossier(dossier, ctx, d);
    expect(calls.generate).toHaveLength(2);
    expect(calls.generate[1]).toContain("founded_year: 2021");
    expect(r.status === "verified" && r.dossier.founded_year).toBe(2021);
    expect(r.verification.rechecked).toBe(1);
  });

  test("nothing readable, or a model failure, throws: the caller saves nothing and retries", async () => {
    await expect(verifyDossier(dossier, ctx, deps(verdict(), { read: [] }).d)).rejects.toThrow("no evidence could be read");
    await expect(verifyDossier(dossier, ctx, deps(verdict(), { fail: new Error("gateway 503") }).d)).rejects.toThrow("gateway 503");
  });
});

describe("parseStoredDossier", () => {
  test("a row written before customers and backers were split reads its mixed list as customers", () => {
    const { customers, investors_and_backers, ...rest } = dossier;
    const legacy = parseStoredDossier({ ...rest, customers_or_logos: ["German Aerospace Center (DLR)", "Seedhouse"] });
    expect(legacy?.customers).toEqual(["German Aerospace Center (DLR)", "Seedhouse"]);
    expect(legacy?.investors_and_backers).toEqual([]);
    expect(parseStoredDossier({ nope: true })).toBeNull();
    expect(parseStoredDossier(dossier)).toEqual(dossier);
    expect(customers.length + investors_and_backers.length).toBeGreaterThan(0);
  });
});

describe("dossierVerifyProviderFor", () => {
  test("DOSSIER_VERIFY_MODEL wins, then a pinned RECONCILE_MODEL, then the strongest default; no key, no check", () => {
    const key = { AI_GATEWAY_API_KEY: "k" };
    expect(dossierVerifyProviderFor({ ...key })).toEqual({ provider: "gateway", modelId: "openai/gpt-6-sol" });
    expect(dossierVerifyProviderFor({ ...key, RECONCILE_MODEL: "openai/gpt-5.6-luna" })).toEqual({
      provider: "gateway",
      modelId: "openai/gpt-5.6-luna",
    });
    expect(
      dossierVerifyProviderFor({ ...key, RECONCILE_MODEL: "openai/gpt-5.6-luna", DOSSIER_VERIFY_MODEL: "anthropic/claude-opus-5.5" }),
    ).toEqual({
      provider: "gateway",
      modelId: "anthropic/claude-opus-5.5",
    });
    expect(dossierVerifyProviderFor({ ANTHROPIC_API_KEY: "k" })).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5" });
    expect(dossierVerifyProviderFor({})).toBeNull();
    // RECONCILE=off turns the reconcile step off; the dossier check follows unless it names its own model.
    expect(dossierVerifyProviderFor({ ...key, RECONCILE: "off" })).toBeNull();
    expect(dossierVerifyProviderFor({ ...key, RECONCILE: "off", DOSSIER_VERIFY_MODEL: "openai/gpt-6-astra" })?.modelId).toBe(
      "openai/gpt-6-astra",
    );
  });
});

// Silicon Mobility's dossier researched SiliconFlow, a Chinese AI-inference company, and its one-liner
// stood as the description of a French EV semiconductor company. The page and sentence are the dossier's.
describe("the one-liner is held to the check a homepage gets", () => {
  const SILICONFLOW_ABOUT = {
    url: "https://siliconflow.cn/about",
    title: "About SiliconFlow",
    markdown:
      "SiliconFlow provides developers and enterprises with AI infrastructure that turns heterogeneous computing resources and many AI models into standardized, scalable token services. Founded by Jinhui Yuan.",
  };
  const ONE_LINER =
    "SiliconFlow provides developers and enterprises with AI infrastructure that turns heterogeneous computing resources and many AI models into standardized, scalable token services through APIs, dedicated instances and private deployments.";
  const siliconMobility = (description: string): Pick<DossierContext, "company" | "rounds"> => ({
    company: {
      name: "Silicon Mobility",
      domain: "silicon-mobility.com",
      website: "https://silicon-mobility.com",
      description,
      hq: "Valbonne, Alpes-Maritimes",
      sector: "hardware",
    },
    rounds: [],
  });

  test("a one-liner read from a page that names neither the company nor its domain does not stand", () => {
    // The record's description at the time came from the same confusion, so the words alone agreed.
    const ctx = siliconMobility("a company specializing in AI infrastructure");
    expect(oneLinerFault(ONE_LINER, SILICONFLOW_ABOUT.url, [SILICONFLOW_ABOUT], ctx)).toBe(
      "its page (siliconflow.cn) names neither Silicon Mobility nor silicon-mobility.com",
    );
  });

  test("a page that names the company still needs the record's line of business", () => {
    const ctx = siliconMobility("a semiconductor and software company that makes electric and hybrid vehicles more energy-efficient");
    const roundup = {
      url: "https://af.net/realtime/silicon-mobility-secures-funding",
      title: "Silicon Mobility secures funding",
      markdown: ONE_LINER,
    };
    expect(oneLinerFault(ONE_LINER, roundup.url, [roundup], ctx)).toBe("it does not share the record's line of business");
    const right =
      "Silicon Mobility makes semiconductor and software solutions that make electric and hybrid vehicles more energy-efficient.";
    expect(oneLinerFault(right, roundup.url, [{ ...roundup, markdown: right }], ctx)).toBeNull();
  });

  test("the company's own site, our record, and a short description are not second-guessed", () => {
    const ctx = siliconMobility("a semiconductor and software company that makes electric and hybrid vehicles more energy-efficient");
    const own = { url: "https://www.silicon-mobility.com/about", title: "About", markdown: "Intel company." };
    expect(oneLinerFault("An Intel company building chips for EVs.", own.url, [own], ctx)).toBeNull();
    expect(oneLinerFault(ONE_LINER, undefined, [], ctx)).toBeNull();
    const named = { ...SILICONFLOW_ABOUT, markdown: `${SILICONFLOW_ABOUT.markdown} Silicon Mobility` };
    expect(oneLinerFault(ONE_LINER, named.url, [named], siliconMobility("an EV chip company"))).toBeNull();
  });

  test("verifyDossier drops the one-liner, records why, and keeps the rest of the dossier's checked claims", async () => {
    const namesake = { url: pages[1].url, title: "SiliconFlow", markdown: SILICONFLOW_ABOUT.markdown };
    const { d } = deps(verdict({ one_liner: ok("S2", "SiliconFlow provides developers and enterprises with AI infrastructure") }), {
      read: [pages[0], namesake],
    });
    const r = await verifyDossier({ ...dossier, one_liner: ONE_LINER }, ctx, d);
    expect(r.status).toBe("verified");
    if (r.status !== "verified") return;
    expect(r.dossier.one_liner).toBe("");
    expect(r.verification.citations.one_liner).toBeUndefined();
    expect(r.verification.dropped).toContainEqual({
      field: "one_liner",
      item: ONE_LINER,
      reason: "its page (news.example) names neither Acme nor acme.com",
    });
    expect(r.dossier.founded_year).toBe(2021);
  });
});
