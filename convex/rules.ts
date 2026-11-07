// Pure rules the leads and jobs mutations share. No Convex imports, so tests run them directly.

export type Stage = "pre_seed" | "seed" | "series_a" | "series_b" | "series_c";
export type OutreachStatus = "qualified" | "needs_contact" | "contacted" | "replied" | "not_a_fit";

const STAGE_ORDER: Stage[] = ["pre_seed", "seed", "series_a", "series_b", "series_c"];

export function normalizedDomain(website: string): string {
  return new URL(website).hostname.toLowerCase().replace(/^www\./, "");
}

/** Printed publicly: the quote taken from sourceUrl contains the address itself. Nothing else is saved. */
export function postedEmail(email: { email: string; sourceUrl: string; quote?: string | null }): boolean {
  const address = email.email.trim().toLowerCase();
  return Boolean(address && email.sourceUrl && email.quote?.toLowerCase().includes(address));
}

/**
 * The outreach status to write. A new company starts qualified when it has a posted email; an existing one
 * keeps whatever outreach progress it has (contacted, replied, not_a_fit), and only needs_contact moves up
 * to qualified once a posted email arrives.
 */
export function nextOutreachStatus(existing: OutreachStatus | null, hasContacts: boolean): OutreachStatus {
  if (existing === null) return hasContacts ? "qualified" : "needs_contact";
  if (existing === "needs_contact" && hasContacts) return "qualified";
  return existing;
}

/** One round per stage per company: amount strings and first-seen dates vary between runs and sources. */
export function roundKey(domain: string, stage: Stage): string {
  return `${domain}|${stage}`;
}

const UNDISCLOSED = /^\s*(?:undisclosed|unknown|n\/?a|)\s*$/i;

/**
 * Merges a new sighting of a round into the stored one: announcedOn stays the earliest date seen, and a
 * disclosed amount is never replaced by "Undisclosed".
 */
export function mergeRound<R extends { announcedOn: string; amountAsWritten: string; amountUsd?: number }>(old: R, incoming: R): R {
  const keepOldAmount = UNDISCLOSED.test(incoming.amountAsWritten) && !UNDISCLOSED.test(old.amountAsWritten);
  return {
    ...incoming,
    announcedOn: old.announcedOn && old.announcedOn < incoming.announcedOn ? old.announcedOn : incoming.announcedOn,
    ...(keepOldAmount ? { amountAsWritten: old.amountAsWritten, amountUsd: old.amountUsd } : {}),
    ...(incoming.amountUsd === undefined && !keepOldAmount && old.amountUsd !== undefined ? { amountUsd: old.amountUsd } : {}),
  };
}

/** The stage of the latest-dated round; same date, the later stage. */
export function latestStage(rounds: Array<{ stage: Stage; announcedOn: string }>): Stage | null {
  let best: { stage: Stage; announcedOn: string } | null = null;
  for (const round of rounds) {
    if (
      !best ||
      round.announcedOn > best.announcedOn ||
      (round.announcedOn === best.announcedOn && STAGE_ORDER.indexOf(round.stage) > STAGE_ORDER.indexOf(best.stage))
    )
      best = round;
  }
  return best?.stage ?? null;
}

/** Convex's patch removes a field set to undefined; a sighting that omits a field must keep the stored value. */
export function definedOnly<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;
}
