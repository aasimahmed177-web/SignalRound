// Recent marketing roles a job seeker can act on today, from logged-out public sources: JobSpy (Indeed, LinkedIn
// jobs, Naukri, Bayt), remote-job boards with public feeds, and LinkedIn hiring posts. Each role lands in one of two
// lists: with an email the employer wrote in the posting (kept with the line it appears on), or with a link to apply.
// Emails are never guessed: an email is kept only when it appears verbatim in the text read from source_url.

import { readPublicText } from "@fireround/core/web/transport";
import { load } from "cheerio";
import type { ReadText } from "./job-boards.ts";
import { splitEmailIntent } from "./job-email-intent.ts";
import type { JobInput } from "./jobs.ts";
import { JOBSPY_SITES, type JobSpyRequest, type JobSpySite, searchJobSpy } from "./jobspy.ts";
import { collectLinkedInPosts, emailQuote, extractEmails, type LinkedInPost, pool } from "./linkedin-posts.ts";
import { type RemoteBoard, readRemoteBoards } from "./remote-boards.ts";

const DAY_MS = 86_400_000;

export interface MarketingJob {
  title: string;
  company: string;
  company_brief: string | null;
  location: string | null;
  remote: boolean | null;
  posted_at: string;
  source: string;
  source_url: string;
  apply_url: string;
  /** Inboxes the posting asks applications to be sent to. A role is "with email" only when this is non-empty. */
  emails: string[];
  /** Addresses the posting prints for something else (adjustments, questions, data protection), never for applying. */
  contact_only_emails?: string[];
  email_source_quote: string | null;
}

const MARKETING_TITLE =
  /\b(?:marketing|marketer|seo|sem|ppc|social media|social (?:manager|strategist|executive|lead|specialist|content|editor)|content (?:writer|marketing|marketer|strategist|strategy|creator|manager|executive|specialist|lead|editor|producer)|copy ?writ\w*|growth (?:marketing|marketer|manager|lead|hacker|specialist|associate|executive)|brand (?:manager|marketing|strategist|executive|specialist|lead|associate|director)|branding|media buy\w*|paid (?:media|search|social|ads|acquisition)|performance (?:marketing|marketer|media)|demand gen\w*|crm (?:marketing|executive|specialist|manager)|email (?:marketing|specialist)|influencer|community manager|affiliate (?:manager|specialist|executive)|digital media|cmo|user acquisition|campaign (?:manager|executive|specialist)|ugc)\b/i;
const NOT_MARKETING_TITLE =
  /\b(?:engineer\w*|developer|scientist|data analyst|software|programmer|sales (?:executive|representative|manager|associate|rep|officer|consultant|specialist|agent|coordinator)|account executive|tele-?market\w*|tele-?caller|network marketing|business development|field (?:sales|officer)|designer|accountant|recruiter|nurse|driver|teacher|tutor|technician|moderator|cashier|receptionist|insurance|loan|real estate agent|investment)\b/i;

/** A marketing role by its title: digital, performance/paid, SEO, social, content, growth, brand, email/CRM. */
export const isMarketingTitle = (title: string) => MARKETING_TITLE.test(title) && !NOT_MARKETING_TITLE.test(title);

// On a company's own board the team says more than the title ("Website Product Manager" in Marketing), and startup
// titles use growth/brand/comms words without "marketing". These count unless the title names another craft or a
// sales seat (a "Go To Market" team is mostly sales), or the team is sales/BD ("Director, Commercial Growth" in Business Development).
const MARKETING_TEAM =
  /\b(?:marketing|brand|content|communications?|comms|creative|demand gen\w*|growth marketing|public relations|pr|social)\b/i;
const MARKETING_TITLE_WORD =
  /\b(?:growth|brand|content|communications?|comms|creative|go[- ]to[- ]market|gtm|demand gen\w*|product[- ]led|public relations|pr)\b/i;
const NOT_MARKETING_TEAM = /\b(?:sales|business development|bd|commercial|partnerships?|engineering)\b/i;

