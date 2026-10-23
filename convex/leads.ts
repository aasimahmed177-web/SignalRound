import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const stage = v.union(v.literal("pre_seed"), v.literal("seed"), v.literal("series_a"), v.literal("series_b"));
const contactType = v.union(
  v.literal("hello"),
  v.literal("sales"),
  v.literal("business"),
  v.literal("info"),
  v.literal("contact"),
  v.literal("media"),
  v.literal("other_role"),
);

function normalizedDomain(website: string) {
  return new URL(website).hostname.toLowerCase().replace(/^www\./, "");
}

export const upsert = internalMutation({
  args: {
    company: v.object({
      name: v.string(),
      website: v.string(),
      headquarters: v.optional(v.string()),
      category: v.string(),
      description: v.string(),
      operatingStatus: v.union(v.literal("active"), v.literal("unknown")),
      personalizationHooks: v.array(v.string()),
      relevanceNotes: v.string(),
      sourceUrls: v.array(v.string()),
      researchedAt: v.string(),
    }),
    round: v.object({
      stage,
      stageAsWritten: v.string(),
      amountUsd: v.optional(v.number()),
      amountAsWritten: v.string(),
      currency: v.string(),
      announcedOn: v.string(),
      investors: v.array(v.string()),
      sourceUrl: v.string(),
      sourceTitle: v.string(),
      evidence: v.string(),
      verificationStatus: v.union(v.literal("primary_source"), v.literal("corroborated"), v.literal("reported")),
    }),
    contacts: v.array(
      v.object({
        email: v.string(),
        contactType,
        sourceUrl: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const domain = normalizedDomain(args.company.website);
    const existing = await ctx.db
      .query("companies")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .unique();
    const companyValues = {
      ...args.company,
      normalizedName: args.company.name.trim().toLowerCase(),
      domain,
      country: "India" as const,
      latestStage: args.round.stage,
      outreachStatus: (args.contacts.length ? "qualified" : "needs_contact") as "qualified" | "needs_contact",
      updatedAt: now,
    };
    const companyId = existing ? existing._id : await ctx.db.insert("companies", companyValues);
    if (existing) await ctx.db.patch(existing._id, companyValues);

    const roundKey = [domain, args.round.stage, args.round.announcedOn, args.round.amountAsWritten.toLowerCase()].join("|");
    const oldRound = await ctx.db
      .query("fundingRounds")
      .withIndex("by_dedupe_key", (q) => q.eq("dedupeKey", roundKey))
      .unique();
    const roundValues = { ...args.round, companyId, dedupeKey: roundKey, updatedAt: now };
    if (oldRound) await ctx.db.patch(oldRound._id, roundValues);
    else await ctx.db.insert("fundingRounds", { ...roundValues, createdAt: now });

    for (const contact of args.contacts) {
      const email = contact.email.trim().toLowerCase();
      const contactKey = `${domain}|${email}`;
      const oldContact = await ctx.db
        .query("contacts")
        .withIndex("by_dedupe_key", (q) => q.eq("dedupeKey", contactKey))
        .unique();
      const contactValues = {
        ...contact,
        email,
        companyId,
        dedupeKey: contactKey,
        publicListingVerified: true,
        deliverabilityStatus: "not_tested" as const,
        updatedAt: now,
      };
      if (oldContact) await ctx.db.patch(oldContact._id, contactValues);
      else await ctx.db.insert("contacts", { ...contactValues, createdAt: now });
    }
    return { companyId, domain, contactCount: args.contacts.length };
  },
});

export const stats = internalQuery({
  args: {},
  handler: async (ctx) => {
    const [companies, contacts, rounds] = await Promise.all([
      ctx.db.query("companies").collect(),
      ctx.db.query("contacts").collect(),
      ctx.db.query("fundingRounds").collect(),
    ]);
    const companyIdsWithEmail = new Set(contacts.map((contact) => contact.companyId));
    return {
      companies: companies.length,
      companiesWithEmail: companyIdsWithEmail.size,
      contacts: contacts.length,
      rounds: rounds.length,
      byStage: Object.fromEntries(
        ["pre_seed", "seed", "series_a", "series_b"].map((value) => [
          value,
          companies.filter((company) => company.latestStage === value).length,
        ]),
      ),
    };
  },
});

export const list = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const companies = await ctx.db
      .query("companies")
      .order("desc")
      .take(Math.min(args.limit ?? 100, 500));
    return Promise.all(
      companies.map(async (company) => ({
        ...company,
        rounds: await ctx.db
          .query("fundingRounds")
          .withIndex("by_company", (q) => q.eq("companyId", company._id))
          .collect(),
        contacts: await ctx.db
          .query("contacts")
          .withIndex("by_company", (q) => q.eq("companyId", company._id))
          .collect(),
      })),
    );
  },
});
