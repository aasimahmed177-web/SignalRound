import { randomUUID } from "node:crypto";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

export const SIGNAL_STATUSES = ["new", "researching", "matched", "dismissed"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();
const dateString = z
  .string()
  .trim()
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), "Must be an ISO date or timestamp");

/** The small, stable contract discovery workers use; metadata keeps source-specific detail lossless. */
export const signalInputSchema = z
  .object({
    channel: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9][a-z0-9_-]*$/),
    url: z.string().trim().url().max(2_048),
    title: optionalText(300),
    summary: optionalText(4_000),
    company: optionalText(200),
    author: optionalText(200),
    published_at: dateString.optional().nullable(),
    confidence: z.number().min(0).max(1).optional().nullable(),
    tags: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.title && !value.summary) ctx.addIssue({ code: "custom", message: "title or summary is required" });
  });

export type SignalInput = z.infer<typeof signalInputSchema>;
export type SignalRow = typeof schema.signalObservations.$inferSelect;

export function parseSignalInput(value: unknown): SignalInput {
  return signalInputSchema.parse(value);
}

function clean(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

/** Idempotent on channel + URL: repeat sightings enrich the row and increase seenCount. */
export async function ingestSignal(handle: Db, input: SignalInput): Promise<SignalRow> {
  const now = new Date();
  const values = {
    id: randomUUID(),
    channel: input.channel,
    url: input.url,
    title: clean(input.title),
    summary: clean(input.summary),
    company: clean(input.company),
    author: clean(input.author),
    publishedAt: input.published_at ? new Date(input.published_at) : null,
    confidence: input.confidence ?? null,
    tags: [...new Set(input.tags)],
    metadata: input.metadata,
    lastSeenAt: now,
    updatedAt: now,
  };
  const [row] = await handle
    .insert(schema.signalObservations)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.signalObservations.channel, schema.signalObservations.url],
      set: {
        title: values.title ?? undefined,
        summary: values.summary ?? undefined,
        company: values.company ?? undefined,
        author: values.author ?? undefined,
        publishedAt: values.publishedAt ?? undefined,
        confidence: values.confidence ?? undefined,
        tags: values.tags,
        metadata: values.metadata,
        seenCount: sql`${schema.signalObservations.seenCount} + 1`,
        lastSeenAt: now,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("Signal was not stored.");
  return row;
}

export interface SignalInbox {
  rows: SignalRow[];
  counts: Record<SignalStatus | "all", number>;
}

export async function listSignalInbox(handle: Db, status?: SignalStatus): Promise<SignalInbox> {
  const where = status ? eq(schema.signalObservations.status, status) : undefined;
  const [rows, grouped] = await Promise.all([
    handle.select().from(schema.signalObservations).where(where).orderBy(desc(schema.signalObservations.lastSeenAt)).limit(200),
    handle
      .select({ status: schema.signalObservations.status, count: sql<number>`count(*)::int` })
      .from(schema.signalObservations)
      .groupBy(schema.signalObservations.status),
  ]);
  const counts: SignalInbox["counts"] = { all: 0, new: 0, researching: 0, matched: 0, dismissed: 0 };
  for (const group of grouped) {
    if (SIGNAL_STATUSES.includes(group.status as SignalStatus)) counts[group.status as SignalStatus] = group.count;
    counts.all += group.count;
  }
  return { rows: rows as SignalRow[], counts };
}

export async function setSignalStatus(handle: Db, id: string, status: SignalStatus): Promise<boolean> {
  const rows = await handle
    .update(schema.signalObservations)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(schema.signalObservations.id, id), sql`${schema.signalObservations.status} <> ${status}`))
    .returning({ id: schema.signalObservations.id });
  return rows.length > 0;
}

export function publicSignal(row: SignalRow) {
  return {
    id: row.id,
    channel: row.channel,
    url: row.url,
    title: row.title,
    summary: row.summary,
    company: row.company,
    author: row.author,
    published_at: row.publishedAt?.toISOString() ?? null,
    status: row.status,
    confidence: row.confidence,
    tags: row.tags,
    metadata: row.metadata,
    round_id: row.roundId,
    seen_count: row.seenCount,
    first_seen_at: row.firstSeenAt.toISOString(),
    last_seen_at: row.lastSeenAt.toISOString(),
  };
}
