// How a stored posting reads on the Jobs page: the emails the employer printed in it (with the line and the page),
// the link to apply on (the employer's own page or ATS before a job board), and the fit score a ranked run attached.
// Pure, so the page and its tests read one set of rules.

import { isAggregator } from "@/lib/marketing-jobs";

export interface JobLike {
  url: string;
  metadata: Record<string, unknown>;
}

export interface JobEmail {
  email: string;
  sourceUrl: string;
  quote: string | null;
}

export interface Fit {
  score: number;
  reasons: string[];
}

const EMAIL = /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[a-z]{2,}$/i;
const http = (value: unknown): value is string => typeof value === "string" && /^https?:\/\//i.test(value);

/**
 * The posting's printed emails. `public_emails` holds addresses (or `{ email, source_url, quote }`), and
 * `email_source_quote` the line they were printed in; the posting itself is the source unless one is named. An
 * address whose quote does not contain it keeps no quote, so a hover never shows a line the address is not in.
 */
export function jobEmails(job: JobLike): JobEmail[] {
  const { metadata } = job;
  const sharedQuote = typeof metadata.email_source_quote === "string" ? metadata.email_source_quote : null;
  const list = Array.isArray(metadata.public_emails) ? metadata.public_emails : [];
  const out: JobEmail[] = [];
  for (const item of list) {
    const raw =
      typeof item === "string"
        ? { email: item, source_url: null, quote: null }
        : item && typeof item === "object"
          ? (item as { email?: unknown; source_url?: unknown; quote?: unknown })
          : null;
    const email = typeof raw?.email === "string" ? raw.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email) || out.some((e) => e.email === email)) continue;
    const quote = [raw?.quote, sharedQuote].find((q): q is string => typeof q === "string" && q.toLowerCase().includes(email));
    out.push({ email, sourceUrl: http(raw?.source_url) ? raw.source_url : job.url, quote: quote ?? null });
  }
  return out.slice(0, 4);
}

/** Where to apply: the employer's own page or ATS when the posting names one, else the posting itself. */
export function applyLink(job: JobLike): { url: string; direct: boolean } {
  const named = job.metadata.apply_url;
  if (http(named) && !isAggregator(named)) return { url: named, direct: true };
  return { url: job.url, direct: !isAggregator(job.url) };
}

/** A ranked run's `fit: { score, reasons }` (or `fit_score` / `fit_reasons`), when the posting carries one. */
export function jobFit(metadata: Record<string, unknown>): Fit | null {
  const nested = metadata.fit && typeof metadata.fit === "object" ? (metadata.fit as Record<string, unknown>) : null;
  const score = Number(nested?.score ?? metadata.fit_score);
  if (!Number.isFinite(score) || (nested?.score ?? metadata.fit_score) == null) return null;
  const rawReasons = nested?.reasons ?? metadata.fit_reasons;
  const reasons = Array.isArray(rawReasons) ? rawReasons.filter((r): r is string => typeof r === "string").slice(0, 6) : [];
  return { score: Math.round(score), reasons };
}

/** Email them when the posting printed an email; otherwise apply via the link. */
export function splitJobs<T extends JobLike>(rows: T[]): { email: T[]; apply: T[] } {
  const email: T[] = [];
  const apply: T[] = [];
  for (const row of rows) (jobEmails(row).length ? email : apply).push(row);
  return { email, apply };
}

/** "today", "3d ago", "5w ago": how old a posting is. */
export function ageLabel(value: Date | null, now = new Date()): string | null {
  if (!value) return null;
  const days = Math.floor((now.getTime() - value.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 28) return `${days}d ago`;
  if (days < 120) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
