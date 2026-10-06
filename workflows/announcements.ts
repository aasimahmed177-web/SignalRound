// The X announcements lane as a durable run, hourly. Search X for funding posts from the last few
// hours (X's own index through Alexandria, and web search) and keep each as a lead; then work every lead whose next search is due: the store may
// already hold the round (known); else a search on the company and the amount looks for an article,
// which is read through the normal pipeline (extract, resolve, read-back) and lands under the preset
// that keeps it (corroborated). A lead from a status post whose account the company's own homepage
// links may land on the post alone, flagged and unverified (published), and keeps looking for its
// article. Each lead is searched on a backoff to 48 hours, then expires. Every step is idempotent:
// a lead is keyed by its post, and an attempt writes its outcome and its next due time together.

import type { FeedRecord } from "@fireround/core";
import {
  bioLinksCompany,
  companyFromFounderBio,
  DEFAULT_TIERS,
  domainInText,
  extractRounds,
  fetchRates,
  firecrawlReader,
  founderLandedNote,
  homepageHandles,
  judgeRecords,
  leadAsItem,
  leadMatches,
  profileBio,
  readXPost,
  reconcileModel,
  reconcileRecords,
  registrableDomain,
  resolveRounds,
  STAGE_BANDS,
  searchAnnouncements,
  searchLeadArticles,
  selfPublishable,
  selfPublishedNote,
  settleDate,
  windowStartFor,
  X_ANNOUNCEMENT_QUERIES,
  X_LANDING_MAX_AGE_HOURS,
  xOnlyRecord,
} from "@fireround/core";
import {
  asLead,
  confirmingLeads,
  dueLeads,
  finishAttempt,
  knownRoundFor,
  type LeadOutcome,
  type LeadRow,
  storedWebsite,
  storeLeads,
} from "@/lib/announcements";
import { db } from "@/lib/db";
import { flushDeliveries } from "@/lib/delivery";
import { invalidateEntityPages } from "@/lib/entity-invalidation";
import { getFirecrawl } from "@/lib/firecrawl";
import { type PersistOptions, recordRun } from "@/lib/persist";
import { enqueueRouted, persistRouted, routingTable } from "@/lib/routing";
import { loadAliases, loadPublisherTiers } from "@/lib/rules";
import { getCoverage } from "@/lib/settings";
import { enrichPending } from "@/workflows/enrich";

/** The note a lead keeps once its founder's bio was read and did not link the company, so it is not read again. */
const FOUNDER_BIO_MISS = "founder bio: does not link the company";
/** The note a lead keeps once its full post and its author's bio were read and named no company, so they are not read again. */
const NO_COMPANY = "full post and bio: no company named";
/** The note a lead keeps once its founder's bio linked the company but did not name the account the post names: it waits for a second account. */
const FOUNDER_UNCONFIRMED = "founder bio: links the company; waiting for a second account";

/** Leads worked per step: each is a search and at most three page reads, so a step stays well inside a function's time. */
const ATTEMPT_BATCH = 6;
/** The run row's preset column: the lane owns it, as Trending owns `trending`. */
export const ANNOUNCEMENTS_PRESET_SLUG = "x-announcements";

export interface AnnouncementsSummary {
  runId: string;
  leads: number;
  newLeads: number;
  attempted: number;
  corroborated: number;
  published: number;
  creditsMeasured: number;
}

/**
 * `lookbackHours` is how old a post may be to count (12 on the hourly cadence, 26 on the daily);
 * null skips the search and only works the leads that are due.
 */
