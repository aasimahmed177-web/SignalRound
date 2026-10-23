// Investor domains against the store: who still needs a search, the search, and the write. The
// pick is pickInvestorDomain's (pure, in core); this file decides which investors are worth a
// search and records every outcome, so a miss is paid for once. A hit writes the bare domain the
// logo is fetched by; a miss writes only domain_checked_at; a search that threw releases its claim,
// so the next pass tries again. The enrich lane, the sweep, and the backfill script share it.
//
// Passes can overlap (the cron starts one enrich run per preset at once, and an investor sits on
// rounds in several presets), so a pass claims its rows before it searches: one UPDATE stamps
// domain_checked_at on the rows still unchecked and returns the ones it stamped. A row another pass
// claimed first is not returned, so no investor is searched twice.
//
// The logo is the second phase, the way a company's comes from its homepage: one branding-only
// scrape of https://<domain> (no JSON, no markdown), the branding format's logo file or else the
// page's favicon written to logo_url, a page with neither recorded in logo_checked_at so it is paid
// for once. It claims and releases exactly as the search does. A domain the search just resolved
// gets its logo in the same pass; the backlog (a domain with no logo read yet) is a scoped pass of
// its own, from the sweep or the backfill script.

import {
  anchorCandidates,
  brandFrom,
  brandingCredits,
  type CandidateOrigin,
  homepageLogo,
  INVESTOR_SEARCH_RESULTS,
  type InvestorCandidate,
  type InvestorHomepage,
  type InvestorSearchHit,
  InvestorSite,
  type InvestorType,
  type InvestorVerdict,
  investorCandidates,
  investorDomainCredits,
  investorHomepageCredits,
  investorQueries,
  investorSearchTarget,
  investorSiteJsonSchema,
  investorSitePrompt,
  isXUrl,
  judgeInvestorHomepage,
  mapLimit,
  NON_ARTICLE_HOSTS,
  normalizeCompanyKey,
  RATE,
  readsAsPerson,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import type { NativeWebClient } from "@fireround/core/web";
import { and, eq, inArray, isNotNull, isNull, lt, or, type SQL, sql } from "drizzle-orm";

const { fundingRounds, investors, roundInvestors, roundSources, sources } = schema;

/** The dispositions a reader sees; an investor named only on review or rejected rows shows nowhere yet. */
const VISIBLE = ["publish", "flagged"] as const;

export interface InvestorDomainQuery {
  /** Only these investors (by id), visible rounds or not. */
  ids?: string[];
  /** Only investors named on this preset's visible rounds. */
  presetSlug?: string | null;
  /**
   * Only investors named on these rounds, or on these companies' rounds: the scope of the pass
   * that just ingested or enriched them. Either given (even empty) makes the query scoped, and an
   * empty scope finds nobody.
   */
  roundIds?: string[];
  companyIds?: string[];
  limit: number;
  /** Search again for misses checked more than this many days ago. Unset: a miss is never retried. */
  retryAfterDays?: number;
  /**
   * Leave bare person-shaped names ("Jane Doe", but also "Kleiner Perkins") unsearched and
   * unchecked, for a cheaper backfill: most are angels whose search resolves nothing. They stay
   * pending, so a later pass without the flag still reaches them. The limit counts the others.
   */
  skipPeople?: boolean;
  /**
   * With `ids`: search these investors again whatever they hold, a domain or a checked miss, and
   * write the new answer over the old (a miss clears the domain). The fix for a bad resolution.
   */
  force?: boolean;
  /**
   * Read the logo of every investor this pass resolves on a search snippet alone (its homepage
   * could not be read), in the same pass. A verified resolution's logo comes off its own homepage
   * read. On unless false: a new investor should reach the page with its logo.
   */
  logos?: boolean;
  /** Read the rounds' press pages for links when no search candidate verifies. On unless false. */
  press?: boolean;
  /** Read each candidate's homepage for a verdict; off on the Lite rung (see resolveInvestor). On unless false. */
  verify?: boolean;
}

export interface PendingInvestor {
  id: string;
  name: string;
  /** What domain_checked_at held before this pass: a failed search puts it back. */
  checkedAt: Date | null;
}

/** No domain, and never checked (or checked long enough ago that the caller asked for a retry). */
function needsCheck(retryAfterDays: number | undefined, now: Date): SQL | undefined {
  const unchecked = isNull(investors.domainCheckedAt);
  if (retryAfterDays === undefined) return and(isNull(investors.domain), unchecked);
  const cutoff = new Date(now.getTime() - retryAfterDays * 86_400_000);
  return and(isNull(investors.domain), or(unchecked, lt(investors.domainCheckedAt, cutoff)));
}

function isForced(query: InvestorDomainQuery): boolean {
  return query.force === true && query.ids !== undefined;
}

/** The pass's scope over rounds, or undefined when the query is not scoped. */
function roundScope(query: InvestorDomainQuery): SQL | undefined | "empty" {
  if (query.roundIds === undefined && query.companyIds === undefined) return undefined;
  const rounds = query.roundIds ?? [];
  const companies = query.companyIds ?? [];
  if (rounds.length === 0 && companies.length === 0) return "empty";
  return or(
    rounds.length > 0 ? inArray(fundingRounds.id, rounds) : undefined,
    companies.length > 0 ? inArray(fundingRounds.companyId, companies) : undefined,
  );
}

/**
 * Investors that still need a domain search, the newest rounds' investors first, so a capped pass
 * spends on the firms the feed just showed before the backlog. With `skipPeople` the person-shaped
 * names are filtered out page by page until `limit` others are found, so the flag never stalls on
 * a limit filled by names it will not search.
 */
export async function pendingInvestorDomains(handle: Db, query: InvestorDomainQuery, now = new Date()): Promise<PendingInvestor[]> {
  const pending = isForced(query) ? undefined : needsCheck(query.retryAfterDays, now);
  const columns = { id: investors.id, name: investors.name, checkedAt: investors.domainCheckedAt };
  if (query.ids) {
    if (query.ids.length === 0) return [];
    return handle
      .select(columns)
      .from(investors)
      .where(and(inArray(investors.id, query.ids), pending))
      .orderBy(investors.id)
      .limit(query.limit);
  }
  const scope = roundScope(query);
  if (scope === "empty") return [];
  const page = (offset: number, size: number) =>
    handle
      .select(columns)
      .from(investors)
      .innerJoin(roundInvestors, eq(roundInvestors.investorId, investors.id))
      .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
      .where(
        and(
          inArray(fundingRounds.disposition, [...VISIBLE]),
          query.presetSlug ? eq(fundingRounds.presetSlug, query.presetSlug) : undefined,
          scope,
          pending,
        ),
      )
      .groupBy(investors.id, investors.name, investors.domainCheckedAt)
      .orderBy(sql`max(${fundingRounds.firstSeenAt}) desc`, investors.id)
      .limit(size)
      .offset(offset);
  if (!query.skipPeople) return page(0, query.limit);
  const size = Math.max(query.limit * 2, 200);
  const out: PendingInvestor[] = [];
  for (let offset = 0; out.length < query.limit; offset += size) {
    const rows = await page(offset, size);
    for (const r of rows) if (!investorSearchTarget(r.name)?.person && out.length < query.limit) out.push(r);
    if (rows.length < size) break;
  }
  return out;
}

/** Homepage reads one resolution may spend across its candidates: a namesake or two, then the firm. */
export const MAX_HOMEPAGE_READS = 4;
/** Press pages of an investor's rounds read for links, when no search candidate verified. */
export const MAX_SOURCE_READS = 2;

/**
 * What a pass over these investors would search and spend, without a call: the dry run's answer.
 * `people` is how many of the searches are bare person-shaped names, the share `skipPeople` saves.
 * `credits` is the usual cost (one search and one homepage verdict each); `maxCredits` the most a
 * resolution may spend (both searches, every homepage read, both press pages).
 */
export function planInvestorDomains(pending: PendingInvestor[]): {
  investors: number;
  searches: number;
  skipped: number;
  people: number;
  credits: number;
  maxCredits: number;
} {
  const targets = pending.map((p) => investorSearchTarget(p.name));
  const searches = targets.filter((t) => t !== null).length;
  const people = targets.filter((t) => t?.person).length;
  return {
    investors: pending.length,
    searches,
    skipped: pending.length - searches,
    people,
    credits: investorDomainCredits(searches) + investorHomepageCredits(searches),
    maxCredits: searches * (investorDomainCredits(2) + investorHomepageCredits(MAX_HOMEPAGE_READS) + MAX_SOURCE_READS * RATE.scrapePage),
  };
}

export interface InvestorDomainOutcome {
  id: string;
  name: string;
  /**
   * "resolved": a domain was written. "person": an individual no firm's site claimed, recorded as a
   * person. "miss": searched, nothing verified. "skipped": no search can find one (a person named by
   * a role or an affiliation, a placeholder). "error": the search or the write threw; the claim is released.
   */
  outcome: "resolved" | "person" | "miss" | "skipped" | "error";
  domain: string | null;
  detail: string | null;
}

export interface InvestorDomainResult {
  investors: number;
  searched: number;
  resolved: number;
  skipped: number;
  errors: number;
  /** Everything the resolutions spent: searches, homepage verdicts, press pages. Chained logo reads carry their own in `logos.credits`. */
  credits: number;
  outcomes: InvestorDomainOutcome[];
  /** Logo reads chained onto resolutions whose homepage was not read (a snippet stood in); null when none ran. */
  logos: InvestorLogoResult | null;
}

/** The search's web results as the resolver reads them. A result without a URL is dropped. */
function hitsOf(res: Awaited<ReturnType<NativeWebClient["search"]>>): InvestorSearchHit[] {
  return (res.web ?? []).flatMap((item) => {
    const url = "url" in item ? item.url : undefined;
    if (!url) return [];
    return [{ url, title: "title" in item ? item.title : null, description: "description" in item ? item.description : null }];
  });
}

/** One investor's answer, before anything is written: what the lane writes and the backfill reports. */
export interface InvestorResolution {
  outcome: "resolved" | "person" | "miss" | "skipped";
  domain: string | null;
  /** "verified": the homepage's own word. "snippet": the homepage could not be read and a search result's bar stood in. */
  confidence: "verified" | "snippet" | null;
  type: InvestorType | null;
  description: string | null;
  headquarters: string | null;
  /** The logo off the homepage read, the brand's file or else its favicon. */
  logo: string | null;
  /** Whether the resolved domain's homepage was read, so a missing logo is a checked miss rather than unknown. */
  logoRead: boolean;
  origin: CandidateOrigin | null;
  reason: string;
  /** Every candidate read and refused, with why: the report's evidence that a namesake was turned away. */
  refused: Array<{ domain: string; reason: string }>;
  searches: number;
  reads: number;
  sourceReads: number;
  credits: number;
}

/** A press page's markdown, or null when it could not be read. Shared across a pass, so a round's page is read once. */
export type PressReader = (url: string) => Promise<string | null>;

/** A reader that scrapes each press page once per pass, whoever asks, and counts what it spent. */
export function pressReader(client: NativeWebClient): PressReader & { credits: () => number; reads: () => number } {
  const cache = new Map<string, Promise<string | null>>();
  let credits = 0;
  let reads = 0;
  const read = (url: string) => {
    let hit = cache.get(url);
    if (!hit) {
      hit = client
        .scrape(url, { formats: ["markdown"], onlyMainContent: true, timeout: 45_000 })
        .then((doc) => {
          reads++;
          const used = doc.metadata?.creditsUsed;
          credits += typeof used === "number" && Number.isFinite(used) ? used : RATE.scrapePage;
          return doc.markdown ?? null;
        })
        .catch(() => null);
      cache.set(url, hit);
    }
    return hit;
  };
  return Object.assign(read, { credits: () => credits, reads: () => reads });
}

/**
 * One homepage read and its verdict: the branding format for the logo and the JSON identity verdict,
 * in one scrape. A scrape that throws twice is an unreadable page (unknown, not refused), unbilled.
 */
export async function readInvestorHomepage(
  client: NativeWebClient,
  name: string,
  candidate: InvestorCandidate,
  context = "",
): Promise<{ verdict: InvestorVerdict; logo: string | null; read: boolean; credits: number }> {
  const read = () =>
    client.scrape(candidate.homepage, {
      formats: ["branding", { type: "json", schema: investorSiteJsonSchema, prompt: investorSitePrompt(name) }],
      onlyMainContent: false,
      timeout: 60_000,
    });
  try {
    // One retry: a proxy or tunnel error on the first attempt is common and says nothing about the site.
    const home = await read().catch(read);
    const used = home.metadata?.creditsUsed;
    const finalUrl = home.metadata?.url ?? home.metadata?.sourceURL ?? candidate.homepage;
    const parsed = InvestorSite.safeParse(home.json);
    const page: InvestorHomepage = {
      finalUrl,
      status: home.metadata?.statusCode ?? null,
      title: home.metadata?.title ?? null,
      siteName: home.metadata?.ogSiteName ?? null,
      brandName: home.branding?.brandName ?? null,
      site: parsed.success ? parsed.data : null,
    };
    return {
      verdict: judgeInvestorHomepage(name, candidate, page, context),
      logo: homepageLogo(home, finalUrl),
      read: true,
      credits: typeof used === "number" && Number.isFinite(used) ? used : investorHomepageCredits(1),
    };
  } catch (err) {
    return {
      verdict: { ok: false, unreadable: true, reason: `unreadable: ${err instanceof Error ? err.message : String(err)}` },
      logo: null,
      read: false,
      credits: 0,
    };
  }
}

/**
 * Resolve one investor's website without writing anything: the searches, the candidates, and one
 * homepage verdict per candidate until an investor's own site verifies (a corporation's or a
 * bank's site is kept only when no investor's did). With no verified candidate from either search,
 * the round's press pages are read for links under the firm's name. An individual no firm's site
 * claimed resolves as a person, never onto a domain. Throws only when a search throws, which the
 * caller treats as unknown rather than a miss; a homepage that throws is an unreadable candidate.
 */
export async function resolveInvestor(
  client: NativeWebClient,
  name: string,
  options: {
    pressPages?: string[];
    readPress?: PressReader;
    context?: string;
    /**
     * Read each candidate's homepage for a verdict (on unless false). The Lite rung turns it off to
     * keep a lookup at one search: the snippet bar picks, as it did before homepages were read, the
     * logo is the chained branding read, and an individual is never given a domain.
     */
    verify?: boolean;
  } = {},
): Promise<InvestorResolution> {
  const out: InvestorResolution = {
    outcome: "skipped",
    domain: null,
    confidence: null,
    type: null,
    description: null,
    headquarters: null,
    logo: null,
    logoRead: false,
    origin: null,
    reason: "a person or placeholder with no firm to search for",
    refused: [],
    searches: 0,
    reads: 0,
    sourceReads: 0,
    credits: 0,
  };
  const target = investorSearchTarget(name);
  if (!target) return out;
  const tried = new Map<string, boolean>();
  const verified: Array<{
    candidate: InvestorCandidate;
    verdict: Extract<InvestorVerdict, { ok: true }>;
    logo: string | null;
    /** The first candidate the first search offered. */
    first: boolean;
  }> = [];
  const unreadable: Array<{ candidate: InvestorCandidate; logo: string | null; read: boolean }> = [];
  const settled = () => verified.some((v) => v.verdict.investing);

  const verify = async (candidate: InvestorCandidate) => {
    const previous = tried.get(candidate.domain);
    if (previous === true || (previous === false && !candidate.armPage) || out.reads >= MAX_HOMEPAGE_READS || settled()) return;
    tried.set(candidate.domain, !!candidate.armPage);
    const r = await readInvestorHomepage(client, name, candidate, options.context);
    out.reads += r.read ? 1 : 0;
    out.credits += r.credits;
    if (r.verdict.ok) verified.push({ candidate, verdict: r.verdict, logo: r.logo, first: tried.size === 1 });
    else {
      if (r.verdict.unreadable) unreadable.push({ candidate, logo: r.logo, read: r.read });
      out.refused.push({ domain: candidate.domain, reason: r.verdict.reason });
    }
  };

  // An individual gets the site-steered search only, and no press links: a firm named like a person
  // surfaces there, and a second search or a press page would only find the person's own pages.
  const verifying = options.verify !== false;
  const queries = investorQueries(target).slice(0, target.individual || !verifying ? 1 : undefined);
  let person = false;
  for (const query of queries) {
    const hits = hitsOf(await client.search(query, { limit: INVESTOR_SEARCH_RESULTS, highlights: false }));
    if (out.searches === 0) person = readsAsPerson(name, hits);
    out.searches++;
    out.credits += investorDomainCredits(1);
    const candidates = investorCandidates(name, hits);
    if (!verifying) {
      const pick = target.individual ? undefined : candidates.find((c) => c.snippet);
      if (pick) unreadable.push({ candidate: pick, logo: null, read: false });
      break;
    }
    for (const c of candidates) await verify(c);
    if (settled()) break;
  }
  if (verifying && !settled() && options.readPress && !target.individual) {
    for (const url of (options.pressPages ?? []).slice(0, MAX_SOURCE_READS)) {
      const markdown = await options.readPress(url);
      out.sourceReads++;
      if (markdown) for (const c of anchorCandidates(name, markdown, url)) await verify(c);
      if (settled()) break;
    }
  }

  // A corporation's or a bank's site stands in only when no investor's verified. For a one-word name
  // it must also be the investor search's first candidate with nothing refused before it: "Huma" the
  // health company is not the Huma a biotech round names when humacapital.com.br came up first.
  const oneWord = normalizeCompanyKey(target.firm).split(" ").length === 1;
  const plain = verified[0];
  const plainOk = plain && (!oneWord || (plain.first && out.refused.length === 0));
  const best = verified.find((v) => v.verdict.investing) ?? (plainOk ? plain : undefined);
  if (best) {
    return {
      ...out,
      outcome: "resolved",
      domain: best.verdict.domain,
      confidence: "verified",
      type: best.verdict.type,
      description: best.verdict.description,
      headquarters: best.verdict.headquarters,
      logo: best.logo,
      logoRead: true,
      origin: best.candidate.origin,
      reason: best.verdict.reason,
    };
  }
  // A page that could not be read is unknown, not refused: a result that passed the snippet bar on
  // its own stands in, as it did before any homepage was read. Never for an individual.
  // Nor, where homepages are read, for a one-word name: which of the firms sharing the word it is
  // ("Soma" on soma.ventures, not Soma Capital) is the verdict's to say, never a snippet's. The Lite
  // rung reads no homepage, so there the snippet is the whole lookup, as it always was.
  const fallback = target.individual || (oneWord && verifying) ? undefined : unreadable.find((u) => u.candidate.snippet);
  if (fallback) {
    const c = fallback.candidate;
    return {
      ...out,
      outcome: "resolved",
      domain: c.domain,
      confidence: "snippet",
      logo: fallback.logo,
      logoRead: fallback.read,
      origin: c.origin,
      reason: c.snippet ?? "",
    };
  }
  if (person)
    return {
      ...out,
      outcome: "person",
      type: "person",
      reason: "an individual: the search reads as a person, and no firm's own site claimed the name",
    };
  return {
    ...out,
    outcome: "miss",
    reason: out.refused.length > 0 ? `${out.refused.length} candidate(s) refused` : "no candidate spelled the name",
  };
}

/** Press releases first (they link every investor), then any other page that is not a directory. */
const WIRE = /(^|\.)(prnewswire|businesswire|globenewswire|prweb|accesswire|einpresswire|newswire|newsfilecorp)\./;

/** What the store already holds about where an investor was named: its rounds' press pages and their evidence. */
export interface InvestorEvidence {
  /** Newest round first, wire releases before other stories, at most MAX_SOURCE_READS: where the round's own page may link the firm. */
  pressPages: string[];
  /** The rounds' evidence quotes, joined: the words that must write a one-word name's suffix. */
  context: string;
}

/** Each investor's press pages and evidence quotes, over its visible rounds, in two reads for the whole pass. */
export async function investorEvidence(handle: Db, ids: string[]): Promise<Map<string, InvestorEvidence>> {
  const out = new Map<string, InvestorEvidence>();
  if (ids.length === 0) return out;
  const visible = and(inArray(roundInvestors.investorId, ids), inArray(fundingRounds.disposition, [...VISIBLE]));
  const [pages, quotes] = await Promise.all([
    handle
      .select({ investorId: roundInvestors.investorId, url: sources.url, host: sources.host, seen: fundingRounds.firstSeenAt })
      .from(roundInvestors)
      .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
      .innerJoin(roundSources, eq(roundSources.roundId, fundingRounds.id))
      .innerJoin(sources, eq(sources.id, roundSources.sourceId))
      .where(visible),
    handle
      .select({ investorId: roundInvestors.investorId, quotes: fundingRounds.evidenceQuotes })
      .from(roundInvestors)
      .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
      .where(visible),
  ]);
  const entry = (id: string) => {
    const e = out.get(id) ?? { pressPages: [], context: "" };
    out.set(id, e);
    return e;
  };
  const rank = (host: string) => (WIRE.test(host) ? 0 : isXUrl(`https://${host}`) || NON_ARTICLE_HOSTS.has(host) ? 2 : 1);
  pages.sort((a, b) => rank(a.host) - rank(b.host) || b.seen.getTime() - a.seen.getTime());
  for (const r of pages) {
    const e = entry(r.investorId);
    if (rank(r.host) < 2 && e.pressPages.length < MAX_SOURCE_READS && !e.pressPages.includes(r.url)) e.pressPages.push(r.url);
  }
  for (const r of quotes) {
    const e = entry(r.investorId);
    const text = (Array.isArray(r.quotes) ? r.quotes : []).filter((q): q is string => typeof q === "string").join(" ");
    e.context = `${e.context} ${text}`.trim();
  }
  return out;
}

/**
 * Stamp domain_checked_at on the rows this pass may search, atomically: only rows still pending
 * are stamped, so a row a concurrent pass claimed a moment earlier is not returned. A forced
 * recheck claims every id it was given.
 */
async function claim(handle: Db, pending: PendingInvestor[], query: InvestorDomainQuery, at: Date): Promise<Set<string>> {
  if (pending.length === 0) return new Set();
  const rows = await handle
    .update(investors)
    .set({ domainCheckedAt: at })
    .where(
      and(
        inArray(
          investors.id,
          pending.map((p) => p.id),
        ),
        isForced(query) ? undefined : needsCheck(query.retryAfterDays, at),
      ),
    )
    .returning({ id: investors.id });
  return new Set(rows.map((r) => r.id));
}

/**
 * Resolve the websites of investors that have none and write what verifies: the domain, the logo
 * off the same homepage read, and what the site says the investor is. Rows are claimed first, so
 * an overlapping pass never resolves the same investor. Concurrency is bounded; anything that
 * throws for one investor (a search, the write) is that investor's "error" outcome, its claim goes
 * back, and the batch and its accounting carry on.
 */
export async function resolveInvestorDomains(
  handle: Db,
  client: NativeWebClient,
  query: InvestorDomainQuery & { concurrency?: number },
): Promise<InvestorDomainResult> {
  const claimedAt = new Date();
  const candidates = await pendingInvestorDomains(handle, query, claimedAt);
  const claimed = await claim(handle, candidates, query, claimedAt);
  const pending = candidates.filter((c) => claimed.has(c.id));
  const force = isForced(query);
  const press = query.press === false ? null : pressReader(client);
  const evidence = await investorEvidence(
    handle,
    pending.map((p) => p.id),
  );
  // The claim already stamped domain_checked_at. A domain already set (by hand, or by a concurrent
  // pass) is never overwritten, unless the caller forced a recheck, where the new answer is the point
  // and a logo read off the old domain goes with it. The profile follows the domain it was read off.
  const changed = (domain: string | null) => sql`${investors.domain} is distinct from ${domain}`;
  const write = (id: string, r: InvestorResolution) => {
    const read = r.logoRead;
    const profile = { kind: r.type, description: r.description, headquarters: r.headquarters };
    if (force) {
      return handle
        .update(investors)
        .set({
          domain: r.domain,
          ...profile,
          logoUrl: sql`coalesce(${r.logo}, case when ${changed(r.domain)} then null else ${investors.logoUrl} end)`,
          logoCheckedAt: read ? claimedAt : sql`case when ${changed(r.domain)} then null else ${investors.logoCheckedAt} end`,
        })
        .where(eq(investors.id, id));
    }
    if (r.outcome === "person")
      return handle
        .update(investors)
        .set({ kind: "person" })
        .where(and(eq(investors.id, id), isNull(investors.domain)));
    return handle
      .update(investors)
      .set({
        domain: sql`coalesce(${investors.domain}, ${r.domain})`,
        kind: sql`case when ${investors.domain} is null or ${investors.domain} = ${r.domain} then ${r.type} else ${investors.kind} end`,
        description: sql`case when ${investors.domain} is null or ${investors.domain} = ${r.domain} then ${r.description} else ${investors.description} end`,
        headquarters: sql`case when ${investors.domain} is null or ${investors.domain} = ${r.domain} then ${r.headquarters} else ${investors.headquarters} end`,
        ...(read ? { logoUrl: sql`coalesce(${investors.logoUrl}, ${r.logo})`, logoCheckedAt: claimedAt } : {}),
      })
      .where(and(eq(investors.id, id), or(isNull(investors.domain), eq(investors.domain, r.domain ?? ""))));
  };
  // A search or write that failed is unknown, not a miss: the stamp goes back to what it was, so the
  // next pass retries it rather than treating it as searched. Only a stamp still ours is released.
  const release = (inv: PendingInvestor) =>
    handle
      .update(investors)
      .set({ domainCheckedAt: inv.checkedAt })
      .where(and(eq(investors.id, inv.id), eq(investors.domainCheckedAt, claimedAt)));
  let searched = 0;
  let credits = 0;
  const snippetOnly: string[] = [];
  const outcomes = await mapLimit(pending, query.concurrency ?? 4, async (inv): Promise<InvestorDomainOutcome> => {
    const base = { id: inv.id, name: inv.name };
    try {
      const e = evidence.get(inv.id);
      const r = await resolveInvestor(client, inv.name, {
        pressPages: e?.pressPages,
        readPress: press ?? undefined,
        context: e?.context,
        verify: query.verify,
      });
      searched += r.searches;
      credits += r.credits;
      if (r.outcome === "resolved" || r.outcome === "person" || force) await write(inv.id, r);
      if (r.outcome === "resolved" && !r.logoRead) snippetOnly.push(inv.id);
      return { ...base, outcome: r.outcome, domain: r.domain, detail: r.reason };
    } catch (err) {
      await release(inv).catch(() => undefined);
      return { ...base, outcome: "error", domain: null, detail: err instanceof Error ? err.message : String(err) };
    }
  });
  credits += press?.credits() ?? 0;
  const count = (o: InvestorDomainOutcome["outcome"]) => outcomes.filter((r) => r.outcome === o).length;
  // A snippet stood in only where the homepage could not be read; its logo gets the branding-only
  // read, capped by construction at one per such resolution. A failure here (the store) is logged,
  // never thrown: the resolutions above are spent and accounted.
  let logos: InvestorLogoResult | null = null;
  if (query.logos !== false && snippetOnly.length > 0) {
    logos = await fetchInvestorLogos(handle, client, { ids: snippetOnly, limit: snippetOnly.length, concurrency: query.concurrency }).catch(
      (err) => {
        console.error(`investor logos: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      },
    );
  }
  return {
    investors: pending.length,
    searched,
    resolved: count("resolved"),
    skipped: count("skipped"),
    errors: count("error"),
    credits,
    outcomes,
    logos,
  };
}

/**
 * Undo resolutions without a search: the domain goes back to null and domain_checked_at stays (or
 * is set), so no pass searches these investors again on its own. `force` with their ids does. The
 * logo read off the bad domain goes too.
 * Returns what each row held before, for the script to print.
 */
export async function clearInvestorDomains(handle: Db, ids: string[]): Promise<Array<{ id: string; name: string; domain: string | null }>> {
  if (ids.length === 0) return [];
  const before = await handle
    .select({ id: investors.id, name: investors.name, domain: investors.domain })
    .from(investors)
    .where(inArray(investors.id, ids));
  await handle
    .update(investors)
    .set({ domain: null, domainCheckedAt: sql`coalesce(${investors.domainCheckedAt}, now())`, logoUrl: null, logoCheckedAt: null })
    .where(inArray(investors.id, ids));
  return before;
}

export interface InvestorLogoQuery {
  /** Only these investors (by id), visible rounds or not. */
  ids?: string[];
  /** Only investors named on this preset's visible rounds. */
  presetSlug?: string | null;
  /** Only investors named on these rounds or these companies' rounds; as for domains, an empty scope finds nobody. */
  roundIds?: string[];
  companyIds?: string[];
  limit: number;
  /** Read again pages that had no logo more than this many days ago. Unset: a miss is never retried. */
  retryAfterDays?: number;
}

export interface PendingLogo {
  id: string;
  name: string;
  domain: string;
  /** What logo_checked_at held before this pass: a failed scrape puts it back. */
  checkedAt: Date | null;
}

/** A domain, no logo, and never read (or read long enough ago that the caller asked for a retry). */
function needsLogo(retryAfterDays: number | undefined, now: Date): SQL | undefined {
  const base = and(isNotNull(investors.domain), isNull(investors.logoUrl));
  const unchecked = isNull(investors.logoCheckedAt);
  if (retryAfterDays === undefined) return and(base, unchecked);
  const cutoff = new Date(now.getTime() - retryAfterDays * 86_400_000);
  return and(base, or(unchecked, lt(investors.logoCheckedAt, cutoff)));
}

/** Investors whose logo is still unread, the newest rounds' investors first, as the domain pass orders them. */
export async function pendingInvestorLogos(handle: Db, query: InvestorLogoQuery, now = new Date()): Promise<PendingLogo[]> {
  const pending = needsLogo(query.retryAfterDays, now);
  const columns = { id: investors.id, name: investors.name, domain: investors.domain, checkedAt: investors.logoCheckedAt };
  const withDomain = (rows: Array<Omit<PendingLogo, "domain"> & { domain: string | null }>) =>
    rows.flatMap((r) => (r.domain ? [{ ...r, domain: r.domain }] : []));
  if (query.ids) {
    if (query.ids.length === 0) return [];
    const rows = await handle
      .select(columns)
      .from(investors)
      .where(and(inArray(investors.id, query.ids), pending))
      .orderBy(investors.id)
      .limit(query.limit);
    return withDomain(rows);
  }
  const scope = roundScope(query);
  if (scope === "empty" || query.limit <= 0) return [];
  const rows = await handle
    .select(columns)
    .from(investors)
    .innerJoin(roundInvestors, eq(roundInvestors.investorId, investors.id))
    .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
    .where(
      and(
        inArray(fundingRounds.disposition, [...VISIBLE]),
        query.presetSlug ? eq(fundingRounds.presetSlug, query.presetSlug) : undefined,
        scope,
        pending,
      ),
    )
    .groupBy(investors.id, investors.name, investors.domain, investors.logoCheckedAt)
    .orderBy(sql`max(${fundingRounds.firstSeenAt}) desc`, investors.id)
    .limit(query.limit);
  return withDomain(rows);
}

/** What a logo pass over these investors would scrape and spend, without a call. */
export function planInvestorLogos(pending: PendingLogo[]): { investors: number; scrapes: number; credits: number } {
  return { investors: pending.length, scrapes: pending.length, credits: brandingCredits(pending.length) };
}

export interface InvestorLogoOutcome {
  id: string;
  name: string;
  domain: string;
  /**
   * "found": a logo was written. "miss": the page was read and had neither a brand logo nor a
   * favicon. "error": the scrape or the write threw; the claim is released.
   */
  outcome: "found" | "miss" | "error";
  logo_url: string | null;
  detail: string | null;
}

export interface InvestorLogoResult {
  investors: number;
  scraped: number;
  found: number;
  errors: number;
  credits: number;
  outcomes: InvestorLogoOutcome[];
}

/** An empty logo pass, for a caller that ran none. */
export const NO_LOGOS: InvestorLogoResult = { investors: 0, scraped: 0, found: 0, errors: 0, credits: 0, outcomes: [] };

/**
 * Read the logos of investors that have a domain and no logo: one branding-only scrape of the
 * homepage each, the cheapest read that returns one, and the same pick a company's homepage gets
 * (the brand's logo file, else the favicon). Rows are claimed on logo_checked_at first, so an
 * overlapping pass never scrapes the same investor; a scrape or write that throws is that
 * investor's "error", its claim goes back, and the batch carries on. Credits are what the scrape
 * reports it used, or the rate card's when it does not say.
 */
export async function fetchInvestorLogos(
  handle: Db,
  client: NativeWebClient,
  query: InvestorLogoQuery & { concurrency?: number },
): Promise<InvestorLogoResult> {
  const claimedAt = new Date();
  const candidates = await pendingInvestorLogos(handle, query, claimedAt);
  if (candidates.length === 0) return { ...NO_LOGOS, outcomes: [] };
  const rows = await handle
    .update(investors)
    .set({ logoCheckedAt: claimedAt })
    .where(
      and(
        inArray(
          investors.id,
          candidates.map((c) => c.id),
        ),
        needsLogo(query.retryAfterDays, claimedAt),
      ),
    )
    .returning({ id: investors.id, domain: investors.domain });
  // The domain as the claim saw it: the page read is this one's, whatever the candidate list held.
  const claimed = new Map(rows.flatMap((r) => (r.domain ? [[r.id, r.domain] as const] : [])));
  const pending = candidates.flatMap((c) => {
    const domain = claimed.get(c.id);
    return domain ? [{ ...c, domain }] : [];
  });
  // Written only while the domain is the one read, so a recheck that moved it meanwhile keeps its own
  // logo pass; a logo already set (by hand) is never overwritten.
  const write = (inv: PendingLogo, logo: string) =>
    handle
      .update(investors)
      .set({ logoUrl: sql`coalesce(${investors.logoUrl}, ${logo})` })
      .where(and(eq(investors.id, inv.id), eq(investors.domain, inv.domain)));
  const release = (inv: PendingLogo) =>
    handle
      .update(investors)
      .set({ logoCheckedAt: inv.checkedAt })
      .where(and(eq(investors.id, inv.id), eq(investors.logoCheckedAt, claimedAt)));
  let scraped = 0;
  let credits = 0;
  const outcomes = await mapLimit(pending, query.concurrency ?? 4, async (inv): Promise<InvestorLogoOutcome> => {
    const base = { id: inv.id, name: inv.name, domain: inv.domain };
    const url = `https://${inv.domain}`;
    try {
      // onlyMainContent false as on the company read: the logo lives in the header the main-content
      // filter drops. With branding as the only format there is no markdown to trim anyway.
      const home = await client.scrape(url, { formats: ["branding"], onlyMainContent: false, timeout: 60_000 });
      scraped++;
      const used = home.metadata?.creditsUsed;
      credits += typeof used === "number" && Number.isFinite(used) ? used : brandingCredits(1);
      const logo = homepageLogo(home, url);
      if (logo) await write(inv, logo);
      return logo
        ? { ...base, outcome: "found", logo_url: logo, detail: brandFrom(home.branding, url)?.logo ? "branding logo" : "favicon" }
        : { ...base, outcome: "miss", logo_url: null, detail: "no brand logo or favicon on the page" };
    } catch (err) {
      await release(inv).catch(() => undefined);
      return { ...base, outcome: "error", logo_url: null, detail: err instanceof Error ? err.message : String(err) };
    }
  });
  const count = (o: InvestorLogoOutcome["outcome"]) => outcomes.filter((r) => r.outcome === o).length;
  return { investors: pending.length, scraped, found: count("found"), errors: count("error"), credits, outcomes };
}
