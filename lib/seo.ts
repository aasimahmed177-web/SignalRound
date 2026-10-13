// What a search engine reads beside the page: the sitemap's entries, the JSON-LD blocks, and a
// company's search title and summary. The sitemap reads cover the rounds the feed lists (publish
// and flagged), the set the directories count (lib/directory.ts), so it never names a page a
// visitor would get a 404 for. What states a figure as fact (the JSON-LD rounds, the summary)
// counts only the citable rounds: published, verified, and closed.

import { isPersonShaped, normalizeInvestorKey } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { desc, eq, inArray, sql } from "drizzle-orm";
import type { MetadataRoute } from "next";
import type { CompanyPage } from "@/lib/company";
import { inFeed } from "@/lib/company";
import { reportedAmount, roundStageLabel, stageOf, usd } from "@/lib/format";
import { REPO_URL } from "@/lib/landing";
import { companyHref, investorHref } from "@/lib/links";
import type { RoundRow } from "@/lib/persist";
import { capitalise, cardDate, clip, nameList } from "@/lib/share";
import { isVerified } from "@/lib/source-count";
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
  /** ISO timestamp of when the entity's newest visible round joined the record. */
  lastModified: string;
}

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

/**
 * Every company and investor page worth listing, two grouped queries in all: a company with a
 * visible round, an investor named on one, each dated by when its latest round joined the record.
 * Not the rows' updatedAt: marking a round seen or re-reading a source moves that without changing
 * what the page says, and a lastmod that moves every day is one a search engine stops trusting.
 */
