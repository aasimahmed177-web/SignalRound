// What may go out as news. Every enqueue path (delivery targets and Slack subscriptions) and every
// sender (the outbox flush for Slack targets, webhooks, and the email digest; the instant subscription
// flush; the public daily digest) asks here, so one rule decides whether a round is sent, whatever the
// channel.

import { reconcileProviderFor } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { inArray } from "drizzle-orm";

const { roundMerges } = schema;

/**
 * A round announced more than this many days before the moment of sending is not news, whatever day
 * the pipeline found it. The pre-launch audit's late deliveries ran 6 to 8 days after the announcement
 * (a sweep's day window, a list's week); two weeks leaves room for those and none for a re-dated or
 * re-reported round from last month.
 */
export const NEWS_WINDOW_DAYS = 14;

/** The facts the rule reads off a round. */
export interface NewsFacts {
  id: string;
  disposition: "publish" | "flagged" | "review" | "rejected";
  history: boolean;
  hold: string | null;
  verification: { status: string } | null;
  /** YYYY-MM-DD, or null when undated. */
  announced_on: string | null;
  /** day, week, month, or unknown: a week or a month is a list's bucket. */
  date_precision: string;
  sources: unknown[];
  certainty: "announced" | "reported" | "expected" | "unconfirmed";
}

/** Certainty is scoped to a destination; newsBlocks remains the common trust and freshness gate. */
export function acceptsCertainty(round: Pick<NewsFacts, "certainty">, includeExpected: boolean): boolean {
  return round.certainty === "announced" || round.certainty === "reported" || (round.certainty === "expected" && includeExpected);
}

/**
 * Whether a round's day is more than NEWS_WINDOW_DAYS before `now`. An undated round is not judged
 * here (it starts in review, and a person places it). The stored day is taken as it stands, a week's
 * or a month's included: a list's day is never earlier than the round it lists.
 */
export function staleForNews(announcedOn: string | null, now: Date): boolean {
  if (!announcedOn) return false;
  const at = new Date(`${announcedOn}T00:00:00Z`).getTime();
  if (Number.isNaN(at)) return false;
  return now.getTime() - at > (NEWS_WINDOW_DAYS + 1) * 86_400_000;
}

/**
 * Why each of these rounds must not be sent, by id; a round absent from the map may go. Only a visible
 * round (published or flagged) goes, never a history round, never a held one (a lead source shows it is
 * a late re-report, lib/late-report.ts), never one announced more than NEWS_WINDOW_DAYS before `now`
 * (the moment of sending: a round queued in time and sent late is judged when it goes), never one whose
 * only date is one roundup's, digest's, or newsletter's week or month (an upper bound, not the day: it
 * waits for a second source), and never one
 * whose id is a merge tombstone (a rebuilt copy that slipped past persist: the survivor already went out).
 */
export async function newsBlocks(handle: Db, rows: NewsFacts[], now: Date = new Date()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // Without a model key there is no read-back to wait for, so a self-hosted instance still delivers.
  const readBack = reconcileProviderFor() !== null;
  for (const r of rows) {
    if (r.history) out.set(r.id, "history round: never delivered");
    else if (r.certainty === "unconfirmed") out.set(r.id, "unconfirmed round: never delivered");
    else if (r.hold) out.set(r.id, r.hold);
    else if (r.disposition !== "publish" && r.disposition !== "flagged") out.set(r.id, `${r.disposition}: never delivered`);
    else if (readBack && r.verification?.status !== "confirmed" && r.verification?.status !== "corrected")
      out.set(r.id, "read-back has not confirmed this round: not delivered");
    else if (staleForNews(r.announced_on, now))
      out.set(r.id, `announced ${r.announced_on}, more than ${NEWS_WINDOW_DAYS} days before sending: not news`);
    else if ((r.date_precision === "week" || r.date_precision === "month") && r.sources.length < 2)
      out.set(
        r.id,
        `dated only by one list's ${r.date_precision} (${r.announced_on}): not delivered until a second source corroborates it`,
      );
  }
  const ids = [...new Set(rows.map((r) => r.id))];
  if (ids.length === 0) return out;
  const merged = await handle
    .select({ droppedId: roundMerges.droppedId, keptId: roundMerges.keptId })
    .from(roundMerges)
    .where(inArray(roundMerges.droppedId, ids));
  for (const m of merged) out.set(m.droppedId, `merged into ${m.keptId}: never delivered`);
  return out;
}

/** The rounds newsBlocks lets through, in their order. */
export async function deliverableRounds<T extends NewsFacts>(handle: Db, rows: T[], now: Date = new Date()): Promise<T[]> {
  const blocks = await newsBlocks(handle, rows, now);
  return rows.filter((r) => !blocks.has(r.id));
}
