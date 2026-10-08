import { dateFromUrl, extractRounds, normalizeCompanyKey, parseStatedDate } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { NEWS_WINDOW_DAYS } from "./deliverable.ts";

const DAY_MS = 86_400_000;
/** Pages this close together tell of one news cycle. */
const CYCLE_DAYS = 3;

export interface PageYearChange {
  id: string;
  from: string;
  to: string;
  /** The round left history: the guessed year had made it a late report, and the new day is inside the news window. */
  backToFeed: boolean;
}

/**
 * The day a round's pages tell of: the earliest day two of them fall within a few days of, else the only
 * dated page's day, else the earliest. A lone stale page (a roundup dated weeks before the story) does
 * not lead a cluster of the round's coverage.
 */
function coverageDay(days: string[]): string {
  const sorted = [...days].sort();
  const t = (d: string) => Date.parse(`${d}T12:00:00Z`);
  return sorted.find((d, i) => sorted.some((o, j) => j !== i && Math.abs(t(o) - t(d)) <= CYCLE_DAYS * DAY_MS)) ?? (sorted[0] as string);
}

/** Reads a page's text, or null when it cannot be read. */
export type PageReader = (url: string) => Promise<string | null>;

/** A round's pages to read again: their URL, title, and the day stored for them. */
export interface ReadTarget {
  url: string;
  title: string | null;
  published: string | null;
}

/** Reads a round's pages again under today's rules and returns the days they give the company's own round. */
export type PageDater = (pages: ReadTarget[], company: string) => Promise<string[]>;

/**
 * A PageDater on the extractor: each page is read once more (a cached copy up to a month old will do), and
 * a reading of the company's round that is not background gives its day, else its page's day. A page
 * that recalls the round as history dates the page, not the round, so it gives nothing.
 */
export function extractionDater(client: Firecrawl): PageDater {
  return async (pages, company) => {
    const read = await extractRounds(
      client,
      pages.map((p) => ({ url: p.url, title: p.title ?? undefined, published: p.published ?? undefined })),
      { concurrency: 2, maxAge: 30 * DAY_MS },
    );
    const key = normalizeCompanyKey(company);
    return read.items.flatMap((item) => {
      const named = normalizeCompanyKey(item.round.company_name ?? "");
      if (item.round.is_background || !named || !(named === key || named.startsWith(`${key} `) || key.startsWith(`${named} `))) return [];
      const day = parseStatedDate(item.round.announced_date) ?? parseStatedDate(item.page_date ?? null);
      return day ? [day.toISOString().slice(0, 10)] : [];
    });
  };
}

/** Undated pages read per round: the year check needs the pages that could have dated it, not every copy. */
const MAX_READS = 5;

/**
 * Re-date stored rounds whose day an extractor gave a year of its own (guessedYear): a day borrowed from
 * a page, not stated, whose year no source of the round is dated in and none of its undated pages writes
 * (each is read once more to check). The day the round's sources tell of replaces it (coverageDay). A
 * round the reported-later rule moved to history on the guessed day returns to the feed when the new day
 * is inside the news window of its first sighting. A pinned day stays, and so does a round whose sources
 * carry no day at all, or an undated page that could not be read. A dry run by default.
 *
 * With `reread`, the round's pages are read again under today's extraction rules instead, and they
 * decide: the round moves to the day the readings tell of (coverageDay) when that day is in another
 * year; one stale page in the stored year does not hold it back when the rest agree elsewhere. `ids` names the rounds to re-read; without it, the
 * rounds no dated source of which is in the stored year.
 */
export async function repairPageYears(
  handle: Db,
  read: PageReader,
  apply = false,
  opts: { reread?: PageDater; ids?: string[] } = {},
): Promise<PageYearChange[]> {
  const { fundingRounds, roundSources, sources, companies } = schema;
  const rows = await handle
    .select({
      id: fundingRounds.id,
      announcedOn: fundingRounds.announcedOn,
      pinned: fundingRounds.pinned,
      history: fundingRounds.history,
      hold: fundingRounds.hold,
      verification: fundingRounds.verification,
      firstSeenAt: fundingRounds.firstSeenAt,
      company: companies.name,
    })
    .from(fundingRounds)
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    .where(
      and(
        opts.ids ? inArray(fundingRounds.id, opts.ids) : undefined,
        ne(fundingRounds.disposition, "rejected"),
        // A re-read dates a round a list put in its week or month too.
        opts.reread ? inArray(fundingRounds.datePrecision, ["day", "week", "month"]) : eq(fundingRounds.datePrecision, "day"),
        inArray(fundingRounds.dateBasis, ["page", "none"]),
        isNotNull(fundingRounds.announcedOn),
      ),
    );
  if (rows.length === 0) return [];
  const links = await handle
    .select({ roundId: roundSources.roundId, url: sources.url, title: sources.title, published: sources.publishedAt })
    .from(roundSources)
    .innerJoin(sources, eq(sources.id, roundSources.sourceId))
    .where(
      inArray(
        roundSources.roundId,
        rows.map((r) => r.id),
      ),
    );
  const changes: PageYearChange[] = [];
  for (const r of rows) {
    const day = r.announcedOn as string;
    if (r.pinned?.announced_on || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const pages = links
      .filter((l) => l.roundId === r.id)
      .map((l) => ({ ...l, day: dateFromUrl(l.url) ?? (l.published ? parseStatedDate(l.published) : null) }));
    const days = pages.flatMap((p) => (p.day ? [p.day.toISOString().slice(0, 10)] : []));
    const year = day.slice(0, 4);
    let to: string;
    if (opts.reread) {
      if (!opts.ids && days.some((d) => d.startsWith(year))) continue;
      const readDays = await opts.reread(pages.slice(0, MAX_READS), r.company);
      if (readDays.length === 0) continue;
      to = coverageDay(readDays);
      if (to.startsWith(year)) continue;
    } else {
      if (days.length === 0 || days.some((d) => d.startsWith(year))) continue;
      const undated = pages.filter((p) => !p.day);
      if (undated.length > MAX_READS) continue;
      const texts = await Promise.all(undated.map((p) => read(p.url)));
      if (texts.some((t) => t === null || new RegExp(`\\b${year}\\b`).test(t))) continue;
      to = coverageDay(days);
    }
    const firstSeen = r.firstSeenAt.toISOString().slice(0, 10);
    const backToFeed =
      r.history &&
      Boolean(r.hold?.startsWith("reported later:")) &&
      Math.abs(Date.parse(firstSeen) - Date.parse(to)) / DAY_MS <= NEWS_WINDOW_DAYS;
    changes.push({ id: r.id, from: day, to, backToFeed });
    if (!apply) continue;
    const verification = r.verification;
    await handle
      .update(fundingRounds)
      .set({
        announcedOn: to,
        datePrecision: "day",
        dateBasis: "page",
        ...(backToFeed
          ? {
              history: false,
              hold: null,
              verification: verification && {
                ...verification,
                notes: verification.notes.filter((n) => !n.startsWith("reported later:")),
              },
            }
          : {}),
      })
      .where(eq(fundingRounds.id, r.id));
  }
  return changes;
}
