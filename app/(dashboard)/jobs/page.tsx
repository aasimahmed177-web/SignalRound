import { ArrowUpRight, AtSign, Link2 } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { JobFinder } from "@/components/jobs/job-finder";
import { ageLabel, applyLink, type Fit, jobEmails, jobFit, splitJobs } from "@/components/jobs/job-view";
import { EmailChip } from "@/components/leads/email-chip";
import { PageBody } from "@/components/shell/page-body";
import { PageHeader } from "@/components/shell/page-header";
import { CardListSkeleton } from "@/components/ui/skeletons";
import { db } from "@/lib/db";
import { JOB_STATUSES, type JobListing, type JobStatus, listJobs } from "@/lib/jobs";
import { cn } from "@/lib/utils";

type Params = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const SOURCE_LABELS: Record<string, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workable: "Workable",
  smartrecruiters: "SmartRecruiters",
  recruitee: "Recruitee",
  bamboohr: "BambooHR",
  "jobspy-linkedin": "LinkedIn",
  "jobspy-indeed": "Indeed",
  "jobspy-naukri": "Naukri",
  "jobspy-glassdoor": "Glassdoor",
  "jobspy-google": "Google Jobs",
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.replace(/^jobspy-/, "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

type Job = JobListing["rows"][number];
type View = "email" | "apply";

function FitBadge({ fit }: { fit: Fit }) {
  return (
    <span
      title={fit.reasons.join("\n") || undefined}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px]",
        fit.score >= 60 ? "bg-proof-green/10 text-proof-green" : "bg-black-alpha-4 text-black-alpha-56 dark:bg-white/6",
      )}
    >
      fit {fit.score}
    </span>
  );
}

