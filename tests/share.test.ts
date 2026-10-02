// Link previews: the sentences a shared company or investor link unfurls with, and who can reach
// the cards (the password never lets an unfurler past it; the demo lets it read what a visitor can).

import { NextRequest } from "next/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CompanyPage } from "../lib/company";
import type { InvestorPage } from "../lib/investor";
import { cardCacheControl } from "../lib/og";
import type { RoundRow } from "../lib/persist";
import { cardDate, clip, companyShare, investorShare, nameList, shareMetadata } from "../lib/share";
import { config, gate } from "../proxy";

function round(partial: Partial<RoundRow> = {}): RoundRow {
  return {
    id: "r1",
    company: {
      id: "zeliq.com",
      name: "Zeliq",
      domain: "zeliq.com",
      website: null,
      logo_url: null,
      description: null,
      sector: null,
      hq: null,
    },
    stage: "seed",
    stage_as_written: "Seed",
    is_extension: false,
    amount: { value: 8, currency: "USD", as_written: "$8M", usd_millions: 8 },
    financing_total_as_written: null,
    financing_total_quote: null,
    amount_scope: null,
    valuation_as_written: null,
    announced_on: "2026-09-04",
    certainty: "announced",
    reported_on: null,
    date_precision: "day",
    date_basis: "stated",
    verification: { status: "confirmed", notes: [], url: null, sources_seen: 5 },
    lead_investors: ["The Moon Venture", "CMI"],
    other_investors: [],
    // The count a card states is the sources the page lists (lib/source-count.ts), so the fixture lists the five its verdict read.
    sources: Array.from({ length: 5 }, (_, i) => ({
      url: `https://news.example/${i}`,
      title: null,
      host: "news.example",
      published: null,
      query: null,
    })),
    evidence_quotes: [],
    confidence: 0.9,
    status: "new",
    disposition: "publish",
    preset_slug: "seed",
    history: false,
    hold: null,
    pinned: null,
    first_seen_at: "2026-09-04T00:00:00Z",
    last_seen_at: "2026-09-04T00:00:00Z",
    enrichment: null,
    alexandria: null,
    ...partial,
  };
}

function company(rounds: RoundRow[], description: string | null = "a sales prospecting platform based in Europe"): CompanyPage {
  const counted = rounds.filter((r) => r.disposition !== "rejected");
  return {
    addedOnRequest: false,
    requestTally: null,
    publicListing: null,
    priorReasons: null,
    company: { id: "zeliq.com", name: "Zeliq", domain: "zeliq.com", website: null, logo_url: null, description, hq: null, sector: null },
    rounds,
    enrichment: null,
    alexandria: null,
    apollo: null,
    dossier: null,
    sources: [],
    investors: [],
    totals: {
      rounds: rounds.length,
      usd_millions_raised: counted.reduce((n, r) => n + (r.amount.usd_millions ?? 0), 0),
      first_seen: null,
      last_seen: null,
    },
  };
}

describe("companyShare", () => {
  test("the latest round, its lead, when, how verified, then what the company does", () => {
    const share = companyShare(company([round()]));
    expect(share.title).toBe("Zeliq: $8M Seed");
    expect(share.description).toBe(
      "Zeliq raised $8M in its seed round, led by The Moon Venture and CMI (Sep 2026), verified against 5 sources. A sales prospecting platform based in Europe.",
    );
  });

  test("no amount, no lead, unverified: it claims none of them", () => {
    const r = round({
      amount: { value: null, currency: null, as_written: null, usd_millions: null },
      lead_investors: [],
      verification: null,
    });
    const share = companyShare(company([r], null));
    expect(share.title).toBe("Zeliq: Seed round");
    expect(share.description).toBe("Zeliq raised a seed round (Sep 2026).");
  });

  test("several rounds add the total; rejected ones count for nothing", () => {
    const b = round({
      id: "b",
      stage: "series_a",
      amount: { value: 20, currency: "USD", as_written: "$20M", usd_millions: 20 },
      lead_investors: ["Big Fund"],
    });
    const rejected = round({
      id: "x",
      disposition: "rejected",
      amount: { value: 900, currency: "USD", as_written: "$900M", usd_millions: 900 },
    });
    const share = companyShare(company([b, round(), rejected], null));
    expect(share.description).toBe(
      "Zeliq raised $20M in its Series A round, led by Big Fund (Sep 2026), verified against 5 sources; $28M across 2 rounds on record.",
    );
  });

  test("a company whose rounds were all rejected still gets a line", () => {
    const share = companyShare(company([round({ disposition: "rejected" })]));
    expect(share.title).toBe("Zeliq");
    expect(share.description).toBe("A sales prospecting platform based in Europe.");
  });
});

