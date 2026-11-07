// Reddit and X posts from the last few days that hire for a marketing role and write an email to apply to.
// Logged out only: Reddit's public JSON search (old.reddit.com), falling back to its public Atom feeds when the JSON
// asks for a login; X through `agent-reach --backend public-web` (no browser, no session), skipped when unavailable.
// People offering their services ([For Hire]) are dropped. An email is kept only when it appears verbatim in the post.

import { execFile } from "node:child_process";
import { load } from "cheerio";
import { emailQuote, marketingRole, postCompany, postedVerbatim, postLocation, readCapped } from "./linkedin-posts.ts";
import { companyBrief, employerLink, isMarketingTitle, type MarketingJob, plainText, postingEmails } from "./marketing-jobs.ts";

const DAY_MS = 86_400_000;
export const SOCIAL_USER_AGENT =
  "SignalRound/0.2 marketing-job research, logged out, read-only (+https://github.com/aasimahmed177-web/SignalRound)";

/** Subreddits that carry hiring posts, with the search that finds marketing ones there. */
export const SUBREDDITS: Array<[subreddit: string, query: string]> = [
  ["forhire", "hiring marketing"],
  ["hiring", "marketing"],
  ["jobbit", "marketing"],
  ["marketingjobs", "hiring"],
  ["DigitalMarketingJobs", "hiring"],
  ["DigitalMarketing", "hiring"],
  ["marketing", "hiring"],
  ["SocialMediaMarketing", "hiring"],
  ["RemoteJobs", "marketing"],
];

export const X_QUERIES = [
  '"hiring" "marketing" "send your cv" email',
  '"we are hiring" "social media manager" email',
  '"hiring" "digital marketing" "resume to"',
];

export interface SocialPost {
  source: "reddit" | "x";
  url: string;
  title: string;
  text: string;
  author: string;
  posted_at: string;
}

const FOR_HIRE = /\[\s*for\s*hire\s*\]|\bfor hire\b|\bhire me\b|\bavailable for (?:work|hire|projects)\b|\b(?:my|our) services\b/i;
const HIRING_TAG = /\[\s*(?:hiring|job|task)\s*\]/gi;
// Platform and system mailboxes are never an application address.
const NOT_APPLY_EMAIL =
  /^(?:no-?reply|do-?not-?reply|noreply|system|mailer-daemon|notifications?|admin|mod(?:erator)?s?)@|@(?:[\w-]+\.)*(?:reddit(?:mail)?\.com|redd\.it|x\.com|twitter\.com)$/i;
const REMOTE = /\b(?:remote|work from home|wfh|anywhere)\b/i;

/** Reddit's search JSON (a Listing) → posts. */
export function parseRedditJson(json: unknown): SocialPost[] {
  const children = (json as { data?: { children?: Array<{ data?: Record<string, unknown> }> } })?.data?.children ?? [];
  return children.flatMap(({ data }) => {
    if (!data || typeof data.permalink !== "string" || typeof data.created_utc !== "number") return [];
    return [
      {
        source: "reddit" as const,
        url: `https://www.reddit.com${data.permalink}`,
        title: String(data.title ?? ""),
        text: String(data.selftext ?? ""),
        author: String(data.author ?? ""),
        posted_at: new Date(data.created_utc * 1000).toISOString(),
      },
    ];
  });
}

