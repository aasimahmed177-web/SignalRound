// Every visible investor's website at once: the resolver the lanes run (lib/investor-enrich.ts), over
// the whole directory, as a plan first and a write second. The plan reads the store and calls
// NativeWebClient but writes nothing, so it can run against production with a read-only role; the apply
// writes a saved plan without another call, so what was reviewed is what lands.
//
// An investor with no domain gets the full resolution. One that has a domain gets its homepage read
// with the same verdict: confirmed (and its profile and logo filled), refuted (a person's own site, a
// startup, another organization, a redirect elsewhere, a parked page), in which case a fresh
// resolution looks for the right one, or unreadable, which keeps it.

import { type InvestorType, mapLimit, storedCandidate } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import type { NativeWebClient } from "@fireround/core/web";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { type InvestorResolution, investorEvidence, pressReader, readInvestorHomepage, resolveInvestor } from "./investor-enrich.ts";

const { fundingRounds, investors, roundInvestors } = schema;

export interface BackfillInvestor {
  id: string;
  name: string;
  domain: string | null;
  logoUrl: string | null;
  rounds: number;
}

/**
 * Every investor on a visible round, most rounds first. Only columns every deployed schema has, so
 * the plan can read a database the investor-profile migration has not reached yet.
 */
export async function visibleInvestors(handle: Db, ids?: string[]): Promise<BackfillInvestor[]> {
  return handle
    .select({
      id: investors.id,
      name: investors.name,
      domain: investors.domain,
      logoUrl: investors.logoUrl,
      rounds: sql<number>`count(distinct ${fundingRounds.id})::int`,
    })
    .from(investors)
    .innerJoin(roundInvestors, eq(roundInvestors.investorId, investors.id))
    .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
    .where(and(inArray(fundingRounds.disposition, ["publish", "flagged"]), ids ? inArray(investors.id, ids) : undefined))
    .groupBy(investors.id, investors.name, investors.domain, investors.logoUrl)
    .orderBy(sql`count(distinct ${fundingRounds.id}) desc`, investors.id);
}

/**
 * What the apply does with one investor.
 *   set: write a new domain (none before, or a refuted one replaced) with its logo and profile.
 *   confirm: the stored domain verified; write its profile, and its logo when it had none.
 *   clear: the stored domain was refuted and nothing replaced it; domain, logo, and profile go.
 *   person: an individual; recorded as a person, no domain.
 *   keep: a stored domain that could not be read or re-judged; untouched.
 *   none: nothing verified; stamped as checked so the lanes wait a month before trying again.
 */
export type BackfillAction = "set" | "confirm" | "clear" | "person" | "keep" | "none";

export interface BackfillEntry {
  id: string;
  name: string;
  rounds: number;
  before: { domain: string | null; logo_url: string | null };
  action: BackfillAction;
  domain: string | null;
  confidence: "verified" | "snippet" | null;
  type: InvestorType | null;
  description: string | null;
  headquarters: string | null;
  logo_url: string | null;
  origin: string | null;
  reason: string;
  refused: Array<{ domain: string; reason: string }>;
  credits: number;
}

