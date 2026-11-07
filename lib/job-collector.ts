import type { Db } from "@fireround/core/db";
import { collectCompanyJobs, type ReadText } from "./job-boards.ts";
import { closeMissingJobs, fundedCompanies, type ParsedJob, parseJobInput, upsertJob } from "./jobs.ts";

export interface CompanyScan {
  company: string;
  website: string;
  /** `listed`: every external id the board returned, including postings that failed validation (still listed, so not closed). */
  boards: Array<{ ats: string; token: string; boardUrl: string; foundOn: string; jobs: number; listed?: string[] }>;
  jobs: ParsedJob[];
  warnings: string[];
}

/** Reads the job boards of the given companies. Pure collection: nothing is written. */
export async function scanCompanies(
  companies: Array<{ company: string; website: string; signalId?: string | null }>,
  onProgress?: (message: string) => void,
  concurrency = 4,
  read?: ReadText,
): Promise<CompanyScan[]> {
  const results: CompanyScan[] = new Array(companies.length);
  let next = 0;
  const worker = async () => {
    while (next < companies.length) {
      const index = next++;
      const target = companies[index];
      if (!target) break;
      onProgress?.(`Looking for ${target.company}'s job board (${target.website})`);
      const found = await collectCompanyJobs(target, read);
      const jobs: ParsedJob[] = [];
      const warnings = [...found.warnings];
      for (const board of found.boards) {
        for (const job of board.jobs) {
          try {
            jobs.push(parseJobInput(job));
          } catch (error) {
            const why = error instanceof Error ? error.message.split("\n")[0] : String(error);
            warnings.push(`${board.boardUrl}: posting ${String(job.external_id)} skipped (invalid: ${why})`);
          }
        }
      }
      results[index] = {
        company: target.company,
        website: target.website,
        boards: found.boards.map((board) => ({
          ats: board.board.ats,
          token: board.board.token,
          boardUrl: board.boardUrl,
          foundOn: board.board.foundOn,
          jobs: board.jobs.length,
          listed: board.jobs.map((job) => String(job.external_id ?? "").trim()).filter(Boolean),
        })),
        jobs,
        warnings,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, companies.length) }, worker));
  return results;
}

/** Stores a scan and closes postings each fully-read board stopped listing. */
export async function storeScans(handle: Db, scans: CompanyScan[]): Promise<{ stored: number; closed: number }> {
  let stored = 0;
  let closed = 0;
  for (const scan of scans) {
    for (const job of scan.jobs) {
      await upsertJob(handle, job);
      stored++;
    }
    for (const board of scan.boards) {
      // Kept = what the board lists, not what parsed: an invalid posting the board still shows is not "removed".
      const parsed = scan.jobs.filter((job) => job.board_url === board.boardUrl).map((job) => job.external_id);
      const kept = [...new Set([...parsed, ...(board.listed ?? [])])];
      closed += await closeMissingJobs(handle, board.boardUrl, board.ats, kept);
    }
  }
  return { stored, closed };
}

/** The recently funded companies in the Signal Inbox, read and stored. */
export async function collectFundedJobs(
  handle: Db,
  options: { limit?: number; onProgress?: (message: string) => void } = {},
): Promise<{ scans: CompanyScan[]; stored: number; closed: number }> {
  const companies = await fundedCompanies(handle, { limit: options.limit });
  const scans = await scanCompanies(companies, options.onProgress);
  return { scans, ...(await storeScans(handle, scans)) };
}
