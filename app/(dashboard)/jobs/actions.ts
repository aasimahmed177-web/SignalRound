"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, attempt } from "@/lib/action-result";
import { requireDashboard } from "@/lib/dashboard-auth.server";
import { db } from "@/lib/db";
import { scanCompanies, storeScans } from "@/lib/job-collector";
import { fundedCompanies, upsertJob } from "@/lib/jobs";
import { JOBSPY_SITES, type JobSpySite, searchJobSpy } from "@/lib/jobspy";

export interface JobRunSummary {
  companies: number;
  withBoards: number;
  stored: number;
  closed: number;
  notes: string[];
}

/** Funded startups in the Signal Inbox, or one website when given. */
export async function scanJobBoards(website: string, company: string): Promise<ActionResult<{ value: JobRunSummary }>> {
  return attempt(async () => {
    await requireDashboard();
    if (typeof website !== "string" || website.length > 500 || typeof company !== "string" || company.length > 200)
      throw new Error("Use a website URL under 500 characters.");
    const handle = await db();
    let targets: Array<{ company: string; website: string; signalId?: string | null }>;
    if (website.trim()) {
      let url: URL;
      try {
        url = new URL(/^https?:\/\//i.test(website.trim()) ? website.trim() : `https://${website.trim()}`);
      } catch {
        throw new Error("That website is not a valid URL.");
      }
      targets = [{ company: company.trim() || (url.hostname.replace(/^www\./, "").split(".")[0] ?? url.hostname), website: url.href }];
    } else {
      targets = await fundedCompanies(handle, { limit: 25 });
      if (!targets.length) throw new Error("No funded startups with a website yet. Use Signals → Find startups first.");
    }
    const scans = await scanCompanies(targets);
    const { stored, closed } = await storeScans(handle, scans);
    revalidatePath("/jobs");
    return {
      companies: scans.length,
      withBoards: scans.filter((scan) => scan.boards.length).length,
      stored,
      closed,
      notes: scans.filter((scan) => !scan.boards.length).map((scan) => `${scan.company}: no public job board found on ${scan.website}`),
    };
  });
}

export async function searchJobSites(input: {
  search: string;
  location: string;
  sites: string[];
  country: string;
  hours: number;
}): Promise<ActionResult<{ value: JobRunSummary }>> {
  return attempt(async () => {
    await requireDashboard();
    const search = String(input.search ?? "").trim();
    if (!search || search.length > 120) throw new Error("Enter a role or keyword under 120 characters.");
    const sites = (input.sites ?? []).filter((site): site is JobSpySite => JOBSPY_SITES.includes(site as JobSpySite));
    if (!sites.length) throw new Error("Choose at least one job site.");
    const { jobs } = await searchJobSpy({
      search,
      location: String(input.location ?? "").slice(0, 120) || undefined,
      sites,
      country: String(input.country ?? "").slice(0, 40) || undefined,
      hoursOld: Number.isFinite(input.hours) && input.hours > 0 ? Math.min(input.hours, 24 * 60) : undefined,
      results: 30,
    });
    const handle = await db();
    for (const job of jobs) await upsertJob(handle, job);
    revalidatePath("/jobs");
    return { companies: new Set(jobs.map((job) => job.company)).size, withBoards: 0, stored: jobs.length, closed: 0, notes: [] };
  });
}
