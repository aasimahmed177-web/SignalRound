// What a search engine reads beside the page: the sitemap's entries and the JSON-LD blocks. The
// reads cover the rounds the feed lists (publish and flagged), the set the directories count
// (lib/directory.ts), so the sitemap never names a page a visitor would get a 404 for.

import { isPersonShaped, normalizeInvestorKey } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { desc, eq, inArray, sql } from "drizzle-orm";
import type { MetadataRoute } from "next";
import type { CompanyPage } from "@/lib/company";
import { inFeed } from "@/lib/company";
import { stageOf } from "@/lib/format";
import { REPO_URL } from "@/lib/landing";
import { companyHref, investorHref } from "@/lib/links";
import { capitalizeFirst } from "@/lib/text";

const { companies, fundingRounds, investors, roundInvestors } = schema;

const VISIBLE = ["publish", "flagged"] as const;

/**
 * A sitemap file holds 50,000 URLs. Each entity list is capped under half that, newest first, so
 * one file always fits; past it, split with generateSitemaps rather than raising the cap.
 */
export const SITEMAP_ENTITY_CAP = 24_000;

export interface SitemapEntity {
  id: string;
  /** ISO timestamp of the newest change to a visible round (or, for a company, its profile). */
  lastModified: string;
}

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

/**
 * Every company and investor page worth listing, two grouped queries in all: a company with a
 * visible round, dated by its newest round update or profile update; an investor named on a
 * visible round, dated by that round's update.
 */
export async function sitemapEntities(handle: Db): Promise<{ companies: SitemapEntity[]; investors: SitemapEntity[] }> {
  const companyLast = sql<string>`greatest(max(${fundingRounds.updatedAt}), max(${companies.updatedAt}))`;
  const investorLast = sql<string>`max(${fundingRounds.updatedAt})`;
  const [companyRows, investorRows] = await Promise.all([
    handle
      .select({ id: companies.id, last: companyLast })
      .from(companies)
      .innerJoin(fundingRounds, eq(fundingRounds.companyId, companies.id))
      .where(inArray(fundingRounds.disposition, [...VISIBLE]))
      .groupBy(companies.id)
      .orderBy(desc(companyLast), companies.id)
      .limit(SITEMAP_ENTITY_CAP),
    handle
      .select({ id: investors.id, last: investorLast })
      .from(investors)
      .innerJoin(roundInvestors, eq(roundInvestors.investorId, investors.id))
      .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
      .where(inArray(fundingRounds.disposition, [...VISIBLE]))
      .groupBy(investors.id)
      .orderBy(desc(investorLast), investors.id)
      .limit(SITEMAP_ENTITY_CAP),
  ]);
  return {
    companies: companyRows.map((r) => ({ id: r.id, lastModified: iso(r.last) })),
    investors: investorRows.map((r) => ({ id: r.id, lastModified: iso(r.last) })),
  };
}

/**
 * The sitemap from the entity reads: the front door (`/` when LANDING=1 serves the landing page
 * there, else the landing page at /home), the public indexes (the feed, the Overview, the two
 * directories, the news), then each entity page. Pure, so a test pins the shape without a server.
 */
export function buildSitemap(
  origin: string,
  landing: boolean,
  entities: { companies: SitemapEntity[]; investors: SitemapEntity[] },
): MetadataRoute.Sitemap {
  const newest = [...entities.companies, ...entities.investors].reduce<string | undefined>(
    (max, e) => (max === undefined || e.lastModified > max ? e.lastModified : max),
    undefined,
  );
  const index = (path: string, changeFrequency: "hourly" | "daily", priority: number) => ({
    url: `${origin}${path}`,
    ...(newest ? { lastModified: newest } : {}),
    changeFrequency,
    priority,
  });
  return [
    index(landing ? "/" : "/home", "daily", 1),
    index("/feed", "hourly", 0.9),
    index("/overview", "hourly", 0.8),
    index("/companies", "daily", 0.8),
    index("/investors", "daily", 0.8),
    index("/news", "hourly", 0.6),
    ...entities.companies.map((c) => ({
      url: `${origin}${companyHref(c.id)}`,
      lastModified: c.lastModified,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
    ...entities.investors.map((i) => ({
      url: `${origin}${investorHref(i.id)}`,
      lastModified: i.lastModified,
      changeFrequency: "weekly" as const,
      priority: 0.5,
    })),
  ];
}

const FIRECRAWL = { url: "https://www.firecrawl.dev", id: "https://www.firecrawl.dev/#organization" };

/**
 * The landing page's JSON-LD: the Fireround site, published by Firecrawl. Fireround is a product,
 * not a company, so the one Organization node is Firecrawl's.
 */
export function siteJsonLd(origin: string, description: string) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${origin}/#website`,
        name: "Fireround",
        url: `${origin}/`,
        description,
        inLanguage: "en",
        publisher: { "@id": FIRECRAWL.id },
      },
      {
        "@type": "Organization",
        "@id": FIRECRAWL.id,
        name: "Firecrawl",
        url: FIRECRAWL.url,
        logo: `${FIRECRAWL.url}/brand/firecrawl-wordmark.svg`,
        sameAs: ["https://github.com/firecrawl", REPO_URL],
      },
    ],
  };
}

