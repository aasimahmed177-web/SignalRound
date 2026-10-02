// One enrichment batch against the store: the read (enrichCompanies) and the write. The
// workflow step and the company page's Refresh profile share it, so a company re-enriched by
// hand goes through exactly what the sweep does. Only a homepage that verified as the record's
// company writes a logo or description; a website kept without a verdict (unreadable, or an
// exact-name host refused over wording), or confirmed only by the round's links to it, writes the
// website and domain and nothing else; a row
// that did not verify still gets its enrichment row, with the error, so the company is not
// retried on every sweep. The reverify script clears the pending rows so the next lane retries them.

import type { Enrichment } from "@fireround/core";
import { cleanBrandName, cleanHeadlineName, enrichCompanies, hostOf, normalizeCompanyKey, registrableDomain } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { claimDomain } from "./persist.ts";

const { companies, enrichments, fundingRounds, roundSources, sources } = schema;

export interface EnrichCompany {
  id: string;
  name: string;
  website: string | null;
  description: string | null;
  hq: string | null;
  sector: string | null;
}

/** What the store already read about a company: its rounds' pages with their titles, and its dossier's sources. */
interface StoreEvidence {
  sourcePages: Array<{ url: string; title: string | null }>;
  dossierSources: string[];
}

/**
 * The pages the store already holds for each company: the sources of its rounds (a
 * rejected row is not the company, so its pages say nothing) and what its deep dive read. The core
 * picks the company's own site out of them (openai.com's funding post under OpenAI's round, the four
 * mmimicro.com pages Medical Microinstruments' dossier read) and reads the round's press release for
 * its links; each candidate still faces the identity check.
 */
async function storeEvidence(handle: Db, companies: EnrichCompany[]): Promise<Map<string, StoreEvidence>> {
  const out = new Map<string, StoreEvidence>();
  const ids = companies.map((c) => c.id);
  if (ids.length === 0) return out;
  const entry = (id: string) => {
    let e = out.get(id);
    if (!e) {
      e = { sourcePages: [], dossierSources: [] };
      out.set(id, e);
    }
    return e;
  };
  const [dossiers, linked] = await Promise.all([
    handle
      .select({ companyId: enrichments.companyId, data: enrichments.data })
      .from(enrichments)
      .where(and(eq(enrichments.kind, "deep_dive"), inArray(enrichments.companyId, ids))),
    handle
      .select({ companyId: fundingRounds.companyId, url: sources.url, title: sources.title })
      .from(roundSources)
      .innerJoin(fundingRounds, eq(fundingRounds.id, roundSources.roundId))
      .innerJoin(sources, eq(sources.id, roundSources.sourceId))
      .where(and(inArray(fundingRounds.companyId, ids), ne(fundingRounds.disposition, "rejected")))
      .orderBy(sources.fetchedAt),
  ]);
  for (const r of dossiers) {
    const urls = ((r.data as { sources?: unknown })?.sources ?? []) as unknown[];
    entry(r.companyId).dossierSources.push(...urls.filter((u): u is string => typeof u === "string"));
  }
  for (const l of linked) {
    const e = entry(l.companyId);
    if (!e.sourcePages.some((p) => p.url === l.url)) e.sourcePages.push({ url: l.url, title: l.title });
  }
  return out;
}

/**
 * The sentence and headline the company's most recent round was read from; what the press says it is.
 * The subquery names funding_rounds.id outright: drizzle writes a bare "id" for a one-table select,
 * which inside the subquery would mean the source's id and find no headline at all.
 */
async function roundContext(handle: Db, companyIds: string[]): Promise<Map<string, { evidence: string | null; headline: string | null }>> {
  const out = new Map<string, { evidence: string | null; headline: string | null }>();
  if (companyIds.length === 0) return out;
  const rows = await handle
    .select({
      companyId: fundingRounds.companyId,
      evidence: fundingRounds.evidenceQuotes,
      headline: sql<
        string | null
      >`(select s.title from round_sources rs join sources s on s.id = rs.source_id where rs.round_id = funding_rounds.id order by s.fetched_at asc limit 1)`,
      announcedOn: fundingRounds.announcedOn,
    })
    .from(fundingRounds)
    // A rejected row is not what the company is (a trend story's passing mention of OpenAI), so it grounds nothing.
    .where(and(inArray(fundingRounds.companyId, companyIds), ne(fundingRounds.disposition, "rejected")))
    .orderBy(sql`${fundingRounds.announcedOn} desc nulls last`);
  for (const r of rows) {
    if (out.has(r.companyId)) continue;
    out.set(r.companyId, { evidence: r.evidence?.[0] ?? null, headline: r.headline ?? null });
  }
  return out;
}

