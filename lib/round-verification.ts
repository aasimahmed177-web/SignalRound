import {
  companySite,
  DEFAULT_TIERS,
  hostOf,
  isFundingAggregatorUrl,
  namesCompany,
  registrableDomain,
  secondhandOnly,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { RoundRow } from "./persist.ts";

const { fundingRounds, roundVerification, investors, roundInvestors } = schema;
const HOUR = 3_600_000;
const HOURS = [
  1,
  6,
  24,
  72,
  ...Array.from({ length: 27 }, (_, i) => (i + 4) * 24),
  ...Array.from({ length: 8 }, (_, i) => (37 + i * 7) * 24),
  90 * 24,
];

export function nextVerification(firstSeen: Date, attempts: number): Date | null {
  return attempts < HOURS.length ? new Date(firstSeen.getTime() + HOURS[attempts] * HOUR) : null;
}

/** Wires distribute the issuer's release and are primary evidence, not independent journalism. */
const WIRES = new Set([
  "businesswire.com",
  "prnewswire.com",
  "globenewswire.com",
  "accesswire.com",
  "newswire.ca",
  "einpresswire.com",
  "webwire.com",
]);
const FILINGS = new Set(["sec.gov", "hkexnews.hk", "londonstockexchange.com", "asx.com.au", "sedarplus.ca"]);

/** The read-back establishes fidelity to a page, not the independence or authority of that page. */
export function visibilityEvidence(
  sources: readonly { url: string; title?: string | null; evidence?: string | null }[],
  companyDomain: string | null,
  investorDomains: readonly string[] = [],
  tiers: Record<string, number> = DEFAULT_TIERS,
  historicalCompany?: { name: string; sites: readonly string[] },
  ownAccounts: readonly string[] = [],
): boolean {
  const independent = new Set<string>();
  const titles = new Set<string>();
  const excerpts = new Set<string>();
  for (const source of sources) {
    const domain = registrableDomain(source.url);
    if (!domain || isFundingAggregatorUrl(source.url)) continue;
    if (domain === companyDomain || investorDomains.includes(domain) || WIRES.has(domain) || FILINGS.has(domain)) return true;
    // A post from one of the company's own X accounts is the company announcing, as its own site is.
    const account = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(\w+)\/status\//i.exec(source.url)?.[1]?.toLowerCase();
    if (account && ownAccounts.includes(account)) return true;
    if (historicalCompany && companyDomain) {
      const site = companySite(source.url, { domain: companyDomain, sites: historicalCompany.sites });
      if (site === "own" || (site === "sibling" && namesCompany(`${source.title ?? ""} ${source.evidence ?? ""}`, historicalCompany.name)))
        return true;
    }
    if ((tiers[hostOf(source.url)] ?? tiers[domain] ?? 0) >= 0.7) return true;
    const title = (source.title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    const excerpt = (source.evidence ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (!title || titles.has(title) || /\b(?:press release|news provided by|prnewswire|business wire|globe newswire)\b/i.test(title))
      continue;
    if (excerpt && excerpts.has(excerpt)) continue;
    titles.add(title);
    if (excerpt) excerpts.add(excerpt);
    independent.add(domain);
  }
  return independent.size >= 2;
}

/** Stored links keep the exact sentence that each page contributed to this round. */
export async function storedVisibilityEvidence(
  handle: Db,
  row: Pick<RoundRow, "id" | "sources" | "company">,
  investorDomains: readonly string[] = [],
  tiers: Record<string, number> = DEFAULT_TIERS,
): Promise<boolean> {
  const links = await handle
    .select({ sourceId: schema.roundSources.sourceId, claims: schema.roundSources.fieldClaims })
    .from(schema.roundSources)
    .where(eq(schema.roundSources.roundId, row.id));
  const evidence = new Map(links.map((link) => [link.sourceId, (link.claims as { evidence?: string | null } | null)?.evidence ?? null]));
  return visibilityEvidence(
    row.sources.map((source) => ({ ...source, evidence: evidence.get(source.url) })),
    row.company.domain,
    investorDomains,
    tiers,
    undefined,
    await companyAccounts(handle, row.company.id),
  );
}

/** The company's own X accounts, lowercased, as the X lane recorded them. */
export async function companyAccounts(handle: Db, companyId: string): Promise<string[]> {
  const rows = await handle
    .select({ key: schema.companyAliases.aliasKey })
    .from(schema.companyAliases)
    .where(and(eq(schema.companyAliases.companyId, companyId), eq(schema.companyAliases.kind, "x")));
  return rows.map((r) => r.key);
}

/** An invariant, an identity collision, or a person's Review is not cleared by a successful search. */
export function autoPromotionEligible(notes: readonly string[] | undefined, presetSlug: string): boolean {
  if (presetSlug === "form-d" || !notes?.length) return false;
  const holds = notes.filter((note) => note.startsWith("held for review:"));
  return (
    holds.length > 0 &&
    holds.every(
      (note) => note.includes("source fidelity is not independent confirmation") || note.includes("earliest-report search pending"),
    )
  );
}

export function evidenceComplete(
  row: { sources: readonly Pick<RoundRow["sources"][number], "url" | "title" | "query">[]; company: Pick<RoundRow["company"], "domain"> },
  investorDomains: string[] = [],
  tiers: Record<string, number> = DEFAULT_TIERS,
): boolean {
  const primary = row.sources.some((s) => {
    const domain = registrableDomain(s.url);
    return domain !== null && (domain === row.company.domain || investorDomains.includes(domain) || WIRES.has(domain));
  });
  if (!primary) return false;
  const releaseTitles = new Set(
    row.sources
      .filter((s) => {
        const domain = registrableDomain(s.url);
        return domain && (domain === row.company.domain || investorDomains.includes(domain) || WIRES.has(domain));
      })
      .map((s) =>
        (s.title ?? "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim(),
      )
      .filter(Boolean),
  );
  const news = new Set<string>();
  for (const s of row.sources) {
    const domain = registrableDomain(s.url);
    if (!domain || domain === row.company.domain || investorDomains.includes(domain) || WIRES.has(domain) || isFundingAggregatorUrl(s.url))
      continue;
    const tier = tiers[hostOf(s.url)] ?? tiers[domain] ?? 0;
    if (tier < 0.7 && s.query !== "corroborate:news") continue;
    if (/\b(?:press release|news provided by|prnewswire|business wire|globe newswire)\b/i.test(s.title ?? "")) continue;
    if (
      releaseTitles.has(
        (s.title ?? "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim(),
      )
    )
      continue;
    news.add(domain);
  }
  return news.size > 0;
}

/** New rows needing verification enter immediately, including weak-source rows in Review. */
export async function seedRoundVerification(handle: Db, now = new Date()): Promise<void> {
  await handle.execute(sql`
    INSERT INTO round_verification (round_id, next_attempt_at)
    SELECT id, CASE WHEN disposition = 'review' THEN first_seen_at ELSE first_seen_at + interval '1 hour' END FROM funding_rounds
    WHERE history = false AND (disposition IN ('publish', 'flagged') OR
      (disposition = 'review' AND (verification::text LIKE '%earliest-report search pending%' OR
        verification::text LIKE '%source fidelity is not independent confirmation%')))
    ON CONFLICT DO NOTHING
  `);
  await handle.execute(sql`
    UPDATE round_verification v SET status = 'pending', next_attempt_at = ${now}, updated_at = ${now}
    FROM funding_rounds f
    WHERE f.id = v.round_id AND v.status = 'done' AND f.certainty IN ('expected', 'reported', 'unconfirmed')
      AND f.first_seen_at + interval '90 days' > ${now}
      AND f.history = false AND (f.disposition IN ('publish', 'flagged') OR
        (f.disposition = 'review' AND (f.verification::text LIKE '%earliest-report search pending%' OR
          f.verification::text LIKE '%source fidelity is not independent confirmation%')))
  `);
  await handle
    .update(roundVerification)
    .set({ status: "done", updatedAt: now })
    .where(
      and(
        eq(roundVerification.status, "pending"),
        sql`NOT EXISTS (
      SELECT 1 FROM funding_rounds f WHERE f.id = ${roundVerification.roundId}
        AND f.history = false AND (f.disposition IN ('publish', 'flagged') OR
          (f.disposition = 'review' AND (f.verification::text LIKE '%earliest-report search pending%' OR
            f.verification::text LIKE '%source fidelity is not independent confirmation%')))
    )`,
      ),
    );
}

/** Due entries order by the newest, largest round, then the due time. Claim is atomic across workers. */
export async function claimRoundVerification(handle: Db, claimer: string, limit: number, now = new Date()): Promise<string[]> {
  const due = await handle
    .select({ id: roundVerification.roundId })
    .from(roundVerification)
    .innerJoin(fundingRounds, eq(fundingRounds.id, roundVerification.roundId))
    .where(
      and(
        or(eq(roundVerification.status, "pending"), eq(roundVerification.status, "running")),
        lte(roundVerification.nextAttemptAt, now),
        eq(fundingRounds.history, false),
        or(
          inArray(fundingRounds.disposition, ["publish", "flagged"]),
          and(
            eq(fundingRounds.disposition, "review"),
            sql`(${fundingRounds.verification}::text LIKE '%earliest-report search pending%' OR ${fundingRounds.verification}::text LIKE '%source fidelity is not independent confirmation%')`,
          ),
        ),
      ),
    )
    .orderBy(
      sql`date_trunc('day', ${fundingRounds.firstSeenAt}) DESC`,
      sql`${fundingRounds.amountUsdMillions} DESC NULLS LAST`,
      desc(fundingRounds.firstSeenAt),
      roundVerification.nextAttemptAt,
    )
    .limit(limit * 3);
  const claimed: string[] = [];
  for (const row of due) {
    const taken = await handle
      .update(roundVerification)
      .set({ status: "running", claimedBy: claimer, nextAttemptAt: new Date(now.getTime() + HOUR), updatedAt: now })
      .where(
        and(
          eq(roundVerification.roundId, row.id),
          lte(roundVerification.nextAttemptAt, now),
          or(eq(roundVerification.status, "pending"), eq(roundVerification.status, "running")),
        ),
      )
      .returning({ id: roundVerification.roundId });
    if (taken.length) claimed.push(row.id);
    if (claimed.length >= limit) break;
  }
  return claimed;
}

export async function investorDomainsForRound(handle: Db, roundId: string): Promise<string[]> {
  const rows = await handle
    .select({ domain: investors.domain })
    .from(roundInvestors)
    .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
    .where(eq(roundInvestors.roundId, roundId));
  return rows.flatMap((r) => (r.domain ? [r.domain] : []));
}

export async function completeRoundVerification(handle: Db, roundId: string, now = new Date(), claimer?: string): Promise<void> {
  await handle
    .update(roundVerification)
    .set({ status: "done", claimedBy: null, updatedAt: now })
    .where(and(eq(roundVerification.roundId, roundId), ...(claimer ? [eq(roundVerification.claimedBy, claimer)] : [])));
}

export async function finishRoundVerification(
  handle: Db,
  row: RoundRow,
  credits: number,
  investorDomains: string[],
  tiers: Record<string, number>,
  now = new Date(),
  error: string | null = null,
  claimer?: string,
): Promise<void> {
  const ledger = await handle
    .select({ attempts: roundVerification.attempts, credits: roundVerification.credits })
    .from(roundVerification)
    .where(and(eq(roundVerification.roundId, row.id), ...(claimer ? [eq(roundVerification.claimedBy, claimer)] : [])))
    .limit(1);
  const prior = ledger[0];
  if (!prior) return;
  const attempts = prior.attempts + 1;
  const firstSeen = new Date(row.first_seen_at);
  const next =
    HOURS.slice(attempts)
      .map((hours) => new Date(firstSeen.getTime() + hours * HOUR))
      .find((date) => date > now) ?? null;
  const expired = row.certainty !== "announced" && now.getTime() >= firstSeen.getTime() + 90 * 24 * HOUR;
  const done =
    (row.certainty === "announced" &&
      evidenceComplete(row, investorDomains, tiers) &&
      row.disposition !== "review" &&
      row.freshness_checked_on === row.announced_on) ||
    !next ||
    row.history ||
    row.disposition === "rejected";
  const updated = await handle
    .update(roundVerification)
    .set({
      attempts,
      credits: prior.credits + credits,
      lastCheckedAt: now,
      nextAttemptAt: next ?? now,
      status: done ? "done" : "pending",
      claimedBy: null,
      lastError: error,
      updatedAt: now,
    })
    .where(and(eq(roundVerification.roundId, row.id), ...(claimer ? [eq(roundVerification.claimedBy, claimer)] : [])))
    .returning({ id: roundVerification.roundId });
  if (updated.length === 0) return;
  if (expired) {
    const verification = row.verification ?? { status: "unverified", notes: [], url: null };
    await handle
      .update(fundingRounds)
      .set({
        certainty: "unconfirmed",
        verification: {
          ...verification,
          notes: [...new Set([...verification.notes, "Still unconfirmed 90 days after its first report."])],
        },
        updatedAt: now,
      })
      .where(and(eq(fundingRounds.id, row.id), inArray(fundingRounds.certainty, ["expected", "reported", "unconfirmed"])));
  }
  if (
    done &&
    row.certainty === "announced" &&
    !evidenceComplete(row, investorDomains, tiers) &&
    secondhandOnly(
      row.sources.map((s) => s.url),
      tiers,
    )
  ) {
    const reason = "Verification after 90 days: sources remain secondhand";
    const verification = row.verification ?? { status: "unverified", notes: [], url: null };
    await handle
      .update(fundingRounds)
      .set({
        disposition: "review",
        verification: { ...verification, notes: [...new Set([...verification.notes, reason])] },
        updatedAt: now,
      })
      .where(and(eq(fundingRounds.id, row.id), inArray(fundingRounds.disposition, ["publish", "flagged"])));
  }
}
