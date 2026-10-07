import type {
  CompanyRequestBrand,
  CompanyRequestStatus,
  CompanyRequestStep,
  CompanyRequestTally,
  HistoryPrior,
} from "@fireround/core/db/schema";
import { HISTORY_MAX_ATTEMPTS } from "./history-tally.ts";

export interface PublicRequestStatus {
  id: string;
  domain: string;
  status: CompanyRequestStatus;
  step: CompanyRequestStep | null;
  message: string | null;
  tally: CompanyRequestTally | null;
  /** The homepage's branding while research runs; withheld once a request is refused or failed, so it never reads as a verified company. */
  brand: CompanyRequestBrand | null;
  dossier: RequestDossier | null;
  createdAt: string;
  companyUrl: string;
}

export interface RequestStepView {
  key: "website" | "profile" | "search" | "dossier" | "rounds";
  label: string;
  hint?: string;
  state: "done" | "current" | "pending";
}

/** The Deep dive's own progress: it runs on after the request is done. */
export interface RequestDossier {
  status: "running" | "done" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
}

/** Where the request's own steps have got to: the Deep dive is tracked apart, and "rounds" is the search's rounds being verified. */
const ORDER: CompanyRequestStep[] = ["website", "profile", "history", "rounds"];

/**
 * The steps as the page lists them. The request's own steps (website, profile, funding search) tick
 * in order and are all done once it is done; the dossier ticks on its own, and may still be running
 * on the finished page; the rounds step ticks once every round found so far is checked.
 */
export function requestSteps(
  request: Pick<PublicRequestStatus, "status" | "step"> & { tally?: CompanyRequestTally | null; dossier?: RequestDossier | null },
): RequestStepView[] {
  const done = request.status === "done";
  const stopped = request.status === "refused" || request.status === "failed";
  const at = done ? ORDER.length : Math.max(0, ORDER.indexOf(request.step ?? "website"));
  const own = (i: number): RequestStepView["state"] => (i < at ? "done" : i === at && !stopped ? "current" : "pending");
  const dossier = request.dossier?.status ?? null;
  const tally = request.tally;
  const checked = tally ? tally.priors.filter((p) => p.reason !== STILL_CHECKING).length : 0;
  const rounds: Pick<RequestStepView, "hint" | "state"> =
    tally && tally.found > 0
      ? { hint: `${checked} of ${tally.found} checked`, state: checked === tally.found ? "done" : stopped ? "pending" : "current" }
      : done && dossier !== "running"
        ? { hint: "none found", state: "done" }
        : { state: "pending" };
  return [
    { key: "website", label: "Website checked", state: own(0) },
    { key: "profile", label: "Company profile", state: own(1) },
    { key: "search", label: "Funding search", state: own(2) },
    {
      key: "dossier",
      label: "Company dossier",
      hint: dossier === "failed" ? "did not finish" : "Firecrawl Agent, usually 3 to 8 minutes",
      state: dossier === "done" ? "done" : dossier === "running" && !stopped ? "current" : "pending",
    },
    { key: "rounds", label: "Earlier rounds verified", ...rounds },
  ];
}

/** A done request whose Deep dive is still running: the page is usable, and more may yet arrive. */
export function dossierPending(request: { status: CompanyRequestStatus; dossier?: RequestDossier | null }): boolean {
  return request.status === "done" && request.dossier?.status === "running";
}

export function requestFinished(status: CompanyRequestStatus): boolean {
  return status === "done" || status === "refused" || status === "failed";
}