/** Refusals that say the stored site is not this investor's; a bar on the label alone is only a reason to look again. */
const HARD_REFUSAL =
  /^(?:a person's own site|not the named investor|redirects to|parked or unavailable|startup or other company|news, directory)/;

function entryOf(inv: BackfillInvestor, action: BackfillAction, r: Partial<InvestorResolution> & { reason: string }): BackfillEntry {
  return {
    id: inv.id,
    name: inv.name,
    rounds: inv.rounds,
    before: { domain: inv.domain, logo_url: inv.logoUrl },
    action,
    domain: r.domain ?? null,
    confidence: r.confidence ?? null,
    type: r.type ?? null,
    description: r.description ?? null,
    headquarters: r.headquarters ?? null,
    logo_url: r.logo ?? null,
    origin: r.origin ?? null,
    reason: r.reason,
    refused: r.refused ?? [],
    credits: r.credits ?? 0,
  };
}

/**
 * The plan for these investors, one entry each, without a write. `onEntry` sees each as it lands, so
 * a long run can be followed and saved as it goes. A search that throws is recorded as "none" with
 * its error, not retried here: the lanes' backlog pass reaches it.
 */
export async function planInvestorBackfill(
  handle: Db,
  client: NativeWebClient,
  list: BackfillInvestor[],
  options: { concurrency?: number; reverify?: boolean; onEntry?: (e: BackfillEntry) => void } = {},
): Promise<{ entries: BackfillEntry[]; pressCredits: number }> {
  const evidence = await investorEvidence(
    handle,
    list.map((i) => i.id),
  );
  const press = pressReader(client);
  const entries = await mapLimit(list, options.concurrency ?? 8, async (inv): Promise<BackfillEntry> => {
    const e = evidence.get(inv.id);
    const resolve = () => resolveInvestor(client, inv.name, { pressPages: e?.pressPages, readPress: press, context: e?.context });
    let entry: BackfillEntry;
    try {
      if (inv.domain && options.reverify === false) {
        entry = entryOf(inv, "keep", { domain: inv.domain, reason: "stored; not re-verified" });
      } else if (inv.domain) {
        const candidate = storedCandidate(inv.name, inv.domain);
        const read = candidate ? await readInvestorHomepage(client, inv.name, candidate, e?.context) : null;
        if (!read) entry = entryOf(inv, "keep", { domain: inv.domain, reason: "no firm to verify the stored domain against" });
        else if (read.verdict.ok) {
          const v = read.verdict;
          entry = entryOf(inv, v.domain === inv.domain ? "confirm" : "set", {
            domain: v.domain,
            confidence: "verified",
            type: v.type,
            description: v.description,
            headquarters: v.headquarters,
            logo: read.logo,
            origin: "stored",
            reason: v.reason,
            credits: read.credits,
          });
        } else if (read.verdict.unreadable || !HARD_REFUSAL.test(read.verdict.reason)) {
          entry = entryOf(inv, "keep", { domain: inv.domain, reason: `kept: ${read.verdict.reason}`, credits: read.credits });
        } else {
          const r = await resolve();
          const refused = [{ domain: inv.domain, reason: read.verdict.reason }, ...r.refused];
          const credits = read.credits + r.credits;
          if (r.outcome === "resolved" && r.domain === inv.domain) entry = entryOf(inv, "confirm", { ...r, refused, credits });
          else if (r.outcome === "resolved") entry = entryOf(inv, "set", { ...r, refused, credits });
          else if (r.outcome === "person") entry = entryOf(inv, "clear", { ...r, refused, credits, reason: `refuted; ${r.reason}` });
          else entry = entryOf(inv, "clear", { refused, credits, reason: `refuted: ${read.verdict.reason}` });
        }
      } else {
        const r = await resolve();
        entry = entryOf(inv, r.outcome === "resolved" ? "set" : r.outcome === "person" ? "person" : "none", r);
      }
    } catch (err) {
      entry = entryOf(inv, inv.domain ? "keep" : "none", {
        domain: inv.domain,
        reason: `error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    options.onEntry?.(entry);
    return entry;
  });
  return { entries, pressCredits: press.credits() };
}

/**
 * Write a plan. Every write is conditioned on the row still holding what the plan saw, so an entry
 * the lanes overtook since (a domain written in the meantime) is skipped, not overwritten. Returns
 * how many rows each action changed.
 */
export async function applyInvestorBackfill(handle: Db, entries: BackfillEntry[]): Promise<Record<BackfillAction, number>> {
  const done: Record<BackfillAction, number> = { set: 0, confirm: 0, clear: 0, person: 0, keep: 0, none: 0 };
  const now = new Date();
  for (const e of entries) {
    const unchanged = e.before.domain === null ? isNull(investors.domain) : eq(investors.domain, e.before.domain);
    const where = and(eq(investors.id, e.id), unchanged);
    const profile = { kind: e.type, description: e.description, headquarters: e.headquarters };
    let rows: Array<{ id: string }> = [];
    if (e.action === "set") {
      rows = await handle
        .update(investors)
        .set({
          domain: e.domain,
          domainCheckedAt: now,
          logoUrl: e.logo_url,
          logoCheckedAt: e.logo_url || e.confidence === "verified" ? now : null,
          ...profile,
        })
        .where(where)
        .returning({ id: investors.id });
    } else if (e.action === "confirm") {
      rows = await handle
        .update(investors)
        .set({ ...profile, logoUrl: sql`coalesce(${investors.logoUrl}, ${e.logo_url})`, logoCheckedAt: now })
        .where(where)
        .returning({ id: investors.id });
    } else if (e.action === "clear") {
      rows = await handle
        .update(investors)
        .set({
          domain: null,
          domainCheckedAt: now,
          logoUrl: null,
          logoCheckedAt: null,
          kind: e.type,
          description: null,
          headquarters: null,
        })
        .where(where)
        .returning({ id: investors.id });
    } else if (e.action === "person") {
      rows = await handle.update(investors).set({ kind: "person", domainCheckedAt: now }).where(where).returning({ id: investors.id });
    } else if (e.action === "none") {
      rows = await handle
        .update(investors)
        .set({ domainCheckedAt: now })
        .where(and(where, or(isNull(investors.domainCheckedAt), sql`${investors.domainCheckedAt} < ${now}`)))
        .returning({ id: investors.id });
    }
    done[e.action] += e.action === "keep" ? 1 : rows.length;
  }
  return done;
}
