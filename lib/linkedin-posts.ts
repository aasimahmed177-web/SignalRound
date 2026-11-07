// Recent LinkedIn posts that announce a marketing opening and publish an email to apply to. Logged out only:
// discovery through Exa's free hosted search, then each public post page (HTTP 200 without a session) is read
// for its JSON-LD text. Emails are kept only when they appear verbatim in the decoded post text.

import { readPublicText } from "@fireround/core/web/transport";
import { load } from "cheerio";
import type { ReadText } from "./job-boards.ts";
import type { JobInput } from "./jobs.ts";

export const SOURCE = "linkedin-post";
const EXA_MCP = "https://mcp.exa.ai/mcp";
const DAY_MS = 86_400_000;

export interface LinkedInPost {
  post_url: string;
  posted_at: string;
  author: string;
  company: string | null;
  role: string;
  location: string | null;
  emails: string[];
  email_source_quote: string;
  is_marketing_role: true;
  post_text: string;
}

/** LinkedIn activity ids carry their creation time: the top 41 bits are milliseconds since the epoch. */
export function activityId(url: string): string | null {
  return url.match(/activity[-:](\d{15,22})/)?.[1] ?? null;
}
export function activityDate(idOrUrl: string): Date | null {
  const id = /^\d+$/.test(idOrUrl) ? idOrUrl : activityId(idOrUrl);
  if (!id) return null;
  const date = new Date(Number(BigInt(id) >> 22n));
  return Number.isNaN(date.getTime()) ? null : date;
}

const EMAIL = /(?<![\w.%+-])[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?![\w-])/gi;
const NOT_EMAIL = /\.(?:png|jpe?g|gif|webp|svg)$/i;

const GLUE = "using|contact|call|phone|mobile|mob|tel|cell|whatsapp|with|subject|apply|website|visit";
const GLUED = new RegExp(`^(?:${GLUE}|or|and|for|to)`, "i");

/**
 * True when `email` is written in `text` as a whole address: the next character is not part of an
 * address, or it starts a known glued word ("hr@x.comusing"). A prefix of a longer address
 * ("hr@brand.com" inside "hr@brand.community") is not posted verbatim.
 */
export function postedVerbatim(text: string, email: string): boolean {
  const lower = text.normalize("NFKC").toLowerCase();
  const needle = email.toLowerCase();
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
    const before = lower[at - 1] ?? "";
    const after = lower.slice(at + needle.length);
    // A longer local part ("xhr@…") or a longer domain ("…com.au") is a different address.
    if (/[\w.%+-]/.test(before) || /^\.[a-z0-9]/.test(after)) continue;
    if (!/^[a-z0-9-]/.test(after) || GLUED.test(after)) return true;
  }
  return false;
}

/** Emails written in the post text itself. The text must already be decoded (JSON-LD, not raw HTML). */
export function extractEmails(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.normalize("NFKC").matchAll(EMAIL)) {
    // "Quillhr@gmail.comusing the subject…": a common TLD run into a known next word is cut back to the TLD.
    // Only known glue words are cut, so real TLDs (.company, .community, .network, .organic) stay whole.
    const email = match[0]
      .replace(/\.+$/, "")
      .toLowerCase()
      .replace(new RegExp(`\\.(com|net|org)(?:${GLUE}|or|and|for|to)[a-z]*$`), ".$1")
      .replace(new RegExp(`\\.(in|co|ae|pk|uk|sg|my|ph|ng|za)(?:${GLUE})[a-z]*$`), ".$1");
    if (!NOT_EMAIL.test(email)) found.add(email);
  }
  return [...found];
}

/** The line or sentence of the post that carries the email, as written. */
export function emailQuote(text: string, email: string): string | null {
  const lower = email.toLowerCase();
  for (const line of text.normalize("NFKC").split(/\n+/)) {
    if (!line.toLowerCase().includes(lower)) continue;
    const sentence = line.split(/(?<=[.!?])\s+(?=[A-Z📩📧✉👉])/u).find((part) => part.toLowerCase().includes(lower));
    return (sentence ?? line).trim();
  }
  return null;
}

