// Lane 1: the sweep. Search cheaply across every query, merge and dedupe the
// URLs, then extract each unique page once. This is the weekly recall pass.
// https://docs.firecrawl.dev/features/search

import type { Preset } from "../presets/types.ts";
import type { Window } from "../records/normalize.ts";
import {
  canonicalUrl,
  isArticleUrl,
  isDirectoryTitle,
  resolveWindowStartFor,
  tbsFor,
  windowEndFor,
  windowQueryHint,
} from "../records/normalize.ts";
import type { ResolveOptions, ResolveResult } from "../records/resolve.ts";
import { resolveRounds } from "../records/resolve.ts";
import { STAGE_BANDS } from "../records/routing.ts";
import type { Stage } from "../records/stages.ts";
import type { Document, NativeWebClient, SearchResultNews, SearchResultWeb } from "../web/client.ts";
import { CreditTally, mapLimit, searchCredits } from "./credits.ts";
import type { ExtractOptions, ExtractResult, ExtractTarget } from "./extract.ts";
import { extractRounds } from "./extract.ts";

export interface Candidate extends ExtractTarget {
  queries: string[];
  kinds: Array<"news" | "web" | "x">;
}

/**
 * One candidate per configured X account (the first `max` of them): its profile page, whose
 * latest posts the extractor reads as a dated timeline.
 */
export function xProfileCandidates(preset: Preset, max = preset.xAccounts.length): Candidate[] {
  return preset.xAccounts.slice(0, Math.max(0, max)).map((handle) => ({
    url: `https://x.com/${handle}`,
    title: `@${handle} on X`,
    query: `x:@${handle}`,
    queries: [`x:@${handle}`],
    kinds: ["x" as const],
  }));
}

export type SearchSource = Preset["sources"][number];

/** The preset's sources inside the allowed set; a preset narrower than the ceiling stays narrow, one outside it takes the ceiling. */
export function effectiveSources(preset: Preset, allowed: SearchSource[] | undefined): SearchSource[] {
  if (!allowed) return preset.sources;
  const inside = preset.sources.filter((s) => allowed.includes(s));
  return inside.length > 0 ? inside : allowed;
}

export interface SearchOptions {
  /** Sources the run may use; the coverage rung's ceiling. */
  sources?: SearchSource[];
  /** How many of the preset's X accounts to read; the coverage rung's ceiling. */
  xAccountsMax?: number;
  /** The instant a month window is measured from; defaults to now. */
  now?: Date;
}

/** The preset's queries as searched: a past month appends its name, so the year-wide `tbs` lands on the month. */
export function searchQueries(preset: Preset, window: Window, now: Date = new Date()): string[] {
  const hint = windowQueryHint(window, now);
  return hint ? preset.queries.map((q) => `${q} ${hint}`) : preset.queries;
}

/**
 * A search result with the rules' decision on it (an article URL and no directory title): what the
 * classifier's reading is compared against (lib/jev-shadow.ts). `heldByTitle` marks an article URL the
 * directory-title rule alone declined: the only kind of drop the classifier may overturn.
 */
export interface ScreenedResult {
  url: string;
  title?: string;
  snippet?: string;
  kept: boolean;
  heldByTitle?: boolean;
}

export interface SearchStepResult {
  candidates: Candidate[];
  resultCount: number;
  creditsEstimated: number;
  raw: Array<{ query: string; result: unknown }>;
  /** Result URLs that are not articles (site roots, section indexes, paginated lists, directory hosts), declined before extraction. */
  dropped: { notArticle: number };
  /** Every web and news result once, with the rules' decision. */
  screened: ScreenedResult[];
  /** Article results the directory-title rule alone declined, for the classifier to rescue. */
  heldByTitle: Candidate[];
}

/**
 * The search results that can be articles, as candidates, and the count of those that cannot.
 * A search for "seed funding" returns a directory's "Top Pre-Seed Investors" page, a site's
 * `/funding-rounds` index, and page 146 of a fundraising-news list beside the articles; none of
 * them reports a round, and each would cost five credits to learn that.
 */
export function articleCandidates(candidates: Iterable<Candidate>): { kept: Candidate[]; notArticle: number; heldByTitle: Candidate[] } {
  const kept: Candidate[] = [];
  const heldByTitle: Candidate[] = [];
  let notArticle = 0;
  for (const c of candidates) {
    const article = isArticleUrl(c.url);
    if (article && !isDirectoryTitle(c.title)) kept.push(c);
    else {
      notArticle++;
      if (article) heldByTitle.push(c);
    }
  }
  return { kept, notArticle, heldByTitle };
}