// A product seat is not a marketing role even on a growth or marketing team ("Head of Product - Growth",
// "Website Product Manager", "Head of Product-Led Growth"); product marketing is.
const PRODUCT_SEAT =
  /\b(?:product (?:manager|owner|lead|director|management|designer|analyst)|head of product(?![- ]marketing)|(?:vp|vice president|director|chief)[,\s]+(?:of\s+)?product(?![- ]marketing)|product[- ]led|product\s*[-–—:|]\s*growth|growth product|product growth)\b/i;

/** A marketing role on a company's job board, by its title or its ATS department/team. */
export function isMarketingRole(title: string, department?: string | null): boolean {
  // A sales seat with a marketing word ("Sales cum CRM Executive") is still sales.
  if (PRODUCT_SEAT.test(title) || (/\bsales\b/i.test(title) && !/\bmarketing\b/i.test(title))) return false;
  if (isMarketingTitle(title)) return true;
  if (NOT_MARKETING_TITLE.test(title) || /\b(?:reviewer|moderat\w*|sales|accounts?|sdr|bdr|business development)\b/i.test(title))
    return false;
  if (department && MARKETING_TEAM.test(department)) return true;
  return MARKETING_TITLE_WORD.test(title) && !(department && NOT_MARKETING_TEAM.test(department));
}

// Addresses that are not for applications: platform mailboxes, privacy and accommodation desks, placeholders.
const SKIP_LOCAL =
  /^(?:no-?reply|do-?not-?reply|donotreply|privacy|accommodat\w*|accessibility|ada|eeo\w*|dpo|gdpr|data-?protection|legal|abuse|security|fraud|unsubscribe|webmaster|postmaster|example|test|your\w*|name|email|user|someone|support|help|billing|invoice\w*|feedback)$|accommodat|accessib|privacy|no-?reply|fraud|grievance|eeo|disabilit/i;
const SKIP_DOMAIN =
  /(?:^|\.)(?:example\.(?:com|org|net)|domain\.com|email\.com|company\.com|yourcompany\.com|indeed\.com|linkedin\.com|naukri\.com|glassdoor\.[a-z.]+|bayt\.com|himalayas\.app|jobicy\.com|remotive\.com|remoteok\.com|weworkremotely\.com|sentry\.io|wixpress\.com)$/i;
const SKIP_CONTEXT =
  /\b(?:accommodat\w*|disabilit\w*|privacy|data protection|personal data|gdpr|fraud\w*|scam\w*|phishing|impersonat\w*|unsolicited|suspicious|grievance|whistle\w*|unsubscribe|e\.g|for example|originat\w*|never ask|legitimate|authenticity|genuine|concerns?|issues? with|technical (?:issues?|difficult\w*)|trouble|(?:approved|recruit\w*|staffing|search) agenc\w*|agencies|vendors?)\b/i;

/** Markdown from JobSpy escapes characters ("hr\_team@x.com") and wraps emails in mailto links. */
export function plainText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\[([^\]]*)\]\(mailto:[^)]*\)/gi, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1")
    .replace(/\*\*|__/g, "");
}

function shorten(quote: string, email: string, max = 240): string {
  if (quote.length <= max) return quote;
  const at = quote.toLowerCase().indexOf(email.toLowerCase());
  const start = Math.max(0, at - Math.floor((max - email.length) / 2));
  const piece = quote.slice(start, start + max);
  return `${start > 0 ? "…" : ""}${piece.trim()}${start + max < quote.length ? "…" : ""}`;
}

/** Application emails written in a posting's text, and the line each appears on (verbatim). */
export function postingEmails(text: string): { emails: string[]; quote: string | null } {
  const body = plainText(text);
  const lower = body.toLowerCase();
  const emails: string[] = [];
  const quotes: string[] = [];
  for (const email of extractEmails(body)) {
    const [local = "", domain = ""] = email.split("@");
    if (!lower.includes(email) || SKIP_LOCAL.test(local) || SKIP_DOMAIN.test(domain)) continue;
    const quote = emailQuote(body, email);
    if (!quote || SKIP_CONTEXT.test(quote)) continue;
    emails.push(email);
    const short = shorten(quote, email);
    if (!quotes.some((q) => q.toLowerCase().includes(email))) quotes.push(short);
  }
  return { emails, quote: quotes.length ? quotes.join(" … ") : null };
}