function JobRow({ job, view }: { job: Job; view: View }) {
  const posted = job.postedAt ? `posted ${ageLabel(job.postedAt)}` : `found ${ageLabel(job.firstSeenAt)}`;
  const meta = [job.location, job.remote ? "Remote" : null, job.department, job.employmentType].filter(Boolean);
  const emails = jobEmails(job);
  const apply = applyLink(job);
  const fit = jobFit(job.metadata);
  return (
    <article className="grid gap-3 border-b border-border-faint py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-mono-x-small">
          <span className="uppercase tracking-[0.12em] text-black-alpha-40">{job.company}</span>
          {job.funding && <span className="rounded-full bg-proof-green/10 px-2 py-0.5 text-proof-green">Raised {job.funding}</span>}
          {fit && <FitBadge fit={fit} />}
        </div>
        <h3 className="text-title-h6 leading-snug [overflow-wrap:anywhere]">
          <a href={job.url} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
            {job.title}
          </a>
        </h3>
        {meta.length > 0 && <p className="text-body-small text-black-alpha-56">{meta.join(" · ")}</p>}
        {(job.salary || emails.length > 0) && (
          <div className="flex flex-wrap items-center gap-2 pt-1 text-label-small">
            {job.salary && <span className="rounded-full bg-black-alpha-4 px-2.5 py-1 dark:bg-white/6">{job.salary}</span>}
            {emails.map((email) => (
              <EmailChip key={email.email} email={email.email} sourceUrl={email.sourceUrl} quote={email.quote} />
            ))}
          </div>
        )}
        {view === "email" && emails[0]?.quote && (
          <p className="max-w-3xl text-body-small leading-relaxed text-black-alpha-56 sm:hidden">“{emails[0].quote}”</p>
        )}
        {fit && fit.reasons.length > 0 && (
          <p className="max-w-3xl text-body-small text-black-alpha-40">{fit.reasons.slice(0, 3).join(" · ")}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-label-small text-black-alpha-56 sm:flex-col sm:items-end sm:gap-1">
        <span className="rounded-full bg-signal-blue/10 px-2 py-0.5 text-mono-x-small uppercase tracking-[0.1em] text-signal-blue">
          {sourceLabel(job.source)}
        </span>
        <span>{posted}</span>
        {view === "apply" ? (
          <a
            href={apply.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full bg-signal-ink px-3 py-1 text-white hover:opacity-90 dark:bg-white dark:text-signal-ink"
            title={apply.url}
          >
            Apply {apply.direct ? `on ${hostOf(apply.url)}` : "via posting"} <ArrowUpRight className="size-3.5" />
          </a>
        ) : (
          <a
            href={emails[0]?.sourceUrl ?? job.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            Posting <ArrowUpRight className="size-3.5" />
          </a>
        )}
      </div>
    </article>
  );
}

function href(params: { q?: string; source?: string; funded?: boolean; status?: string; view?: View }): string {
  const search = new URLSearchParams();
  if (params.view === "apply") search.set("view", "apply");
  if (params.q) search.set("q", params.q);
  if (params.source) search.set("source", params.source);
  if (params.funded) search.set("funded", "1");
  if (params.status && params.status !== "open") search.set("status", params.status);
  const query = search.toString();
  return query ? `/jobs?${query}` : "/jobs";
}

async function JobsBody({ searchParams }: { searchParams: Promise<Params> }) {
  await connection();
  const params = await searchParams;
  const q = first(params.q)?.slice(0, 120);
  const source = first(params.source);
  const funded = first(params.funded) === "1";
  const rawStatus = first(params.status);
  const status: JobStatus = JOB_STATUSES.includes(rawStatus as JobStatus) ? (rawStatus as JobStatus) : "open";
  const listing = await listJobs(await db(), { q, source, funded, status, limit: 500 });
  const groups = splitJobs(listing.rows);
  const view: View = first(params.view) === "apply" ? "apply" : first(params.view) === "email" || groups.email.length ? "email" : "apply";
  const rows = groups[view];
  const chip = (active: boolean) =>
    cn(
      "inline-flex h-8 items-center gap-2 rounded-full px-3 text-label-small transition-colors",
      active
        ? "bg-signal-ink text-white dark:bg-white dark:text-signal-ink"
        : "bg-black-alpha-4 text-black-alpha-56 hover:bg-black-alpha-8 hover:text-foreground dark:bg-white/6",
    );

  return (
    <PageBody>
      <JobFinder />
      <section aria-labelledby="jobs-heading">
        <div className="flex flex-col gap-4 border-b border-border-faint pb-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-mono-x-small uppercase tracking-[0.14em] text-black-alpha-32">
                {listing.counts.open} open · {listing.counts.companies} companies · {listing.counts.funded} at funded startups
              </p>
              <h2 id="jobs-heading" className="mt-1 text-title-h5">
                {listing.rows.length} {status === "closed" ? "closed" : "open"} role{listing.rows.length === 1 ? "" : "s"}
                {q ? ` matching “${q}”` : ""}
              </h2>
            </div>
            <form action="/jobs" className="flex gap-2">
              {view === "apply" && <input type="hidden" name="view" value="apply" />}
              {source && <input type="hidden" name="source" value={source} />}
              {funded && <input type="hidden" name="funded" value="1" />}
              <input
                name="q"
                defaultValue={q}
                maxLength={120}
                placeholder="Filter by title, company, place"
                aria-label="Filter jobs"
                className="h-9 w-full min-w-0 rounded-8 border border-border-faint bg-background px-3 text-body-small outline-none focus-visible:ring-2 focus-visible:ring-signal-blue sm:w-64"
              />
            </form>
          </div>
          <nav
            aria-label="How to reach the employer"
            className="grid grid-cols-2 gap-1 rounded-12 bg-black-alpha-4 p-1 sm:inline-grid sm:w-fit dark:bg-white/6"
          >
            {(
              [
                ["email", "Email them", AtSign, groups.email.length, "The posting prints an email to apply to"],
                ["apply", "Apply via link", Link2, groups.apply.length, "Apply on the employer's page or the posting"],
              ] as const
            ).map(([id, label, Icon, count, hint]) => (
              <Link
                key={id}
                href={href({ q, source, funded, status, view: id })}
                aria-current={view === id ? "page" : undefined}
                title={hint}
                className={cn(
                  "inline-flex h-9 items-center justify-center gap-2 rounded-8 px-4 text-label-small transition-colors",
                  view === id ? "bg-background text-foreground shadow-sm dark:bg-white/12" : "text-black-alpha-56 hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {label}
                <span className="font-mono text-[11px] opacity-65">{count}</span>
              </Link>
            ))}
          </nav>
          <nav aria-label="Job filters" className="flex flex-wrap gap-1.5">
            <Link
              href={href({ q, status, view })}
              className={chip(!funded && !source)}
              aria-current={!funded && !source ? "page" : undefined}
            >
              All
            </Link>
            <Link href={href({ q, funded: true, status, view })} className={chip(funded)} aria-current={funded ? "page" : undefined}>
              Funded startups <span className="font-mono text-[11px] opacity-65">{listing.counts.funded}</span>
            </Link>
            {listing.sources.map((id) => (
              <Link
                key={id}
                href={href({ q, source: id, status, view })}
                className={chip(source === id)}
                aria-current={source === id ? "page" : undefined}
              >
                {sourceLabel(id)}
              </Link>
            ))}
            <Link
              href={href({ q, source, funded, status: status === "closed" ? "open" : "closed", view })}
              className={chip(status === "closed")}
            >
              Closed <span className="font-mono text-[11px] opacity-65">{listing.counts.closed}</span>
            </Link>
          </nav>
        </div>
        {rows.length ? (
          <div>
            <p className="pt-4 text-body-small text-black-alpha-56">
              {view === "email"
                ? "Each email is printed in the posting itself. Hover a chip for the line it appears in and the page."
                : "The employer's own page or ATS when the posting names one; otherwise the posting."}
            </p>
            {rows.map((job) => (
              <JobRow key={job.id} job={job} view={view} />
            ))}
          </div>
        ) : listing.rows.length ? (
          <div className="border-b border-border-faint py-16 text-center">
            <p className="text-title-h6">
              {view === "email" ? "No posting here prints an email." : "Every role here has an email to write to."}
            </p>
            <p className="mx-auto mt-2 max-w-md text-body-medium text-black-alpha-56">
              <Link
                href={href({ q, source, funded, status, view: view === "email" ? "apply" : "email" })}
                className="text-signal-blue underline-offset-4 hover:underline"
              >
                {view === "email" ? `See ${groups.apply.length} to apply via link` : `See ${groups.email.length} to email`}
              </Link>
            </p>
          </div>
        ) : (
          <div className="border-b border-border-faint py-16 text-center">
            <p className="text-title-h6">No roles here yet.</p>
            <p className="mx-auto mt-2 max-w-md text-body-medium text-black-alpha-56">
              Scan the funded startups' job boards above, search job sites, or run{" "}
              <code className="font-mono text-[.9em]">pnpm collect:jobs</code>.
            </p>
          </div>
        )}
      </section>
    </PageBody>
  );
}

export const metadata = { title: "Jobs" };

export default function JobsPage({ searchParams }: PageProps<"/jobs">) {
  return (
    <>
      <PageHeader section={11} description="Open roles from funded startups' own job boards and logged-out job-site searches." />
      <Suspense
        fallback={
          <PageBody>
            <CardListSkeleton rows={5} />
          </PageBody>
        }
      >
        <JobsBody searchParams={searchParams as Promise<Params>} />
      </Suspense>
    </>
  );
}
