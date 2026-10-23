// Re-evaluate existing rows under issuer, identity, financing, stage, and company-date rules.
// Dry run by default. --reground reads a source through NativeWebClient; --apply writes only quoted changes.

import {
  amountInEvidence,
  brandNamesOtherEntity,
  type Enrichment,
  enrichCompanies,
  hostOf,
  mapLimit,
  namesCompany,
  normalizeCompanyKey,
  pageSentences,
  registrableDomain,
  siteCandidates,
} from "@fireround/core";
import { closeDb, schema } from "@fireround/core/db";
import { NativeWebClient } from "@fireround/core/web";
import { eq } from "drizzle-orm";
import { type AuditChange, type AuditRow, planAuditRepair } from "../../lib/audit-repair.ts";
import { openStore } from "../../lib/db.ts";
import { staleForNews } from "../../lib/deliverable.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";

const apply = process.argv.includes("--apply");
const reground = process.argv.includes("--reground");
const companyFilter = process.argv
  .find((arg) => arg.startsWith("--company="))
  ?.slice("--company=".length)
  .toLowerCase();
const handle = await openStore();
const client = reground ? new NativeWebClient() : null;
const rounds = await handle
  .select({ round: schema.fundingRounds, company: schema.companies })
  .from(schema.fundingRounds)
  .innerJoin(schema.companies, eq(schema.fundingRounds.companyId, schema.companies.id));
const sources = await handle
  .select({
    roundId: schema.roundSources.roundId,
    url: schema.sources.url,
    title: schema.sources.title,
    published: schema.sources.publishedAt,
  })
  .from(schema.roundSources)
  .innerJoin(schema.sources, eq(schema.roundSources.sourceId, schema.sources.id));
const profiles = await handle
  .select({ companyId: schema.enrichments.companyId, data: schema.enrichments.data })
  .from(schema.enrichments)
  .where(eq(schema.enrichments.kind, "profile"));
const byRound = Map.groupBy(sources, (source) => source.roundId);
const byCompany = new Map(profiles.map((profile) => [profile.companyId, profile.data as Partial<Enrichment>]));
const counts: Record<AuditChange["kind"] | "scanned" | "regrounded" | "readErrors", number> = {
  scanned: 0,
  regrounded: 0,
  readErrors: 0,
  reject: 0,
  name: 0,
  domain: 0,
  money: 0,
  valuation: 0,
  stage: 0,
  extension: 0,
  date: 0,
};

function preferredSource(row: AuditRow): AuditRow["sources"][number] | null {
  const own = siteCandidates(row.company, row.sources);
  const eligible = row.sources.filter((s) => !/\b(?:roundup|week of|digest|newsletter|funding this week)\b/i.test(s.title ?? ""));
  const ranked = eligible
    .map((source) => {
      const host = hostOf(source.url);
      const onOwnSite = own.some((site) => hostOf(site) === host);
      const filing = host.endsWith("sec.gov") && /(?:-index\.htm|\/primary_doc\.xml)$/i.test(source.url);
      const wire = /(?:prnewswire|businesswire|globenewswire)\.com$/.test(host);
      const aboutCompany =
        namesCompany(source.title, row.company, { share: 0.5 }) ||
        namesCompany(source.url.replace(/[-_/]/g, " "), row.company, { share: 0.5 });
      const stageTitle =
        row.stageAsWritten.length > 3 && (source.title ?? "").toLowerCase().includes(row.stageAsWritten.replaceAll("_", " ").toLowerCase());
      return { source, rank: filing ? 0 : onOwnSite ? 1 : wire && aboutCompany ? 2 : aboutCompany ? (stageTitle ? 2.5 : 3) : 9 };
    })
    .sort((a, b) => a.rank - b.rank || (b.source.title?.length ?? 0) - (a.source.title?.length ?? 0));
  return ranked[0]?.rank === 9 ? null : (ranked[0]?.source ?? null);
}

