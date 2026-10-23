// Legacy ledger compatibility. Native scraping has no service-credit charge.
// Model-provider and hosting costs are separate; zero here does not mean free compute.

export const RATE = {
  searchPer10Results: 0,
  scrapePage: 0,
  jsonFormatPerPage: 0,
  /** Branding is parsed locally from public page metadata. */
  brandingFormatPerPage: 0,
  /** Publicly indexed posts only; there is no hosted X reader. */
  xProfileRequest: 0,
  monitorJudgePerResult: 0,
  mapCall: 0,
} as const;

export const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);

export function isXUrl(url: string): boolean {
  try {
    return X_HOSTS.has(new URL(url).hostname.replace(/^www\./, ""));
  } catch {
    return false;
  }
}

/** What one JSON extraction of this URL costs. */
export function pageCredits(url: string): number {
  return (isXUrl(url) ? RATE.xProfileRequest : RATE.scrapePage) + RATE.jsonFormatPerPage;
}

export interface CreditLine {
  label: string;
  credits: number;
}

export class CreditTally {
  readonly lines: CreditLine[] = [];
  add(label: string, credits: number): void {
    this.lines.push({ label, credits });
  }
  total(): number {
    return this.lines.reduce((n, l) => n + l.credits, 0);
  }
}

export function searchCredits(resultCount: number): number {
  return Math.ceil(Math.max(resultCount, 1) / 10) * RATE.searchPer10Results;
}

/** A page count prices ordinary pages; a URL list prices each by host, so X profiles count at their rate. */
export function extractionCredits(pages: number | string[]): number {
  if (typeof pages === "number") return pages * (RATE.scrapePage + RATE.jsonFormatPerPage);
  return pages.reduce((n, url) => n + pageCredits(url), 0);
}

/** What `pages` branding-only reads cost: no JSON, no main-content markdown, the base page plus the format. */
export function brandingCredits(pages: number): number {
  return pages * (RATE.scrapePage + RATE.brandingFormatPerPage);
}

/** Small concurrency limiter so a run never floods the API or the plan's browser limit. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