const HIRING =
  /\b(?:we(?:'|’)?re hiring|we are hiring|now hiring|i(?:'|’)?m hiring|is hiring|hiring(?: for| now|:|!| alert| an?\b)|#hiring|job (?:opening|opportunity|vacancy|alert)|vacanc(?:y|ies)|opening for|looking (?:to hire|for)|seeking|(?:to )?find an? |join (?:our|the) team|apply now|send (?:your |us your )?(?:cv|resume)|share (?:your )?(?:cv|resume)|(?:cv|resume)s? (?:to|at)\b)/i;
const SEEKING_WORK =
  /\b(?:open to work|#opentowork|i am (?:actively )?(?:looking|seeking) for (?:a |an )?(?:new )?(?:job|role|position|opportunit)|seeking (?:new )?(?:job )?opportunities)\b/i;

const FIELD = String.raw`(?:marketing|marketer|seo|sem|ppc|social media|content|growth|brand(?:ing)?|copywrit\w*|cmo|media buy\w*|paid (?:media|ads|social)|performance|influencer|community manager|digital)`;
const TITLE = String.raw`(?:executive|manager|specialist|intern(?:ship)?|lead|head|strategist|associate|analyst|coordinator|writer|marketer|officer|director|consultant|trainee|creator|expert|handler|buyer|vp|cmo|copywriter|partner)`;
const ROLE_WORD = new RegExp(String.raw`\b${TITLE}s?\b`, "i");
// The field word must name the job, not just appear: "digital" alone (Digital Product Designer) is not marketing.
const MARKETING_CORE =
  /\b(?:marketing|marketer|seo|sem|ppc|social media|content|growth|brand(?:ing)?|copywrit\w*|cmo|media buy\w*|paid (?:media|ads|social)|influencer|community manager)\b/i;
const NOT_MARKETING = /\b(?:engineer\w*|developer|data scien\w*|designer|sales|business development|accountant|styling|cloud)\b/i;
const MARKETING_ROLE = new RegExp(
  String.raw`\b((?:(?:senior|sr\.?|junior|jr\.?|lead|associate|assistant|trainee|deputy|chief|head of|vp(?: of)?|director(?: of)?)\s+)?(?:[\w&/-]+\s+){0,2}?${FIELD}(?:\s+[\w&/-]+){0,2}?\s+${TITLE}s?)\b`,
  "i",
);

function clean(value: string | undefined | null, max = 120): string | null {
  const text = value
    ?.normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s&/(),.'’+:–—-]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:–—,.-]+|[\s:.,;!–—-]+$/g, "")
    .trim();
  return text ? text.slice(0, max) : null;
}

const withoutHashtags = (text: string) => text.replace(/#[\p{L}\p{N}_]+/gu, " ");
const label = (text: string, names: string) =>
  text.match(new RegExp(String.raw`(?:^|\n)[^\n\p{L}]*(?:${names})\s*[:\-–—]\s*([^\n]+)`, "iu"))?.[1];
const isRole = (value: string | null | undefined): value is string =>
  !!value && value.length <= 90 && MARKETING_CORE.test(value) && ROLE_WORD.test(value) && !NOT_MARKETING.test(value);
// A role starts at its first level, field, or title word: "a results-driven PPC Executive" → "PPC Executive".
const ROLE_START = new RegExp(
  String.raw`^.*?(?=\b(?:senior|sr\b|junior|jr\b|lead|associate|assistant|trainee|deputy|chief|head|vp\b|director|manager|executive|ai\b|b2b|e-?commerce|product|email|event|trade|field|regional|global|${FIELD.slice(3, -1)}))`,
  "i",
);
const AGENCY_PITCH =
  /\b(?:partner with an?\b|looking for an? [^.\n]{0,40}agency|calling all [^.\n]{0,40}agencies|request for proposals?|\brfp\b)/i;

function tidyRole(raw: string | undefined): string | null {
  const head = clean(raw?.split(/\s[|•·]\s|[(]/)[0])?.split(/\s+(?:to|who|at|in|for|with|that|based|across)\s+/i)[0] ?? "";
  let role = "";
  for (const part of head.split(/\s+[–—-]\s*|\s*[–—-]\s+/)) {
    if (isRole(role)) break;
    role = role ? `${role} – ${part}` : part;
  }
  role = role.replace(ROLE_START, "").replace(/[\s,&/–—-]+$/, "");
  return isRole(role) ? role : null;
}

/** The marketing role a hiring post is for, or null when the post is not a marketing opening. */
export function marketingRole(text: string): string | null {
  const body = withoutHashtags(text.normalize("NFKC"));
  if (!HIRING.test(text) || SEEKING_WORK.test(body) || AGENCY_PITCH.test(body)) return null;
  const labelled = tidyRole(label(body, "position|role|job title|designation|opening|vacancy|post|job"));
  if (labelled) return labelled;
  const lines = body.split("\n");
  for (const line of lines) {
    const after = line.match(
      /(?:hiring|looking (?:to hire|for)|seeking|to find|opportunity for|join (?:us|our team) as)\s*(?:[:|!–—-]\s*|for\s+)?([^\n.!?]+)/i,
    )?.[1];
    const role = tidyRole(after?.split(",")[0]);
    if (role) return role;
  }
  for (const line of lines) {
    const role = line.length <= 90 ? tidyRole(line) : null;
    if (role) return role;
  }
  return tidyRole(body.match(MARKETING_ROLE)?.[1]);
}
export const isMarketingRole = (text: string) => marketingRole(text) !== null;

const FREE_MAIL = /@(?:gmail|googlemail|yahoo|ymail|hotmail|outlook|live|icloud|me|aol|proton(?:mail)?|zoho|rediffmail|gmx|yandex|mail)\./i;
const NAME = String.raw`((?:[A-Z0-9][\w&.'’-]*)(?:[ \t]+(?:[A-Z0-9][\w&.'’-]*|&|of)){0,4})`;
const asCompany = (value: string | undefined) => {
  const name = clean(value, 80);
  return name && !MARKETING_CORE.test(name) && !ROLE_WORD.test(name) && !/^(?:we|we're|i|i'm|our team|team|us)$/i.test(name) ? name : null;
};

export function postCompany(text: string, emails: string[], author?: { name: string; isOrg: boolean }): string | null {
  const body = withoutHashtags(text.normalize("NFKC"));
  const labelled = asCompany(label(body, "company(?: name)?|organi[sz]ation|employer|client|brand"));
  if (labelled) return labelled;
  const named = asCompany(
    body.match(
      new RegExp(
        String.raw`(?:^|[\n.!|]\s*|\s)${NAME}[ \t]+(?:is|are)[ \t]+(?:now[ \t]+)?(?:hiring|looking|seeking|inviting|expanding|growing)\b`,
      ),
    )?.[1],
  );
  if (named) return named;
  const hiringLines = body.split("\n").filter((line) => HIRING.test(line) || /\b(?:join|open(?:ings?)?)\b/i.test(line));
  const at = asCompany(hiringLines.join("\n").match(new RegExp(String.raw`\b(?:at|join(?:ing)?|team at)[ \t]+${NAME}`))?.[1]);
  if (at) return at;
  if (author?.isOrg && author.name) return author.name;
  const domain = emails.find((email) => !FREE_MAIL.test(email))?.split("@")[1];
  return domain ? (companyFromDomain(body, domain) ?? domain) : null;
}

/** The name the post gives the email's company: "hudmas.com" → "Hudmas Ventures", "majorplayers.co.uk" → "Major Players". */
export function companyFromDomain(text: string, domain: string): string | null {
  const stem = domain
    .toLowerCase()
    .replace(/^(?:www|mail|careers|jobs|hr)\./, "")
    .split(".")[0]
    ?.replace(/[^a-z0-9]/g, "");
  if (!stem || stem.length < 3) return null;
  const squash = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const words = [...text.normalize("NFKC").matchAll(/[\p{L}\p{N}][\p{L}\p{N}&'’.-]*/gu)].map((match) => match[0].replace(/[.'’]+$/, ""));
  for (let start = 0; start < words.length; start++) {
    let joined = "";
    for (let end = start; end < Math.min(start + 4, words.length); end++) {
      joined += squash(words[end] ?? "");
      if (!stem.startsWith(joined)) break;
      if (joined !== stem) continue;
      // Take the name as written, plus a trailing capitalised word that belongs to it ("Hudmas Ventures").
      const next = words[end + 1];
      const tail =
        next &&
        /^\p{Lu}/u.test(next) &&
        /^(?:ventures|media|digital|group|labs?|technologies|solutions|studios?|agency|global|consulting|marketing|brands?|ltd|llc|inc|pvt)$/i.test(
          next,
        )
          ? [next]
          : [];
      const name = [...words.slice(start, end + 1), ...tail].join(" ");
      if (/^\p{Lu}|^\p{N}/u.test(name)) return name;
    }
  }
  return null;
}

export function postLocation(text: string): string | null {
  const body = text.normalize("NFKC");
  const raw =
    label(body, "location|job location|work location|based in|city") ?? body.match(/📍\s*(?:location\s*[:\-–]\s*)?([^\n]+)/iu)?.[1];
  const named = clean(raw?.split(/\s[|•·]\s|\s{2,}|[💼🕒⏰💰🏢🎓]/u)[0], 100);
  if (named) return named;
  // No location line: "based in Dubai", "our office in Gurugram", or a remote role.
  const place = withoutHashtags(body).match(
    /\b(?:based (?:in|out of)|located in|office in|onsite in|on-site in|hybrid in|work from (?:our )?office in|position in|role in)\s+(\p{Lu}[\p{L}-]+(?:,?\s+\p{Lu}[\p{L}-]+){0,2})/u,
  )?.[1];
  if (place) return clean(place, 100);
  return /\b(?:fully remote|remote(?: role| position| job| opportunity)?\b|work from home|wfh)\b/i.test(body) ? "Remote" : null;
}

interface PageData {
  text: string;
  author: string;
  isOrg: boolean;
  datePublished: string | null;
}

/** Post text, author, and date from a public post page. JSON-LD first (its strings are properly decoded). */
export function parsePostPage(html: string): PageData | null {
  const $ = load(html);
  for (const node of $('script[type="application/ld+json"]').toArray()) {
    let data: unknown;
    try {
      data = JSON.parse($(node).text());
    } catch {
      continue;
    }
    const items = Array.isArray(data) ? data : [data];
    for (const item of items as Array<Record<string, unknown>>) {
      if (!item || !/Posting|Article/.test(String(item["@type"])) || typeof item.articleBody !== "string") continue;
      const author = (item.author ?? {}) as Record<string, unknown>;
      return {
        text: item.articleBody,
        author: String(author.name ?? "")
          .replace(/\s+/g, " ")
          .trim(),
        isOrg: author["@type"] === "Organization",
        datePublished: typeof item.datePublished === "string" ? item.datePublished : null,
      };
    }
  }
  const commentary = $('[data-test-id="main-feed-activity-card__commentary"]').first();
  if (!commentary.length) return null;
  commentary.find("br").replaceWith("\n");
  return {
    text: commentary.text(),
    author: $('[data-tracking-control-name="public_post_feed-actor-name"]').first().text().trim(),
    isOrg: false,
    datePublished: null,
  };
}

/** One post page → a verified record, or the reason it was dropped. */
export function toPost(url: string, html: string, since: Date): LinkedInPost | string {
  const posted = activityDate(url);
  if (!posted) return "no activity id";
  if (posted < since) return "older than the window";
  const page = parsePostPage(html);
  if (!page?.text.trim()) return "no post text";
  const role = marketingRole(page.text);
  if (!role) return "not a marketing hiring post";
  const text = page.text.normalize("NFKC");
  const emails = extractEmails(text).filter((email) => postedVerbatim(text, email));
  if (!emails.length) return "no email in post text";
  const quote = emails.map((email) => emailQuote(text, email)).find(Boolean);
  if (!quote) return "email not quotable";
  return {
    post_url: url.replace(/[?#].*$/, ""),
    posted_at: posted.toISOString(),
    author: page.author || "Unknown",
    company: postCompany(text, emails, { name: page.author, isOrg: page.isOrg }),
    role,
    location: postLocation(text),
    emails,
    email_source_quote: quote,
    is_marketing_role: true,
    post_text: text.slice(0, 1_500),
  };
}

/** Same post (one activity id) or a repost of the same opening (same email and role): keep the earliest. */
export function dedupePosts(posts: LinkedInPost[]): LinkedInPost[] {
  const seen = new Set<string>();
  return [...posts]
    .sort((a, b) => a.posted_at.localeCompare(b.posted_at))
    .filter((post) => {
      const keys = [`id:${activityId(post.post_url)}`, ...post.emails.map((email) => `${email}|${post.role.toLowerCase()}`)];
      if (keys.some((key) => seen.has(key))) return false;
      for (const key of keys) seen.add(key);
      return true;
    })
    .sort((a, b) => b.posted_at.localeCompare(a.posted_at));
}

export function toJobInput(post: LinkedInPost): JobInput {
  return {
    source: SOURCE,
    external_id: activityId(post.post_url) ?? post.post_url,
    url: post.post_url,
    title: post.role,
    company: post.company ?? post.author,
    location: post.location,
    description: post.post_text,
    posted_at: post.posted_at,
    metadata: { author: post.author, public_emails: post.emails, email_source_quote: post.email_source_quote, post_text: post.post_text },
  };
}

const ROLES = [
  "digital marketing executive",
  "digital marketing manager",
  "performance marketing manager",
  "SEO executive",
  "SEO specialist",
  "social media manager",
  "social media executive",
  "content writer",
  "content marketing manager",
  "growth marketing manager",
  "brand manager",
  "marketing executive",
  "marketing manager",
  "marketing intern",
  "digital marketing intern",
  "media buyer",
  "PPC specialist",
  "influencer marketing executive",
  "email marketing specialist",
  "marketing coordinator",
  "head of marketing",
  "copywriter",
  "social media content creator",
];
const ASKS = ["send your CV to", "email your resume to", "share your resume at"];
const DAY_ASKS = ["send CV to", "share resume at", "apply by email", "DM or email your portfolio to"];

/**
 * Exa ranks old posts first unless the query names the date, so most queries name one day of the window (newest
 * first, rotating roles and asks across days) and the rest name the window's month(s).
 */
export function searchQueries(now: Date, days: number): string[] {
  const month = (date: Date) => date.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const day = (date: Date) => date.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const daily = Array.from({ length: days }, (_, d) => day(new Date(now.getTime() - d * DAY_MS))).flatMap((when, d) =>
    ROLES.filter((_, r) => (r + d) % 2 === 0).map(
      (role, r) => `LinkedIn post ${when}: hiring ${role}, ${DAY_ASKS[(r + d) % DAY_ASKS.length]} email`,
    ),
  );
  const months = [...new Set([month(new Date(now.getTime() - days * DAY_MS)), month(now)])].reverse();
  const monthly = months.flatMap((when, m) =>
    ROLES.flatMap((role, r) =>
      ASKS.filter((_, a) => (m === 0 ? (r + a) % 3 !== 2 : (r + a) % 3 === 0)).map(
        (ask) => `LinkedIn post ${when}: We're hiring ${role}, ${ask} email`,
      ),
    ),
  );
  return [...daily, ...monthly];
}

/** A response body as text, aborted once it passes `maxBytes` (an SSE stream that never ends is not buffered without bound). */
export async function readCapped(response: Response, maxBytes = 2_000_000): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response larger than ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export type SearchFn = (query: string, limit: number) => Promise<string[]>;

/** Exa's free hosted MCP (no key, no account): returns linkedin.com/posts URLs from the result text. */
export const exaSearch: SearchFn = async (query, limit) => {
  let response = await exaRequest(query, limit);
  let raw = await readCapped(response);
  // The free endpoint rate-limits bursts (HTTP 429 or a JSON-RPC error); back off before giving up on a query.
  for (let attempt = 1; (response.status === 429 || /rate limit/i.test(raw)) && attempt <= 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
    response = await exaRequest(query, limit);
    raw = await readCapped(response);
  }
  if (!response.ok) throw new Error(`Exa HTTP ${response.status}`);
  const payload =
    raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .at(-1)
      ?.slice(5) ?? raw;
  const message = JSON.parse(payload) as { error?: { message?: string }; result?: { content?: Array<{ text?: string }> } };
  if (message.error) throw new Error(`Exa: ${message.error.message?.split("\n")[0]}`);
  const text = (message.result?.content ?? []).map((part) => part.text ?? "").join("\n");
  return [...new Set(text.match(/https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/posts\/[^\s)"'<>]*activity-\d+[^\s)"'<>]*/g) ?? [])];
};

const exaRequest = (query: string, limit: number) =>
  fetch(EXA_MCP, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "SignalRound/0.2",
      // Optional: the operator's own Exa key lifts the shared free-tier rate limit.
      ...(process.env.EXA_API_KEY ? { authorization: `Bearer ${process.env.EXA_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query,
          numResults: limit,
          objective: `${query}. Recent LinkedIn posts announcing a marketing job with an email to apply.`,
        },
      },
    }),
  });

const defaultRead: ReadText = (url, options) => readPublicText(url, { timeoutMs: options?.timeoutMs ?? 20_000, maxBytes: 3_000_000 });

export async function pool<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++) out[index] = await run(items[index] as T);
    }),
  );
  return out;
}

export interface CollectOptions {
  days: number;
  now?: Date;
  limit?: number;
  queries?: string[];
  /** Known post URLs to re-verify instead of searching. */
  urls?: string[];
  /** Known post URLs to re-verify in addition to searching. */
  seeds?: string[];
  search?: SearchFn;
  read?: ReadText;
  log?: (message: string) => void;
}

export async function collectLinkedInPosts(options: CollectOptions): Promise<{ posts: LinkedInPost[]; stats: Record<string, number> }> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - options.days * DAY_MS);
  const search = options.search ?? exaSearch;
  const read = options.read ?? defaultRead;
  const log = options.log ?? (() => {});
  const queries = options.queries ?? searchQueries(now, options.days);
  let found = 0;
  let failed = 0;
  const byId = new Map<string, string>();
  for (const url of [...(options.urls ?? []), ...(options.seeds ?? [])]) {
    const id = activityId(url);
    const date = id ? activityDate(id) : null;
    if (id && date && date >= since && !byId.has(id)) byId.set(id, url);
  }
  let failingInARow = 0;
  let skipped = 0;
  await pool(options.urls ? [] : queries, 2, async (query) => {
    // A search that keeps failing (rate limit, outage) is given up on instead of retried for every query.
    if (failingInARow >= 6) {
      skipped += 1;
      return;
    }
    try {
      const urls = await search(query, options.limit ?? 50);
      failingInARow = 0;
      found += urls.length;
      for (const url of urls) {
        const id = activityId(url);
        const date = id ? activityDate(id) : null;
        if (id && date && date >= since && date <= new Date(now.getTime() + DAY_MS) && !byId.has(id)) byId.set(id, url);
      }
    } catch (error) {
      failed += 1;
      failingInARow += 1;
      log(`search failed: ${query} (${(error as Error).message})`);
    }
  });
  const stats: Record<string, number> = {
    queries: options.urls ? 0 : queries.length,
    search_failed: failed + skipped,
    found,
    recent: byId.size,
  };
  log(`${found} post links from ${stats.queries} searches; ${byId.size} unique posts in the last ${options.days} days`);
  const results = await pool([...byId.values()], 3, async (url) => {
    try {
      const page = await read(url);
      return /\/(?:signup|authwall|login)/.test(page.url) ? "login wall" : toPost(url, page.text, since);
    } catch (error) {
      return `fetch failed (${(error as Error).message})`;
    }
  });
  const posts: LinkedInPost[] = [];
  for (const result of results) {
    if (typeof result === "string") stats[result] = (stats[result] ?? 0) + 1;
    else posts.push(result);
  }
  const kept = dedupePosts(posts);
  stats.duplicates = posts.length - kept.length;
  stats.kept = kept.length;
  return { posts: kept, stats };
}
