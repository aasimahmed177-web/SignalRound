import { canonicalUrl, isArticleUrl, registrableDomain } from "../records/normalize.ts";
import { companySite, linkedSites } from "../records/source-fit.ts";
import type { NativeWebClient } from "../web/client.ts";
import { isArticleLink, watchLinkDate } from "./watch.ts";

export const NEWSROOM_TERMS = ["news", "press", "blog", "announcements", "funding"] as const;
export const NEWSROOM_LIMIT = 4;
export const NEWSROOM_PAGE_LIMIT = 80;
export const NEWSROOM_NEW_LIMIT = 5;
export const TOP_NEWSROOMS = 100;
export const MONITORED_COMPANIES = 25;
export const DISCOVERY_CAP = 20;
export const CHECK_CAP = 40;
export const HISTORY_CAP = 3;
const SECTION = /(?:^|\/)(?:news(?:room)?|press(?:-releases?)?|media|blog|journal|updates|announcements?|changelog|stories)(?:\/|$)/i;
const FUNDING = /(?:rais(?:e[sd]?|ing)|fund(?:ed|ing)?|financ(?:e|ing)|seed|series|investment|million|billion|round)/i;
const HOSTED_BLOG = /\.(?:substack|medium|wordpress|blogspot|beehiiv)\.com$/i;
const DAY = 86_400_000;

export interface CompanyNewsroomTarget {
  id: string;
  name: string;
  homepage: string;
  domain: string;
  aliases: string[];
  top: boolean;
  monitor: boolean;
  lastRound: string | null;
  discoveredAt: Date | null;
  sections: Array<{ url: string; monitorId: string | null; checkedAt: Date | null }>;
}

export function discoveryDue(target: CompanyNewsroomTarget, now: Date): boolean {
  return !target.discoveredAt || target.discoveredAt.getTime() <= now.getTime() - (target.top ? 30 : 90) * DAY;
}

export function sectionDue(target: CompanyNewsroomTarget, section: CompanyNewsroomTarget["sections"][number], now: Date): boolean {
  const days =
    section.monitorId ||
    target.top ||
    (target.lastRound && target.lastRound >= new Date(now.getTime() - 90 * DAY).toISOString().slice(0, 10))
      ? 7
      : 30;
  return !section.checkedAt || section.checkedAt.getTime() <= now.getTime() - days * DAY;
}

export interface NewsroomLink {
  url: string;
  title?: string;
}

export function newsroomSections(links: readonly NewsroomLink[], sites: { domain: string; aliases: string[] }): string[] {
  const found = new Set<string>();
  for (const link of links) {
    if (companySite(link.url, { domain: sites.domain, sites: sites.aliases }) !== "own") continue;
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    if (/^(?:careers?|jobs?)\./i.test(url.hostname)) continue;
    const segments = url.pathname.split("/").filter(Boolean);
    const index = segments.findIndex((segment) => SECTION.test(`/${segment}/`));
    if (index < 0) {
      if (HOSTED_BLOG.test(url.hostname) && sites.aliases.includes(url.hostname.toLowerCase())) found.add(canonicalUrl(url.origin));
      continue;
    }
    if (index > 2) continue;
    const section = new URL(`/${segments.slice(0, index + 1).join("/")}/`, url.origin);
    found.add(canonicalUrl(section.href));
    if (found.size >= NEWSROOM_LIMIT) break;
  }
  return [...found];
}

/** A mapped link must report funding and be in the news window before it gets an extraction slot. */
export function newsroomFundingLinks(links: readonly NewsroomLink[], section: string, now = new Date(), maxAgeDays = 14): string[] {
  const out = new Set<string>();
  const source = new URL(section);
  const host = source.hostname;
  for (const link of links) {
    const url = new URL(link.url, section);
    if (HOSTED_BLOG.test(host) && url.hostname !== host) continue;
    const shortPressArticle =
      url.hostname === host &&
      url.pathname.startsWith(`${source.pathname.replace(/\/$/, "")}/`) &&
      isArticleUrl(url.href) &&
      FUNDING.test(link.title ?? "");
    if (!isArticleLink(url.href, section) && !shortPressArticle && !(HOSTED_BLOG.test(host) && /^\/p\/[^/]+/.test(url.pathname))) continue;
    const date = watchLinkDate(link.url);
    if (date && date.getTime() < now.getTime() - maxAgeDays * DAY) continue;
    const path = url.pathname;
    if (!FUNDING.test(`${path} ${link.title ?? ""}`)) continue;
    out.add(canonicalUrl(link.url));
  }
  return [...out];
}

/** NativeWebClient map is scoped to a company-owned site; unlinked lookalike domains are never mapped. */
export async function discoverNewsrooms(
  client: Pick<NativeWebClient, "map" | "scrape">,
  homepage: string,
  aliases: string[],
): Promise<{ sections: string[]; linked: string[]; calls: number }> {
  const domain = registrableDomain(homepage);
  if (!domain) return { sections: [], linked: [], calls: 0 };
  const links: NewsroomLink[] = [];
  let linked: string[] = [];
  try {
    const home = await client.scrape(homepage, { formats: ["links"], timeout: 30_000 });
    for (const url of home.links ?? []) links.push({ url });
    linked = linkedSites(home.links ?? [], domain);
  } catch {}
  const allowedAliases = [...new Set([...aliases, ...linked])];
  const sites = [domain, ...allowedAliases.filter((site) => site !== domain)].slice(0, 6);
  let calls = 0;
  for (const site of sites) {
    for (const search of NEWSROOM_TERMS) {
      try {
        const result = await client.map(`https://${site}`, { search, includeSubdomains: true, limit: 30, timeout: 30_000 });
        links.push(...(result.links ?? []).map((link) => ({ url: link.url, title: link.title })));
      } catch {}
      calls++;
    }
  }
  return { sections: newsroomSections(links, { domain, aliases: allowedAliases }), linked, calls };
}
