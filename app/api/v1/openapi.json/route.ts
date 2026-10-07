// OpenAPI 3.1 for the read API. Import it into Zapier, a custom GPT, or any client generator.
// A public demo serves its visitors' contract: no include_review, no credit fields, no Basic auth,
// and only the dispositions the feed publishes. The admin's extras are in this file for anyone
// running their own instance. The company request operations are listed only where
// COMPANY_REQUESTS=1 serves them, so a client generator never builds calls that answer 404.

import { ROUND_CERTAINTIES, STAGES } from "@fireround/core";
import { NextResponse } from "next/server";
import { isPublicDemo } from "@/lib/access";
import { companyRequestsDailyMax } from "@/lib/company-requests";
import { LIMITS } from "@/lib/rate-limit";

export function GET(request: Request) {
  const origin = process.env.APP_ORIGIN ?? new URL(request.url).origin;
  const demo = isPublicDemo();
  const Money = {
    type: "object",
    properties: {
      value: { type: ["number", "null"], description: "Amount in millions of `currency`" },
      currency: { type: ["string", "null"], description: "ISO 4217" },
      as_written: { type: ["string", "null"] },
      usd_millions: { type: ["number", "null"], description: "Converted at the announcement-day rate" },
    },
  };
  const Trending = {
    type: ["object", "null"],
    description:
      "The Trending lane's reading while the round is inside its first 72 hours (null after, or before it is scored): distinct people posting about it on X (found with Firecrawl search, outlets and aggregator accounts left out), distinct press outlets, and Hacker News points, combined into a score weighted toward the last 24 hours. Counts are distinct accounts and outlets, not likes. label is true for the rounds that earn Trending: at most five, each with 10+ people on X and 3+ outlets.",
    properties: {
      label: { type: "boolean" },
      rank: { type: ["integer", "null"], description: "Position by score among the rounds being followed; 1 is the most discussed" },
      score: { type: "number" },
      people: { type: "integer", description: "Distinct non-outlet X accounts with a post about the round" },
      outlets: { type: "integer", description: "Distinct press publishers among the round's sources" },
      hn_points: { type: "integer" },
      summary: { type: "string", examples: ["14 people on X · 6 outlets · HN 3 pts"] },
      scored_at: { type: ["string", "null"], format: "date-time" },
    },
  };
  const Round = {
    type: "object",
    properties: {
      id: { type: "string", description: "company_key:stage:announced_on; stable across updates" },
      company: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          domain: { type: ["string", "null"] },
          website: { type: ["string", "null"] },
          logo_url: { type: ["string", "null"], description: "Favicon from the company's homepage, captured by enrichment" },
          description: { type: ["string", "null"] },
          sector: { type: ["string", "null"] },
          hq: { type: ["string", "null"] },
        },
      },
      stage: { type: "string", enum: [...STAGES] },
      certainty: {
        type: "string",
        enum: [...ROUND_CERTAINTIES],
        description:
          "announced: closed on the record; reported: said to have closed by a publisher citing unnamed sources; expected: still proposed or in progress; unconfirmed: not established. Older rows without certainty read as announced.",
      },
      stage_as_written: { type: "string" },
      is_extension: { type: "boolean" },
      amount: Money,
      financing_total_as_written: {
        type: ["string", "null"],
        description:
          "A larger total the source states beside this round's money (funding to date, a series' running total); never the round's amount",
      },
      valuation_as_written: { type: ["string", "null"] },
      announced_on: { type: ["string", "null"], format: "date" },
      date_precision: {
        type: "string",
        enum: ["day", "week", "month", "unknown"],
        description:
          "How well announced_on is known: day (the round's own date or an article), week (the date of the roundup it was read from), month (a monthly list), unknown (undated)",
      },
      date_basis: {
        type: ["string", "null"],
        enum: ["stated", "page", "url", "result", "none", null],
        description:
          "Where announced_on came from: stated (the text names the day), page (the page's byline), url (a day in the URL), result (the search result's published day), none. A stated day stands; a borrowed one yields to a surer sibling source.",
      },
      verification: {
        type: ["object", "null"],
        description:
          "The judge's verdict: the record read back against its primary page. status is confirmed, corrected (notes say what changed), skipped (page unreadable), or unverified; contradicted and not_news records do not publish. publish requires confirmed or corrected.",
        properties: {
          status: { type: "string", enum: ["unverified", "confirmed", "corrected", "contradicted", "not_news", "skipped"] },
          notes: { type: "array", items: { type: "string" } },
          url: { type: ["string", "null"] },
          sources_seen: {
            type: "integer",
            description:
              "How many of the round's sources the verdict read. When it is below the length of sources, pages arrived after the read and a new read is due; the row's source count is always the length of sources.",
          },
        },
      },
      lead_investors: { type: "array", items: { type: "string" } },
      other_investors: { type: "array", items: { type: "string" } },
      sources: {
        type: "array",
        items: { type: "object", properties: { url: { type: "string" }, title: { type: ["string", "null"] }, host: { type: "string" } } },
      },
      alexandria: {
        type: ["object", "null"],
        description:
          "The company's Y Combinator record through Firecrawl Alexandria, keyed on its verified domain; null when YC does not list it",
        properties: {
          yc: {
            type: ["object", "null"],
            properties: {
              batch: { type: ["string", "null"], description: 'The YC batch as written, e.g. "Summer 2022"' },
              team_size: { type: ["integer", "null"] },
              year_founded: { type: ["integer", "null"] },
              founders_count: { type: "integer" },
            },
          },
        },
      },
      company_facts: {
        type: "object",
        description:
          "Company facts with their source: yc (the Y Combinator record above) or dossier (the company research dossier, which keeps a claim only when a page it read states it). The LinkedIn page is the one the company's own verified homepage links.",
        properties: {
          founded_year: {
            type: ["object", "null"],
            properties: { value: { type: "integer" }, source: { type: "string", enum: ["yc", "dossier"] } },
          },
          headcount: {
            type: ["object", "null"],
            description: 'The team size as the source states it, e.g. "51 to 200", "about 40 people", or YC\'s count',
            properties: { value: { type: "string" }, source: { type: "string", enum: ["yc", "dossier"] } },
          },
          linkedin_url: { type: ["string", "null"] },
        },
      },
      evidence_quotes: { type: "array", items: { type: "string" } },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      status: { type: "string", enum: ["new", "updated", "seen"] },
      disposition: { type: "string", enum: demo ? ["publish", "flagged"] : ["publish", "flagged", "review", "rejected"] },
      history: {
        type: "boolean",
        description:
          "An earlier round of the company, promoted from its checked dossier after its own announcement was found and read back like any record. Listed only when the request asks for dates (since) or a company; never in feeds or deliveries.",
      },
      first_seen_at: { type: "string", format: "date-time" },
      last_seen_at: { type: "string", format: "date-time" },
      trending: Trending,
    },
  };
  const Problem = {
    type: "object",
    properties: { error: { type: "string", description: "One sentence a person can act on" } },
    required: ["error"],
  };
  const problem = (description: string) => ({ description, content: { "application/json": { schema: Problem } } });
  const notFound = (description: string) => ({ description, content: { "text/plain": { schema: { type: "string" } } } });
  const RequestStarted = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid", description: "Pass to GET /api/company-requests/{id}" },
      requestUrl: { type: "string", description: "Redirects to companyUrl; kept for older links", examples: ["/requests/0b9f..."] },
      companyUrl: {
        type: "string",
        description: "The company's page, a path on this origin; it shows the research progress until done",
        examples: ["/companies/acme.com"],
      },
    },
    required: ["id", "requestUrl", "companyUrl"],
  };
  const CompanyKnown = {
    type: "object",
    properties: {
      companyUrl: { type: "string", description: "The company's page, a path on this origin", examples: ["/companies/acme.com"] },
    },
    required: ["companyUrl"],
  };
  const companyRequestPaths = {
    "/api/company-requests": {
      post: {
        operationId: "requestCompany",
        summary: "Ask for research on a company the feed does not cover yet",
        description: [
          "Submit a company's own website; it is reduced to its registrable domain, and directory, social, news, and private addresses are refused.",
          "A company already covered answers with its page, and a request already running for the domain answers with that request, so asking twice costs nothing. Otherwise research starts in the background: poll GET /api/company-requests/{id}.",
          "Research checks the homepage, builds a checked dossier, and verifies each earlier round against its own announcement. The rounds it finds are stored as history (history: true): listed on the company page and in /api/v1/rounds for a company or a date range, never delivered to feeds, Slack, email, or webhooks, and never in Latest or Trending.",
          `Budgets: ${LIMITS.companyRequest.limit} per address per day on a public demo (an admin is not counted), and ${companyRequestsDailyMax()} new requests per UTC day across the instance. Counting fails closed: when the store cannot count, the request is refused with 429.`,
          "This is the request page's endpoint: it needs an Origin header naming this origin, and on a Vercel deployment it runs BotID, which refuses a request without the page's challenge. Scripts and agents use the MCP tool request_company, which shares the website check, dedupe, and budgets.",
        ].join(" "),
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  url: {
                    type: "string",
                    maxLength: 2048,
                    description: "The company's own website, as a domain or URL",
                    examples: ["acme.com"],
                  },
                },
                required: ["url"],
              },
            },
          },
        },
        responses: {
          "202": { description: "Research started", content: { "application/json": { schema: RequestStarted } } },
          "200": {
            description: "Nothing new started: a request for the domain is already running, or the company is already covered",
            content: { "application/json": { schema: { oneOf: [RequestStarted, CompanyKnown] } } },
          },
          "400": problem("No website, or one refused: not public, or a directory, social, or news site"),
          "403": problem("The Origin is not this origin, or BotID classified the request as automated"),
          "404": notFound("COMPANY_REQUESTS is off on this instance"),
          "429": {
            ...problem("Over the per-address or the global daily budget, or the budget could not be counted"),
            headers: { "retry-after": { description: "Seconds until the window turns over", schema: { type: "integer" } } },
          },
          "503": problem("The request could not be saved or its research could not be started"),
        },
      },
    },
    "/api/company-requests/{id}": {
      get: {
        operationId: "getCompanyRequest",
        summary: "A company request's progress",
        description: "Public to anyone holding the id; never cached. Poll until status is done, refused, or failed.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": {
            description: "The request's status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    domain: { type: "string", description: "The registrable domain the request was made for", examples: ["acme.com"] },
                    status: {
                      type: "string",
                      enum: ["queued", "running", "done", "refused", "failed"],
                      description: "refused: the website is not a company Fireround could verify",
                    },
                    step: {
                      type: ["string", "null"],
                      enum: ["website", "profile", "history", "rounds", null],
                      description: "The research step in progress",
                    },
                    message: { type: ["string", "null"], description: "What the research is doing, or how it ended" },
                    tally: {
                      type: ["object", "null"],
                      description: "Earlier rounds research found and how many were verified, with the reason each unverified one was not",
                    },
                    brand: {
                      type: ["object", "null"],
                      description: "The name, logo, and colour read from the homepage while research runs; null once refused or failed",
                    },
                    dossier: {
                      type: ["object", "null"],
                      description:
                        "The Deep dive that runs beside the request: status, startedAt, finishedAt. The request can be done while it still runs; null until it starts",
                    },
                    createdAt: { type: "string", format: "date-time" },
                    companyUrl: {
                      type: "string",
                      description: "The company's page, a path on this origin; it shows the research progress until done",
                    },
                  },
                  required: ["id", "domain", "status", "step", "message", "tally", "createdAt", "companyUrl"],
                },
              },
            },
          },
          "404": notFound("No request has that id, or COMPANY_REQUESTS is off"),
        },
      },
    },
  };
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Fireround: funding feed API",
      version: "1.0.0",
      description:
        "Funding rounds reported on the open web, extracted with Firecrawl into structured, deduped, scored records with explicit certainty.",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/v1/rounds": {
        get: {
          operationId: "listRounds",
          summary: "List funding rounds, newest first",
          parameters: [
            {
              name: "since",
              in: "query",
              description:
                "Only rounds announced on or after this day; must be a real YYYY-MM-DD date. With it, earlier rounds promoted from dossiers (history: true) are listed too.",
              schema: { type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            },
            {
              name: "stage",
              in: "query",
              description: `Comma-separated; every value must be one of: ${STAGES.join(", ")}`,
              schema: { type: "string" },
            },
            {
              name: "status",
              in: "query",
              description: "Comma-separated; every value must be one of: new, updated, seen",
              schema: { type: "string" },
            },
            {
              name: "certainty",
              in: "query",
              description: "Exactly one certainty value; older rows without a stored value count as announced",
              schema: { type: "string", enum: [...ROUND_CERTAINTIES] },
            },
            {
              name: "preset",
              in: "query",
              description:
                "One preset's rounds: series-a-b (Series A and B, the default preset), seed (seed and pre-seed), or growth (Series C and later). Omit for every preset.",
              schema: { type: "string", examples: ["series-a-b", "seed", "growth"] },
            },
            { name: "sector", in: "query", schema: { type: "string" } },
            { name: "q", in: "query", description: "Free text over company name, description, and investors", schema: { type: "string" } },
            {
              name: "company",
              in: "query",
              description: "One company by registrable domain (acme.com, any URL shape) or exact name, case-insensitive",
              schema: { type: "string" },
            },
            {
              name: "min_usd",
              in: "query",
              description: "Minimum amount in USD millions; a finite number at or above 0",
              schema: { type: "number", minimum: 0 },
            },
            ...(demo
              ? []
              : [
                  {
                    name: "include_review",
                    in: "query",
                    description:
                      "Adds rows in review. On a public demo it needs the dashboard password (Basic auth); without it the request is a 403",
                    schema: { type: "boolean" },
                  },
                ]),
            {
              name: "sort",
              in: "query",
              description:
                "amount orders by USD, largest first, unknown amounts last; trending lists only the rounds the Trending lane is following (first seen in the last 72 hours), most discussed first; absent is newest announced first",
              schema: { type: "string", enum: ["amount", "trending"] },
            },
            {
              name: "cursor",
              in: "query",
              description:
                'From next_cursor, under the same sort: "YYYY-MM-DD|id" (an empty date reads the undated tail), "amt:N|id" under sort=amount (an empty N reads the unknown-amount tail), or "trend:N" under sort=trending',
              schema: { type: "string", pattern: "^(((\\d{4}-\\d{2}-\\d{2})?|amt:(\\d+(\\.\\d+)?)?)\\|[^|]+|trend:\\d{1,4})$" },
            },
            {
              name: "limit",
              in: "query",
              description:
                "Page size; a whole number from 1 to 200. A CSV without it is the whole filtered set, up to 10,000 rows, with an x-next-cursor header when there are more",
              schema: { type: "integer", minimum: 1, maximum: 200 },
            },
            { name: "format", in: "query", schema: { type: "string", enum: ["json", "csv", "jsonl"] } },
          ],
          responses: {
            "400": {
              description: "A parameter failed validation",
              content: {
                "application/json": { schema: { type: "object", properties: { error: { type: "string" } }, required: ["error"] } },
              },
            },
            "200": {
              description: "A page of rounds",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { data: { type: "array", items: Round }, next_cursor: { type: ["string", "null"] } },
                  },
                },
                "text/csv": { schema: { type: "string" } },
                "application/x-ndjson": { schema: { type: "string" } },
              },
            },
          },
        },
      },
      "/api/v1/runs": {
        get: {
          operationId: "listRuns",
          summary: "Recent pipeline runs, newest first, with per-stage counts and drop tallies",
          parameters: [
            {
              name: "limit",
              in: "query",
              description: "Page size; a whole number from 1 to 200",
              schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            },
          ],
          responses: {
            "400": {
              description: "A parameter failed validation",
              content: {
                "application/json": { schema: { type: "object", properties: { error: { type: "string" } }, required: ["error"] } },
              },
            },
            "200": {
              description: "Runs",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            preset: { type: ["string", "null"] },
                            lane: { type: "string" },
                            window: { type: ["string", "null"] },
                            started_at: { type: "string", format: "date-time" },
                            finished_at: { type: ["string", "null"], format: "date-time" },
                            ...(demo
                              ? {}
                              : {
                                  credits_estimated: {
                                    type: ["integer", "null"],
                                    description:
                                      "Admin only on a public demo, like credits_measured, credits_charged, overlapped, and every credit or budget counter in counts",
                                  },
                                  credits_measured: { type: ["integer", "null"] },
                                  credits_charged: {
                                    type: "integer",
                                    description:
                                      "What a total takes for this run: the measurement, or the estimate when a measured run overlapped it",
                                  },
                                  overlapped: {
                                    type: "boolean",
                                    description: "Another measured run shared the account-balance drop, so credits_measured double-counts",
                                  },
                                }),
                            counts: {
                              type: ["object", "null"],
                              additionalProperties: { type: "integer" },
                              description:
                                "Per-stage counts (search_results, pages_extracted, rounds_extracted, records, judged, corroborated, enriched) and every drop reason as its own count (otherStage, background, rumor, outOfWindow, ungrounded, nonArticle, undatedTimeline, unnamed, unrelatedSource)",
                            },
                            error: { type: ["string", "null"] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      ...(process.env.COMPANY_REQUESTS === "1" ? companyRequestPaths : {}),
    },
    components: {
      schemas: { Round, Money, Trending },
      ...(demo
        ? {}
        : {
            securitySchemes: {
              basic: {
                type: "http",
                scheme: "basic",
                description: "Applies only when DASHBOARD_PASSWORD is set on the deployment; any username, that password",
              },
            },
          }),
    },
    ...(demo ? {} : { security: [{ basic: [] }] }),
  };
  // The spec only changes with a deploy (which clears the CDN) and holds no records, only the API's
  // shape and this origin, so browsers keep it an hour and the CDN a day instead of rebuilding it per hit.
  return NextResponse.json(spec, { headers: { "cache-control": "public, max-age=3600, s-maxage=86400" } });
}