/** Step 1: run the preset's queries and merge the result URLs. No page content yet. */
export async function searchCandidates(
  client: NativeWebClient,
  preset: Preset,
  window: Window,
  options: SearchOptions = {},
): Promise<SearchStepResult> {
  const tally = new CreditTally();
  const candidates = new Map<string, Candidate>();
  const snippets = new Map<string, string>();
  const sources = effectiveSources(preset, options.sources);
  let resultCount = 0;

  const results = await mapLimit(searchQueries(preset, window, options.now), 4, async (query) => {
    const result = await client.search(query, {
      sources,
      tbs: tbsFor(window),
      limit: preset.limit,
      highlights: false,
      ...(preset.excludeDomains.length ? { excludeDomains: preset.excludeDomains } : {}),
      ...(preset.includeDomains.length ? { includeDomains: preset.includeDomains } : {}),
    });
    return { query, result };
  });

  for (const { query, result } of results) {
    let count = 0;
    for (const kind of sources) {
      const list = (result[kind] ?? []) as Array<SearchResultWeb | SearchResultNews | Document>;
      for (const item of list) {
        const url = "url" in item ? item.url : (item as Document).metadata?.sourceURL;
        if (!url) continue;
        count++;
        const key = canonicalUrl(url);
        const title = "title" in item ? item.title : (item as Document).metadata?.title;
        const published = "date" in item ? (item as SearchResultNews).date : undefined;
        const snippet =
          "description" in item
            ? (item as SearchResultWeb).description
            : "snippet" in item
              ? (item as SearchResultNews).snippet
              : undefined;
        if (snippet && !snippets.has(key)) snippets.set(key, snippet);
        const existing = candidates.get(key);
        if (existing) {
          if (!existing.queries.includes(query)) existing.queries.push(query);
          if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
          existing.published ??= published;
          existing.title ??= title;
        } else {
          candidates.set(key, { url, title, published, query, queries: [query], kinds: [kind] });
        }
      }
    }
    resultCount += count;
    tally.add(`search "${query}"`, searchCredits(count));
  }

  // X profiles are candidates too; their cost is extraction, priced by extractRounds.
  const articles = articleCandidates(candidates.values());
  const kept = new Set(articles.kept.map((c) => canonicalUrl(c.url)));
  const held = new Set(articles.heldByTitle.map((c) => canonicalUrl(c.url)));
  return {
    candidates: [...articles.kept, ...xProfileCandidates(preset, options.xAccountsMax)],
    resultCount,
    creditsEstimated: tally.total(),
    raw: results,
    dropped: { notArticle: articles.notArticle },
    screened: [...candidates.entries()].map(([key, c]) => ({
      url: c.url,
      title: c.title,
      snippet: snippets.get(key),
      kept: kept.has(key),
      heldByTitle: held.has(key),
    })),
    heldByTitle: articles.heldByTitle,
  };
}

/**
 * How a scheduled sweep resolves what it read: every stage a preset keeps and a stageless round of any
 * size (the caller files each record under the preset that keeps it), over the window's resolve span
 * (three days for the day window). A lettered round of another preset's stage used to be dropped here
 * after its page was paid for and marked read.
 */
export function sweepResolveOptions(
  stages: readonly Stage[],
  window: Window,
  anchor: Date,
): Pick<ResolveOptions, "stages" | "stagelessBands" | "windowStart" | "windowEnd"> {
  return {
    stages: [...stages],
    stagelessBands: STAGE_BANDS,
    windowStart: resolveWindowStartFor(window, anchor),
    windowEnd: windowEndFor(window, anchor),
  };
}

export interface SweepResult extends ResolveResult {
  window: Window;
  windowStart: Date;
  /** Exclusive; only a month window has one. */
  windowEnd: Date | undefined;
  search: SearchStepResult;
  extraction: ExtractResult;
  creditsEstimated: number;
}

export interface SweepOptions {
  window?: Window;
  now?: Date;
  resolve?: Partial<Omit<ResolveOptions, "stages" | "windowStart" | "windowEnd" | "now">>;
  onPage?: ExtractOptions["onPage"];
}

/** The whole lane: search, extract once per unique URL, resolve into records. */
export async function sweep(client: NativeWebClient, preset: Preset, opts: SweepOptions = {}): Promise<SweepResult> {
  const window = opts.window ?? "week";
  const now = opts.now ?? new Date();
  const windowStart = resolveWindowStartFor(window, now);
  const windowEnd = windowEndFor(window, now);
  const search = await searchCandidates(client, preset, window, { now });
  const extraction = await extractRounds(client, search.candidates, { onPage: opts.onPage });
  const resolved = resolveRounds(extraction.items, { stages: preset.stages, windowStart, windowEnd, now, ...opts.resolve });
  return {
    ...resolved,
    window,
    windowStart,
    windowEnd,
    search,
    extraction,
    creditsEstimated: search.creditsEstimated + extraction.creditsEstimated,
  };
}