export interface EnrichBatchResult {
  resolved: number;
  pricing: number;
  credits: number;
  enrichments: Enrichment[];
}

/**
 * A homepage the identity check accepted: it carries a website and the profile that verified it, or,
 * for a homepage too big or too guarded to read, the round's own pages and a live search listing
 * that placed the company on the domain (`identity_basis: "linked"`).
 */
export function isVerified(e: Enrichment): boolean {
  if (e.company_website === null || e.website_source === "parked" || e.website_source === "unverified") return false;
  return e.profile !== null || e.identity_basis === "linked";
}

/**
 * A website kept without a verdict: the host could not be read, or an exact-name host was refused
 * without a different business named. The website and domain stay; the profile is pending. A site
 * confirmed by links has its verdict, only no profile.
 */
export function isPending(e: Pick<Enrichment, "company_website" | "profile" | "identity_basis">): boolean {
  return e.company_website !== null && !e.profile && e.identity_basis !== "linked";
}

/** Whether the company row's own website or domain is among the hosts the identity check refused. */
function refusedOwnSite(e: Pick<Enrichment, "refused_hosts">, row: { website: string | null; domain: string | null }): boolean {
  const refused = new Set((e.refused_hosts ?? []).map((h) => h.replace(/^www\./, "")));
  const host = hostOf(row.website ?? "").replace(/^www\./, "");
  return Boolean((host && refused.has(host)) || (row.domain && refused.has(row.domain)));
}

/**
 * The read half of a batch: the store's context and evidence for each company, and the enrichment
 * read. Nothing is written, so a measurement can run it against a read-only store.
 */
export async function readProfiles(
  handle: Db,
  client: Firecrawl,
  batch: EnrichCompany[],
  options: { pricingPage: boolean },
): Promise<{ enrichments: Enrichment[]; credits: number }> {
  const [context, evidence] = await Promise.all([
    roundContext(
      handle,
      batch.map((c) => c.id),
    ),
    storeEvidence(handle, batch),
  ]);
  const result = await enrichCompanies(
    client,
    batch.map((c) => ({
      company_key: c.id,
      company_name: c.name,
      company_website: c.website,
      company_description: c.description,
      headquarters: c.hq,
      sector: c.sector,
      evidence: context.get(c.id)?.evidence ?? null,
      headline: context.get(c.id)?.headline ?? null,
      source_pages: evidence.get(c.id)?.sourcePages ?? [],
      dossier_sources: evidence.get(c.id)?.dossierSources ?? [],
    })),
    { pricingPage: options.pricingPage },
  );
  return { enrichments: result.enrichments, credits: result.creditsEstimated };
}

export async function enrichBatch(
  handle: Db,
  client: Firecrawl,
  batch: EnrichCompany[],
  options: { pricingPage: boolean },
): Promise<EnrichBatchResult> {
  const result = await readProfiles(handle, client, batch, options);
  return saveProfiles(handle, result);
}

