// Recently funded companies that are hiring right now: each company from a funded-founders run, its open roles read
// from its own job board (a supported ATS, or a careers page that lists roles), and the marketing roles among them.
// Logged out; contacts carry only emails posted publicly, with the page and the words around them.

import { readPublicText } from "@fireround/core/web/transport";
import { load } from "cheerio";
import { articleText, type FundedCompany, type FundedRun, isOutreachEmail, posted } from "./funded-founders.ts";
import {
  cardQuote,
  classifyEmail,
  emailNamesPerson,
  type FounderMention,
  foundersFromTeamPage,
  foundersFromText,
  type InboxType,
  leadersFromText,
  linkOnlyQuote,
  pageEmails,
  pageText,
  quoteNamesPerson,
  rootDomain,
} from "./funding-parse.ts";

export { cardQuote, emailNamesPerson, leadersFromText };

import { careerLinks, type ReadText } from "./job-boards.ts";
import { scanCompanies } from "./job-collector.ts";
import type { ParsedJob } from "./jobs.ts";
import { searchJobSpy } from "./jobspy.ts";
import { pool } from "./linkedin-posts.ts";
import { companyKey, isMarketingRole, postingEmails, similarTitles } from "./marketing-jobs.ts";

/** An email printed on a public page, with that page and the words around it. */
export interface PostedEmail {
  email: string;
  source_url: string;
  quote: string;
}
export interface HiringRole {
  title: string;
  url: string;
  location: string | null;
  department: string | null;
  /** Full-time, part-time, contract or internship, as the ATS or the posting's JobPosting data states it. */
  employment_type: string | null;
  /** The pay the ATS publishes, or the range the posting itself prints (verbatim). */
  salary: string | null;
  /** Read from the title's words (intern, junior, senior, lead, head, director, VP, C-level); null when it names none. */
  seniority: string | null;
  posted_at: string | null;
  /**
   * Where posted_at was read: the ATS feed, the job page's JobPosting data or published-date meta, the site's sitemap
   * (the page's lastmod), the same role's Indeed/LinkedIn listing, or "first-seen": a daily watch poll found it new on a
   * board that an earlier post-announcement poll had read without it, so it was created after the round.
   */
  posted_at_source: "ats" | "job-page" | "sitemap" | "indeed" | "linkedin" | "first-seen" | null;
  /** Days from the funding announcement to the posting: negative means it was posted before the round. */
  days_after_funding: number | null;
  /** Posted before the round was announced: an older opening, not a hire the money is paying for. */
  pre_funding: boolean | null;
  /** Addresses the job page (or the careers page) prints for applications, e.g. hiring@ or jobs@. */
  application_emails: PostedEmail[];
  /**
   * Set when this listing's description matches an opening the company posted before the round (on its board or a job
   * site): a repost, dated by that earlier posting and not counted as a post-funding hire.
   */
  repost_of?: string;
}
export interface HiringFounder {
  name: string;
  /** CEO, co-founder, founder or managing director, as the page titles them. */
  role: string;
  /** Where the title was printed, and the words that say it. */
  source_url: string;
  quote: string;
  emails: PostedEmail[];
}
export interface HiringCompany {
  company: string;
  website: string;
  industry: string;
  stage: string;
  amount: string | null;
  announced_on: string;
  funding_source_url: string;
  founders: HiringFounder[];
  company_emails: Array<PostedEmail & { inbox: InboxType }>;
  boards: Array<{ ats: string; board_url: string; match?: JobSiteMatch }>;
  open_roles: number;
  /** Marketing roles posted on or after the announcement day: the hires the round is paying for. */
  marketing_jobs: HiringRole[];
  /** Marketing roles posted before the round was announced: older openings, kept for reference only. */
  pre_funding_marketing_jobs: HiringRole[];
  /** The address to write to first: a founder/CEO's own, then a role's application address, then founders@/careers@. */
  best_contact: BestContact | null;
}
export interface BestContact extends PostedEmail {
  /** "Ana Example (CEO)", "application email for Head of Marketing", or the inbox kind ("founders", "careers"). */
  who: string;
}
/** Polled daily for 30 days after the announcement: new roles on the company's board are dated by the poll that found them. */
export interface WatchedCompany {
  funded: FundedCompany;
  watch_until: string;
  polls: Array<{ at: string; roles_from: string; open_roles: number }>;
  roles: Record<string, { title: string; first_seen: string; last_seen: string }>;
}
export interface WatchState {
  updated_at: string;
  companies: Record<string, WatchedCompany>;
}
/** How a job-site listing was tied to the company: its exact name, and whether a posting also names its domain. */
export type JobSiteMatch = "name+domain" | "name";
/** Where each scanned company's roles were looked for, and what was found. */
export interface CompanyCoverage {
  company: string;
  website: string;
  roles_from: string;
  open_roles: number;
  marketing_roles: number;
  marketing_roles_after_funding: number;
  /** In `companies` (a marketing role posted after the round), demoted, or why it went to `other_companies`. */
  outcome:
    | "kept: marketing role posted after funding"
    | "demoted: marketing roles predate the round"
    | "demoted: hiring contact, no marketing role after funding"
    | "no open roles found"
    | "no marketing role and no founder or hiring email";
}
export interface HiringRun {
  generated_at: string;
  stats: Record<string, number>;
  /** Leads: companies with a marketing role posted on or after the day the round was announced. */
  companies: HiringCompany[];
  /** No marketing role since the round: only older (pre-funding) marketing roles, or a founder/hiring email alone. */
  demoted_companies: Array<HiringCompany & { demoted_because: string }>;
  /** Hiring, but no marketing opening and only general/press/sales inboxes: kept apart, not leads. */
  other_companies: Array<Pick<HiringCompany, "company" | "website" | "boards" | "open_roles">>;
  /**
   * Marketing roles with no posting date (no ATS date, JobPosting date, sitemap lastmod, job-site listing or watch poll),
   * or only a sitemap lastmod after the round (an edit date, not a posting date): not counted either way.
   */
  undated_marketing_roles: Array<{ company: string; title: string; url: string; reason: string }>;
  coverage: CompanyCoverage[];
}

const USER_AGENT = "SignalRound/0.2 (+https://github.com/aasimahmed177-web/SignalRound)";
const ROLE_WORD =
  /\b(?:manager|engineer|developer|designer|lead|head|director|specialist|associate|intern(?:ship)?|analyst|executive|marketer|coordinator|officer|consultant|representative|scientist|architect|administrator|writer|strategist|vp|chief|recruiter|accountant|technician|operator|copywriter|editor|researcher|advisor|assistant|controller|counsel|nurse|physician|product owner)\b/i;
