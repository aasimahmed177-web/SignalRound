// The API reference page's endpoints (app/(site)/docs): what each read answers, the parameters a
// reader reaches for first, and copy-paste requests built on the instance's own origin. Every path
// and parameter named here is one the OpenAPI document serves (tests/api-docs.test.ts), so the page
// can only ever leave something out, never invent it. The full parameter list stays in OpenAPI.

export interface ApiEndpoint {
  /** The anchor on the page. */
  id: string;
  path: string;
  summary: string;
  /** What comes back, in the response's own keys. */
  returns: string;
  /** Query parameters (or the path's `{id}`), each with a one-line reading. */
  params: Array<[name: string, what: string]>;
  /** Commented curl lines against this origin. */
  example: (origin: string) => string;
}

export const API_ENDPOINTS: ApiEndpoint[] = [
  {
    id: "rounds",
    path: "/api/v1/rounds",
    summary: "Funding rounds, newest first: company, stage, amount, date, lead and other investors, certainty, and sources.",
    returns: "{ data: [round], next_cursor }",
    params: [
      ["stage", "Comma-separated: pre_seed, seed, series_a, series_b, series_c, series_d_plus, growth, and more"],
      ["sector", "One sector, such as ai, fintech, or developer tools"],
      ["q", "Free text over company names, descriptions, and investors"],
      ["company", "One company by domain or exact name"],
      ["since", "Rounds announced on or after a YYYY-MM-DD day"],
      ["min_usd", "Minimum amount in USD millions"],
      ["sort", "amount (largest first) or trending (most discussed now)"],
      ["format", "json (default), csv, or jsonl"],
      ["limit, cursor", "Page size up to 200, and next_cursor from the previous page"],
    ],
    example: (o) =>
      [
        "# Series A rounds in AI, newest first",
        `curl "${o}/api/v1/rounds?stage=series_a&sector=ai&limit=5"`,
        "",
        "# The rounds people are discussing now",
        `curl "${o}/api/v1/rounds?sort=trending"`,
        "",
        "# Every round over $100M, as CSV",
        `curl "${o}/api/v1/rounds?min_usd=100&format=csv"`,
      ].join("\n"),
  },
  {
    id: "companies",
    path: "/api/v1/companies",
    summary: "Companies with a round in the feed, each with what it raised and its newest round.",
    returns: "{ data: [company], total, next_page }",
    params: [
      ["q", "Free text over name, description, sector, domain, and headquarters (london finds companies based there)"],
      ["sector, stage, since", "Read the same way as on /api/v1/rounds"],
      ["sort", "latest (default), raised, or name"],
      ["limit, page", "Page size up to 100, and the page number"],
    ],
    example: (o) => ["# London companies, largest raise first", `curl "${o}/api/v1/companies?q=london&sort=raised&limit=5"`].join("\n"),
  },
  {
    id: "company",
    path: "/api/v1/companies/{id}",
    summary: "One company's funding: who it is, what it raised, every round with its leads and announcement, and its investors.",
    returns: "{ id, name, domain, total_raised_usd_millions, latest_round, rounds, investors, … }",
    params: [["id", "The company's id, as in its page address: /companies/ramp is ramp"]],
    example: (o) => ["# Everything on record for one company", `curl "${o}/api/v1/companies/ramp"`].join("\n"),
  },
  {
    id: "investors",
    path: "/api/v1/investors",
    summary: "Investors named on rounds in the feed, with the rounds they led and joined and their newest round.",
    returns: "{ data: [investor], total, next_page }",
    params: [
      ["q", "Part of the investor's name, such as sequoia"],
      ["sort", "led (default), rounds, latest, or name"],
      ["limit, page", "Page size up to 100, and the page number"],
    ],
    example: (o) => ["# Find an investor by name", `curl "${o}/api/v1/investors?q=sequoia"`].join("\n"),
  },
  {
    id: "investors-top",
    path: "/api/v1/investors/top",
    summary: "The investors that led the most rounds in the last 7, 30, or 90 days, with the rounds they led.",
    returns: "{ window, since, sector, data: [{ rank, name, rounds_led, lead_share_usd_millions, led_rounds }] }",
    params: [
      ["window", "7d, 30d (default), or 90d"],
      ["sector, stage", "Rank within one sector or a set of stages"],
      ["limit", "Up to 50, 10 by default"],
    ],
    example: (o) => ["# Who led the most AI rounds this week", `curl "${o}/api/v1/investors/top?window=7d&sector=ai"`].join("\n"),
  },
  {
    id: "investor",
    path: "/api/v1/investors/{id}",
    summary: "One investor's profile: its kind and headquarters, the rounds it led and joined, its sectors, stages, and co-investors.",
    returns: "{ id, name, kind, totals, sectors, stages, co_investors, recent_rounds, … }",
    params: [["id", "The investor's id, as in its page address: /investors/sequoia is sequoia"]],
    example: (o) => ["# One investor's rounds and co-investors", `curl "${o}/api/v1/investors/sequoia"`].join("\n"),
  },
  {
    id: "news",
    path: "/api/v1/news",
    summary: "The articles behind the rounds, newest first, each with its publisher, day, and the rounds it reports.",
    returns: "{ data: [{ title, url, publisher, published_on, excerpt, rounds }], next_cursor }",
    params: [
      ["q", "A company name or a word in the headline"],
      ["sector, since", "Articles about rounds in one sector, or published on or after a day"],
      ["limit, cursor", "Page size up to 100, and next_cursor from the previous page"],
    ],
    example: (o) => ["# The latest fintech funding news", `curl "${o}/api/v1/news?sector=fintech&limit=10"`].join("\n"),
  },
];
