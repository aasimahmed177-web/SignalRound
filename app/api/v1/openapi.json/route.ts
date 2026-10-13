// OpenAPI 3.1 for the read API. Import it into Zapier, a custom GPT, or any client generator.
// A public demo serves its visitors' contract: no include_review, no credit fields, no Basic auth,
// and only the dispositions the feed publishes. The admin's extras are in this file for anyone
// running their own instance. The company request operations are listed only where
// COMPANY_REQUESTS=1 serves them, so a client generator never builds calls that answer 404.

import { ROUND_CERTAINTIES, SECTOR_GROUPS, SECTORS, STAGES } from "@fireround/core";
import { NextResponse } from "next/server";
import { isPublicDemo } from "@/lib/access";
import { preflight } from "@/lib/api-params";
import { companyRequestsDailyMax } from "@/lib/company-requests";
import { LIMITS } from "@/lib/rate-limit";

const SECTOR_GROUPS_TEXT = Object.entries(SECTOR_GROUPS)
  .map(([group, members]) => `${group} (${members.join(", ")})`)
  .join("; ");
const SECTOR_PARAM = `One sector or one group of sectors. Sectors: ${SECTORS.join(", ")}. A group matches every sector under it: ${SECTOR_GROUPS_TEXT}. So sector=ai includes ai infrastructure, and sector=health includes biotech. Case, spaces and dashes don't matter ("AI infrastructure", "ai-infra"), and common other names map on ("healthcare" is health, "dev tools" is developer tools)`;

