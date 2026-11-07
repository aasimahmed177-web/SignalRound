import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { latestStage, mergeRound, nextOutreachStatus, normalizedDomain, postedEmail, roundKey } from "./rules";
import { contactType, stage } from "./validators";

/** An address with the page that prints it and the text on that page that shows it. */
const sourcedEmail = v.object({ email: v.string(), sourceUrl: v.string(), quote: v.string() });

export const upsert = internalMutation({
  args: {
    company: v.object({
      name: v.string(),
      website: v.string(),
      /** Defaults to "India", what every earlier import was. */
      country: v.optional(v.string()),
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
        quote: v.string(),
      }),
    ),
    founders: v.optional(
      v.array(
        v.object({
          name: v.string(),
          role: v.string(),
          sourceUrl: v.string(),
          quote: v.optional(v.string()),
          linkedinUrl: v.optional(v.string()),
          emails: v.optional(v.array(sourcedEmail)),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const domain = normalizedDomain(args.company.website);

    // Only addresses whose quote shows them are saved; anything else is dropped, never stored as verified.
    const contacts = args.contacts.filter(postedEmail);
    const founders = (args.founders ?? [])
      .map((founder) => ({ ...founder, emails: (founder.emails ?? []).filter(postedEmail) }))
      .filter((founder) => founder.emails.length);
    const hasContacts = contacts.length > 0 || founders.length > 0;

    const existing = await ctx.db
      .query("companies")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .unique();
    const companyValues = {
      ...args.company,
      normalizedName: args.company.name.trim().toLowerCase(),
      domain,
      country: args.company.country ?? "India",
      updatedAt: now,
    };
    let companyId: Id<"companies">;
    if (existing) {
      companyId = existing._id;
      // A re-import never resets outreach progress (contacted, replied, not_a_fit).
      await ctx.db.patch(companyId, { ...companyValues, outreachStatus: nextOutreachStatus(existing.outreachStatus, hasContacts) });
    } else {
      companyId = await ctx.db.insert("companies", {
        ...companyValues,
        latestStage: args.round.stage,
        outreachStatus: nextOutreachStatus(null, hasContacts),
      });
    }

    // One round per stage per company. Rows stored under the old domain|stage|date|amount key are found by stage.
    const dedupeKey = roundKey(domain, args.round.stage);
    const companyRounds = await ctx.db
      .query("fundingRounds")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    const oldRound =
      companyRounds.find((round) => round.dedupeKey === dedupeKey) ?? companyRounds.find((round) => round.stage === args.round.stage);
    let saved: { stage: typeof args.round.stage; announcedOn: string } = args.round;
    if (oldRound) {
      const { _id, _creationTime, ...roundValues } = mergeRound(oldRound, { ...oldRound, ...args.round });
      await ctx.db.patch(oldRound._id, { ...roundValues, dedupeKey, updatedAt: now });
      saved = roundValues;
    } else {
      await ctx.db.insert("fundingRounds", { ...args.round, companyId, dedupeKey, createdAt: now, updatedAt: now });
    }
    // The company's stage is its latest-dated round's, not the last one imported.
    const stageNow = latestStage([...companyRounds.filter((round) => round !== oldRound), saved]) ?? args.round.stage;
    if ((existing?.latestStage ?? args.round.stage) !== stageNow) await ctx.db.patch(companyId, { latestStage: stageNow });

    // Only people with a publicly posted email are saved.
    const personIds = new Map<string, Id<"people">>();
    for (const founder of founders) {
      const { emails: _emails, ...person } = founder;
      const personKey = `${domain}|${founder.name.trim().toLowerCase()}`;
      const oldPerson = await ctx.db
        .query("people")
        .withIndex("by_dedupe_key", (q) => q.eq("dedupeKey", personKey))
        .unique();
      const personValues = { ...person, companyId, dedupeKey: personKey, updatedAt: now };
      if (oldPerson) await ctx.db.patch(oldPerson._id, personValues);
      personIds.set(founder.name, oldPerson ? oldPerson._id : await ctx.db.insert("people", { ...personValues, createdAt: now }));
    }
    const founderContacts = founders.flatMap((founder) =>
      founder.emails.map((email) => ({
        ...email,
        contactType: "founder_personal" as const,
        personId: personIds.get(founder.name),
      })),
    );

    for (const contact of [...contacts, ...founderContacts]) {
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
        // Every saved contact passed postedEmail: its quote, from sourceUrl, shows the address.
        publicListingVerified: true,
        deliverabilityStatus: "not_tested" as const,
        updatedAt: now,
      };
      if (oldContact) await ctx.db.patch(oldContact._id, contactValues);
      else await ctx.db.insert("contacts", { ...contactValues, createdAt: now });
    }
    return {
      companyId,
      domain,
      contactCount: contacts.length + founderContacts.length,
      founderCount: personIds.size,
      skippedContacts: args.contacts.length - contacts.length,
    };
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
        ["pre_seed", "seed", "series_a", "series_b", "series_c"].map((value) => [
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
        people: await ctx.db
          .query("people")
          .withIndex("by_company", (q) => q.eq("companyId", company._id))
          .collect(),
      })),
    );
  },
});