const JOB_PATH = /\/(?:careers?|jobs?|positions?|openings?|vacanc(?:y|ies)|roles?|join-us|opportunities)\/[^/?#]+/i;
// Hosted job pages we do not read as feeds, but whose links name a role at this company.
const OTHER_ATS =
  /(?:^|\.)(?:teamtailor\.com|personio\.(?:de|com)|breezy\.hr|myworkdayjobs\.com|jobvite\.com|zohorecruit\.\w+|keka\.com|freshteam\.com|homerun\.co|join\.com|pinpointhq\.com|rippling\.com|workatastartup\.com|wellfound\.com|darwinbox\.in)$/i;

const text = (value: string) => value.replace(/\s+/g, " ").trim();
const str = (value: unknown) => (typeof value === "string" && value.trim() ? text(value) : null);
const num = (value: unknown) =>
  typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

const EMPLOYMENT: Array<[RegExp, string]> = [
  [/intern/i, "Internship"],
  [/part[\s_-]?time/i, "Part-time"],
  [/full[\s_-]?time|permanent|festanstellung/i, "Full-time"],
  [/contract|freelance/i, "Contract"],
  [/temp/i, "Temporary"],
];

/** "FullTime", "FULL_TIME", "Full-time" → "Full-time"; anything else is kept as the ATS wrote it. */
export function employmentType(value: unknown): string | null {
  const raw = [value].flat().map(str).filter(Boolean).join(", ");
  if (!raw) return null;
  for (const [pattern, label] of EMPLOYMENT) if (pattern.test(raw)) return label;
  return raw;
}

const SENIORITY: Array<[RegExp, string]> = [
  [/\b(?:chief|cmo|cxo)\b/i, "C-level"],
  [/\b(?:vp|svp|evp|vice president)\b/i, "VP"],
  [/\bhead\b/i, "Head"],
  [/\bdirector\b/i, "Director"],
  [/\b(?:intern(?:ship)?|trainee|working student|werkstudent\w*|apprentice)\b/i, "Intern"],
  [/\b(?:lead(?![\s-]*gen)|principal|staff)\b/i, "Lead"],
  [/\b(?:senior|sr)\b/i, "Senior"],
  [/\b(?:junior|jr|entry[- ]level|graduate)\b/i, "Junior"],
];

/** The level a title names; null when it names none (a plain "Marketing Manager" is not guessed). */
export function seniorityOf(title: string): string | null {
  for (const [pattern, label] of SENIORITY) if (pattern.test(title)) return label;
  return null;
}

const CURRENCY = String.raw`(?:[$€£₹]|USD|EUR|GBP|INR|CHF|CAD|AUD|SGD)`;
const AMOUNT = String.raw`\d{1,3}(?:[,.]\d{3})*(?:\.\d+)?\s?[kK]?`;
const SALARY_RANGE = new RegExp(
  String.raw`${CURRENCY}\s?${AMOUNT}\s*(?:-|–|—|to)\s*${CURRENCY}?\s?${AMOUNT}(?:\s*${CURRENCY})?(?:\s*(?:LPA|lakhs?|per year|per annum|annually|a year|\/\s?(?:year|yr|annum)|p\.a\.|OTE))?`,
  "u",
);

/** The pay range a posting prints, verbatim ("$140,000 - $180,000 per year"); small or bare numbers are ignored. */
export function salaryFromText(body: string | null | undefined): string | null {
  const match = body ? SALARY_RANGE.exec(body) : null;
  if (!match) return null;
  const value = text(match[0]);
  const first = Number((/\d[\d,.]*/.exec(value)?.[0] ?? "").replace(/[,.](?=\d{3}\b)/g, ""));
  return first >= 1000 || /\d\s?k\b|lpa|lakh/i.test(value) ? value : null;
}

function jsonLdSalary(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return str(String(value));
  const amount = (value ?? {}) as Record<string, unknown>;
  const inner = (typeof amount.value === "object" && amount.value ? amount.value : amount) as Record<string, unknown>;
  const min = num(inner.minValue ?? (typeof amount.value === "object" ? undefined : amount.value) ?? inner.value);
  const max = num(inner.maxValue);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return null;
  const range = [min, max].filter(Number.isFinite).join("–");
  const unit = str(inner.unitText);
  return text(`${str(amount.currency) ?? ""} ${range}${unit ? ` per ${unit.toLowerCase()}` : ""}`);
}

/** A role with the fields a source left out set to null. */
function newRole(fields: Partial<HiringRole> & { title: string; url: string }): HiringRole {
  return {
    location: null,
    department: null,
    employment_type: null,
    salary: null,
    seniority: seniorityOf(fields.title),
    posted_at: null,
    posted_at_source: fields.posted_at ? "ats" : null,
    days_after_funding: null,
    pre_funding: null,
    application_emails: [],
    ...fields,
  };
}

function jsonLdRoles(html: string, pageUrl: string): HiringRole[] {
  const $ = load(html);
  const roles: HiringRole[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const item = node as Record<string, unknown>;
    if (item["@graph"]) walk(item["@graph"]);
    const type = item["@type"];
    if (!(type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting")))) return;
    const title = str(item.title);
    if (!title) return;
    const place = [item.jobLocation].flat()[0] as Record<string, unknown> | undefined;
    const address = (place?.address ?? {}) as Record<string, unknown>;
    const posted = str(item.datePosted);
    roles.push(
      newRole({
        title,
        url: new URL(str(item.url) ?? pageUrl, pageUrl).href,
        location: [str(address.addressLocality), str(address.addressCountry)].filter(Boolean).join(", ") || null,
        employment_type: employmentType(item.employmentType),
        salary: jsonLdSalary(item.baseSalary),
        posted_at: posted && !Number.isNaN(Date.parse(posted)) ? new Date(posted).toISOString() : null,
        posted_at_source: posted && !Number.isNaN(Date.parse(posted)) ? "job-page" : null,
      }),
    );
  };
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      walk(JSON.parse($(element).text()));
    } catch {}
  });
  return roles;
}

const ROLE_LIST = /(?:^|[\s_-])(?:roles?|jobs?|positions?|openings?|vacanc\w*|postings?)(?:$|[\s_-])/i;

/**
 * A same-site link inside the careers page's list of openings ("/marketing-lead" in <ul class="careers-roles__list">),
 * or one labelled "View role"/"Apply": role pages do not always sit under /careers or /jobs.
 */
function inRoleList($: ReturnType<typeof load>, anchor: ReturnType<ReturnType<typeof load>>): boolean {
  if (/\b(?:view|see) (?:role|job|position|opening)|\bapply\b/i.test(anchor.attr("aria-label") ?? "")) return true;
  return anchor
    .parents()
    .slice(0, 4)
    .toArray()
    .some((parent) => ROLE_LIST.test(`${$(parent).attr("class") ?? ""} ${$(parent).attr("id") ?? ""}`));
}

/** Roles a careers page lists: JobPosting data, or links to a role on the company's site or a hosted job page. */
export function careersPageRoles(html: string, pageUrl: string): HiringRole[] {
  const roles = jsonLdRoles(html, pageUrl);
  if (roles.length) return roles;
  const $ = load(html);
  const site = hostOf(pageUrl);
  const page = new URL(pageUrl);
  $("a[href]").each((_, element) => {
    let url: URL;
    try {
      url = new URL($(element).attr("href") ?? "", pageUrl);
    } catch {
      return;
    }
    url.hash = "";
    const host = hostOf(url.href);
    const ours = host === site || host.endsWith(`.${site}`);
    if (!/^https?:$/.test(url.protocol) || url.pathname.replace(/\/$/, "") === page.pathname.replace(/\/$/, "")) return;
    const anchor = $(element);
    if (!(ours ? JOB_PATH.test(url.pathname) || inRoleList($, anchor) : OTHER_ATS.test(host))) return;
    // A card often packs department, title and location into one link: take its heading, else the part naming a role.
    const parts = anchor
      .find("*")
      .toArray()
      .filter((part) => !$(part).children().length)
      .map((part) => text($(part).text()));
    const title =
      text(anchor.find("h1,h2,h3,h4,h5,h6,strong").first().text()) || parts.find((part) => ROLE_WORD.test(part)) || text(anchor.text());
    if (title.length < 4 || title.length > 100 || !ROLE_WORD.test(title) || roles.some((role) => role.url === url.href)) return;
    roles.push(newRole({ title, url: url.href }));
  });
  return roles;
}

