// The Trending lane as a durable run, hourly. Follow every visible round first seen in the last 72
// hours; search the ones a checkpoint has come for (first seen, +6h, +24h, +48h) on X with Firecrawl
// search; ask Hacker News about the ones due; rescore every followed round from what is stored (so
// the decay stays current without a credit); read likes and reposts for the labelled rounds' top
// posts through Firecrawl's X scrape; record the run. Each step is idempotent: posts upsert by
// status id and a checkpoint is marked done with the posts it found.

import type { HnStory } from "@fireround/core";
import { aboutRound, hnStories, homepageHandles, readXPost, searchRoundOnX } from "@fireround/core";
import { db } from "@/lib/db";
import { invalidateAllEntityPages } from "@/lib/entity-invalidation";
import { getFirecrawl } from "@/lib/firecrawl";
import { recordRun } from "@/lib/persist";
import {
  dueCheckpoint,
  estimateRun,
  type FollowedRound,
  followRounds,
  hnDue,
  knownHandle,
  labelledRoundIds,
  rescore,
  type ShowcaseTarget,
  searchDue,
  showcaseTargets,
  storeEngagement,
  storeHn,
  storeSearch,
  subjectOf,
} from "@/lib/trending";

/** Rounds searched per step: a few seconds each, so a step stays well inside a function's time. */
const SEARCH_BATCH = 6;
/** Rounds asked of Hacker News per step (two requests each at most). */
const HN_BATCH = 20;
/** Posts read per step through the X scrape (about four seconds each). */
const SHOWCASE_BATCH = 6;
/** The run row's preset column: the lane owns it, as Form D owns `form-d`. */
export const TRENDING_PRESET_SLUG = "trending";

export interface TrendingSummary {
  runId: string;
  followed: number;
  searched: number;
  scored: number;
  labelled: number;
  creditsEstimated: number;
  creditsMeasured: number;
}

interface Plan {
  followed: number;
  due: FollowedRound[];
  hnDue: FollowedRound[];
  showcase: number;
  estimate: number;
}

export async function trendingWorkflow(runId: string): Promise<TrendingSummary> {
  "use workflow";
  const startedAt = new Date().toISOString();
  const plan = await planStep(startedAt);
  const counts: Record<string, number> = {
    followed: plan.followed,
    due: plan.due.length,
    searched: 0,
    queries: 0,
    results: 0,
    posts: 0,
    posts_relevant: 0,
    handle_lookups: 0,
    handles_found: 0,
    search_errors: 0,
    hn_checked: 0,
    hn_stories: 0,
  };
  let credits = 0;
  for (let i = 0; i < plan.due.length; i += SEARCH_BATCH) {
    const r = await searchStep(plan.due.slice(i, i + SEARCH_BATCH), startedAt);
    for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + v;
    credits += r.credits;
  }
  for (let i = 0; i < plan.hnDue.length; i += HN_BATCH) {
    const r = await hnStep(plan.hnDue.slice(i, i + HN_BATCH));
    counts.hn_checked += r.checked;
    counts.hn_stories += r.stories;
  }
  const scored = await scoreStep();
  counts.scored = scored.scored;
  counts.labelled = scored.labelled.length;
  counts.stale = scored.stale;
  counts.people = scored.people;
  const targets = await showcasePlanStep(scored.labelled);
  counts.showcase_reads = 0;
  counts.showcase_errors = 0;
  for (let i = 0; i < targets.length; i += SHOWCASE_BATCH) {
    const r = await showcaseStep(targets.slice(i, i + SHOWCASE_BATCH));
    counts.showcase_reads += r.read;
    counts.showcase_errors += r.errors;
    credits += r.credits;
  }
  await recordRunStep({ id: runId, startedAt, estimate: plan.estimate, measured: credits, counts });
  return {
    runId,
    followed: plan.followed,
    searched: counts.searched,
    scored: scored.scored,
    labelled: scored.labelled.length,
    creditsEstimated: plan.estimate,
    creditsMeasured: credits,
  };
}

/** Take up the window's rounds and say which are due a search, which a Hacker News read, and what that should cost. */
async function planStep(startedAt: string): Promise<Plan> {
  "use step";
  const handle = await db();
  const now = new Date(startedAt);
  const followed = await followRounds(handle, now);
  const due = followed.filter((r) => searchDue(r.checkpoints, new Date(r.firstSeenAt), now));
  // A round searched this run gets its Hacker News read with it; the rest when theirs is stale.
  const hn = followed.filter((r) => hnDue(r, now) || due.includes(r));
  // The showcase reads are priced for the rounds labelled now; the rescore may move one in or out.
  const labelledNow = await labelledRoundIds(handle, now);
  const showcase = (await showcaseTargets(handle, labelledNow, now)).length;
  return { followed: followed.length, due, hnDue: hn, showcase, estimate: estimateRun(due, showcase) };
}