/** Save a homepage verdict already read by the existing enrichment lane. */
export async function saveProfiles(handle: Db, result: Awaited<ReturnType<typeof readProfiles>>): Promise<EnrichBatchResult> {
  let resolved = 0;
  let pricing = 0;
  for (const e of result.enrichments) {
    const verified = isVerified(e);
    if (verified) resolved++;
    if (e.pricing) pricing++;
    // A domain another company row already owns means this row is that company: fold it in and
    // write the profile under the survivor. Only a homepage that verified may fold rows together; a
    // site confirmed by links is written like a pending one, where the domain is free.
    const domain = e.company_website ? registrableDomain(e.company_website) : null;
    const companyId = await claimDomain(handle, e.company_key, verified && e.profile ? domain : null);
    await handle
      .insert(enrichments)
      .values({ companyId, kind: "profile", data: e, sourceUrl: e.company_website })
      .onConflictDoUpdate({
        target: [enrichments.companyId, enrichments.kind],
        set: { data: e, sourceUrl: e.company_website, fetchedAt: new Date() },
      });
    if (!verified || !e.profile) {
      // The record's own website was one of the refused hosts: it was a guess at a namesake, and it
      // must not stay on the row feeding the logo lookup and the next search. An unreadable host is
      // not refused, so a website the scrape could not read stays.
      const [row] = await handle
        .select({ website: companies.website, domain: companies.domain })
        .from(companies)
        .where(eq(companies.id, companyId));
      if (row && (!verified || refusedOwnSite(e, row))) {
        await handle
          .update(companies)
          .set({ website: null, domain: null, logoUrl: null, updatedAt: new Date() })
          .where(eq(companies.id, companyId));
      }
      // A link-confirmed site can be assigned even when its homepage is unreadable; an unverified
      // candidate cannot become the company's public domain just because its spelling matches.
      if (verified && e.company_website) {
        const [owner] = domain
          ? await handle.select({ id: companies.id }).from(companies).where(eq(companies.domain, domain)).limit(1)
          : [];
        const domainFree = !owner || owner.id === companyId;
        await handle
          .update(companies)
          .set({
            website: sql`coalesce(${companies.website}, ${e.company_website})`,
            ...(domainFree ? { domain: sql`coalesce(${companies.domain}, ${domain})` } : {}),
            updatedAt: new Date(),
          })
          .where(eq(companies.id, companyId));
      }
      continue;
    }
    // The website the search found, and the domain either way: the logo lookup keys on the domain,
    // and a record extracted from a roundup often names the company without one. When the row's own
    // website was refused and another homepage verified, the refused one was a namesake's (Creem's
    // creem.com, a rock magazine, beside the verified creem.io) and the verified site replaces it; the
    // Alexandria facts (YC, FullEnrich, Apollo) looked up on the namesake's domain go with it, so the next pass reads the right one.
    const [current] = await handle
      .select({ name: companies.name, website: companies.website, domain: companies.domain })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (current && domain && refusedOwnSite(e, current)) {
      await handle.update(companies).set({ website: e.company_website, domain, updatedAt: new Date() }).where(eq(companies.id, companyId));
      await handle
        .delete(enrichments)
        .where(and(eq(enrichments.companyId, companyId), inArray(enrichments.kind, ["alexandria", "apollo"])));
    } else {
      await handle
        .update(companies)
        .set({
          website: sql`coalesce(${companies.website}, ${e.company_website})`,
          domain: sql`coalesce(${companies.domain}, ${domain})`,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId));
    }
    if (current && e.brand?.name) {
      const cleaned = cleanHeadlineName(current.name);
      const brand = cleanBrandName(e.brand.name, domain);
      if (cleaned !== current.name && normalizeCompanyKey(cleaned) === normalizeCompanyKey(brand))
        await handle
          .update(companies)
          .set({ name: brand, nameKey: normalizeCompanyKey(brand), updatedAt: new Date() })
          .where(eq(companies.id, companyId));
    }
    if (e.profile) {
      await handle
        .update(companies)
        .set({ description: sql`coalesce(${companies.description}, ${e.profile.what_they_sell})`, updatedAt: new Date() })
        .where(eq(companies.id, companyId));
    }
    if (e.logo_url) {
      await handle.update(companies).set({ logoUrl: e.logo_url, updatedAt: new Date() }).where(eq(companies.id, companyId));
    }
  }
  return { resolved, pricing, credits: result.credits, enrichments: result.enrichments };
}

/**
 * Forget what an earlier enrichment learned about a company so the next one starts clean: the
 * profile row goes; the logo, and a website and domain that came from the old ungrounded search
 * rather than the record, go with it; the description goes when the profile wrote it. A website
 * the record itself named stays and is verified again on the next read.
 */
