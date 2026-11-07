// How well a marketing role fits the seeker: fresh, at the right level, in a wanted place, and reachable directly (an
// email the employer posted for applications, or the employer's own apply page rather than a job board). Pure: the
// score is a sum of named rules, and every rule that moved it is kept as a short reason.

import { isAggregator, type MarketingJob, similarTitles } from "./marketing-jobs.ts";

const DAY_MS = 86_400_000;

export interface FitConfig {
  /** Level words wanted in the title, e.g. ["manager", "lead", "head", "senior"]. */
  seniority: string[];
  /** Wanted places, e.g. ["Bengaluru", "Mumbai", "Remote"]; empty means anywhere (remote is fine). */
  locations: string[];
}

export const DEFAULT_FIT: FitConfig = { seniority: ["manager", "lead", "head", "senior"], locations: [] };

export interface Fit {
  score: number;
  reasons: string[];
}

/** "Bengaluru, Mumbai,Remote" → ["Bengaluru", "Mumbai", "Remote"]; "any" or nothing → []. */
export const listArg = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !/^any(?:where)?$/i.test(part));

// Title levels, lowest to highest. A title with no level word is mid-level.
const LEVELS: Array<[number, RegExp]> = [
  [4, /\b(?:head|director|vp|vice president|chief|cmo)\b/i],
  [3, /\b(?:senior|sr\.?|lead|manager|principal)\b/i],
  [0, /\b(?:intern(?:ship)?|trainee|apprentice|fresher)\b/i],
  [1, /\b(?:junior|jr\.?|entry[- ]level|assistant|coordinator|graduate)\b/i],
  [2, /\b(?:executive|associate|specialist|analyst|strategist)\b/i],
];
const MID = 2;
const levelOf = (text: string) => LEVELS.find(([, pattern]) => pattern.test(text))?.[0] ?? MID;
const word = (value: string) => new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");

function seniority(title: string, wanted: string[]): [number, string] | null {
  if (!wanted.length) return null;
  // A junior word decides ("Assistant Marketing Manager"); otherwise the highest ("Senior Marketing Executive").
  const found = LEVELS.filter(([, pattern]) => pattern.test(title)).map(([lvl]) => lvl);
  const junior = found.filter((lvl) => lvl < MID);
  const level = junior.length ? Math.min(...junior) : found.length ? Math.max(...found) : MID;
  const named = wanted.find((w) => word(w).test(title));
  if (named && level >= levelOf(named)) return [20, `seniority: ${named.toLowerCase()} (+20)`];
  const targets = wanted.map(levelOf);
  const gap = Math.min(...targets.map((target) => Math.abs(target - level)));
  if (gap === 0) return [12, "seniority: same level (+12)"];
  const points = -10 * gap;
  return [points, `seniority: ${level < Math.min(...targets) ? "below" : "above"} target (${points})`];
}

// Metro areas the seeker may name (a suburb or satellite city counts as the metro), and the country each is in.
const PLACES: Record<string, { city: RegExp; country: string }> = {
  bengaluru: { city: /\b(?:bengaluru|bangalore)\b/i, country: "india" },
  mumbai: { city: /\b(?:mumbai|bombay|navi mumbai|thane)\b/i, country: "india" },
  pune: { city: /\bpune\b/i, country: "india" },
  delhi: { city: /\b(?:delhi|new delhi|ncr|gurgaon|gurugram|noida)\b/i, country: "india" },
  hyderabad: { city: /\b(?:hyderabad|secunderabad)\b/i, country: "india" },
  chennai: { city: /\bchennai\b/i, country: "india" },
  dubai: { city: /\bdubai\b/i, country: "united arab emirates" },
  london: { city: /\blondon\b/i, country: "uk" },
};
const COUNTRY: Record<string, RegExp> = {
  india: /\bindia\b/i,
  "united arab emirates": /\b(?:uae|united arab emirates)\b/i,
  uk: /\b(?:uk|united kingdom|england)\b/i,
};
const REMOTE_WORD = /^(?:remote|wfh|work from home)$/i;
const ANYWHERE = /\b(?:anywhere|worldwide|global)\b/i;
const LIMITED = /\b(?:only|usa?|united states|canada|americas?|latam|europe|emea|eu|uk|australia|philippines)\b/i;

/**
 * The location rule, and a hard filter: a job in a wanted metro, or remote and open to the wanted cities' country
 * (or to anywhere in the world). Anything else (another city, a state with no city, remote for another country) is
 * null, and rankJobs drops it.
 */