/** Reddit's public Atom feed (…/new.rss, …/search.rss) → posts; the body is the post's rendered markdown. */
export function parseRedditAtom(xml: string): SocialPost[] {
  const $ = load(xml, { xml: true });
  return $("entry")
    .toArray()
    .flatMap((entry) => {
      const url = $(entry).find("link").attr("href");
      const posted = $(entry).find("published").text() || $(entry).find("updated").text();
      if (!url || !posted) return [];
      const date = new Date(posted);
      if (Number.isNaN(date.getTime())) return [];
      const body = load($(entry).find("content").text());
      body("p, li, br, h1, h2, h3, h4, blockquote, pre").after("\n");
      const text = (body(".md").first().text() || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
      return [
        {
          source: "reddit" as const,
          url,
          title: $(entry).find("title").first().text(),
          text,
          author: $(entry)
            .find("author name")
            .text()
            .replace(/^\/?u\//, ""),
          posted_at: date.toISOString(),
        },
      ];
    });
}

/** agent-reach JSON output → X posts (only x.com/twitter.com status links with a date). */
export function parseAgentReach(output: string): SocialPost[] {
  const items = (JSON.parse(output) as { items?: Array<Record<string, unknown>> }).items ?? [];
  return items.flatMap((item) => {
    const url = [item.url, item.link].find(
      (v): v is string => typeof v === "string" && /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/\w+\/status\/\d+/.test(v),
    );
    const text = [item.text, item.content, item.full_text, item.snippet, item.description].find((v): v is string => typeof v === "string");
    const date = [item.published_at, item.published, item.created_at, item.date].find((v): v is string => typeof v === "string");
    const posted = date ? new Date(date) : null;
    if (!url || !text || !posted || Number.isNaN(posted.getTime())) return [];
    const author = typeof item.author === "string" ? item.author : (url.match(/\.com\/(\w+)\//)?.[1] ?? "");
    return [{ source: "x" as const, url, title: "", text, author, posted_at: posted.toISOString() }];
  });
}

/** A post → a marketing role with an application email, or why it was dropped. */
export function toSocialJob(post: SocialPost, since: Date, now: Date): MarketingJob | string {
  const posted = new Date(post.posted_at);
  if (Number.isNaN(posted.getTime()) || posted < since) return "older than the window";
  if (posted.getTime() > now.getTime() + DAY_MS) return "dated in the future";
  if (FOR_HIRE.test(post.title)) return "offering services";
  const title = post.title.replace(HIRING_TAG, "Hiring:").trim();
  const text = [title, post.text].filter(Boolean).join("\n");
  const fromTitle = post.title.replace(HIRING_TAG, "").trim();
  const role = marketingRole(text) ?? (/\[\s*hiring\s*\]/i.test(post.title) && isMarketingTitle(fromTitle) ? fromTitle : null);
  if (!role) return "not a marketing hiring post";
  const body = plainText(text);
  const emails = postingEmails(text).emails.filter((email) => !NOT_APPLY_EMAIL.test(email) && postedVerbatim(body, email));
  if (!emails.length) return "no application email";
  const company = postCompany(text, emails) ?? (post.source === "reddit" ? `u/${post.author}` : `@${post.author}`);
  const location = postLocation(text);
  return {
    title: role,
    company,
    company_brief: companyBrief(company, text),
    location,
    remote: REMOTE.test(`${role} ${location ?? ""}`) ? true : null,
    posted_at: posted.toISOString(),
    source: post.source,
    source_url: post.url,
    apply_url: employerLink(body.match(/https?:\/\/[^\s<>()"'\]]+/g) ?? []) ?? post.url,
    emails,
    email_source_quote: [...new Set(emails.map((email) => emailQuote(body, email) ?? ""))].filter(Boolean).join(" … ") || null,
  };
}

export type SocialFetch = (url: string) => Promise<{ status: number; text: string; retryAfter?: number }>;
export type RunAgentReach = (args: string[]) => Promise<string>;

const fetchPublic: SocialFetch = async (url) => {
  // A redirect (Reddit sends logged-out JSON to its login page) is reported, never followed.
  const res = await fetch(url, { headers: { "user-agent": SOCIAL_USER_AGENT }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  return {
    status: res.status,
    text: res.status === 200 ? await readCapped(res, 5_000_000) : "",
    retryAfter: Number(res.headers.get("retry-after")) || undefined,
  };
};

const runAgentReach: RunAgentReach = (args) =>
  new Promise((resolve, reject) =>
    execFile("agent-reach", args, { timeout: 120_000, maxBuffer: 8_000_000 }, (error, stdout) =>
      // agent-reach prints its JSON (with ok:false) even when it exits non-zero.
      stdout.trim() ? resolve(stdout) : reject(error ?? new Error("agent-reach printed nothing")),
    ),
  );

export interface SocialOptions {
  days: number;
  now?: Date;
  subreddits?: Array<[string, string]>;
  /** X search through agent-reach's public-web backend; false skips X. */
  xQueries?: string[] | false;
  fetch?: SocialFetch;
  agentReach?: RunAgentReach;
  /** Pause between Reddit requests (default 6s; Reddit rate-limits logged-out readers hard). */
  delayMs?: number;
  log?: (message: string) => void;
}

export async function collectSocialHiring(options: SocialOptions): Promise<{ jobs: MarketingJob[]; stats: Record<string, number> }> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - options.days * DAY_MS);
  const read = options.fetch ?? fetchPublic;
  const delay = options.delayMs ?? 6_000;
  const log = options.log ?? (() => {});
  const stats: Record<string, number> = {};
  const count = (key: string, by = 1) => {
    stats[key] = (stats[key] ?? 0) + by;
  };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const get = async (url: string) => {
    await wait(delay);
    let res = await read(url).catch((error: Error) => ({ status: 0, text: error.message, retryAfter: undefined }));
    if (res.status === 429) {
      count("reddit_rate_limited");
      await wait(delay ? Math.min(res.retryAfter ?? 60, 90) * 1000 : 0);
      res = await read(url).catch((error: Error) => ({ status: 0, text: error.message, retryAfter: undefined }));
    }
    return res;
  };

  const posts: SocialPost[] = [];
  let jsonBlocked = false;
  const t = options.days <= 1 ? "day" : options.days <= 7 ? "week" : "month";
  for (const [subreddit, query] of options.subreddits ?? SUBREDDITS) {
    const params = `q=${encodeURIComponent(query)}&sort=new&restrict_sr=1&t=${t}&limit=100`;
    if (!jsonBlocked) {
      const res = await get(`https://old.reddit.com/r/${subreddit}/search.json?${params}`);
      if (res.status === 200 && res.text.trim().startsWith("{")) {
        const found = parseRedditJson(JSON.parse(res.text));
        count("reddit_json_posts", found.length);
        posts.push(...found);
        continue;
      }
      // Logged-out JSON redirects to a login page or is refused: use the public feeds for the rest of the run.
      jsonBlocked = true;
      count("reddit_json_blocked");
      log(`reddit JSON needs a login (HTTP ${res.status}); reading the public Atom feeds instead`);
    }
    let found: SocialPost[] = [];
    for (const url of [
      `https://www.reddit.com/r/${subreddit}/search.rss?${params}`,
      `https://www.reddit.com/r/${subreddit}/new.rss?limit=100`,
    ]) {
      const res = await get(url);
      if (res.status !== 200) {
        count(`reddit_feed_http_${res.status}`);
        continue;
      }
      found = parseRedditAtom(res.text);
      break;
    }
    if (!found.length) log(`r/${subreddit}: no posts read`);
    count("reddit_feed_posts", found.length);
    posts.push(...found);
  }

  if (options.xQueries !== false) {
    const run = options.agentReach ?? runAgentReach;
    for (const query of options.xQueries ?? X_QUERIES) {
      try {
        const output = JSON.parse(await run(["twitter", "search", query, "--limit", "20", "--backend", "public-web"])) as {
          ok?: boolean;
          error?: { code?: string; message?: string };
        };
        if (!output.ok) throw new Error(output.error?.code ?? output.error?.message ?? "not ok");
        const found = parseAgentReach(JSON.stringify(output));
        count("x_posts", found.length);
        posts.push(...found);
      } catch (error) {
        // Logged-out X search is often unavailable (rate limit, no public route): record it and move on.
        stats.x_unavailable = 1;
        log(`x search unavailable, skipped: ${(error as Error).message.slice(0, 160)}`);
        break;
      }
    }
  }

  const seen = new Set<string>();
  const jobs: MarketingJob[] = [];
  for (const post of posts) {
    if (seen.has(post.url)) continue;
    seen.add(post.url);
    const job = toSocialJob(post, since, now);
    if (typeof job === "string") count(`dropped:${job}`);
    else jobs.push(job);
  }
  stats.social_with_email = jobs.length;
  return { jobs: jobs.sort((a, b) => b.posted_at.localeCompare(a.posted_at)), stats };
}
