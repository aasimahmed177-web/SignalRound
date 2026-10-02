// The Trending layer's rules: how an X search result is read (dated by its status id, attributed
// to an author, judged relevant to one round), which accounts are outlets rather than people, how
// X, the press, and Hacker News combine into one decayed score, when a round's date looks stale,
// and which rounds earn the Trending label. Pure, so every rule is tested without the network.
// The thresholds come from a spike over 18 production rounds (2026-09-23): about 95 percent of the
// results this relevance rule keeps are about the round.

import { normalizeCompanyKey } from "../records/keys.ts";

/** X's snowflake epoch: a status id's top bits are milliseconds since 2010-11-04T01:42:54.657Z. */
const TWITTER_EPOCH_MS = 1288834974657n;

/**
 * When a post was written, read off its status id. Search engines date X results loosely (a week
 * old post can carry today's date), so the id is the only honest clock a result carries.
 */
export function snowflakeTime(id: string): Date | null {
  if (!/^\d{6,20}$/.test(id)) return null;
  const ms = Number((BigInt(id) >> 22n) + TWITTER_EPOCH_MS);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Words that say a post is about money raised: a verb, a round word, or a currency figure. */
export const FUNDING_WORDS =
  /\b(rais(e|es|ed|ing)|funding|fundraise|series [a-f]\b|seed|round|backed|led by|valuation|invest(s|ed|ment|ors?)?)\b|[$€£₹]\s?\d|\brs\.? ?\d/i;

/** Path segments on x.com that are not an account. */
const NOT_ACCOUNTS = new Set(["i", "search", "hashtag", "intent", "share", "home", "explore", "settings", "messages", "notifications"]);

export interface XResult {
  kind: "post" | "profile";
  /** The status id for a post; null for a profile page. */
  statusId: string | null;
  /** Lowercased handle, null when the URL names none (an `/i/` page). */
  handle: string | null;
  /** The display name as the result's title writes it ("Firecrawl on X: ..." is "Firecrawl"). */
  name: string | null;
  url: string;
  /** Title and description together: what the relevance rule reads. */
  text: string;
  /** The post's words as a reader sees them: the description without the "1 day ago ·" and repost chrome. */
  snippet: string;
  /** From the status id for a post; from "N hours ago" in the snippet for a profile page, when it says. */
  postedAt: Date | null;
}

/**
 * The display name at the front of an X result, in the shapes search returns: "Name (@handle)",
 * "Name on X", "Name - X", "Name - @handle", a description opening "Name on X:", or a title that
 * is only the name. A title that reads as a sentence fragment ("housing, jobs, research ...") is not one.
 */
export function displayNameFromTitle(title: string | undefined | null, description?: string | null): string | null {
  const t = (title ?? "").replace(/^(Highlights|Replies|Reposts|Posts) by /i, "").trim();
  const m =
    /^(.+?)\s+\(@[A-Za-z0-9_]{1,15}\)/.exec(t) ??
    /^(.+?)\s+on X\b/.exec(t) ??
    /^(.+?)\s+[-|]\s+(X\b|@[A-Za-z0-9_]{1,15})/.exec(t) ??
    /^(.+?)\s+\/\s+X\b/.exec(t) ??
    /^([^"“:]{1,60}?)\s+on X:/.exec(description ?? "");
  const name = m?.[1]?.trim() ?? (t && t.length <= 40 && !/[,:"“…]|\.\.\.|\s-\s/.test(t) && t.split(/\s+/).length <= 4 ? t : null);
  return name && name.length <= 80 ? name : null;
}

/** "3 hours ago", "1 day ago" in a snippet, as an instant before `searchedAt`. */
export function agoTime(text: string, searchedAt: Date): Date | null {
  const m = /(\d+)\s+(minute|hour|day)s?\s+ago/i.exec(text);
  if (!m) return null;
  const unit = { minute: 60_000, hour: 3_600_000, day: 86_400_000 }[m[2].toLowerCase() as "minute" | "hour" | "day"];
  return new Date(searchedAt.getTime() - Number(m[1]) * unit);
}

/** Longest snippet kept: a post's own limit, so a stored snippet never outgrows what it quotes. */
export const SNIPPET_MAX = 280;

/**
 * What a search result says the post says. Search descriptions open with the result's age ("1 day
 * ago ·") and, for a repost or a reply, the quoted account's chrome ("@firecrawl · Firecrawl ·
 * @firecrawl · 8h."); both go, and the title's quoted words stand in when there is no description.
 */
export function cleanSnippet(title: string | undefined | null, description: string | undefined | null): string {
  let s = (description ?? "").replace(/\s+/g, " ").trim();
  // Some descriptions are an X scrape's markdown: "# Post by @acme ## Post ...", "## Latest Posts ### 2. Post ...".
  s = s
    .replace(/^#\s*[^#]{0,80}?##\s*(Latest Posts\s*###\s*\d+\.\s*)?Post\s*/i, "")
    .replace(/(^|\s)#{1,6}\s+\d+\.\s*Post\s+/g, " ")
    .trim();
  s = s.replace(/^\d+\s+(second|minute|hour|day|week|month)s?\s+ago\s*·\s*/i, "");
  s = s.replace(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})?\s*·\s*/, "");
  s = s.replace(/^[^"“]{1,60}? on X:\s*["“]/, "");
  const when = String.raw`(\d+[smhd]|now|[A-Z][a-z]{2} \d{1,2})`;
  s = s.replace(new RegExp(String.raw`^(@\w{1,15}\s*·\s*)?[^·@]{1,60}·\s*@\w{1,15}\s*·\s*${when}\.?\s*`, "i"), "");
  s = s.replace(new RegExp(String.raw`^@\w{1,15}\s*·\s*${when}\.\s*`, "i"), "");
  if (!s) {
    const quoted = /on X:\s*"(.+?)"?\s*(\/\s*X)?$/.exec(title ?? "")?.[1];
    s = (quoted ?? title ?? "").trim();
  }
  return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : s;
}

/** One search result on x.com or twitter.com read into a post or a profile hit; anything else is null. */
export function parseXResult(r: { url: string; title?: string; description?: string }, searchedAt: Date): XResult | null {
  let u: URL;
  try {
    u = new URL(r.url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|mobile)\./, "");
  if (host !== "x.com" && host !== "twitter.com") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const text = `${r.title ?? ""} ${r.description ?? ""}`.replace(/\s+/g, " ").trim();
  const snippet = cleanSnippet(r.title, r.description);
  const name = displayNameFromTitle(r.title, r.description);
  const first = parts[0]?.toLowerCase() ?? null;
  const handle = first && !NOT_ACCOUNTS.has(first) && /^[a-z0-9_]{1,15}$/.test(first) ? first : null;
  const si = parts.indexOf("status");
  const id = si >= 0 ? parts[si + 1] : undefined;
  if (id && /^\d+$/.test(id)) {
    return {
      kind: "post",
      statusId: id,
      handle,
      name,
      url: `https://x.com/${handle ?? "i/web"}/status/${id}`,
      text,
      snippet,
      postedAt: snowflakeTime(id),
    };
  }
  if (!handle) return null;
  return {
    kind: "profile",
    statusId: null,
    handle,
    name,
    url: `https://x.com/${parts[0]}`,
    text,
    snippet,
    postedAt: agoTime(text, searchedAt),
  };
}

/** What the relevance rule knows about a round. */
export interface RoundSubject {
  name: string;
  /** Other spellings a post may use: the name without a generic tail ("Snorkel" for "Snorkel AI"). */
  aliases: string[];
  /** The company's own X handle, lowercased, when known and verified. */
  handle: string | null;
  /** The amount as posts write it: "$75M", "$75 million", "75M", or the currency as written. */
  amounts: string[];
  /** YYYY-MM-DD: the announced day, or the first-seen day for an undated row. */
  announced: string;
  /** What tells this company from a namesake, for a one-word name (identityHit): its domain, leads, and description. */
  domain?: string | null;
  leadInvestors?: readonly string[];
  description?: string | null;
}

/** Tail words a post often drops from a name ("Heidi" for "Heidi Health"); the rest must still be five letters or more. */
const ALIAS_TAIL = /\s+(ai|inc|labs|technologies|technology|health|hq|app|io|automotive|group|holdings|corp|co)$/i;

export function nameAliases(name: string): string[] {
  const out = new Set<string>();
  let n = name.trim();
  for (;;) {
    const next = n.replace(ALIAS_TAIL, "").trim();
    if (next === n) break;
    n = next;
    if (n.replace(/[^a-z0-9]/gi, "").length >= 5) out.add(n);
  }
  return [...out].filter((a) => a.toLowerCase() !== name.toLowerCase());
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", INR: "₹" };

/**
 * The amount the way posts write it. The first token is the one the amount query searches; the
 * rest only widen the relevance match. A figure over a billion reads in billions ("$3.9B").
 */
export function amountTokens(amount: {
  asWritten: string | null;
  value: number | null;
  currency: string | null;
  usdMillions: number | null;
}): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const t = s.trim();
    if (t && !out.includes(t)) out.push(t);
  };
  const figure = (sym: string, millions: number) => {
    if (millions >= 1000) {
      const b = trimNumber(millions / 1000);
      add(`${sym}${b}B`);
      add(`${sym}${b} billion`);
      add(`${b}B`);
    } else {
      const m = trimNumber(millions);
      add(`${sym}${m}M`);
      add(`${sym}${m} million`);
      add(`${m}M`);
    }
  };
  const cur = amount.currency?.toUpperCase() ?? null;
  const sym = cur ? SYMBOLS[cur] : undefined;
  if (cur && cur !== "USD" && sym && amount.value !== null && amount.value > 0) figure(sym, amount.value);
  if (amount.usdMillions !== null && amount.usdMillions > 0) figure("$", amount.usdMillions);
  if (amount.asWritten && amount.asWritten.length <= 40) add(amount.asWritten);
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive: "Ema" matches "Ema raises", never "email". */
export function mentions(text: string, name: string): boolean {
  if (!name.trim()) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(name.toLowerCase())}([^a-z0-9]|$)`).test(text.toLowerCase());
}

/** The span a post must fall in to count: a day before the announcement to four days after. */
export function searchWindow(announced: string): { start: Date; end: Date } {
  const start = new Date(`${announced}T00:00:00Z`).getTime() - 86_400_000;
  return { start: new Date(start), end: new Date(start + 5 * 86_400_000) };
}

export interface Classified {
  nameHit: boolean;
  amountHit: boolean;
  fund: boolean;
  /** Posts only: inside the search window by its status-id time. Null for a profile page. */
  inWindow: boolean | null;
  /** Written by the company's own account. */
  self: boolean;
  /**
   * The relevance rule: the name as a whole word (or the company's handle), a funding word or the
   * amount, and for a post, a status-id time inside the window. A profile page counts on the first
   * two: the page shows that account's post or repost about the round.
   */
  relevant: boolean;
}

export function classifyX(r: XResult, s: RoundSubject): Classified {
  const text = r.text;
  const nameHit = [s.name, ...s.aliases].some((n) => mentions(text, n)) || (!!s.handle && text.toLowerCase().includes(`@${s.handle}`));
  const lower = text.toLowerCase();
  const amountHit = s.amounts.some((a) => lower.includes(a.toLowerCase()));
  const fund = FUNDING_WORDS.test(text);
  const w = searchWindow(s.announced);
  const inWindow = r.kind === "post" ? !!r.postedAt && r.postedAt >= w.start && r.postedAt < w.end : null;
  const self = !!s.handle && r.handle === s.handle;
  // A distinctive name counts with the round where it is named, or with the round's own figure and a
  // funding word anywhere in the post. A one-word name ("Millie", "Mika", "Treble") is as often a
  // word or a person, so it needs the round where it is named and a sign that it means this company.
  const about = self
    ? fund || amountHit
    : isOneWordName(s.name)
      ? fundingContext(text, s) &&
        // The figure close to the name in the post's own words (not a display name that happens to
        // share it: "Millie Meeta" posting about another company's $12M seed) says this company.
        (amountNearName(r.snippet, s, 10) ||
          raiseAfterName(r.snippet, s) ||
          identityHit({ handle: r.handle, authorName: r.name, snippet: text }, subjectIdentity(s)))
      : fundingContext(text, s) || (amountHit && fund);
  const relevant = nameHit && (r.kind === "profile" || inWindow === true) && about;
  return { nameHit, amountHit, fund, inWindow, self, relevant };
}

/** Words a post uses for a round that are not also everyday words: "raised" and "round" are left to the verb and amount rules. */
const FUNDING_PHRASE =
  /\b(series [a-f]\b|seed (round|funding|stage)|pre-?seed|funding|fundrais\w*|valuation|led by|co-led|investment from|backed by|financing|unicorn|backs|backing|invest(?:s|ed|ing|ment)? in|(the|this|their|its|your) raise)\b/i;

/** Words between two places in a text, counting whitespace runs. */
function wordsBetween(text: string, from: number, to: number): number {
  const [a, b] = from < to ? [from, to] : [to, from];
  return (text.slice(a, b).match(/\s+/g) ?? []).length;
}

type Named = Pick<RoundSubject, "name" | "aliases" | "handle" | "amounts">;

/** The name's spellings in a post (the name, its aliases, the @handle), lowercased. */
function nameForms(s: Named): string[] {
  return [s.name, ...s.aliases, ...(s.handle ? [`@${s.handle}`] : [])].map((n) => n.toLowerCase()).filter(Boolean);
}

/** Where the name starts in a lowercased text, each whole-word occurrence of each spelling. */
function namePositions(lower: string, s: Named): number[] {
  const at: number[] = [];
  for (const n of nameForms(s)) {
    const re = new RegExp(`(^|[^a-z0-9])(${escapeRe(n)})(?=[^a-z0-9]|$)`, "g");
    for (const m of lower.matchAll(re)) at.push((m.index ?? 0) + m[1].length);
  }
  return at;
}

/** Whether a match of `re` sits within `words` words of a place the name is written. */
function nearName(lower: string, at: number[], re: RegExp, words: number): boolean {
  for (const m of lower.matchAll(re)) if (at.some((i) => wordsBetween(lower, i, m.index ?? 0) <= words)) return true;
  return false;
}

/** The round's figure within `words` words of the name: "Congratulations to Firecrawl on their $75M Series B". */
export function amountNearName(text: string, s: Named, words: number): boolean {
  const lower = text.toLowerCase();
  const at = namePositions(lower, s);
  return at.length > 0 && s.amounts.some((a) => a && nearName(lower, at, new RegExp(escapeRe(a.toLowerCase()), "g"), words));
}

/**
 * Whether a post talks about the round where it names the company, not merely beside it: the round's
 * figure within twelve words of the name, a funding phrase within ten ("Congrats to the Acme team on
 * the Series B"), or a raise verb straight after the name ("Millie just secured $12M"). A shared word
 * is not enough: "Millie's mum discovered a raised lymph node" names Millie and says "raised", and a
 * snippet that joins one post's "$12M Series A" to another's "Millie is the new standard in maternity
 * care" keeps the two twenty words apart.
 */
export function fundingContext(text: string, s: Named): boolean {
  const lower = text.toLowerCase();
  const at = namePositions(lower, s);
  if (at.length === 0) return false;
  if (amountNearName(text, s, 12)) return true;
  if (nearName(lower, at, new RegExp(FUNDING_PHRASE.source, "gi"), 10)) return true;
  return raiseAfterName(text, s);
}

/**
 * The raise verb straight after the name, or after an appositive between commas, the shape of a news
 * post: "Baselayer, an AI-powered startup that helps banks verify businesses, has raised $35M". The
 * company as the subject of the raise, which also tells a one-word name's company from a namesake.
 */
export function raiseAfterName(text: string, s: Named): boolean {
  const lower = text.toLowerCase();
  return nameForms(s).some(
    (n) =>
      new RegExp(String.raw`(^|[^a-z0-9])${escapeRe(n)}(\s+[^\s.:;!?|·]+){0,3}?\s+${RAISE_VERB}\b`).test(lower) ||
      new RegExp(String.raw`(^|[^a-z0-9])${escapeRe(n)},[^.!?]{0,160}?,\s+(?:has\s+|have\s+|just\s+|today\s+)?${RAISE_VERB}\b`).test(lower),
  );
}

/** The identity check's subject from what the relevance rule knows about a round. */
function subjectIdentity(s: RoundSubject): StaleSubject {
  return {
    name: s.name,
    handle: s.handle,
    domain: s.domain ?? null,
    leadInvestors: s.leadInvestors ?? [],
    description: s.description ?? null,
    amount: { value: null, currency: null },
  };
}

/** `cdr` custom range from a day before the announcement to four days after, as Firecrawl search takes it. */
export function xTbs(announced: string): string {
  const w = searchWindow(announced);
  const mdY = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  return `cdr:1,cd_min:${mdY(w.start)},cd_max:${mdY(new Date(w.end.getTime() - 86_400_000))}`;
}

export type XQueryKey = "name_fund" | "name_amount" | "handle_fund";

export interface XQuery {
  key: XQueryKey;
  q: string;
  tbs: string;
}

/**
 * The searches for one round: the name with funding words, the name with the amount (when one is
 * known), and the company's handle with funding words (when a verified handle is known).
 */
export function xQueries(s: RoundSubject, withHandle = true): XQuery[] {
  const tbs = xTbs(s.announced);
  const name = s.name.replace(/"/g, "");
  const out: XQuery[] = [{ key: "name_fund", q: `site:x.com "${name}" (raises OR raised OR funding OR round)`, tbs }];
  if (s.amounts[0]) out.push({ key: "name_amount", q: `site:x.com "${name}" "${s.amounts[0].replace(/"/g, "")}"`, tbs });
  if (withHandle && s.handle) out.push({ key: "handle_fund", q: `site:x.com "@${s.handle}" (raises OR raised OR funding OR round)`, tbs });
  return out;
}

/**
 * Handles that are news desks, aggregators, and deal bots rather than people talking about a
 * round. Read on the handle, where the spike measured it; display names get a stricter list
 * because a person's name can carry "Tech" or "Capital" in a bio-like suffix.
 */
export const OUTLET_HANDLE =
  /news|times|tech|pulse|saas|meme|wire|betterhn|daily|crunch|week|entrackr|moneycontrol|australian|hackernoon|traded|wallst|swipeline|finance|launch|prn_|siliconangle|geekwire|startup|funding|venture|capital|report|insider|inc42|yourstory|vcc|bpay|reuters|bloomberg|forbes|cnbc|axios|wsj|tldr|newsletter|press|media/i;
const OUTLET_NAME =
  /\b(news|daily|times|wire|report|insider|journal|magazine|media|digest|breaking|headlines|reuters|bloomberg|newsletter)\b/i;

/**
 * An outlet: the handle or display name reads as a publisher, or the account turned up on too many
 * different rounds to be talking about any one of them (`frequent`, computed over 30 days). An
 * account whose name is one of the round's own investors is never an outlet: a lead's
 * congratulations is part of the conversation, however its handle reads.
 */
export function isOutletAccount(
  handle: string | null,
  name: string | null,
  frequent: ReadonlySet<string>,
  investors: readonly string[] = [],
): boolean {
  if (name && investors.some((i) => sameName(name, i))) return false;
  if (handle && frequent.has(handle)) return true;
  if (handle && OUTLET_HANDLE.test(handle)) return true;
  return !!name && OUTLET_NAME.test(name);
}

/** Two display names for one entity: equal once case, punctuation, and corporate tails are gone. */
export function sameName(a: string, b: string): boolean {
  const ka = normalizeCompanyKey(a.replace(/\(.*?\)/g, ""));
  const kb = normalizeCompanyKey(b.replace(/\(.*?\)/g, ""));
  return !!ka && ka === kb;
}

/** Share of recent rounds an account must appear on to be an aggregator, and the floor under it. */
export const FREQUENT_ACCOUNT_SHARE = 0.05;
export const FREQUENT_ACCOUNT_MIN_ROUNDS = 3;

/** Accounts seen on at least 5 percent of the rounds searched (and never fewer than three rounds). */
export function frequentAccounts(roundsByHandle: ReadonlyMap<string, number>, roundsSearched: number): Set<string> {
  const floor = Math.max(FREQUENT_ACCOUNT_MIN_ROUNDS, Math.ceil(roundsSearched * FREQUENT_ACCOUNT_SHARE));
  return new Set([...roundsByHandle].filter(([, n]) => n >= floor).map(([h]) => h));
}

/** Each item's weight halves every day from its own timestamp; a future timestamp weighs one. */
export const HALF_LIFE_HOURS = 24;

export function decay(at: Date, now: Date, halfLifeHours = HALF_LIFE_HOURS): number {
  const hours = Math.max(0, (now.getTime() - at.getTime()) / 3_600_000);
  return 0.5 ** (hours / halfLifeHours);
}

export const SCORE_WEIGHTS = { x: 1, press: 0.75, hn: 0.5 } as const;

export interface ScoreInput {
  /** One entry per non-outlet X author: the time of that author's earliest relevant post. */
  people: Date[];
  /** One entry per press publisher host: when it first carried the round. */
  outlets: Date[];
  /** Matching Hacker News stories. */
  hn: Array<{ points: number; at: Date }>;
}

export interface Score {
  score: number;
  x: number;
  press: number;
  hn: number;
}

/**
 * 1 x ln(1 + decayed people on X) + 0.75 x ln(1 + decayed outlets) + 0.5 x ln(1 + decayed HN
 * points). The logs keep one loud signal from swamping the others; the decay keeps the last day
 * on top. Likes and reposts are not in it: in the spike they did not improve the order.
 */
export function trendingScore(input: ScoreInput, now: Date): Score {
  const x = input.people.reduce((n, t) => n + decay(t, now), 0);
  const press = input.outlets.reduce((n, t) => n + decay(t, now), 0);
  const hn = input.hn.reduce((n, s) => n + Math.max(0, s.points) * decay(s.at, now), 0);
  const score = SCORE_WEIGHTS.x * Math.log1p(x) + SCORE_WEIGHTS.press * Math.log1p(press) + SCORE_WEIGHTS.hn * Math.log1p(hn);
  return { score, x, press, hn };
}

export interface StaleVerdict {
  stale: boolean;
  /** For an admin: how many amount-matching posts predate the day, and the earliest of them. */
  reason: string | null;
}

/** Posts naming the company and the amount needed before the check says anything. */
export const STALE_MIN_POSTS = 3;
export const STALE_LEAD_DAYS = 3;

/**
 * A round whose announcement happened well before the day on record: more than half of the posts
 * naming the company and the amount predate that day by over three days. Such a round is left out
 * of Trending and flagged for re-dating; the date itself is not changed here. The rescore feeds it
 * `staleReadings`, which decides what "naming the company and the amount" means.
 */
export function staleCheck(posts: Array<{ nameHit: boolean; amountHit: boolean; postedAt: Date | null }>, announced: string): StaleVerdict {
  const dated = posts.filter((p) => p.nameHit && p.amountHit && p.postedAt);
  if (dated.length < STALE_MIN_POSTS) return { stale: false, reason: null };
  const cutoff = new Date(`${announced}T12:00:00Z`).getTime() - STALE_LEAD_DAYS * 86_400_000;
  const old = dated.filter((p) => (p.postedAt as Date).getTime() < cutoff);
  if (old.length * 2 <= dated.length) return { stale: false, reason: null };
  const earliest = old.map((p) => (p.postedAt as Date).toISOString().slice(0, 10)).sort()[0];
  return {
    stale: true,
    reason: `${old.length} of ${dated.length} X posts naming the company and the amount predate ${announced} by more than ${STALE_LEAD_DAYS} days (earliest ${earliest}); the announced date may be late.`,
  };
}

// What the stale check reads a stored post for. The relevance rule is loose on purpose (a post about
// the round should count for the score), but the stale check hides a round, so a post counts there
// only when it is provably about this company and this amount. Written after the Sep 23 flags, where
// football fees ("Akanji for €15M, won the treble"), a winger named Mika, and "keep in mind" posts
// outvoted the real conversation about Treble, mika, and MIND.

/** What the stale check knows about a round beyond the relevance subject. */
export interface StaleSubject {
  name: string;
  /** The company's own X handle, lowercased. */
  handle: string | null;
  domain: string | null;
  leadInvestors: readonly string[];
  description: string | null;
  /** The amount in the round's own currency: `value` in millions, as funding_rounds stores it. */
  amount: { value: number | null; currency: string | null };
}

/** A stored post as the stale check reads it: the words kept for it, and who wrote it. */
export interface StalePost {
  nameHit: boolean;
  postedAt: Date | null;
  handle: string | null;
  authorName: string | null;
  snippet: string;
}

/** How a currency is written before or after a figure. */
const CURRENCY_WORDS: Record<string, { before: string; after: string }> = {
  USD: { before: String.raw`(?:US\$|\$|USD\s?)`, after: String.raw`(?:\s?(?:USD|dollars))` },
  EUR: { before: String.raw`(?:€|EUR\s?)`, after: String.raw`(?:\s?(?:€|EUR|euros?))` },
  GBP: { before: String.raw`(?:£|GBP\s?)`, after: String.raw`(?:\s?(?:£|GBP|pounds))` },
  INR: { before: String.raw`(?:₹|Rs\.?\s?|INR\s?)`, after: String.raw`(?:\s?(?:INR|rupees))` },
};

/**
 * The round's figure in its own currency, as a whole figure: "$4M" and "$4 million" match a $4M
 * round, "$14M", "$4.5M", "4M", and a euro fee of €4M do not. A converted figure ("$6.9M" for a
 * €6M round) is not the round's own and does not count either: the check needs fewer, surer posts.
 */
export function amountInCurrency(text: string, amount: StaleSubject["amount"]): boolean {
  const words = amount.currency ? CURRENCY_WORDS[amount.currency.toUpperCase()] : undefined;
  if (!words || amount.value === null || !(amount.value > 0)) return false;
  const billions = amount.value >= 1000;
  const n = trimNumber(billions ? amount.value / 1000 : amount.value).replace(".", "\\.");
  const unit = billions ? String.raw`(?:b|bn|billion)` : String.raw`(?:m|mn|mm|million)`;
  const figure = String.raw`(?<![\d.,])${n}\s?${unit}(?![a-z0-9])`;
  return new RegExp(String.raw`${words.before}\s?${figure}|${figure}${words.after}(?![a-z])`, "i").test(text);
}

/** The name without a generic tail ("Vals" for "Vals AI"): what decides whether it is one word. */
function coreName(name: string): string {
  let n = name.trim();
  for (;;) {
    const next = n.replace(ALIAS_TAIL, "").trim();
    if (next === n || !next) return n;
    n = next;
  }
}

/**
 * A one-word name ("Mind", "Snag", "Treble", "Mika", "Vals AI") is as often a word, a first name, or
 * another company as it is this one, so a post naming it needs a second sign. There is no dictionary
 * here to tell "Snag" from "Nopan", so every one-word name asks; the funding-verb sign below keeps a
 * coined name's own headlines counting.
 */
export function isOneWordName(name: string): boolean {
  return !/\s/.test(coreName(name));
}

/** Tails a firm's name carries that a post often drops ("Tidemark" for "Tidemark Capital"). */
const INVESTOR_TAIL = /\s+(capital|partners|ventures|venture|vc|fund|funds|management|group|investments|holdings|llc|lp)$/i;

/** A firm's name with every generic tail dropped ("Black Nova" for "Black Nova Venture Capital"). */
function investorCore(name: string): string {
  let n = name.trim();
  for (;;) {
    const next = n.replace(INVESTOR_TAIL, "").trim();
    if (next === n || !next) return n;
    n = next;
  }
}
/** Short names posts use for a firm more often than its full one. */
const INVESTOR_ALIASES: Record<string, string[]> = { "andreessen horowitz": ["a16z"] };

/** Description words too common in startup copy to tell one company from another. */
const GENERIC_WORDS = new Set(
  (
    "platform platforms company companies startup startups software solution solutions service services technology technologies " +
    "powered native based build builds building builder developing develops developer developers provider providers product products " +
    "tools system systems enabled digital online global leading modern simple smart first their which helps helping using focused " +
    "business businesses enterprise enterprises marketplace network networks market markets world customers customer users teams " +
    "people industry industries agentic intelligence artificial automation automated automates automate application applications " +
    "infrastructure operating management connects verified across about other every these those where while through makes offers " +
    "provides designed driven small large"
  ).split(" "),
);

/** Words in the company's description a same-named stranger would not use: six letters or more, or an acronym ("DLP"). */
function distinctiveWords(description: string | null, core: string): string[] {
  if (!description) return [];
  const out = new Set<string>();
  for (const w of description.match(/[A-Za-z]+/g) ?? []) {
    const lower = w.toLowerCase();
    if (lower === core.toLowerCase() || GENERIC_WORDS.has(lower)) continue;
    if (lower.length >= 6 || (w.length >= 3 && w === w.toUpperCase())) out.add(lower);
  }
  return [...out];
}

/** Verbs a headline puts right after the company that raised: "Nopan bags", "Vals AI just raised". */
const RAISE_VERB = String.raw`(raises|raised|raising|secures|secured|bags|bagged|closes|closed|completes|completed|lands|landed|nabs|nabbed|gets|got|announces|announced|pulls in|snags|snagged)`;

/**
 * A second sign that a post naming a one-word company means this one: its own account or handle,
 * its domain, a lead investor, a distinctive word from its description, or the name followed within
 * three words by a raise verb. Squashed forms catch "Vals AI" for the handle valsai and "@AdaptiveBuilds"
 * for adaptive.build; they are used only when they say more than the name does.
 */
export function identityHit(post: Pick<StalePost, "handle" | "authorName" | "snippet">, s: StaleSubject): boolean {
  const text = `${post.authorName ?? ""} ${post.snippet}`;
  const lower = text.toLowerCase();
  const squashed = squash(text);
  const core = coreName(s.name);
  const coreKey = squash(core);
  const distinct = (key: string) => key.length >= 6 && !coreKey.includes(key) && squashed.includes(key);

  if (s.handle && (post.handle === s.handle || lower.includes(`@${s.handle}`) || distinct(s.handle))) return true;
  if (s.domain && (lower.includes(s.domain.toLowerCase()) || distinct(squash(s.domain)))) return true;
  for (const lead of s.leadInvestors) {
    const trimmed = investorCore(lead);
    const names = [lead, ...(trimmed.length >= 4 ? [trimmed] : []), ...(INVESTOR_ALIASES[lead.toLowerCase()] ?? [])];
    if (names.some((n) => n.length >= 3 && (mentions(text, n) || lower.includes(`@${squash(n)}`)))) return true;
  }
  if (distinctiveWords(s.description, core).some((w) => mentions(text, w))) return true;
  return new RegExp(String.raw`(^|[^a-z0-9])${escapeRe(core.toLowerCase())}(\s+[^\s.:;!?|·]+){0,3}?\s+${RAISE_VERB}\b`).test(lower);
}

/**
 * Each stored post as the stale check counts it: named (and, for a one-word name, identified by a
 * second sign) and carrying the round's figure in its own currency. The words read are the stored
 * snippet and the author's name, the parts of the search result the relevance rule read.
 */
export function staleReadings(
  posts: readonly StalePost[],
  s: StaleSubject,
): Array<{ nameHit: boolean; amountHit: boolean; postedAt: Date | null }> {
  const oneWord = isOneWordName(s.name);
  return posts.map((p) => ({
    nameHit: p.nameHit && (!oneWord || identityHit(p, s)),
    amountHit: amountInCurrency(`${p.authorName ?? ""} ${p.snippet}`, s.amount),
    postedAt: p.postedAt,
  }));
}

/** The label's thresholds. */
export const LABEL_RULE = { maxAgeHours: 72, minPeople: 10, minOutlets: 3, topN: 5 } as const;

export interface LabelInput {
  roundId: string;
  score: number;
  stale: boolean;
  firstSeenAt: Date;
  people: number;
  outlets: number;
}

/**
 * "Trending": not stale, first seen under 72 hours ago, at least ten people on X and three outlets,
 * and among the top five by score. Returns the rank (1-based, over rounds that are not stale) for
 * every round and the labelled ids.
 */
export function labelRounds(rows: LabelInput[], now: Date): { rank: Map<string, number>; labelled: Set<string> } {
  const ranked = rows.filter((r) => !r.stale && r.score > 0).sort((a, b) => b.score - a.score || a.roundId.localeCompare(b.roundId));
  const rank = new Map(ranked.map((r, i) => [r.roundId, i + 1]));
  const labelled = new Set<string>();
  for (const r of ranked.slice(0, LABEL_RULE.topN)) {
    const ageHours = (now.getTime() - r.firstSeenAt.getTime()) / 3_600_000;
    if (ageHours < LABEL_RULE.maxAgeHours && r.people >= LABEL_RULE.minPeople && r.outlets >= LABEL_RULE.minOutlets)
      labelled.add(r.roundId);
  }
  return { rank, labelled };
}

/** The reader's one-line count: "14 people on X · 6 outlets · HN 3 pts". Counts, not likes. */
export function trendingSummary(t: { people: number; outlets: number; hnPoints: number }): string {
  const parts: string[] = [];
  if (t.people > 0) parts.push(`${t.people} ${t.people === 1 ? "person" : "people"} on X`);
  if (t.outlets > 0) parts.push(`${t.outlets} ${t.outlets === 1 ? "outlet" : "outlets"}`);
  if (t.hnPoints > 0) parts.push(`HN ${t.hnPoints} ${t.hnPoints === 1 ? "pt" : "pts"}`);
  return parts.join(" · ");
}

// The company's own handle.

/** Prefixes and suffixes companies wrap a name in to get a free handle ("tryheidi", "arcee_ai"). */
const HANDLE_PREFIX = /^(try|get|use|join|hey|hello|meet|go)/;
const HANDLE_SUFFIX = /(ai|hq|io|app|inc|labs|co|dev|health|tech|ev|official|team|global|group)$/;

function squash(s: string): string {
  return s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * The handle spells the company's name: equal once squashed, or the name wrapped in one common
 * prefix or suffix. "temporalio" is Temporal and "tryheidi" is Heidi Health; "fearnlegal" is not
 * provably Fearn, so it waits for a display-name match in the search results.
 */
export function handleMatchesName(handle: string, name: string): boolean {
  const h = squash(handle);
  const names = [name, ...nameAliases(name)].map((n) => squash(normalizeCompanyKey(n) || n)).filter((n) => n.length >= 3);
  for (const n of names) {
    if (h === n) return true;
    const core = h.replace(HANDLE_PREFIX, "").replace(HANDLE_SUFFIX, "");
    if (core === n) return true;
    if (h.replace(HANDLE_PREFIX, "") === n || h.replace(HANDLE_SUFFIX, "") === n) return true;
  }
  return false;
}

/**
 * Account handles linked from a homepage. A status link is a testimonial, not the company, and is
 * skipped; so are share and intent links. Order is the page's; duplicates collapse.
 */
export function handlesFromLinks(links: readonly string[]): string[] {
  const out: string[] = [];
  for (const link of links) {
    const m = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:#!\/)?([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/.exec(link.trim());
    const h = m?.[1]?.toLowerCase();
    if (!h || NOT_ACCOUNTS.has(h) || out.includes(h)) continue;
    out.push(h);
  }
  return out;
}

/**
 * Pick the company's handle. A homepage candidate that spells the name is taken; one that does not
 * is taken only when a search result by that account carries the company's name as its display
 * name. With no candidate, an account in the results whose display name is the company's name and
 * whose handle spells it is adopted. Testimonial accounts linked from a homepage fail both tests.
 */
export function chooseHandle(
  candidates: readonly string[],
  name: string,
  results: ReadonlyArray<Pick<XResult, "handle" | "name">>,
): { handle: string; source: "homepage" | "search" } | null {
  const displayOf = new Map<string, string>();
  for (const r of results) if (r.handle && r.name && !displayOf.has(r.handle)) displayOf.set(r.handle, r.name);
  for (const c of candidates) {
    if (handleMatchesName(c, name)) return { handle: c, source: "homepage" };
    const display = displayOf.get(c);
    if (display && sameName(display, name)) return { handle: c, source: "homepage" };
  }
  for (const [h, display] of displayOf) {
    if (sameName(display, name) && handleMatchesName(h, name)) return { handle: h, source: "search" };
  }
  return null;
}

// Hacker News.

/** A story counts for a round when its title names the company (or its URL is on the domain) and it reads as funding news. */
export function hnStoryMatches(
  story: { title: string | null; url: string | null },
  s: Pick<RoundSubject, "name" | "aliases">,
  domain: string | null,
): boolean {
  const title = story.title ?? "";
  const named = [s.name, ...s.aliases].some((n) => mentions(title, n)) || (!!domain && !!story.url && story.url.includes(domain));
  return named && /\b(rais|funding|series|seed|valuation|round)/i.test(title);
}

// A post read through Firecrawl's X scrape.

export interface XPostRead {
  author: string | null;
  postedAt: Date | null;
  likes: number | null;
  reposts: number | null;
  isRetweet: boolean;
  text: string | null;
}

/** The five entities X leaves escaped in a post's text. */
function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e] ?? _);
}

