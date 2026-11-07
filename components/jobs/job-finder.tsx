"use client";

import { Briefcase, LoaderCircle, Search } from "lucide-react";
import { useState, useTransition } from "react";
import { type JobRunSummary, scanJobBoards, searchJobSites } from "@/app/(dashboard)/jobs/actions";
import { cn } from "@/lib/utils";

const SITES = [
  { id: "linkedin", label: "LinkedIn" },
  { id: "indeed", label: "Indeed" },
  { id: "naukri", label: "Naukri" },
  { id: "glassdoor", label: "Glassdoor" },
  { id: "google", label: "Google Jobs" },
];

const input =
  "min-w-0 rounded-8 border border-border-faint bg-background px-3 py-3 text-body-medium outline-none focus-visible:ring-2 focus-visible:ring-signal-blue disabled:opacity-60";
const button =
  "inline-flex items-center justify-center gap-2 rounded-8 bg-signal-blue px-5 py-3 text-label-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60";

type Result = { message: string; notes: string[]; error?: boolean };

function summary(value: JobRunSummary, mode: "boards" | "sites"): string {
  if (mode === "sites")
    return `${value.stored} role${value.stored === 1 ? "" : "s"} saved from ${value.companies} compan${value.companies === 1 ? "y" : "ies"}`;
  const closed = value.closed ? ` · ${value.closed} closed` : "";
  return `${value.withBoards}/${value.companies} companies have a public job board · ${value.stored} open role${value.stored === 1 ? "" : "s"} saved${closed}`;
}

export function JobFinder() {
  const [mode, setMode] = useState<"boards" | "sites">("boards");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);

  const run = (task: () => Promise<{ ok: true; value: JobRunSummary } | { ok: false; error: string }>) => {
    setResult(null);
    start(async () => {
      const response = await task();
      setResult(
        response.ok
          ? { message: summary(response.value, mode), notes: response.value.notes }
          : { message: response.error, notes: [], error: true },
      );
    });
  };

  return (
    <section className="rounded-16 border border-signal-blue/20 bg-card p-5 sm:p-6" aria-labelledby="job-finder-heading">
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <Briefcase className="mt-1 size-5 text-signal-blue" />
          <div>
            <h2 id="job-finder-heading" className="text-title-h5">
              Find jobs
            </h2>
            <p className="mt-1 text-body-small text-muted-foreground">
              {mode === "boards"
                ? "Reads the job boards on funded startups' own websites: Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, BambooHR."
                : "Searches job sites without logging in, through JobSpy. Sites can rate-limit; results vary."}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 gap-1 rounded-full bg-black-alpha-4 p-1 dark:bg-white/6" role="tablist" aria-label="Job source">
          {(
            [
              ["boards", "Startup job boards"],
              ["sites", "Job sites"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              disabled={pending}
              onClick={() => {
                setMode(id);
                setResult(null);
              }}
              className={cn(
                "h-8 rounded-full px-3 text-label-small transition-colors",
                mode === id ? "bg-signal-ink text-white dark:bg-white dark:text-signal-ink" : "text-black-alpha-56 hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {mode === "boards" ? (
        <form
          action={(data) => run(() => scanJobBoards(String(data.get("website") ?? ""), String(data.get("company") ?? "")))}
          className="flex flex-col gap-3 sm:flex-row"
        >
          <label className="sr-only" htmlFor="job-website">
            Company website
          </label>
          <input
            id="job-website"
            name="website"
            maxLength={500}
            disabled={pending}
            placeholder="https://company.com (blank = all funded startups)"
            className={cn(input, "flex-1")}
          />
          <label className="sr-only" htmlFor="job-company">
            Company name
          </label>
          <input
            id="job-company"
            name="company"
            maxLength={200}
            disabled={pending}
            placeholder="Company name (optional)"
            className={cn(input, "sm:w-52")}
          />
          <button type="submit" disabled={pending} className={button}>
            {pending ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : <Search className="size-4" />}
            {pending ? "Reading boards…" : "Scan boards"}
          </button>
        </form>
      ) : (
        <form
          action={(data) =>
            run(() =>
              searchJobSites({
                search: String(data.get("search") ?? ""),
                location: String(data.get("location") ?? ""),
                country: String(data.get("country") ?? ""),
                hours: Number(data.get("hours") ?? 0),
                sites: data.getAll("sites").map(String),
              }),
            )
          }
          className="space-y-3"
        >
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_9rem_8rem]">
            <input
              name="search"
              required
              maxLength={120}
              disabled={pending}
              placeholder="Role or keyword, e.g. backend engineer"
              aria-label="Role or keyword"
              className={input}
            />
            <input name="location" maxLength={120} disabled={pending} placeholder="Location" aria-label="Location" className={input} />
            <input
              name="country"
              maxLength={40}
              disabled={pending}
              placeholder="Country (india)"
              aria-label="Indeed country"
              className={input}
            />
            <select name="hours" disabled={pending} aria-label="Posted within" defaultValue="72" className={input}>
              <option value="24">24 hours</option>
              <option value="72">3 days</option>
              <option value="168">7 days</option>
              <option value="720">30 days</option>
              <option value="0">Any time</option>
            </select>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <fieldset className="flex flex-wrap gap-2" disabled={pending}>
              <legend className="sr-only">Job sites</legend>
              {SITES.map((site) => (
                <label
                  key={site.id}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-black-alpha-4 px-3 py-1.5 text-label-small has-[:checked]:bg-signal-blue/10 has-[:checked]:text-signal-blue dark:bg-white/6"
                >
                  <input
                    type="checkbox"
                    name="sites"
                    value={site.id}
                    defaultChecked={["linkedin", "indeed", "naukri"].includes(site.id)}
                    className="accent-signal-blue"
                  />
                  {site.label}
                </label>
              ))}
            </fieldset>
            <button type="submit" disabled={pending} className={button}>
              {pending ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : <Search className="size-4" />}
              {pending ? "Searching sites…" : "Search jobs"}
            </button>
          </div>
        </form>
      )}

      <p className="mt-3 text-body-small text-muted-foreground">
        No logins, no scraping credits. Every role links to the posting it was read from.
      </p>
      {result && (
        <div role={result.error ? "alert" : "status"} className="mt-4 border-t border-border-faint pt-4 text-body-small">
          <p className={result.error ? "text-crimson-ink" : "text-foreground"}>{result.message}</p>
          {!!result.notes.length && (
            <details className="mt-2 text-muted-foreground">
              <summary>Companies without a public board ({result.notes.length})</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {result.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