export function locationFit(job: Pick<MarketingJob, "location" | "remote">, wanted: string[]): [number, string] | null {
  const where = job.location ?? "";
  const cities = wanted.filter((place) => !REMOTE_WORD.test(place));
  for (const city of cities) {
    if ((PLACES[city.toLowerCase()]?.city ?? word(city)).test(where)) return [20, `location: ${city} (+20)`];
  }
  if (!job.remote || !wanted.some((place) => REMOTE_WORD.test(place))) return null;
  const countries = [...new Set(cities.map((city) => PLACES[city.toLowerCase()]?.country).filter(Boolean) as string[])];
  const home = countries.find((country) => COUNTRY[country]?.test(where));
  if (home || !countries.length) return [15, `location: remote${home ? `, ${home === "india" ? "India" : home.toUpperCase()}` : ""} (+15)`];
  if (ANYWHERE.test(where) && !LIMITED.test(where)) return [10, "location: remote, anywhere (+10)"];
  return null;
}

// Lines whose email is for something other than applying: adjustments, accessibility, privacy, general questions.
const NOT_APPLY_INTENT =
  /\b(?:adjustments?|accessib\w*|accommodat\w*|disab\w*|alternative format|data protection|privacy|gdpr|general (?:and additional )?(?:inquir|enquir)\w*|(?:any )?(?:questions?|queries|query)|further information|informal (?:discussion|chat)|technical support|confidential discussion)\b/i;
const APPLY_INTENT =
  /\b(?:send|share|email|e-mail|forward|submit|mail|drop)\b[^.…]{0,50}\b(?:cv|cvs|resume|résumé|resumes|portfolio|cover letter|application)s?\b|\bapply\b\s*(?:now|at|to|via|by|on|:|\/)|\bapplications?\s+(?:to|at)\b|\b(?:interested|apply)\b[^.…]{0,40}\b(?:email|write|reach)\b/i;
const intentOf = (quote: string): string | null => {
  if (APPLY_INTENT.test(quote)) return null;
  return quote.match(NOT_APPLY_INTENT)?.[0]?.toLowerCase() ?? null;
};

/** The job's fit: freshness, seniority, location, a posted email (and what it is for), and how to apply. */
export function scoreFit(job: MarketingJob, config: FitConfig = DEFAULT_FIT, now = new Date()): Fit {
  const reasons: string[] = [];
  let score = 0;
  const add = (rule: [number, string] | null) => {
    if (!rule) return;
    score += rule[0];
    reasons.push(rule[1]);
  };
  const days = Math.max(0, Math.floor((now.getTime() - new Date(job.posted_at).getTime()) / DAY_MS));
  const fresh = Math.max(0, 20 - 3 * days);
  add([fresh, `freshness: ${days}d old (+${fresh})`]);
  add(seniority(job.title, config.seniority));
  if (config.locations.length) add(locationFit(job, config.locations) ?? [-50, `location: outside ${config.locations.join(", ")} (-50)`]);
  const intent = job.emails.length ? intentOf(job.email_source_quote ?? "") : null;
  if (job.emails.length) add([15, "posted email (+15)"]);
  if (intent) add([-20, `email intent: ${intent}, not applications (-20)`]);
  const applyEmail = job.emails.length > 0 && !intent;
  if (!isAggregator(job.apply_url)) add([10, "direct employer apply link (+10)"]);
  else if (!applyEmail) add([-10, "aggregator-only apply link (-10)"]);
  return { score, reasons };
}

// Tracking parameters that make one posting's apply link look like two.
const TRACKING = /^(?:utm_\w+|source|src|ref|referrer|gh_src|lever-\w+|trk\w*|from)$/i;
const applyKey = (url: string) => {
  try {
    const link = new URL(url);
    for (const key of [...link.searchParams.keys()]) if (TRACKING.test(key)) link.searchParams.delete(key);
    return `${link.hostname.replace(/^www\./, "")}${link.pathname.replace(/\/+$/, "")}${link.search}`.toLowerCase();
  } catch {
    return url;
  }
};

/**
 * Jobs in the wanted places with their fit, best first (newer first on a tie). One row per apply link: a second row
 * with the same link and a similar title is the same opening (a shared careers page with another role is kept).
 */
export function rankJobs<T extends MarketingJob>(jobs: T[], config: FitConfig = DEFAULT_FIT, now = new Date()) {
  const seen = new Map<string, string[]>();
  return jobs
    .filter((job) => !config.locations.length || locationFit(job, config.locations))
    .map((job) => ({ ...job, fit: scoreFit(job, config, now) }))
    .sort((a, b) => b.fit.score - a.fit.score || b.posted_at.localeCompare(a.posted_at))
    .filter((job) => {
      const key = applyKey(job.apply_url);
      const titles = seen.get(key) ?? [];
      if (titles.some((title) => similarTitles(title, job.title))) return false;
      seen.set(key, [...titles, job.title]);
      return true;
    });
}