/**
 * Whether a post's own words are about the round: the name or the handle, and a funding word or the
 * amount. A quote post's comment ("congrats!") is not, though the post it quotes was; the showcase
 * keeps the search snippet for those rather than show words that say nothing about the round.
 */
export function aboutRound(text: string, s: Pick<RoundSubject, "name" | "aliases" | "handle" | "amounts">): boolean {
  const lower = text.toLowerCase();
  const named = [s.name, ...s.aliases].some((n) => mentions(text, n)) || (!!s.handle && lower.includes(`@${s.handle}`));
  return named && (FUNDING_WORDS.test(text) || s.amounts.some((a) => lower.includes(a.toLowerCase())));
}

/** The markdown Firecrawl's X scrape returns for one post: author line, Posted, Likes | Retweets, then the post. */
export function parseXPost(markdown: string): XPostRead {
  const head = markdown.split("\n## ")[0] ?? "";
  const num = (re: RegExp) => {
    const m = re.exec(head);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  };
  const posted = /Posted:\s*(.+)/.exec(head)?.[1]?.replace(/\\/g, "").trim();
  const postedAt = posted ? new Date(posted) : null;
  const body = /(?:^|\n)## Post\s*\n+([\s\S]*?)(\n## |$)/.exec(markdown)?.[1]?.trim() ?? null;
  return {
    author: /Author:\s*(.+)/.exec(head)?.[1]?.trim() ?? null,
    postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
    likes: num(/Likes:\s*([\d,]+)/),
    reposts: num(/Retweets:\s*([\d,]+)/),
    isRetweet: /^RT @/.test(body ?? ""),
    text: body === null ? null : decodeEntities(body),
  };
}
