// The read API. Every other surface (feeds, exports, MCP, Slack) renders from this.
// GET /api/v1/rounds?since=YYYY-MM-DD&stage=series_a,series_b&status=new&certainty=announced&preset=series-a-b&sector=fintech&q=acme&company=acme.com&min_usd=10&sort=amount|trending&cursor=...&limit=50&format=json|csv|jsonl
// A CSV without `limit` is the whole filtered set (up to 10,000 rows; `x-next-cursor` when there are more).
// Every JSON and JSONL row carries `trending`: the Trending lane's counts, rank, and label while
// the round is inside its 72 hours, null otherwise.

import { NextResponse } from "next/server";
import { seesReview, viewerFrom } from "@/lib/access";
import {
  badRequest,
  parseCertainty,
  parseCursor,
  parseFormat,
  parseLimit,
  parseMinUsd,
  parseQuery,
  parseSector,
  parseSince,
  parseSort,
  parseStages,
  parseStatuses,
  preflight,
  readHeaders,
} from "@/lib/api-params";
import { db } from "@/lib/db";
import type { RoundRow } from "@/lib/persist";
import { feedHistory, listRounds, publicRoundQuery } from "@/lib/persist";
import { didYouMean } from "@/lib/public-api";
import { publicRound } from "@/lib/public-view";
import { LIMITS, limitRequest } from "@/lib/rate-limit";
import { parseTrendingCursor, trendingCursorAfter } from "@/lib/round-sort";
import { listTrending, trendingMarks } from "@/lib/trending";

const CSV_COLUMNS = [
  "status",
  "company",
  "website",
  "logo_url",
  "stage",
  "certainty",
  "amount_as_written",
  "amount_usd_millions",
  "announced_on",
  "lead_investors",
  "other_investors",
  "sector",
  "confidence",
  "sources",
  "disposition",
] as const;

/** A CSV with no `limit` is the whole filtered set, read a page at a time up to this many rows. */
const CSV_MAX_ROWS = 10_000;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = Array.isArray(v) ? v.join("; ") : String(v);
  // A cell that opens with = + - @ or a tab or return runs as a formula when the file lands in a spreadsheet;
  // the leading quote keeps a scraped name as text. Scraped names are the only place one could come from.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: RoundRow[]): string {
  const lines = rows.map((r) =>
    [
      r.status,
      r.company.name,
      r.company.website,
      r.company.logo_url,
      r.stage,
      r.certainty,
      r.amount.as_written,
      r.amount.usd_millions,
      r.announced_on,
      r.lead_investors,
      r.other_investors,
      r.company.sector,
      r.confidence,
      r.sources.map((s) => s.url),
      r.disposition,
    ]
      .map(csvEscape)
      .join(","),
  );
  return `${[CSV_COLUMNS.join(","), ...lines].join("\n")}\n`;
}