/** A request row as a visitor may see it: never the submitted URL or the requester hash. */
export function publicRequestStatus(row: {
  id: string;
  domain: string;
  status: CompanyRequestStatus;
  step: CompanyRequestStep | null;
  message: string | null;
  tally: CompanyRequestTally | null;
  brand?: CompanyRequestBrand | null;
  dossierStatus?: RequestDossier["status"] | null;
  dossierStartedAt?: Date | null;
  dossierFinishedAt?: Date | null;
  companyId: string | null;
  createdAt: Date;
}): PublicRequestStatus {
  return {
    id: row.id,
    domain: row.domain,
    status: row.status,
    step: row.step,
    message: row.message,
    tally: row.tally,
    brand: row.status === "refused" || row.status === "failed" ? null : (row.brand ?? null),
    dossier: row.dossierStatus
      ? {
          status: row.dossierStatus,
          startedAt: row.dossierStartedAt?.toISOString() ?? null,
          finishedAt: row.dossierFinishedAt?.toISOString() ?? null,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    companyUrl: requestCompanyPath(row),
  };
}

/** The one address a request lives at: its domain, or the company it finished as when that differs. */
export function requestCompanyPath(row: { domain: string; status: CompanyRequestStatus; companyId: string | null }): string {
  return `/companies/${encodeURIComponent(row.status === "done" && row.companyId ? row.companyId : row.domain)}`;
}

/** One ledger row for an earlier round, as history_promotions stores it. */
export interface LedgerPrior {
  prior: HistoryPrior;
  status: string;
  origin?: string;
  attempts?: number;
  outcome: { reason?: string; disposition?: string | null; duplicateOf?: string } | null;
}

export const STILL_CHECKING = "still checking";

function priorLabel(p: HistoryPrior): string {
  return [p.stage_as_written, p.amount_as_written, p.announced_date].filter((part) => part?.trim()).join(", ") || "Unlabelled round";
}

/** Why a round stayed unverified, phrased to follow "for it" or "for either". Null once it is on the company's page. */
export function ledgerReason(row: LedgerPrior): string | null {
  const reason = row.outcome?.reason ?? "";
  if (row.status === "promoted") {
    return row.outcome?.disposition === "publish" || row.outcome?.disposition === "flagged" ? null : "not cleared by the feed's checks";
  }
  if (row.status === "skipped") return "not enough detail to search";
  // A failed try the lane will retry on its backoff is not a verdict yet.
  if (row.status === "failed")
    return (row.attempts ?? HISTORY_MAX_ATTEMPTS) < HISTORY_MAX_ATTEMPTS ? STILL_CHECKING : "search could not be completed";
  if (row.status === "no_source") {
    if (reason === "reported, not announced") return reason;
    if (reason.startsWith("the read-back")) return "no matching announcement found";
    // Retrospectives and encyclopedias recount a pre-web round, but no dated announcement of it is online.
    const year = Number(/^(\d{4})/.exec(row.prior.announced_date ?? "")?.[1]);
    if (year && year < 1995) return `no dated announcement online from the ${Math.floor(year / 10) * 10}s`;
    if (reason === "only funding databases state it") return "stated only by funding databases, no announcement found";
    return reason === "no candidate page" ? "no page found" : "no dated announcement found";
  }
  return STILL_CHECKING;
}

/** Who found a round, as the tally names it. */
const SOURCES: Record<string, string> = {
  dossier: "company dossier",
  check: "company dossier",
  search: "funding search",
  gap: "gap search",
  apollo: "an earlier lead",
  audit: "audit",
};

/** A dossier's prior the funding search already put on the ledger is one round, counted once. */
export function tallyFromLedger(rows: LedgerPrior[]): CompanyRequestTally {
  const priors = rows
    .filter((row) => !row.outcome?.duplicateOf)
    .map((row) => {
      const reason = ledgerReason(row);
      return { label: priorLabel(row.prior), verified: reason === null, reason, source: SOURCES[row.origin ?? "dossier"] ?? row.origin };
    });
  return { found: priors.length, verified: priors.filter((p) => p.verified).length, priors };
}

function rounds(n: number): string {
  return `${n} earlier ${n === 1 ? "round" : "rounds"}`;
}

/** "Found 2 earlier rounds in research, verified 0: no dated announcement found for either." */
export function tallyMessage(tally: CompanyRequestTally): string {
  if (tally.found === 0) return "Company added. Research found no earlier funding rounds to check.";
  const head = `Found ${rounds(tally.found)} in research, verified ${tally.verified}`;
  const missed = tally.priors.filter((p) => !p.verified);
  if (missed.length === 0) return `${head}.`;
  const reasons = [...new Set(missed.map((p) => p.reason))];
  if (reasons.length === 1) {
    const which = missed.length === 1 ? "it" : missed.length === 2 ? "either" : "any of them";
    return `${head}: ${reasons[0]} for ${which}.`;
  }
  return `${head}. Not verified: ${reasons.map((r) => `${r} (${missed.filter((p) => p.reason === r).length})`).join(", ")}.`;
}
