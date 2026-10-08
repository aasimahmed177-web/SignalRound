import type { FeedRecord } from "@fireround/core";
import { DEFAULT_TIERS, dateFromUrl, hostOf, parseStatedDate, registrableDomain } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { NEWS_WINDOW_DAYS } from "./deliverable.ts";
import { visibilityEvidence } from "./round-verification.ts";
import { loadPublisherTiers } from "./rules.ts";
import { WIRE_DOMAINS } from "./source-order.ts";

/** How far ahead of a round's own release a report of it can run (a report the evening before, an early leak). */
const RELEASE_LEAD_DAYS = 45;

/** A page's own day: the date in its URL, else the day it was published. */
function pageDay(source: { url: string; published?: string | null }): string | null {
  const d = dateFromUrl(source.url) ?? (source.published ? parseStatedDate(source.published) : null);
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * The day the round's own release went out: the earliest day of a wire's copy of it, or of a page by the
 * company or an established outlet whose sentence calls the round today's news ("Arceus Legal today
 * disclosed"). Null when no source is either.
 */
export function releaseDay(
  sources: ReadonlyArray<{ url: string; published?: string | null; evidence?: string | null }>,
  companyDomain: string | null,
  tiers: Record<string, number> = DEFAULT_TIERS,
): string | null {
  const days = sources.flatMap((s) => {
    const domain = registrableDomain(s.url);
    if (!domain) return [];
    const wire = WIRE_DOMAINS.has(domain);
    const own = domain === companyDomain || (tiers[hostOf(s.url)] ?? tiers[domain] ?? 0) >= 0.7;
    if (!wire && !(own && /\btoday\b/i.test(s.evidence ?? ""))) return [];
    const day = pageDay(s);
    return day ? [day] : [];
  });
  return days.sort()[0] ?? null;
}

/** A stored round's sources as releaseDay reads them: each page's URL, day, and the sentence it stated the round in. */
export async function storedReleaseSources(handle: Db, roundId: string) {
  return handle
    .select({
      url: schema.sources.url,
      published: schema.sources.publishedAt,
      evidence: sql<string | null>`${schema.roundSources.fieldClaims}->>'evidence'`,
    })
    .from(schema.roundSources)
    .innerJoin(schema.sources, eq(schema.sources.id, schema.roundSources.sourceId))
    .where(eq(schema.roundSources.roundId, roundId));
}

/**
 * Whether a day borrowed from a page (its byline or metadata, not its sentence) is too far before the
 * round's own release to be a report of it: a company post from March that links the October round, a
 * trade story on the launch whose sidebar names it, a page whose metadata reads the day backwards.
 */
export function staleBeforeRelease(day: string, basis: string | null | undefined, release: string | null): boolean {
  if (!release || basis === "stated") return false;
  return Date.parse(release) - Date.parse(day) > RELEASE_LEAD_DAYS * 86_400_000;
}

/** A page's own URL dates it to another day than the one its byline or metadata lent the reading (a month and day read backwards); a wire's upload day a day off is its own. */
function urlContradicts(r: FeedRecord): boolean {
  if (r.date_basis === "stated") return false;
  const day = dateFromUrl(r.sources[0]?.url);
  return day !== null && Math.abs(day.getTime() - Date.parse(`${r.announced_date}T12:00:00Z`)) > 86_400_000;
}

/**
 * The earliest independently dated same-round reading. Never an undated search snippet, a page's day
 * far before the round's own release (staleBeforeRelease), or a page's day its own URL contradicts.
 */
export function earliestReport(
  readings: readonly FeedRecord[],
  companyDomain: string | null,
  investorDomains: readonly string[] = [],
  tiers: Record<string, number> = DEFAULT_TIERS,
  release: string | null = null,
): string | null {
  const dated = readings.filter(
    (r) =>
      r.announced_date &&
      r.date_precision === "day" &&
      r.date_basis !== "result" &&
      !staleBeforeRelease(r.announced_date, r.date_basis, release) &&
      !urlContradicts(r),
  );
  const weak = dated.filter((r) => {
    const source = r.sources[0];
    const domain = source && registrableDomain(source.url);
    return (
      domain && domain !== companyDomain && !investorDomains.includes(domain) && (tiers[hostOf(source.url)] ?? tiers[domain] ?? 0) < 0.7
    );
  });
  const independentlyReported = visibilityEvidence(
    weak.flatMap((r) => r.sources),
    null,
    [],
    tiers,
  );
  return (
    dated
      .filter((r) => {
        const source = r.sources[0];
        const domain = source && registrableDomain(source.url);
        return (
          domain &&
          (domain === companyDomain ||
            investorDomains.includes(domain) ||
            (tiers[hostOf(source.url)] ?? tiers[domain] ?? 0) >= 0.7 ||
            (independentlyReported && weak.includes(r)))
        );
      })
      .map((r) => r.announced_date as string)
      .sort()[0] ?? null
  );
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Whether an evidence sentence writes this day out: "June 24, 2026", "24 June", "2026-06-24". */
function quotesDay(quotes: readonly string[], day: string): boolean {
  const [, m, d] = day.split("-").map(Number);
  const month = `${MONTHS[(m as number) - 1]}[a-z]*\\.?`;
  const written = new RegExp(`\\b(?:${month}\\s+0?${d}\\b|\\b0?${d}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${month})|${day}`, "i");
  return quotes.some((q) => written.test(q));
}

export interface StaleReportDayChange {
  id: string;
  from: string;
  to: string;
  /** The round left history: the stale day had made it a late report, and its release is inside the news window. */
  backToFeed: boolean;
}

/**
 * Re-date stored rounds caught as news whose day sits far before their own release (releaseDay), when
 * the release falls inside the news window of the round's first sighting and no evidence sentence writes
 * the day out: a day a page's byline or metadata lent the earliest-report check and stored as if stated,
 * or a year an extraction misread. The release's day replaces it, and a round the reported-later rule
 * moved to history on the old day returns to the feed. A pinned day, and a round the history lane
 * promoted, stay. A dry run by default.
 */
export async function repairStaleReportDays(handle: Db, apply = false): Promise<StaleReportDayChange[]> {
  const { fundingRounds, companies } = schema;
  const tiers = { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
  const rows = await handle
    .select({
      id: fundingRounds.id,
      announcedOn: fundingRounds.announcedOn,
      pinned: fundingRounds.pinned,
      evidence: fundingRounds.evidenceQuotes,
      history: fundingRounds.history,
      hold: fundingRounds.hold,
      verification: fundingRounds.verification,
      firstSeenAt: fundingRounds.firstSeenAt,
      domain: companies.domain,
    })
    .from(fundingRounds)
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    .where(
      and(
        ne(fundingRounds.disposition, "rejected"),
        eq(fundingRounds.datePrecision, "day"),
        isNotNull(fundingRounds.announcedOn),
        // A release far after the day is, in practice, near the round's first sighting.
        sql`${fundingRounds.announcedOn} ~ '^\\d{4}-\\d{2}-\\d{2}$' and (${fundingRounds.firstSeenAt} at time zone 'UTC')::date - ${fundingRounds.announcedOn}::date > ${RELEASE_LEAD_DAYS}`,
      ),
    );
  const changes: StaleReportDayChange[] = [];
  for (const r of rows) {
    const day = r.announcedOn as string;
    if (r.pinned?.announced_on || quotesDay(r.evidence ?? [], day)) continue;
    // A round the history lane promoted is an old round on purpose; a later release among its sources is another round's.
    const reportedLater = r.history && Boolean(r.hold?.startsWith("reported later:"));
    if (r.history && !reportedLater) continue;
    const release = releaseDay(await storedReleaseSources(handle, r.id), r.domain, tiers);
    if (!release || !staleBeforeRelease(day, null, release)) continue;
    // The release is the news the round was caught as: within the news window of its first sighting.
    const firstSeen = r.firstSeenAt.toISOString().slice(0, 10);
    if (Math.abs(Date.parse(firstSeen) - Date.parse(release)) / 86_400_000 > NEWS_WINDOW_DAYS) continue;
    const backToFeed = reportedLater;
    changes.push({ id: r.id, from: day, to: release, backToFeed });
    if (!apply) continue;
    const verification = r.verification;
    await handle
      .update(fundingRounds)
      .set({
        announcedOn: release,
        datePrecision: "day",
        dateBasis: "page",
        freshnessCheckedOn: release,
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