const HTML_HEADERS = { "user-agent": USER_AGENT, accept: "text/html,*/*" };

async function readHtml(read: ReadText, url: string, timeoutMs = 15_000): Promise<{ url: string; html: string } | null> {
  try {
    const response = await read(url, { timeoutMs, headers: HTML_HEADERS });
    if (response.status >= 400 || !/<(?:!doctype|[a-z][a-z0-9]*)[\s>]/i.test(response.text.slice(0, 5000))) return null;
    return { url: response.url, html: response.text };
  } catch {
    return null;
  }
}

/** A careers page on the company's own site that lists roles, when it has no supported ATS board. */
export async function careersPage(website: string, read: ReadText): Promise<{ board_url: string; roles: HiringRole[] } | null> {
  const get = async (url: string) => {
    try {
      const response = await read(url, { timeoutMs: 15_000, headers: HTML_HEADERS });
      return response.status < 400 ? response : null;
    } catch {
      return null;
    }
  };
  const home = await get(website);
  const candidates = home ? careerLinks(home.text, home.url).slice(0, 2) : [];
  for (const path of ["/careers", "/jobs"]) candidates.push(new URL(path, home?.url ?? website).href);
  for (const url of [...new Set(candidates)].slice(0, 4)) {
    const response = await get(url);
    if (!response) continue;
    const roles = careersPageRoles(response.text, response.url);
    if (roles.length) return { board_url: response.url, roles };
  }
  return null;
}

/** Pages are read more than once (board search, careers fallback, contact pages), so HTML reads are kept for the run. */
function cachedRead(read: ReadText): ReadText {
  const pages = new Map<string, ReturnType<ReadText>>();
  return (url, options) => {
    if (!options?.headers?.accept?.startsWith("text/html")) return read(url, options);
    let page = pages.get(url);
    if (!page) {
      page = read(url, options);
      pages.set(url, page);
    }
    return page;
  };
}

/** When a role was posted against the funding announcement, by calendar day (an undated role stays unknown). */
function datedAgainst(role: HiringRole, announcedOn: string): HiringRole {
  const announced = Date.parse(announcedOn.slice(0, 10));
  if (!role.posted_at || Number.isNaN(announced)) return role;
  const days = Math.floor((Date.parse(role.posted_at.slice(0, 10)) - announced) / 86_400_000);
  // A sitemap lastmod is the page's last edit: before the round it proves an older role, after it proves nothing.
  if (role.posted_at_source === "sitemap" && days >= 0) return { ...role, days_after_funding: days, pre_funding: null };
  return { ...role, days_after_funding: days, pre_funding: days < 0 };
}

// ---- Who to write to: founders, CEOs and managing directors the company's pages name, with the emails they print ----

const SITE_PATHS = [
  "/about",
  "/about-us",
  "/team",
  "/company",
  "/imprint",
  "/impressum",
  "/legal-notice",
  "/contact",
  "/contact-us",
  "/press-kit",
];
const SITE_LINK = /about|team|founder|leadership|people|company|imprint|impressum|legal-notice|legal|kontakt|contact|press/i;
/** The titles worth a founder slot: CEO, founder or co-founder, managing director. */
const LEADER_ROLE = /\b(?:co-?founders?|founders?|ceo|chief executive|managing director|geschäftsführer\w*|geschaeftsfuehrer\w*)\b/i;
const fold = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss");

const FREE_MAIL = /@(?:gmail|googlemail|outlook|hotmail|yahoo|proton|protonmail|icloud|me|zoho)\.[a-z.]+$/i;
const APPLY_LOCAL = /^(?:hiring|jobs?|careers?|talent|recruit\w*|apply|applications?|join(?:us)?|work(?:withus)?|hr|people)(?:[._+-].*)?$/i;
const APPLY_CONTEXT = /\b(?:apply|application|applying|resum[eé]|cv|cover letter|portfolio)\b/i;
const NOT_APPLY_CONTEXT = /\b(?:accommodat\w*|disabilit\w*|privacy|personal data|fraud\w*|scam\w*|phishing|unsolicited|agenc(?:y|ies))\b/i;

interface Page {
  url: string;
  html: string;
}
interface Leader {
  name: string;
  role: string;
  source_url: string;
  quote: string;
  emails: PostedEmail[];
}

async function sitePages(read: ReadText, website: string): Promise<Page[]> {
  const home = await readHtml(read, website);
  if (!home) return [];
  const origin = new URL(home.url).origin;
  const root = rootDomain(hostOf(home.url));
  const $ = load(home.html);
  const linked = $("a[href]")
    .toArray()
    .flatMap((element) => {
      try {
        const url = new URL($(element).attr("href") ?? "", home.url);
        url.hash = "";
        const label = $(element).text();
        return rootDomain(hostOf(url.href)) === root &&
          (SITE_LINK.test(url.pathname) || SITE_LINK.test(label)) &&
          !/privacy|cookie|terms/i.test(url.pathname)
          ? [url.href]
          : [];
      } catch {
        return [];
      }
    });
  const urls = [...new Set([...linked, ...SITE_PATHS.map((path) => `${origin}${path}`)])].filter((url) => url !== home.url).slice(0, 12);
  const pages = await pool(urls, 4, (url) => readHtml(read, url, 10_000));
  // Unknown paths often serve the homepage again.
  const seen = new Set([home.html.length]);
  const kept: Page[] = [home];
  for (const page of pages) {
    if (!page || rootDomain(hostOf(page.url)) !== root || seen.has(page.html.length)) continue;
    seen.add(page.html.length);
    kept.push(page);
  }
  return kept;
}

/**
 * Founders, CEOs and managing directors of one company, read from the funding article, the company's own
 * about/team/imprint/contact/press pages and its job pages, with every email those pages print for them.
 */