export async function announcementsWorkflow(
  runId: string,
  origin: string,
  lookbackHours: number | null = 12,
): Promise<AnnouncementsSummary> {
  "use workflow";
  const startedAt = new Date().toISOString();
  const counts: Record<string, number> = {};
  const add = (more: Record<string, number>) => {
    for (const [k, v] of Object.entries(more)) counts[k] = (counts[k] ?? 0) + v;
  };
  let credits = 0;
  const found = lookbackHours === null ? null : await discoverStep(startedAt, lookbackHours);
  if (found) {
    add(found.counts);
    credits += found.credits;
  }
  const due = await dueStep(startedAt);
  counts.due = due.length;
  const changedByPreset: Record<string, string[]> = {};
  const inserted: Record<string, string[]> = {};
  for (let i = 0; i < due.length; i += ATTEMPT_BATCH) {
    const r = await attemptStep(due.slice(i, i + ATTEMPT_BATCH), runId);
    add(r.counts);
    credits += r.credits;
    for (const [slug, ids] of Object.entries(r.changedByPreset)) changedByPreset[slug] = [...(changedByPreset[slug] ?? []), ...ids];
    for (const [slug, ids] of Object.entries(r.insertedByPreset)) inserted[slug] = [...(inserted[slug] ?? []), ...ids];
  }
  // New companies get their homepage read now, as a sweep's do.
  for (const [slug, ids] of Object.entries(inserted)) {
    const e = await enrichPending(slug, ids.length, { roundIds: ids });
    credits += e.credits + e.alexandriaCredits + e.investorCredits;
    counts.enriched = (counts.enriched ?? 0) + e.companies;
  }
  const queued = await deliverStep(changedByPreset, origin);
  counts.queued = queued;
  // Each query runs twice: a 4-credit web search and a 30-credit search of X's own index through Alexandria.
  const estimate = (found ? X_ANNOUNCEMENT_QUERIES.length * (4 + 30) : 0) + due.length * 2;
  await recordRunStep({ id: runId, startedAt, estimate, measured: credits, counts });
  return {
    runId,
    leads: counts.leads ?? 0,
    newLeads: counts.new_leads ?? 0,
    attempted: counts.attempted ?? 0,
    corroborated: counts.corroborated ?? 0,
    published: counts.published ?? 0,
    creditsMeasured: credits,
  };
}

/** The searches, each result a lead or a counted reason it is not one; new leads are due at once. */
async function discoverStep(startedAt: string, lookbackHours: number): Promise<{ credits: number; counts: Record<string, number> }> {
  "use step";
  const handle = await db();
  const now = new Date(startedAt);
  const r = await searchAnnouncements(getFirecrawl(), now, { lookbackHours });
  const fresh = await storeLeads(handle, r.leads, now);
  const counts: Record<string, number> = {
    searches: r.calls.length,
    search_errors: r.calls.filter((c) => c.error).length,
    results: r.calls.reduce((n, c) => n + c.results, 0),
    leads: r.leads.length,
    live_leads: r.calls.filter((c) => c.key.endsWith(":live")).reduce((n, c) => n + c.leads, 0),
    new_leads: fresh,
  };
  for (const [reason, n] of Object.entries(r.rejected)) counts[`not_lead_${reason.replace(/\s+/g, "_")}`] = n ?? 0;
  return { credits: r.credits, counts };
}

async function dueStep(startedAt: string): Promise<LeadRow[]> {
  "use step";
  return dueLeads(await db(), new Date(startedAt));
}

/**
 * One attempt for each lead: the stored round, else the article search and its pages read through
 * the pipeline, else (once, for a status post) the homepage check that lets the post land flagged.
 * A failure on one lead is counted and leaves it due for the next run.
 */
