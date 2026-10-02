// This browser's company requests, kept in localStorage: no account, no email. Pure, so the storage
// rules (dedupe, dismissal, the seven-day expiry of finished requests) are tested without a browser.

import type { CompanyRequestStatus } from "@fireround/core/db/schema";

export const REQUEST_HISTORY_KEY = "fireround:company-requests";
const FINISHED_TTL_MS = 7 * 86_400_000;
const MAX_ENTRIES = 20;

export interface StoredRequest {
  id: string;
  domain: string;
  submittedAt: number;
  /** When a status check first saw it done, refused, or failed; the seven days count from here. */
  finishedAt?: number;
  /** How it finished, so a finished request needs no further status checks. */
  outcome?: Extract<CompanyRequestStatus, "done" | "refused" | "failed">;
  /** The visitor has seen the finished result (the company page, or the refused or failed page); the entry then leaves the list. */
  viewed?: boolean;
}

const OUTCOMES = new Set(["done", "refused", "failed"]);

/** What was stored, kept only where every field is the right shape. */
export function parseRequestHistory(raw: string | null): StoredRequest[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is StoredRequest =>
        typeof entry?.id === "string" &&
        /^[0-9a-f-]{36}$/.test(entry.id) &&
        typeof entry.domain === "string" &&
        entry.domain.length > 0 &&
        Number.isFinite(entry.submittedAt) &&
        (entry.finishedAt === undefined || Number.isFinite(entry.finishedAt)) &&
        (entry.outcome === undefined || OUTCOMES.has(entry.outcome)) &&
        (entry.viewed === undefined || typeof entry.viewed === "boolean"),
    );
  } catch {
    return [];
  }
}

/** The newest request first; a second request for the same domain replaces the first. */
export function addRequest(list: StoredRequest[], entry: StoredRequest): StoredRequest[] {
  return [entry, ...list.filter((r) => r.id !== entry.id && r.domain !== entry.domain)].slice(0, MAX_ENTRIES);
}

export function dismissRequest(list: StoredRequest[], id: string): StoredRequest[] {
  return list.filter((r) => r.id !== id);
}

/** Stamps the first time a request is seen finished, with how it ended; an already stamped one is left alone. */
export function markFinished(
  list: StoredRequest[],
  id: string,
  outcome: NonNullable<StoredRequest["outcome"]>,
  now: number,
): StoredRequest[] {
  return list.map((r) => (r.id === id && r.finishedAt === undefined ? { ...r, finishedAt: now, outcome } : r));
}

/**
 * The visitor saw a finished result: by View, or by opening the result page once it was done, refused,
 * or failed. Only a finished outcome marks it, so a request still running is never dropped this way.
 */
export function markViewed(
  list: StoredRequest[],
  which: (r: StoredRequest) => boolean,
  outcome: NonNullable<StoredRequest["outcome"]>,
  now: number,
): StoredRequest[] {
  return list.map((r) => (which(r) ? { ...r, viewed: true, finishedAt: r.finishedAt ?? now, outcome: r.outcome ?? outcome } : r));
}

/** Seen results leave the list at once; any other finished request seven days after it finished. */
export function pruneRequests(list: StoredRequest[], now: number): StoredRequest[] {
  return list.filter((r) => !r.viewed && (r.finishedAt === undefined || now - r.finishedAt < FINISHED_TTL_MS));
}

/** "researching · 2 min", "ready", "couldn't verify": the line each request shows. */
export function requestLine(status: CompanyRequestStatus | null, submittedAt: number, now: number): string {
  if (status === "done") return "ready";
  if (status === "refused" || status === "failed") return "couldn't verify";
  return `researching · ${Math.max(1, Math.floor((now - submittedAt) / 60_000))} min`;
}
