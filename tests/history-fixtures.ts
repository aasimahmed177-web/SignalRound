// Shared by the history tests: a company with a feed round and a checked dossier that lists its
// seed, the seed's announcement as the extractor would read it, and a scripted reader (no network).

import type { CompanyDossier, ExtractedItem, ExtractedRound, ExtractTarget, FeedRecord, HistoryCandidate } from "@fireround/core";
import { hostOf } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { saveDossier } from "../lib/deepdive";
import type { HistoryReader } from "../lib/history";
import { persistRecords } from "../lib/persist";
import { record } from "./helpers";

const { fundingRounds } = schema;

export const SEED_URL = "https://techcrunch.com/2022/08/03/footprint-raises-6m-seed-index-ventures";
export const SERIES_B_URL = "https://techcrunch.com/2025/01/10/footprint-series-b";

/** A YYYY-MM-DD `daysAgo` days before now. */
export function isoDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

export function round(p: Partial<ExtractedRound>): ExtractedRound {
  return {
    company_name: "Footprint",
    company_website: null,
    company_description: null,
    round_type_as_written: "Seed",
    amount_as_written: "$6 million",
    amount_kind: "round",
    valuation_as_written: null,
    lead_investors: ["Index Ventures"],
    other_investors: [],
    announced_date: "2022-08-03",
    headquarters: null,
    sector: null,
    evidence_quote: "Footprint raised $6 million in a seed round led by Index Ventures.",
    source_url: null,
    is_background: false,
    is_rumor: false,
    ...p,
  };
}

export function item(url: string, r: ExtractedRound): ExtractedItem {
  return { round: r, source: { url, host: hostOf(url), title: "Footprint raises $6M" }, page_kind: "article", grounded: true };
}

export const verified = (status: string) => (records: FeedRecord[]) =>
  records.map((r) => ({ ...r, verification: { status, notes: [], url: r.sources[0]?.url ?? null } }) as FeedRecord);

/** A reader that serves scripted search results and pages, counting every call. */
export function reader(
  opts: { search?: HistoryCandidate[]; pages?: Record<string, ExtractedItem[]>; verify?: (records: FeedRecord[]) => FeedRecord[] } = {},
) {
  const calls = { search: 0, map: 0, extract: 0, verify: 0, queries: [] as string[] };
  const r: HistoryReader = {
    async search(query) {
      calls.search++;
      calls.queries.push(query);
      return opts.search ?? [];
    },
    async map() {
      calls.map++;
      return [];
    },
    async extract(targets: ExtractTarget[]) {
      calls.extract++;
      const url = targets[0].url;
      const items = opts.pages?.[url];
      return {
        items: items ?? [],
        pages: [{ url, ok: Boolean(items), rounds: items?.length ?? 0, ungrounded: 0, cached: false, error: items ? undefined : "404" }],
        creditsEstimated: 5,
        notArticle: 0,
      };
    },
    async verify(records) {
      calls.verify++;
      return { records: (opts.verify ?? verified("confirmed"))(records), credits: 4 };
    },
    async rates() {
      return null;
    },
  };
  return { reader: r, calls };
}

export const seedSearch: HistoryCandidate[] = [{ url: SEED_URL, title: "Footprint raises $6M seed led by Index Ventures", via: "search" }];

export function dossier(priors: CompanyDossier["prior_rounds"]): CompanyDossier {
  return {
    one_liner: "Footprint verifies identities.",
    founded_year: 2021,
    founders: [],
    headcount_estimate: null,
    total_raised_as_written: null,
    prior_rounds: priors,
    customers: [],
    investors_and_backers: [],
    competitors: [],
    business_model: null,
    why_it_matters: "Identity checks are a wedge.",
    sources: [SEED_URL],
  };
}

export const SEED_PRIOR = {
  stage_as_written: "Seed",
  amount_as_written: "$6 million",
  announced_date: "2022-08-03",
  lead_investors: ["Index Ventures"],
};
export const SEED_KEY = "seed|$6 million|2022-08-03";

/** Footprint with its feed round (the Series B the lanes caught) and a checked dossier listing the seed. */
export async function seed(
  handle: Db,
  priors: CompanyDossier["prior_rounds"] = [SEED_PRIOR],
  checked = true,
  dropped: Array<{ field: string; item: string | null; reason: string; prior?: CompanyDossier["prior_rounds"][number] }> = [],
): Promise<string> {
  const b = record({
    company_name: "Footprint",
    company_key: "footprint",
    company_domain: "onefootprint.com",
    stage: "series_b",
    stage_as_written: "Series B",
    announced_date: isoDaysAgo(2),
    amount: { value: 40, currency: "USD", as_written: "$40M", usd_millions: 40, fx_rate: 1, fx_date: null },
    lead_investors: ["QED Investors"],
    sources: [{ url: SERIES_B_URL, host: "techcrunch.com", title: "Footprint raises $40M Series B" }],
    confidence: 0.9,
  });
  await persistRecords(handle, [b], "series-a-b", "run-1");
  const [{ companyId }] = await handle.select({ companyId: fundingRounds.companyId }).from(fundingRounds).where(eq(fundingRounds.id, b.id));
  const at = new Date("2026-09-20T00:00:00Z");
  await saveDossier(
    handle,
    companyId,
    dossier(priors),
    SEED_URL,
    at,
    checked
      ? {
          version: 1,
          checked_at: at.toISOString(),
          model: "test",
          sources_checked: [SEED_URL],
          searched: false,
          kept: 3,
          dropped,
          citations: { "prior_rounds[0]": SEED_URL },
          rechecked: 0,
          credits: 3,
        }
      : null,
  );
  return companyId;
}
