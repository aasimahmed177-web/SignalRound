import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { closeDb } from "@fireround/core/db";
import { openStore } from "../lib/db.ts";
import { scanCompanies, storeScans } from "../lib/job-collector.ts";
import { DEFAULT_FIT, listArg, rankJobs } from "../lib/job-fit.ts";
import { closeStaleJobs, fundedCompanies, type ParsedJob, parseJobInput, upsertJob } from "../lib/jobs.ts";
import { JOBSPY_SITES, type JobSpySite, searchJobSpy } from "../lib/jobspy.ts";
import { collectLinkedInPosts, toJobInput } from "../lib/linkedin-posts.ts";
import { collectMarketingJobs, dedupeMarketingJobs } from "../lib/marketing-jobs.ts";
import { collectSocialHiring } from "../lib/social-hiring.ts";

const HELP = `SignalRound job collector (dry run unless --apply)

Funded startups (default): reads the job boards of companies in the Signal Inbox
  pnpm collect:jobs -- --limit 25 --apply

One company:
  pnpm collect:jobs -- --website https://linear.app --company Linear --apply

Job-site search via JobSpy, logged out (LinkedIn, Indeed, Naukri, Glassdoor, Google...):
  pnpm collect:jobs -- --search "backend engineer" --location Bengaluru --sites linkedin,naukri --country india --hours 72 --results 30 --apply

LinkedIn posts hiring for marketing roles with an email to apply to, logged out (Exa search + public post pages):
  pnpm collect:jobs -- --linkedin-posts --days 7 --out evals/runs/linkedin-posts.json --apply
  Re-verify an earlier run's posts without searching: add --recheck evals/runs/linkedin-posts.json

Recent marketing roles from every logged-out source (JobSpy boards, remote-job feeds, LinkedIn posts), split into
roles with an employer-written email and roles with an apply link. Always a dry run; writes only --out:
  pnpm collect:jobs -- --marketing --days 7 --out evals/runs/marketing-jobs.json
  Add Reddit/X hiring posts with an email: --social (or --only-social for those alone; X is skipped when unavailable)
  Skip a source: --no-jobspy, --no-boards, --no-linkedin-posts. Re-verify earlier LinkedIn posts: --seed <file> (repeatable)
  Rank by fit and write the best N instead: --rank --top 30 [--seniority "manager,lead,head,senior"] [--locations "Bengaluru,Mumbai,Remote"]
`;

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function numberArg(name: string, fallback?: number): number | undefined {
  const raw = value(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${name} must be a positive number`);
  return parsed;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const apply = process.argv.includes("--apply");
const search = value("--search");
const website = value("--website");
console.log(`SignalRound job collector (${apply ? "apply" : "dry run"})`);

function print(job: ParsedJob) {
  const where = [job.location, job.remote ? "remote" : null].filter(Boolean).join(" · ");
  console.log(`  ${job.title}${where ? ` — ${where}` : ""}`);
  console.log(`    ${job.url}`);
}

if (process.argv.includes("--marketing")) {
  const days = numberArg("--days", 7)!;
  const out = value("--out");
  // Earlier runs' LinkedIn post URLs are re-read (not trusted): Exa's free tier may be rate-limited today.
  const seedFiles = process.argv.flatMap((arg, i) => (arg === "--seed" ? [process.argv[i + 1] ?? ""] : []));
  const seeds: string[] = [];
  for (const file of seedFiles.length ? seedFiles : ["evals/runs/linkedin-posts.json", ...(out ? [out] : [])]) {
    const text = await readFile(file, "utf8").catch(() => "");
    seeds.push(...(text.match(/https:\/\/[^\s"]*linkedin\.com\/posts\/[^\s"]+/g) ?? []));
  }
  const onlySocial = process.argv.includes("--only-social");
  const social = onlySocial || process.argv.includes("--social");
  console.log(`Collecting marketing roles from the last ${days} day(s), logged out (${seeds.length} known LinkedIn posts to re-verify)`);
  const log = (message: string) => console.log(`  ${message}`);
  const [{ run, stats }, socialRun] = await Promise.all([
    collectMarketingJobs({
      days,
      searches: onlySocial || process.argv.includes("--no-jobspy") ? false : undefined,
      boards: onlySocial || process.argv.includes("--no-boards") ? false : undefined,
      linkedinPosts: onlySocial || process.argv.includes("--no-linkedin-posts") ? false : { seeds },
      siteBriefs: onlySocial ? false : undefined,
      log,
    }),
    social ? collectSocialHiring({ days, log }) : null,
  ]);
  if (socialRun) {
    Object.assign(stats, socialRun.stats);
    run.with_email = dedupeMarketingJobs([...run.with_email, ...socialRun.jobs]).sort((a, b) => b.posted_at.localeCompare(a.posted_at));
    stats.with_email = run.with_email.length;
  }
  for (const job of run.with_email.slice(0, 20))
    console.log(
      `  ${job.title} — ${job.company}${job.location ? ` · ${job.location}` : ""} (${job.posted_at.slice(0, 10)}) ${job.emails.join(", ")}`,
    );
  const rank = process.argv.includes("--rank");
  const ranked = rank
    ? rankJobs(
        [...run.with_email, ...run.apply_link],
        {
          seniority: value("--seniority") ? listArg(value("--seniority")) : DEFAULT_FIT.seniority,
          locations: listArg(value("--locations")),
        },
        new Date(run.generated_at),
      ).slice(0, numberArg("--top", 30))
    : [];
  if (rank)
    console.log(
      `  ranked ${ranked.length} of ${run.with_email.length + run.apply_link.length} role(s) in ${listArg(value("--locations")).join(", ") || "any location"} (others dropped by location or a repeated apply link)`,
    );
  for (const job of ranked.slice(0, 10)) console.log(`  [${job.fit.score}] ${job.title} — ${job.company} · ${job.fit.reasons.join("; ")}`);
  if (out) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(rank ? { generated_at: run.generated_at, ranked } : run, null, 2)}\n`);
  }
  console.log(`\n${JSON.stringify(stats)}`);
  console.log(`${run.with_email.length} role(s) with an email, ${run.apply_link.length} with an apply link${out ? `; wrote ${out}` : ""}.`);
} else if (process.argv.includes("--linkedin-posts")) {
  const days = numberArg("--days", 7)!;
  console.log(`Searching LinkedIn posts from the last ${days} day(s) for marketing openings with an email (no login)`);
  // --recheck <file>: re-verify the post URLs of an earlier output (or a plain list of URLs) without searching.
  const recheck = value("--recheck");
  const urls = recheck ? ((await readFile(recheck, "utf8")).match(/https:\/\/[^\s"]*linkedin\.com\/posts\/[^\s"]+/g) ?? []) : undefined;
  const { posts, stats } = await collectLinkedInPosts({ days, urls, limit: numberArg("--results", 50), log: (m) => console.log(`  ${m}`) });
  for (const post of posts) {
    console.log(
      `\n${post.role} — ${post.company ?? post.author}${post.location ? ` · ${post.location}` : ""} (${post.posted_at.slice(0, 10)})`,
    );
    console.log(`  ${post.emails.join(", ")}  ${post.post_url}`);
  }
  const jobs = posts.map((post) => parseJobInput(toJobInput(post)));
  const out = value("--out");
  // A rate-limited search returns a partial picture; keep the last complete file rather than overwrite it.
  const partial = (stats.search_failed ?? 0) > (stats.queries ?? 0) / 4;
  if (partial) process.exitCode = 1;
  if (partial) console.log(`\n${stats.search_failed}/${stats.queries} searches failed (rate limit?); not writing ${out ?? "the store"}.`);
  if (out && !partial) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(
      out,
      `${JSON.stringify(
        posts.map(({ post_text: _text, ...post }) => post),
        null,
        2,
      )}\n`,
    );
  }
  if (apply && !partial) {
    const handle = await openStore();
    for (const job of jobs) await upsertJob(handle, job);
    const closed = await closeStaleJobs(handle, { sourcePrefixes: ["linkedin-post"] });
    if (closed) console.log(`Closed ${closed} LinkedIn post role(s) not seen in 30 days.`);
    await closeDb();
  }
  console.log(`\n${JSON.stringify(stats)}`);
  console.log(
    `Kept ${posts.length} post(s)${out && !partial ? `, wrote ${out}` : ""}${apply && !partial ? "; stored" : "; nothing written to the store (pass --apply)"}.`,
  );
} else if (search) {
  const sites = (value("--sites") ?? "linkedin,indeed")
    .split(",")
    .map((site) => site.trim())
    .filter(Boolean) as JobSpySite[];
  const unknown = sites.filter((site) => !JOBSPY_SITES.includes(site));
  if (unknown.length) throw new Error(`Unknown site(s): ${unknown.join(", ")}. Choose from ${JOBSPY_SITES.join(", ")}`);
  console.log(`Searching ${sites.join(", ")} for "${search}"${value("--location") ? ` in ${value("--location")}` : ""} (no login)`);
  const { jobs, log } = await searchJobSpy({
    search,
    location: value("--location"),
    sites,
    hoursOld: numberArg("--hours"),
    results: numberArg("--results", 20),
    country: value("--country"),
    remote: process.argv.includes("--remote"),
  });
  if (log) console.log(`  ${log.split("\n").at(-1)}`);
  const byCompany = new Map<string, ParsedJob[]>();
  for (const job of jobs) byCompany.set(job.company, [...(byCompany.get(job.company) ?? []), job]);
  for (const [company, list] of byCompany) {
    console.log(`\n${company} (${list[0]?.source})`);
    list.forEach(print);
  }
  if (apply) {
    const handle = await openStore();
    for (const job of jobs) await upsertJob(handle, job);
    const closed = await closeStaleJobs(handle, { sourcePrefixes: ["jobspy-"] });
    if (closed) console.log(`Closed ${closed} JobSpy role(s) not seen in 30 days.`);
    await closeDb();
  }
  console.log(`\nFound ${jobs.length} posting(s)${apply ? "; stored" : "; nothing written (pass --apply to store)"}.`);
} else {
  const handle = await openStore();
  const targets = website
    ? [{ company: value("--company") ?? new URL(website).hostname.replace(/^www\./, "").split(".")[0]!, website }]
    : await fundedCompanies(handle, { limit: numberArg("--limit", 25) });
  if (!targets.length) console.log("No funded companies with a known website yet. Run `pnpm collect:native -- --apply` first.");
  const scans = await scanCompanies(targets, (message) => console.log(`  ${message}`));
  for (const scan of scans) {
    console.log(`\n${scan.company} — ${scan.website}`);
    if (!scan.boards.length) console.log("  no public job board found");
    for (const board of scan.boards)
      console.log(`  ${board.ats} board ${board.boardUrl} (found via ${board.foundOn}): ${board.jobs} open role(s)`);
    scan.jobs.slice(0, 5).forEach(print);
    if (scan.jobs.length > 5) console.log(`  … and ${scan.jobs.length - 5} more`);
  }
  const total = scans.reduce((sum, scan) => sum + scan.jobs.length, 0);
  const withBoards = scans.filter((scan) => scan.boards.length).length;
  if (apply) {
    const { stored, closed } = await storeScans(handle, scans);
    console.log(
      `\n${withBoards}/${scans.length} companies have a public job board; stored ${stored} role(s), closed ${closed} no longer listed.`,
    );
  } else {
    console.log(
      `\n${withBoards}/${scans.length} companies have a public job board; ${total} open role(s); nothing written (pass --apply to store).`,
    );
  }
  await closeDb();
}