const AGGREGATOR =
  /(?:^|\.)(?:indeed|linkedin|naukri|glassdoor|bayt|ziprecruiter|mycareersfuture|jobstreet|seek|reed|totaljobs|cv-library|dice|rozee|jobberman|careers24|pnet|himalayas|jobicy|remotive|remoteok|weworkremotely|google|jooble|monster|simplyhired|adzuna|talent|careerjet|shine|foundit|timesjobs|apna|bdjobs|hellowork|wellfound|lnkd|facebook|instagram|x|twitter)\.[a-z.]+$/i;
const ATS_HOST =
  /(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|bamboohr\.com|breezy\.hr|jobvite\.com|myworkdayjobs\.com|icims\.com|teamtailor\.com|personio\.\w+|rippling\.com|keka\.com|zohorecruit\.\w+|freshteam\.com|jazzhr\.com|applytojob\.com|pinpointhq\.com|dover\.com|recruitics\.com|successfactors\.\w+|taleo\.net|oraclecloud\.com)$/i;
const CAREER_PATH = /\/(?:careers?|jobs?|apply|join(?:-us)?|vacanc(?:y|ies)|openings|positions|hiring)(?:[/?#.-]|$)/i;
const NOT_APPLY_PATH = /(?:diversity|accommodat|privacy|legal|\/dei\b|benefits|candidate-privacy|fraud|terms|cookie)/i;

export const isAggregator = (url: string) => {
  try {
    return AGGREGATOR.test(new URL(url).hostname);
  } catch {
    return true;
  }
};

/** The employer's own apply page, careers page, or ATS posting among a posting's links; never a job board. */
export function employerLink(candidates: Array<string | null | undefined>, trusted?: string | null): string | null {
  if (trusted && /^https?:\/\//i.test(trusted) && !isAggregator(trusted)) return trusted;
  for (const raw of candidates) {
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw.replace(/[).,;]+$/, ""));
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || isAggregator(url.href) || NOT_APPLY_PATH.test(url.pathname)) continue;
    if (ATS_HOST.test(url.hostname) || CAREER_PATH.test(url.pathname) || /^(?:careers|jobs|apply)\./i.test(url.hostname)) {
      return url.href;
    }
  }
  return null;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NOT_BRIEF = /\b(?:hiring|looking for|seeking|equal opportunity|apply|candidate|you will|your role|this role|salary)\b/i;

function sentence(value: string | null | undefined): string | null {
  const line = value
    ?.replace(/[#*_>`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return null;
  const first = line.match(/^.{25,}?[.!?](?=\s|$)/)?.[0] ?? line;
  if (first.length < 25 || NOT_BRIEF.test(first)) return null;
  return first.length <= 220 ? first : `${first.slice(0, 217).replace(/\s+\S*$/, "")}…`;
}

/** One line on what the company does, from the board's company blurb or the posting's own "About us". */
export function companyBrief(company: string, text: string, metadata: Record<string, unknown> = {}): string | null {
  const given = sentence(typeof metadata.company_description === "string" ? metadata.company_description : null);
  if (given) return given;
  const body = plainText(text);
  const name = escapeRegex(company.replace(/\s+(?:pvt\.?|private|ltd\.?|limited|llc|inc\.?|gmbh|plc)\b.*$/i, "").trim());
  const about = body.match(
    new RegExp(
      String.raw`(?:^|\n)[^\S\n]*(?:about (?:us|the company|the organi[sz]ation|the business|the brand|the client|our client|${name})|who we are|company (?:overview|description|profile))[^\S\n]*[:\-–]?[^\S\n]*\n+[^\S\n]*([^\n]{25,})`,
      "i",
    ),
  )?.[1];
  const aboutLine = sentence(about);
  if (aboutLine) return aboutLine;
  const inline = body.match(
    new RegExp(
      String.raw`(?:^|[\n.!]\s*)((?:${name}|we|at ${name},? we)(?:\s*\([^)]*\))?\s+(?:is|are|'re)\s+(?:a|an|the|one of|india's|a leading|the leading)\b[^\n]{15,260})`,
      "i",
    ),
  )?.[1];
  const inlineLine = sentence(inline);
  if (inlineLine) return inlineLine;
  const industry = typeof metadata.company_industry === "string" ? metadata.company_industry.trim() : "";
  return industry && !/^(?:organi[sz]ation|company|other|others|n\/?a)$/i.test(industry) ? `Industry: ${industry}` : null;
}

const FREE_MAIL_HOST =
  /^(?:gmail|googlemail|yahoo|ymail|hotmail|outlook|live|icloud|me|aol|proton(?:mail)?|zoho|rediffmail|gmx|yandex|mail)\./i;
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** The company's own site, when an email domain or the apply link's host plainly carries the company's name. */
export function companySite(job: Pick<MarketingJob, "company" | "emails" | "apply_url">): string | null {
  const key = companyKey(job.company);
  const hosts = [...job.emails.map((email) => email.split("@")[1] ?? ""), ...(isAggregator(job.apply_url) ? [] : [hostOf(job.apply_url)])];
  for (const host of hosts) {
    if (!host || FREE_MAIL_HOST.test(host) || ATS_HOST.test(host)) continue;
    const base = host.replace(/^(?:www|careers|jobs|apply|hr|mail)\./, "");
    const stem = (base.split(".")[0] ?? "").replace(/[^a-z0-9]/g, "");
    const sameName = stem.length >= 3 && key.length >= 3 && (key.includes(stem) || stem.includes(key));
    if (sameName || (stem.length >= 6 && key.length >= 6 && key.slice(0, 6) === stem.slice(0, 6))) return `https://${base}/`;
  }
  return null;
}

const NOT_SITE_TEXT =
  /\b(?:cookies?|javascript|log ?in|sign ?in|not found|access denied|just a moment|captcha|coming soon|under construction)\b/i;

/** A company homepage's own one-line description (meta description or og:description). */
export function siteDescription(html: string): string | null {
  const $ = load(html);
  for (const selector of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) {
    const line = sentence($(selector).attr("content"));
    if (line && !NOT_SITE_TEXT.test(line)) return line;
  }
  return null;
}

const REMOTE = /\b(?:remote|work from home|wfh|anywhere)\b/i;

// Indian cities by state, with the suburbs postings name instead (a suburb counts as its metro).
const INDIAN_CITIES: Array<[city: string, state: RegExp, names: RegExp]> = [
  ["Mumbai", /^(?:mh|maharashtra)$/i, /\b(?:mumbai|bombay|navi mumbai|thane|andheri|powai|bandra|lower parel|goregaon|malad|vashi|bkc)\b/i],
  ["Pune", /^(?:mh|maharashtra)$/i, /\b(?:pune|hinjewadi|kharadi|pimpri|chinchwad)\b/i],
  ["Nagpur", /^(?:mh|maharashtra)$/i, /\bnagpur\b/i],
  ["Nashik", /^(?:mh|maharashtra)$/i, /\bnashik\b/i],
  ["Aurangabad", /^(?:mh|maharashtra)$/i, /\b(?:aurangabad|sambhajinagar)\b/i],
  ["Kolhapur", /^(?:mh|maharashtra)$/i, /\bkolhapur\b/i],
  ["Bengaluru", /^(?:ka|karnataka)$/i, /\b(?:bengaluru|bangalore|whitefield|koramangala|indiranagar|hsr layout|electronic city)\b/i],
  ["Mysuru", /^(?:ka|karnataka)$/i, /\b(?:mysuru|mysore)\b/i],
  ["Mangaluru", /^(?:ka|karnataka)$/i, /\b(?:mangaluru|mangalore)\b/i],
  ["Hubballi", /^(?:ka|karnataka)$/i, /\b(?:hubballi|hubli|dharwad)\b/i],
  ["Chennai", /^(?:tn|tamil nadu)$/i, /\bchennai\b/i],
  ["Coimbatore", /^(?:tn|tamil nadu)$/i, /\bcoimbatore\b/i],
  ["Hyderabad", /^(?:ts|tg|telangana)$/i, /\b(?:hyderabad|secunderabad)\b/i],
  ["Ahmedabad", /^(?:gj|gujarat)$/i, /\b(?:ahmedabad|gandhinagar)\b/i],
  ["Surat", /^(?:gj|gujarat)$/i, /\bsurat\b/i],
  ["Vadodara", /^(?:gj|gujarat)$/i, /\b(?:vadodara|baroda)\b/i],
  ["Kolkata", /^(?:wb|west bengal)$/i, /\b(?:kolkata|calcutta|salt lake)\b/i],
  ["Delhi", /^(?:dl|delhi)$/i, /\b(?:new delhi|delhi)\b/i],
  ["Gurugram", /^(?:hr|haryana)$/i, /\b(?:gurugram|gurgaon)\b/i],
  ["Noida", /^(?:up|uttar pradesh)$/i, /\b(?:noida|greater noida)\b/i],
  ["Lucknow", /^(?:up|uttar pradesh)$/i, /\blucknow\b/i],
  ["Jaipur", /^(?:rj|rajasthan)$/i, /\bjaipur\b/i],
  ["Kochi", /^(?:kl|kerala)$/i, /\b(?:kochi|cochin|kakkanad)\b/i],
  ["Thiruvananthapuram", /^(?:kl|kerala)$/i, /\b(?:thiruvananthapuram|trivandrum)\b/i],
  ["Bhubaneswar", /^(?:or|od|odisha|orissa)$/i, /\bbhubaneswar\b/i],
  ["Guwahati", /^(?:as|assam)$/i, /\bguwahati\b/i],
  ["Indore", /^(?:mp|madhya pradesh)$/i, /\bindore\b/i],
  ["Bhopal", /^(?:mp|madhya pradesh)$/i, /\bbhopal\b/i],
];
const STATE_ONLY = /^\s*([A-Za-z ]+?)\s*,\s*(?:India|IN)\s*$/;
const LOCATION_LINE = /\b(?:job |work |office )?location\s*[:\-–]\s*([^\n.;|]{1,120})|\bbased (?:in|out of)\s+([^\n.]{1,80})/gi;

/**
 * Indeed often gives only the state ("MH, India"); the posting's text names the city. Only a city of that state counts,
 * from a "Location:" line first, else the whole text, and only when one city is named (an office list stays as it is),
 * so a Nagpur role never passes as Mumbai. "MH, India" + "Location: Andheri East" → "Mumbai, MH, India".
 */
export function resolveLocation(location: string | null, text: string): string | null {
  const state = location?.match(STATE_ONLY)?.[1];
  const cities = state ? INDIAN_CITIES.filter(([, pattern]) => pattern.test(state)) : [];
  if (!cities.length) return location;
  const named = (part: string) => new Set(cities.filter(([, , names]) => part.match(names)).map(([city]) => city));
  const lines = [...plainText(text).matchAll(LOCATION_LINE)].map((m) => m[1] ?? m[2] ?? "").join("\n");
  for (const part of [lines, plainText(text)]) {
    const found = named(part);
    if (found.size === 1) return `${[...found][0]}, ${location?.trim()}`;
    if (found.size > 1) return location;
  }
  return location;
}
const sourceName = (source: string) => source.replace(/^jobspy-/, "");

/** A posting in the job contract → a marketing role in the window, or the reason it was dropped. */
export function toMarketingJob(job: JobInput, since: Date, now: Date): MarketingJob | string {
  const posted = job.posted_at ? new Date(job.posted_at) : null;
  if (!posted || Number.isNaN(posted.getTime())) return "no posting date";
  if (posted < since) return "older than the window";
  if (posted.getTime() > now.getTime() + DAY_MS) return "dated in the future";
  if (!isMarketingTitle(job.title)) return "not a marketing role";
  const metadata = job.metadata ?? {};
  const text = job.description ?? "";
  const { emails: found, quote } = postingEmails(text);
  const { apply: emails, contactOnly } = splitEmailIntent(found, quote);
  const links = [
    ...(Array.isArray(metadata.links) ? (metadata.links as string[]) : []),
    ...(plainText(text).match(/https?:\/\/[^\s<>()"'\]]+/g) ?? []),
  ];
  const direct = typeof metadata.apply_url === "string" ? metadata.apply_url : null;
  return {
    title: job.title.trim(),
    company: job.company.trim(),
    company_brief: companyBrief(job.company, text, metadata),
    location: resolveLocation(job.location ?? null, text),
    remote: job.remote || REMOTE.test(`${job.title} ${job.location ?? ""}`) ? true : (job.remote ?? null),
    posted_at: posted.toISOString(),
    source: sourceName(job.source),
    source_url: job.url,
    apply_url: employerLink(links, direct) ?? direct ?? job.url,
    emails,
    contact_only_emails: contactOnly,
    email_source_quote: found.length ? quote : null,
  };
}

export function fromLinkedInPost(post: LinkedInPost): MarketingJob {
  const company = post.company ?? post.author;
  // Every email's own line, so the quote shows each address the post gives.
  const quote =
    [...new Set(post.emails.map((email) => emailQuote(post.post_text, email) ?? ""))].filter(Boolean).join(" … ") ||
    post.email_source_quote;
  const { apply, contactOnly } = splitEmailIntent(post.emails, quote);
  return {
    title: post.role,
    company,
    company_brief: companyBrief(company, post.post_text),
    location: post.location,
    remote: REMOTE.test(`${post.role} ${post.location ?? ""}`) ? true : null,
    posted_at: post.posted_at,
    source: "linkedin-post",
    source_url: post.post_url,
    apply_url: employerLink(post.post_text.match(/https?:\/\/[^\s<>()"'\]]+/g) ?? []) ?? post.post_url,
    emails: apply,
    contact_only_emails: contactOnly,
    email_source_quote: quote,
  };
}

const LEGAL = /\b(?:pvt|private|ltd|limited|llc|l\.l\.c|inc|corp|corporation|co|company|gmbh|plc|llp|fze|fzco|the|group)\b/g;
export const companyKey = (company: string) =>
  company
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(LEGAL, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
const TITLE_NOISE =
  /\b(?:urgent(?:ly)?|hiring|required|requirement|opening|walk-?in|immediate(?:ly)?|joiner|remote|hybrid|onsite|on-site|full[- ]time|part[- ]time|wfh|work from home|f\/m\/d|m\/f\/d|m\/w\/d)\b|\([^)]*\)|\[[^\]]*\]/gi;
export function titleTokens(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(TITLE_NOISE, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => ({ sr: "senior", jr: "junior", mgr: "manager", exec: "executive", mktg: "marketing" })[word] ?? word)
    .filter((word) => word.length > 1 && !["and", "the", "for", "of", "in", "at", "to", "with"].includes(word));
  return new Set(words);
}
export function similarTitles(a: string, b: string): boolean {
  const x = titleTokens(a);
  const y = titleTokens(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((word) => y.has(word)).length;
  return shared / new Set([...x, ...y]).size >= 0.75 || (shared === Math.min(x.size, y.size) && shared >= 2);
}

const rank = (job: MarketingJob) =>
  (job.emails.length ? 8 : 0) + (isAggregator(job.apply_url) ? 0 : 4) + (job.company_brief ? 2 : 0) + (job.location ? 1 : 0);

/**
 * One record per role: the same company (or the same email) with a similar title is one opening seen on several
 * sources. Keeps the version with an email, then the employer's own link; borrows an employer link from a duplicate.
 */
export function dedupeMarketingJobs(jobs: MarketingJob[]): MarketingJob[] {
  const groups: MarketingJob[][] = [];
  const byKey = new Map<string, MarketingJob[][]>();
  for (const job of jobs) {
    const keys = [`c:${companyKey(job.company)}`, ...job.emails.map((email) => `e:${email}`)];
    const group = keys
      .flatMap((key) => byKey.get(key) ?? [])
      .find((candidates) => candidates.some((other) => similarTitles(other.title, job.title)));
    const target = group ?? [];
    if (!group) groups.push(target);
    target.push(job);
    for (const key of keys) {
      const list = byKey.get(key) ?? [];
      if (!list.includes(target)) list.push(target);
      byKey.set(key, list);
    }
  }
  return groups.map((group) => {
    const sorted = [...group].sort((a, b) => rank(b) - rank(a) || b.posted_at.localeCompare(a.posted_at));
    const best = { ...(sorted[0] as MarketingJob) };
    const own = sorted.find((job) => !isAggregator(job.apply_url));
    if (own && isAggregator(best.apply_url)) best.apply_url = own.apply_url;
    best.company_brief ??= sorted.find((job) => job.company_brief)?.company_brief ?? null;
    best.location ??= sorted.find((job) => job.location)?.location ?? null;
    return best;
  });
}

const INDEED_COUNTRIES = [
  "india",
  "usa",
  "uk",
  "united arab emirates",
  "canada",
  "australia",
  "singapore",
  "pakistan",
  "philippines",
  "nigeria",
  "south africa",
  "malaysia",
];
const TERMS = [
  "digital marketing",
  "marketing executive",
  "marketing manager",
  "social media",
  "seo",
  "performance marketing",
  "content marketing",
  "content writer",
  "brand manager",
  "marketing intern",
  "email marketing",
  "growth marketing",
];

/** The JobSpy searches behind a marketing run: Indeed per country, plus LinkedIn, Naukri and Bayt with descriptions. */
export function marketingSearches(days: number): JobSpyRequest[] {
  const hoursOld = days * 24;
  const indeed = INDEED_COUNTRIES.flatMap((country) =>
    TERMS.map((search) => ({ search, country, sites: ["indeed"] as JobSpySite[], hoursOld, results: 60 })),
  );
  const linkedin = ["India", "United States", "United Kingdom", "United Arab Emirates"].flatMap((location) =>
    ["digital marketing", "social media manager", "seo", "marketing executive", "content marketing"].map((search) => ({
      search,
      location,
      sites: ["linkedin"] as JobSpySite[],
      hoursOld,
      results: 30,
      fullDescriptions: true,
    })),
  );
  const naukri = TERMS.slice(0, 9).map((search) => ({
    search,
    location: "India",
    sites: ["naukri"] as JobSpySite[],
    hoursOld,
    results: 60,
    fullDescriptions: true,
  }));
  const bayt = ["marketing", "digital marketing", "social media"].map((search) => ({
    search,
    sites: ["bayt"] as JobSpySite[],
    hoursOld,
    results: 40,
    fullDescriptions: true,
  }));
  return [...indeed, ...linkedin, ...naukri, ...bayt];
}

export interface MarketingRun {
  generated_at: string;
  window_days: number;
  with_email: MarketingJob[];
  apply_link: MarketingJob[];
}

export interface MarketingOptions {
  days: number;
  now?: Date;
  /** JobSpy searches; false skips JobSpy. */
  searches?: JobSpyRequest[] | false;
  sites?: readonly JobSpySite[];
  boards?: readonly RemoteBoard[] | false;
  /** LinkedIn hiring posts: search Exa and re-verify these known post URLs. false skips them. */
  linkedinPosts?: { seeds?: string[]; search?: boolean } | false;
  /** Read company homepages for a brief when the posting has none: at most this many sites (default 800); false skips. */
  siteBriefs?: number | false;
  read?: ReadText;
  log?: (message: string) => void;
}

/** Fills missing company briefs from the company's own homepage; roles with an email first. Returns how many. */
export async function addSiteBriefs(jobs: MarketingJob[], read?: ReadText, limit = 800): Promise<number> {
  const reader: ReadText =
    read ?? ((url, options) => readPublicText(url, { timeoutMs: options?.timeoutMs ?? 10_000, maxBytes: 1_500_000 }));
  const sites = new Map<string, MarketingJob[]>();
  const ordered = [...jobs.filter((job) => job.emails.length), ...jobs.filter((job) => !job.emails.length)];
  for (const job of ordered) {
    const site = job.company_brief ? null : companySite(job);
    if (site && (sites.has(site) || sites.size < limit)) sites.set(site, [...(sites.get(site) ?? []), job]);
  }
  const briefs = await pool([...sites.keys()], 8, async (site) => {
    try {
      const page = await reader(site, { timeoutMs: 10_000 });
      return page.status < 400 ? siteDescription(page.text) : null;
    } catch {
      return null;
    }
  });
  let filled = 0;
  [...sites.values()].forEach((list, index) => {
    const brief = briefs[index];
    if (!brief) return;
    for (const job of list) job.company_brief = brief;
    filled += list.length;
  });
  return filled;
}

export async function collectMarketingJobs(options: MarketingOptions): Promise<{ run: MarketingRun; stats: Record<string, number> }> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - options.days * DAY_MS);
  const log = options.log ?? (() => {});
  const stats: Record<string, number> = {};
  const count = (key: string, by = 1) => {
    stats[key] = (stats[key] ?? 0) + by;
  };
  const sites = options.sites ?? JOBSPY_SITES;
  const searches = (options.searches === false ? [] : (options.searches ?? marketingSearches(options.days))).filter((request) =>
    (request.sites ?? []).every((site) => sites.includes(site)),
  );
  // LinkedIn throttles bursts, so its searches run one at a time beside the rest.
  const [slow, fast] = [searches.filter((r) => r.sites?.includes("linkedin")), searches.filter((r) => !r.sites?.includes("linkedin"))];
  const runSearch = async (request: JobSpyRequest): Promise<JobInput[]> => {
    try {
      const { jobs } = await searchJobSpy(request, 600_000);
      count(`jobspy:${request.sites?.join("+")}`, jobs.length);
      return jobs;
    } catch (error) {
      count("jobspy_failed");
      log(
        `jobspy failed: ${request.sites?.join(",")} "${request.search}" ${request.country ?? request.location ?? ""} (${(error as Error).message.slice(0, 160)})`,
      );
      return [];
    }
  };
  const [jobspyFast, jobspySlow, boards, posts] = await Promise.all([
    pool(fast, 5, runSearch).then((lists) => lists.flat()),
    pool(slow, 1, runSearch).then((lists) => lists.flat()),
    options.boards === false ? [] : readRemoteBoards(since, { boards: options.boards, log }),
    options.linkedinPosts === false
      ? { posts: [], stats: {} }
      : collectLinkedInPosts({
          days: options.days,
          now,
          seeds: options.linkedinPosts?.seeds,
          ...(options.linkedinPosts?.search === false ? { urls: options.linkedinPosts.seeds ?? [] } : {}),
          log,
        }).catch((error: Error) => {
          log(`linkedin posts failed: ${error.message}`);
          return { posts: [] as LinkedInPost[], stats: {} };
        }),
  ]);
  log(`jobspy: ${jobspyFast.length + jobspySlow.length} posting(s) from ${searches.length} searches; boards: ${boards.length}`);
  for (const [key, value] of Object.entries(posts.stats)) count(`linkedin_posts:${key}`, value);
  const roles: MarketingJob[] = posts.posts.map(fromLinkedInPost);
  for (const job of [...jobspyFast, ...jobspySlow, ...boards]) {
    const role = toMarketingJob(job, since, now);
    if (typeof role === "string") count(`dropped:${role}`);
    else roles.push(role);
  }
  const kept = dedupeMarketingJobs(roles).sort((a, b) => b.posted_at.localeCompare(a.posted_at));
  if (options.siteBriefs !== false) stats.briefs_from_sites = await addSiteBriefs(kept, options.read, options.siteBriefs);
  stats.candidates = roles.length;
  stats.duplicates = roles.length - kept.length;
  const run: MarketingRun = {
    generated_at: now.toISOString(),
    window_days: options.days,
    with_email: kept.filter((job) => job.emails.length),
    apply_link: kept.filter((job) => !job.emails.length),
  };
  stats.with_email = run.with_email.length;
  stats.apply_link = run.apply_link.length;
  return { run, stats };
}
