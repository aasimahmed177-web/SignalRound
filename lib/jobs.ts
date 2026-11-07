import { createHash } from "node:crypto";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, desc, eq, ilike, inArray, isNotNull, isNull, like, lt, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";

export const JOB_STATUSES = ["open", "closed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobRow = typeof schema.jobPostings.$inferSelect;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max * 4)
    .transform((value) => value.slice(0, max) || null)
    .optional()
    .nullable();

/** The contract every job source writes: native board readers, the JobSpy worker, and POST /api/v1/jobs. */
export const jobInputSchema = z
  .object({
    source: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9_-]*$/),
    external_id: z.string().trim().min(1).max(300),
    url: z.string().trim().url().max(2_048),
    title: z.string().trim().min(1).max(300),
    company: z.string().trim().min(1).max(200),
    company_website: z.string().trim().url().max(2_048).optional().nullable(),
    board_url: z.string().trim().url().max(2_048).optional().nullable(),
    signal_id: z.string().trim().max(64).optional().nullable(),
    location: optionalText(300),
    remote: z.boolean().optional().nullable(),
    department: optionalText(200),
    employment_type: optionalText(100),
    salary: optionalText(200),
    description: optionalText(20_000),
    posted_at: z
      .string()
      .trim()
      .max(64)
      .refine((value) => !Number.isNaN(Date.parse(value)), "Must be an ISO date or timestamp")
      .optional()
      .nullable(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type JobInput = z.input<typeof jobInputSchema>;
export type ParsedJob = z.output<typeof jobInputSchema>;

export function parseJobInput(value: unknown): ParsedJob {
  return jobInputSchema.parse(value);
}

export function jobId(source: string, externalId: string): string {
  return createHash("sha256").update(`${source}\0${externalId}`).digest("hex").slice(0, 32);
}

/** Idempotent on source + external id: a repeat sighting refreshes the row and reopens it. */
export async function upsertJob(handle: Db, input: ParsedJob): Promise<JobRow> {
  const now = new Date();
  const values = {
    id: jobId(input.source, input.external_id),
    source: input.source,
    externalId: input.external_id,
    url: input.url,
    title: input.title,
    company: input.company,
    companyWebsite: input.company_website ?? null,
    boardUrl: input.board_url ?? null,
    signalId: input.signal_id ?? null,
    location: input.location ?? null,
    remote: input.remote ?? null,
    department: input.department ?? null,
    employmentType: input.employment_type ?? null,
    salary: input.salary ?? null,
    description: input.description ?? null,
    postedAt: input.posted_at ? new Date(input.posted_at) : null,
    status: "open" as const,
    metadata: input.metadata,
    lastSeenAt: now,
    updatedAt: now,
  };
  const { id: _id, ...update } = values;
  const [row] = await handle
    .insert(schema.jobPostings)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.jobPostings.source, schema.jobPostings.externalId],
      set: {
        ...update,
        signalId: values.signalId ?? sql`${schema.jobPostings.signalId}`,
        companyWebsite: values.companyWebsite ?? sql`${schema.jobPostings.companyWebsite}`,
        postedAt: values.postedAt ?? sql`${schema.jobPostings.postedAt}`,
      },
    })
    .returning();
  if (!row) throw new Error("Job posting was not stored.");
  return row;
}

/** A batch write that failed part-way outside a transaction: `stored` already landed. */
export class PartialJobBatchError extends Error {
  // Plain fields, not parameter properties: Node's type stripping (the CLI scripts) rejects those.
  readonly stored: JobRow[];
  readonly reason: unknown;
  constructor(stored: JobRow[], reason: unknown) {
    super(`Job batch stopped after ${stored.length} row(s)`);
    this.stored = stored;
    this.reason = reason;
  }
}

/**
 * Upserts a batch all-or-nothing in one transaction. Drivers without transactions (Neon HTTP) pass
 * `transaction: false`; a failure then throws PartialJobBatchError naming the rows that were stored.
 */
export async function upsertJobs(handle: Db, inputs: ParsedJob[], options: { transaction?: boolean } = {}): Promise<JobRow[]> {
  if (options.transaction !== false) {
    return handle.transaction(async (tx) => {
      const rows: JobRow[] = [];
      // SAFETY: a transaction has the same query-builder surface as the handle upsertJob takes.
      for (const input of inputs) rows.push(await upsertJob(tx as unknown as Db, input));
      return rows;
    });
  }
  const rows: JobRow[] = [];
  for (const input of inputs) {
    try {
      rows.push(await upsertJob(handle, input));
    } catch (error) {
      throw new PartialJobBatchError(rows, error);
    }
  }
  return rows;
}

/** After a complete board read: postings the board no longer lists are closed, never deleted. */
export async function closeMissingJobs(handle: Db, boardUrl: string, source: string, keptExternalIds: string[]): Promise<number> {
  const conditions = [
    eq(schema.jobPostings.boardUrl, boardUrl),
    eq(schema.jobPostings.source, source),
    eq(schema.jobPostings.status, "open"),
  ];
  if (keptExternalIds.length) conditions.push(notInArray(schema.jobPostings.externalId, keptExternalIds));
  const rows = await handle
    .update(schema.jobPostings)
    .set({ status: "closed", updatedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: schema.jobPostings.id });
  return rows.length;
}

