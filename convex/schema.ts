import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  companies: defineTable({
    name: v.string(),
    normalizedName: v.string(),
    domain: v.string(),
    website: v.string(),
    country: v.literal("India"),
    headquarters: v.optional(v.string()),
    category: v.string(),
    description: v.string(),
    operatingStatus: v.union(v.literal("active"), v.literal("unknown")),
    latestStage: v.union(v.literal("pre_seed"), v.literal("seed"), v.literal("series_a"), v.literal("series_b")),
    outreachStatus: v.union(
      v.literal("qualified"),
      v.literal("needs_contact"),
      v.literal("contacted"),
      v.literal("replied"),
      v.literal("not_a_fit"),
    ),
    personalizationHooks: v.array(v.string()),
    relevanceNotes: v.string(),
    sourceUrls: v.array(v.string()),
    researchedAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_domain", ["domain"])
    .index("by_name", ["normalizedName"])
    .index("by_outreach_status", ["outreachStatus"])
    .index("by_country_stage", ["country", "latestStage"]),

  fundingRounds: defineTable({
    companyId: v.id("companies"),
    dedupeKey: v.string(),
    stage: v.union(v.literal("pre_seed"), v.literal("seed"), v.literal("series_a"), v.literal("series_b")),
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
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_company", ["companyId"])
    .index("by_dedupe_key", ["dedupeKey"])
    .index("by_stage_date", ["stage", "announcedOn"]),

  contacts: defineTable({
    companyId: v.id("companies"),
    dedupeKey: v.string(),
    email: v.string(),
    contactType: v.union(
      v.literal("hello"),
      v.literal("sales"),
      v.literal("business"),
      v.literal("info"),
      v.literal("contact"),
      v.literal("media"),
      v.literal("other_role"),
    ),
    sourceUrl: v.string(),
    publicListingVerified: v.boolean(),
    deliverabilityStatus: v.union(v.literal("not_tested"), v.literal("valid"), v.literal("invalid"), v.literal("risky")),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_company", ["companyId"])
    .index("by_email", ["email"])
    .index("by_dedupe_key", ["dedupeKey"]),

  collectionRuns: defineTable({
    scope: v.string(),
    targetContacts: v.number(),
    companiesFound: v.number(),
    companiesWithEmail: v.number(),
    contactsFound: v.number(),
    status: v.union(v.literal("running"), v.literal("complete"), v.literal("failed")),
    notes: v.array(v.string()),
    startedAt: v.string(),
    updatedAt: v.string(),
  }).index("by_status", ["status"]),
});
