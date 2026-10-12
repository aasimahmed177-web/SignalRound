// The feed as an MCP server (spec 2026-07-28 via mcp-handler 2.x). Agents get
// the same read API the dashboard uses. Connect: { "url": "<origin>/api/mcp" }.
// Optional bearer auth: set MCP_API_KEY and send Authorization: Bearer <key>.

import type { Stage } from "@fireround/core";
import { ROUND_CERTAINTIES, STAGES } from "@fireround/core";
import type { ServerContext } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { isPublicDemo, mcpTrusted } from "@/lib/access";
import { parseQuery, parseSector, parseSince, parseStages } from "@/lib/api-params";
import { companyPath, companyRequestStatus, limitMessage, requestPath, submitCompanyRequest } from "@/lib/company-requests";
import { dashboardPassword } from "@/lib/dashboard-auth";
import { db } from "@/lib/db";
import { COMPANY_SORTS } from "@/lib/directory";
import type { RoundRow } from "@/lib/persist";
import { feedHistory, listRounds, publicRoundQuery, setStatus } from "@/lib/persist";
import { listPresets } from "@/lib/presets";
import {
  API_INVESTOR_SORTS,
  apiCompanies,
  apiCompanyProfile,
  apiInvestorProfile,
  apiInvestors,
  apiNews,
  apiTopLeads,
  didYouMean,
  notFound,
  parseNewsCursor,
  TOP_WINDOWS,
  type TopWindow,
} from "@/lib/public-api";
import { clientKey, LIMITS, limitRequest } from "@/lib/rate-limit";
import { tokenEquals } from "@/lib/tokens";
import { listTrending, TRENDING_EXPLAINER, trendingMarks } from "@/lib/trending";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** A refusal the caller can act on (a bad website, a spent budget), marked as an error so an agent does not read it as data. */
function refusal(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * A tool body that cannot leak: the SDK answers a throw with the error's own message, and a driver
 * error quotes the query and its parameters. The caller gets one sentence; the log keeps the rest.
 */
function safe<A>(tool: string, run: (args: A, ctx: ServerContext) => Promise<ReturnType<typeof text> | ReturnType<typeof refusal>>) {
  return async (args: A, ctx: ServerContext) => {
    try {
      return await run(args, ctx);
    } catch (err) {
      console.error(`mcp ${tool} failed`, err);
      return refusal("The tool failed on an internal error. Try again shortly.");
    }
  };
}

/** Links an agent can open as they are; the HTTP API answers with paths because its caller is on this origin already. */
function absolute(ctx: ServerContext, path: string): string {
  return new URL(path, process.env.APP_ORIGIN ?? ctx.http?.req?.url ?? "http://localhost").toString();
}

/** A request as a tool reports it, from the same row the status route reads. */
async function requestReport(ctx: ServerContext, id: string) {
  const status = await companyRequestStatus(await db(), id);
  if (!status) return refusal("No company request has that id.");
  return text({
    id,
    status: status.status,
    message: status.message,
    step: status.step,
    company_url: absolute(ctx, status.companyUrl),
    request_url: absolute(ctx, requestPath(id)),
  });
}

function compactRound(r: RoundRow) {
  return {
    id: r.id,
    company: r.company.name,
    domain: r.company.domain,
    website: r.company.website,
    logo_url: r.company.logo_url,
    description: r.company.description,
    stage: r.stage,
    certainty: r.certainty,
    amount: r.amount.as_written,
    amount_usd_millions: r.amount.usd_millions,
    valuation: r.valuation_as_written,
    valuation_disclosed: r.valuation_disclosed,
    lead_investors: r.lead_investors,
    other_investors: r.other_investors,
    announced_on: r.announced_on,
    sector: r.company.sector,
    confidence: r.confidence,
    status: r.status,
    // An earlier round promoted from the company's checked dossier, verified against its own announcement.
    history: r.history,
    // The company's own announcement first, then a wire's release, established outlets, the rest.
    sources: r.sources.map((s) => s.url),
    primary_source: r.primary_source?.url ?? null,
    previous_rounds: r.previous_rounds.map((p) => ({
      stage: p.stage,
      amount: p.amount.as_written,
      announced_on: p.announced_on,
      lead_investors: p.lead_investors,
      url: p.url,
    })),
  };
}

const handler = createMcpHandler(
  (server) => {
    const trusted = mcpTrusted();
    server.registerTool(
      "list_rounds",
      {
        title: "List funding rounds",
        description:
          "Funding rounds, newest first. Filter by stage, status, certainty, sector, minimum amount, date, or preset (a slug from list_presets). Returns a cursor for the next page.",
        inputSchema: z.object({
          since: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("YYYY-MM-DD; only rounds announced on or after this date"),
          stage: z.array(z.enum(STAGES)).optional(),
          status: z.array(z.enum(["new", "updated", "seen"])).optional(),
          certainty: z.enum(ROUND_CERTAINTIES).optional(),
          sector: z
            .string()
            .max(100)
            .optional()
            .describe("A sector or a group, e.g. ai (includes ai infrastructure), health (healthtech, biotech, medtech), fintech, climate"),
          min_amount_usd_millions: z.number().min(0).optional(),
          preset: z
            .string()
            .max(100)
            .optional()
            .describe(
              "Preset slug, for example series-a-b, seed, or growth; omit for every preset except form-d (SEC Form D filings), which is listed only when asked for",
            ),
          cursor: z.string().max(200).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
        annotations: { readOnlyHint: true },
      },
      safe("list_rounds", async (args) => {
        const sector = parseSector(args.sector ?? null);
        if (!sector.ok) return refusal(sector.error);
        const handle = await db();
        const { rows, nextCursor } = await listRounds(
          handle,
          publicRoundQuery({
            since: args.since,
            stages: args.stage as Stage[] | undefined,
            status: args.status,
            certainty: args.certainty,
            sector: sector.value,
            minUsdMillions: args.min_amount_usd_millions,
            preset: args.preset,
            cursor: args.cursor,
            limit: args.limit ?? 25,
            history: feedHistory({ since: args.since }),
          }),
        );
        return text({ rounds: rows.map(compactRound), next_cursor: nextCursor });
      }),
    );

    server.registerTool(
      "search_rounds",
      {
        title: "Search funding rounds",
        description: "Free-text search over company names, descriptions, and investors. Optionally filter by certainty.",
        inputSchema: z.object({
          query: z.string().min(1).max(200),
          certainty: z.enum(ROUND_CERTAINTIES).optional(),
          limit: z.number().int().min(1).max(50).optional(),
        }),
        annotations: { readOnlyHint: true },
      },
      safe("search_rounds", async ({ query, certainty, limit }) => {
        const handle = await db();
        const { rows } = await listRounds(handle, { q: query, certainty, limit: limit ?? 20 });
        return text({ rounds: rows.map(compactRound) });
      }),
    );

    server.registerTool(
      "get_company",
      {
        title: "Get a company",
        description: "Every round on record for one company, by domain or name.",
        inputSchema: z.object({ company: z.string().min(1).max(200).describe("Domain (acme.com) or name") }),
        annotations: { readOnlyHint: true },
      },
      safe("get_company", async ({ company }) => {
        const handle = await db();
        const { rows } = await listRounds(handle, { company, limit: 50, includeReview: trusted });
        return text({ company, rounds: rows.map(compactRound) });
      }),
    );

    server.registerTool(
      "list_trending",
      {
        title: "List trending rounds",
        description: `${TRENDING_EXPLAINER} Filter by certainty. Each round carries its counts (people on X, outlets, Hacker News points), its rank, and whether it earned the Trending label.`,
        inputSchema: z.object({ certainty: z.enum(ROUND_CERTAINTIES).optional(), limit: z.number().int().min(1).max(50).optional() }),
        annotations: { readOnlyHint: true },
      },
      safe("list_trending", async ({ certainty, limit }) => {
        const handle = await db();
        const { rows } = await listTrending(handle, { certainty }, { offset: 0, limit: limit ?? 10 });
        const marks = await trendingMarks(
          handle,
          rows.map((r) => r.id),
        );
        return text({ rounds: rows.map((r) => ({ ...compactRound(r), trending: marks.get(r.id) ?? null })) });
      }),
    );

    // The company, investor, and news reads of /api/v1 (lib/public-api.ts): the same parameters, the
    // same published rows for every caller, and the same JSON the routes answer with.
    const sectorParam = z
      .string()
      .max(100)
      .optional()
      .describe("A sector or a group, e.g. ai (includes ai infrastructure), health (healthtech, biotech, medtech), fintech, climate");
    const stageParam = z
      .array(z.string().max(50))
      .max(20)
      .optional()
      .describe("Stages as the API names them (seed, series_a) or as written (Series A, pre-seed)");

    server.registerTool(
      "list_companies",
      {
        title: "List companies",
        description:
          "The companies the feed lists rounds for, newest raise first, searched by name, description, sector, domain, or headquarters. Filter by sector, stage, or date; sort by latest, raised, or name. A search that matches nothing returns did_you_mean. Pages with page and next_page.",
        inputSchema: z.object({
          q: z.string().max(200).optional().describe("Free text: a name, a domain, a city"),
          sector: sectorParam,
          stage: stageParam,
          since: z.string().optional().describe("YYYY-MM-DD; only companies with a round announced on or after this date"),
          sort: z.enum(COMPANY_SORTS).optional().describe("latest (default), raised, or name"),
          page: z.number().int().min(1).max(10_000).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
        annotations: { readOnlyHint: true },
      },
      safe("list_companies", async (args) => {
        const q = parseQuery(args.q ?? null);
        if (!q.ok) return refusal(q.error);
        const sector = parseSector(args.sector ?? null);
        if (!sector.ok) return refusal(sector.error);
        const stages = parseStages(args.stage?.length ? args.stage.join(",") : null);
        if (!stages.ok) return refusal(stages.error);
        const since = parseSince(args.since ?? null);
        if (!since.ok) return refusal(since.error);
        return text(
          await apiCompanies(await db(), {
            q: q.value,
            sector: sector.value,
            stages: stages.value,
            since: since.value,
            sort: args.sort ?? "latest",
            page: args.page ?? 1,
            limit: args.limit ?? 20,
          }),
        );
      }),
    );

    server.registerTool(
      "get_company_profile",
      {
        title: "Get a company profile",
        description:
          "One company's funding: who it is, what it raised (announced and reported rounds), every round the feed lists for it, newest first, with leads and the official announcement, and its investors, leads first. An id that matches nothing is an error naming the nearest companies.",
        inputSchema: z.object({
          id: z
            .string()
            .min(1)
            .max(200)
            .describe("The id list_companies returns (ramp.com), or a domain, earlier id, or name slug the company is known by"),
        }),
        annotations: { readOnlyHint: true },
      },
      safe("get_company_profile", async ({ id }) => {
        const handle = await db();
        const wanted = id.trim().toLowerCase();
        const found = await apiCompanyProfile(handle, wanted);
        if (found) return text(found);
        return {
          ...text(notFound("No company with that id has a published round", await didYouMean(handle, "companies", wanted))),
          isError: true,
        };
      }),
    );

    server.registerTool(
      "list_investors",
      {
        title: "List investors",
        description:
          "The investors named on the rounds the feed lists, searched by name, with the rounds each led and joined and its latest round. Sort by led (default), rounds, latest, or name. A search that matches nothing returns did_you_mean. Pages with page and next_page.",
        inputSchema: z.object({
          q: z.string().max(200).optional().describe("Free text: an investor's name"),
          sort: z.enum(API_INVESTOR_SORTS).optional().describe("led (default), rounds, latest, or name"),
          page: z.number().int().min(1).max(10_000).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
        annotations: { readOnlyHint: true },
      },
      safe("list_investors", async (args) => {
        const q = parseQuery(args.q ?? null);
        if (!q.ok) return refusal(q.error);
        return text(
          await apiInvestors(await db(), { q: q.value, sort: args.sort ?? "led", page: args.page ?? 1, limit: args.limit ?? 20 }),
        );
      }),
    );

    server.registerTool(
      "get_investor",
      {
        title: "Get an investor",
        description:
          "One investor's profile: who it is, the rounds it led, co-led, and joined, the money it led, its sectors and stages, the investors it backs companies beside, and its recent rounds. An id that matches nothing is an error naming the nearest investors.",
        inputSchema: z.object({
          id: z
            .string()
            .min(1)
            .max(200)
            .describe("The id list_investors returns (sequoia-capital), or the investor's name (Sequoia Capital) or site (sequoiacap.com)"),
        }),
        annotations: { readOnlyHint: true },
      },
      safe("get_investor", async ({ id }) => {
        const handle = await db();
        const found = await apiInvestorProfile(handle, id);
        if (found) return text(found);
        return {
          ...text(notFound("No investor with that id is named on a published round", await didYouMean(handle, "investors", id))),
          isError: true,
        };
      }),
    );

    server.registerTool(
      "top_investors",
      {
        title: "Top investors",
        description:
          "The investors that led the most rounds in the window (7d, 30d, or 90d), optionally within a sector or set of stages, each with the money it led (a co-led round split evenly between its leads) and its latest led rounds.",
        inputSchema: z.object({
          window: z
            .enum(Object.keys(TOP_WINDOWS) as [TopWindow, ...TopWindow[]])
            .optional()
            .describe("7d, 30d (default), or 90d"),
          sector: sectorParam,
          stage: stageParam,
          limit: z.number().int().min(1).max(50).optional(),
        }),
        annotations: { readOnlyHint: true },
      },
      safe("top_investors", async (args) => {
        const sector = parseSector(args.sector ?? null);
        if (!sector.ok) return refusal(sector.error);
        const stages = parseStages(args.stage?.length ? args.stage.join(",") : null);
        if (!stages.ok) return refusal(stages.error);
        return text(
          await apiTopLeads(await db(), {
            window: args.window ?? "30d",
            sector: sector.value,
            stages: stages.value,
            limit: args.limit ?? 10,
          }),
        );
      }),
    );

    server.registerTool(
      "list_news",
      {
        title: "List funding news",
        description:
          "The latest articles about the rounds the feed lists, newest first, each with its publisher, its day, an excerpt when it reports one round, and the rounds it reports. Filter by sector, date, or free text over company names and headlines. Returns a cursor for the next page.",
        inputSchema: z.object({
          q: z.string().max(200).optional().describe("Free text over company names and article titles"),
          sector: sectorParam,
          since: z.string().optional().describe("YYYY-MM-DD; only articles published on or after this date"),
          cursor: z.string().max(4096).optional().describe("The next_cursor of the previous page"),
          limit: z.number().int().min(1).max(100).optional(),
        }),
        annotations: { readOnlyHint: true },
      },
      safe("list_news", async (args) => {
        const since = parseSince(args.since ?? null);
        if (!since.ok) return refusal(since.error);
        const sector = parseSector(args.sector ?? null);
        if (!sector.ok) return refusal(sector.error);
        const q = parseQuery(args.q ?? null);
        if (!q.ok) return refusal(q.error);
        const cursor = args.cursor ? parseNewsCursor(args.cursor) : undefined;
        if (cursor === null) return refusal('cursor must be the next_cursor of the previous page ("YYYY-MM-DD|url")');
        return text(await apiNews(await db(), { since: since.value, sector: sector.value, q: q.value, cursor, limit: args.limit ?? 20 }));
      }),
    );

    // The operator write, only for trusted callers (lib/access.ts mcpTrusted).
    if (trusted) {
      server.registerTool(
        "mark_seen",
        {
          title: "Mark rounds seen",
          description: "Mark round ids as seen so they leave the unread set.",
          inputSchema: z.object({ ids: z.array(z.string().max(200)).min(1).max(200) }),
        },
        safe("mark_seen", async ({ ids }) => {
          const handle = await db();
          return text({ updated: await setStatus(handle, ids, "seen") });
        }),
      );
    }

    server.registerTool(
      "list_presets",
      {
        title: "List presets",
        description: trusted
          ? "The signal presets this instance watches, in order (the first is the default): slug, name, stages, queries, goal, xAccounts, and the monitor settings. Pass a slug as `preset` to list_rounds."
          : "The signal presets this instance watches, in order (the first is the default): slug, name, description, and stages. Pass a slug as `preset` to list_rounds.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      // A public demo's untrusted caller gets what a preset is, not how it searches: the queries,
      // accounts, sites, and monitor settings are the operator's, like a source's query.
      safe("list_presets", async () => {
        const presets = await listPresets();
        return text({
          presets: trusted ? presets : presets.map((p) => ({ slug: p.slug, name: p.name, description: p.description, stages: p.stages })),
        });
      }),
    );

    // The public write the request page offers, so any caller may use it; submitCompanyRequest holds
    // the website check, dedupe, and daily caps for both doors. The server is built per request, so
    // the flag is read on each call.
    if (process.env.COMPANY_REQUESTS === "1") {
      server.registerTool(
        "request_company",
        {
          title: "Request a company",
          description:
            "Ask Fireround to research a company it does not cover yet, by its own website. A company already covered returns its company_url. Otherwise research starts in the background (a request already running for the domain is returned instead of a new one): poll company_request_status with the id. Research checks the homepage, builds a dossier, and verifies each earlier round against its own announcement; the rounds it finds are stored as history on the company page and never delivered to feeds, Slack, email, or webhooks. Each address may start 3 requests per day, and the instance has a global daily cap.",
          inputSchema: z.object({
            website: z
              .string()
              .min(1)
              .max(2048)
              .describe("The company's own website, as a domain or URL (acme.com); not a directory, social, or news page"),
          }),
        },
        safe("request_company", async ({ website }, ctx) => {
          const outcome = await submitCompanyRequest(website, clientKey(ctx.http?.req?.headers ?? new Headers()), mcpTrusted());
          switch (outcome.kind) {
            case "request":
              return requestReport(ctx, outcome.id);
            case "company":
              return text({ company_url: absolute(ctx, companyPath(outcome.companyId)) });
            case "limited":
              return refusal(limitMessage(outcome.scope, outcome.decision.retryAfter));
            case "refused":
              return refusal(outcome.error);
          }
        }),
      );

      server.registerTool(
        "company_request_status",
        {
          title: "Company request status",
          description:
            "The status of a request_company research job: queued, running, done, refused (the site is not a company Fireround can verify), or failed, with a message and the current step. company_url is the company page, which shows progress until research is done.",
          inputSchema: z.object({ id: z.string().max(100).describe("The id request_company returned") }),
          annotations: { readOnlyHint: true },
        },
        safe("company_request_status", async ({ id }, ctx) => requestReport(ctx, id)),
      );
    }
  },
  { serverInfo: { name: "fireround", version: "0.1.0" } },
);

const apiKey = process.env.MCP_API_KEY;
const guarded = apiKey
  ? withMcpAuth(
      handler,
      async (_req, token) => (tokenEquals(token, apiKey) ? { token: apiKey, clientId: "fireround", scopes: ["read", "write"] } : undefined),
      { required: true },
    )
  : handler;

/**
 * Whether the body is a JSON-RPC batch of more than one message. The SDK still runs every call in a
 * batch (the 2025-03-26 revision allowed them; current revisions dropped them, and no SDK client
 * sends one), so a single request could carry thousands of tool calls on one count of the limiter.
 */
async function isBatch(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  return Array.isArray(body) && body.length > 1;
}

/** An untrusted caller (a public demo with no MCP_API_KEY) is counted per address before the server sees the request. */
async function limited(request: Request): Promise<Response> {
  if (!apiKey && !isPublicDemo() && dashboardPassword() !== null) {
    return Response.json({ error: "MCP_API_KEY is required on a password-protected deployment" }, { status: 401 });
  }
  if (await isBatch(request)) {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32600, message: "Batched requests are not supported: send one JSON-RPC message per request." },
        id: null,
      },
      { status: 400 },
    );
  }
  return (await limitRequest(request, LIMITS.mcp, mcpTrusted())) ?? guarded(request);
}

export { limited as GET, limited as POST };