/**
 * Search each round on X. A round with no handle on record has its homepage links read once (or
 * borrows the handle another round of the company found); a failure on one round is counted and
 * leaves its checkpoint open for the next run.
 */
async function searchStep(rounds: FollowedRound[], startedAt: string): Promise<{ credits: number; counts: Record<string, number> }> {
  "use step";
  const handle = await db();
  const client = getFirecrawl();
  const plannedAt = new Date(startedAt);
  let credits = 0;
  const counts: Record<string, number> = {
    searched: 0,
    queries: 0,
    results: 0,
    posts: 0,
    posts_relevant: 0,
    handle_lookups: 0,
    handles_found: 0,
    search_errors: 0,
  };
  for (const r of rounds) {
    const now = new Date();
    let candidates: string[] = [];
    let handleChecked = false;
    if (!r.handleCheckedAt) {
      handleChecked = true;
      const known = await knownHandle(handle, r.companyId, now);
      if (known) {
        candidates = known.handle ? [known.handle] : [];
      } else if (r.website) {
        const h = await homepageHandles(client, r.website);
        credits += h.credits;
        counts.handle_lookups++;
        candidates = h.handles;
      }
    }
    const source: "homepage" | "search" | null = r.xHandleSource === "homepage" || r.xHandleSource === "search" ? r.xHandleSource : null;
    const verified = r.xHandle && source ? { handle: r.xHandle, source } : null;
    const result = await searchRoundOnX(client, subjectOf({ ...r, xHandle: null }), { verified, candidates }, now);
    credits += result.credits;
    counts.queries += result.calls.length;
    counts.results += result.calls.reduce((n, c) => n + c.results, 0);
    if (result.calls.every((c) => c.error)) {
      counts.search_errors++;
      continue;
    }
    counts.searched++;
    counts.posts += result.hits.length;
    counts.posts_relevant += result.hits.filter((h) => h.relevant).length;
    if (result.handle && !verified) counts.handles_found++;
    await storeSearch(handle, r.roundId, result, dueCheckpoint(new Date(r.firstSeenAt), plannedAt), now, handleChecked);
  }
  if (counts.searched) await invalidateAllEntityPages();
  return { credits, counts };
}

/** Hacker News for each round: free, so a failed request is simply no stories this time. */
async function hnStep(rounds: FollowedRound[]): Promise<{ checked: number; stories: number }> {
  "use step";
  const handle = await db();
  let stories = 0;
  for (const r of rounds) {
    const s = subjectOf(r);
    const found: HnStory[] = await hnStories(s, r.domain);
    stories += found.length;
    await storeHn(handle, r.roundId, found.slice(0, 5), new Date());
  }
  if (rounds.length) await invalidateAllEntityPages();
  return { checked: rounds.length, stories };
}

/** The hourly rescore from stored posts, press sources, and stories; no Firecrawl call. */
async function scoreStep(): Promise<{ scored: number; labelled: string[]; stale: number; people: number }> {
  "use step";
  const result = await rescore(await db(), new Date());
  if (result.scored || result.stale) await invalidateAllEntityPages();
  return result;
}

async function showcasePlanStep(labelled: string[]): Promise<ShowcaseTarget[]> {
  "use step";
  return showcaseTargets(await db(), labelled, new Date());
}

/** Likes and reposts for the labelled rounds' top posts, each read at most every six hours. */
async function showcaseStep(targets: ShowcaseTarget[]): Promise<{ read: number; errors: number; credits: number }> {
  "use step";
  const handle = await db();
  const client = getFirecrawl();
  let read = 0;
  let errors = 0;
  let credits = 0;
  for (const t of targets) {
    const r = await readXPost(client, t.url);
    credits += r.credits;
    if (!r.post) {
      errors++;
      continue;
    }
    read++;
    // The post's own words replace the search snippet only when they are about the round (a quote post's comment is
    // not); the company's own post needs no name to be about its round.
    const text = r.post.text && !r.post.isRetweet && (t.self || aboutRound(r.post.text, t.subject)) ? r.post.text : null;
    await storeEngagement(handle, t, { likes: r.post.likes, reposts: r.post.reposts, text }, new Date());
  }
  if (read) await invalidateAllEntityPages();
  return { read, errors, credits };
}

/**
 * The run's row on Runs. Credits measured are the sum each call reported (search bills per ten
 * results returned, the scrape reports its own), not the account balance: the account is shared
 * with every other lane running at the same hour.
 */
async function recordRunStep(run: {
  id: string;
  startedAt: string;
  estimate: number;
  measured: number;
  counts: Record<string, number>;
}): Promise<void> {
  "use step";
  await recordRun(await db(), {
    id: run.id,
    presetSlug: TRENDING_PRESET_SLUG,
    lane: "trending",
    window: null,
    startedAt: new Date(run.startedAt),
    finishedAt: new Date(),
    creditsEstimated: run.estimate,
    creditsMeasured: run.measured,
    counts: run.counts,
  });
}
