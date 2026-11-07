import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { definedOnly, postedEmail } from "./rules";
import { jobStatus, postedJobEmail } from "./validators";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Mirrors Postgres job_postings (scripts/import-convex-jobs.ts): idempotent on source + externalId. A repeat
 * sighting refreshes lastSeenAt and overwrites only the fields it carries, so an omitted field keeps its value.
 */
export const upsert = internalMutation({
  args: {
    jobs: v.array(
      v.object({
        companyId: v.optional(v.id("companies")),
        source: v.string(),
        externalId: v.string(),
        url: v.string(),
        title: v.string(),
        company: v.string(),
        companyWebsite: v.optional(v.string()),
        boardUrl: v.optional(v.string()),
        signalId: v.optional(v.string()),
        publicEmails: v.optional(v.array(postedJobEmail)),
        location: v.optional(v.string()),
        remote: v.optional(v.boolean()),
        department: v.optional(v.string()),
        employmentType: v.optional(v.string()),
        salary: v.optional(v.string()),
        postedAt: v.optional(v.string()),
        status: v.optional(jobStatus),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    let inserted = 0;
    for (const job of args.jobs) {
      const old = await ctx.db
        .query("jobs")
        .withIndex("by_source_external", (q) => q.eq("source", job.source).eq("externalId", job.externalId))
        .unique();
      if (job.postedAt !== undefined && !ISO.test(job.postedAt)) throw new Error(`postedAt is not ISO 8601: ${job.postedAt}`);
      // Only addresses whose quote shows them are kept.
      const publicEmails = job.publicEmails?.filter(postedEmail);
      const values = definedOnly({ ...job, publicEmails, lastSeenAt: now });
      if (old) await ctx.db.patch(old._id, values);
      else {
        await ctx.db.insert("jobs", { ...job, publicEmails, status: job.status ?? "open", lastSeenAt: now, firstSeenAt: now });
        inserted += 1;
      }
    }
    return { inserted, updated: args.jobs.length - inserted };
  },
});

export const listOpen = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: (ctx, args) =>
    ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .order("desc")
      .take(Math.min(args.limit ?? 100, 500)),
});
