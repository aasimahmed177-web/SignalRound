// The X announcements lane against the store: leads kept one per post, the ones due a search for
// their article, whether the store already holds the round, and the company's homepage for the
// check that decides whether a post may land on its own (packages/core/src/trending/announcements.ts).

import type { AnnouncementLead } from "@fireround/core";
import { confirmsLead, nextAttemptAt, normalizeCompanyKey, X_CONFIRMATION_WINDOW_HOURS } from "@fireround/core";
import { type Db, schema } from "@fireround/core/db";
import { and, eq, gte, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";

const { announcementLeads, companies, fundingRounds } = schema;

/** A lead as a workflow step passes it: dates as ISO strings, so the value serializes as it is. */
export interface LeadRow extends Omit<AnnouncementLead, "postedAt"> {
  postedAt: string | null;
  status: string;
  attempts: number;
  firstSeenAt: string;
  readUrls: string[];
  selfCheckedAt: string | null;
  selfVerified: boolean;
  roundId: string | null;
  /** What the last attempt noted: a founder bio that did not link the company, a profile page expired. */
  note: string | null;
}

/** Leads due per run at most: each costs a search, and a matched page an extraction, a read-back, and a persist. */
export const LEADS_PER_RUN = 60;

/** New leads written, each due at once; a lead already on record (the same post in a later search) is left as it is. */
export async function storeLeads(handle: Db, leads: AnnouncementLead[], now: Date): Promise<number> {
  if (leads.length === 0) return 0;
  const rows = await handle
    .insert(announcementLeads)
    .values(
      leads.map((l) => ({
        key: l.key,
        kind: l.kind,
        url: l.url,
        handle: l.handle,
        authorName: l.authorName,
        via: l.via,
        company: l.company,
        companyHandle: l.companyHandle,
        amountAsWritten: l.amountAsWritten,
        amountValue: l.amountValue,
        currency: l.currency,
        usdMillions: l.usdMillions,
        label: l.label,
        leadInvestors: l.leadInvestors,
        text: l.text,
        postedAt: l.postedAt,
        nextAttemptAt: now,
        firstSeenAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing()
    .returning({ key: announcementLeads.key });
  return rows.length;
}

function toRow(r: typeof announcementLeads.$inferSelect): LeadRow {
  return {
    key: r.key,
    kind: r.kind === "profile" ? "profile" : "post",
    url: r.url,
    handle: r.handle,
    authorName: r.authorName,
    via: r.via,
    company: r.company,
    companyHandle: r.companyHandle,
    amountAsWritten: r.amountAsWritten,
    amountValue: r.amountValue,
    currency: r.currency,
    usdMillions: r.usdMillions,
    label: r.label,
    leadInvestors: r.leadInvestors,
    text: r.text,
    postedAt: r.postedAt?.toISOString() ?? null,
    status: r.status,
    attempts: r.attempts,
    firstSeenAt: r.firstSeenAt.toISOString(),
    readUrls: r.readUrls,
    selfCheckedAt: r.selfCheckedAt?.toISOString() ?? null,
    selfVerified: r.selfVerified,
    roundId: r.roundId,
    note: r.note ?? null,
  };
}

/** A stored lead back as the pure rules read it. */
export function asLead(r: LeadRow): AnnouncementLead {
  return { ...r, postedAt: r.postedAt ? new Date(r.postedAt) : null };
}

/** Leads whose next search is due: pending ones, and published ones still looking for their article; oldest due first. */
export async function dueLeads(handle: Db, now: Date, limit = LEADS_PER_RUN): Promise<LeadRow[]> {
  const rows = await handle
    .select()
    .from(announcementLeads)
    .where(
      and(
        inArray(announcementLeads.status, ["pending", "published"]),
        isNotNull(announcementLeads.nextAttemptAt),
        lte(announcementLeads.nextAttemptAt, now),
      ),
    )
    .orderBy(announcementLeads.nextAttemptAt)
    .limit(limit);
  return rows.map(toRow);
}

/** Days either side of a post a stored round may be dated and still be the round it announces. */
const KNOWN_WITHIN_DAYS = 7;

/**
 * The stored round a lead announces, when the store already has it: the same company (by name key or
 * the company's handle as a name) at a figure within 15 percent, dated within a week of the post.
 */
export async function knownRoundFor(handle: Db, lead: AnnouncementLead, now: Date): Promise<string | null> {
  const keys = [lead.company, lead.companyHandle].filter((s): s is string => !!s).map((s) => normalizeCompanyKey(s));
  if (keys.length === 0) return null;
  const at = lead.postedAt ?? now;
  const from = new Date(at.getTime() - KNOWN_WITHIN_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = await handle
    .select({
      id: fundingRounds.id,
      usd: fundingRounds.amountUsdMillions,
      value: fundingRounds.amountValue,
      currency: fundingRounds.amountCurrency,
    })
    .from(fundingRounds)
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    .where(
      and(
        or(
          inArray(companies.nameKey, keys),
          inArray(
            sql`replace(${companies.nameKey}, ' ', '')`,
            keys.map((k) => k.replace(/\s+/g, "")),
          ),
        ),
        ne(fundingRounds.disposition, "rejected"),
        gte(fundingRounds.announcedOn, from),
      ),
    );
  const near = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b) <= 0.15;
  for (const r of rows) {
    if (lead.usdMillions !== null && r.usd !== null && near(lead.usdMillions, Number(r.usd))) return r.id;
    if (lead.currency && r.currency === lead.currency && r.value !== null && near(lead.amountValue, Number(r.value))) return r.id;
  }
  return null;
}

/**
 * The stored leads that independently confirm `lead` (lib's side of `confirmsLead`): other accounts'
 * status posts naming the same company and figure within twelve hours of it, handles returned once each.
 */
export async function confirmingLeads(handle: Db, lead: AnnouncementLead): Promise<string[]> {
  if (!lead.postedAt || !lead.handle) return [];
  const window = X_CONFIRMATION_WINDOW_HOURS * 3_600_000;
  const rows = await handle
    .select()
    .from(announcementLeads)
    .where(
      and(
        eq(announcementLeads.kind, "post"),
        ne(announcementLeads.key, lead.key),
        gte(announcementLeads.postedAt, new Date(lead.postedAt.getTime() - window)),
        lte(announcementLeads.postedAt, new Date(lead.postedAt.getTime() + window)),
      ),
    );
  const out = new Set<string>();
  for (const r of rows) {
    const other = asLead(toRow(r));
    if (other.handle && confirmsLead(lead, other)) out.add(other.handle);
  }
  return [...out];
}

/** The company's homepage the store holds, by the lead's company name. */
export async function storedWebsite(handle: Db, lead: AnnouncementLead): Promise<string | null> {
  const keys = [lead.company, lead.companyHandle].filter((s): s is string => !!s).map((s) => normalizeCompanyKey(s));
  if (keys.length === 0) return null;
  const [row] = await handle
    .select({ website: companies.website })
    .from(companies)
    .where(and(inArray(companies.nameKey, keys), isNotNull(companies.website)))
    .limit(1);
  return row?.website ?? null;
}

export interface LeadOutcome {
  status: "pending" | "corroborated" | "known" | "published" | "expired";
  roundId?: string | null;
  articleUrl?: string | null;
  readUrls?: string[];
  selfCheckedAt?: Date;
  selfVerified?: boolean;
  note?: string | null;
  /** The company, its handle, and the full post, when the search snippet named none and the post was read. */
  company?: { name: string; handle: string; text: string };
}

/**
 * One attempt done: the lead's new state, and its next search from the schedule. A lead that found its
 * article or its stored round stops; a published one keeps searching for an article until the schedule
 * runs out; a pending one past the schedule expires.
 */
export async function finishAttempt(handle: Db, lead: LeadRow, outcome: LeadOutcome, now: Date): Promise<LeadOutcome["status"]> {
  const attempts = lead.attempts + 1;
  const done = outcome.status === "corroborated" || outcome.status === "known";
  const next = done ? null : nextAttemptAt(new Date(lead.firstSeenAt), attempts, lead.kind);
  const status = !done && next === null && outcome.status === "pending" ? "expired" : outcome.status;
  await handle
    .update(announcementLeads)
    .set({
      status,
      attempts,
      nextAttemptAt: next,
      ...(outcome.roundId !== undefined ? { roundId: outcome.roundId } : {}),
      ...(outcome.articleUrl !== undefined ? { articleUrl: outcome.articleUrl } : {}),
      ...(outcome.readUrls ? { readUrls: outcome.readUrls } : {}),
      ...(outcome.selfCheckedAt ? { selfCheckedAt: outcome.selfCheckedAt } : {}),
      ...(outcome.selfVerified !== undefined ? { selfVerified: outcome.selfVerified } : {}),
      ...(outcome.note !== undefined ? { note: outcome.note } : {}),
      ...(outcome.company ? { company: outcome.company.name, companyHandle: outcome.company.handle, text: outcome.company.text } : {}),
      updatedAt: now,
    })
    .where(eq(announcementLeads.key, lead.key));
  return status;
}
