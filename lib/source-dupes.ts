import { samePageKey } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, notExists } from "drizzle-orm";
import { dedupeSources } from "./source-order.ts";

const { roundSources, sources } = schema;

export interface SourceDupe {
  roundId: string;
  /** The spelling the round keeps (dedupeSources' choice). */
  keep: string;
  /** The other spellings of the same page, unlinked from the round. */
  drop: string[];
}

/**
 * Rounds that link one page under two spellings (http and https, with and without www or a trailing
 * slash): each keeps the spelling dedupeSources lists, and the others come off the round, their source
 * row going too when no other round links it. A dry run by default.
 */
export async function dedupeRoundSources(handle: Db, apply = false): Promise<SourceDupe[]> {
  const links = await handle
    .select({ roundId: roundSources.roundId, url: sources.url, title: sources.title, id: sources.id })
    .from(roundSources)
    .innerJoin(sources, eq(sources.id, roundSources.sourceId));
  const byRound = new Map<string, typeof links>();
  for (const l of links) byRound.set(l.roundId, [...(byRound.get(l.roundId) ?? []), l]);
  const dupes: SourceDupe[] = [];
  for (const [roundId, list] of byRound) {
    const kept = new Set(dedupeSources(list));
    for (const k of kept) {
      const drop = list.filter((l) => !kept.has(l) && samePageKey(l.url) === samePageKey(k.url)).map((l) => l.id);
      if (drop.length > 0) dupes.push({ roundId, keep: k.id, drop });
    }
  }
  if (!apply) return dupes;
  for (const d of dupes) {
    await handle.delete(roundSources).where(and(eq(roundSources.roundId, d.roundId), inArray(roundSources.sourceId, d.drop)));
    await handle
      .delete(sources)
      .where(
        and(
          inArray(sources.id, d.drop),
          notExists(handle.select({ id: roundSources.sourceId }).from(roundSources).where(eq(roundSources.sourceId, sources.id))),
        ),
      );
  }
  return dupes;
}