async function leadersAndEmails(
  read: ReadText,
  company: FundedCompany,
  website: string,
  extraPages: Page[],
): Promise<{ leaders: Leader[]; inboxes: Array<PostedEmail & { inbox: InboxType }> }> {
  const root = rootDomain(hostOf(website));
  const site = await sitePages(read, website);
  const article = await readHtml(read, company.funding_source_url);
  const leaders = new Map<string, Leader>();
  const addLeader = (mention: FounderMention, sourceUrl: string) => {
    if (!LEADER_ROLE.test(mention.role)) return;
    const key = fold(mention.name);
    const old = leaders.get(key);
    if (!old) leaders.set(key, { name: mention.name, role: mention.role, source_url: sourceUrl, quote: mention.quote, emails: [] });
    else if (!fold(old.role).includes(fold(mention.role))) old.role = `${old.role}; ${mention.role}`;
  };
  for (const founder of company.founders) addLeader({ name: founder.name, role: founder.role, quote: founder.quote }, founder.source_url);
  for (const page of [...site, ...extraPages]) {
    for (const mention of leadersFromText(pageText(page.html), company.company)) addLeader(mention, page.url);
    for (const mention of foundersFromTeamPage(page.html, company.company)) addLeader(mention, page.url);
  }
  if (article)
    for (const mention of foundersFromText(articleText(article.html), company.company, { strict: true })) addLeader(mention, article.url);

  const own = new Set([...site, ...extraPages].map((page) => page.url));
  const jobPages = new Set(extraPages.map((page) => page.url));
  const found: Array<PostedEmail & { own: boolean }> = [
    ...company.founders.flatMap((founder) => founder.emails.filter(posted).map((email) => ({ ...email, own: true }))),
    ...company.company_emails.filter(posted).map((email) => ({ ...email, own: true })),
    ...[...site, ...extraPages, ...(article ? [article] : [])].flatMap((page) => {
      const body = pageText(page.html);
      return pageEmails(page.html, page.url).map((email) => ({ ...cardQuote(body, email), own: own.has(page.url) }));
    }),
  ].map(({ email, source_url, quote, own }) => ({ email, source_url, quote, own }));
  const inboxes = new Map<string, PostedEmail & { inbox: InboxType }>();
  // One entry per address; the quote that carries words (the card's "Ana Example · CEO") replaces a bare one.
  const addEmail = (leader: Leader, email: PostedEmail) => {
    const index = leader.emails.findIndex((known) => known.email === email.email);
    if (index < 0) leader.emails.push(email);
    else if (!leader.emails[index]?.quote.includes(" ") && email.quote.includes(" ")) leader.emails[index] = email;
  };
  // An inbox only a job or careers page prints belongs to those roles (application_emails), not to the company list.
  const elsewhere = new Set(found.filter((email) => !jobPages.has(email.source_url)).map((email) => email.email));
  for (const { own: onOwnPage, ...email } of found) {
    const ours = rootDomain(email.email.split("@")[1] ?? "") === root;
    // Theirs when the address spells their name, or the page prints it with their full name (never a desk address).
    const person = [...leaders.values()].find((leader) => classifyEmail(email.email, [leader], email.quote).founder);
    // A founder's free-mail address counts only when the company's own page prints it as theirs.
    if (person && (ours || (onOwnPage && FREE_MAIL.test(email.email)))) {
      addEmail(person, email);
      continue;
    }
    // Already the run's founder email: keep it with that founder even when their title was not reread, but only when the
    // address spells their name or its own line names them (a privacy page's "amit.testkar@" is not Ashwin Testkar's).
    const founderOwn = company.founders.find(
      (founder) =>
        founder.emails.some((known) => known.email === email.email) &&
        (emailNamesPerson(email.email, founder.name) || quoteNamesPerson(email.quote, founder.name)),
    );
    if (founderOwn) {
      const leader = leaders.get(fold(founderOwn.name));
      if (leader) addEmail(leader, email);
      continue;
    }
    if (!ours || !isOutreachEmail(email.email) || !elsewhere.has(email.email)) continue;
    // A card that names someone else (a COO, the finance lead) is that person's address, below founders and hiring.
    const cardName = email.quote.split(" · ")[0] ?? "";
    const inbox =
      email.quote.includes(" · ") && emailNamesPerson(email.email, cardName) ? "person" : classifyEmail(email.email, [], email.quote).inbox;
    const known = inboxes.get(email.email);
    // A worded quote (the card, the sentence) beats the bare address the same email had on another page.
    if (known && (known.quote.includes(" ") || !email.quote.includes(" "))) continue;
    inboxes.set(email.email, { ...email, inbox });
  }
  return { leaders: [...leaders.values()].filter((leader) => leader.emails.length), inboxes: [...inboxes.values()] };
}

// "Any applications received via email will be deleted", "We do not accept applications by email", "Do not email to apply".
const NO_EMAILED_APPLICATIONS =
  /\b(?:(?:applications?|resum[eé]s?|cvs?)\s+(?:received|sent|submitted)\s+(?:via|by|through|over)\s+e-?mail\s+will\s+(?:be\s+)?(?:deleted|discarded|ignored|not\s+be\s+(?:considered|reviewed|accepted|processed))|(?:do\s+not|don['’]t|cannot|can['’]t|will\s+not|won['’]t)\s+(?:accept|consider|review)\s+(?:any\s+)?(?:applications?|resum[eé]s?|cvs?)\s+(?:sent\s+)?(?:via|by|through|over)\s+e-?mail|do\s+not\s+(?:contact|e-?mail)\s+[\w\s]{0,40}?\s+(?:directly\s+)?to\s+apply)/i;

/** Whether a job or careers page says applications sent by email are refused or deleted (then it has no application email). */
export function refusesEmailedApplications(body: string | null | undefined): boolean {
  return Boolean(body && NO_EMAILED_APPLICATIONS.test(body.replace(/\s+/g, " ")));
}

/** Application addresses a job page prints: a hiring/jobs/careers inbox, or one the text asks for a CV or application at. */
export function applicationEmails(found: PostedEmail[], website: string): PostedEmail[] {
  const root = rootDomain(hostOf(website));
  const out = new Map<string, PostedEmail>();
  for (const email of found) {
    const local = email.email.split("@")[0] ?? "";
    if (rootDomain(email.email.split("@")[1] ?? "") !== root || !isOutreachEmail(email.email)) continue;
    if (NOT_APPLY_CONTEXT.test(email.quote) || !(APPLY_LOCAL.test(local) || APPLY_CONTEXT.test(email.quote))) continue;
    // The sentence a page prints beats the bare mailto link that carries the same address.
    const known = out.get(email.email);
    if (!known || (linkOnlyQuote(known.quote) && !linkOnlyQuote(email.quote))) out.set(email.email, email);
  }
  return [...out.values()];
}

/** One marketing role's own page: the emails it prints, and JobPosting details the board feed left out. */
// ---- When a role was posted: the ATS, the job page, the site's sitemap, or the same role on a job site ----

/** The date a job page states for itself: JobPosting datePosted, else a published-date meta tag or JSON-LD datePublished. */
export function pageDate(html: string, pageUrl: string): string | null {
  const posting = jsonLdRoles(html, pageUrl).find((role) => role.posted_at)?.posted_at;
  if (posting) return posting;
  const $ = load(html);
  const meta =
    $('meta[property="article:published_time"]').attr("content") ??
    $('meta[itemprop="datePosted"]').attr("content") ??
    $('meta[itemprop="datePublished"]').attr("content") ??
    /"datePublished"\s*:\s*"([^"]+)"/.exec(html)?.[1];
  return meta && !Number.isNaN(Date.parse(meta)) ? new Date(meta).toISOString() : null;
}

const pageKey = (url: string) => {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url;
  }
};