describe("investorShare", () => {
  const page = (rounds: InvestorPage["rounds"], led: number): InvestorPage => ({
    investor: { id: "insight", name: "Insight Partners", domain: null, logo_url: null, kind: null, description: null, headquarters: null },
    rounds,
    totals: { led, co_led: 0, participated: rounds.length - led, lead_share_usd_millions: 0 },
    reach: { usd_millions: 0, co_investors: 0 },
    co_investors: [],
    sectors: [
      { sector: "other", count: 3 },
      { sector: "ai", count: 2 },
      { sector: "fintech", count: 1 },
    ],
    stages: [
      { stage: "series_b", count: 2 },
      { stage: "seed", count: 1 },
    ],
  });

  test("seats, the latest round, and where it clusters; 'other' says nothing and is dropped", () => {
    const share = investorShare(
      page(
        [
          { ...round(), role: "lead" },
          { ...round({ id: "r2" }), role: "participant" },
        ],
        1,
      ),
    );
    expect(share.title).toBe("Insight Partners: led 1 round");
    expect(share.description).toBe(
      "Insight Partners led 1 round and joined 1 more on record, most recently Zeliq's $8M Seed (Sep 2026). Mostly Series B and seed, in AI and fintech.",
    );
  });

  test("no rounds: a plain line, no numbers", () => {
    expect(investorShare(page([], 0)).description).toBe("Insight Partners on Fireround: the rounds it led and joined, with their sources.");
  });
});

describe("helpers", () => {
  test("cardDate words a stated day and drops a borrowed one to the month", () => {
    expect(cardDate("2026-09-04", "day")).toBe("4 Sep 2026");
    expect(cardDate("2026-09-04", "week")).toBe("Sep 2026");
    expect(cardDate(null, "day")).toBeNull();
  });

  test("nameList and clip", () => {
    expect(nameList(["A", "B", "C", "D"])).toBe("A, B and 2 others");
    expect(clip("one two three four five", 14)).toBe("one two three…");
  });

  test("shareMetadata carries siteName and the large card, and the root image only when asked", () => {
    const own = shareMetadata({ title: "T", description: "D" });
    expect(own.openGraph).toMatchObject({ title: "T", description: "D", siteName: "Fireround" });
    expect(own.openGraph && "images" in own.openGraph).toBe(false);
    expect(own.twitter).toMatchObject({ card: "summary_large_image" });
    expect(shareMetadata({ title: "T", description: "D", image: "root" }).openGraph).toHaveProperty("images");
  });
});

describe("who can reach a card", () => {
  const passed = (res: Response) => res.headers.get("x-middleware-next") === "1";
  const matcher = new RegExp(`^${config.matcher[0]}$`);
  const CARDS = ["/companies/zeliq.com/opengraph-image-1h1ury", "/investors/the-moon/opengraph-image-jndh0d"];

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.DASHBOARD_PASSWORD;
    delete process.env.PUBLIC_DEMO;
  });

  test("the entity cards run through the proxy; only the root's generic card skips it", () => {
    for (const path of CARDS) expect(matcher.test(path), path).toBe(true);
    expect(matcher.test("/opengraph-image")).toBe(false);
  });

  test("password without demo: an anonymous unfurler gets 401 for the card, as for the page", () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    for (const path of CARDS) expect(gate(new NextRequest(`http://app.test${path}`)).status, path).toBe(401);
  });

  test("demo: the cards are as open as the pages they preview", () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    process.env.DASHBOARD_PASSWORD = "secret";
    for (const path of CARDS) expect(passed(gate(new NextRequest(`http://app.test${path}`))), path).toBe(true);
  });
});

describe("how long a card is reused", () => {
  test("a public demo lets the CDN keep a card and serve it stale while it redraws", () => {
    expect(cardCacheControl(true)).toMatch(/^public, .*s-maxage=\d+.*stale-while-revalidate=\d+/);
  });

  test("a private instance keeps next/og's default, so no shared cache holds its cards", () => {
    expect(cardCacheControl(false)).toBeNull();
  });
});
