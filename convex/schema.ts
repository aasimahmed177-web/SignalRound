import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { contactType, jobStatus, postedJobEmail, stage } from "./validators";

export default defineSchema({
  companies: defineTable({
    name: v.string(),
    normalizedName: v.string(),
    domain: v.string(),
    website: v.string(),
    /** Any country; rows written before this widened were all "India". */
    country: v.string(),
    headquarters: v.optional(v.string()),
    category: v.string(),
    description: v.string(),
    operatingStatus: v.union(v.literal("active"), v.literal("unknown")),
    latestStage: stage,
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
    contactType,
    /** Set for a founder's own address. */
    personId: v.optional(v.id("people")),
    sourceUrl: v.string(),
    /** The text on sourceUrl that shows the address. */
    quote: v.optional(v.string()),
    publicListingVerified: v.boolean(),
    deliverabilityStatus: v.union(v.literal("not_tested"), v.literal("valid"), v.literal("invalid"), v.literal("risky")),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_company", ["companyId"])
    .index("by_email", ["email"])
    .index("by_dedupe_key", ["dedupeKey"]),

  /** Founders, co-founders, CEOs and owners a public page names, each cited to that page. */
  people: defineTable({
    companyId: v.id("companies"),
    dedupeKey: v.string(),
    name: v.string(),
    role: v.string(),
    sourceUrl: v.string(),
    quote: v.optional(v.string()),
    /** Only a profile a public page links. */
    linkedinUrl: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_company", ["companyId"])
    .index("by_dedupe_key", ["dedupeKey"]),

  /**
   * The essentials of Postgres job_postings: one row per posting, unique on source + externalId. Filled by
   * scripts/import-convex-jobs.ts; status mirrors Postgres, where a board scan closes postings it stopped listing.
   */
  jobs: defineTable({
    companyId: v.optional(v.id("companies")),
    source: v.string(),
    externalId: v.string(),
    url: v.string(),
    title: v.string(),
    company: v.string(),
    companyWebsite: v.optional(v.string()),
    /** The public board the posting came from. */
    boardUrl: v.optional(v.string()),
    /** Postgres signal_observations id of the funding signal that led to this company. */
    signalId: v.optional(v.string()),
    /** Emails the posting prints, each with the text that shows it; never guessed. */
    publicEmails: v.optional(v.array(postedJobEmail)),
    location: v.optional(v.string()),
    remote: v.optional(v.boolean()),
    department: v.optional(v.string()),
    employmentType: v.optional(v.string()),
    salary: v.optional(v.string()),
    /** ISO 8601, from Postgres timestamptz. */
    postedAt: v.optional(v.string()),
    status: jobStatus,
    firstSeenAt: v.string(),
    lastSeenAt: v.string(),
  })
    .index("by_source_external", ["source", "externalId"])
    .index("by_company", ["companyId"])
    .index("by_status", ["status", "lastSeenAt"]),

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
