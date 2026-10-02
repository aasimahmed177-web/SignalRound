// Rate card and a running tally, printed beside the measured account delta.
// https://www.firecrawl.dev/pricing and https://docs.firecrawl.dev/features/monitoring#pricing

export const RATE = {
  searchPer10Results: 2,
  scrapePage: 1,
  jsonFormatPerPage: 4,
  /**
   * The branding format: the billing page's surcharge list (JSON, query, highlights, audio, video,
   * PII redaction, zero data retention) does not name it, so a branding-only read is the base page.
   * https://docs.firecrawl.dev/billing
   */
  brandingFormatPerPage: 0,
  /** x.com goes through Grok: 1 base + 29 for the X query, before the JSON format. https://docs.firecrawl.dev/billing */
  xProfileRequest: 30,
  monitorJudgePerResult: 1,
  mapCall: 1,
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
