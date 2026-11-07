// Reads open roles straight from a company's applicant-tracking system. Each supported ATS publishes
// a public, unauthenticated job feed; we find which one a company uses from links on its own website
// (patterns follow colophon-group/jobseek's monitors, MIT). No login, no scraping service.

import { readPublicText } from "@fireround/core/web/transport";
import { load } from "cheerio";
import type { JobInput } from "./jobs.ts";

export const ATS_KINDS = [
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "smartrecruiters",
  "recruitee",
  "bamboohr",
  "teamtailor",
  "personio",
  "gem",
] as const;
export type AtsKind = (typeof ATS_KINDS)[number];

export interface JobBoard {
  ats: AtsKind;
  token: string;
  /** Lever runs a separate EU deployment. */
  eu?: boolean;
  /** How we learned the company uses this board. */
  foundOn: string;
}

export interface BoardRead {
  board: JobBoard;
  boardUrl: string;
  /** The ATS's own display name for the company, when its feed gives one. */
  companyName?: string;
  /** The company website the ATS itself lists for the board (Ashby publishes one). */
  companyWebsite?: string;
  jobs: JobInput[];
}

export type ReadText = (
  url: string,
  options?: { timeoutMs?: number; headers?: Record<string, string>; maxBytes?: number },
) => Promise<{ text: string; url: string; status: number }>;

const USER_AGENT = "SignalRound/0.2 (+https://github.com/aasimahmed177-web/SignalRound)";
const SMARTRECRUITERS_MAX = 5_000;
const RESERVED_TOKENS = new Set([
  "api",
  "embed",
  "v0",
  "v1",
  "static",
  "assets",
  "js",
  "css",
  "jobs",
  "careers",
  "www",
  "app",
  "cdn",
  "gem",
  "career",
  "scripts",
]);

const PATTERNS: Array<{ ats: AtsKind; re: RegExp; eu?: boolean }> = [
  { ats: "greenhouse", re: /boards-api\.greenhouse\.io\/v1\/boards\/([\w-]+)/gi },
  { ats: "greenhouse", re: /boards\.greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([\w-]+)/gi },
  { ats: "greenhouse", re: /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/([\w-]+)/gi },
  { ats: "lever", re: /api\.eu\.lever\.co\/v0\/postings\/([\w-]+)/gi, eu: true },
  { ats: "lever", re: /jobs\.eu\.lever\.co\/([\w-]+)/gi, eu: true },
  { ats: "lever", re: /api\.lever\.co\/v0\/postings\/([\w-]+)/gi },
  { ats: "lever", re: /jobs\.lever\.co\/([\w-]+)/gi },
  { ats: "ashby", re: /api\.ashbyhq\.com\/posting-api\/job-board\/([\w.-]+)/gi },
  { ats: "ashby", re: /jobs\.ashbyhq\.com\/([\w.%-]+)/gi },
  { ats: "workable", re: /apply\.workable\.com\/(?:api\/v\d\/accounts\/)?([\w-]+)/gi },
  { ats: "smartrecruiters", re: /(?:jobs|careers)\.smartrecruiters\.com\/([\w-]+)/gi },
  { ats: "smartrecruiters", re: /api\.smartrecruiters\.com\/v1\/companies\/([\w-]+)/gi },
  { ats: "recruitee", re: /\b([a-z0-9][\w-]{0,62})\.recruitee\.com/gi },
  { ats: "bamboohr", re: /\b([a-z0-9][a-z0-9-]{0,62})\.bamboohr\.com\/(?:careers|jobs)/gi },
  { ats: "teamtailor", re: /\b([a-z0-9][a-z0-9-]{0,62})\.teamtailor\.com/gi },
  { ats: "personio", re: /\b([a-z0-9][a-z0-9-]{0,62})\.jobs\.personio\.(?:de|com)/gi },
  { ats: "gem", re: /jobs\.gem\.com\/([\w-]+)/gi },
  { ats: "gem", re: /api\.gem\.com\/job_board\/v0\/([\w-]+)/gi },
];

/** Every ATS board referenced in a page's HTML, de-duplicated. */
export function detectBoards(html: string, foundOn: string): JobBoard[] {
  const found = new Map<string, JobBoard>();
  for (const { ats, re, eu } of PATTERNS) {
    for (const match of html.matchAll(re)) {
      // ATS tokens are case-insensitive: one casing keeps external_id and board_url stable across runs.
      const token = decodeURIComponent(match[1] ?? "")
        .trim()
        .toLowerCase();
      if (!token || RESERVED_TOKENS.has(token)) continue;
      const key = `${ats}:${token}`;
      if (!found.has(key)) found.set(key, { ats, token, eu, foundOn });
    }
  }
  return [...found.values()];
}