/** Each page's lastmod from a site's sitemap (and up to five sitemaps an index lists), keyed by host and path. */
export async function sitemapDates(read: ReadText, website: string): Promise<Map<string, string>> {
  const dates = new Map<string, string>();
  const take = (body: string) => {
    const $ = load(body, { xml: true });
    $("url").each((_, node) => {
      const loc = $(node).children("loc").text().trim();
      const lastmod = $(node).children("lastmod").text().trim();
      if (loc && lastmod && !Number.isNaN(Date.parse(lastmod))) dates.set(pageKey(loc), new Date(lastmod).toISOString());
    });
    return $("sitemap > loc")
      .toArray()
      .map((node) => $(node).text().trim());
  };
  const get = async (url: string) => {
    try {
      const response = await read(url, {
        timeoutMs: 15_000,
        headers: { accept: "application/xml,text/xml,*/*", "user-agent": USER_AGENT },
      });
      return response.status < 400 && /<(?:urlset|sitemapindex)\b/i.test(response.text.slice(0, 2000)) ? response.text : null;
    } catch {
      return null;
    }
  };
  const index = await get(new URL("/sitemap.xml", website).href);
  if (!index) return dates;
  const children = take(index);
  // Job pages usually sit in a careers/jobs/pages sitemap; read those first.
  children.sort((a, b) => Number(/career|job|page/i.test(b)) - Number(/career|job|page/i.test(a)));
  for (const child of children.slice(0, 5)) {
    const body = await get(child);
    if (body) take(body);
  }
  return dates;
}

/** The same role in a job-site listing for this company (same or near-identical title), when it is dated. */
function listedRole(role: HiringRole, listings: HiringRole[]): HiringRole | undefined {
  return listings.find(
    (listing) =>
      listing.posted_at && (listing.title.toLowerCase() === role.title.toLowerCase() || similarTitles(listing.title, role.title)),
  );
}

/** One marketing role's own page: the emails it prints, its posting date, and JobPosting details the board feed left out. */
async function jobDetails(
  read: ReadText,
  role: HiringRole,
  boardEmails: PostedEmail[],
  description: string | null,
  website: string,
): Promise<{ role: HiringRole; page: Page | null }> {
  const page = await readHtml(read, role.url);
  const found: PostedEmail[] = page ? pageEmails(page.html, page.url) : [];
  if (description) {
    const { emails } = postingEmails(description);
    for (const email of emails) {
      const line = description.split("\n").find((part) => part.toLowerCase().includes(email));
      if (line) found.push({ email, source_url: role.url, quote: text(line).slice(0, 240) });
    }
  }
  const posting = page ? jsonLdRoles(page.html, page.url)[0] : undefined;
  const dated = role.posted_at ? null : page ? pageDate(page.html, page.url) : null;
  const updated: HiringRole = {
    ...role,
    location: role.location ?? posting?.location ?? null,
    employment_type: role.employment_type ?? posting?.employment_type ?? null,
    salary: role.salary ?? posting?.salary ?? salaryFromText(description) ?? (page ? salaryFromText(pageText(page.html)) : null),
    posted_at: role.posted_at ?? dated,
    posted_at_source: role.posted_at ? role.posted_at_source : dated ? "job-page" : null,
    // A posting that says emailed applications are deleted (Ocient) has no application email, whatever it prints.
    application_emails:
      refusesEmailedApplications(description) || (page && refusesEmailedApplications(pageText(page.html)))
        ? []
        : applicationEmails([...found, ...boardEmails], website),
  };
  return { role: updated, page };
}

// ---- Job sites by company name, when the company's own site and the ATSes yield nothing ----

/** Indeed's country for a funded company's country (JobSpy's names); unknown → the US site. */
const INDEED_COUNTRY: Record<string, string> = {
  "united states": "usa",
  usa: "usa",
  "united kingdom": "uk",
  uk: "uk",
  "united arab emirates": "united arab emirates",
};
export function indeedCountry(country: string | null | undefined): string {
  const key = (country ?? "").trim().toLowerCase();
  return INDEED_COUNTRY[key] ?? (key || "usa");
}

export interface JobSiteQuery {
  company: string;
  website: string;
  country: string | null;
}
/** Searches job sites for a company's name; returns every posting found (the caller keeps the company's own). */
export type SearchJobSites = (query: JobSiteQuery) => Promise<ParsedJob[]>;

/** Logged-out Indeed and LinkedIn search through JobSpy, for the company's name in quotes. */
export const jobSpyCompanySearch: SearchJobSites = async ({ company, country }) => {
  const { jobs } = await searchJobSpy(
    {
      search: `"${company}"`,
      sites: ["indeed", "linkedin"],
      country: indeedCountry(country),
      location: country ?? undefined,
      results: 60,
    },
    240_000,
  );
  return jobs;
};

/**
 * The postings among a job-site search that are this company's: the employer name must match exactly. A posting that
 * also names the company's domain is "name+domain"; a short name (under six letters) needs that domain to count.
 */
export function companyListings(
  jobs: ParsedJob[],
  company: string,
  website: string,
): { roles: HiringRole[]; match: JobSiteMatch; descriptions: Map<string, string> } | null {
  const key = companyKey(company);
  const domain = rootDomain(hostOf(website));
  const ours = jobs.filter((job) => companyKey(job.company) === key);
  if (!ours.length || !domain) return null;
  const namesDomain = ours.some((job) =>
    `${job.description ?? ""} ${job.company_website ?? ""} ${String(job.metadata?.company_url_direct ?? "")}`
      .toLowerCase()
      .includes(domain),
  );
  if (!namesDomain && key.length < 6) return null;
  const roles = ours.map((job) => {
    const site = /linkedin/i.test(job.source) ? "linkedin" : "indeed";
    return newRole({
      title: job.title,
      url: job.url,
      location: job.location ?? null,
      department: job.department ?? null,
      employment_type: employmentType(job.employment_type),
      salary: job.salary ?? null,
      posted_at: job.posted_at ? new Date(job.posted_at).toISOString() : null,
      posted_at_source: job.posted_at ? site : null,
    });
  });
  const descriptions = new Map(ours.flatMap((job) => (job.description ? [[job.url, job.description] as const] : [])));
  return { roles, match: namesDomain ? "name+domain" : "name", descriptions };
}

// ---- Reposts: the same description listed again after the round is the older opening, not a new hire ----

/** A description's fingerprint: every run of six words, folded to lowercase letters and digits. */
export function descriptionFingerprint(body: string): Set<string> {
  const words = fold(body.replace(/<[^>]+>/g, " ")).match(/[a-z0-9]+/g) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + 6 <= words.length; i++) out.add(words.slice(i, i + 6).join(" "));
  return out;
}

/**
 * Whether two descriptions are one posting: most of the shorter one's six-word runs appear in the other (a job page
 * wraps the description in navigation, so containment, not equality). Short texts never match.
 */
export function sameDescription(a: string, b: string): boolean {
  const x = descriptionFingerprint(a);
  const y = descriptionFingerprint(b);
  if (x.size < 20 || y.size < 20) return false;
  const [small, large] = x.size <= y.size ? [x, y] : [y, x];
  let shared = 0;
  for (const run of small) if (large.has(run)) shared++;
  return shared / small.size >= 0.7;
}

/**
 * Post-funding roles whose description matches a pre-funding listing of the same company (same or near-identical
 * title, any source) are reposts: they take the earlier posting date and move to the pre-funding list.
 */
