// The X announcements lane, the pure part. A founder or a company often announces a round on X
// before any article exists (Parallax's $117m fundraise, September 24, 2026, was X-only for hours),
// and the sweep's queries never see a post. Every hour the lane searches X through Firecrawl for
// first-person funding posts from the last few hours, reads each result into a lead (who posted,
// which company, how much), and looks for an article that corroborates it with a search on the
// company and the amount, on a backoff for about 48 hours. The article, read through the normal
// pipeline, is what lands; a post on its own lands only as a flagged record, and only when the
// company's own homepage links the account that posted it. lib/announcements.ts and
// workflows/announcements.ts run these rules against the store and Firecrawl.

import { normalizeCompanyKey } from "../records/keys.ts";
import { canonicalUrl, hostOf, isArticleUrl, parseAmount, registrableDomain } from "../records/normalize.ts";
import type { ExtractedItem } from "../records/resolve.ts";
import { notARound } from "../records/routing.ts";
import { isAnnouncementOutlet } from "./outlets.ts";
import { amountTokens, mentions, type XResult } from "./signals.ts";

/**
 * The searches, each restricted to x.com and to the past day, newest first. Measured on September 24,
 * 2026 over 190 results: first-person phrasings ("we've raised", "excited to announce ... raised")
 * returned the founder and company posts; "today we announced" and "raised a $" returned mostly news
 * desks and unrelated posts and are left out. "we're launching" is Parallax's own phrasing. The
 * investor-side phrasings ("proud to lead", "we led", "our investment in") catch the lead investor's
 * post, which a recall check (September 18 to 24) found was the realistic X-first path besides founders.
 */
export const X_ANNOUNCEMENT_QUERIES: ReadonlyArray<{ key: string; q: string }> = [
  { key: "weve_raised", q: `site:x.com "we've raised" led by` },
  { key: "we_raised", q: `site:x.com "we raised" led by` },
  { key: "excited_raised", q: `site:x.com "excited to announce" raised led by` },
  { key: "thrilled", q: `site:x.com "thrilled to announce" raised OR funding led by` },
  { key: "announcing_our", q: `site:x.com "announcing our" round OR seed OR fundraise led by` },
  { key: "launching_with", q: `site:x.com "we're launching" fundraise OR funding OR raised "led by"` },
  { key: "our_round", q: `site:x.com "our seed" OR "our series" led by` },
  { key: "has_raised", q: `site:x.com "has raised" led by` },
  { key: "weve_closed", q: `site:x.com "we've closed" OR "we closed our" OR "closed our seed" round` },
  {
    key: "proud_to_lead",
    q: `site:x.com "proud to lead" OR "excited to lead" OR "thrilled to lead" OR "proud to co-lead" round OR seed OR series`,
  },
  { key: "we_led", q: `site:x.com "we led" OR "we co-led" OR "led by us" round OR seed OR series` },
  { key: "our_investment", q: `site:x.com "our investment in" OR "welcome to the portfolio" OR "proud to back" raised OR round` },
];

/** Results each search asks for: the rate's first full step (20 results, 4 credits). */
export const X_ANNOUNCEMENT_LIMIT = 20;

/**
 * How old a post may be to count as this hour's news. The lane runs hourly; twelve hours of overlap
 * lets a post the search engine indexes late still come in (a founder's post measured at eight hours
 * old when the search first returned it), and the lead key keeps it from coming
 * in twice.
 */
export const ANNOUNCEMENT_LOOKBACK_HOURS = 12;

/**
 * When a lead is searched for an article, in hours after it was first seen: at once, then on a
 * widening backoff to 48 hours: six searches at 2 credits each. Parallax's first article (WSJ,
 * syndicated on Yahoo Finance) came the same day; a smaller round's trade-press write-up can take a
 * day or two.
 */
export const CORROBORATION_SCHEDULE_HOURS: readonly number[] = [0, 2, 6, 12, 24, 48];

const HOUR = 3_600_000;

/**
 * A profile page's lead is searched three times, not six: its snippet can be an older post the page
 * still shows (most measured profile leads found no article this week), and a status post carries its
 * own time.
 */
export const PROFILE_SCHEDULE_HOURS: readonly number[] = [0, 12, 48];

/** When the next corroboration attempt is due, or null once the schedule has run out. */
export function nextAttemptAt(firstSeenAt: Date, attemptsDone: number, kind: "post" | "profile" = "post"): Date | null {
  const offset = (kind === "profile" ? PROFILE_SCHEDULE_HOURS : CORROBORATION_SCHEDULE_HOURS)[attemptsDone];
  return offset === undefined ? null : new Date(firstSeenAt.getTime() + offset * HOUR);
}