const CAREER_TEXT = /\b(?:careers?|jobs?|join(?: us| the team| our team)?|we'?re hiring|hiring|open (?:roles|positions)|work with us)\b/i;
const CAREER_PATH = /\/(?:careers?|jobs?|join(?:-us)?|hiring|work-with-us|open-roles|positions)(?:[/?#.]|$)/i;

function sameSite(a: string, b: string): boolean {
  const host = (value: string) => new URL(value).hostname.replace(/^www\./, "");
  try {
    const x = host(a);
    const y = host(b);
    return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
  } catch {
    return false;
  }
}

/** Same-site links that look like a careers page, best first. */
export function careerLinks(html: string, pageUrl: string): string[] {
  const $ = load(html);
  const scored = new Map<string, number>();
  $("a[href]").each((_, element) => {
    let url: URL;
    try {
      url = new URL($(element).attr("href") ?? "", pageUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || !sameSite(url.href, pageUrl)) return;
    url.hash = "";
    const text = $(element).text().replace(/\s+/g, " ").trim();
    let score = 0;
    if (CAREER_PATH.test(url.pathname)) score += 2;
    if (CAREER_TEXT.test(text)) score += 1;
    if (score) scored.set(url.href, Math.max(score, scored.get(url.href) ?? 0));
  });
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).map(([url]) => url);
}

function htmlToText(html: string | null | undefined, max = 20_000): string | null {
  if (!html) return null;
  const $ = load(html.includes("&lt;") ? load(html).text() : html);
  $("script,style").remove();
  $("br,p,li,h1,h2,h3,h4,div").after("\n");
  const text = $.root()
    .text()
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  return text ? text.slice(0, max) : null;
}

function iso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function json(read: ReadText, url: string): Promise<unknown> {
  let response: Awaited<ReturnType<ReadText>>;
  try {
    // Large employers publish multi-megabyte feeds with full descriptions.
    response = await read(url, {
      timeoutMs: 30_000,
      maxBytes: 25_000_000,
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
  } catch (error) {
    if (error instanceof Error && /\bHTTP 404\b/.test(error.message)) throw new BoardNotFound(url);
    throw error;
  }
  if (response.status === 404) throw new BoardNotFound(url);
  if (response.status >= 400) throw new Error(`${url} answered ${response.status}`);
  try {
    return JSON.parse(response.text);
  } catch {
    throw new BoardNotFound(url);
  }
}

export class BoardNotFound extends Error {
  constructor(url: string) {
    super(`No public job board at ${url}`);
  }
}

interface ReadContext {
  company: string;
  companyWebsite?: string | null;
  signalId?: string | null;
}

function base(board: JobBoard, ctx: ReadContext, boardUrl: string) {
  return {
    source: board.ats,
    company: ctx.company,
    company_website: ctx.companyWebsite ?? null,
    board_url: boardUrl,
    signal_id: ctx.signalId ?? null,
  };
}

/** Reads one board's complete current listing. */
export async function readBoard(board: JobBoard, ctx: ReadContext, read: ReadText = defaultRead): Promise<BoardRead> {
  const t = encodeURIComponent(board.token);
  const meta = { ats_token: board.token, found_on: board.foundOn };
  switch (board.ats) {
    case "greenhouse": {
      const boardUrl = `https://job-boards.greenhouse.io/${t}`;
      const data = obj(await json(read, `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`));
      let companyName: string | undefined;
      try {
        companyName = str(obj(await json(read, `https://boards-api.greenhouse.io/v1/boards/${t}`)).name) ?? undefined;
      } catch {}
      const jobs = arr(data.jobs).map((raw) => {
        const job = obj(raw);
        return {
          ...base(board, ctx, boardUrl),
          external_id: `${board.token}:${job.id}`,
          url: str(job.absolute_url) ?? `${boardUrl}/jobs/${job.id}`,
          title: str(job.title) ?? "Untitled role",
          location: str(obj(job.location).name),
          department:
            arr(job.departments)
              .map((d) => str(obj(d).name))
              .filter(Boolean)
              .join(", ") || null,
          description: htmlToText(str(job.content)),
          // updated_at moves on any edit; an old role edited yesterday is not posted yesterday.
          posted_at: iso(job.first_published),
          metadata: iso(job.updated_at) ? { ...meta, updated_at: iso(job.updated_at) } : meta,
        };
      });
      return { board, boardUrl, companyName, jobs };
    }
    case "lever": {
      const host = board.eu ? "eu.lever.co" : "lever.co";
      const boardUrl = `https://jobs.${host}/${t}`;
      const data = arr(await json(read, `https://api.${host}/v0/postings/${t}?mode=json`));
      const jobs = data.map((raw) => {
        const job = obj(raw);
        const categories = obj(job.categories);
        const salary = obj(job.salaryRange);
        return {
          ...base(board, ctx, boardUrl),
          external_id: `${board.token}:${job.id}`,
          url: str(job.hostedUrl) ?? `${boardUrl}/${job.id}`,
          title: str(job.text) ?? "Untitled role",
          location: str(categories.location) ?? arr(categories.allLocations).map(str).filter(Boolean).join("; ") ?? null,
          // "unspecified" and "hybrid" say nothing about remote eligibility.
          remote: job.workplaceType === "remote" ? true : job.workplaceType === "onsite" ? false : null,
          department:
            [str(categories.department), str(categories.team)].filter((v, i, all) => v && all.indexOf(v) === i).join(" · ") || null,
          employment_type: str(categories.commitment),
          salary:
            typeof salary.min === "number"
              ? `${salary.currency ?? ""} ${salary.min}–${salary.max ?? ""} ${salary.interval ?? ""}`.replace(/\s+/g, " ").trim()
              : null,
          description: (str(job.descriptionPlain) ?? htmlToText(str(job.description)))?.slice(0, 20_000) ?? null,
          posted_at: iso(job.createdAt),
          metadata: meta,
        };
      });
      return { board, boardUrl, jobs };
    }
    case "ashby": {
      const boardUrl = `https://jobs.ashbyhq.com/${t}`;
      const data = obj(await json(read, `https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=true`));
      const jobs = arr(data.jobs)
        .map(obj)
        .filter((job) => job.isListed !== false)
        .map((job) => ({
          ...base(board, ctx, boardUrl),
          external_id: `${board.token}:${job.id}`,
          url: str(job.jobUrl) ?? `${boardUrl}/${job.id}`,
          title: str(job.title) ?? "Untitled role",
          location: str(job.location),
          remote: typeof job.isRemote === "boolean" ? job.isRemote : null,
          department: [str(job.department), str(job.team)].filter((v, i, all) => v && all.indexOf(v) === i).join(" · ") || null,
          employment_type: str(job.employmentType),
          salary: str(obj(job.compensation).compensationTierSummary),
          description: (str(job.descriptionPlain) ?? htmlToText(str(job.descriptionHtml)))?.slice(0, 20_000) ?? null,
          posted_at: iso(job.publishedAt),
          metadata: meta,
        }));
      return { board, boardUrl, jobs };
    }
    case "workable": {
      const boardUrl = `https://apply.workable.com/${t}`;
      const data = obj(await json(read, `https://www.workable.com/api/accounts/${t}?details=true`));
      const jobs = arr(data.jobs).map((raw) => {
        const job = obj(raw);
        const place = [str(job.city), str(job.state), str(job.country)].filter(Boolean).join(", ");
        return {
          ...base(board, ctx, boardUrl),
          external_id: `${board.token}:${job.shortcode ?? job.url}`,
          url: str(job.shortlink) ?? str(job.url) ?? `${boardUrl}/j/${job.shortcode}`,
          title: str(job.title) ?? "Untitled role",
          location: place || null,
          remote: typeof job.telecommuting === "boolean" ? job.telecommuting : null,
          department: str(job.department),
          employment_type: str(job.employment_type),
          description: htmlToText(str(job.description)),
          posted_at: iso(job.published_on) ?? iso(job.created_at),
          metadata: meta,
        };
      });
      return { board, boardUrl, companyName: str(data.name) ?? undefined, jobs };
    }
    case "smartrecruiters": {
      const boardUrl = `https://jobs.smartrecruiters.com/${t}`;
      const jobs: JobInput[] = [];
      // The read must be complete (missing postings get closed), so page to totalFound; a capped or stalled
      // listing throws and the board is skipped rather than half-read.
      let total = Number.POSITIVE_INFINITY;
      for (let offset = 0; offset < total; offset += 100) {
        if (offset >= SMARTRECRUITERS_MAX) throw new Error(`${boardUrl} lists more than ${SMARTRECRUITERS_MAX} postings; not read`);
        const data = obj(await json(read, `https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=100&offset=${offset}`));
        if (typeof data.totalFound === "number") total = data.totalFound;
        const page = arr(data.content).map(obj);
        for (const job of page) {
          const location = obj(job.location);
          jobs.push({
            ...base(board, ctx, boardUrl),
            external_id: `${board.token}:${job.id}`,
            url: `${boardUrl}/${job.id}`,
            title: str(job.name) ?? "Untitled role",
            location: str(location.fullLocation) ?? ([str(location.city), str(location.country)].filter(Boolean).join(", ") || null),
            remote: typeof location.remote === "boolean" ? location.remote : null,
            department: str(obj(job.department).label) ?? str(obj(job.function).label),
            employment_type: str(obj(job.typeOfEmployment).label),
            posted_at: iso(job.releasedDate),
            metadata: meta,
          });
        }
        if (page.length < 100) {
          if (Number.isFinite(total) && offset + page.length < total)
            throw new Error(`${boardUrl} stopped at ${offset + page.length} of ${total} postings`);
          break;
        }
      }
      return { board, boardUrl, jobs };
    }
    case "recruitee": {
      const boardUrl = `https://${t}.recruitee.com`;
      const data = obj(await json(read, `${boardUrl}/api/offers`));
      const jobs = arr(data.offers).map((raw) => {
        const job = obj(raw);
        return {
          ...base(board, ctx, boardUrl),
          external_id: `${board.token}:${job.id}`,
          url: str(job.careers_url) ?? `${boardUrl}/o/${job.slug}`,
          title: str(job.title) ?? "Untitled role",
          location: str(job.location) ?? ([str(job.city), str(job.country)].filter(Boolean).join(", ") || null),
          remote: typeof job.remote === "boolean" ? job.remote : null,
          department: str(job.department),
          employment_type: str(job.employment_type_code),
          description: htmlToText([str(job.description), str(job.requirements)].filter(Boolean).join("\n")),
          posted_at: iso(job.published_at) ?? iso(job.created_at),
          metadata: meta,
        };
      });
      return { board, boardUrl, companyName: str(arr(data.offers).map(obj)[0]?.company_name) ?? undefined, jobs };
    }
    case "bamboohr": {
      const boardUrl = `https://${t}.bamboohr.com/careers`;
      const data = obj(await json(read, `https://${t}.bamboohr.com/careers/list`));
      const jobs = arr(data.result).map((raw) => {
        const job = obj(raw);
        const location = obj(job.location);
        return {
          ...base(board, ctx, boardUrl),
          external_id: `${board.token}:${job.id}`,
          url: `${boardUrl}/${job.id}`,
          title: str(job.jobOpeningName) ?? "Untitled role",
          location: [str(location.city), str(location.state)].filter(Boolean).join(", ") || null,
          remote: job.isRemote === true ? true : null,
          department: str(job.departmentLabel),
          employment_type: str(job.employmentStatusLabel),
          metadata: meta,
        };
      });
      return { board, boardUrl, jobs };
    }
    case "teamtailor": {
      // Every Teamtailor career site publishes its open jobs as RSS, with the posting date.
      const boardUrl = `https://${t}.teamtailor.com/jobs`;
      const $ = await xml(read, `${boardUrl}.rss`);
      const jobs = $("item")
        .toArray()
        .map((item) => {
          const node = $(item);
          const url = node.children("link").first().text().trim() || boardUrl;
          const place = node.find("tt\\:location, location").first();
          const city = place.find("tt\\:city, city").first().text().trim();
          const country = place.find("tt\\:country, country").first().text().trim();
          return {
            ...base(board, ctx, boardUrl),
            external_id: `${board.token}:${node.children("guid").first().text().trim() || url}`,
            url,
            title: node.children("title").first().text().trim() || "Untitled role",
            location: [city, country].filter(Boolean).join(", ") || null,
            remote: /^(?:fully|remote)/i.test(node.children("remoteStatus").first().text().trim()) || null,
            department: node.find("tt\\:department, department").first().text().trim() || null,
            description: htmlToText(node.children("description").first().text()),
            posted_at: iso(node.children("pubDate").first().text().trim()),
            metadata: meta,
          };
        });
      const channel = $("channel > title").first().text().trim();
      return { board, boardUrl, companyName: channel || undefined, jobs };
    }
    case "personio": {
      // Personio's public XML feed of open positions; the account lives on .de or .com.
      let found: { $: ReturnType<typeof load>; host: string } | null = null;
      for (const host of ["jobs.personio.de", "jobs.personio.com"]) {
        try {
          found = { $: await xml(read, `https://${t}.${host}/xml?language=en`), host };
          if (found.$("position").length || found.$("workzag-jobs").length) break;
        } catch (error) {
          if (!(error instanceof BoardNotFound)) throw error;
        }
      }
      if (!found) throw new BoardNotFound(`https://${t}.jobs.personio.de/xml`);
      const { $, host } = found;
      const boardUrl = `https://${t}.${host}`;
      let companyName: string | undefined;
      const jobs = $("position")
        .toArray()
        .map((item) => {
          const node = $(item);
          const field = (name: string) => node.children(name).first().text().trim() || null;
          companyName ??= field("subcompany") ?? undefined;
          const id = field("id") ?? field("name") ?? "";
          const description = node
            .find("jobDescription")
            .toArray()
            .map((part) => $(part).find("value").text())
            .join("\n");
          return {
            ...base(board, ctx, boardUrl),
            external_id: `${board.token}:${id}`,
            url: `${boardUrl}/job/${id}`,
            title: field("name") ?? "Untitled role",
            location: field("office"),
            department: field("department"),
            employment_type: field("employmentType") ?? field("schedule"),
            description: htmlToText(description),
            posted_at: iso(field("createdAt")),
            metadata: meta,
          };
        });
      return { board, boardUrl, companyName, jobs };
    }
    case "gem": {
      const boardUrl = `https://jobs.gem.com/${t}`;
      const data = arr(await json(read, `https://api.gem.com/job_board/v0/${t}/job_posts/`));
      const jobs = data.map(obj).map((job) => ({
        ...base(board, ctx, boardUrl),
        external_id: `${board.token}:${job.id}`,
        url: str(job.absolute_url) ?? `${boardUrl}/${job.id}`,
        title: str(job.title) ?? "Untitled role",
        location: str(obj(job.location).name),
        remote: str(job.location_type) ? job.location_type === "remote" : null,
        department:
          arr(job.departments)
            .map((d) => str(obj(d).name))
            .filter(Boolean)
            .join(", ") || null,
        employment_type: str(job.employment_type),
        description: (str(job.content_plain) ?? htmlToText(str(job.content)))?.slice(0, 20_000) ?? null,
        posted_at: iso(job.first_published_at) ?? iso(job.created_at),
        metadata: meta,
      }));
      return { board, boardUrl, jobs };
    }
  }
}

async function xml(read: ReadText, url: string): Promise<ReturnType<typeof load>> {
  let response: Awaited<ReturnType<ReadText>>;
  try {
    response = await read(url, {
      timeoutMs: 30_000,
      maxBytes: 25_000_000,
      headers: { accept: "application/xml,text/xml,*/*", "user-agent": USER_AGENT },
    });
  } catch (error) {
    if (error instanceof Error && /\bHTTP 404\b/.test(error.message)) throw new BoardNotFound(url);
    throw error;
  }
  if (response.status >= 400 || !/^\s*(?:<\?xml|<rss|<workzag)/i.test(response.text)) throw new BoardNotFound(url);
  return load(response.text, { xml: true });
}

const defaultRead: ReadText = (url, options) =>
  readPublicText(url, { timeoutMs: options?.timeoutMs, headers: options?.headers, maxBytes: options?.maxBytes });

/** The name and website an Ashby board page publishes for its organization (its JSON feed carries neither). */
export async function ashbyOrganization(token: string, read: ReadText = defaultRead): Promise<{ name?: string; website?: string }> {
  try {
    const page = await read(`https://jobs.ashbyhq.com/${encodeURIComponent(token)}`, {
      timeoutMs: 15_000,
      headers: { accept: "text/html,*/*", "user-agent": USER_AGENT },
    });
    const org = /"organization":\{[^{}]*?"name":"([^"]+)"[^{}]*?"publicWebsite":"([^"]*)"/.exec(page.text);
    return { name: org?.[1], website: org?.[2] || undefined };
  } catch {
    return {};
  }
}

/** A company name with only legal suffixes dropped: "Acme Labs" and "Acme AI" stay different companies. */
function legalName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:inc|llc|ltd|limited|gmbh|corp|corporation|co|pvt|private|plc|sa|ag|bv)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function normalName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:inc|llc|ltd|limited|gmbh|corp|corporation|technologies|labs|ai|hq|pvt|private)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function domainStem(website: string): string | null {
  try {
    const host = new URL(website).hostname.replace(/^www\./, "");
    return host.split(".")[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * A board found by guessing its name is only kept when its own data ties it to this company: the
 * ATS's company name matches, or a posting mentions the company's domain. Otherwise a same-named
 * stranger (another "Harbinger") would be filed under this company.
 */
export function boardBelongsTo(read: BoardRead, company: string, website: string): boolean {
  if (read.jobs.length === 0) return false;
  // Descriptive words (labs, ai, technologies) are part of the name here: stripping them filed a stranger's
  // "Acme Labs" board under a funded "Acme AI".
  if (read.companyName && legalName(read.companyName) && legalName(read.companyName) === legalName(company)) return true;
  let host: string;
  try {
    host = new URL(website).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return false;
  }
  if (read.companyWebsite) {
    try {
      const listed = new URL(read.companyWebsite).hostname.replace(/^www\./, "").toLowerCase();
      if (listed === host || listed.endsWith(`.${host}`) || host.endsWith(`.${listed}`)) return true;
    } catch {}
  }
  return read.jobs.some((job) => `${job.description ?? ""} ${job.url}`.toLowerCase().includes(host));
}

const GUESSED_ATS = ["greenhouse", "lever", "ashby", "workable", "recruitee", "teamtailor", "personio", "gem"] as const;

/** Board names a company is likely to use: its domain's first label, and its name squashed or hyphenated. */
export function boardTokens(company: string, website: string): string[] {
  const words = company
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim();
  const tokens = [domainStem(website), normalName(company), words.replace(/[\s-]+/g, ""), words.replace(/[\s-]+/g, "-")];
  return [...new Set(tokens.filter((value): value is string => !!value && value.length > 2))];
}

export interface CompanyJobsResult {
  company: string;
  website: string;
  boards: BoardRead[];
  /** Pages read while looking for the board. */
  checked: string[];
  warnings: string[];
}

/**
 * Finds a company's job board from its website (homepage, then its careers pages), reads every board
 * found, and falls back to verified name guesses on Greenhouse, Lever and Ashby.
 */
export async function collectCompanyJobs(
  input: { company: string; website: string; signalId?: string | null },
  read: ReadText = defaultRead,
): Promise<CompanyJobsResult> {
  const { company, website } = input;
  const checked: string[] = [];
  const warnings: string[] = [];
  const boards = new Map<string, JobBoard>();
  const add = (found: JobBoard[]) => {
    for (const board of found) boards.set(`${board.ats}:${board.token.toLowerCase()}`, board);
  };

  const page = async (url: string) => {
    if (checked.includes(url)) return null;
    checked.push(url);
    try {
      const response = await read(url, { timeoutMs: 15_000, headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" } });
      if (response.status >= 400) return null;
      add(detectBoards(response.text, response.url));
      return response;
    } catch (error) {
      warnings.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const home = await page(website);
  const candidates = home ? careerLinks(home.text, home.url) : [];
  for (const path of ["/careers", "/jobs"]) {
    try {
      candidates.push(new URL(path, home?.url ?? website).href);
    } catch {}
  }
  for (const url of [...new Set(candidates)].slice(0, 4)) {
    if (boards.size) break;
    const response = await page(url);
    // A careers page often links one level deeper ("See open roles").
    if (response && !boards.size) for (const deeper of careerLinks(response.text, response.url).slice(0, 2)) await page(deeper);
  }

  const ctx = { company, companyWebsite: website, signalId: input.signalId };
  const reads: BoardRead[] = [];
  for (const board of boards.values()) {
    try {
      reads.push(await readBoard(board, ctx, read));
    } catch (error) {
      if (!(error instanceof BoardNotFound))
        warnings.push(`${board.ats}/${board.token}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!reads.length) {
    // No board linked from the site: try the company's name on each ATS with a public feed, and keep a board only
    // when the ATS's own data ties it to this company (its name, the website it lists, or the domain in a posting).
    for (const ats of GUESSED_ATS) {
      for (const token of boardTokens(company, website)) {
        try {
          const result = await readBoard({ ats, token, foundOn: "name-guess" }, ctx, read);
          if (ats === "ashby" && result.jobs.length) {
            const org = await ashbyOrganization(token, read);
            result.companyName ??= org.name;
            result.companyWebsite ??= org.website;
          }
          if (boardBelongsTo(result, company, website)) {
            for (const job of result.jobs) job.metadata = { ...job.metadata, discovery: "name-guess-verified" };
            reads.push(result);
          }
        } catch {}
      }
      if (reads.length) break;
    }
  }
  return { company, website, boards: reads, checked, warnings };
}
