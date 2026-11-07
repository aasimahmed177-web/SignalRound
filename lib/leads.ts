// Funded startups as leads: a funding observation (signal_observations) with the founders a public page names
// (signal_people) and the emails printed verbatim on a public page (signal_emails). Read-only. An email shows only
// when its quote contains it and it names its page; a founder shows only with such an email.

import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, desc, eq, ilike, inArray, ne, or, type SQL, sql } from "drizzle-orm";

export interface LeadEmail {
  email: string;
  kind: string;
  inbox: string | null;
  sourceUrl: string;
  quote: string;
}

export interface LeadFounder {
  name: string;
  role: string | null;
  sourceUrl: string;
  quote: string | null;
  linkedinUrl: string | null;
  emails: LeadEmail[];
}

export interface Lead {
  id: string;
  company: string;
  website: string | null;
  industry: string | null;
  country: string | null;
  stage: string | null;
  amount: string | null;
  announcedOn: Date | null;
  brief: string | null;
  fundingUrl: string;
  otherSources: string[];
  founders: LeadFounder[];
  inboxes: LeadEmail[];
}

export interface LeadFilter {
  q?: string;
  industry?: string;
  /** Only companies with at least one posted email (a founder's or an inbox). */
  withEmail?: boolean;
  limit?: number;
}

export interface LeadListing {
  rows: Lead[];
  industries: string[];
  counts: { companies: number; withEmail: number; founderEmails: number; inboxes: number };
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The stored industry: `{ label }` from the classifier, or a plain string. */
export function industryOf(metadata: Record<string, unknown>): string | null {
  const value = metadata.industry;
  if (value && typeof value === "object" && "label" in value) return text((value as { label: unknown }).label);
  return text(value);
}

/** "b2b_saas" → "B2B SaaS", "real_estate" → "Real estate". */
export function industryLabel(value: string): string {
  const special: Record<string, string> = { b2b_saas: "B2B SaaS", edtech: "Edtech", deeptech: "Deeptech", fintech: "Fintech" };
  if (special[value]) return special[value];
  const words = value.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Posted: the page it came from is named and the quote from that page contains the address. */
export function isPosted(email: { email: string; sourceUrl: string | null; quote: string | null }): boolean {
  return Boolean(email.sourceUrl && email.quote?.toLowerCase().includes(email.email.toLowerCase()));
}

const t = schema.signalObservations;
const industrySql = sql<
  string | null
>`coalesce(${t.metadata}->'industry'->>'label', case when jsonb_typeof(${t.metadata}->'industry') = 'string' then ${t.metadata}->>'industry' end)`;
const hasPeople = sql`exists (select 1 from ${schema.signalPeople} where ${schema.signalPeople.signalId} = ${t.id})`;
const hasEmails = sql`exists (select 1 from ${schema.signalEmails} where ${schema.signalEmails.signalId} = ${t.id})`;
/** A funding lead: written by the funded-startups collector, or carrying a stage, people, or emails. */
const isLead = or(eq(t.channel, "funding-news"), sql`${t.metadata} ? 'stage'`, hasPeople, hasEmails) as SQL;

export async function listLeads(handle: Db, filter: LeadFilter = {}): Promise<LeadListing> {
  const conditions: SQL[] = [isLead, ne(t.status, "dismissed")];
  const q = filter.q?.trim().slice(0, 120);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const match = or(ilike(t.company, like), ilike(t.title, like), ilike(t.summary, like));
    if (match) conditions.push(match);
  }
  if (filter.industry) conditions.push(sql`${industrySql} = ${filter.industry}`);
  if (filter.withEmail) conditions.push(hasEmails);

  const [observations, industries] = await Promise.all([
    handle
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(desc(sql`coalesce(${t.publishedAt}, ${t.firstSeenAt})`))
      .limit(Math.min(filter.limit ?? 200, 500)),
    handle
      .selectDistinct({ industry: industrySql })
      .from(t)
      .where(and(isLead, ne(t.status, "dismissed"))),
  ]);
  const ids = observations.map((row) => row.id);
  const [people, emails] = ids.length
    ? await Promise.all([
        handle.select().from(schema.signalPeople).where(inArray(schema.signalPeople.signalId, ids)),
        handle.select().from(schema.signalEmails).where(inArray(schema.signalEmails.signalId, ids)),
      ])
    : [[], []];

  const posted = emails.filter(isPosted);
  const rows = observations.map((row): Lead => {
    const metadata = row.metadata ?? {};
    const own = posted.filter((email) => email.signalId === row.id);
    const toEmail = (email: (typeof own)[number]): LeadEmail => ({
      email: email.email,
      kind: email.kind,
      inbox: email.inbox,
      sourceUrl: email.sourceUrl,
      quote: email.quote,
    });
    const founders = people
      .filter((person) => person.signalId === row.id)
      .map(
        (person): LeadFounder => ({
          name: person.name,
          role: person.role,
          sourceUrl: person.sourceUrl,
          quote: person.quote,
          linkedinUrl: person.linkedinUrl,
          emails: own.filter((email) => email.personId === person.id).map(toEmail),
        }),
      )
      .filter((founder) => founder.emails.length);
    const claimed = new Set(founders.flatMap((founder) => founder.emails.map((email) => email.email)));
    const others = Array.isArray(metadata.other_sources)
      ? metadata.other_sources.filter((url): url is string => typeof url === "string")
      : [];
    return {
      id: row.id,
      company: row.company ?? text(row.title) ?? "Unknown company",
      website: text(metadata.company_website),
      industry: industryOf(metadata),
      country: text(metadata.country),
      stage: text(metadata.stage),
      amount: text(metadata.amount),
      announcedOn: row.publishedAt,
      brief: row.summary,
      fundingUrl: row.url,
      otherSources: [...new Set(others)].filter((url) => url !== row.url),
      founders,
      inboxes: own.filter((email) => !email.personId && !claimed.has(email.email)).map(toEmail),
    };
  });

  return {
    rows: filter.withEmail ? rows.filter((lead) => lead.founders.length || lead.inboxes.length) : rows,
    industries: industries
      .map((row) => row.industry)
      .filter((value): value is string => Boolean(value))
      .sort(),
    counts: {
      companies: rows.length,
      withEmail: rows.filter((lead) => lead.founders.length || lead.inboxes.length).length,
      founderEmails: rows.reduce((n, lead) => n + lead.founders.reduce((m, founder) => m + founder.emails.length, 0), 0),
      inboxes: rows.reduce((n, lead) => n + lead.inboxes.length, 0),
    },
  };
}
