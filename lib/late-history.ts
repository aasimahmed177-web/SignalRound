import { type FeedRecord, wireReleaseDay, yieldsToRelease } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { NEWS_WINDOW_DAYS } from "./deliverable.ts";
import { dispositionFor } from "./persist.ts";

const { fundingRounds, roundSources, sources } = schema;

export interface LateHistoryChange {
  id: string;
  announcedOn: string;
  firstSeenAt: string;
  basis: string;
  source: string | null;
}

export async function repairLateHistory(handle: Db, apply = false): Promise<LateHistoryChange[]> {
  const rows = await handle
    .select({
      id: fundingRounds.id,
      announcedOn: fundingRounds.announcedOn,
      firstSeenAt: fundingRounds.firstSeenAt,
      dateBasis: fundingRounds.dateBasis,
      pinned: fundingRounds.pinned,
    })
    .from(fundingRounds)
    .where(
      and(
        eq(fundingRounds.history, false),
        inArray(fundingRounds.disposition, ["publish", "flagged"]),
        eq(fundingRounds.datePrecision, "day"),
        sql`(${fundingRounds.firstSeenAt} AT TIME ZONE 'UTC')::date - ${fundingRounds.announcedOn}::date > ${NEWS_WINDOW_DAYS}`,
        or(
          sql`${fundingRounds.pinned} ? 'announced_on'`,
          and(
            inArray(fundingRounds.dateBasis, ["stated", "page", "url"]),
            sql`${fundingRounds.verification}->>'status' IN ('confirmed', 'corrected')`,
          ),
        ),
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
  const changes = rows.map((r) => {
    const related = links.filter((link) => link.roundId === r.id);
    const source = related.find((link) => link.published?.startsWith(r.announcedOn ?? "")) ?? related[0];
    return {
      id: r.id,
      announcedOn: r.announcedOn as string,
      firstSeenAt: r.firstSeenAt.toISOString().slice(0, 10),
      basis: r.pinned?.announced_on ? "pinned" : (r.dateBasis ?? "none"),
      source: source?.url ?? null,
    };
  });
  if (apply) {
    for (const row of rows)
      await handle
        .update(fundingRounds)
        .set({ announcedOn: sql`${fundingRounds.announcedOn}` })
        .where(and(eq(fundingRounds.id, row.id), eq(fundingRounds.history, false)));
  }
  return changes;
}

export interface ReleaseDayChange {
  id: string;
  from: string | null;
  to: string;
  /** The round left history: the old day had made it a late report, and the release's day is inside the news window. */
  backToFeed: boolean;
  quote: string;
}

/**
 * Re-date stored rounds whose evidence quotes a wire release announcing them today, where the stored day
 * gives way to the release's (yieldsToRelease). A round the reported-later rule moved to history on the
 * old day returns to the feed when the release's day is inside the news window of its first sighting.
 * A pinned day is a person's and stays. A dry run by default.
 */
export async function repairReleaseDays(handle: Db, apply = false): Promise<ReleaseDayChange[]> {
  const rows = await handle
    .select({
      id: fundingRounds.id,
      announcedOn: fundingRounds.announcedOn,
      dateBasis: fundingRounds.dateBasis,
      pinned: fundingRounds.pinned,
      evidence: fundingRounds.evidenceQuotes,
      history: fundingRounds.history,
      hold: fundingRounds.hold,
      verification: fundingRounds.verification,
      firstSeenAt: fundingRounds.firstSeenAt,
    })
    .from(fundingRounds)
    .where(
      and(
        ne(fundingRounds.disposition, "rejected"),
        sql`${fundingRounds.evidenceQuotes}::text ~* '(newswire|presswire|accesswire|prweb|business ?wire|newsfile)'`,
      ),
    );
  const changes: ReleaseDayChange[] = [];
  for (const r of rows) {
    const evidence = r.evidence ?? [];
    const release = wireReleaseDay(evidence);
    if (!release || release === r.announcedOn || r.pinned?.announced_on) continue;
    if (!yieldsToRelease({ announcedOn: r.announcedOn, dateBasis: r.dateBasis }, release)) continue;
    const firstSeen = r.firstSeenAt.toISOString().slice(0, 10);
    const backToFeed =
      r.history &&
      Boolean(r.hold?.startsWith("reported later:")) &&
      (Date.parse(firstSeen) - Date.parse(release)) / 86_400_000 <= NEWS_WINDOW_DAYS;
    changes.push({
      id: r.id,
      from: r.announcedOn,
      to: release,
      backToFeed,
      quote: evidence.find((q) => wireReleaseDay([q]) === release) ?? "",
    });
    if (!apply) continue;
    const verification = r.verification;
    await handle
      .update(fundingRounds)
      .set({
        announcedOn: release,
        datePrecision: "day",
        dateBasis: "stated",
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

export interface ReportedLaterSettle {
  id: string;
  to: "publish" | "flagged";
}

const EARLIEST_REPORT = "held for review: earliest-report search pending";

/**
 * Settle the rows the "reported later" mark froze in review. Before it stopped holding rows (persist's
 * `unheld`), a round its own page dates long before it was first seen went to history with the mark and
 * stayed in review whatever later readings found. Each such row takes the disposition its stored facts
 * give (dispositionFor), unless a doubt of its own still holds it (a namesake, secondhand or unconfirmed
 * sources, a broken invariant) or the publication audit failed it. The earliest-report search a feed row
 * waits for is not owed by a history row, so that note alone comes off. A dry run by default.
 */
export async function settleReportedLater(handle: Db, apply = false): Promise<ReportedLaterSettle[]> {
  const rows = await handle
    .select({
      id: fundingRounds.id,
      announcedOn: fundingRounds.announcedOn,
      confidence: fundingRounds.confidence,
      amountAsWritten: fundingRounds.amountAsWritten,
      verification: fundingRounds.verification,
      audit: fundingRounds.audit,
    })
    .from(fundingRounds)
    .where(
      and(eq(fundingRounds.disposition, "review"), eq(fundingRounds.history, true), sql`${fundingRounds.hold} LIKE 'reported later:%'`),
    );
  const changes: ReportedLaterSettle[] = [];
  for (const r of rows) {
    const notes = r.verification?.notes ?? [];
    if (r.audit?.status === "fail" || notes.some((n) => n.startsWith("held for review:") && n !== EARLIEST_REPORT)) continue;
    const to = dispositionFor({
      undated: r.announcedOn === null,
      confidence: Number(r.confidence),
      amount: { as_written: r.amountAsWritten },
      verification: (r.verification as FeedRecord["verification"]) ?? undefined,
    });
    if (to === "review") continue;
    changes.push({ id: r.id, to });
    if (!apply) continue;
    const verification = r.verification && { ...r.verification, notes: notes.filter((n) => n !== EARLIEST_REPORT) };
    await handle
      .update(fundingRounds)
      .set({ disposition: to, verification, updatedAt: new Date() })
      .where(and(eq(fundingRounds.id, r.id), eq(fundingRounds.disposition, "review")));
  }
  return changes;
}