const plans = await mapLimit(
  rounds.filter(({ company }) => !companyFilter || company.name.toLowerCase().includes(companyFilter)),
  6,
  async ({ round, company }) => {
    const profile = byCompany.get(company.id);
    const row: AuditRow = {
      id: round.id,
      company: company.name,
      description: company.description,
      website: company.website,
      stage: round.stage,
      stageAsWritten: round.stageAsWritten,
      isExtension: round.isExtension,
      amountAsWritten: round.amountAsWritten,
      valuationAsWritten: round.valuationAsWritten,
      financingTotalAsWritten: round.financingTotalAsWritten,
      amountScope: round.amountScope,
      announcedOn: round.announcedOn,
      datePrecision: round.datePrecision,
      dateBasis: round.dateBasis,
      firstSeenAt: round.firstSeenAt,
      pinned: round.pinned as AuditRow["pinned"],
      disposition: round.disposition,
      evidenceQuotes: round.evidenceQuotes,
      sources: (byRound.get(round.id) ?? []).map((s) => ({
        url: s.url,
        title: s.title,
        published: s.published ?? null,
      })),
      brand: profile?.brand?.name ?? null,
      profileVerified:
        profile?.profile?.same_company === true && !!profile.identity_basis && !brandNamesOtherEntity(profile?.brand?.name, company.name),
    };
    let page: { url: string; markdown: string; published?: string | null } | undefined;
    if (client && !round.history && round.disposition !== "rejected" && round.firstSeenAt > new Date("2026-01-01")) {
      const source = preferredSource(row);
      const candidates = [source, ...row.sources.filter((s) => s.url !== source?.url && namesCompany(s.title, row.company, { share: 0.5 }))]
        .filter((s): s is NonNullable<typeof s> => !!s)
        .slice(0, 3);
      for (const candidate of candidates) {
        const url = candidate.url.replace(/[^/]+-index\.htm$/i, "primary_doc.xml");
        try {
          const result = await client.scrape(url, { formats: ["markdown"], onlyMainContent: true, timeout: 60_000, maxAge: 86_400_000 });
          if (result.markdown) {
            page = {
              url: candidate.url,
              markdown: result.markdown,
              published: typeof result.metadata?.publishedTime === "string" ? result.metadata.publishedTime.slice(0, 10) : null,
            };
            counts.regrounded++;
            break;
          }
        } catch {
          counts.readErrors++;
        }
      }
    }
    if (
      client &&
      row.datePrecision === "week" &&
      row.website &&
      row.announcedOn &&
      !row.pinned?.announced_on &&
      !round.history &&
      round.firstSeenAt > new Date("2026-01-01")
    ) {
      const domain = registrableDomain(row.website);
      if (domain && !page?.url.includes(domain)) {
        try {
          const results = await client.search(`site:${domain} "${row.company}" ${row.stageAsWritten} funding`, {
            limit: 5,
            highlights: false,
          });
          const post = (results.web ?? [])
            .map((result) => ({
              url: "url" in result && typeof result.url === "string" ? result.url : "",
              title: "title" in result && typeof result.title === "string" ? result.title : null,
            }))
            .find(
              (result) =>
                registrableDomain(result.url) === domain &&
                /\/(?:blog|news|press|updates|articles)\//i.test(result.url) &&
                namesCompany(result.title, row.company, { share: 0.5 }),
            );
          if (post?.url) {
            const result = await client.scrape(post.url, {
              formats: ["markdown"],
              onlyMainContent: true,
              timeout: 60_000,
              maxAge: 86_400_000,
            });
            if (
              result.markdown &&
              (!row.amountAsWritten || pageSentences(result.markdown).some((q) => amountInEvidence(row.amountAsWritten, q)))
            ) {
              page = {
                url: post.url,
                markdown: result.markdown,
                published: typeof result.metadata?.publishedTime === "string" ? result.metadata.publishedTime.slice(0, 10) : null,
              };
              counts.regrounded++;
            }
          }
        } catch {
          counts.readErrors++;
        }
      }
    }
    let website: { url: string; quote: string } | null = null;
    const own = siteCandidates(row.company, row.sources);
    const suspicious =
      row.website &&
      ((row.brand && brandNamesOtherEntity(row.brand, row.company)) || own.some((url) => hostOf(url) !== hostOf(row.website as string)));
    if (client && suspicious) {
      try {
        const [enriched] = (
          await enrichCompanies(
            client,
            [
              {
                company_key: normalizeCompanyKey(row.company),
                company_name: row.company,
                company_website: row.website,
                company_description: row.description,
                evidence: row.evidenceQuotes[0],
                headline: row.sources[0]?.title,
                source_pages: row.sources,
              },
            ],
            { pricingPage: false, concurrency: 1 },
          )
        ).enrichments;
        if (
          enriched?.company_website &&
          enriched.profile?.same_company &&
          enriched.identity_basis &&
          enriched.company_website !== row.website
        ) {
          const home = await client.scrape(enriched.company_website, {
            formats: ["markdown"],
            onlyMainContent: true,
            timeout: 60_000,
            maxAge: 86_400_000,
          });
          const line = pageSentences(home.markdown ?? "").find(
            (s) =>
              s.length > 40 &&
              s.length < 350 &&
              namesCompany(s, row.company, { share: 0.5 }) &&
              !/\b(?:privacy policy|terms of service|trust center|cookie preferences)\b/i.test(s),
          );
          if (line) website = { url: enriched.company_website, quote: line.slice(0, 350) };
        }
      } catch {
        counts.readErrors++;
      }
    }
    if (client && (!row.website || suspicious) && !website && row.brand && brandNamesOtherEntity(row.brand, row.company)) {
      const first = normalizeCompanyKey(row.company).split(" ")[0] ?? "";
      const canonical = normalizeCompanyKey(row.company).replaceAll(" ", "");
      const alias = row.sources
        .flatMap((source) =>
          [...source.url.matchAll(/(?:^|[-/])([a-z][a-z0-9]{4,})-raises(?:[-/]|$)/gi)].map((match) => match[1]?.toLowerCase()),
        )
        .find((candidate) => candidate && first.length >= 3 && candidate.startsWith(first) && candidate !== canonical);
      if (alias) {
        try {
          const results = await client.search(`${alias} ${row.company} official website`, { limit: 10, highlights: false });
          const candidate = (results.web ?? [])
            .map((result) => ({
              url: "url" in result && typeof result.url === "string" ? result.url : "",
              title: "title" in result && typeof result.title === "string" ? result.title : null,
            }))
            .find((result) => hostOf(result.url).split(".")[0] === alias && namesCompany(result.title, row.company, { share: 1 }));
          const domain = candidate && registrableDomain(candidate.url);
          if (domain) {
            const url = `https://${domain}`;
            const description =
              pageSentences(page?.markdown ?? "").find(
                (sentence) =>
                  sentence.length < 400 &&
                  namesCompany(sentence, row.company, { share: 1 }) &&
                  /\b(?:platform|delivery|delivers|sells|provides|develops|builds)\b/i.test(sentence),
              ) ?? row.description;
            const [enriched] = (
              await enrichCompanies(
                client,
                [
                  {
                    company_key: normalizeCompanyKey(row.company),
                    company_name: row.company,
                    company_website: url,
                    company_description: description,
                    evidence: row.evidenceQuotes[0],
                    headline: row.sources[0]?.title,
                    source_pages: row.sources,
                  },
                ],
                { pricingPage: false, concurrency: 1 },
              )
            ).enrichments;
            if (enriched?.profile?.same_company && enriched.identity_basis && registrableDomain(enriched.company_website) === domain) {
              const home = await client.scrape(url, { formats: ["markdown"], onlyMainContent: true, timeout: 60_000, maxAge: 86_400_000 });
              const title = home.metadata?.title;
              if (title && namesCompany(title, row.company, { share: 1 })) website = { url, quote: title.trim() };
            }
          }
        } catch {
          counts.readErrors++;
        }
      }
    }
    const changes = planAuditRepair(row, page, website);
    counts.scanned++;
    return { round, company, changes };
  },
);