/** A funding post read into what the lane needs to find its article. */
export interface AnnouncementLead {
  /** The status id, or `profile:<handle>:<amount>` for a profile-page result. */
  key: string;
  kind: "post" | "profile";
  url: string;
  /** Who wrote the words: the quoted post's author when the result is a quote or a repost that names one. */
  handle: string | null;
  authorName: string | null;
  /** The account whose page carried it, when that is not the author (a quote post, a repost page). */
  via: string | null;
  /** The company the post names, or the posting account's own name when it is plainly the company's. */
  company: string | null;
  /** The company's handle when the post names it ("@nova_ai's $40M"). */
  companyHandle: string | null;
  amountAsWritten: string;
  amountValue: number;
  currency: string | null;
  /** USD millions for a dollar figure; other currencies are priced when the article is read. */
  usdMillions: number | null;
  /** The round's words as the post writes them: "Series B", "seed", "fundraise". */
  label: string;
  leadInvestors: string[];
  text: string;
  postedAt: Date | null;
}

export type LeadRejection =
  | "profile"
  | "old"
  | "undated"
  | "no announcement"
  | "no amount"
  | "outlet"
  | "not a round"
  | "no author"
  | "no subject";

/**
 * The quote chrome a search description carries when the post quotes or reposts another: "@CarlSchoeller.
 * Carl Schoeller · @CarlSchoeller · Now. Today we're launching Parallax ...". The quoted account is the author.
 */
const QUOTE_CHROME =
  /(?:^|\s)(?:@\w{1,15}\.\s+)?([^·@\n]{1,60}?)\s+·\s+@(\w{1,15})\s+·\s+(\d+[smhd]|now|[A-Z][a-z]{2} \d{1,2}(?:, \d{4})?)\.?\s/i;

/**
 * The words of an announcement by the party that raised, or by its lead investor: first person, the
 * company as subject, or the investor leading or backing it ("proud to lead", "we led", "our
 * investment in", "welcome @acme to the portfolio").
 */