function httpUrl(value: string | null | undefined): string | undefined {
  return value && /^https?:\/\//.test(value) ? value : undefined;
}

/** How many rounds a company's JSON-LD carries; the page lists the rest. */
const MAX_ROUNDS = 20;

/**
 * A company page's JSON-LD: the company as an Organization and each round the feed lists as an
 * InvestAction in the same graph, its investors the agents, the company its object, the stated
 * amount its price. Rounds were MonetaryGrants on `funding`, which labels equity as grants.
 * Undated and unpriced rounds just leave those fields out. An investor with a resolved firm
 * domain is an Organization; a name shaped like a person's with no domain is a Person.
 */
export function companyJsonLd(page: CompanyPage, origin: string) {
  const { company } = page;
  const known = new Map(page.investors.map((i) => [i.id, i]));
  const funder = (name: string) => {
    const hit = known.get(normalizeInvestorKey(name));
    const domain = hit?.domain ?? null;
    return {
      "@type": !domain && isPersonShaped(name) ? "Person" : "Organization",
      name,
      ...(domain ? { url: `https://${domain}` } : {}),
    };
  };
  const pageUrl = `${origin}${companyHref(company.id)}`;
  const orgId = `${pageUrl}#organization`;
  const rounds = page.rounds
    .filter(inFeed)
    .slice(0, MAX_ROUNDS)
    .map((r) => {
      const label = ["undisclosed", "other"].includes(r.stage) ? "funding round" : stageOf(r);
      const amount =
        r.amount.value !== null && r.amount.currency
          ? { value: Math.round(r.amount.value * 1_000_000), currency: r.amount.currency }
          : r.amount.usd_millions !== null
            ? { value: Math.round(r.amount.usd_millions * 1_000_000), currency: "USD" }
            : null;
      const funders = [...r.lead_investors, ...r.other_investors].map(funder);
      return {
        "@type": "InvestAction",
        name: `${company.name} ${label}${r.is_extension ? " extension" : ""}`,
        object: { "@id": orgId },
        ...(r.announced_on ? { startTime: r.announced_on.slice(0, r.date_precision === "day" ? 10 : 7) } : {}),
        ...(amount ? { price: amount.value, priceCurrency: amount.currency } : {}),
        ...(funders.length ? { agent: funders } : {}),
      };
    });
  const website = httpUrl(company.website) ?? (company.domain ? `https://${company.domain}` : undefined);
  const description = company.description?.trim() ? capitalizeFirst(company.description.trim()) : undefined;
  const organization = {
    "@type": "Organization",
    "@id": orgId,
    name: company.name,
    ...(website ? { url: website } : {}),
    ...(httpUrl(company.logo_url) ? { logo: company.logo_url } : {}),
    ...(description ? { description } : {}),
    ...(company.hq ? { location: company.hq } : {}),
    mainEntityOfPage: pageUrl,
  };
  return { "@context": "https://schema.org", "@graph": [organization, ...rounds] };
}

/**
 * JSON for a <script type="application/ld+json">. `<` is escaped so a company description holding
 * "</script>" cannot close the tag early (the XSS the Next JSON-LD guide warns about).
 */
export function jsonLdHtml(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