export function markReposts(
  afterFunding: HiringRole[],
  earlier: HiringRole[],
  describe: (role: HiringRole) => string | null,
): { afterFunding: HiringRole[]; reposts: HiringRole[] } {
  const kept: HiringRole[] = [];
  const reposts: HiringRole[] = [];
  for (const role of afterFunding) {
    const body = describe(role);
    const match = body
      ? earlier.find((old) => {
          if (old.url === role.url || old.pre_funding !== true || !old.posted_at) return false;
          if (old.title.toLowerCase() !== role.title.toLowerCase() && !similarTitles(old.title, role.title)) return false;
          const oldBody = describe(old);
          return Boolean(oldBody && sameDescription(body, oldBody));
        })
      : undefined;
    if (!match) kept.push(role);
    else
      reposts.push({
        ...role,
        posted_at: match.posted_at,
        posted_at_source: match.posted_at_source,
        days_after_funding: match.days_after_funding,
        pre_funding: true,
        repost_of: match.url,
      });
  }
  return { afterFunding: kept, reposts };
}

const defaultRead: ReadText = (url, options) =>
  readPublicText(url, { timeoutMs: options?.timeoutMs, headers: options?.headers, maxBytes: options?.maxBytes });

/** Where to write: a founder's own email, an application email on a role, or a founders/careers inbox the site prints. */
const hasHiringContact = (company: Pick<HiringCompany, "founders" | "marketing_jobs" | "pre_funding_marketing_jobs" | "company_emails">) =>
  company.founders.length > 0 ||
  [...company.marketing_jobs, ...company.pre_funding_marketing_jobs].some((role) => role.application_emails.length) ||
  company.company_emails.some((email) => email.inbox === "founders" || email.inbox === "careers");

const CEO_FIRST = /\b(?:ceo|chief executive)\b/i;
const FOUNDER_FIRST = /\bfounder/i;

/**
 * The first address to write to: a CEO's own, then a founder's or managing director's, then the application address of a
 * role posted after the round (then an older role's), then founders@ or careers@. Sales, press, support and privacy
 * inboxes, and other staff's addresses, are never picked.
 */
export function bestContact(
  company: Pick<HiringCompany, "founders" | "marketing_jobs" | "pre_funding_marketing_jobs" | "company_emails">,
): BestContact | null {
  const leaders = [...company.founders].sort(
    (a, b) =>
      Number(CEO_FIRST.test(b.role)) - Number(CEO_FIRST.test(a.role)) ||
      Number(FOUNDER_FIRST.test(b.role)) - Number(FOUNDER_FIRST.test(a.role)),
  );
  for (const leader of leaders) {
    const email = leader.emails[0];
    if (email) return { ...email, who: `${leader.name} (${leader.role})` };
  }
  for (const role of [...company.marketing_jobs, ...company.pre_funding_marketing_jobs]) {
    const email = role.application_emails[0];
    if (email) return { ...email, who: `application email for ${role.title}` };
  }
  for (const inbox of ["founders", "careers"] as const) {
    const email = company.company_emails.find((found) => found.inbox === inbox);
    if (email) return { email: email.email, source_url: email.source_url, quote: email.quote, who: `${inbox} inbox` };
  }
  return null;
}

const WATCH_DAYS = 30;
const DAY = 86_400_000;
const watchKey = (company: Pick<FundedCompany, "company" | "website">) =>
  company.website ? rootDomain(hostOf(company.website)) : company.company.toLowerCase();

/** An empty watch: companies are added as runs see them, and dropped 30 days after their announcement. */
export function emptyWatch(): WatchState {
  return { updated_at: new Date(0).toISOString(), companies: {} };
}

/**
 * The run's companies plus every watched company still inside its 30 days after the announcement (so a daily run
 * keeps polling last week's rounds); watched companies past their 30 days are dropped from the watch.
 */
export function withWatched(run: FundedRun, watch: WatchState, now: Date): FundedRun {
  for (const [key, entry] of Object.entries(watch.companies))
    if (Date.parse(entry.watch_until) < now.getTime()) delete watch.companies[key];
  const seen = new Set(run.companies.map(watchKey));
  const extra = Object.values(watch.companies)
    .map((entry) => entry.funded)
    .filter((company) => !seen.has(watchKey(company)));
  return { ...run, companies: [...run.companies, ...extra] };
}

/**
 * A role this poll lists that the company's last poll (same source, after the announcement, roles read) did not: it was
 * created between the two polls, so after the round. Its posted_at is the poll that first saw it.
 */
function firstSeenAfterRound(entry: WatchedCompany | undefined, url: string, rolesFrom: string, announcedOn: string): boolean {
  const last = entry?.polls.at(-1);
  if (!entry || !last || entry.roles[url] || last.roles_from !== rolesFrom || last.open_roles === 0) return false;
  return Date.parse(last.at.slice(0, 10)) >= Date.parse(announcedOn.slice(0, 10));
}

export interface FundedHiringOptions {
  read?: ReadText;
  log?: (message: string) => void;
  concurrency?: number;
  now?: Date;
  jobPagesPerCompany?: number;
  /** Job-site search by company name (e.g. jobSpyCompanySearch: Indeed, LinkedIn) when the site yields no roles; off by default. */
  searchJobSites?: SearchJobSites | false;
  /**
   * The daily watch (updated in place): each company's polls and every role URL with the day it was first seen. A role
   * that appears between two polls after the announcement is dated by the poll that found it ("first-seen").
   */
  watch?: WatchState;
}

/**
 * Every funded company with a website: its open roles from a linked or name-matched ATS board, its careers page, or
 * (when both yield nothing) Indeed/LinkedIn by company name; its marketing roles, split by whether they were posted
 * after the round was announced; and who to write to there. Only companies with a marketing role posted after the
 * announcement are leads (`companies`); the rest are demoted or set apart.
 */