const INVESTOR_ANNOUNCES =
  /\b(?:(?:proud|excited|thrilled|delighted|happy)\s+to\s+(?:co-?)?(?:lead|back)|we(?:'ve|’ve| have)?\s+(?:co-?)?led|led\s+by\s+us|our\s+(?:new\s+)?investment\s+in|welcome\s+@?\w+\s+to\s+the\s+(?:\w+\s+)?portfolio)\b/i;
const ANNOUNCES =
  /\b(?:we(?:'ve|’ve| have)?\s+(?:just\s+|now\s+|officially\s+)?(?:raised|closed|secured)|we(?:'re|’re| are)\s+(?:excited|thrilled|proud|happy|delighted|launching|announcing)|(?:excited|thrilled|proud|happy|delighted)\s+to\s+(?:announce|share)|today,?\s+we(?:'re|’re| are)?\s+(?:announc\w+|launch\w+)|announcing\s+our|we(?:'re|’re| are)\s+(?:also\s+)?announcing|has\s+(?:just\s+|officially\s+)?raised|just\s+raised|our\s+(?:new\s+)?(?:\$[\d.,]+\s?[mbk]\w*\s+)?(?:pre-?seed|seed|series\s+[a-h]\b|fundraise|funding round|round))/i;

/** What makes a "we raised" a venture round rather than a drive: a round word, a lead, investors, a valuation. */
const VENTURE_WORDS =
  /\b(?:led by|co-led|pre-?seed|seed|series\s+[a-h]|round|funding|fundraise|financing|valuation|investors?|backed by|venture|from\s+@\w+)\b|\braised\s+(?:an?\s+)?\S*\d\S*\s+(?:\w+\s+)?to\s+(?:build|make|help|bring|scale|accelerate|power|create|expand|grow|fix|reinvent|launch|turn|end)\b/i;

/** A money figure as a post prints it: "$117m", "$40M", "€12 million", "7M EUR", "US$5.5 million". */
const MONEY =
  /(?:US\$|[A-Z]{1,2}\$|[$€£]|\b(?:USD|EUR|GBP)\s?)\s?\d[\d.,]*\s*(?:million|billion|mn|bn|m|b|k)?\b|\b\d[\d.,]*\s*(?:million|billion|m|mn|bn)\s*(?:USD|EUR|GBP|dollars|euros|pounds)\b/i;

/** The round's own word near its figure. */
const LABEL = /\b(pre-?seed|seed(?: extension)?|series\s+[a-h](?:[-\s]?\d|\+)?|fundraise|financing|funding round|funding|round)\b/i;

/** Words that open a sentence and are never a company. */
const NOT_A_NAME = new Set([
  "we",
  "i",
  "today",
  "it",
  "the",
  "this",
  "our",
  "they",
  "he",
  "she",
  "company",
  "startup",
  "team",
  "now",
  "so",
  "and",
  "but",
  "after",
  "excited",
  "thrilled",
  "proud",
  "why",
  "just",
  "we've",
  "we're",
  "i'm",
  "another",
  "one",
  "congrats",
  "congratulations",
]);

// A token keeps a dot only inside a domain-shaped name ("Bird.com"), so "Introducing Alexandria. We raised" never reads as one name.
// A name starts at a word's start ("functionSPACE", not its "SPACE"), capitalized or camel-cased.
const NAME = String.raw`(?<![\w@])((?:[A-Z]|[a-z]+[A-Z])[\w&'’-]*(?:\.[a-z]{2,})?(?:\s+[A-Z0-9][\w&'’-]*(?:\.[a-z]{2,})?){0,3})`;
/** "@nova_ai's $40M", "@naturalpay has raised", "the $12M seed round in @acme", "our investment in @acme". */
const HANDLE_RAISED =
  /@(\w{1,15})(?:(?:'s|’s)\s+(?:[\w-]+\s+){0,2}(?:\$|€|£)|\s+(?:has\s+|just\s+)*(?:raised|raises|secured|closed))|\b(?:launching|introducing|announcing|meet)\s+@(\w{1,15})\b|\b(?:round|seed|series\s+[a-h]|investment|financing|raise)\s+(?:at|for|in|into|of)\s+@(\w{1,15})\b|\b(?:lead|co-lead|led|back|backing)\s+@(\w{1,15})\b/i;
/** "Limble has raised $58M", "Optimum has raised an $11 million seed". */
const NAME_RAISED = new RegExp(
  String.raw`${NAME}\s+(?:has\s+|have\s+|just\s+|today\s+|officially\s+)*(?:raised|raises|secured|secures|closed|closes|lands|landed)\b`,
);
/** "Fortytwo is thrilled to announce a $2.3M Pre-Seed", "Axis is excited to announce a raise". */
const NAME_ANNOUNCES = new RegExp(String.raw`${NAME}\s+is\s+(?:thrilled|excited|proud|happy|delighted)\s+to\s+(?:announce|share)\b`);
/** "proud to lead Acme's $12M Series A", "our investment in Acme", "we led the seed round in Acme". */
const NAME_BACKED = new RegExp(
  String.raw`\b(?:lead|co-lead|led|back|backing|investment in|invest in|round in|seed in)\s+${NAME}(?=(?:'s|’s)|[,.:;!]|\s+(?:the|a|an|with|to|and|as|in|at|on)\b|$)`,
);
/** "launching Parallax, the AI energy company", "introducing Seltz"; "launching @pitdotcom, with $16M" is caught as a handle. */
const NAME_LAUNCHED = new RegExp(
  String.raw`\b(?:[Ll]aunching|[Ii]ntroducing|[Aa]nnouncing|[Mm]eet)\s+${NAME}(?=[,.:;!]|\s+(?:the|a|an|with|to|and)\b)`,
);

/** Money raised for a cause, a campaign, or a fund, which a founder's "we raised" can also mean. */
const NOT_FUNDING =
  /\b(?:campaign|scholarships?|charit(?:y|ies)|donat\w+|cancer|lottery|for education|non-dilutive|grants?|fundraiser for|cash on hand|relief|election|antiquities)\b|\b(?:early[- ]stage|seed|growth|venture|opportunit(?:y|ies)|select|flagship|debut|new|first|second|third|climate|impact)\s+fund\b(?!ing)|\bfund\s+(?:[ivx]{1,4}|\d)\b|\b[A-Z][a-z]+ [IVX]{2,5}\b/;

/** X's localized "Replies by" and "Reposts by" in front of a display name. */
const PAGE_PREFIX =
  /^(?:Replies by|Reposts by|Posts by|Отговори от|Публикации от|Ответы|Respuestas de|Respostes de|Respostas de|Réponses de|Antworten von|Risposte di|返信|الردود بواسطة)\s+/i;

/** Firm-shaped display names: an investor account posting a portfolio company's news is not the company. */
const FIRM_NAME = /\b(?:ventures?|vc|capital|partners|fund|investments|holdings|labs? fund)\b/i;

/** A name's leading word as the stop list reads it: lowercased, curly apostrophes straightened, trailing marks gone. */
function stopWord(word: string): boolean {
  return NOT_A_NAME.has(
    word
      .toLowerCase()
      .replace(/’/g, "'")
      .replace(/[.,;:!]+$/, ""),
  );
}

function clean(name: string | null | undefined): string | null {
  const n = (name ?? "")
    .replace(/[’']s$/i, "")
    .replace(/[.,;:!]+$/, "")
    .trim();
  if (!n || stopWord(n) || n.length < 2) return null;
  return n;
}

/** A hyphenated descriptor in front of a name: "Israeli-founded", "London-based", "YC-backed". */
const DESCRIPTOR = /^[\w’']+-(?:founded|based|backed|born|headquartered|led|made)$/i;

/** The company a post names: its handle, a name before "raised", the name after "launching", or the one an investor leads or backs. */
export function companyInText(text: string): { name: string | null; handle: string | null } {
  const h = HANDLE_RAISED.exec(text);
  const handle = h?.[1] ?? h?.[2] ?? h?.[3] ?? h?.[4];
  if (handle) return { name: handle, handle: handle.toLowerCase() };
  for (const re of [NAME_ANNOUNCES, NAME_RAISED, NAME_LAUNCHED, NAME_BACKED]) {
    const m = re.exec(text);
    const words = m?.[1]?.split(/\s+/) ?? [];
    // Drop leading sentence words ("Today Seltz raised" is Seltz) and descriptors ("Israeli-founded Island"
    // is Island); a stop word inside means two sentences ran together.
    while (words.length > 0 && (stopWord(words[0]) || DESCRIPTOR.test(words[0]))) words.shift();
    if (words.some(stopWord)) continue;
    const n = clean(words.join(" "));
    if (n) return { name: n, handle: null };
  }
  return { name: null, handle: null };
}

/** Handle tails and fronts a company account adds to its name: "@hifihq", "@seltz_ai", "@getacme", "@officialmagicco". */
const HANDLE_FRONT = /^(?:official|get|try|join|use|the|hello|meet)/;
const HANDLE_TAIL = /(?:hq|app|ai|labs?|inc|io|xyz|co|official|team|world|global)$/;

/** A handle down to the name it spells: lowercased, fronts and tails a company adds removed. */
function handleCore(handle: string): string {
  const h = handle.toLowerCase().replace(/[^a-z0-9]/g, "");
  const front = h.replace(HANDLE_FRONT, "");
  const core = front.replace(HANDLE_TAIL, "");
  return core.length >= 3 ? core : front;
}

/**
 * Whether the account is plainly the company's own: its display name is one word (or a name with a
 * company tail like "AI" or "Labs"), not a firm's, and the handle spells that name, give or take a
 * company's front or tail ("Seltz", @seltz_ai). A person's first name at the front of a longer handle
 * ("Karan", @karankendre) is not a company.
 */
export function looksLikeCompanyAccount(handle: string | null, name: string | null): boolean {
  if (!handle || !name || FIRM_NAME.test(name) || !/^[A-Z0-9]/.test(name.trim())) return false;
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (n.length < 4) return false;
  const oneWord = !/\s/.test(name.trim()) || /^(?:[A-Z][a-z]+)\s(?:AI|HQ|Labs?|Inc|Money|Health|Bio|Energy|Robotics)$/.test(name.trim());
  if (!oneWord) return false;
  const h = handle.toLowerCase().replace(/[^a-z0-9]/g, "");
  const core = handleCore(handle);
  return core === n || h.replace(HANDLE_FRONT, "") === n || n.startsWith(core);
}

/**
 * The company a company account's first-person post is about, when its display name does not read as a
 * name (HIFI's account shows a tagline): a word in the post that spells the handle's name ("run on HIFI"
 * from @hifihq). Null when no word does.
 */
export function companyFromHandle(handle: string | null, text: string): string | null {
  if (!handle) return null;
  const core = handleCore(handle);
  if (core.length < 3) return null;
  for (const word of text.match(/[A-Za-z][\w&.-]*[A-Za-z0-9]/g) ?? []) {
    if (word.toLowerCase().replace(/[^a-z0-9]/g, "") === core && /[A-Z]/.test(word)) return word;
  }
  return null;
}

/** "led by Founders Fund, Eclipse, Lux, Diffusion, Greylock and General Catalyst" as a list of names. */
export function leadsInText(text: string): string[] {
  const m = /\b(?:co-)?led by\s+(.+?)(?:\.\s|[.!]$|\s+with participation|\s+alongside|\s+to\s|\s+-\s|\(|$)/i.exec(text);
  if (!m) return [];
  return m[1]
    .split(/,\s*|\s+and\s+|\s*&\s*/)
    .map((s) =>
      s
        .replace(/^@/, "")
        .replace(/[.…]+$/, "")
        .trim(),
    )
    .filter((s) => s.length > 1 && s.length <= 60 && !/^(?:others?|more)$/i.test(s))
    .slice(0, 8);
}

/**
 * One X search result as a lead, or why it is not one. A lead is a post from the last
 * `lookbackHours` in which the party that raised says so ("we've raised", "@acme has raised",
 * "we're launching Parallax ... with a $117m fundraise"), with a figure. A news desk's post, a
 * charity drive, a fund close, and a profile page whose snippet is an older post are not.
 */
export function readAnnouncement(
  r: XResult,
  title: string | null | undefined,
  now: Date,
  lookbackHours = ANNOUNCEMENT_LOOKBACK_HOURS,
): AnnouncementLead | LeadRejection {
  // A profile page's snippet can be any of its posts and carries no time of its own (its "N hours ago" is
  // the newest post's): every profile lead measured in September 2026 was months or years old.
  if (r.kind === "profile") return "profile";
  const quote = QUOTE_CHROME.exec(r.text);
  const repostPage = /^Reposts? by\b/i.test(title ?? "");
  // The words: the snippet the result shows, with the quote chrome gone.
  const text = r.snippet;
  // Recency: the quoted post's own age when the chrome shows one, and the status id's time.
  if (quote) {
    const age = quote[3].toLowerCase();
    if (!/^(?:now|\d+[smh])$/.test(age)) return "old";
  }
  if (!r.postedAt) return "undated";
  if (now.getTime() - r.postedAt.getTime() > lookbackHours * HOUR) return "old";
  const byInvestor = INVESTOR_ANNOUNCES.test(text);
  if ((!ANNOUNCES.test(text) && !byInvestor) || !VENTURE_WORDS.test(text)) return "no announcement";
  const money = MONEY.exec(text);
  const amount = parseAmount(money?.[0] ?? null);
  if (!money || amount.value === null || amount.value <= 0) return "no amount";
  const handle = quote ? quote[2].toLowerCase() : repostPage ? null : r.handle;
  const authorName = (quote ? quote[1].trim() : repostPage ? null : r.name)?.replace(PAGE_PREFIX, "").trim() || null;
  if (!handle && !authorName) return "no author";
  if (isAnnouncementOutlet(handle, authorName)) return "outlet";
  // A charity drive, a fund close, a cohort's total, a lender's facility: the same rules a stageless article round meets.
  const why = notARound("funding", text, money[0]);
  if ((why && why !== "no raise stated") || NOT_FUNDING.test(text)) return "not a round";
  const named = companyInText(text);
  const company =
    named.name ?? (looksLikeCompanyAccount(handle, authorName) ? authorName : byInvestor ? null : companyFromHandle(handle, text));
  if (!company && !authorName) return "no subject";
  const label = LABEL.exec(text.slice(Math.max(0, (money.index ?? 0) - 60), (money.index ?? 0) + money[0].length + 60))?.[1] ?? "funding";
  const usd = amount.currency === "USD" ? amount.value : null;
  const key = r.statusId ?? `profile:${r.handle ?? handle}:${money[0].toLowerCase().replace(/\s+/g, "")}`;
  return {
    key,
    kind: r.kind,
    url: r.url,
    handle,
    authorName,
    via: r.handle && r.handle !== handle ? r.handle : null,
    company,
    companyHandle: named.handle,
    amountAsWritten: money[0].trim(),
    amountValue: amount.value,
    currency: amount.currency,
    usdMillions: usd,
    label: label.replace(/\s+/g, " "),
    // An investor announcing that it led the round is the round's lead.
    leadInvestors: leadsInText(text).length > 0 || !byInvestor || !authorName ? leadsInText(text) : [authorName],
    text,
    postedAt: r.postedAt,
  };
}

/** The ways the lead's figure is written in an article: "$117M", "$117 million", "117M". */
export function leadAmountTokens(lead: Pick<AnnouncementLead, "amountAsWritten" | "amountValue" | "currency" | "usdMillions">): string[] {
  return amountTokens({ asWritten: lead.amountAsWritten, value: lead.amountValue, currency: lead.currency, usdMillions: lead.usdMillions });
}

/**
 * The search for the lead's article: the company (else the author, whom an article quotes as its
 * founder) with the figure two ways and a raise word, over the past week. Null when the lead names
 * neither.
 */
export function leadArticleQuery(lead: AnnouncementLead): { q: string; tbs: string } | null {
  const subject = (lead.company ?? lead.authorName)?.replace(/"/g, "");
  if (!subject) return null;
  const tokens = leadAmountTokens(lead)
    .filter((t) => /\d/.test(t))
    .slice(0, 2)
    .map((t) => `"${t.replace(/"/g, "")}"`);
  const figure = tokens.length > 1 ? `(${tokens.join(" OR ")})` : (tokens[0] ?? "");
  return { q: `"${subject}" ${figure} (raises OR raised OR funding OR fundraise)`.replace(/\s+/g, " ").trim(), tbs: "qdr:w" };
}

/** Hosts an article is never read from: the social networks the lead came from, and their kin. */
const NOT_AN_ARTICLE_HOST = new Set([
  "x.com",
  "twitter.com",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "reddit.com",
  "threads.net",
  "tiktok.com",
  "bsky.app",
]);

/** Articles to read from the corroboration search: news pages that name the subject, at most `max`, in result order. */
export function pickCorroboration(
  results: ReadonlyArray<{ url?: string; title?: string; description?: string }>,
  lead: Pick<AnnouncementLead, "company" | "authorName" | "companyHandle">,
  max = 3,
): Array<{ url: string; title?: string }> {
  const subjects = [lead.company, lead.companyHandle, lead.authorName].filter((s): s is string => !!s);
  const out: Array<{ url: string; title?: string }> = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (!r.url) continue;
    const url = canonicalUrl(r.url);
    const host = registrableDomain(url) ?? hostOf(url);
    if (seen.has(url) || NOT_AN_ARTICLE_HOST.has(host) || !isArticleUrl(url)) continue;
    const text = `${r.title ?? ""} ${r.description ?? ""}`;
    if (!subjects.some((s) => mentions(text, s))) continue;
    seen.add(url);
    out.push({ url, title: r.title });
    if (out.length >= max) break;
  }
  return out;
}

/** Two figures are one round's within 15 percent (a post's "$117m" is an article's "$117 million"; "~$2M" its "$2.1 million"). */
function near(a: number, b: number): boolean {
  return Math.abs(a - b) / Math.max(a, b) <= 0.15;
}

/**
 * Whether a record read off a corroborating article is the lead's round. The company must match
 * when the post named one; the figure must match when both are known (in dollars, or in the
 * post's own currency). A lead that names only its author needs the figure and a name the post
 * also carries (the article's company is in the post's words, or it shares a lead investor).
 */
export function leadMatches(
  record: {
    company_name: string;
    amount: { value: number | null; currency: string | null; usd_millions: number | null };
    lead_investors: string[];
  },
  lead: Pick<AnnouncementLead, "company" | "companyHandle" | "amountValue" | "currency" | "usdMillions" | "text" | "leadInvestors">,
): boolean {
  const rk = normalizeCompanyKey(record.company_name);
  const amountKnown = record.amount.value !== null;
  const amountOk =
    lead.usdMillions !== null && record.amount.usd_millions !== null
      ? near(lead.usdMillions, record.amount.usd_millions)
      : lead.currency !== null && record.amount.currency === lead.currency && record.amount.value !== null
        ? near(lead.amountValue, record.amount.value)
        : !amountKnown;
  if (lead.company || lead.companyHandle) {
    const keys = [lead.company, lead.companyHandle].filter((s): s is string => !!s).map((s) => normalizeCompanyKey(s));
    const compact = (s: string) => s.replace(/\s+/g, "");
    const same = keys.some(
      (k) => !!k && !!rk && (k === rk || compact(k) === compact(rk) || rk.startsWith(`${k} `) || k.startsWith(`${rk} `)),
    );
    return same && amountOk;
  }
  if (!amountKnown || !amountOk) return false;
  const leads = new Set(lead.leadInvestors.map((l) => normalizeCompanyKey(l)));
  return mentions(lead.text, record.company_name) || record.lead_investors.some((l) => leads.has(normalizeCompanyKey(l)));
}

/**
 * Whether a lead may land on the post alone, flagged. Decided (September 2026): yes, narrowly. A
 * company's own announcement is a first-party statement, the same kind of evidence as a release on
 * its newsroom, and a round that stays X-only for hours (Parallax) is exactly what the feed missed.
 * But X accounts are free to open and to name, so the author must be verifiable as the company or
 * its founder: the company's own homepage links the account that posted. The post must be a status
 * with its own time inside the lookback (a profile page's snippet can be an older post), name the
 * company, and state a figure. The record is flagged and unverified until an article confirms it;
 * the lane keeps searching for one on its schedule.
 */
export function selfPublishable(
  lead: Pick<AnnouncementLead, "kind" | "handle" | "company" | "postedAt" | "via">,
  homepageHandles: readonly string[],
): boolean {
  if (lead.kind !== "post" || !lead.postedAt || !lead.handle || !lead.company) return false;
  return homepageHandles.map((h) => h.toLowerCase()).includes(lead.handle.toLowerCase());
}

/** A domain the post writes out ("parallax.ai"), for reading the company's homepage when the store has none. */
export function domainInText(text: string): string | null {
  const m = /\b((?:[a-z0-9-]+\.)+(?:ai|com|io|co|dev|xyz|app|so|tech|energy|bio|health|finance|us|uk|de|fr))\b/i.exec(text);
  if (!m) return null;
  const d = m[1].toLowerCase();
  return /^(?:x|twitter|t|linkedin|youtube|bit|lnkd)\.(?:com|co|ly|in)$/.test(d) ? null : d;
}

/**
 * A self-published lead as the resolver reads a page: the post is the source (x.com is a timeline host,
 * so the resolver keeps a post's round as it keeps an X timeline's), the post's words are the evidence,
 * and the post's own day is the date.
 */
export function leadAsItem(lead: AnnouncementLead, website: string | null): ExtractedItem {
  const day = (lead.postedAt ?? new Date()).toISOString().slice(0, 10);
  return {
    round: {
      company_name: lead.company ?? "",
      company_website: website,
      company_description: null,
      round_type_as_written: lead.label,
      amount_as_written: lead.amountAsWritten,
      amount_kind: "round",
      valuation_as_written: null,
      lead_investors: lead.leadInvestors,
      other_investors: [],
      announced_date: day,
      headquarters: null,
      sector: null,
      evidence_quote: lead.text,
      source_url: null,
      is_background: false,
      is_rumor: false,
    },
    source: {
      url: lead.url,
      host: "x.com",
      title: `${lead.authorName ?? lead.handle ?? "X"} on X`,
      published: day,
      query: "x:announcement",
    },
    page_kind: "article",
    page_date: day,
    grounded: true,
  };
}

/** Hours two posts may be apart and still confirm one another: a launch and its echo land the same morning. */
export const X_CONFIRMATION_WINDOW_HOURS = 12;

/**
 * How old a founder's post may be when it lands on its own: the lane searches a lead for 48 hours, but a
 * post-only record is today's news or nothing, so a confirmation that arrives later leaves it for the article.
 */
export const X_LANDING_MAX_AGE_HOURS = 24;

type ConfirmFields = Pick<
  AnnouncementLead,
  "kind" | "handle" | "company" | "companyHandle" | "amountValue" | "currency" | "usdMillions" | "postedAt"
>;

/**
 * Whether `other` independently confirms `lead`: a different account's own dated status post (never a
 * profile page, never the same author through a quote or a repost, never an outlet, which readAnnouncement
 * already refused), naming the same company, stating the same figure within 15 percent, posted within
 * twelve hours of the lead. Parallax's launch had seven such posts from its founders, team, and investors.
 */
export function confirmsLead(lead: ConfirmFields, other: ConfirmFields, windowHours = X_CONFIRMATION_WINDOW_HOURS): boolean {
  if (lead.kind !== "post" || other.kind !== "post" || !lead.postedAt || !other.postedAt) return false;
  if (!lead.handle || !other.handle || lead.handle.toLowerCase() === other.handle.toLowerCase()) return false;
  if (Math.abs(lead.postedAt.getTime() - other.postedAt.getTime()) > windowHours * HOUR) return false;
  const keys = (l: ConfirmFields) =>
    [l.company, l.companyHandle].filter((x): x is string => !!x).map((x) => normalizeCompanyKey(x).replace(/\s+/g, ""));
  const a = keys(lead);
  const b = keys(other);
  if (a.length === 0 || !a.some((k) => k && b.includes(k))) return false;
  if (lead.usdMillions !== null && other.usdMillions !== null) return near(lead.usdMillions, other.usdMillions);
  return lead.currency !== null && lead.currency === other.currency && near(lead.amountValue, other.amountValue);
}

/** An X profile's bio as Firecrawl's X scrape writes it: the lines between the "# Name (@handle)" heading and the stats list. */
export function bioFromProfile(markdown: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^#\s/.test(l));
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\s*-\s+(Followers|Following|Verified|Profile Picture|Source|Joined|Location|Website)\b/i.test(l) || /^#/.test(l)) break;
    if (l.trim()) out.push(l.trim());
  }
  return out.join(" ");
}

/** Role words in a bio that tie its owner to a company: "CEO @ Parallax", "co-founder of Acme", "building Acme". */
const ROLE = /\b(?:co-?founder|founder|ceo|cto|coo|cso|chief|president|founding|building|head of|partner at)\b|@\s/i;

/**
 * Whether a founder's X bio links the company: it names the company's domain or one of the X handles the
 * company's homepage links, or it names the company beside a role ("CEO @ Parallax"). A bio that only
 * mentions the name in passing does not count.
 */
export function bioLinksCompany(
  bio: string,
  company: { name: string | null; domain: string | null; handles: readonly string[]; links?: readonly string[] },
): boolean {
  const text = bio.toLowerCase();
  const domain = company.domain?.toLowerCase().replace(/^www\./, "") ?? null;
  if (domain && (text.includes(domain) || (company.links ?? []).some((u) => registrableDomain(u) === domain))) return true;
  if (company.handles.some((h) => new RegExp(`(^|[^\\w])@${h.toLowerCase()}(?![\\w])`).test(text))) return true;
  if (!company.name || !ROLE.test(bio)) return false;
  const name = company.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w])${name}(?![\\w])`).test(text);
}

const FOUNDER_ROLE = /\b(?:co-?founder|founder|ceo|cto|founding)\b/i;
const MENTION = /(?:^|[^\w@])@(\w{3,15})\b/g;

/**
 * The company a founder's post announces when no raise phrase names it ("we've raised $12.8M ... @TaskletAI
 * is built with ..."): the one account the author's bio gives them a founder's role at ("Founder & CEO of
 * @TaskletAI & @Shortwave") that the post also names. Null when the bio states no founder's role, or when
 * the post names none or several of the bio's accounts.
 */
export function companyFromFounderBio(bio: string, postText: string): { name: string; handle: string } | null {
  if (!FOUNDER_ROLE.test(bio)) return null;
  const inPost = new Set([...postText.matchAll(MENTION)].map((m) => m[1].toLowerCase()));
  const named = [...new Set([...bio.matchAll(MENTION)].map((m) => m[1]))].filter((h) => inPost.has(h.toLowerCase()));
  if (named.length !== 1) return null;
  const handle = named[0];
  const spelled = handle
    .replace(/^(?:official|get|try|join|use|the|hello|meet)(?=[A-Z_])/, "")
    .replace(/[_-]?(?:HQ|App|AI|Labs?|Inc|IO|Co|Team)$/, "");
  return { handle, name: companyFromHandle(handle, postText) ?? (spelled.length >= 3 ? spelled : handle) };
}

/** The note a founder-landed record carries: who posted, why the account is the company's, who confirmed it. */
export function founderLandedNote(lead: Pick<AnnouncementLead, "handle" | "companyHandle">, confirmedBy: readonly string[]): string {
  const why = `announced on X by @${lead.handle}, whose X bio links the company`;
  if (confirmedBy.length === 0)
    return `announced on X by @${lead.handle}, whose X bio names them a founder of @${lead.companyHandle}, the account the post names; no article confirms it yet`;
  return `${why}, and confirmed within ${X_CONFIRMATION_WINDOW_HOURS} hours by ${confirmedBy.map((h) => `@${h}`).join(", ")}; no article confirms it yet`;
}

/**
 * A post-only record as it is stored: unverified with the note that says what it rests on, and dated by the
 * page, not the text. The post's day is when it was posted, not a day the company stated for its round, so
 * the late re-report hold can still set it aside when the store knows the round from months before.
 */
export function xOnlyRecord<R extends { verification?: unknown; date_basis?: unknown }>(record: R, note: string, url: string): R {
  return { ...record, date_basis: "page", verification: { status: "unverified" as const, notes: [note], url } };
}

/** The note a post-only record carries, so a reader sees what it rests on. */
export function selfPublishedNote(lead: Pick<AnnouncementLead, "handle">): string {
  return `announced on X by @${lead.handle}, an account the company's own homepage links; no article confirms it yet`;
}
