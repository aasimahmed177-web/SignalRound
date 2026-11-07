// Mirrors Postgres job_postings into the Convex `jobs` table: every posting, open and closed, in batches
// through `convex run jobs:upsert`. Emails ride along only when the posting prints them and the stored quote
// shows the address; nothing is guessed.
//
//   CONVEX_DEPLOY_KEY=... node --env-file-if-exists=.env scripts/import-convex-jobs.ts [--batch 100]

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { closeDb, schema } from "@fireround/core/db";
import { asc } from "drizzle-orm";
import { postedEmail } from "../convex/rules.ts";
import { openStore } from "../lib/db.ts";

type JobRow = typeof schema.jobPostings.$inferSelect;

export interface ConvexJob {
  source: string;
  externalId: string;
  url: string;
  title: string;
  company: string;
  companyWebsite?: string;
  boardUrl?: string;
  signalId?: string;
  publicEmails?: Array<{ email: string; sourceUrl: string; quote: string }>;
  location?: string;
  remote?: boolean;
  department?: string;
  employmentType?: string;
  salary?: string;
  postedAt?: string;
  status: "open" | "closed";
}

const http = (value: unknown): value is string => typeof value === "string" && /^https?:\/\//i.test(value);

/**
 * The posting's printed emails: metadata.public_emails holds addresses or `{ email, source_url, quote }`, and
 * metadata.email_source_quote the line they were printed in. An address no quote shows is left out.
 */
export function postedJobEmails(row: Pick<JobRow, "url" | "metadata">): Array<{ email: string; sourceUrl: string; quote: string }> {
  const metadata = row.metadata ?? {};
  const shared = typeof metadata.email_source_quote === "string" ? metadata.email_source_quote : undefined;
  const list = Array.isArray(metadata.public_emails) ? metadata.public_emails : [];
  const out: Array<{ email: string; sourceUrl: string; quote: string }> = [];
  for (const item of list) {
    const raw = (typeof item === "string" ? { email: item } : item && typeof item === "object" ? item : {}) as {
      email?: unknown;
      source_url?: unknown;
      quote?: unknown;
    };
    const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
    if (!email || out.some((e) => e.email === email)) continue;
    const sourceUrl = http(raw.source_url) ? raw.source_url : row.url;
    const quote = [raw.quote, shared].find((q): q is string => typeof q === "string" && postedEmail({ email, sourceUrl, quote: q }));
    if (quote) out.push({ email, sourceUrl, quote });
  }
  return out;
}

/** One Postgres row as jobs:upsert takes it: nulls left out (Convex optional), timestamps as ISO strings. */
export function toConvexJob(row: JobRow): ConvexJob {
  const emails = postedJobEmails(row);
  const job: ConvexJob = {
    source: row.source,
    externalId: row.externalId,
    url: row.url,
    title: row.title,
    company: row.company,
    companyWebsite: row.companyWebsite ?? undefined,
    boardUrl: row.boardUrl ?? undefined,
    signalId: row.signalId ?? undefined,
    publicEmails: emails.length ? emails : undefined,
    location: row.location ?? undefined,
    remote: row.remote ?? undefined,
    department: row.department ?? undefined,
    employmentType: row.employmentType ?? undefined,
    salary: row.salary ?? undefined,
    postedAt: row.postedAt?.toISOString(),
    status: row.status === "closed" ? "closed" : "open",
  };
  // JSON.stringify drops undefined; strip them anyway so the payload reads the same everywhere.
  return Object.fromEntries(Object.entries(job).filter(([, value]) => value !== undefined)) as unknown as ConvexJob;
}

export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main() {
  if (!process.env.CONVEX_DEPLOY_KEY) throw new Error("CONVEX_DEPLOY_KEY is required");
  const index = process.argv.indexOf("--batch");
  const size = Math.max(1, Math.min(Number(index >= 0 ? process.argv[index + 1] : 100) || 100, 500));
  const handle = await openStore();
  const rows = await handle.select().from(schema.jobPostings).orderBy(asc(schema.jobPostings.id));
  await closeDb();
  const failures: string[] = [];
  for (const [n, batch] of batches(rows.map(toConvexJob), size).entries()) {
    try {
      execFileSync("pnpm", ["exec", "convex", "run", "jobs:upsert", JSON.stringify({ jobs: batch }), "--prod"], {
        env: process.env,
        stdio: "inherit",
      });
    } catch (error) {
      failures.push(
        `batch ${n + 1} (${batch[0]?.source}:${batch[0]?.externalId}…): ${error instanceof Error ? error.message.split("\n")[0] : error}`,
      );
    }
  }
  console.log(`${rows.length} postings in ${Math.ceil(rows.length / size)} batches; ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