const companyChoices = new Map<string, AuditChange>();
for (const { company, changes } of plans)
  for (const change of changes) {
    if (change.kind !== "domain" && change.kind !== "name") continue;
    const key = `${company.id}:${change.kind}`;
    const prior = companyChoices.get(key);
    if (!prior || (change.kind === "domain" && change.to && !prior.to)) companyChoices.set(key, change);
  }
const seenCompany = new Set<string>();
for (const { round, company, changes } of plans) {
  const proposed = changes.filter((change) => {
    if (change.kind !== "domain" && change.kind !== "name") return true;
    const key = `${company.id}:${change.kind}`;
    if (seenCompany.has(key) || companyChoices.get(key) !== change) return false;
    seenCompany.add(key);
    return true;
  });
  for (const change of proposed) {
    counts[change.kind]++;
    console.log(JSON.stringify(change));
  }
  if (!apply || proposed.length === 0) continue;
  const set: Partial<typeof schema.fundingRounds.$inferInsert> = {};
  const companySet: Partial<typeof schema.companies.$inferInsert> = {};
  for (const change of proposed) {
    if (change.kind === "reject") {
      set.disposition = "rejected";
      set.verification = {
        ...(round.verification ?? { status: "unverified", notes: [], url: null }),
        notes: [...new Set([...(round.verification?.notes ?? []), `rejected: ${change.reason}: ${change.quote}`])],
      };
    }
    if (change.kind === "name") {
      companySet.name = change.to ?? company.name;
      companySet.nameKey = normalizeCompanyKey(change.to ?? company.name);
    }
    if (change.kind === "domain") {
      companySet.website = change.to;
      companySet.domain = change.to ? new URL(change.to).hostname.replace(/^www\./, "") : null;
      companySet.logoUrl = null;
    }
    if (change.kind === "money") {
      set.financingTotalAsWritten = change.to;
      set.financingTotalQuote = change.quote;
      set.amountScope = change.scope;
      if (change.from && change.from === round.amountAsWritten) {
        set.amountAsWritten = null;
        set.amountValue = null;
        set.amountCurrency = null;
        set.amountUsdMillions = null;
        set.fxRate = null;
        set.fxDate = null;
      }
    }
    if (change.kind === "valuation") {
      set.valuationAsWritten = null;
      set.valuationClaims = null;
    }
    if (change.kind === "stage") {
      set.stage = change.to as typeof round.stage;
      set.stageAsWritten =
        change.to === "pre_a" ? "Pre-A" : change.to === "convertible" ? "SAFE" : change.to === "debt" ? "Debt" : round.stageAsWritten;
    }
    if (change.kind === "extension") set.isExtension = true;
    if (change.kind === "date") {
      set.announcedOn = change.to;
      set.datePrecision = "day";
      set.dateBasis = "page";
    }
  }
  const nextDay = set.announcedOn ?? round.announcedOn;
  if (nextDay && (proposed.some((c) => c.kind === "date") || round.datePrecision === "day") && staleForNews(nextDay, round.firstSeenAt)) {
    set.history = true;
    set.status = "seen";
  }
  if (Object.keys(set).length) await handle.update(schema.fundingRounds).set(set).where(eq(schema.fundingRounds.id, round.id));
  if (Object.keys(companySet).length) await handle.update(schema.companies).set(companySet).where(eq(schema.companies.id, company.id));
}
console.log(JSON.stringify({ mode: apply ? "applied" : "dry-run", counts }));
await invalidateScriptEntityPages();
await closeDb();
