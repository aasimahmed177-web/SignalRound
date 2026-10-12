import { describe, expect, test } from "vitest";
import type { FeedRecord } from "../records/schema.ts";
import { DEFAULT_MODEL, reconcileProviderFor } from "./model.ts";
import {
  applyReconciliation,
  MAX_SOURCES,
  PAGE_CHARS,
  type Reconciliation,
  readCoverage,
  reconcilePrompt,
  reconcileRecords,
  regroundValuation,
  type SourceText,
  sourcesToRead,
} from "./reconcile.ts";

const RATES = { date: "2026-09-02", perUsd: { EUR: 0.9 } };

function record(over: Partial<FeedRecord> = {}): FeedRecord {
  return {
    id: "gimlet:series_a:2026-09-05",
    company_key: "gimlet labs",
    company_name: "Gimlet Labs",
    company_domain: "gimletlabs.ai",
    company_website: "https://gimletlabs.ai",
    company_description: null,
    stage: "series_a",
    stage_as_written: "Series A",
    is_extension: false,
    amount: { value: 41, currency: "USD", as_written: "$41M", usd_millions: 41, fx_rate: 1, fx_date: "2026-09-02" },
    valuation_as_written: null,
    lead_investors: ["Maverick Silicon"],
    other_investors: ["Samsung Ventures", "Plaid"],
    announced_date: "2026-09-05",
    date_precision: "day",
    date_basis: "page",
    headquarters: null,
    sector: "ai",
    evidence_quotes: ["Gimlet Labs raised $41M in a Series A led by Maverick Silicon."],
    sources: [
      { url: "https://en.wowtale.net/gimlet", host: "en.wowtale.net", title: "Gimlet Labs raises $41M", published: "2026-09-05" },
      {
        url: "https://siliconangle.com/2026/09/04/gimlet-labs-raises-41m/",
        host: "siliconangle.com",
        title: "Gimlet Labs raises $41M",
        published: "2026-09-04",
        query: "corroborate",
      },
    ],
    confidence: 0.8,
    status: "new",
    undated: false,
    ...over,
  };
}

const AGREES: Reconciliation = {
  is_announcement: "yes",
  company_matches: true,
  stage: { stated: true, value: "Series A", source: "https://siliconangle.com/2026/09/04/gimlet-labs-raises-41m/", quote: "Series A" },
  amount: {
    stated: true,
    value: "$41 million",
    source: "https://siliconangle.com/2026/09/04/gimlet-labs-raises-41m/",
    quote: "raised $41 million",
  },
  valuation: { stated: false, value: null, source: null, quote: null },
  financing_total: { stated: false, value: null, source: null, quote: null },
  announced_date: {
    stated: true,
    value: "2026-09-04",
    precision: "day",
    source: "https://siliconangle.com/2026/09/04/gimlet-labs-raises-41m/",
    quote: "announced today",
  },
  lead_investors: [{ name: "Maverick Silicon", source: "https://siliconangle.com/2026/09/04/gimlet-labs-raises-41m/" }],
  other_investors: [{ name: "Samsung Ventures", source: "https://en.wowtale.net/gimlet" }],
  not_this_round: [],
  headquarters: {
    stated: true,
    value: "San Francisco, California",
    source: "https://siliconangle.com/2026/09/04/gimlet-labs-raises-41m/",
    quote: "San Francisco-based Gimlet Labs",
  },
  notes: "The republisher is dated a day after the SiliconANGLE article, which says announced today.",
};
const OPTS = { rates: RATES, verifier: "gateway:openai/gpt-5.6-luna", sourcesSeen: 2 };

