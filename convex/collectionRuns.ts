import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const start = internalMutation({
  args: { scope: v.string(), targetContacts: v.number() },
  handler: (ctx, args) => {
    const now = new Date().toISOString();
    return ctx.db.insert("collectionRuns", {
      ...args,
      companiesFound: 0,
      companiesWithEmail: 0,
      contactsFound: 0,
      status: "running",
      notes: [],
      startedAt: now,
      updatedAt: now,
    });
  },
});

export const update = internalMutation({
  args: {
    id: v.id("collectionRuns"),
    companiesFound: v.number(),
    companiesWithEmail: v.number(),
    contactsFound: v.number(),
    status: v.union(v.literal("running"), v.literal("complete"), v.literal("failed")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const current = await ctx.db.get(args.id);
    if (!current) throw new Error("Collection run not found");
    await ctx.db.patch(args.id, {
      companiesFound: args.companiesFound,
      companiesWithEmail: args.companiesWithEmail,
      contactsFound: args.contactsFound,
      status: args.status,
      notes: args.note ? [...current.notes, args.note] : current.notes,
      updatedAt: new Date().toISOString(),
    });
  },
});

export const current = internalQuery({
  args: {},
  handler: (ctx) => ctx.db.query("collectionRuns").withIndex("by_status", (q) => q.eq("status", "running")).order("desc").first(),
});
