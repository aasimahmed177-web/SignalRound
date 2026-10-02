import { createHash, randomUUID } from "node:crypto";
import { knownRound, priorAsKnown, registrableDomain } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { start } from "workflow/api";
import {
  type LedgerPrior,
  ledgerReason,
  type PublicRequestStatus,
  publicRequestStatus,
  STILL_CHECKING,
  tallyFromLedger,
} from "@/lib/company-request-status";
import { db } from "@/lib/db";
import { counted, LIMITS, type RateDecision, rateLimit } from "@/lib/rate-limit";
import { companyRequestWorkflow } from "@/workflows/company-request";
import { publicUrl, type Resolve } from "./safe-fetch.ts";

const { companies, companyRequests, fundingRounds, historyPromotions } = schema;

const NON_COMPANIES = new Set([
  "linkedin.com",
  "crunchbase.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "youtube.com",
  "reddit.com",
  "github.com",
  "medium.com",
  "substack.com",
  "wikipedia.org",
  "wikidata.org",
  "bloomberg.com",
  "reuters.com",
  "techcrunch.com",
  "businesswire.com",
  "prnewswire.com",
  "globenewswire.com",
  "yahoo.com",
  "forbes.com",
  "pitchbook.com",
  "tracxn.com",
  "wellfound.com",
  "producthunt.com",
]);

/** A website becomes its public registrable domain, not an arbitrary path for the worker to crawl. */
export async function normalizeCompanyWebsite(raw: string, resolve?: Resolve): Promise<{ domain: string; url: string } | null> {
  const input = raw.trim();
  if (!input || input.length > 2048 || /\s/.test(input)) return null;
  const address = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  const checked = await publicUrl(address, resolve);
  if (!checked) return null;
  const domain = registrableDomain(checked.toString());
  if (!domain || NON_COMPANIES.has(domain)) return null;
  const url = `https://${domain}/`;
  if (!(await publicUrl(url, resolve))) return null;
  return { domain, url };
}

/** Never retain the raw address in a request row. */
export function requesterHash(address: string): string {
  return createHash("sha256").update(address).digest("hex");
}

export async function knownCompany(handle: Db, domain: string): Promise<string | null> {
  const [row] = await handle.select({ id: companies.id }).from(companies).where(eq(companies.domain, domain)).limit(1);
  if (!row) return null;
  const [round, requested] = await Promise.all([
    handle
      .select({ id: fundingRounds.id })
      .from(fundingRounds)
      .where(and(eq(fundingRounds.companyId, row.id), inArray(fundingRounds.disposition, ["publish", "flagged"])))
      .limit(1),
    handle
      .select({ id: companyRequests.id })
      .from(companyRequests)
      .where(and(eq(companyRequests.companyId, row.id), eq(companyRequests.status, "done")))
      .limit(1),
  ]);
  return round.length || requested.length ? row.id : null;
}

export async function activeCompanyRequest(handle: Db, domain: string): Promise<string | null> {
  const [row] = await handle
    .select({ id: companyRequests.id })
    .from(companyRequests)
    .where(and(eq(companyRequests.domain, domain), inArray(companyRequests.status, ["queued", "running"])))
    .orderBy(desc(companyRequests.createdAt))
    .limit(1);
  return row?.id ?? null;
}

export function companyRequestsDailyMax(): number {
  const configured = Number(process.env.COMPANY_REQUESTS_DAILY_MAX);
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 1000) : 50;
}

/** The newest request behind a company URL: the domain it was submitted for, or the company it finished as. */
export async function companyRequestFor(handle: Db, id: string) {
  const [row] = await handle
    .select({
      id: companyRequests.id,
      domain: companyRequests.domain,
      status: companyRequests.status,
      step: companyRequests.step,
      message: companyRequests.message,
      tally: companyRequests.tally,
      brand: companyRequests.brand,
      dossierStatus: companyRequests.dossierStatus,
      dossierStartedAt: companyRequests.dossierStartedAt,
      dossierFinishedAt: companyRequests.dossierFinishedAt,
      companyId: companyRequests.companyId,
      createdAt: companyRequests.createdAt,
    })
    .from(companyRequests)
    .where(or(eq(companyRequests.domain, id), eq(companyRequests.companyId, id)))
    .orderBy(desc(companyRequests.createdAt))
    .limit(1);
  return row ?? null;
}

/** Every earlier round research put on the history ledger for the company, and what became of each. */
export async function requestTally(handle: Db, companyId: string) {
  const rows = await handle
    .select({
      prior: historyPromotions.prior,
      status: historyPromotions.status,
      origin: historyPromotions.origin,
      attempts: historyPromotions.attempts,
      outcome: historyPromotions.outcome,
    })
    .from(historyPromotions)
    .where(eq(historyPromotions.companyId, companyId))
    .orderBy(historyPromotions.createdAt);
  // One round found by several sources (the search, Apollo, the dossier) is one line: the best outcome stands.
  const rank = (row: LedgerPrior) => {
    const reason = ledgerReason(row);
    return reason === null ? 2 : reason === STILL_CHECKING ? 1 : 0;
  };
  const kept: LedgerPrior[] = [];
  for (const row of rows.map((r) => ({ ...r, outcome: r.outcome as LedgerPrior["outcome"] }))) {
    if (row.outcome?.duplicateOf) continue;
    const mine = priorAsKnown(row.prior);
    const same = kept.findIndex((k) => {
      const theirs = priorAsKnown(k.prior);
      // Two named stages that differ are two rounds, whatever their amounts.
      return (!mine.stage || !theirs.stage || mine.stage === theirs.stage) && knownRound(mine, [theirs]);
    });
    if (same < 0) kept.push(row);
    else if (rank(row) > rank(kept[same])) kept[same] = row;
  }
  return tallyFromLedger(kept);
}