describe("reconcileProviderFor", () => {
  test("the gateway first, then OpenAI, OpenRouter, Anthropic; RECONCILE=off disables; RECONCILE_MODEL overrides", () => {
    expect(reconcileProviderFor({})).toBeNull();
    expect(reconcileProviderFor({ AI_GATEWAY_API_KEY: "k", OPENAI_API_KEY: "k" })).toEqual({
      provider: "gateway",
      modelId: "openai/gpt-6-luna",
    });
    expect(reconcileProviderFor({ OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k" })).toEqual({ provider: "openai", modelId: "gpt-6-luna" });
    expect(reconcileProviderFor({ OPENROUTER_API_KEY: "k" })).toEqual({ provider: "openrouter", modelId: DEFAULT_MODEL.openrouter });
    expect(reconcileProviderFor({ ANTHROPIC_API_KEY: "k" })).toEqual({ provider: "anthropic", modelId: "claude-haiku-4.5" });
    expect(reconcileProviderFor({ VERCEL_OIDC_TOKEN: "t" })?.provider).toBe("gateway");
    expect(reconcileProviderFor({ AI_GATEWAY_API_KEY: "k", RECONCILE: "off" })).toBeNull();
    expect(reconcileProviderFor({ AI_GATEWAY_API_KEY: "k", RECONCILE_MODEL: "anthropic/claude-sonnet-4.6" })?.modelId).toBe(
      "anthropic/claude-sonnet-4.6",
    );
    expect(reconcileProviderFor({ AI_GATEWAY_API_KEY: "k", OPENAI_API_KEY: "k", RECONCILE_PROVIDER: "openai" })?.provider).toBe("openai");
  });
});

describe("applyReconciliation", () => {
  test("a day, a lead, and a headquarters the sources state land with their citations; without the pages read, a silent name keeps its seat", () => {
    const r = applyReconciliation(record(), AGREES, OPTS);
    expect(r.verification?.status).toBe("corrected");
    expect(r.verification?.verifier).toBe("gateway:openai/gpt-5.6-luna");
    expect(r.verification?.sources_seen).toBe(2);
    expect(r.announced_date).toBe("2026-09-04");
    expect(r.date_precision).toBe("day");
    expect(r.date_basis).toBe("stated");
    expect(r.lead_investors).toEqual(["Maverick Silicon"]);
    // Plaid is on no list and not excluded, and the caller passed no pages: unknown, kept.
    expect(r.other_investors.sort()).toEqual(["Plaid", "Samsung Ventures"]);
    expect(r.headquarters).toBe("San Francisco, California");
    expect(r.amount.as_written).toBe("$41M");
    expect(r.verification?.notes.join(" | ")).toContain("date 2026-09-05 (day) read as 2026-09-04 (day, siliconangle.com)");
  });

  test("a record the sources confirm is confirmed and unchanged; a list-only date stays a week", () => {
    const same = applyReconciliation(
      record({ announced_date: "2026-09-04", other_investors: ["Samsung Ventures"], headquarters: "San Francisco, California" }),
      { ...AGREES, notes: "sources agree" },
      OPTS,
    );
    expect(same.verification?.status).toBe("confirmed");
    expect(same.verification?.notes).toEqual([]);
    const week = applyReconciliation(
      record({ announced_date: "2026-09-06", date_precision: "week" }),
      {
        ...AGREES,
        announced_date: {
          stated: true,
          value: "2026-09-06",
          precision: "week",
          source: "https://en.wowtale.net/gimlet",
          quote: "this week",
        },
      },
      OPTS,
    );
    expect(week.date_precision).toBe("week");
    expect(week.date_basis).toBe("page");
  });

  test("a graded day that only sharpens a newsletter's own stamp, citing the newsletter, is refused; a release's day is not", () => {
    // Fearn: Term Sheet (fortune.com, Sep 23) listed a seed announced on June 10, the row took the issue's
    // week, and the verdict handed the issue's day back as "day" citing the newsletter under its http URL.
    const termSheet = "https://fortune.com/2026/09/23/climate-tech-vc-fundraising-is-down-almost-40-but-ai-is-driving-deals";
    const fearn = record({
      id: "fearn:seed:2026-09-23",
      company_key: "fearn",
      company_name: "Fearn",
      stage: "seed",
      stage_as_written: "seed",
      amount: { value: 5.5, currency: "USD", as_written: "$5.5 million", usd_millions: 5.5, fx_rate: 1, fx_date: "2026-09-23" },
      lead_investors: [],
      other_investors: ["Kindred Ventures", "a16z Speedrun"],
      announced_date: "2026-09-23",
      date_precision: "week",
      date_basis: "page",
      evidence_quotes: ["Fearn, a San Francisco-based AI-powered patent law firm, raised $5.5 million in seed funding."],
      sources: [{ url: termSheet, host: "fortune.com", title: "Climate tech VC fundraising is down almost 40%, but AI is driving deals" }],
    });
    const echo: Reconciliation = {
      ...AGREES,
      stage: { stated: true, value: "seed", source: termSheet, quote: "seed funding" },
      amount: { stated: true, value: "$5.5 million", source: termSheet, quote: "raised $5.5 million" },
      announced_date: {
        stated: true,
        value: "2026-09-23",
        precision: "day",
        source: termSheet.replace("https://", "http://"),
        quote: "September 23, 2026",
      },
      lead_investors: [],
      other_investors: [
        { name: "Kindred Ventures", source: termSheet },
        { name: "a16z Speedrun", source: termSheet },
      ],
      headquarters: { stated: false, value: null, source: null, quote: null },
      notes: "sources agree",
    };
    const refused = applyReconciliation(fearn, echo, OPTS);
    expect(refused.announced_date).toBe("2026-09-23");
    expect(refused.date_precision).toBe("week");
    expect(refused.date_basis).toBe("page");
    expect(refused.verification?.notes.join(" ")).not.toContain("read as");
    // The same day from the company's release, a page about this round alone, is a day.
    const release = "https://www.prnewswire.com/news-releases/fearn-raises-5-5-million-seed-302796012.html";
    const withRelease = {
      ...fearn,
      sources: [...fearn.sources, { url: release, host: "www.prnewswire.com", title: "Fearn Raises $5.5 Million Seed" }],
    };
    const released = applyReconciliation(
      withRelease,
      { ...echo, announced_date: { ...echo.announced_date, value: "2026-09-23", source: release } },
      OPTS,
    );
    expect(released.date_precision).toBe("day");
    expect(released.date_basis).toBe("stated");
    // And the release's own earlier day moves the row, whatever the newsletter said.
    const june = applyReconciliation(
      withRelease,
      { ...echo, announced_date: { ...echo.announced_date, value: "2026-06-10", source: release } },
      OPTS,
    );
    expect(june.announced_date).toBe("2026-06-10");
    expect(june.date_precision).toBe("day");
  });

  test("an amount no source states leaves; a differently stated amount, stage, and excluded investor are corrected", () => {
    const r = applyReconciliation(
      record(),
      {
        ...AGREES,
        stage: { stated: true, value: "Seed", source: "https://en.wowtale.net/gimlet", quote: "seed round" },
        amount: { stated: true, value: "€30 million", source: "https://en.wowtale.net/gimlet", quote: "€30 million" },
        not_this_round: ["Plaid"],
      },
      OPTS,
    );
    expect(r.stage).toBe("seed");
    expect(r.amount.as_written).toBe("€30 million");
    expect(r.amount.currency).toBe("EUR");
    expect(r.amount.usd_millions).toBeCloseTo(33.33, 1);
    expect(r.other_investors).toEqual(["Samsung Ventures"]);
    expect(r.verification?.notes.join(" | ")).toContain("not investors in this round: Plaid");
    // A figure the model copied without its currency is the record's own amount when the numbers match: no correction.
    const bare = applyReconciliation(
      record({ amount: { value: 17.2, currency: "EUR", as_written: "€17.2m", usd_millions: 19.1, fx_rate: 0.9, fx_date: "2026-09-02" } }),
      { ...AGREES, amount: { stated: true, value: "17.2m", source: "https://en.wowtale.net/gimlet", quote: "raised 17.2m" } },
      OPTS,
    );
    expect(bare.amount.as_written).toBe("€17.2m");
    expect(bare.amount.currency).toBe("EUR");
    const gone = applyReconciliation(record(), { ...AGREES, amount: { stated: false, value: null, source: null, quote: null } }, OPTS);
    expect(gone.amount.as_written).toBeNull();
    expect(gone.amount.usd_millions).toBeNull();
  });

  test("history or not a round is not news; a namesake contradicts", () => {
    expect(applyReconciliation(record(), { ...AGREES, is_announcement: "history" }, OPTS).verification?.status).toBe("not_news");
    expect(applyReconciliation(record(), { ...AGREES, is_announcement: "not_a_round" }, OPTS).verification?.status).toBe("not_news");
    expect(applyReconciliation(record(), { ...AGREES, company_matches: false }, OPTS).verification?.status).toBe("contradicted");
  });
});

describe("sourcesToRead and the prompt", () => {
  test("wires and the company's site first, then the record's own finds, then corroborants; at most MAX_SOURCES; pages truncated", () => {
    const many = record({
      sources: [
        { url: "https://blog.example/roundup", host: "blog.example", title: "Deals of the week" },
        { url: "https://techcrunch.com/2026/09/04/gimlet/", host: "techcrunch.com", query: "corroborate" },
        { url: "https://www.prnewswire.com/news-releases/gimlet-302400000.html", host: "www.prnewswire.com", query: "corroborate" },
        { url: "https://gimletlabs.ai/blog/series-a", host: "gimletlabs.ai", query: "corroborate" },
        { url: "https://finsmes.com/gimlet", host: "finsmes.com", query: "corroborate" },
        { url: "https://finsmes.com/gimlet", host: "finsmes.com", query: "corroborate" },
      ],
    });
    const picked = sourcesToRead(many);
    expect(picked).toHaveLength(MAX_SOURCES);
    expect(
      picked
        .slice(0, 2)
        .map((s) => s.host)
        .sort(),
    ).toEqual(["gimletlabs.ai", "www.prnewswire.com"]);
    expect(picked[2]?.host).toBe("blog.example");
    const prompt = reconcilePrompt(many, [{ url: "https://x.example", host: "x.example", markdown: "a".repeat(PAGE_CHARS + 500) }]);
    expect(prompt.length).toBeLessThan(PAGE_CHARS + 3_000);
    expect(prompt).toContain('"company":"Gimlet Labs"');
    expect(prompt).toContain("URL: https://x.example");
  });
});

describe("reconcileRecords", () => {
  test("reads each record's pages, applies the verdict, tallies, and marks a record with no readable page skipped", async () => {
    const read = async (sources: FeedRecord["sources"]) =>
      sources
        .filter((s) => !s.url.includes("broken"))
        .map((s) => ({
          url: s.url,
          host: s.host,
          title: s.title,
          published: s.published,
          markdown: `# ${s.host}\nSan Francisco-based Gimlet Labs announced today it raised $41 million in a Series A led by Maverick Silicon.`,
        }));
    const prompts: string[] = [];
    const model = {
      provider: "gateway" as const,
      modelId: "openai/gpt-6-luna",
      label: "gateway:openai/gpt-6-luna",
      model: "openai/gpt-6-luna",
    };
    const r = await reconcileRecords(
      [
        record(),
        record({
          id: "beta:seed:2026-09-01",
          company_name: "Beta",
          sources: [{ url: "https://broken.example/x", host: "broken.example" }],
        }),
        record({ id: "gamma:seed:2026-09-01", company_name: "Gamma", sources: [] }),
      ],
      read,
      model,
      {
        rates: RATES,
        generate: async (prompt) => {
          prompts.push(prompt);
          return AGREES;
        },
      },
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("--- Source 1 ---");
    expect(prompts[0]).toContain("--- Source 2 ---");
    expect(r.judged).toBe(1);
    expect(r.corrected).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.creditsEstimated).toBe(3);
    expect(r.records.map((x) => x.verification?.status)).toEqual(["corrected", "skipped", "skipped"]);
    expect(r.records[0]?.announced_date).toBe("2026-09-04");
    expect(r.records[0]?.verification?.sources_seen).toBe(2);
  });
});

// Shaped like production's Ultraviolette row (2026-09-23): the Series E's own syndicate is Yali Capital
// and TDK Ventures leading with Lip-Bu Tan; corroboration folded in the company's existing backers, which
// a page listed as background, and the verdict named them in no list while its notes said the sources
// "do not identify Lingotto, Qualcomm Ventures, Zoho Corporation, TVS Motors, or Speciale Invest as
// investors in this specific round". The row published with all eight at 0.86.
describe("the investor rule: only investors a source places in this round stay", () => {
  const UV = {
    moneycontrol: "https://www.moneycontrol.com/news/business/startup/ultraviolette-bags-85-million-series-e-14036186.html",
    yourstory: "https://yourstory.com/2026/09/ultraviolette-raises-85-million-series-e",
    entrackr: "https://entrackr.com/news/ultraviolette-raises-85-mn-targets-us-expansion-in-2027-12567317",
    evreporter: "https://evreporter.com/ultraviolette-raises-85-million-in-new-funding-round",
  };
  const BACKERS = ["Lingotto", "Qualcomm Ventures", "Zoho Corporation", "TVS Motors", "Speciale Invest"];

  function ultraviolette(over: Partial<FeedRecord> = {}): FeedRecord {
    return record({
      id: "ultraviolette:series_d_plus:2026-09-23",
      company_key: "ultraviolette",
      company_name: "Ultraviolette",
      company_domain: null,
      company_website: null,
      stage: "series_d_plus",
      stage_as_written: "Series E",
      amount: { value: 85, currency: "USD", as_written: "$85 million", usd_millions: 85, fx_rate: 1, fx_date: "2026-09-23" },
      lead_investors: ["Yali Capital", "TDK Ventures"],
      other_investors: ["Lip-Bu Tan", ...BACKERS],
      announced_date: "2026-09-23",
      date_precision: "day",
      date_basis: "stated",
      evidence_quotes: [
        "Electric mobility startup Ultraviolette has raised $85 million in a funding round led by Yali Capital and TDK Ventures, with participation from Walden International chairman Lip-Bu Tan and its existing investors.",
      ],
      sources: [
        { url: UV.moneycontrol, host: "moneycontrol.com", title: "Ultraviolette bags $85 million Series E led by Yali, TDK Ventures" },
        { url: UV.yourstory, host: "yourstory.com", title: "Ultraviolette raises $85 million in Series E", query: "corroborate" },
        { url: UV.entrackr, host: "entrackr.com", title: "Ultraviolette raises $85 Mn", query: "corroborate" },
        { url: UV.evreporter, host: "evreporter.com", title: "Ultraviolette Raises $85 Million in Series E", query: "corroborate" },
      ],
      confidence: 0.86,
      verification: undefined,
      ...over,
    });
  }

  const PAGE = {
    [UV.moneycontrol]:
      "Electric mobility startup Ultraviolette has raised $85 million in a funding round led by Yali Capital and TDK Ventures, with participation from Walden International chairman Lip-Bu Tan and its existing investors.",
    [UV.yourstory]: "Ultraviolette has raised a funding of $85 million led by deeptech fund Yali Capital and TDK Ventures.",
    [UV.entrackr]:
      "Ultraviolette raises $85M in Series E funding. The Bengaluru company counts Lingotto, Qualcomm Ventures, Zoho Corporation, TVS Motors and Speciale Invest among its existing investors.",
    [UV.evreporter]:
      "Electric motorcycle manufacturer Ultraviolette Automotive has announced an $85 million funding round led by Yali Capital and TDK Ventures.",
  };
  const pages = (urls: string[], pad = 0): SourceText[] =>
    urls.map((url) => ({ url, host: new URL(url).hostname, markdown: `${PAGE[url] ?? ""}${" filler".repeat(pad)}` }));

  const VERDICT: Reconciliation = {
    ...AGREES,
    stage: { stated: true, value: "Series E", source: UV.yourstory, quote: "Series E" },
    amount: { stated: true, value: "$85 million", source: UV.moneycontrol, quote: "raised $85 million" },
    announced_date: { stated: true, value: "2026-09-23", precision: "day", source: UV.entrackr, quote: "September 23, 2026" },
    lead_investors: [
      { name: "Yali Capital", source: UV.moneycontrol },
      { name: "TDK Ventures", source: UV.moneycontrol },
    ],
    other_investors: [{ name: "Lip-Bu Tan", source: UV.moneycontrol }],
    not_this_round: [],
    headquarters: { stated: false, value: null, source: null, quote: null },
    notes:
      "Sources agree on the $85 million Series E announced on September 23, 2026, led by Yali Capital and TDK Ventures, with Lip-Bu Tan investing. The sources mention existing or current investors and separately list Ultraviolette's investors, but do not identify Lingotto, Qualcomm Ventures, Zoho Corporation, TVS Motors, or Speciale Invest as investors in this specific round.",
  };
  const UV_OPTS = { rates: RATES, verifier: "gateway:openai/gpt-6-luna", sourcesSeen: 4 };

  test("existing backers the verdict leaves out come off, the round's own syndicate stays, and the row reads corrected", () => {
    const r = applyReconciliation(ultraviolette(), VERDICT, { ...UV_OPTS, pages: pages(Object.values(UV)) });
    expect(r.lead_investors).toEqual(["Yali Capital", "TDK Ventures"]);
    expect(r.other_investors).toEqual(["Lip-Bu Tan"]);
    expect(r.verification?.status).toBe("corrected");
    expect(r.verification?.notes).toContain(`not supported for this round: ${BACKERS.join(", ")}`);
    // The score is recomputed on the corrected lists: the leads stand, so the row still publishes.
    expect(r.confidence).toBeGreaterThanOrEqual(0.75);
  });

  test("a participant the sources name in this round still lands, whether the record had it or not", () => {
    const withNew: Reconciliation = {
      ...VERDICT,
      other_investors: [
        { name: "Lip-Bu Tan", source: UV.moneycontrol },
        { name: "Zoho Corporation", source: UV.entrackr },
      ],
    };
    const r = applyReconciliation(ultraviolette({ other_investors: ["Lip-Bu Tan", "Zoho Corporation"] }), withNew, {
      ...UV_OPTS,
      pages: pages(Object.values(UV)),
    });
    expect(r.other_investors).toEqual(["Lip-Bu Tan", "Zoho Corporation"]);
    expect(r.verification?.status).toBe("confirmed");
    const added = applyReconciliation(ultraviolette({ other_investors: [] }), VERDICT, { ...UV_OPTS, pages: pages(Object.values(UV)) });
    expect(added.other_investors).toEqual(["Lip-Bu Tan"]);
  });

  test("a lead no source calls a lead leaves the lead list: demoted when a source places it in the round, gone when none does", () => {
    const demoted = applyReconciliation(
      ultraviolette({ lead_investors: ["Yali Capital", "TDK Ventures", "Lip-Bu Tan"], other_investors: [] }),
      VERDICT,
      { ...UV_OPTS, pages: pages(Object.values(UV)) },
    );
    expect(demoted.lead_investors).toEqual(["Yali Capital", "TDK Ventures"]);
    expect(demoted.other_investors).toEqual(["Lip-Bu Tan"]);
    expect(demoted.verification?.notes).toContain("not leads: Lip-Bu Tan");
    const cleared = applyReconciliation(ultraviolette({ lead_investors: ["Yali Capital", "TDK Ventures", "Lingotto"] }), VERDICT, {
      ...UV_OPTS,
      pages: pages(Object.values(UV)),
    });
    expect(cleared.lead_investors).toEqual(["Yali Capital", "TDK Ventures"]);
    expect(cleared.other_investors).toEqual(["Lip-Bu Tan"]);
  });

  test("Melius: a lead the record's sentences give only the earlier seed is not the Series A's lead, whatever the verdict says", () => {
    const melius = record({
      id: "melius:series_a:2026-10-06",
      company_name: "Melius",
      stage: "series_a",
      stage_as_written: "Series A",
      amount: { value: 20, currency: "USD", as_written: "$20 million", usd_millions: 20, fx_rate: 1, fx_date: "2026-10-06" },
      lead_investors: ["CRV", "General Catalyst"],
      other_investors: ["Vine Ventures"],
      evidence_quotes: [
        "Melius today announced $25 million in total funding.",
        "The funding includes $5 million in seed funding led by General Catalyst, and $20 million Series A led by CRV.",
      ],
    });
    const verdict: Reconciliation = {
      ...AGREES,
      stage: { stated: true, value: "Series A", source: null, quote: null },
      amount: { stated: true, value: "$20 million", source: null, quote: null },
      lead_investors: [
        { name: "CRV", source: "https://www.globenewswire.com/melius" },
        { name: "General Catalyst", source: "https://www.globenewswire.com/melius" },
      ],
      other_investors: [{ name: "Vine Ventures", source: "https://www.globenewswire.com/melius" }],
    };
    const gone = applyReconciliation(melius, verdict, OPTS);
    expect(gone.lead_investors).toEqual(["CRV"]);
    expect(gone.other_investors).toEqual(["Vine Ventures"]);
    expect(gone.verification?.notes).toContain("not investors in this round: General Catalyst");
    // A sentence that puts General Catalyst in the Series A keeps it there as a participant.
    const joined = melius.evidence_quotes.concat(
      "Melius has raised $20M in Series A funding led by CRV with participation from General Catalyst.",
    );
    const kept = applyReconciliation({ ...melius, evidence_quotes: joined }, verdict, OPTS);
    expect(kept.lead_investors).toEqual(["CRV"]);
    expect(kept.other_investors).toEqual(["Vine Ventures", "General Catalyst"]);
    expect(kept.verification?.notes).toContain("not leads: General Catalyst");
  });

  test("with every page read and no investor named in this round, the record's names are unsupported and a lead's absence lowers the score", () => {
    const silent: Reconciliation = { ...VERDICT, lead_investors: [], other_investors: [] };
    const record = ultraviolette();
    const r = applyReconciliation(record, silent, { ...UV_OPTS, pages: pages(Object.values(UV)) });
    expect(r.lead_investors).toEqual([]);
    expect(r.other_investors).toEqual([]);
    const kept = applyReconciliation(record, VERDICT, { ...UV_OPTS, pages: pages(Object.values(UV)) });
    expect(r.confidence).toBeLessThan(kept.confidence);
  });

  test("a silent name keeps its seat only when a source the model never read could state it", () => {
    const fifth = { url: "https://www.autocarindia.com/ultraviolette-85m", host: "autocarindia.com", title: "Ultraviolette raises $85m" };
    const record = ultraviolette({ sources: [...ultraviolette().sources, fifth], other_investors: ["Lip-Bu Tan", ...BACKERS, "Exor"] });
    const r = applyReconciliation(record, VERDICT, { ...UV_OPTS, pages: pages(Object.values(UV)) });
    // Exor is named on no page the model read, and a fifth source went unread: unknown, kept.
    expect(r.other_investors).toEqual(["Lip-Bu Tan", "Exor"]);
    // The backers were on a page the model read, and it left them out: seen, and not placed in this round.
    expect(r.verification?.notes).toContain(`not supported for this round: ${BACKERS.join(", ")}`);
    // A page cut at PAGE_CHARS is not read in full: a name past the cut keeps its seat too.
    const cut = applyReconciliation(ultraviolette({ other_investors: ["Lip-Bu Tan", "Exor"] }), VERDICT, {
      ...UV_OPTS,
      pages: pages(Object.values(UV), PAGE_CHARS),
    });
    expect(cut.other_investors).toEqual(["Lip-Bu Tan", "Exor"]);
    const whole = applyReconciliation(ultraviolette({ other_investors: ["Lip-Bu Tan", "Exor"] }), VERDICT, {
      ...UV_OPTS,
      pages: pages(Object.values(UV)),
    });
    expect(whole.other_investors).toEqual(["Lip-Bu Tan"]);
  });

  test("readCoverage: every source read in full, and names tested against the text read", () => {
    const all = readCoverage(ultraviolette(), pages(Object.values(UV)));
    expect(all.readAll).toBe(true);
    expect(all.mentions("Qualcomm Ventures")).toBe(true);
    expect(all.mentions("Exor")).toBe(false);
    expect(readCoverage(ultraviolette(), pages([UV.moneycontrol, UV.yourstory])).readAll).toBe(false);
  });

  test("reconcileRecords hands the pages it read to the applier", async () => {
    const model = {
      provider: "gateway" as const,
      modelId: "openai/gpt-6-luna",
      label: "gateway:openai/gpt-6-luna",
      model: "openai/gpt-6-luna",
    };
    const r = await reconcileRecords([ultraviolette()], async (sources) => pages(sources.map((s) => s.url)), model, {
      rates: RATES,
      generate: async () => VERDICT,
    });
    expect(r.records[0]?.other_investors).toEqual(["Lip-Bu Tan"]);
    expect(r.corrected).toBe(1);
  });

  test("the prompt and the schema tell the model its lists are the whole syndicate and a company's backers are not", () => {
    const prompt = reconcilePrompt(ultraviolette(), pages(Object.values(UV)));
    expect(prompt).toContain("The two investor lists are this round's whole syndicate");
    expect(prompt).toContain("existing backer");
  });
});

describe("valuations, tranches, and the day a page is read at", () => {
  const FORBES = "https://www.forbes.com/sites/corgi-worth-5-billion/";
  const corgi = (over: Partial<FeedRecord> = {}) =>
    record({
      company_key: "corgi",
      company_name: "Corgi",
      stage: "series_b",
      stage_as_written: "Series B extension",
      is_extension: true,
      amount: { value: 64, currency: "USD", as_written: "$64 million", usd_millions: 64, fx_rate: 1, fx_date: null },
      valuation_as_written: "$1.3 billion",
      lead_investors: [],
      other_investors: [],
      announced_date: "2026-09-25",
      sources: [{ url: FORBES, host: "forbes.com", title: "Corgi Is Now Worth $5 Billion Thanks To Four Funding Rounds In Five Months" }],
      ...over,
    });
  const says = (over: Partial<Reconciliation>): Reconciliation => ({
    ...AGREES,
    stage: { stated: true, value: "Series B extension", source: FORBES, quote: "a $64 million Series B extension" },
    amount: { stated: true, value: "$64 million", source: FORBES, quote: "raised $64 million" },
    announced_date: { stated: true, value: "2026-09-26", precision: "day", source: FORBES, quote: "Sep 26, 2026" },
    lead_investors: [],
    other_investors: [],
    headquarters: { stated: false, value: null, source: null, quote: null },
    ...over,
  });

  test("Corgi: the page's own valuation replaces May's, and a valuation no source states for this round is ruled out", () => {
    const fixed = applyReconciliation(
      corgi(),
      says({
        valuation: { stated: true, value: "$5 billion", source: FORBES, quote: "Corgi raised $64 million at a $5 billion valuation" },
      }),
      OPTS,
    );
    expect(fixed.valuation_as_written).toBe("$5 billion");
    expect(fixed.verification?.notes).toContain("valuation $1.3 billion read as $5 billion (forbes.com)");
    const none = applyReconciliation(corgi(), says({}), OPTS);
    expect(none).toMatchObject({ valuation_as_written: null, valuation_ruled_out: "no source states it for this round" });
  });

  test("the day the read-back settles from a page with no date of its own becomes that page's date", () => {
    const r = applyReconciliation(corgi(), says({}), OPTS);
    expect(r.announced_date).toBe("2026-09-26");
    expect(r.sources[0].published).toBe("2026-09-26");
    // A page that has its own date keeps it.
    const dated = corgi({ sources: [{ url: FORBES, host: "forbes.com", title: "Corgi", published: "2026-09-25" }] });
    expect(applyReconciliation(dated, says({}), OPTS).sources[0].published).toBe("2026-09-25");
  });

  test("Positron: one financing split into tranches is its total; FORE: an extension is the new money, never the series total", () => {
    const positron = record({
      company_key: "positron",
      company_name: "Positron",
      stage: "series_c",
      stage_as_written: "Series C",
      amount: { value: 375, currency: "USD", as_written: "$375 million", usd_millions: 375, fx_rate: 1, fx_date: null },
    });
    const release = "https://www.businesswire.com/news/positron-875-million-series-c";
    const r = applyReconciliation(
      positron,
      {
        ...AGREES,
        stage: { stated: true, value: "Series C", source: release, quote: "Series C financing" },
        amount: {
          stated: true,
          value: "$875 million",
          source: release,
          quote: "an $875 million Series C financing, comprising a $375 million Series C and a $500 million Series C-1",
        },
      },
      OPTS,
    );
    expect(r.amount).toMatchObject({ value: 875, as_written: "$875 million" });
    const prompt = reconcilePrompt(positron, []);
    expect(prompt).toContain("one financing announced split into tranches is its total");
    expect(prompt).toContain("new money added to a round is that new money, never the series' running total");
  });
});

describe("an honest read-back: blind, grounded, counting what it read", () => {
  const SA = "https://siliconangle.com/2026/09/04/gimlet-labs-raises-41m/";
  const page = (markdown: string, url = SA): SourceText => ({ url, host: "siliconangle.com", title: "Gimlet Labs", markdown });

  test("the prompt names the company and nothing the record holds about the round", () => {
    const prompt = reconcilePrompt(record({ valuation_as_written: "$500 million" }), [page("Gimlet Labs raised money.")]);
    expect(prompt).toContain('"company":"Gimlet Labs"');
    for (const held of ["$41M", "Maverick Silicon", "2026-09-05", "$500 million", "Series A led by"]) expect(prompt).not.toContain(held);
  });

  test("a correction whose quote is not on the page it cites is not applied, and says so", () => {
    const verdict = {
      ...AGREES,
      amount: { stated: true, value: "$60 million", source: SA, quote: "raised $60 million" },
      announced_date: { stated: true, value: "2026-09-01", precision: "day" as const, source: SA, quote: "on September 1" },
      stage: { stated: true, value: "Series B", source: null, quote: null },
    };
    const r = applyReconciliation(record(), verdict, { ...OPTS, pages: [page("Gimlet Labs announced today it raised $41 million.")] });
    expect(r.amount.as_written).toBe("$41M");
    expect(r.announced_date).toBe("2026-09-05");
    expect(r.stage).toBe("series_a");
    expect(r.verification?.notes.join(" ")).toContain("not on the page it cites, so not applied: stage, amount, date");
    // The same correction on the page stands.
    const onPage = applyReconciliation(record(), verdict, {
      ...OPTS,
      pages: [page("Gimlet Labs raised $60 million on September 1 in a Series B led by Maverick Silicon.")],
    });
    expect(onPage.amount.as_written).toBe("$60 million");
  });

  test("sources_seen counts the pages read; sources_listed the record's sources, so a grown row is read again", async () => {
    const sources = Array.from({ length: 6 }, (_, i) => ({
      url: `https://news${i}.example/gimlet`,
      host: `news${i}.example`,
      title: `Gimlet ${i}`,
    }));
    const model = { provider: "gateway" as const, modelId: "m", label: "gateway:m", model: "m" };
    const r = await reconcileRecords(
      [record({ sources })],
      async (read) => read.map((s) => ({ url: s.url, host: s.host, title: s.title, markdown: "Gimlet Labs raised $41 million." })),
      model,
      { rates: RATES, generate: async () => AGREES },
    );
    expect(r.records[0].verification).toMatchObject({ sources_seen: MAX_SOURCES, sources_listed: 6 });
  });

  test("an original is read before its syndicated copy, and a copy under the same headline is left out", () => {
    const read = sourcesToRead(
      record({
        sources: [
          { url: "https://finance.yahoo.com/news/gimlet-labs-raises-41m", host: "finance.yahoo.com", title: "Gimlet Labs raises $41M" },
          { url: "https://www.businesswire.com/news/gimlet-labs-raises-41m", host: "businesswire.com", title: "Gimlet Labs raises $41M" },
          { url: "https://www.msn.com/en-us/money/gimlet", host: "msn.com", title: "Gimlet Labs lands $41M for AI inference" },
        ],
      }),
    );
    expect(read.map((s) => s.host)).toEqual(["businesswire.com", "msn.com"]);
  });

  test("each step can read with its own model; unset, every step uses RECONCILE_MODEL or the default", () => {
    const env = { AI_GATEWAY_API_KEY: "k", RECONCILE_MODEL: "openai/gpt-6-luna", RECONCILE_MODEL_HISTORY: "openai/gpt-6-sol" };
    expect(reconcileProviderFor(env, "history")?.modelId).toBe("openai/gpt-6-sol");
    expect(reconcileProviderFor(env, "feed")?.modelId).toBe("openai/gpt-6-luna");
    expect(reconcileProviderFor({ AI_GATEWAY_API_KEY: "k" }, "feed")?.modelId).toBe(DEFAULT_MODEL.gateway);
  });
});

describe("regroundValuation on the production copy's cases", () => {
  const none = { stated: false, value: null, source: null, quote: null };
  const stored = (company: string, valuation: string, amount: number) => ({
    company_name: company,
    stage: "growth" as const,
    amount: { value: amount, currency: "USD", as_written: `$${amount} million`, usd_millions: amount, fx_rate: 1, fx_date: null },
    announced_date: "2026-06-10",
    valuation_as_written: valuation,
    financing_total_as_written: null,
  });
  const reading = (value: string, source: string, quote: string) => ({
    amount: none,
    financing_total: none,
    valuation: { stated: true, value, source, quote },
  });

  test("Harvey: 'it' after a sentence naming the company is kept; Wonder's correction keeps its pre-money basis", () => {
    const url = "https://techcrunch.com/harvey-300m";
    const page = {
      url,
      host: "techcrunch.com",
      title: "Harvey raises $300M",
      markdown: "Legal AI startup Harvey has raised $300 million. It is now valued at $3 billion.",
    };
    expect(
      regroundValuation(stored("Harvey", "$3B", 300), reading("$3 billion", url, "It is now valued at $3 billion."), [page]),
    ).toMatchObject({
      outcome: "kept",
      claim: { value: "$3B", url },
    });
    const wonderUrl = "https://www.bloomberg.com/wonder";
    const wonder = { url: wonderUrl, host: "bloomberg.com", markdown: "Wonder raised $600 million at a $9 billion pre-money valuation." };
    expect(
      regroundValuation(
        stored("Wonder", "$7B", 600),
        reading("$9 billion", wonderUrl, "Wonder raised $600 million at a $9 billion pre-money valuation."),
        [wonder],
      ),
    ).toMatchObject({ outcome: "corrected", claim: { value: "$9 billion pre-money" } });
  });

  test("a sentence only a funding database states holds the value unconfirmed rather than grounding it", () => {
    const url = "https://multiples.vc/companies/ultraviolette";
    const page = { url, host: "multiples.vc", markdown: "Ultraviolette raised $21 million at a $500 million valuation." };
    expect(
      regroundValuation(
        stored("Ultraviolette", "$500 million", 21),
        reading("$500 million", url, "Ultraviolette raised $21 million at a $500 million valuation."),
        [page],
      ),
    ).toEqual({ outcome: "held", value: "$500 million", url });
  });
});