/** A browser client's CORS preflight (lib/api-params.ts preflight). */
export function OPTIONS(): Response {
  return preflight();
}

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
      id: {
        type: "string",
        description:
          "An opaque, stable identifier: it does not change when the round is updated or re-dated. Do not parse it; read the company, stage and date from their own fields.",
      },
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
      financing_total_quote: {
        type: ["string", "null"],
        description: "The source's sentence that states financing_total_as_written; null when that is null",
      },
      amount_scope: {
        type: ["string", "null"],
        enum: ["tranche", "round", "financing_total", "includes_grants", "includes_secondary", "combined_rounds", "cumulative", null],
        description:
          "What the source's figure covers: a tranche, the round, all new money in the financing, or a total that includes grants, secondary sales, combined rounds, or funding to date. null when the source does not say.",
      },
      valuation_as_written: { type: ["string", "null"] },
      valuation_disclosed: {
        type: ["boolean", "null"],
        description:
          "true when a valuation is stated (valuation_as_written); false when a source says outright that the valuation was not disclosed; null when no source says either way. A null valuation_as_written with valuation_disclosed false is a known non-disclosure, not a gap.",
      },
      announced_on: { type: ["string", "null"], format: "date" },
      reported_on: {
        type: ["string", "null"],
        format: "date",
        description:
          "For a round first known as reported or expected, the day it was reported (the report's own date, else the day it was first read); null for a round announced on the record",
      },
      freshness_checked_on: {
        type: ["string", "null"],
        format: "date",
        description: "The announcement day the earliest-report check settled on; null before the check has run",
      },
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
          notes: { type: "array", items: { type: "string" }, description: "What the read-back changed, and its remarks on the sources" },
          url: { type: ["string", "null"] },
          sources_listed: { type: "integer", description: "How many sources the round had when the verdict was read" },
          sources_seen: {
            type: "integer",
            description:
              "How many of the round's sources the verdict read. When it is below the length of sources, pages arrived after the read and a new read is due; the row's source count is always the length of sources.",
          },
        },
      },
      verification_checks: {
        type: ["object", "null"],
        description: "How many times the round has been read back against its sources, and when last; null before the first check",
        properties: { attempts: { type: "integer" }, last_checked_at: { type: ["string", "null"], format: "date-time" } },
      },
      lead_investors: { type: "array", items: { type: "string" } },
      other_investors: { type: "array", items: { type: "string" } },
      sources: {
        type: "array",
        description:
          "In reading order: the company's own announcement first, then a newswire's release of it, then established outlets, then the rest; within each, the earlier page first",
        items: { type: "object", properties: { url: { type: "string" }, title: { type: ["string", "null"] }, host: { type: "string" } } },
      },
      primary_source: {
        type: ["object", "null"],
        description:
          "The round's official announcement: the company's own page (kind company), else its release on a newswire (kind wire); null when the sources hold neither. Always the first of sources when present.",
        properties: { url: { type: "string" }, kind: { type: "string", enum: ["company", "wire"] } },
      },
      previous_rounds: {
        type: "array",
        description:
          "The company's other visible rounds announced before this one, newest first, at most 10 (earlier rounds verified against their own announcement included). company= lists every round in full.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            stage: { type: "string", enum: [...STAGES] },
            stage_as_written: { type: "string" },
            amount: {
              type: "object",
              properties: { as_written: { type: ["string", "null"] }, usd_millions: { type: ["number", "null"] } },
            },
            announced_on: { type: ["string", "null"], format: "date" },
            lead_investors: { type: "array", items: { type: "string" } },
            url: { type: ["string", "null"], description: "The round's official announcement when it has one, else its first source" },
          },
        },
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
      enrichment: {
        type: ["object", "null"],
        description: "The company profile read off its verified homepage; null until the profile step has run for the company",
        properties: {
          what_they_sell: { type: ["string", "null"] },
          pricing_model: { type: ["string", "null"] },
          has_free_tier: { type: ["boolean", "null"] },
          plans: {
            type: "array",
            items: { type: "object", properties: { name: { type: "string" }, price_as_written: { type: ["string", "null"] } } },
          },
          pricing_page_url: { type: ["string", "null"] },
          verified: { type: "boolean", description: "true when a homepage passed the identity check" },
          brand: {
            type: ["object", "null"],
            properties: { name: { type: ["string", "null"] }, primary_color: { type: ["string", "null"] } },
          },
        },
      },
      evidence_quotes: { type: "array", items: { type: "string" } },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      status: { type: "string", enum: ["new", "updated", "seen"] },
      preset_slug: { type: "string", description: "The preset whose lane found the round; pass it as preset to list one preset's rounds" },
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
  const RoundRef = {
    type: "object",
    description: "A round as the company, investor and news reads list it: whose, what, how much, and when",
    properties: {
      company: { type: "string" },
      company_domain: { type: ["string", "null"] },
      company_url: { type: "string", description: "The company's page on this site, with every round and its sources" },
      stage: { type: "string", enum: [...STAGES] },
      stage_as_written: { type: "string" },
      amount: {
        type: "object",
        properties: { as_written: { type: ["string", "null"] }, usd_millions: { type: ["number", "null"] } },
      },
      announced_on: { type: ["string", "null"], format: "date" },
    },
  };
  const InvestorId = {
    type: "string",
    description: 'The investor\'s URL slug, e.g. "sequoia-capital-india": pass it to /api/v1/investors/{id}',
  };
  const CompanyId = {
    type: "string",
    description:
      "The company's id, the segment of its page's URL: its domain when known (\"ramp.com\"), else its name hyphenated. Pass it to /api/v1/companies/{id}, which also takes the company's domain (a URL of its site works too) or an earlier id",
  };
  const CompanyRound = {
    allOf: [
      RoundRef,
      {
        type: "object",
        properties: {
          certainty: { type: "string", enum: [...ROUND_CERTAINTIES] },
          lead_investors: { type: "array", items: { type: "string" } },
          other_investors: { type: "array", items: { type: "string" } },
          primary_source: {
            type: ["string", "null"],
            description:
              "The round's official announcement: the company's own page, else its release on a newswire; null when neither is among its sources",
          },
          earlier_round: { type: "boolean", description: "An earlier round of the company, not this week's news" },
        },
      },
    ],
  };
  const DidYouMean = {
    type: "array",
    description:
      "Only when nothing matched: up to three companies or investors whose name is a typo or two away from the one asked for, nearest first. Retry with one of them.",
    items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] },
  };
  const BadRequest = {
    description: "A parameter failed validation",
    content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } }, required: ["error"] } } },
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
                "Only rounds announced on or after this day, as YYYY-MM-DD. Also a month (YYYY-MM, from its first day), today, yesterday, or a number of days back such as 7d; days are UTC. With it, earlier rounds promoted from dossiers (history: true) are listed too.",
              schema: { type: "string" },
            },
            {
              name: "stage",
              in: "query",
              description: `Comma-separated; each one of ${STAGES.join(", ")}, or the words for it ("Series A", "series-a", "pre-seed")`,
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
                "One preset's rounds: series-a-b (Series A and B, the default preset), seed (seed and pre-seed), growth (Series C and later), or form-d (SEC Form D filings, which a list leaves out unless asked for or narrowed to a company). Omit for every preset but form-d.",
              schema: { type: "string", examples: ["series-a-b", "seed", "growth"] },
            },
            {
              name: "sector",
              in: "query",
              description: SECTOR_PARAM,
              schema: { type: "string" },
            },
            {
              name: "q",
              in: "query",
              description: "Free text over company name, description, and investors",
              schema: { type: "string", maxLength: 200 },
            },
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
                "amount orders by USD: published rounds announced on the record first, then flagged, expected, reported, and unconfirmed rounds, each part largest first with unknown amounts last; trending lists only the rounds the Trending lane is following (first seen in the last 72 hours), most discussed first; absent is newest announced first",
              schema: { type: "string", enum: ["amount", "trending"] },
            },
            {
              name: "cursor",
              in: "query",
              description:
                'From next_cursor, under the same sort: "YYYY-MM-DD|id" (an empty date reads the undated tail), "amt:N|id" or "amtp:N|id" under sort=amount (amtp pages the flagged, expected, reported, and unconfirmed rounds; an empty N reads the unknown-amount tail), or "trend:N" under sort=trending',
              schema: { type: "string", pattern: "^(((\\d{4}-\\d{2}-\\d{2})?|amtp?:(\\d+(\\.\\d+)?)?)\\|[^|]+|trend:\\d{1,4})$" },
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
                    properties: {
                      data: { type: "array", items: Round },
                      next_cursor: { type: ["string", "null"] },
                      did_you_mean: DidYouMean,
                    },
                  },
                },
                "text/csv": { schema: { type: "string" } },
                "application/x-ndjson": { schema: { type: "string" } },
              },
            },
          },
        },
      },
      "/api/v1/companies": {
        get: {
          operationId: "listCompanies",
          summary: "Companies with published rounds, newest raise first",
          description:
            "Every company the feed lists a round for, with what it raised and its newest round. Search with q over the name, description, sector, domain, and headquarters (q=london finds companies based there); narrow by sector, and by stage and since to companies with a round at that stage announced on or after that day. Sort by the newest raise (default), the most raised, or name. total_raised_usd_millions counts announced and reported rounds only.",
          parameters: [
            {
              name: "q",
              in: "query",
              description: "Free text over the company's name, description, sector, domain, and headquarters, e.g. ramp or london",
              schema: { type: "string", maxLength: 200 },
            },
            {
              name: "sector",
              in: "query",
              description: "One sector, e.g. ai or fintech, read the same way as /api/v1/rounds?sector=",
              schema: { type: "string" },
            },
            {
              name: "stage",
              in: "query",
              description: `Comma-separated stages, any of: ${STAGES.join(", ")}; with since, a round at one of them announced on or after that day`,
              schema: { type: "string" },
            },
            {
              name: "since",
              in: "query",
              description:
                "Only companies with a round announced on or after this day, as YYYY-MM-DD. Also a month (YYYY-MM, from its first day), today, yesterday, or a number of days back such as 7d; days are UTC.",
              schema: { type: "string" },
            },
            { name: "sort", in: "query", schema: { type: "string", enum: ["latest", "raised", "name"], default: "latest" } },
            { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
            {
              name: "limit",
              in: "query",
              description: "Page size, at most 100",
              schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            },
          ],
          responses: {
            "400": BadRequest,
            "200": {
              description: "One page of companies",
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
                            id: CompanyId,
                            name: { type: "string" },
                            domain: { type: ["string", "null"] },
                            logo_url: { type: ["string", "null"] },
                            url: { type: "string", description: "The company's page on this site" },
                            description: { type: ["string", "null"] },
                            sector: { type: ["string", "null"] },
                            headquarters: { type: ["string", "null"] },
                            rounds_total: { type: "integer", description: "Rounds the feed lists for the company" },
                            total_raised_usd_millions: {
                              type: ["number", "null"],
                              description: "Stated USD amounts of its announced and reported rounds; null when none states one",
                            },
                            latest_round: {
                              type: ["object", "null"],
                              properties: {
                                stage: { type: "string", enum: [...STAGES] },
                                stage_as_written: { type: "string" },
                                announced_on: { type: ["string", "null"], format: "date" },
                              },
                            },
                          },
                        },
                      },
                      total: { type: "integer", description: "Companies matching the search" },
                      next_page: { type: ["integer", "null"] },
                      did_you_mean: DidYouMean,
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/v1/companies/{id}": {
        get: {
          operationId: "getCompany",
          summary: "One company's funding",
          description:
            "Who the company is, what it raised (announced and reported rounds only), every round the feed lists for it, newest first, each with its leads and official announcement, and the investors on those rounds, leads first.",
          parameters: [{ name: "id", in: "path", required: true, schema: CompanyId }],
          responses: {
            "404": {
              description: "No company with that id has a published round. The message names the closest matches, if any",
              content: {
                "application/json": { schema: { type: "object", properties: { error: { type: "string" }, did_you_mean: DidYouMean } } },
              },
            },
            "200": {
              description: "The profile",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: CompanyId,
                      matched_from: {
                        type: "string",
                        description:
                          "Present only when the id matched nothing and this profile is the one name a single edit away; the id as asked",
                      },
                      note: { type: "string", description: "Present with matched_from: says which name was read instead" },
                      name: { type: "string" },
                      domain: { type: ["string", "null"] },
                      logo_url: { type: ["string", "null"] },
                      url: { type: "string", description: "The company's page on this site" },
                      description: { type: ["string", "null"] },
                      sector: { type: ["string", "null"] },
                      headquarters: { type: ["string", "null"] },
                      total_raised_usd_millions: {
                        type: "number",
                        description:
                          "Stated USD amounts of its announced and reported rounds; expected and unconfirmed rounds are left out",
                      },
                      latest_round: { ...CompanyRound, type: ["object", "null"], description: "The first of rounds" },
                      rounds: { type: "array", description: "Every round the feed lists for it, newest first", items: CompanyRound },
                      investors: {
                        type: "array",
                        description: "The investors on its rounds, leads first",
                        items: {
                          type: "object",
                          properties: {
                            id: InvestorId,
                            name: { type: "string" },
                            domain: { type: ["string", "null"] },
                            logo_url: { type: ["string", "null"] },
                            url: { type: "string" },
                            rounds_led: { type: "integer" },
                            rounds_participated: { type: "integer" },
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
      "/api/v1/investors": {
        get: {
          operationId: "listInvestors",
          summary: "Investors named on published rounds, searched by name",
          description:
            "Every investor named on a round the feed lists, with the rounds it led and joined and its newest round. Search by name with q; sort by rounds led (default), all rounds, the newest round, or name.",
          parameters: [
            {
              name: "q",
              in: "query",
              description: "Part of the investor's name or site, e.g. sequoia or a16z",
              schema: { type: "string", maxLength: 200 },
            },
            { name: "sort", in: "query", schema: { type: "string", enum: ["led", "rounds", "latest", "name"], default: "led" } },
            { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
            {
              name: "limit",
              in: "query",
              description: "Page size, at most 100",
              schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            },
          ],
          responses: {
            "400": BadRequest,
            "200": {
              description: "One page of investors",
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
                            id: InvestorId,
                            name: { type: "string" },
                            domain: { type: ["string", "null"], description: "The investor's own website, bare" },
                            logo_url: { type: ["string", "null"] },
                            url: { type: "string", description: "The investor's page on this site" },
                            rounds_led: { type: "integer" },
                            rounds_participated: { type: "integer" },
                            rounds_total: { type: "integer" },
                            latest_round: {
                              type: ["object", "null"],
                              properties: {
                                company: { type: "string" },
                                company_url: { type: "string" },
                                stage: { type: "string", enum: [...STAGES] },
                                stage_as_written: { type: "string" },
                                announced_on: { type: ["string", "null"], format: "date" },
                              },
                            },
                          },
                        },
                      },
                      total: { type: "integer", description: "Investors matching the search" },
                      next_page: { type: ["integer", "null"] },
                      did_you_mean: DidYouMean,
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/v1/investors/top": {
        get: {
          operationId: "topInvestors",
          summary: "The investors that led the most rounds in a window",
          description:
            "Ranks investors by the announced or reported rounds they led in the last 7, 30, or 90 days, optionally within one sector or set of stages, as the Overview's most active leads. lead_share_usd_millions splits each led round's stated amount evenly between its leads, so the figures add up to the money led. Each investor lists its newest led rounds.",
          parameters: [
            {
              name: "window",
              in: "query",
              description: "7d, 30d or 90d; week, month and quarter read as the same",
              schema: { type: "string", enum: ["7d", "30d", "90d", "week", "month", "quarter"], default: "30d" },
            },
            {
              name: "sector",
              in: "query",
              description: "One sector, e.g. ai or fintech, read the same way as /api/v1/rounds?sector=",
              schema: { type: "string" },
            },
            {
              name: "stage",
              in: "query",
              description: `Comma-separated stages, any of: ${STAGES.join(", ")}`,
              schema: { type: "string" },
            },
            { name: "limit", in: "query", description: "At most 50", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 } },
          ],
          responses: {
            "400": BadRequest,
            "200": {
              description: "The ranking",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      window: { type: "string" },
                      since: { type: "string", format: "date", description: "The first day the window counts" },
                      sector: { type: ["string", "null"] },
                      data: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            rank: { type: "integer" },
                            id: InvestorId,
                            name: { type: "string" },
                            domain: { type: ["string", "null"] },
                            logo_url: { type: ["string", "null"] },
                            url: { type: "string" },
                            rounds_led: { type: "integer" },
                            lead_share_usd_millions: { type: "number" },
                            led_rounds: { type: "array", description: "Its newest led rounds in the window, at most 3", items: RoundRef },
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
      "/api/v1/investors/{id}": {
        get: {
          operationId: "getInvestor",
          summary: "One investor's profile",
          description:
            "Who the investor is (its kind, description, and headquarters as its own site states them), the rounds it led and joined, its sectors and stages, the investors it backs companies beside, and its newest rounds with its role in each.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              description: 'The investor\'s slug, or its name or site as written ("Andreessen Horowitz", "a16z.com", "https://a16z.com/")',
              schema: InvestorId,
            },
          ],
          responses: {
            "404": {
              description: "No investor with that id is named on a published round. The message names the closest matches, if any",
              content: {
                "application/json": { schema: { type: "object", properties: { error: { type: "string" }, did_you_mean: DidYouMean } } },
              },
            },
            "200": {
              description: "The profile",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      matched_from: {
                        type: "string",
                        description:
                          "Present only when the id matched nothing and this profile is the one name a single edit away; the id as asked",
                      },
                      note: { type: "string", description: "Present with matched_from: says which name was read instead" },
                      id: InvestorId,
                      name: { type: "string" },
                      domain: { type: ["string", "null"] },
                      logo_url: { type: ["string", "null"] },
                      url: { type: "string" },
                      kind: {
                        type: ["string", "null"],
                        description: "venture_capital, corporate_venture, accelerator, person, and so on; null until resolved",
                      },
                      kind_label: { type: ["string", "null"] },
                      description: { type: ["string", "null"] },
                      headquarters: { type: ["string", "null"] },
                      totals: {
                        type: "object",
                        properties: {
                          rounds_led: { type: "integer" },
                          rounds_co_led: { type: "integer" },
                          rounds_participated: { type: "integer" },
                          lead_share_usd_millions: { type: "number" },
                        },
                      },
                      sectors: {
                        type: "array",
                        items: { type: "object", properties: { sector: { type: "string" }, count: { type: "integer" } } },
                      },
                      stages: {
                        type: "array",
                        items: { type: "object", properties: { stage: { type: "string" }, count: { type: "integer" } } },
                      },
                      co_investors: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: InvestorId,
                            name: { type: "string" },
                            url: { type: "string" },
                            shared_rounds: { type: "integer" },
                          },
                        },
                      },
                      recent_rounds: {
                        type: "array",
                        description: "Its newest rounds, at most 25",
                        items: {
                          allOf: [
                            RoundRef,
                            {
                              type: "object",
                              properties: {
                                role: { type: "string", enum: ["lead", "participant"] },
                                certainty: { type: "string", enum: [...ROUND_CERTAINTIES] },
                                lead_investors: { type: "array", items: { type: "string" } },
                                sector: { type: ["string", "null"] },
                                earlier_round: { type: "boolean", description: "An earlier round of the company, not this week's news" },
                              },
                            },
                          ],
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
      "/api/v1/news": {
        get: {
          operationId: "listNews",
          summary: "The latest funding news, newest first",
          description:
            "The articles behind the rounds the feed lists: each with its title, publisher, day, and the rounds it reports (with amount, stage, certainty, and leads). A roundup reports several rounds; a single-round article carries the round's own sentence as its excerpt. Regulatory filings are not listed.",
          parameters: [
            {
              name: "since",
              in: "query",
              description:
                "Articles published on or after this day, as YYYY-MM-DD. Also a month (YYYY-MM, from its first day), today, yesterday, or a number of days back such as 7d; days are UTC.",
              schema: { type: "string" },
            },
            { name: "sector", in: "query", description: "Articles about rounds in one sector", schema: { type: "string" } },
            { name: "q", in: "query", description: "A company name or a word in the headline", schema: { type: "string", maxLength: 200 } },
            { name: "limit", in: "query", description: "At most 100", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
            { name: "cursor", in: "query", description: "next_cursor from the previous page", schema: { type: "string" } },
          ],
          responses: {
            "400": BadRequest,
            "200": {
              description: "One page of articles",
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
                            title: { type: ["string", "null"] },
                            url: { type: "string" },
                            publisher: { type: "string", description: "The publisher's host, e.g. techcrunch.com" },
                            published_on: { type: "string", format: "date", description: "The article's day, else the day it was read" },
                            excerpt: { type: ["string", "null"] },
                            rounds: {
                              type: "array",
                              items: {
                                allOf: [
                                  RoundRef,
                                  {
                                    type: "object",
                                    properties: {
                                      certainty: { type: "string", enum: [...ROUND_CERTAINTIES] },
                                      sector: { type: ["string", "null"] },
                                      lead_investors: { type: "array", items: { type: "string" } },
                                    },
                                  },
                                ],
                              },
                            },
                          },
                        },
                      },
                      next_cursor: { type: ["string", "null"] },
                    },
                  },
                },
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
  return NextResponse.json(spec, {
    headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=3600, s-maxage=86400" },
  });
}
