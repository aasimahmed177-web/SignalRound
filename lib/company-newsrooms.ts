import {
  type CompanyNewsroomTarget,
  discoverNewsrooms,
  MONITORED_COMPANIES,
  NEWSROOM_NEW_LIMIT,
  NEWSROOM_PAGE_LIMIT,
  newsroomFundingLinks,
  TOP_NEWSROOMS,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import type { NativeWebClient } from "@fireround/core/web";
import { and, eq, sql } from "drizzle-orm";
import { companySizes } from "./accuracy.ts";
import { isVerified } from "./enrich.ts";

/** Prominence is the same largest-round ranking used for the accuracy check, with recency as a tie-break. */
export async function companyNewsroomTargets(handle: Db): Promise<CompanyNewsroomTarget[]> {
  const sizes = await companySizes(handle);
  const amounts = new Map(sizes.map((s) => [s.id, s.largest ?? 0]));
  const totals = new Map(sizes.map((s) => [s.id, s.total ?? 0]));
  const [companies, profiles, aliases, scans, sections, rounds] = await Promise.all([
    handle
      .select({ id: schema.companies.id, name: schema.companies.name, website: schema.companies.website, domain: schema.companies.domain })
      .from(schema.companies),
    handle
      .select({ companyId: schema.enrichments.companyId, data: schema.enrichments.data })
      .from(schema.enrichments)
      .where(eq(schema.enrichments.kind, "profile")),
    handle
      .select({ companyId: schema.companyAliases.companyId, site: schema.companyAliases.aliasKey })
      .from(schema.companyAliases)
      .where(eq(schema.companyAliases.kind, "domain")),
    handle.select().from(schema.companyNewsroomScans),
    handle.select().from(schema.companyNewsrooms),
    handle
      .select({ companyId: schema.fundingRounds.companyId, last: sql<string | null>`max(${schema.fundingRounds.announcedOn})` })
      .from(schema.fundingRounds)
      .groupBy(schema.fundingRounds.companyId),
  ]);
  const profileBy = new Map(profiles.map((p) => [p.companyId, p.data]));
  const scanBy = new Map(scans.map((s) => [s.companyId, s.discoveredAt]));
  const lastBy = new Map(rounds.map((r) => [r.companyId, r.last]));
  const aliasesBy = Map.groupBy(aliases, (a) => a.companyId);
  const sectionsBy = Map.groupBy(sections, (s) => s.companyId);
  return companies
    .filter((c) => c.website && c.domain && profileBy.has(c.id) && isVerified(profileBy.get(c.id) as Parameters<typeof isVerified>[0]))
    .map((c) => ({
      id: c.id,
      name: c.name,
      homepage: c.website as string,
      domain: c.domain as string,
      aliases: (aliasesBy.get(c.id) ?? []).map((a) => a.site),
      top: false,
      monitor: false,
      lastRound: lastBy.get(c.id) ?? null,
      discoveredAt: scanBy.get(c.id) ?? null,
      sections: (sectionsBy.get(c.id) ?? []).map((s) => ({ url: s.url, monitorId: s.monitorId, checkedAt: s.checkedAt })),
    }))
    .sort(
      (a, b) =>
        (amounts.get(b.id) ?? 0) - (amounts.get(a.id) ?? 0) ||
        (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0) ||
        (b.lastRound ?? "").localeCompare(a.lastRound ?? ""),
    )
    .map((target, index) => ({ ...target, top: index < TOP_NEWSROOMS, monitor: index < MONITORED_COMPANIES }));
}

export async function discoverCompany(
  handle: Db,
  client: NativeWebClient,
  target: CompanyNewsroomTarget,
  now = new Date(),
): Promise<number> {
  const result = await discoverNewsrooms(client, target.homepage, target.aliases);
  if (result.linked.length > 0) {
    await handle
      .insert(schema.companyAliases)
      .values(
        result.linked.map((site) => ({
          companyId: target.id,
          kind: "domain" as const,
          aliasKey: site,
          alias: site,
          sourceUrl: target.homepage,
        })),
      )
      .onConflictDoNothing();
  }
  for (const url of result.sections) {
    await handle.insert(schema.companyNewsrooms).values({ companyId: target.id, url }).onConflictDoNothing();
  }
  await handle
    .insert(schema.companyNewsroomScans)
    .values({ companyId: target.id, discoveredAt: now })
    .onConflictDoUpdate({
      target: schema.companyNewsroomScans.companyId,
      set: { discoveredAt: now },
    });
  return result.sections.length;
}

/** Claim unseen funding-looking URLs atomically; only claimed URLs enter the ordinary ingest workflow. */
export async function checkCompanySection(
  handle: Db,
  client: Pick<NativeWebClient, "map" | "scrape">,
  companyId: string,
  section: string,
  now = new Date(),
): Promise<{ mapped: number; urls: string[] }> {
  const result = await client.map(section, { limit: NEWSROOM_PAGE_LIMIT, includeSubdomains: false, timeout: 30_000 });
  const links = [...(result.links ?? [])];
  try {
    const page = await client.scrape(section, { formats: ["links"], onlyMainContent: true, timeout: 30_000 });
    links.push(...(page.links ?? []).map((url) => ({ url })));
  } catch {}
  const candidateUrls = newsroomFundingLinks(links, section, now);
  const urls: string[] = [];
  for (const url of candidateUrls) {
    if (urls.length >= NEWSROOM_NEW_LIMIT) break;
    const [claimed] = await handle
      .insert(schema.candidates)
      .values({ monitorId: `company:${companyId}`, url, status: "pending" })
      .onConflictDoUpdate({
        target: [schema.candidates.monitorId, schema.candidates.url],
        set: { status: "pending", createdAt: now },
        setWhere: sql`${schema.candidates.status} <> 'extracted' and ${schema.candidates.createdAt} < ${new Date(now.getTime() - 86_400_000)}`,
      })
      .returning({ url: schema.candidates.url });
    if (claimed) urls.push(claimed.url);
  }
  await handle
    .update(schema.companyNewsrooms)
    .set({ checkedAt: now })
    .where(and(eq(schema.companyNewsrooms.companyId, companyId), eq(schema.companyNewsrooms.url, section)));
  return { mapped: links.length, urls };
}
