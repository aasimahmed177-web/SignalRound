// The browser half of lib/company-request-history.ts: this browser's list in localStorage. A browser
// that refuses storage simply has no list; nothing else depends on it.

import { markViewed, parseRequestHistory, REQUEST_HISTORY_KEY, type StoredRequest } from "@/lib/company-request-history";

export function loadRequests(): StoredRequest[] {
  try {
    return parseRequestHistory(localStorage.getItem(REQUEST_HISTORY_KEY));
  } catch {
    return [];
  }
}

export function saveRequests(list: StoredRequest[]) {
  try {
    localStorage.setItem(REQUEST_HISTORY_KEY, JSON.stringify(list));
  } catch {}
}

/** A request's result page was seen. */
export function viewRequest(which: (r: StoredRequest) => boolean, outcome: NonNullable<StoredRequest["outcome"]>) {
  saveRequests(markViewed(loadRequests(), which, outcome, Date.now()));
}
