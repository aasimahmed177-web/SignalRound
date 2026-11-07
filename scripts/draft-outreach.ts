// Writes outreach email drafts to evals/runs/ for review. Drafts only: no email is sent, nothing goes to Gmail,
// no network call is made and no LLM is used. Inputs are the gitignored run files from collect:funded and collect:jobs.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildDrafts, draftsMarkdown, type FundedLead, type JobLead } from "../lib/outreach.ts";

const HELP = `SignalRound outreach drafts (writes files only; never sends or drafts in Gmail)

  pnpm draft:outreach
  pnpm draft:outreach -- --funded evals/runs/funded-founders.json --jobs evals/runs/marketing-jobs.json \\
    --ranked evals/runs/marketing-ranked.json --out evals/runs/outreach-drafts.json --max-jobs 100

Writes --out (JSON) and the same path with .md (readable). Output must stay under evals/runs/.
`;

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  const fundedPath = value("--funded") ?? "evals/runs/funded-founders.json";
  const jobsPath = value("--jobs") ?? "evals/runs/marketing-jobs.json";
  const rankedPath = value("--ranked") ?? "evals/runs/marketing-ranked.json";
  const out = value("--out") ?? "evals/runs/outreach-drafts.json";
  const maxJobsArg = value("--max-jobs");
  const maxJobs = maxJobsArg ? Number(maxJobsArg) : undefined;

  // Drafts hold scraped contact data: keep them in the gitignored run folder, never anywhere that could be committed.
  const runs = resolve("evals/runs");
  if (!resolve(out).startsWith(`${runs}/`)) throw new Error(`--out must be inside evals/runs/ (got ${out})`);

  const funded = existsSync(fundedPath) ? (((await readJson(fundedPath)) as { companies?: FundedLead[] }).companies ?? []) : [];
  const jobs = existsSync(jobsPath) ? (((await readJson(jobsPath)) as { with_email?: JobLead[] }).with_email ?? []) : [];
  const ranked = existsSync(rankedPath)
    ? (((await readJson(rankedPath)) as { ranked?: JobLead[] }).ranked ?? []).filter((job) => job.emails?.length)
    : [];
  console.log(`read ${funded.length} funded companies, ${ranked.length} ranked jobs with email, ${jobs.length} jobs with email`);

  const run = buildDrafts({ funded, ranked, jobs, maxJobs });
  const md = `${out.replace(/\.json$/, "")}.md`;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(run, null, 2)}\n`);
  await writeFile(md, draftsMarkdown(run));
  console.log(JSON.stringify(run.stats));
  console.log(`wrote ${out} and ${md} (${run.drafts.length} drafts, nothing sent)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