export async function collectFundedHiring(run: FundedRun, options: FundedHiringOptions = {}): Promise<HiringRun> {
  const read = cachedRead(options.read ?? defaultRead);
  const log = options.log ?? (() => {});
  const searchSites = options.searchJobSites || null;
  const now = options.now ?? new Date();
  const watch = options.watch;
  const funded = run.companies.filter((company) => company.website);
  const scans = await scanCompanies(
    funded.map((company) => ({ company: company.company, website: company.website as string })),
    log,
    options.concurrency ?? 4,
    read,
  );
  const stats: Record<string, number> = {
    // The headline: marketing roles posted on or after the day the round was announced, and the funded companies with
    // such a role plus a posted founder or hiring email (a founder/CEO's own, a role's application email, founders@ or
    // careers@) to write to.
    marketing_roles_after_funding: 0,
    with_marketing_role_after_funding_and_contact: 0,
    with_marketing_roles_after_funding: 0,
    // Any marketing role (before or after the round) plus a posted founder or hiring email.
    with_marketing_role_and_contact: 0,
    marketing_roles_after_funding_on_company_board: 0,
    marketing_roles_after_funding_on_job_sites: 0,
    marketing_roles_after_funding_first_seen_by_watch: 0,
    funded_companies: run.companies.length,
    scanned: funded.length,
    watched_companies: 0,
    with_ats_board: 0,
    with_careers_page: 0,
    with_job_site_listings: 0,
    with_no_roles_found: 0,
    open_roles: 0,
    marketing_roles: 0,
    marketing_roles_pre_funding: 0,
    marketing_roles_undated_dropped: 0,
    marketing_roles_reposted: 0,
    marketing_roles_with_salary: 0,
    marketing_roles_with_employment_type: 0,
    marketing_roles_with_application_email: 0,
    with_marketing_roles: 0,
    with_only_pre_funding_marketing_roles: 0,
    founders_with_email: 0,
  };
  const companies: HiringCompany[] = [];
  const demoted: HiringRun["demoted_companies"] = [];
  const other: HiringRun["other_companies"] = [];
  const undated: HiringRun["undated_marketing_roles"] = [];
  const coverage: CompanyCoverage[] = [];
  const searchJobSites = async (company: FundedCompany, website: string) => {
    if (!searchSites) return null;
    try {
      return companyListings(await searchSites({ company: company.company, website, country: company.country }), company.company, website);
    } catch (error) {
      log(`${company.company}: job-site search failed (${(error as Error).message.slice(0, 160)})`);
      return null;
    }
  };
  const announcedAt = (company: FundedCompany) => Date.parse(company.announced_on.slice(0, 10));
  const watched = (company: FundedCompany) =>
    Boolean(watch) && !Number.isNaN(announcedAt(company)) && now.getTime() - announcedAt(company) <= WATCH_DAYS * DAY;

  /** Records this poll in the watch: every role URL it listed, and when. */
  const recordPoll = (company: FundedCompany, website: string, roles: HiringRole[], rolesFrom: string) => {
    if (!watch || !watched(company)) return;
    const key = watchKey({ company: company.company, website });
    const at = now.toISOString();
    const entry: WatchedCompany = watch.companies[key] ?? {
      funded: company,
      watch_until: new Date(announcedAt(company) + WATCH_DAYS * DAY).toISOString(),
      polls: [],
      roles: {},
    };
    watch.companies[key] = entry;
    entry.funded = company;
    for (const role of roles) {
      const known = entry.roles[role.url];
      entry.roles[role.url] = { title: role.title, first_seen: known?.first_seen ?? at, last_seen: at };
    }
    entry.polls.push({ at, roles_from: rolesFrom, open_roles: roles.length });
    stats.watched_companies++;
  };

  const research = async (company: FundedCompany, index: number) => {
    const scan = scans[index];
    if (!scan) return;
    const prior = watch?.companies[watchKey({ company: company.company, website: scan.website })];
    let boards: HiringCompany["boards"] = scan.boards.map((board) => ({ ats: board.ats, board_url: board.boardUrl }));
    const descriptions = new Map<string, string>();
    let roles: HiringRole[] = scan.jobs.map((job) => {
      if (job.description) descriptions.set(job.url, job.description);
      return newRole({
        title: job.title,
        url: job.url,
        location: job.location ?? null,
        department: job.department ?? null,
        employment_type: employmentType(job.employment_type),
        salary: job.salary ?? null,
        posted_at: job.posted_at ? new Date(job.posted_at).toISOString() : null,
      });
    });
    let rolesFrom = boards.map((board) => board.ats).join("+");
    if (boards.length) stats.with_ats_board++;
    else {
      const page = await careersPage(scan.website, read);
      if (page) {
        stats.with_careers_page++;
        boards = [{ ats: "careers-page", board_url: page.board_url }];
        roles = page.roles;
        rolesFrom = "careers-page";
      }
    }
    // The site and the ATSes gave nothing: the company's listings on Indeed and LinkedIn, by its exact name.
    let listings: HiringRole[] = [];
    const listingDescriptions = new Map<string, string>();
    let searched = false;
    const listingsOnce = async () => {
      if (searched) return listings;
      searched = true;
      const found = await searchJobSites(company, scan.website);
      if (found) {
        listings = found.roles;
        for (const [url, body] of found.descriptions) listingDescriptions.set(url, body);
        const site = found.roles.some((role) => /indeed\./i.test(role.url)) ? "indeed" : "linkedin";
        if (!roles.length) boards = [{ ats: site, board_url: found.roles[0]?.url ?? "", match: found.match }];
      }
      return listings;
    };
    if (!roles.length) {
      roles = await listingsOnce();
      if (roles.length) {
        stats.with_job_site_listings++;
        rolesFrom = boards[0]?.ats ?? "job-site";
      }
    }
    roles = [...new Map(roles.map((role) => [role.url, role])).values()];
    if (!roles.length) {
      stats.with_no_roles_found++;
      recordPoll(company, scan.website, [], "none");
      coverage.push({
        company: company.company,
        website: scan.website,
        roles_from: "none",
        open_roles: 0,
        marketing_roles: 0,
        marketing_roles_after_funding: 0,
        outcome: "no open roles found",
      });
      log(`${company.company}: no open roles found (site, ATS boards, job sites)`);
      return;
    }
    let marketing_jobs = roles.filter((role) => isMarketingRole(role.title, role.department));

    // The careers page itself may print where to apply ("send your CV to jobs@…"): it holds for each role it lists,
    // unless the page says emailed applications are refused or deleted.
    const board = boards[0]?.ats === "careers-page" ? await readHtml(read, boards[0].board_url) : null;
    const boardEmails =
      board && !refusesEmailedApplications(pageText(board.html)) ? applicationEmails(pageEmails(board.html, board.url), scan.website) : [];
    const limit = options.jobPagesPerCompany ?? 8;
    const details = await pool(marketing_jobs, 3, (role) =>
      marketing_jobs.indexOf(role) < limit
        ? jobDetails(read, role, boardEmails, descriptions.get(role.url) ?? null, scan.website)
        : Promise.resolve({ role: { ...role, application_emails: boardEmails }, page: null }),
    );
    marketing_jobs = details.map((detail) => detail.role);
    // A role the last post-announcement poll of this board did not list was created since: dated by this poll.
    marketing_jobs = marketing_jobs.map((role) =>
      !role.posted_at && firstSeenAfterRound(prior, role.url, rolesFrom, company.announced_on)
        ? { ...role, posted_at: now.toISOString(), posted_at_source: "first-seen" as const }
        : role,
    );
    // Still undated: the page's lastmod in the site's sitemap, then the same role's job-site listing.
    if (marketing_jobs.some((role) => !role.posted_at)) {
      const sitemap = await sitemapDates(read, scan.website);
      marketing_jobs = marketing_jobs.map((role) => {
        const lastmod = role.posted_at ? null : sitemap.get(pageKey(role.url));
        return lastmod ? { ...role, posted_at: lastmod, posted_at_source: "sitemap" as const } : role;
      });
    }
    if (marketing_jobs.some((role) => !role.posted_at)) {
      const found = await listingsOnce();
      marketing_jobs = marketing_jobs.map((role) => {
        const match = role.posted_at ? undefined : listedRole(role, found);
        return match ? { ...role, posted_at: match.posted_at, posted_at_source: match.posted_at_source } : role;
      });
    }
    recordPoll(company, scan.website, roles, rolesFrom);
    marketing_jobs = marketing_jobs.map((role) => datedAgainst(role, company.announced_on));
    for (const role of marketing_jobs.filter((job) => job.pre_funding === null)) {
      stats.marketing_roles_undated_dropped++;
      undated.push({
        company: company.company,
        title: role.title,
        url: role.url,
        reason: role.posted_at
          ? `only a sitemap lastmod (${role.posted_at.slice(0, 10)}) on or after the round: an edit date, not a posting date`
          : "no posting date from the ATS, the job page, the sitemap, a job-site listing or a watch poll",
      });
    }
    const byDate = (a: HiringRole, b: HiringRole) => (b.posted_at ?? "").localeCompare(a.posted_at ?? "");
    let afterFunding = marketing_jobs.filter((role) => role.pre_funding === false).sort(byDate);
    let preFunding = marketing_jobs.filter((role) => role.pre_funding === true).sort(byDate);
    // A post-funding listing whose description matches an opening posted before the round (on the board or a job site)
    // is that older opening reposted: it keeps the earlier date and is not counted as a post-funding hire.
    if (afterFunding.length) {
      const pageTexts = new Map(details.flatMap((detail) => (detail.page ? [[detail.role.url, pageText(detail.page.html)] as const] : [])));
      const describe = (role: HiringRole) =>
        descriptions.get(role.url) ?? listingDescriptions.get(role.url) ?? pageTexts.get(role.url) ?? null;
      const older = [
        ...preFunding,
        ...(await listingsOnce())
          .filter((listing) => isMarketingRole(listing.title, listing.department))
          .map((listing) => datedAgainst(listing, company.announced_on)),
      ];
      const marked = markReposts(afterFunding, older, describe);
      if (marked.reposts.length) {
        stats.marketing_roles_reposted += marked.reposts.length;
        afterFunding = marked.afterFunding;
        preFunding = [...preFunding, ...marked.reposts].sort(byDate);
      }
    }

    // Job-site pages (Indeed, LinkedIn) are not the company's own: their emails are not read as its contacts.
    const jobPages = details.flatMap((detail) =>
      detail.page && !/(?:^|\.)(?:indeed|linkedin)\./i.test(hostOf(detail.page.url)) ? [detail.page] : [],
    );
    const contacts = await leadersAndEmails(read, company, scan.website, [...jobPages, ...(board ? [board] : [])]);
    const founders: HiringFounder[] = contacts.leaders;
    const taken = new Set(founders.flatMap((founder) => founder.emails.map((email) => email.email)));
    const order: InboxType[] = ["founders", "careers", "general", "person", "sales", "press", "other", "support"];
    const company_emails = contacts.inboxes
      .filter((email) => !taken.has(email.email))
      .sort((a, b) => order.indexOf(a.inbox) - order.indexOf(b.inbox));
    const draft = { founders, company_emails, marketing_jobs: afterFunding, pre_funding_marketing_jobs: preFunding };
    const entry: HiringCompany = {
      company: company.company,
      website: scan.website,
      industry: company.industry.label,
      stage: company.stage,
      amount: company.amount,
      announced_on: company.announced_on,
      funding_source_url: company.funding_source_url,
      founders,
      company_emails,
      boards,
      open_roles: roles.length,
      marketing_jobs: afterFunding,
      pre_funding_marketing_jobs: preFunding,
      best_contact: bestContact(draft),
    };
    stats.open_roles += roles.length;
    const contact = hasHiringContact(entry);
    const outcome: CompanyCoverage["outcome"] = afterFunding.length
      ? "kept: marketing role posted after funding"
      : preFunding.length
        ? "demoted: marketing roles predate the round"
        : contact
          ? "demoted: hiring contact, no marketing role after funding"
          : "no marketing role and no founder or hiring email";
    coverage.push({
      company: company.company,
      website: scan.website,
      roles_from: rolesFrom,
      open_roles: roles.length,
      marketing_roles: afterFunding.length + preFunding.length,
      marketing_roles_after_funding: afterFunding.length,
      outcome,
    });
    if (outcome === "no marketing role and no founder or hiring email") {
      other.push({ company: company.company, website: scan.website, boards, open_roles: roles.length });
      log(`${company.company}: ${roles.length} open role(s), none in marketing, no founder or hiring email: set apart`);
      return;
    }
    const all = [...afterFunding, ...preFunding];
    stats.marketing_roles += all.length;
    stats.marketing_roles_pre_funding += preFunding.length;
    stats.marketing_roles_after_funding += afterFunding.length;
    stats.marketing_roles_after_funding_on_job_sites += afterFunding.filter((role) =>
      /indeed|linkedin/.test(role.posted_at_source ?? ""),
    ).length;
    stats.marketing_roles_after_funding_first_seen_by_watch += afterFunding.filter((role) => role.posted_at_source === "first-seen").length;
    stats.marketing_roles_after_funding_on_company_board += afterFunding.filter((role) =>
      ["ats", "job-page", "first-seen"].includes(role.posted_at_source ?? ""),
    ).length;
    stats.marketing_roles_with_salary += all.filter((role) => role.salary).length;
    stats.marketing_roles_with_employment_type += all.filter((role) => role.employment_type).length;
    stats.marketing_roles_with_application_email += all.filter((role) => role.application_emails.length).length;
    stats.founders_with_email += founders.length;
    if (all.length) stats.with_marketing_roles++;
    if (all.length && contact) stats.with_marketing_role_and_contact++;
    if (afterFunding.length && contact) stats.with_marketing_role_after_funding_and_contact++;
    if (afterFunding.length) stats.with_marketing_roles_after_funding++;
    else if (preFunding.length) stats.with_only_pre_funding_marketing_roles++;
    log(
      `${company.company}: ${roles.length} open role(s) via ${rolesFrom}, ${afterFunding.length} marketing posted after funding, ${preFunding.length} before, ${founders.length} founder(s) with email`,
    );
    if (afterFunding.length) companies.push(entry);
    else
      demoted.push({
        ...entry,
        demoted_because: preFunding.length
          ? `every marketing role predates the ${company.announced_on} announcement`
          : "no marketing role posted after the round; a founder or hiring email only",
      });
  };
  await pool(
    funded.map((company, index) => ({ company, index })),
    options.concurrency ?? 4,
    ({ company, index }) => research(company, index),
  );
  if (watch) watch.updated_at = now.toISOString();

  stats.hiring_companies = companies.length;
  stats.demoted_companies = demoted.length;
  stats.other_companies = other.length;
  const rank = (a: HiringCompany, b: HiringCompany) =>
    b.marketing_jobs.length - a.marketing_jobs.length ||
    Number(Boolean(b.best_contact)) - Number(Boolean(a.best_contact)) ||
    b.pre_funding_marketing_jobs.length - a.pre_funding_marketing_jobs.length ||
    b.open_roles - a.open_roles ||
    a.company.localeCompare(b.company);
  companies.sort(rank);
  demoted.sort(rank);
  other.sort((a, b) => b.open_roles - a.open_roles || a.company.localeCompare(b.company));
  coverage.sort((a, b) => a.company.localeCompare(b.company));
  return {
    generated_at: now.toISOString(),
    stats,
    companies,
    demoted_companies: demoted,
    other_companies: other,
    undated_marketing_roles: undated,
    coverage,
  };
}

/** Several funded-founders runs as one (a 7-day and a 14-day run overlap): each company once, its first record kept. */
export function mergeRuns(runs: FundedRun[]): FundedRun {
  const seen = new Map<string, FundedCompany>();
  for (const run of runs)
    for (const company of run.companies) {
      const key = company.website ? rootDomain(hostOf(company.website)) : company.company.toLowerCase();
      if (!seen.has(key)) seen.set(key, company);
    }
  return {
    generated_at:
      runs
        .map((run) => run.generated_at)
        .sort()
        .at(-1) ?? new Date().toISOString(),
    window_days: Math.max(0, ...runs.map((run) => run.window_days)),
    stats: {},
    companies: [...seen.values()],
  };
}