/** A browser client's CORS preflight (lib/api-params.ts preflight). */
export function OPTIONS(): Response {
  return preflight();
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const p = url.searchParams;

  // Every bad value is a 400 with one line; nothing silently narrows to an empty set.
  const limit = parseLimit(p.get("limit"));
  if (!limit.ok) return badRequest(limit.error);
  const since = parseSince(p.get("since"));
  if (!since.ok) return badRequest(since.error);
  const minUsd = parseMinUsd(p.get("min_usd"));
  if (!minUsd.ok) return badRequest(minUsd.error);
  const q = parseQuery(p.get("q"));
  if (!q.ok) return badRequest(q.error);
  const stages = parseStages(p.get("stage"));
  if (!stages.ok) return badRequest(stages.error);
  const sector = parseSector(p.get("sector"));
  if (!sector.ok) return badRequest(sector.error);
  const status = parseStatuses(p.get("status"));
  if (!status.ok) return badRequest(status.error);
  const certainty = parseCertainty(p.get("certainty"));
  if (!certainty.ok) return badRequest(certainty.error);
  const format = parseFormat(p.get("format"));
  if (!format.ok) return badRequest(format.error);
  const sort = parseSort(p.get("sort"));
  if (!sort.ok) return badRequest(sort.error);
  const cursor = parseCursor(p.get("cursor"), sort.value);
  if (!cursor.ok) return badRequest(cursor.error);
  // Review and rejected rows are the admin's: in demo mode the proxy lets visitors through to the
  // API, so the password is checked here, and asking without it is refused rather than quietly narrowed.
  const includeReview = p.get("include_review") === "true";
  // The same test decides who reads operator detail (the verifier's model, each source's query):
  // an admin, or anyone on a private instance. A demo visitor gets the public row.
  const insider = seesReview(viewerFrom(request.headers.get("authorization")));
  if (includeReview && !insider) {
    return Response.json({ error: "include_review needs the dashboard password" }, { status: 403 });
  }
  // A CSV with no limit is the whole filtered set, up to fifty queries, so it has a budget of its own.
  const exportSort = format.value === "csv" && sort.value !== "trending" && p.get("limit") === null ? sort.value : null;
  const limited = await limitRequest(request, exportSort !== null ? LIMITS.export : LIMITS.api, insider);
  if (limited) return limited;

  const handle = await db();
  const filters = publicRoundQuery({
    since: since.value,
    stages: stages.value,
    status: status.value,
    certainty: certainty.value,
    preset: p.get("preset") ?? undefined,
    sector: sector.value,
    q: q.value,
    company: p.get("company") ?? undefined,
    minUsdMillions: minUsd.value,
    includeReview,
    // History rows (earlier rounds promoted from dossiers) list only when the caller asks for dates or a company.
    history: feedHistory({ since: since.value, company: p.get("company") ?? undefined }),
  });
  let rows: RoundRow[];
  let nextCursor: string | null;
  // An export is the whole filtered set, not the first page: a CSV asked for without a limit follows
  // the cursor to the end (it once stopped at 200 rows without a word) and says so when it hits the cap.
  if (exportSort !== null) {
    rows = [];
    nextCursor = cursor.value ?? null;
    do {
      const page = await listRounds(handle, { ...filters, sort: exportSort, cursor: nextCursor ?? undefined, limit: 200 });
      rows.push(...page.rows);
      nextCursor = page.nextCursor;
    } while (nextCursor && rows.length < CSV_MAX_ROWS);
  } else if (sort.value === "trending") {
    // The trending list is short and ranked, so it pages by position: `trend:N` is the row after the last.
    const offset = cursor.value ? (parseTrendingCursor(cursor.value) ?? 0) : 0;
    const page = await listTrending(handle, filters, { offset, limit: limit.value });
    rows = page.rows;
    nextCursor = offset + rows.length < page.total ? trendingCursorAfter(offset + rows.length) : null;
  } else {
    ({ rows, nextCursor } = await listRounds(handle, { ...filters, sort: sort.value, cursor: cursor.value, limit: limit.value }));
  }

  if (format.value === "csv") {
    return new Response(toCsv(rows), {
      headers: {
        ...readHeaders(insider),
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="rounds.csv"',
        // More rows than the file holds: the cursor picks up where it stopped.
        ...(nextCursor ? { "x-next-cursor": nextCursor, "access-control-expose-headers": "x-next-cursor" } : {}),
      },
    });
  }
  const marks = await trendingMarks(
    handle,
    rows.map((r) => r.id),
  );
  const withTrending = rows.map((r) => ({ ...(insider ? r : publicRound(r)), trending: marks.get(r.id) ?? null }));
  if (format.value === "jsonl") {
    return new Response(`${withTrending.map((r) => JSON.stringify(r)).join("\n")}\n`, {
      headers: { ...readHeaders(insider), "content-type": "application/x-ndjson" },
    });
  }
  const named = p.get("company") ?? p.get("q");
  const candidates =
    rows.length === 0 && !cursor.value && named
      ? [...(await didYouMean(handle, "companies", named)), ...(p.get("company") ? [] : await didYouMean(handle, "investors", named))]
      : [];
  // A name is one suggestion for q, whether a company, an investor, or both carry it (Anthropic is both).
  const near = candidates.filter((n, i) => candidates.findIndex((m) => m.name.toLowerCase() === n.name.toLowerCase()) === i).slice(0, 3);
  return NextResponse.json(
    { data: withTrending, next_cursor: nextCursor, ...(near.length ? { did_you_mean: near } : {}) },
    { headers: readHeaders(insider) },
  );
}