/** "about 1 hour 32 minutes": a wait as a person reads it, never a count of seconds. */
export function waitPhrase(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = hours === 1 ? "1 hour" : `${hours} hours`;
  return rest === 0 ? `about ${h}` : `about ${h} ${rest} ${rest === 1 ? "minute" : "minutes"}`;
}

/** What a visitor over a request budget reads: which budget, and when to come back. */
export function limitMessage(scope: "address" | "global", retryAfter: number): string {
  return scope === "address"
    ? `You've used today's ${LIMITS.companyRequest.limit} research requests. You can request another in ${waitPhrase(retryAfter)}.`
    : `Fireround has reached today's research limit. Try again in ${waitPhrase(retryAfter)}.`;
}

export const companyPath = (companyId: string) => `/companies/${encodeURIComponent(companyId)}`;
export const requestPath = (id: string) => `/requests/${id}`;

export type CompanyRequestOutcome =
  | { kind: "request"; id: string; domain: string; created: boolean }
  | { kind: "company"; companyId: string }
  | { kind: "limited"; scope: "address" | "global"; decision: RateDecision }
  | { kind: "refused"; status: 400 | 503; error: string };

/**
 * The one way a website becomes a research job, shared by the request page's POST and the MCP tool so
 * neither door can skip the website check, the dedupe, the per-address limit, or the global cap.
 * Dedupe and known companies answer before any budget is spent, so asking twice costs nothing. An
 * insider (an admin, or anyone on a private instance) skips the per-address limit, never the global cap.
 */
export async function submitCompanyRequest(website: string, address: string, insider = false): Promise<CompanyRequestOutcome> {
  const site = await normalizeCompanyWebsite(website);
  if (!site) return { kind: "refused", status: 400, error: "Enter a public company website, not a directory or news site." };
  try {
    const handle = await db();
    const active = await activeCompanyRequest(handle, site.domain);
    if (active) return { kind: "request", id: active, domain: site.domain, created: false };
    const companyId = await knownCompany(handle, site.domain);
    if (companyId) return { kind: "company", companyId };
    if (counted(insider)) {
      const perAddress = await rateLimit(LIMITS.companyRequest, address, Date.now(), true);
      if (!perAddress.ok) return { kind: "limited", scope: "address", decision: perAddress };
    }
    const global = await rateLimit(
      { bucket: "company-request-global", limit: companyRequestsDailyMax(), windowMs: 86_400_000 },
      "all",
      Date.now(),
      true,
    );
    if (!global.ok) return { kind: "limited", scope: "global", decision: global };
    const id = randomUUID();
    const [created] = await handle
      .insert(companyRequests)
      .values({ id, domain: site.domain, submittedUrl: site.url, requesterHash: requesterHash(address) })
      .onConflictDoNothing()
      .returning({ id: companyRequests.id });
    if (!created) {
      const concurrent = await activeCompanyRequest(handle, site.domain);
      if (concurrent) return { kind: "request", id: concurrent, domain: site.domain, created: false };
      return { kind: "refused", status: 503, error: "The request could not be started. Please try again." };
    }
    try {
      await start(companyRequestWorkflow, [id]);
    } catch {
      await handle
        .update(companyRequests)
        .set({ status: "failed", message: "Research could not be started. Please try again later.", updatedAt: new Date() })
        .where(eq(companyRequests.id, id));
      return { kind: "refused", status: 503, error: "Research could not be started. Please try again later." };
    }
    return { kind: "request", id, domain: site.domain, created: true };
  } catch {
    return { kind: "refused", status: 503, error: "The request could not be saved. Please try again later." };
  }
}

/**
 * What anyone holding a request id may read, for the status route and MCP alike: never the requester
 * or the raw submission (publicRequestStatus).
 */
export async function companyRequestStatus(handle: Db, id: string): Promise<PublicRequestStatus | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const [row] = await handle
    .select({
      id: companyRequests.id,
      domain: companyRequests.domain,
      status: companyRequests.status,
      step: companyRequests.step,
      message: companyRequests.message,
      tally: companyRequests.tally,
      brand: companyRequests.brand,
      dossierStatus: companyRequests.dossierStatus,
      dossierStartedAt: companyRequests.dossierStartedAt,
      dossierFinishedAt: companyRequests.dossierFinishedAt,
      companyId: companyRequests.companyId,
      createdAt: companyRequests.createdAt,
    })
    .from(companyRequests)
    .where(eq(companyRequests.id, id))
    .limit(1);
  if (!row) return null;
  // While research runs, the tally is read live from the ledger, so the page can count rounds as they are checked.
  const tally = row.status === "running" && row.companyId ? await requestTally(handle, row.companyId) : row.tally;
  return publicRequestStatus({ ...row, tally });
}