export async function sitemapEntities(handle: Db): Promise<{ companies: SitemapEntity[]; investors: SitemapEntity[] }> {
  const latestRound = sql<string>`max(${fundingRounds.firstSeenAt})`;
  const [companyRows, investorRows] = await Promise.all([
    handle
      .select({ id: companies.id, last: latestRound })
      .from(companies)
      .innerJoin(fundingRounds, eq(fundingRounds.companyId, companies.id))
      .where(inArray(fundingRounds.disposition, [...VISIBLE]))
      .groupBy(companies.id)
      .orderBy(desc(latestRound), companies.id)
      .limit(SITEMAP_ENTITY_CAP),
    handle
      .select({ id: investors.id, last: latestRound })
      .from(investors)
      .innerJoin(roundInvestors, eq(roundInvestors.investorId, investors.id))
      .innerJoin(fundingRounds, eq(fundingRounds.id, roundInvestors.roundId))
      .where(inArray(fundingRounds.disposition, [...VISIBLE]))
      .groupBy(investors.id)
      .orderBy(desc(latestRound), investors.id)
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

/**
 * A round an answer engine may repeat as fact: published, which means its own pages confirmed it
 * (an earlier round promoted from a checked dossier was verified against its announcement), and
 * closed, announced by the company or reported by the press. A flagged row, a row in review, and a
 * raise still expected never count, though the page lists the flagged ones for a reader to judge.
 */
export function citable(r: RoundRow): boolean {
  return r.disposition === "publish" && (r.history || isVerified(r)) && (r.certainty === "announced" || r.certainty === "reported");
}

/** "Series A" and "SAFE" keep their capitals; "Seed" reads "seed round", "Funding round" stays one round. */
function roundNoun(r: RoundRow): string {
  const label = roundStageLabel(r);
  const noun = /^(?:Series\b|\p{Lu}\p{Lu})/u.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
  return `${noun}${/\bround$/i.test(noun) || noun.startsWith("Series") ? "" : " round"}${r.is_extension ? " extension" : ""}`;
}

/** One round as a clause: "$1.85B funding round led by Dragoneer and Thrive Capital, reported 9 Oct 2026". */
function roundClause(r: RoundRow): string {
  const amount = r.amount.as_written ?? reportedAmount(r);
  const leads = r.lead_investors.length ? ` led by ${nameList(r.lead_investors)}` : "";
  const day = cardDate(r.announced_on, r.date_precision);
  const when = day ? `, ${r.certainty === "reported" ? "reported" : "announced"} ${day}` : "";
  return `${amount ? `${amount} ` : ""}${roundNoun(r)}${leads}${when}`;
}

/**
 * The one count of what a company raised, shared by the page's "raised on record" figure, the dated
 * summary, the search description, and the markdown view: the citable rounds (newest first), the ones
 * among them that state an amount, and those amounts summed in USD. `pending` is the rest the feed
 * lists (flagged, expected, unverified), which the page shows but no figure counts.
 */
export function verifiedRaise(rounds: RoundRow[]) {
  const cited = rounds.filter(citable);
  const priced = cited.filter((r) => (r.amount.usd_millions ?? 0) > 0);
  return {
    cited,
    priced,
    usdMillions: priced.reduce((sum, r) => sum + (r.amount.usd_millions ?? 0), 0),
    pending: rounds.filter((r) => inFeed(r) && !citable(r)),
  };
}

/** The verified total as the page and the summary both print it, billions to two places: $2.65B never reads as $2.6B. */
export function raisedFigure(usdMillions: number): string {
  return usdMillions >= 1000 ? `$${Number((usdMillions / 1000).toFixed(2))}B` : usd(usdMillions);
}

/** "6 rounds still being checked", "1 expected raise not yet closed": the rows the page lists that no figure counts. */
export function pendingClause(pending: RoundRow[]): string | null {
  const expected = pending.filter((r) => r.certainty === "expected").length;
  const checking = pending.length - expected;
  const parts = [
    checking ? `${checking} ${checking === 1 ? "round" : "rounds"} still being checked` : null,
    expected ? `${expected} expected ${expected === 1 ? "raise" : "raises"} not yet closed` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" and ") : null;
}

export interface FundingSummary {
  /** "Ramp has raised $2.65B across 3 verified rounds on record, plus 6 rounds still being checked". */
  raised: string;
  /** The newest citable round as a clause. */
  latest: string;
}

/**
 * What a company has raised, counted over the citable rounds only, or null when none is. "At least"
 * when a round disclosed no amount; it says so when a figure was converted from another currency,
 * and names the rounds the page lists that the figure leaves out.
 */
export function fundingSummary(name: string, rounds: RoundRow[]): FundingSummary | null {
  const { cited, priced, usdMillions, pending } = verifiedRaise(rounds);
  const [latest] = cited;
  if (!latest) return null;
  const count = `${cited.length} verified ${cited.length === 1 ? "round" : "rounds"} on record`;
  const unpriced = cited.length - priced.length;
  const notes = [
    priced.length && unpriced ? `${unpriced} with no disclosed amount` : null,
    priced.some((r) => r.amount.currency !== null && r.amount.currency !== "USD") ? "amounts in other currencies converted to USD" : null,
  ].filter(Boolean);
  const raised = priced.length
    ? `${name} has raised ${unpriced ? "at least " : ""}${raisedFigure(usdMillions)} across ${count}${notes.length ? ` (${notes.join("; ")})` : ""}`
    : `${name} has ${count}, none with a disclosed amount`;
  const more = pendingClause(pending);
  return { raised: more ? `${raised}, plus ${more}` : raised, latest: roundClause(latest) };
}

/** "As of 13 Oct 2026, Ramp has raised $2.65B across 3 verified rounds on record, plus 6 rounds still being checked; latest: …, reported 9 Oct 2026." */
export function asOfSentence(summary: FundingSummary, asOf: Date): string {
  return `As of ${cardDate(asOf.toISOString().slice(0, 10), "day")}, ${summary.raised}; latest: ${summary.latest}.`;
}

/** Search results cut a description near here; a sentence that ends beats one that is cut. */
const MAX_DESCRIPTION = 300;

/**
 * The title and description a search result shows for a company page: the query people type
 * ("Ramp funding rounds and investors", "How much has Ramp raised?") answered from the citable
 * rounds alone. Without one the description is the share card's.
 */
export function companySearchMeta(page: CompanyPage, fallback: string): { title: string; description: string } {
  const { name } = page.company;
  const title = `${name} funding rounds and investors`;
  const summary = fundingSummary(name, page.rounds);
  if (!summary) return { title, description: fallback };
  const what = capitalise(page.company.description);
  const answer = `How much has ${name} raised? ${summary.raised}; latest: ${summary.latest}.`;
  return { title, description: clip(what ? `${answer} ${/[.!?]$/.test(what) ? what : `${what}.`}` : answer, MAX_DESCRIPTION) };
}

/** How many rounds a company's JSON-LD carries; the page lists the rest. */
const MAX_ROUNDS = 20;

/** How many of a round's sources its JSON-LD cites, in reading order: the announcement first. */
const MAX_ROUND_SOURCES = 5;

/**
 * A company page's JSON-LD: the page itself, carrying the dated summary; the company as an
 * Organization; and each citable round as an InvestAction on it, its lead investors the agents,
 * the others participants, the stated amount its price, and the pages that reported it its
 * subjectOf. Flagged, expected, and unverified rows never appear, whoever renders the page.
 * Undated and unpriced rounds just leave those fields out. An investor with a resolved firm domain
 * is an Organization; a name shaped like a person's with no domain is a Person.
 */
export function companyJsonLd(page: CompanyPage, base: string, asOf: Date) {
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
  const pageUrl = `${base}${companyHref(company.id)}`;
  const orgId = `${pageUrl}#organization`;
  const summary = fundingSummary(company.name, page.rounds);
  const rounds = page.rounds
    .filter(citable)
    .slice(0, MAX_ROUNDS)
    .map((r) => {
      const label = ["undisclosed", "other"].includes(r.stage) ? "funding round" : stageOf(r);
      const amount =
        r.amount.value !== null && r.amount.currency
          ? { value: Math.round(r.amount.value * 1_000_000), currency: r.amount.currency }
          : r.amount.usd_millions !== null
            ? { value: Math.round(r.amount.usd_millions * 1_000_000), currency: "USD" }
            : null;
      const sources = r.sources.slice(0, MAX_ROUND_SOURCES).map((s) => ({
        "@type": "WebPage",
        url: s.url,
        ...(s.title ? { name: s.title } : {}),
        ...(s.published && /^\d{4}-\d{2}-\d{2}/.test(s.published) ? { datePublished: s.published.slice(0, 10) } : {}),
      }));
      return {
        "@type": "InvestAction",
        name: `${company.name} ${label}${r.is_extension ? " extension" : ""}`,
        description: `${capitalizeFirst(roundClause(r))}.`,
        actionStatus: "https://schema.org/CompletedActionStatus",
        object: { "@id": orgId },
        ...(r.announced_on ? { startTime: r.announced_on.slice(0, r.date_precision === "day" ? 10 : 7) } : {}),
        ...(amount ? { price: amount.value, priceCurrency: amount.currency } : {}),
        ...(r.lead_investors.length ? { agent: r.lead_investors.map(funder) } : {}),
        ...(r.other_investors.length ? { participant: r.other_investors.map(funder) } : {}),
        ...(sources.length ? { subjectOf: sources } : {}),
      };
    });
  const website = httpUrl(company.website) ?? (company.domain ? `https://${company.domain}` : undefined);
  const description = company.description?.trim() ? capitalizeFirst(company.description.trim()) : undefined;
  const webPage = {
    "@type": "WebPage",
    "@id": pageUrl,
    url: pageUrl,
    name: `${company.name} funding rounds and investors`,
    ...(summary ? { description: asOfSentence(summary, asOf) } : {}),
    about: { "@id": orgId },
    isPartOf: { "@id": `${base}/#website` },
  };
  const organization = {
    "@type": "Organization",
    "@id": orgId,
    name: company.name,
    ...(website ? { url: website } : {}),
    ...(httpUrl(company.logo_url) ? { logo: company.logo_url } : {}),
    ...(description ? { description } : {}),
    ...(company.hq ? { location: company.hq } : {}),
    mainEntityOfPage: { "@id": pageUrl },
  };
  return { "@context": "https://schema.org", "@graph": [webPage, organization, ...rounds] };
}

/**
 * The feed's JSON-LD: the rounds as a Dataset, published by Firecrawl, downloadable from the API
 * and, on a public instance, the public feeds. `base` names the page, `origin` the deployment that
 * serves the downloads.
 */
export function feedJsonLd(base: string, origin: string, feeds: Record<string, Array<{ url: string; title: string }>> | undefined) {
  const download = (encodingFormat: string, path: string, name: string) => ({
    "@type": "DataDownload",
    name,
    encodingFormat,
    contentUrl: `${origin}${path}`,
  });
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${base}/feed#dataset`,
    name: "Fireround startup funding rounds",
    description:
      "Startup funding rounds from across the open web, pre-seed to growth. Each round carries its company, stage, amount, announcement date, lead and other investors, and the source pages that reported it, with its verification status. New rounds are added as scheduled sweeps find them.",
    url: `${base}/feed`,
    inLanguage: "en",
    isAccessibleForFree: true,
    keywords: ["startup funding", "funding rounds", "venture capital", "seed", "Series A", "investors"],
    creator: { "@type": "Organization", "@id": FIRECRAWL.id, name: "Firecrawl", url: FIRECRAWL.url },
    variableMeasured: ["company", "stage", "amount", "announcement date", "lead investors", "other investors", "sources"],
    measurementTechnique:
      "Funding announcements found with Firecrawl web search, extracted to a schema, deduplicated, and checked against the pages that reported them.",
    distribution: [
      download("application/json", "/api/v1/rounds", "Funding rounds API (JSON)"),
      download("text/csv", "/api/v1/rounds?format=csv", "Funding rounds API (CSV)"),
      ...Object.entries(feeds ?? {}).flatMap(([type, links]) => links.map((l) => download(type, l.url, l.title))),
    ],
  };
}

/**
 * JSON for a <script type="application/ld+json">. `<` is escaped so a company description holding
 * "</script>" cannot close the tag early (the XSS the Next JSON-LD guide warns about).
 */
export function jsonLdHtml(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
