// Stored X posts judged again under today's relevance rule (packages/core/src/trending/signals.ts
// classifyX): a post must name the company where it talks about the round, and a one-word name needs
// a sign that it means this company. Posts stored under the older rule counted a shared word
// ("Millie's mum discovered a raised lymph node" sat under Millie's Series A as its one post on X).
// Only demotes: a post the old rule dropped stays dropped. `pnpm prune-trending-posts` runs it.

import type { RoundSubject, XResult } from "@fireround/core";
import { amountTokens, classifyX, mentions, nameAliases } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray } from "drizzle-orm";

const { trendingPosts, trendingRounds, fundingRounds, companies, roundInvestors, investors } = schema;

export interface TrendingDemotion {
  roundId: string;
  postKey: string;
  handle: string | null;
  url: string;
  snippet: string;
}

/**
 * The stored post as the rule reads a search result: the author's name where the title carried it,
 * then the snippet. The original title and description are gone, so this is the closest reading the
 * store allows; a post it cannot place stays as it is only if the rule still finds it relevant.
 */
function asResult(p: typeof trendingPosts.$inferSelect): XResult {
  return {
    kind: p.kind === "profile" ? "profile" : "post",
    statusId: p.statusId,
    handle: p.handle,
    name: p.authorName,
    url: p.url,
    text: `${p.authorName ? `${p.authorName} on X: ` : ""}${p.snippet}`,
    snippet: p.snippet,
    postedAt: p.postedAt,
  };
}

/** Whether the stored words name the company (its name, an alias, or its @handle) at all. */
function fundingNameSeen(text: string, s: RoundSubject): boolean {
  return [s.name, ...s.aliases].some((n) => mentions(text, n)) || (!!s.handle && text.toLowerCase().includes(`@${s.handle}`));
}

/** Every stored relevant post today's rule would not keep, reading only. */
export async function planTrendingPrune(handle: Db): Promise<{ checked: number; demote: TrendingDemotion[] }> {
  const posts = await handle.select().from(trendingPosts).where(eq(trendingPosts.relevant, true));
  const roundIds = [...new Set(posts.map((p) => p.roundId))];
  if (roundIds.length === 0) return { checked: 0, demote: [] };
  const [rounds, leads] = await Promise.all([
    handle
      .select({ r: fundingRounds, c: companies, xHandle: trendingRounds.xHandle })
      .from(fundingRounds)
      .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
      .leftJoin(trendingRounds, eq(trendingRounds.roundId, fundingRounds.id))
      .where(inArray(fundingRounds.id, roundIds)),
    handle
      .select({ roundId: roundInvestors.roundId, name: investors.name })
      .from(roundInvestors)
      .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
      .where(and(inArray(roundInvestors.roundId, roundIds), eq(roundInvestors.role, "lead"))),
  ]);
  const leadsOf = new Map<string, string[]>();
  for (const l of leads) leadsOf.set(l.roundId, [...(leadsOf.get(l.roundId) ?? []), l.name]);
  const subjects = new Map<string, RoundSubject>(
    rounds.map(({ r, c, xHandle }) => [
      r.id,
      {
        name: c.name,
        aliases: nameAliases(c.name),
        handle: xHandle ?? null,
        amounts: amountTokens({
          asWritten: r.amountAsWritten,
          value: r.amountValue === null ? null : Number(r.amountValue),
          currency: r.amountCurrency,
          usdMillions: r.amountUsdMillions === null ? null : Number(r.amountUsdMillions),
        }),
        announced: r.announcedOn ?? r.firstSeenAt.toISOString().slice(0, 10),
        domain: c.domain,
        leadInvestors: leadsOf.get(r.id) ?? [],
        description: c.description,
      },
    ]),
  );
  const demote: TrendingDemotion[] = [];
  for (const p of posts) {
    const subject = subjects.get(p.roundId);
    if (!subject) continue;
    const result = asResult(p);
    // The stored words are the snippet, not the title the post was first judged with: a post whose
    // snippet never names the company (its name was in the title) cannot be judged again, and stays.
    if (!fundingNameSeen(result.text, subject)) continue;
    // The window was checked when the post was stored; the rule is judged again on its words alone.
    const reading = classifyX({ ...result, kind: "profile" }, subject);
    if (!reading.relevant) demote.push({ roundId: p.roundId, postKey: p.postKey, handle: p.handle, url: p.url, snippet: p.snippet });
  }
  return { checked: posts.length, demote };
}

/** Mark the planned posts irrelevant; the rows stay, so a later rule change can read them again. */
export async function applyTrendingPrune(handle: Db, demote: TrendingDemotion[]): Promise<number> {
  let n = 0;
  for (const d of demote) {
    const done = await handle
      .update(trendingPosts)
      .set({ relevant: false })
      .where(and(eq(trendingPosts.roundId, d.roundId), eq(trendingPosts.postKey, d.postKey)))
      .returning({ postKey: trendingPosts.postKey });
    n += done.length;
  }
  return n;
}
