import { dateFromUrl, parseStatedDate } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
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

/** Undated pages read per round: the year check needs the pages that could have dated it, not every copy. */
const MAX_READS = 5;

/**
 * Re-date stored rounds whose day an extractor gave a year of its own (guessedYear): a day borrowed from
 * a page, not stated, whose year no source of the round is dated in and none of its undated pages writes
 * (each is read once more to check). The day the round's sources tell of replaces it (coverageDay). A
 * round the reported-later rule moved to history on the guessed day returns to the feed when the new day
 * is inside the news window of its first sighting. A pinned day stays, and so does a round whose sources
 * carry no day at all, or an undated page that could not be read. A dry run by default.
 */
export async function repairPageYears(handle: Db, read: PageReader, apply = false): Promise<PageYearChange[]> {
  const { fundingRounds, roundSources, sources } = schema;
  const rows = await handle
    .select({
      id: fundingRounds.id,
      announcedOn: fundingRounds.announcedOn,
      pinned: fundingRounds.pinned,
      history: fundingRounds.history,
      hold: fundingRounds.hold,
      verification: fundingRounds.verification,
      firstSeenAt: fundingRounds.firstSeenAt,
    })
    .from(fundingRounds)
    .where(
      and(
        ne(fundingRounds.disposition, "rejected"),
        eq(fundingRounds.datePrecision, "day"),
        inArray(fundingRounds.dateBasis, ["page", "none"]),
        isNotNull(fundingRounds.announcedOn),
      ),
    );
  if (rows.length === 0) return [];
  const links = await handle
    .select({ roundId: roundSources.roundId, url: sources.url, published: sources.publishedAt })
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
      .map((l) => ({ url: l.url, day: dateFromUrl(l.url) ?? (l.published ? parseStatedDate(l.published) : null) }));
    const days = pages.flatMap((p) => (p.day ? [p.day.toISOString().slice(0, 10)] : []));
    const year = day.slice(0, 4);
    if (days.length === 0 || days.some((d) => d.startsWith(year))) continue;
    const undated = pages.filter((p) => !p.day);
    if (undated.length > MAX_READS) continue;
    const texts = await Promise.all(undated.map((p) => read(p.url)));
    if (texts.some((t) => t === null || new RegExp(`\\b${year}\\b`).test(t))) continue;
    const to = coverageDay(days);
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