async function attemptStep(
  leads: LeadRow[],
  runId: string,
): Promise<{
  credits: number;
  counts: Record<string, number>;
  changedByPreset: Record<string, string[]>;
  insertedByPreset: Record<string, string[]>;
}> {
  "use step";
  const handle = await db();
  const client = getFirecrawl();
  const [aliases, publisherTiers, rates, table, plan] = await Promise.all([
    loadAliases(handle),
    loadPublisherTiers(),
    fetchRates("latest").catch(() => null),
    routingTable(handle),
    getCoverage(handle),
  ]);
  const tiers = { ...DEFAULT_TIERS, ...publisherTiers };
  const model = reconcileModel(process.env, "announcements");
  const counts: Record<string, number> = {
    attempted: 0,
    known: 0,
    article_searches: 0,
    article_pages: 0,
    corroborated: 0,
    published: 0,
    self_checks: 0,
    founder_checks: 0,
    founder_published: 0,
    company_reads: 0,
    company_found: 0,
    profiles_expired: 0,
    expired: 0,
    attempt_errors: 0,
  };
  const changedByPreset: Record<string, string[]> = {};
  const insertedByPreset: Record<string, string[]> = {};
  let credits = 0;
  const persist = async (records: FeedRecord[], options: PersistOptions = {}) => {
    const s = await persistRouted(handle, records, null, runId, options, table.presets);
    if (s.persistedIds.length) await invalidateEntityPages(handle, { roundIds: s.persistedIds });
    for (const [slug, ids] of Object.entries(s.changedByPreset)) changedByPreset[slug] = [...(changedByPreset[slug] ?? []), ...ids];
    // Inserted ids by preset: the routed summary lists them flat, so they are placed by the changed map.
    for (const id of s.insertedIds) {
      const slug = Object.entries(s.changedByPreset).find(([, ids]) => ids.includes(id))?.[0];
      if (slug) insertedByPreset[slug] = [...(insertedByPreset[slug] ?? []), id];
    }
    return s;
  };

  for (const row of leads) {
    const now = new Date();
    const lead = asLead(row);
    counts.attempted++;
    try {
      // A profile page's lead from before profiles stopped being leads: its snippet is no dated post.
      if (row.kind === "profile") {
        counts.profiles_expired++;
        await finishAttempt(handle, row, { status: "expired", note: "profile page: no dated post" }, now);
        continue;
      }
      // A search snippet stops a few lines in, often before the post names its company ("... @TaskletAI is
      // built with"). Once, a post with no company is read whole beside its author's bio, and the account the
      // bio names them a founder of, when the post names it too, is the company.
      let named: LeadOutcome["company"];
      let founderBio: Awaited<ReturnType<typeof profileBio>> | null = null;
      if (lead.kind === "post" && !lead.company && lead.handle && row.status === "pending" && row.note !== NO_COMPANY) {
        counts.company_reads++;
        const [post, bio] = await Promise.all([readXPost(client, lead.url), profileBio(client, lead.handle)]);
        credits += post.credits + bio.credits;
        founderBio = bio;
        const text = post.post?.text ?? lead.text;
        const found = companyFromFounderBio(bio.bio, text);
        if (found) {
          named = { ...found, text };
          lead.company = found.name;
          lead.companyHandle = found.handle;
          lead.text = text;
          counts.company_found++;
        }
      }
      const known = row.status === "pending" ? await knownRoundFor(handle, lead, now) : null;
      if (known) {
        counts.known++;
        await finishAttempt(handle, row, { status: "known", roundId: known, ...(named ? { company: named } : {}) }, now);
        continue;
      }
      const search = await searchLeadArticles(client, lead, row.readUrls);
      credits += search.credits;
      counts.article_searches++;
      const outcome: LeadOutcome = {
        status: row.status === "published" ? "published" : "pending",
        readUrls: [...row.readUrls, ...search.picks.map((p) => p.url)],
        ...(named ? { company: named } : founderBio ? { note: NO_COMPANY } : {}),
      };
      if (search.picks.length > 0) {
        const ex = await extractRounds(
          client,
          search.picks.map((p) => ({ url: p.url, title: p.title, query: "x:corroborate" })),
          { concurrency: 3 },
        );
        credits += ex.creditsEstimated;
        counts.article_pages += ex.pages.filter((p) => p.ok).length;
        const r = resolveRounds(ex.items, {
          stages: table.stages,
          stagelessBands: STAGE_BANDS,
          windowStart: windowStartFor("week", now),
          now,
          rates,
          aliases,
          publisherTiers,
        });
        const matched = r.kept.filter((k) => leadMatches(k, lead));
        if (matched.length > 0) {
          // The read-back, as every lane has it: a page that recalls the round as history does not land it.
          let records = matched;
          if (plan.judge) {
            const judged = model
              ? await reconcileRecords(matched, firecrawlReader(client), model, { rates, tiers })
              : await judgeRecords(client, matched, { rates, tiers });
            credits += judged.creditsEstimated;
            records = (model ? judged.records : judged.records.map((x) => settleDate(x))).filter(
              (x) => x.verification?.status !== "not_news" && x.verification?.status !== "contradicted",
            );
          }
          if (records.length > 0) {
            await persist(records);
            counts.corroborated++;
            outcome.status = "corroborated";
            outcome.roundId = records[0].id;
            outcome.articleUrl = records[0].sources[0]?.url ?? null;
          }
        }
      }
      // Once per lead: may the post land on its own? Only a status post naming its company, from an account the homepage links.
      if (outcome.status === "pending" && !row.selfCheckedAt && lead.kind === "post" && lead.company && lead.handle) {
        counts.self_checks++;
        outcome.selfCheckedAt = now;
        outcome.selfVerified = false;
        const domain = domainInText(lead.text);
        const website = (await storedWebsite(handle, lead)) ?? (domain ? `https://${domain}` : null);
        if (website) {
          const links = await homepageHandles(client, website);
          credits += links.credits;
          if (selfPublishable(lead, links.handles)) {
            outcome.selfVerified = true;
            const r = resolveRounds([leadAsItem(lead, website)], {
              stages: table.stages,
              stagelessBands: STAGE_BANDS,
              windowStart: windowStartFor("week", now),
              now,
              rates,
              aliases,
              publisherTiers,
            });
            const records = r.kept.map((k) => xOnlyRecord(k, selfPublishedNote(lead), lead.url));
            if (records.length > 0) {
              await persist(records, { startIn: "flagged", ownAccounts: [lead.handle] });
              counts.published++;
              outcome.status = "published";
              outcome.roundId = records[0].id;
            }
          }
        }
      }
      // A founder's post may land on its own too, flagged, when the founder's X bio links the company and
      // either a second account confirms it within twelve hours or the bio names them a founder of the very
      // account the post names. A bio that does not link the company is not read again; one that links it
      // without naming the post's account is read again only once a confirmation exists.
      if (
        outcome.status === "pending" &&
        lead.kind === "post" &&
        lead.company &&
        lead.handle &&
        lead.postedAt &&
        now.getTime() - lead.postedAt.getTime() <= X_LANDING_MAX_AGE_HOURS * 3_600_000 &&
        row.note !== FOUNDER_BIO_MISS
      ) {
        const confirmedBy = await confirmingLeads(handle, lead);
        if (confirmedBy.length > 0 || (lead.companyHandle && row.note !== FOUNDER_UNCONFIRMED)) {
          counts.founder_checks++;
          const domain = domainInText(lead.text);
          const website = (await storedWebsite(handle, lead)) ?? (domain ? `https://${domain}` : null);
          const links = website ? await homepageHandles(client, website) : { handles: [], credits: 0 };
          const bio = founderBio ?? (await profileBio(client, lead.handle));
          credits += links.credits + (founderBio ? 0 : bio.credits);
          const tied = bioLinksCompany(bio.bio, {
            name: lead.company,
            domain: website ? registrableDomain(website) : null,
            handles: [...links.handles, ...(lead.companyHandle ? [lead.companyHandle] : [])].filter(
              (h) => h.toLowerCase() !== lead.handle?.toLowerCase(),
            ),
            links: bio.links,
          });
          const foundsPostAccount =
            !!lead.companyHandle && companyFromFounderBio(bio.bio, lead.text)?.handle.toLowerCase() === lead.companyHandle.toLowerCase();
          if (!tied) outcome.note = FOUNDER_BIO_MISS;
          else if (confirmedBy.length === 0 && !foundsPostAccount) outcome.note = FOUNDER_UNCONFIRMED;
          else {
            const r = resolveRounds([leadAsItem(lead, website)], {
              stages: table.stages,
              stagelessBands: STAGE_BANDS,
              windowStart: windowStartFor("week", now),
              now,
              rates,
              aliases,
              publisherTiers,
            });
            const records = r.kept.map((k) => xOnlyRecord(k, founderLandedNote(lead, confirmedBy), lead.url));
            if (records.length > 0) {
              await persist(records, { startIn: "flagged", ownAccounts: [lead.handle] });
              counts.published++;
              counts.founder_published++;
              outcome.status = "published";
              outcome.roundId = records[0].id;
            }
          }
        }
      }
      const status = await finishAttempt(handle, row, outcome, now);
      if (status === "expired") counts.expired++;
    } catch {
      counts.attempt_errors++;
    }
  }
  return { credits, counts, changedByPreset, insertedByPreset };
}

async function deliverStep(changedByPreset: Record<string, string[]>, origin: string): Promise<number> {
  "use step";
  if (Object.keys(changedByPreset).length === 0) return 0;
  const handle = await db();
  const queued = await enqueueRouted(handle, changedByPreset);
  if (queued > 0) await flushDeliveries(handle, origin);
  return queued;
}

/**
 * The run's row on Runs. Credits measured are the sum each call reported (search bills per ten
 * results returned, the scrape and the extraction their own), not the account balance, which every
 * lane running this hour shares.
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
    presetSlug: ANNOUNCEMENTS_PRESET_SLUG,
    lane: "announcements",
    window: null,
    startedAt: new Date(run.startedAt),
    finishedAt: new Date(),
    creditsEstimated: run.estimate,
    creditsMeasured: run.measured,
    counts: run.counts,
  });
}
