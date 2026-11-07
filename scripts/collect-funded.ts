import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { closeDb } from "@fireround/core/db";
import { openStore } from "../lib/db.ts";
import { collectFunded, type FundedRun, storeFunded } from "../lib/funded-founders.ts";
import { collectFundedHiring, emptyWatch, jobSpyCompanySearch, mergeRuns, type WatchState, withWatched } from "../lib/funded-hiring.ts";
import { jobspyPython } from "../lib/jobspy.ts";

const HELP = `SignalRound funded-founders collector (dry run unless --apply)

Companies that announced a pre-seed, seed, Series A, B or C round in the last --days days, from Entrackr, Inc42,
YourStory, TechCrunch, EU-Startups, Tech.eu, TechCabal, Startup Daily, Crunchbase News, PR Newswire and Bing News,
with each company's own website, founders, and the public emails its pages print. Logged out; no email is guessed.

  pnpm collect:funded -- --days 7 --out evals/runs/funded-founders.json
  Options: --limit <n> (companies to research), --no-bing, --apply (store signals, people, emails in Postgres)

Funded and hiring: every company in a funded-founders run, its open roles from its ATS board (linked from the site or
found by name on Greenhouse, Lever, Ashby, Workable, Recruitee, Teamtailor, Personio, Gem), its careers page, or else
its Indeed/LinkedIn listings by exact company name (--no-job-sites skips those). The headline is
marketing_roles_after_funding (roles posted on or after the day the round was announced) and
with_marketing_role_after_funding_and_contact (companies with such a role plus a posted founder or hiring email).
A post-funding listing whose description matches one posted before the round is a repost and keeps the older date.
Only those are leads (companies); companies whose marketing roles all predate the round, or that only print a founder
or hiring email, are demoted (demoted_companies); the rest are listed apart (other_companies). Marketing roles need a
posting date. Output keeps pay, employment type and level, the founders, CEOs and managing directors whose emails the
article, the site or the job pages print, the application emails job pages print (none where a page says emailed
applications are deleted), and best_contact (CEO/founder, then hiring; never sales, press or privacy inboxes).
Read only; nothing is stored. --in takes several runs separated by commas (a 7-day and a 14-day run merge).

--watch <file> re-checks companies daily for 30 days after their announcement: the file keeps each company's polls and
every role URL with the day it was first seen; watched companies are polled again even when --in no longer lists them,
and a role that appears between two post-announcement polls is dated by the poll that found it (first-seen). Run once
a day:

  pnpm collect:funded -- --hiring --in evals/runs/funded-founders.json --out evals/runs/funded-hiring.json \\
    --watch evals/runs/funded-hiring-watch.json
`;

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

if (process.argv.includes("--hiring")) {
  const input = value("--in") ?? "evals/runs/funded-founders.json";
  const out = value("--out") ?? "evals/runs/funded-hiring.json";
  const inputs = input.split(",").filter(Boolean);
  const watchPath = value("--watch");
  const watch: WatchState | undefined = watchPath
    ? existsSync(watchPath)
      ? (JSON.parse(await readFile(watchPath, "utf8")) as WatchState)
      : emptyWatch()
    : undefined;
  const now = new Date();
  const merged = mergeRuns(await Promise.all(inputs.map(async (path) => JSON.parse(await readFile(path, "utf8")) as FundedRun)));
  const run = watch ? withWatched(merged, watch, now) : merged;
  console.log(
    `SignalRound funded-and-hiring: ${run.companies.length} funded companies from ${input}${watch ? ` (${run.companies.length - merged.companies.length} more from the watch)` : ""}`,
  );
  // Companies whose site and ATS boards show no roles are looked up on Indeed and LinkedIn by name (JobSpy, logged out).
  const jobSites = !process.argv.includes("--no-job-sites") && existsSync(jobspyPython());
  if (!jobSites) console.log("Job-site lookup (Indeed, LinkedIn) is off: --no-job-sites, or JobSpy is not installed");
  const hiring = await collectFundedHiring(run, {
    log: (message) => console.log(message),
    searchJobSites: jobSites ? jobSpyCompanySearch : false,
    now,
    watch,
  });
  console.log(JSON.stringify(hiring.stats, null, 2));
  console.log(
    `Headline: ${hiring.stats.marketing_roles_after_funding} marketing role(s) posted after the round; ${hiring.stats.with_marketing_role_after_funding_and_contact} of ${hiring.stats.scanned} funded companies have one plus a posted founder or hiring email (${hiring.stats.with_marketing_role_and_contact} counting older marketing roles; ${hiring.stats.marketing_roles_pre_funding} older roles demoted, ${hiring.stats.marketing_roles_reposted} reposts)`,
  );
  if (watch && watchPath) {
    await mkdir(dirname(watchPath), { recursive: true });
    await writeFile(watchPath, `${JSON.stringify(watch, null, 2)}\n`);
    console.log(`Watch: ${Object.keys(watch.companies).length} companies polled until 30 days after their round (${watchPath})`);
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(hiring, null, 2)}\n`);
  console.log(`Wrote ${hiring.companies.length} hiring companies to ${out}`);
  process.exit(0);
}

const days = Number(value("--days") ?? 7);
const limit = value("--limit") ? Number(value("--limit")) : undefined;
if (!Number.isFinite(days) || days < 1 || (limit !== undefined && !(limit >= 1)))
  throw new Error("--days and --limit must be positive numbers");
const apply = process.argv.includes("--apply");
const out = value("--out");
console.log(`SignalRound funded-founders collector (${apply ? "apply" : "dry run"}), last ${days} day(s)`);

const run = await collectFunded({ days, limit, bing: !process.argv.includes("--no-bing"), log: (message) => console.log(message) });
console.log(JSON.stringify(run.stats, null, 2));
if (out) {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(run, null, 2)}\n`);
  console.log(`Wrote ${run.companies.length} companies to ${out}`);
}
if (apply) {
  const handle = await openStore();
  console.log(JSON.stringify(await storeFunded(handle, run)));
  await closeDb();
}
