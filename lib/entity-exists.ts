// Whether a company or investor page has anything to show a demo visitor, answered before the page
// streams. The pages render inside Suspense, so their own notFound() lands after a 200 has been
// sent: a soft 404 that crawlers and link checkers count as a live page. The proxy asks here first
// and rewrites a miss to an unmatched path, which Next answers with a real 404.
//
// The answer comes from a snapshot of every id a visitor may open, one query per process a minute,
// not one query per id: a crawler walking thousands of pages, or a burst of made-up ids, then costs
// the database nothing more than a quiet minute does. A few thousand short ids are a few hundred
// kilobytes, so each warm function instance holds its own copy.

import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { decodeParam, investorIdFromParam } from "@/lib/links";

const { companyRequests, fundingRounds, roundInvestors } = schema;

export type EntityKind = "companies" | "investors";

/** The entity a path names, or null: `/companies/<id>` and `/investors/<id>` exactly, nothing below them. */
export function entityPath(pathname: string): { kind: EntityKind; id: string } | null {
  const m = /^\/(companies|investors)\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  const kind = m[1] as EntityKind;
  return { kind, id: kind === "investors" ? investorIdFromParam(m[2]) : decodeParam(m[2]) };
}

/** The feed's dispositions: what a visitor may read, as getCompany and getInvestor count them. */
const VISIBLE = ["publish", "flagged"] as const;

/** Every id with a round a visitor may read, per kind: the companies on one and the investors named on one. */
export type VisibleIds = Record<EntityKind, string[]>;

/** The snapshot's query: two index scans over the rounds, however many ids a crawler asks about. */
export async function loadVisibleIds(): Promise<VisibleIds> {
  const handle = await db();
  const [companies, investors, requests] = await Promise.all([
    handle
      .selectDistinct({ id: fundingRounds.companyId })
      .from(fundingRounds)
      .where(inArray(fundingRounds.disposition, [...VISIBLE])),
    handle
      .selectDistinct({ id: roundInvestors.investorId })
      .from(roundInvestors)
      .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
      .where(inArray(fundingRounds.disposition, [...VISIBLE])),
    handle
      .select({ domain: companyRequests.domain, companyId: companyRequests.companyId, status: companyRequests.status })
      .from(companyRequests),
  ]);
  // A requested company's page lives at its domain from the moment it is submitted: researching,
  // finished, or stopped. A company a request finished as keeps its page whatever the flag says.
  const requestsOn = process.env.COMPANY_REQUESTS === "1";
  const requested = requests.flatMap((r) => [
    ...(requestsOn ? [r.domain] : []),
    ...(r.status === "done" && r.companyId ? [r.companyId] : []),
  ]);
  return {
    companies: [...new Set([...companies.map((r) => r.id), ...requested])],
    investors: investors.map((r) => r.id),
  };
}

export interface SnapshotTiming {
  /** A snapshot this old is refreshed in the background; requests keep reading it meanwhile. */
  ttlMs: number;
  /** A miss against a snapshot this old refreshes it first and asks again, so a company published a moment ago is found. */
  missRefreshMs: number;
  /** After a failed load, no new one starts for this long: a struggling database is not asked again on every request. */
  failBackoffMs: number;
}

const TIMING: SnapshotTiming = { ttlMs: 60_000, missRefreshMs: 10_000, failBackoffMs: 5_000 };

/** No stored id comes near this (the longest are under 70 characters): a longer one is a miss without a refresh. */
const MAX_ID_LENGTH = 200;

/**
 * The visibility check over a loader, pure apart from it, so the tests drive it with a fake. At most
 * one load runs at a time and every waiting request shares it. Whatever the traffic, a process loads
 * at most once a TTL, plus once per missRefreshMs while unknown ids keep arriving.
 *
 * The answer is null only when no snapshot has ever loaded (the page then renders as before and
 * decides for itself). Never throws: a proxy that fails open costs a soft 404, one that fails closed
 * would 404 every company during a database blip. Once a snapshot exists a failed refresh keeps it,
 * so a known page stays up while the database is away.
 */
export function visibilityCheck(load: () => Promise<VisibleIds>, timing: SnapshotTiming = TIMING) {
  let snapshot: { ids: Record<EntityKind, Set<string>>; at: number } | null = null;
  let loading: Promise<void> | null = null;
  let failedAt = Number.NEGATIVE_INFINITY;

  function refresh(now: number): Promise<void> {
    if (loading) return loading;
    if (now - failedAt < timing.failBackoffMs) return Promise.resolve();
    loading = load()
      .then((ids) => {
        snapshot = { ids: { companies: new Set(ids.companies), investors: new Set(ids.investors) }, at: now };
      })
      .catch(() => {
        failedAt = now;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  return async function entityVisible(kind: EntityKind, id: string, now = Date.now()): Promise<boolean | null> {
    if (id.length > MAX_ID_LENGTH) return false;
    if (!snapshot) await refresh(now);
    else if (now - snapshot.at >= timing.ttlMs) void refresh(now);
    if (!snapshot) return null;
    if (snapshot.ids[kind].has(id)) return true;
    if (now - snapshot.at >= timing.missRefreshMs) await refresh(now);
    return snapshot.ids[kind].has(id);
  };
}

/** Whether the page would show a visitor anything; null when the store could not say. */
export const entityVisible = visibilityCheck(loadVisibleIds);

/**
 * Where a company id that no longer exists now lives, or null: the row mergeCompanies folded it into,
 * followed through later folds. A fold from before folds were recorded left the old id behind in one
 * of two places, which are read next: as the survivor's domain (Sol Foundry's solfoundry.co is Sol's
 * domain now) or as a name it was seen under (HEO Robotics is a name alias of HEO). A live id never
 * redirects.
 */
export async function foldedInto(handle: Db, id: string): Promise<string | null> {
  const [live] = await handle.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.id, id)).limit(1);
  if (live) return null;
  const [fold] = await handle
    .select({ id: schema.companies.id })
    .from(schema.companyFolds)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.companyFolds.intoId))
    .where(eq(schema.companyFolds.fromId, id))
    .limit(1);
  if (fold) return fold.id;
  const [byDomain] = await handle
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(eq(schema.companies.domain, id))
    .limit(1);
  if (byDomain) return byDomain.id;
  const [byName] = await handle
    .select({ id: schema.companyAliases.companyId })
    .from(schema.companyAliases)
    .where(and(eq(schema.companyAliases.kind, "name"), eq(schema.companyAliases.aliasKey, id)))
    .limit(1);
  return byName?.id ?? null;
}