/**
 * Sources without a board (JobSpy searches, LinkedIn posts) never get a complete read, so closeMissingJobs cannot
 * apply. Their rows are closed once no search has seen them for `olderThanDays`; a later sighting reopens them.
 */
export async function closeStaleJobs(
  handle: Db,
  options: { olderThanDays?: number; sourcePrefixes?: string[]; now?: Date } = {},
): Promise<number> {
  const days = options.olderThanDays ?? 30;
  const cutoff = new Date((options.now ?? new Date()).getTime() - days * 86_400_000);
  const conditions = [
    isNull(schema.jobPostings.boardUrl),
    eq(schema.jobPostings.status, "open"),
    lt(schema.jobPostings.lastSeenAt, cutoff),
  ];
  const prefixes = options.sourcePrefixes ?? [];
  if (prefixes.length) {
    const bySource = or(...prefixes.map((prefix) => like(schema.jobPostings.source, `${prefix.replace(/[\\%_]/g, "\\$&")}%`)));
    if (bySource) conditions.push(bySource);
  }
  const rows = await handle
    .update(schema.jobPostings)
    .set({ status: "closed", updatedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: schema.jobPostings.id });
  return rows.length;
}

export interface JobFilter {
  status?: JobStatus;
  q?: string;
  source?: string;
  /** Only roles at companies that reached us through a funding observation. */
  funded?: boolean;
  limit?: number;
}

export interface JobListing {
  rows: Array<JobRow & { funding: string | null }>;
  counts: { open: number; closed: number; funded: number; companies: number };
  sources: string[];
}

function fundingLabel(metadata: Record<string, unknown> | null | undefined): string | null {
  const value = metadata?.funding;
  if (!value || typeof value !== "object") return null;
  const amount = "amount_as_written" in value && typeof value.amount_as_written === "string" ? value.amount_as_written : null;
  const stage = "stage_as_written" in value && typeof value.stage_as_written === "string" ? value.stage_as_written : null;
  return [amount, stage].filter(Boolean).join(" · ") || null;
}

export async function listJobs(handle: Db, filter: JobFilter = {}): Promise<JobListing> {
  const t = schema.jobPostings;
  const conditions = [eq(t.status, filter.status ?? "open")];
  if (filter.source) conditions.push(eq(t.source, filter.source));
  if (filter.funded) conditions.push(isNotNull(t.signalId));
  const q = filter.q?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const match = or(ilike(t.title, like), ilike(t.company, like), ilike(t.location, like), ilike(t.department, like));
    if (match) conditions.push(match);
  }
  const [rows, counts, sources] = await Promise.all([
    handle
      .select({ job: t, signalMetadata: schema.signalObservations.metadata })
      .from(t)
      .leftJoin(schema.signalObservations, eq(schema.signalObservations.id, t.signalId))
      .where(and(...conditions))
      .orderBy(desc(sql`coalesce(${t.postedAt}, ${t.firstSeenAt})`))
      .limit(Math.min(filter.limit ?? 200, 500)),
    handle
      .select({
        open: sql<number>`count(*) filter (where ${t.status} = 'open')::int`,
        closed: sql<number>`count(*) filter (where ${t.status} = 'closed')::int`,
        funded: sql<number>`count(*) filter (where ${t.status} = 'open' and ${t.signalId} is not null)::int`,
        companies: sql<number>`count(distinct lower(${t.company})) filter (where ${t.status} = 'open')::int`,
      })
      .from(t),
    handle.selectDistinct({ source: t.source }).from(t).orderBy(t.source),
  ]);
  return {
    rows: rows.map(({ job, signalMetadata }) => ({ ...job, funding: fundingLabel(signalMetadata) })),
    counts: counts[0] ?? { open: 0, closed: 0, funded: 0, companies: 0 },
    sources: sources.map((row) => row.source),
  };
}

/** Funding observations whose company website is known: the companies a jobs scan visits. */
export async function fundedCompanies(
  handle: Db,
  options: { limit?: number; ids?: string[] } = {},
): Promise<Array<{ signalId: string; company: string; website: string }>> {
  const t = schema.signalObservations;
  const website = sql<string>`${t.metadata}->>'company_website'`;
  const rows = await handle
    .select({ signalId: t.id, company: t.company, website })
    .from(t)
    .where(and(sql`${website} is not null`, sql`${t.status} <> 'dismissed'`, options.ids ? inArray(t.id, options.ids) : undefined))
    .orderBy(desc(t.lastSeenAt))
    .limit(options.limit ?? 25);
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    let host: string;
    try {
      host = new URL(row.website).hostname.replace(/^www\./, "");
    } catch {
      return [];
    }
    if (seen.has(host)) return [];
    seen.add(host);
    return [{ signalId: row.signalId, company: row.company ?? host, website: row.website }];
  });
}

export function publicJob(row: JobRow) {
  return {
    id: row.id,
    source: row.source,
    external_id: row.externalId,
    url: row.url,
    title: row.title,
    company: row.company,
    company_website: row.companyWebsite,
    board_url: row.boardUrl,
    signal_id: row.signalId,
    location: row.location,
    remote: row.remote,
    department: row.department,
    employment_type: row.employmentType,
    salary: row.salary,
    description: row.description,
    posted_at: row.postedAt?.toISOString() ?? null,
    status: row.status,
    metadata: row.metadata,
    first_seen_at: row.firstSeenAt.toISOString(),
    last_seen_at: row.lastSeenAt.toISOString(),
  };
}
