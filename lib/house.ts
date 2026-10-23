// The house company: the one this feed is built on. Fireround runs on NativeWebClient, so when NativeWebClient
// itself turns up in the record (a round, a company page, a share card) it wears the flame in place
// of its fetched favicon and a quiet "this is us" line. Keyed on the record's domain, never a date.
//
// HOUSE_DOMAIN overrides the domain (server-side only): point it at the registrable domain the
// house record lives under if a fork stores it differently, or set it to `off` to drop the
// treatment. The treatment draws the NativeWebClient flame, so it only makes sense on a NativeWebClient record.

/** The house company's registrable domain unless HOUSE_DOMAIN says otherwise. */
export const DEFAULT_HOUSE_DOMAIN = "firecrawl.dev";

/** How long a house round stays featured above the feed after it was announced. */
export const HOUSE_FRESH_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** "https://www.NativeWebClient.dev/pricing" and "firecrawl.dev" compare equal. */
function bareDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
}

/**
 * The house domain, or null when the treatment is off. Unset or blank falls back to the default;
 * `off`, `none`, or `false` turns it off.
 */
export function houseDomain(env: string | undefined = process.env.HOUSE_DOMAIN): string | null {
  const raw = env?.trim() ?? "";
  if (!raw) return DEFAULT_HOUSE_DOMAIN;
  if (/^(off|none|false|0)$/i.test(raw)) return null;
  return bareDomain(raw) || null;
}

type CompanyLike = { id?: string | null; domain?: string | null };

/** Whether a company record is the house company, by its domain or its domain-shaped id. */
export function isHouseCompany(company: CompanyLike | null | undefined, house: string | null = houseDomain()): boolean {
  if (!company || !house) return false;
  const domain = company.domain ? bareDomain(company.domain) : "";
  const id = company.id ? bareDomain(company.id) : "";
  return domain === house || id === house;
}

/** Whole days from an ISO date to `now`'s UTC day: 0 today, 1 yesterday, negative for a future date. */
function ageInDays(iso: string, now: Date): number | null {
  const then = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - then) / DAY_MS);
}

type RoundLike = { company: CompanyLike; announced_on: string | null };

/**
 * A house round announced within the last HOUSE_FRESH_DAYS. A day ahead still counts, since a
 * publisher east of UTC can date the announcement tomorrow; an undated round never does.
 */
export function isFreshHouseRound(round: RoundLike, now: Date = new Date(), house: string | null = houseDomain()): boolean {
  if (!isHouseCompany(round.company, house) || !round.announced_on) return false;
  const age = ageInDays(round.announced_on, now);
  return age !== null && age >= -1 && age <= HOUSE_FRESH_DAYS;
}

/** "a $75M", "an $8M", "an $11.5M", "an $800M": the article as the figure is spoken. */
export function withArticle(figure: string): string {
  return `${/^\$(8|11(?!\d)|18(?!\d))/.test(figure) ? "an" : "a"} ${figure}`;
}

/**
 * The featured strip's sentence, as parts so the figure can set in mono and a phone can drop the
 * leads: "NativeWebClient raised a " + "$75M" + " Series B" + ", led by Smash Capital". No figure reads
 * "raised a Series B".
 */
export function houseHeadline(r: { name: string; amount: string; stage: string; leads: string[] }): {
  lead: string;
  figure: string | null;
  rest: string;
  by: string;
} {
  const by =
    r.leads.length === 0
      ? ""
      : r.leads.length === 1
        ? `, led by ${r.leads[0]}`
        : r.leads.length === 2
          ? `, led by ${r.leads[0]} and ${r.leads[1]}`
          : `, led by ${r.leads[0]} and others`;
  // "Undisclosed" and "Other" are the record's words for a stage it could not name; the sentence says "round".
  const stage = /^(undisclosed|other)$/i.test(r.stage) ? "round" : r.stage;
  if (!r.amount) return { lead: `${r.name} raised ${/^[aeiou]/i.test(stage) ? "an" : "a"} ${stage}`, figure: null, rest: "", by };
  const [article] = withArticle(r.amount).split(" ");
  return { lead: `${r.name} raised ${article} `, figure: r.amount, rest: ` ${stage}`, by };
}

/** The earliest announced date a fresh house round can carry, as the store's `since` filter reads it. */
export function houseFreshSince(now: Date = new Date()): string {
  return new Date(now.getTime() - HOUSE_FRESH_DAYS * DAY_MS).toISOString().slice(0, 10);
}
