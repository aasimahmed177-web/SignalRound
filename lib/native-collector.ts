import { readPublicText } from "@fireround/core/web/transport";
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import type { SignalInput } from "./signals.ts";

export const DEFAULT_NATIVE_FEEDS = [
  "https://techcrunch.com/category/venture/fundraising/feed/",
  "https://www.prnewswire.com/rss/news-releases-list.rss",
] as const;

const FUNDING_ACTION = /\b(?:raises?|raised|secures?|secured|closes?|closed|lands?|landed|bags?|bagged)\b/i;
const FUNDING_AMOUNT = /(?:US\$|CA\$|AU\$|[$€£¥])\s?\d+(?:[.,]\d+)?\s?(?:billion|million|thousand|[BMK])\b/i;
const FUNDING_STAGE =
  /\b(?:pre[- ]?seed|seed(?: round)?|series\s+[a-h]|growth(?: round)?|bridge(?: round)?|venture round|strategic (?:round|financing))\b/i;
const FUNDING_NOUN = /\b(?:funding|financing|fundraise|investment round)\b/i;
const ROLE_LOCAL_PART = /^(?:business|contact|hello|hi|info|inquiries|investor(?:s|relations)?|media|partnerships?|press|sales|team)$/i;
const EXCLUDED_LOCAL_PART = /^(?:abuse|admin|billing|careers?|dpo|jobs?|legal|noreply|no-reply|privacy|security|support)$/i;
const EXCLUDED_HOSTS = [
  "apple.com",
  "bloomberg.com",
  "businesswire.com",
  "crunchbase.com",
  "facebook.com",
  "github.com",
  "google.com",
  "instagram.com",
  "linkedin.com",
  "prnewswire.com",
  "techcrunch.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
];

const USER_AGENT = "SignalRound/0.2 (+https://github.com/aasimahmed177-web/SignalRound)";
const MAX_BODY_BYTES = 4_000_000;

export interface NativeFeedItem {
  title: string;
  url: string;
  summary: string | null;
  author: string | null;
  publishedAt: string | null;
  feedUrl: string;
}

export interface PublicContact {
  email: string;
  sourceUrl: string;
}

export interface CollectedNativeSignal {
  input: SignalInput;
  companyWebsite: string | null;
  contacts: PublicContact[];
  amountAsWritten: string | null;
  stageAsWritten: string | null;
  fetchMethods: string[];
}

export interface NativeCollectorOptions {
  items?: NativeFeedItem[];
  query?: string;
  signal?: AbortSignal;
  feeds?: string[];
  limit?: number;
  since?: Date;
  fetchImpl?: typeof fetch;
  jinaFallback?: boolean;
  onProgress?: (message: string) => void;
}

interface ReadResult {
  text: string;
  method: "direct" | "agent-reach-jina";
}

function values<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textValue(record["#text"] ?? record.__cdata ?? record._text ?? "");
  }
  return "";
}

function cleanText(value: string): string {
  return load(`<body>${value}</body>`)("body").text().replace(/\s+/g, " ").trim();
}

function safeHttpUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function sameSite(a: string, b: string): boolean {
  const left = hostOf(a);
  const right = hostOf(b);
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

function isExcludedHost(host: string): boolean {
  return EXCLUDED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

export function parseNativeFeed(xml: string, feedUrl: string): NativeFeedItem[] {
  const parsed = new XMLParser({ ignoreAttributes: false, trimValues: true }).parse(xml) as Record<string, unknown>;
  const rss = parsed.rss as { channel?: Record<string, unknown> } | undefined;
  const atom = parsed.feed as Record<string, unknown> | undefined;
  const rawItems = rss?.channel ? values(rss.channel.item) : values(atom?.entry);
  return rawItems.flatMap((raw): NativeFeedItem[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const linkValue = values(item.link)
      .map((link) => {
        if (typeof link === "string") return link;
        if (link && typeof link === "object") {
          const attrs = link as Record<string, unknown>;
          return textValue(attrs["@_href"] ?? attrs.href ?? attrs["#text"]);
        }
        return "";
      })
      .find(Boolean);
    const url = safeHttpUrl(linkValue || textValue(item.guid));
    const title = cleanText(textValue(item.title));
    if (!url || !title) return [];
    const published = textValue(item.pubDate ?? item.published ?? item.updated);
    const publishedAt = published && !Number.isNaN(Date.parse(published)) ? new Date(published).toISOString() : null;
    const summary = cleanText(textValue(item.description ?? item.summary ?? item["content:encoded"] ?? item.content));
    return [
      {
        title,
        url,
        summary: summary || null,
        author: cleanText(textValue(item["dc:creator"] ?? item.author)) || null,
        publishedAt,
        feedUrl,
      },
    ];
  });
}

export function isFundingItem(item: NativeFeedItem): boolean {
  const title = cleanText(item.title);
  if (/^(?:here are|these are|top\s+\d|the\s+\d)|\b(?:startups|companies)\s+(?:that|which|have)\s+(?:raised|secured|closed)\b/i.test(title))
    return false;
  if (/\b(?:how to|guide to|tips for|steps to)\s+(?:raise|raising|fundrais)/i.test(title)) return false;
  if (/\braises? the stakes\b/i.test(title) || /\bvaluation\b/i.test(title)) return false;
  const hasFinancialFact = FUNDING_AMOUNT.test(title) || FUNDING_STAGE.test(title) || FUNDING_NOUN.test(title);
  return hasFinancialFact && (FUNDING_ACTION.test(title) || /\bannounces?\b/i.test(title));
}

export function companyNameFromHeadline(headline: string): string | null {
  const title = cleanText(headline)
    .replace(/^(?:exclusive|startup funding news today|funding alert)\s*[:—-]\s*/i, "")
    .replace(/^(?:china|india|japan|france|germany|europe|africa|asia|canada|australia|brazil)[’']s\s+/i, "")
    .replace(/^(?:(?:AI|fintech|robotics|biotech|healthtech|software|climate|cybersecurity)\s+)?startup\s+/i, "")
    .replace(/\s*[|—-]\s*(?:techcrunch|pr newswire).*$/i, "");
  const match = title.match(
    /^(.{2,100}?)\s+(?:announces?\b.*?\s+)?(?:raises?|raised|secures?|secured|closes?|closed|lands?|landed|bags?|bagged)\b/i,
  );
  const value = (match?.[1] ?? "").replace(/^["'“”]|["'“”]$/g, "").trim();
  if (
    !value ||
    /(?:^(?:a\b|an\b|the\b|here\b|these\b|former\b|ex[-\s]|startup\b)|\b(?:founder|exec|executive|startups|companies|that|which)\b)/i.test(
      value,
    )
  )
    return null;
  return value;
}

export function fundingFacts(text: string): { amountAsWritten: string | null; stageAsWritten: string | null } {
  const normalized = cleanText(text);
  const amount = normalized.match(FUNDING_AMOUNT)?.[0] ?? null;
  const stage = normalized.match(FUNDING_STAGE)?.[0] ?? null;
  return { amountAsWritten: amount, stageAsWritten: stage };
}

function companyTokens(name: string | null): string[] {
  if (!name) return [];
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !["company", "labs", "technologies", "startup"].includes(token));
}

export function discoverCompanyWebsite(articleHtml: string, articleUrl: string, company: string | null): string | null {
  const $ = load(articleHtml);
  const articleHost = hostOf(articleUrl);
  const tokens = companyTokens(company);
  const candidates = new Map<string, number>();
  $("a[href]").each((_, element) => {
    const href = safeHttpUrl($(element).attr("href") ?? "", articleUrl);
    if (!href) return;
    const host = hostOf(href);
    if (!host || host === articleHost || isExcludedHost(host)) return;
    const url = new URL(href);
    const anchor = cleanText($(element).text()).toLowerCase();
    let score = url.pathname === "/" || url.pathname === "" ? 2 : 0;
    if (tokens.some((token) => host.replace(/[^a-z0-9]/g, "").includes(token))) score += 5;
    if (tokens.some((token) => anchor.includes(token))) score += 4;
    if (/\b(?:website|company|homepage|learn more)\b/i.test(anchor)) score += 2;
    if (/\b(?:investor|portfolio|author|source)\b/i.test(anchor)) score -= 3;
    const root = `${url.protocol}//${url.host}/`;
    candidates.set(root, Math.max(candidates.get(root) ?? Number.NEGATIVE_INFINITY, score));
  });
  const best = [...candidates.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 4 ? best[0] : null;
}

export function extractPublicEmails(content: string, sourceUrl: string, companyWebsite: string): PublicContact[] {
  const matches = content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  const companyHost = hostOf(companyWebsite);
  const unique = new Map<string, PublicContact>();
  for (const raw of matches) {
    const email = raw.toLowerCase().replace(/[),.;:]+$/, "");
    const [local, domain] = email.split("@");
    if (!local || !domain || EXCLUDED_LOCAL_PART.test(local) || !ROLE_LOCAL_PART.test(local)) continue;
    if (!(domain === companyHost || companyHost.endsWith(`.${domain}`) || domain.endsWith(`.${companyHost}`))) continue;
    unique.set(email, { email, sourceUrl });
  }
  return [...unique.values()];
}

async function boundedText(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new Error(`response exceeds ${MAX_BODY_BYTES} bytes`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error(`response exceeds ${MAX_BODY_BYTES} bytes`);
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel();
  }
}

async function readUrl(url: string, fetchImpl: typeof fetch, _jinaFallback: boolean, signal?: AbortSignal): Promise<ReadResult> {
  // Production always uses the pinned, public-address-only transport. fetchImpl is a test seam.
  if (fetchImpl === fetch) {
    const result = await readPublicText(url, { maxBytes: MAX_BODY_BYTES, timeoutMs: 15_000, signal });
    return { text: result.text, method: "direct" };
  }
  const response = await fetchImpl(url, {
    redirect: "error",
    headers: { accept: "text/html,application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.1", "user-agent": USER_AGENT },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { text: await boundedText(response), method: "direct" };
}

function contactPageUrls(homeHtml: string, website: string): string[] {
  const $ = load(homeHtml);
  const links: string[] = [];
  $("a[href]").each((_, element) => {
    const label = `${$(element).text()} ${$(element).attr("href") ?? ""}`;
    if (!/\b(?:contact|about|company|press|media)\b/i.test(label)) return;
    const url = safeHttpUrl($(element).attr("href") ?? "", website);
    if (url && sameSite(url, website)) links.push(url);
  });
  for (const path of ["contact", "contact-us", "about", "company"]) {
    const url = safeHttpUrl(path, website);
    if (url) links.push(url);
  }
  return [...new Set(links)].slice(0, 6);
}

export async function collectContacts(
  website: string,
  fetchImpl: typeof fetch,
  jinaFallback: boolean,
  signal?: AbortSignal,
): Promise<{ contacts: PublicContact[]; methods: string[] }> {
  const methods = new Set<string>();
  const contacts = new Map<string, PublicContact>();
  let home: ReadResult;
  try {
    home = await readUrl(website, fetchImpl, jinaFallback, signal);
  } catch {
    return { contacts: [], methods: [] };
  }
  methods.add(home.method);
  for (const contact of extractPublicEmails(home.text, website, website)) contacts.set(contact.email, contact);
  const pages = contactPageUrls(home.text, website);
  for (const page of pages) {
    if (signal?.aborted) break;
    if (contacts.size >= 3) break;
    try {
      const read = await readUrl(page, fetchImpl, jinaFallback, signal);
      methods.add(read.method);
      for (const contact of extractPublicEmails(read.text, page, website)) contacts.set(contact.email, contact);
    } catch {
      // A guessed contact path failing is expected; continue with the pages that exist.
    }
  }
  return { contacts: [...contacts.values()].slice(0, 3), methods: [...methods] };
}

export async function collectNativeSignals(options: NativeCollectorOptions = {}): Promise<CollectedNativeSignal[]> {
  const signal = options.signal ?? AbortSignal.timeout(90_000);
  const feeds = options.feeds?.length ? options.feeds : [...DEFAULT_NATIVE_FEEDS];
  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
  const since = options.since ?? new Date(Date.now() - 7 * 86_400_000);
  const jinaFallback = options.jinaFallback ?? false;
  const items: NativeFeedItem[] = [...(options.items ?? [])];
  for (const feed of options.items ? [] : feeds) {
    if (signal.aborted) break;
    options.onProgress?.(`Reading feed ${feed}`);
    try {
      const read = await readUrl(feed, fetchImpl, false, signal);
      items.push(...parseNativeFeed(read.text, feed));
    } catch (error) {
      options.onProgress?.(`Skipped ${feed}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const candidates = items
    .filter(isFundingItem)
    .filter((item) => matchesNativeQuery(item, options.query ?? ""))
    .filter((item) => !item.publishedAt || new Date(item.publishedAt) >= since)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.url === item.url) === index)
    .slice(0, limit * 3);
  const collected: CollectedNativeSignal[] = [];
  for (const item of candidates) {
    if (signal.aborted) {
      options.onProgress?.("Skipped remaining sources: the 90-second collection budget was reached. Retry for more results.");
      break;
    }
    if (collected.length >= limit) break;
    options.onProgress?.(`Inspecting ${item.title}`);
    let article: ReadResult;
    try {
      article = await readUrl(item.url, fetchImpl, jinaFallback, signal);
    } catch (error) {
      options.onProgress?.(`Skipped article: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const company = companyNameFromHeadline(item.title);
    if (!company) {
      options.onProgress?.("Skipped article: headline does not identify a company");
      continue;
    }
    const website = discoverCompanyWebsite(article.text, item.url, company);
    // Never attach a stage from a different paragraph (or an earlier round) to the headline amount.
    const facts = fundingFacts(item.title);
    if (!facts.amountAsWritten && !facts.stageAsWritten) {
      options.onProgress?.("Skipped article: no funding amount or stage was found");
      continue;
    }
    const contactResult = website ? await collectContacts(website, fetchImpl, jinaFallback, signal) : { contacts: [], methods: [] };
    const methods = [...new Set([article.method, ...contactResult.methods])];
    collected.push({
      companyWebsite: website,
      contacts: contactResult.contacts,
      amountAsWritten: facts.amountAsWritten,
      stageAsWritten: facts.stageAsWritten,
      fetchMethods: methods,
      input: {
        channel: "native-web",
        url: item.url,
        title: item.title,
        summary: item.summary,
        company,
        author: item.author,
        published_at: item.publishedAt,
        confidence: contactResult.contacts.length ? 0.82 : website ? 0.7 : 0.52,
        tags: ["funding", ...(contactResult.contacts.length ? ["public-contact"] : [])],
        metadata: {
          collector: "signalround-native-v1",
          source_feed: item.feedUrl,
          company_website: website,
          public_contacts: contactResult.contacts,
          funding: { amount_as_written: facts.amountAsWritten, stage_as_written: facts.stageAsWritten },
          fetch_methods: methods,
        },
      },
    });
  }
  return collected;
}

export function matchesNativeQuery(item: Pick<NativeFeedItem, "title" | "summary">, query: string): boolean {
  const words =
    query
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter(
        (word) => !["startup", "startups", "funding", "raised", "raises", "round", "rounds", "find", "recent", "latest"].includes(word),
      ) ?? [];
  const text = `${item.title} ${item.summary ?? ""}`.toLowerCase();
  return words.every((word) => new RegExp(`\\b${word}\\b`).test(text));
}
