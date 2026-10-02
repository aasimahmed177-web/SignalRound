import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { NEWS_WINDOW_DAYS } from "./deliverable.ts";

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
