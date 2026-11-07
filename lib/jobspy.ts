import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { type ParsedJob, parseJobInput } from "./jobs.ts";
import { emailQuote, extractEmails, postedVerbatim } from "./linkedin-posts.ts";

export const JOBSPY_SITES = [
  "linkedin",
  "indeed",
  "naukri",
  "glassdoor",
  "google",
  "zip_recruiter",
  "bayt",
  "bdjobs",
  "hellowork",
] as const;
export type JobSpySite = (typeof JOBSPY_SITES)[number];

export interface JobSpyRequest {
  search: string;
  location?: string;
  sites?: JobSpySite[];
  hoursOld?: number;
  results?: number;
  /** Indeed/Glassdoor country, e.g. "india", "usa", "uk". */
  country?: string;
  remote?: boolean;
  /** Read each posting's page for its description (Indeed returns one with the search; others need this). */
  fullDescriptions?: boolean;
}

export function jobspyPython(): string {
  return process.env.JOBSPY_PYTHON || path.join(process.cwd(), "workers/.venv/bin/python");
}

/**
 * Runs the logged-out JobSpy worker (workers/jobs/jobspy_worker.py) and returns validated postings.
 * Install once: `uv venv --python 3.12 workers/.venv && uv pip install --python workers/.venv/bin/python -r workers/jobs/requirements.txt`.
 */
export async function searchJobSpy(request: JobSpyRequest, timeoutMs = 180_000): Promise<{ jobs: ParsedJob[]; log: string }> {
  const python = jobspyPython();
  if (!existsSync(python)) throw new Error(`JobSpy is not installed: ${python} is missing. See workers/jobs/README.md.`);
  const script = path.join(process.cwd(), "workers/jobs/jobspy_worker.py");
  const payload = JSON.stringify({
    search: request.search,
    location: request.location,
    sites: request.sites ?? ["linkedin", "indeed"],
    hours_old: request.hoursOld,
    results: request.results ?? 20,
    country: request.country,
    remote: request.remote,
    full_descriptions: request.fullDescriptions,
  });
  const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(python, ["-I", script], { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
    let out = "";
    let err = "";
    // Decode as one UTF-8 stream: a multibyte character split across pipe chunks must not become U+FFFD.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (exit) => resolve({ stdout: out, stderr: err, code: exit }));
    child.stdin.end(payload);
  });
  if (code !== 0) throw new Error(`JobSpy failed (exit ${code}): ${stderr.trim().split("\n").slice(-3).join(" ")}`);
  const jobs: ParsedJob[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      jobs.push(withPostedEmails(parseJobInput(JSON.parse(line))));
    } catch {
      // A posting with a malformed field is skipped, not guessed at.
    }
  }
  return { jobs, log: stderr.trim() };
}

/**
 * Emails come only from the stored description text, each with the line it is written on. JobSpy's own
 * `emails` column is a regex over raw HTML (image names, attribute junk, text past the stored cut) and is ignored.
 */
export function withPostedEmails(job: ParsedJob): ParsedJob {
  const { public_emails: _ignored, email_source_quote: _quote, ...metadata } = job.metadata;
  const text = job.description ?? "";
  const quoted = extractEmails(text)
    .filter((email) => postedVerbatim(text, email))
    .map((email) => ({ email, quote: emailQuote(text, email) }))
    .filter((found): found is { email: string; quote: string } => Boolean(found.quote));
  if (!quoted.length) return { ...job, metadata };
  return {
    ...job,
    metadata: {
      ...metadata,
      public_emails: quoted.map((found) => found.email),
      email_source_quote: [...new Set(quoted.map((found) => found.quote))].join(" … "),
    },
  };
}