export async function clearProfile(handle: Db, companyId: string): Promise<{ cleared: boolean }> {
  const [row] = await handle
    .select({ data: enrichments.data, description: companies.description })
    .from(enrichments)
    .innerJoin(companies, eq(companies.id, enrichments.companyId))
    .where(and(eq(enrichments.companyId, companyId), eq(enrichments.kind, "profile")))
    .limit(1);
  if (!row) return { cleared: false };
  const stored = row.data as Partial<Enrichment>;
  const set: Partial<typeof companies.$inferInsert> = { logoUrl: null, updatedAt: new Date() };
  if (stored.website_source === "search" || stored.website_source === "sources") {
    set.website = null;
    set.domain = null;
  }
  if (stored.profile?.what_they_sell && stored.profile.what_they_sell === row.description) set.description = null;
  await handle.update(companies).set(set).where(eq(companies.id, companyId));
  // The alexandria row goes too: it was keyed on the domain this profile vouched for.
  await handle.delete(enrichments).where(and(eq(enrichments.companyId, companyId), inArray(enrichments.kind, ["profile", "alexandria"])));
  return { cleared: true };
}

/**
 * A stored profile that carries a website the identity check never accepted: written before the
 * check existed, so the homepage may be a namesake's; or kept without a verdict (an unreadable host,
 * an exact-name host refused over wording), which is pending, not verified. A row with no website
 * has nothing to redo.
 */
export function profileUnverified(data: unknown): boolean {
  const stored = data as Partial<Enrichment> | null;
  if (stored && !stored.identity_basis && (stored.unreadable_hosts?.length || stored.refused_hosts?.length)) return true;
  if (!stored?.company_website) return false;
  if (stored.identity_basis === "linked") return false;
  if (isPending({ company_website: stored.company_website, profile: stored.profile ?? null })) return true;
  if (stored.profile?.same_company !== true) return true;
  // Verified, but against nothing: the check had only the name, so a namesake would have passed.
  return Array.isArray(stored.context) && stored.context.length === 0;
}

/**
 * Clear the profiles of companies whose description is the profile's own sentence: the record had
 * no description when the check ran, so the homepage was accepted on its name alone. The next
 * enrichment gets the evidence sentence and headline as context instead.
 */
export async function clearProfilesAcceptedOnNameAlone(handle: Db): Promise<{ cleared: number }> {
  const rows = await handle
    .select({ companyId: enrichments.companyId })
    .from(enrichments)
    .innerJoin(companies, eq(companies.id, enrichments.companyId))
    .where(and(eq(enrichments.kind, "profile"), sql`${companies.description} = ${enrichments.data}->'profile'->>'what_they_sell'`));
  let cleared = 0;
  for (const row of rows) {
    const r = await clearProfile(handle, row.companyId);
    if (r.cleared) cleared++;
  }
  return { cleared };
}

/**
 * Clear every stored profile that never passed the identity check, so the next enrichment redoes
 * it: the legacy unverified ones, the rows kept pending on an unreadable or doubted host, and the
 * rows whose only failures were unreadable hosts.
 */
export async function clearUnverifiedProfiles(handle: Db): Promise<{ cleared: number }> {
  const rows = await handle
    .select({ companyId: enrichments.companyId, data: enrichments.data })
    .from(enrichments)
    .where(eq(enrichments.kind, "profile"));
  // A company whose search found nothing is worth another pass once a deep dive has read its own site.
  const dossiers = new Set(
    (await handle.select({ companyId: enrichments.companyId }).from(enrichments).where(eq(enrichments.kind, "deep_dive"))).map(
      (r) => r.companyId,
    ),
  );
  let cleared = 0;
  for (const row of rows) {
    const stored = row.data as Partial<Enrichment> | null;
    const nothingFound = stored?.website_source === "none" && dossiers.has(row.companyId);
    // Nothing verified and nothing refused, only hosts the scrape could not read: unknown, so retry.
    // A site confirmed by links is settled, though its homepage could not be read.
    const unreadOnly =
      !stored?.profile &&
      stored?.identity_basis !== "linked" &&
      (stored?.unreadable_hosts?.length ?? 0) > 0 &&
      (stored?.refused_hosts?.length ?? 0) === 0;
    if (!nothingFound && !unreadOnly && !profileUnverified(row.data)) continue;
    const r = await clearProfile(handle, row.companyId);
    if (r.cleared) cleared++;
  }
  return { cleared };
}
