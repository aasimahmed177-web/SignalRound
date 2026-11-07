// Remote-job boards that publish their listings as public JSON or RSS (no account, no key): Jobicy, Himalayas,
// We Work Remotely, Remotive and Remote OK. Each reader returns postings in the job contract (lib/jobs.ts) with the
// description as plain text, so emails and apply links are read from what a visitor sees.

import { readPublicText } from "@fireround/core/web/transport";
import { load } from "cheerio";
import type { ReadText } from "./job-boards.ts";
import type { JobInput } from "./jobs.ts";

export const REMOTE_BOARDS = ["jobicy", "himalayas", "weworkremotely", "remotive", "remoteok"] as const;
export type RemoteBoard = (typeof REMOTE_BOARDS)[number];

/** HTML → the text a reader sees, one block per line. Links keep only their visible text. */
export function htmlText(html: string): string {
  const $ = load(html.includes("&lt;") && !html.includes("<") ? load(html).text() : html);
  $("br").replaceWith("\n");
  $("p, li, div, h1, h2, h3, h4, h5, h6, tr").each((_, node) => {
    $(node).append("\n");
  });
  return $.root()
    .text()
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Every http(s) link in a posting's HTML, in order: an employer's own apply or careers link is often among them. */
export function htmlLinks(html: string): string[] {
  const $ = load(html);
  return $("a[href]")
    .toArray()
    .map((node) => $(node).attr("href")?.trim() ?? "")
    .filter((href) => /^https?:\/\//i.test(href));
}

const MARKETING_QUERIES = ["marketing", "seo", "social media", "content", "growth", "brand", "copywriter", "paid media", "email marketing"];

const iso = (value: string | number | undefined | null) => {
  if (value === undefined || value === null || value === "") return null;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

function posting(
  source: RemoteBoard,
  fields: Omit<JobInput, "source" | "description" | "metadata"> & { html: string; metadata?: Record<string, unknown> },
): JobInput {
  const { html, metadata, ...rest } = fields;
  return {
    ...rest,
    source,
    remote: true,
    description: htmlText(html).slice(0, 20_000),
    metadata: { collector: source, links: htmlLinks(html), ...metadata },
  };
}

type Json = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

async function json(read: ReadText, url: string): Promise<unknown> {
  const page = await read(url, { timeoutMs: 30_000, maxBytes: 8_000_000, headers: { accept: "application/json" } });
  if (page.status >= 400) throw new Error(`HTTP ${page.status} for ${url}`);
  return JSON.parse(page.text);
}

export async function readJobicy(read: ReadText): Promise<JobInput[]> {
  const data = (await json(read, "https://jobicy.com/api/v2/remote-jobs?count=100&industry=marketing")) as { jobs?: Json[] };
  return (data.jobs ?? []).map((job) =>
    posting("jobicy", {
      external_id: String(job.id),
      url: String(job.url),
      title: String(job.jobTitle),
      company: String(job.companyName),
      location: str(Array.isArray(job.jobGeo) ? job.jobGeo.join(", ") : job.jobGeo),
      employment_type: str(Array.isArray(job.jobType) ? job.jobType.join(", ") : job.jobType),
      posted_at: iso(str(job.pubDate)),
      html: String(job.jobDescription ?? ""),
    }),
  );
}

export async function readHimalayas(read: ReadText, since: Date, pages = 8): Promise<JobInput[]> {
  const out: JobInput[] = [];
  for (const query of MARKETING_QUERIES) {
    // Search results are not ordered by date, so read a fixed number of pages and filter.
    for (let page = 1; page <= pages; page++) {
      const data = (await json(read, `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(query)}&page=${page}`).catch(
        () => ({}),
      )) as { jobs?: Json[] };
      const jobs = data.jobs ?? [];
      for (const job of jobs) {
        const posted = iso(Number(job.pubDate));
        if (!posted || new Date(posted) < since) continue;
        const restrictions = Array.isArray(job.locationRestrictions) ? job.locationRestrictions.join(", ") : null;
        out.push(
          posting("himalayas", {
            external_id: String(job.guid),
            url: String(job.guid),
            title: String(job.title),
            company: String(job.companyName),
            location: restrictions ? `Remote (${restrictions})` : "Remote",
            employment_type: str(job.employmentType),
            posted_at: posted,
            html: String(job.description ?? ""),
          }),
        );
      }
      if (jobs.length < 20) break;
    }
  }
  return out;
}

export async function readWeWorkRemotely(read: ReadText): Promise<JobInput[]> {
  const page = await read("https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss", {
    timeoutMs: 30_000,
    maxBytes: 8_000_000,
  });
  const $ = load(page.text, { xml: true });
  return $("item")
    .toArray()
    .map((node) => {
      const item = $(node);
      const [company, ...title] = item.find("title").first().text().split(": ");
      const url = item.find("link").first().text().trim() || item.find("guid").first().text().trim();
      return posting("weworkremotely", {
        external_id: url,
        url,
        title: title.join(": ") || String(company),
        company: String(company),
        location: str(item.find("region").first().text()),
        employment_type: str(item.find("type").first().text()),
        posted_at: iso(item.find("pubDate").first().text()),
        html: item.find("description").first().text(),
      });
    });
}

export async function readRemotive(read: ReadText): Promise<JobInput[]> {
  const data = (await json(read, "https://remotive.com/api/remote-jobs?category=marketing")) as { jobs?: Json[] };
  return (data.jobs ?? []).map((job) =>
    posting("remotive", {
      external_id: String(job.id),
      url: String(job.url),
      title: String(job.title),
      company: String(job.company_name),
      location: str(job.candidate_required_location),
      employment_type: str(job.job_type),
      posted_at: iso(`${str(job.publication_date)}Z`),
      html: String(job.description ?? ""),
    }),
  );
}

export async function readRemoteOk(read: ReadText): Promise<JobInput[]> {
  const data = (await json(read, "https://remoteok.com/api")) as Json[];
  return data
    .filter((job) => job.id && job.position)
    .map((job) =>
      posting("remoteok", {
        external_id: String(job.id),
        url: String(job.url),
        title: String(job.position),
        company: String(job.company),
        location: str(job.location),
        posted_at: iso(str(job.date)),
        html: String(job.description ?? ""),
      }),
    );
}

const defaultRead: ReadText = (url, options) =>
  readPublicText(url, { timeoutMs: options?.timeoutMs ?? 30_000, maxBytes: options?.maxBytes ?? 8_000_000, headers: options?.headers });

export async function readRemoteBoards(
  since: Date,
  options: { boards?: readonly RemoteBoard[]; read?: ReadText; log?: (message: string) => void } = {},
): Promise<JobInput[]> {
  const read = options.read ?? defaultRead;
  const readers: Record<RemoteBoard, () => Promise<JobInput[]>> = {
    jobicy: () => readJobicy(read),
    himalayas: () => readHimalayas(read, since),
    weworkremotely: () => readWeWorkRemotely(read),
    remotive: () => readRemotive(read),
    remoteok: () => readRemoteOk(read),
  };
  const lists = await Promise.all(
    (options.boards ?? REMOTE_BOARDS).map(async (board) => {
      try {
        const jobs = await readers[board]();
        options.log?.(`${board}: ${jobs.length} posting(s)`);
        return jobs;
      } catch (error) {
        options.log?.(`${board} failed: ${(error as Error).message}`);
        return [];
      }
    }),
  );
  return lists.flat();
}
