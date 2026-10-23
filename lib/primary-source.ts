// A published round's official announcement, when its sources do not have one yet. The press often
// finds a round before anyone links the company's own post (NativeWebClient's Series B carried 22 write-ups
// and not firecrawl.dev/blog/introducing-alexandria-series-b), and a reader or an agent wants the
// company's own words first. One search scoped to the company's site, then (when that finds nothing)
// one map of the site and one search of the newswires, at most two pages read with the extraction,
// and a page attaches only when its own reading is this round: the company, the stage, and the amount.

import type { CorroborationCandidate, CorroborationInput, FeedRecord } from "@fireround/core";
import {
  canonicalUrl,
  DEFAULT_TIERS,
  namesCompany,
  normalizeCompanyKey,
  parseAmount,
  RATE,
  readCandidates,
  registrableDomain,
  searchCredits,
  selectNewsroomLinks,
  titleNamesCompany,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import type { NativeWebClient } from "@fireround/core/web";
import { and, eq } from "drizzle-orm";
import { applyFill } from "./gapfill.ts";
import type { RoundRow } from "./persist.ts";
import { sourceKind, WIRE_DOMAINS } from "./source-order.ts";

/** Pages read per round at most: the extraction is the expensive step. */
const MAX_PAGES = 2;
const SEARCH_LIMIT = 5;

export interface PrimarySourceOutcome {
  roundId: string;
  /** Pages considered, in the order they would be read. */
  candidates: string[];
  /** The page whose reading confirmed the round, or null. */
  confirmed: string | null;
  /** Why nothing attached, when nothing did. */
  reason: string | null;
  attached: boolean;
  creditsEstimated: number;
}

/**
 * Whether a round should look for its announcement: visible, with a known site, and no page of the
 * company's own among its sources (a wire's release is primary too, but the company's post is still looked for).
 */
export function needsPrimarySource(row: Pick<RoundRow, "disposition" | "primary_source" | "company">): boolean {
  return (
    (row.disposition === "publish" || row.disposition === "flagged") &&
    row.primary_source?.kind !== "company" &&
    Boolean(row.company.domain)
  );
}

/** The stage as a search phrase: "Series B", "seed round". */
function stagePhrase(row: Pick<RoundRow, "stage" | "stage_as_written">): string {
  return /^(?:other|undisclosed)$/.test(row.stage) ? "funding" : row.stage_as_written || row.stage.replace(/_/g, " ");
}

function within(a: number | null, b: number | null, share: number): boolean {
  return a !== null && b !== null && a > 0 && b > 0 && Math.abs(a - b) <= share * Math.max(a, b);
}

const DAY_MS = 86_400_000;

/**
 * Why a page's own reading is not this round, or null when it is: the same company, the same stage
 * (an unnamed stage on either side defers to the other facts), and the same amount within 10 percent
 * in one currency, or in dollars; a round with an amount needs the page to state one. A post on the
 * company's own site read under another name (a product's: "Introducing Alexandria and our $75M Series
 * B") is the company's when its title or sentence names the company or speaks as it ("we", "our") and its
 * day is within a week of the round's.
 */
export function confirmsRound(
  row: Pick<RoundRow, "stage" | "amount" | "company" | "announced_on">,
  reading: FeedRecord,
  opts: { ownSite?: boolean } = {},
): string | null {
  const vague = (s: string) => s === "other" || s === "undisclosed";
  if (reading.stage !== row.stage && !vague(reading.stage) && !vague(row.stage)) return `stage ${reading.stage}, not ${row.stage}`;
  if (row.amount.as_written || row.amount.usd_millions !== null) {
    const mine = parseAmount(row.amount.as_written);
    const sameCurrency =
      mine.currency !== null && mine.currency === reading.amount.currency && within(mine.value, reading.amount.value, 0.1);
    const sameUsd = within(row.amount.usd_millions, reading.amount.usd_millions, 0.1);
    if (!sameCurrency && !sameUsd) return `amount ${reading.amount.as_written ?? "not stated"}, not ${row.amount.as_written}`;
  }
  if (reading.certainty && reading.certainty !== "announced") return `${reading.certainty}, not announced`;
  const name = normalizeCompanyKey(row.company.name);
  if (reading.company_key === name || reading.company_domain === row.company.domain) return null;
  if (!opts.ownSite) return `company ${reading.company_name}`;
  // On its own site the company speaks in the first person: "We raised a $75M Series B".
  const texts = [reading.sources[0]?.title, ...reading.evidence_quotes];
  const named = texts.some((t) => namesCompany(t, row.company.name, { share: 1 }) || /\b(?:we|our)\b/i.test(t ?? ""));
  if (!named) return `company ${reading.company_name}, and the page speaks for neither ${row.company.name} nor itself`;
  const apart =
    row.announced_on && reading.announced_date
      ? Math.abs(Date.parse(`${row.announced_on}T00:00:00Z`) - Date.parse(`${reading.announced_date}T00:00:00Z`)) / DAY_MS
      : Number.POSITIVE_INFINITY;
  return apart <= 7 ? null : `company ${reading.company_name}, dated ${reading.announced_date ?? "never"}`;
}

/** Candidate pages: the company's own (by a site search, else a map of the site), else a wire's release. */
async function findCandidates(
  client: NativeWebClient,
  row: RoundRow,
  domains: string[],
  newsrooms: string[],
): Promise<{ candidates: CorroborationCandidate[]; credits: number }> {
  const known = row.sources.map((s) => s.url);
  const input = { stage_as_written: row.stage_as_written, known_urls: known, company_domain: row.company.domain };
  const phrase = `${row.company.name} ${stagePhrase(row)}`;
  let credits = 0;
  const own: CorroborationCandidate[] = [];
  for (const domain of domains.slice(0, 2)) {
    try {
      const res = await client.search(`site:${domain} ${phrase}`, { limit: SEARCH_LIMIT });
      credits += searchCredits(SEARCH_LIMIT);
      const links = (res.web ?? []).flatMap((w) =>
        "url" in w && typeof w.url === "string"
          ? [{ url: w.url, title: "title" in w && typeof w.title === "string" ? w.title : undefined }]
          : [],
      );
      own.push(...selectNewsroomLinks(links, { ...input, company_domain: domain }, MAX_PAGES));
    } catch {}
  }
  if (own.length === 0 && row.company.domain) {
    try {
      const res = await client.map(`https://${row.company.domain}`, {
        search: `${phrase} funding`,
        limit: 30,
        includeSubdomains: true,
        timeout: 30_000,
      });
      credits += RATE.mapCall;
      // A link under a newsroom the store already knows for the company reads first.
      const links = (res.links ?? []).map((l) => ({ url: l.url, title: l.title, description: l.description }));
      const inNewsroom = (url: string) => newsrooms.some((n) => url.startsWith(n.replace(/\/+$/, "")));
      own.push(
        ...selectNewsroomLinks([...links.filter((l) => inNewsroom(l.url)), ...links.filter((l) => !inNewsroom(l.url))], input, MAX_PAGES),
      );
    } catch {}
  }
  // A round that already has a wire's release needs no other one.
  if (own.length > 0 || row.primary_source?.kind === "wire") return { candidates: dedupe(own).slice(0, MAX_PAGES), credits };
  const wires: CorroborationCandidate[] = [];
  try {
    const sites = ["globenewswire.com", "prnewswire.com", "businesswire.com", "pr.com"].map((d) => `site:${d}`).join(" OR ");
    const res = await client.search(`"${row.company.name.replace(/"/g, "")}" ${stagePhrase(row)} (${sites})`, { limit: SEARCH_LIMIT });
    credits += searchCredits(SEARCH_LIMIT);
    for (const w of res.web ?? []) {
      const url = "url" in w && typeof w.url === "string" ? w.url : null;
      const title = "title" in w && typeof w.title === "string" ? w.title : null;
      if (!url || !WIRE_DOMAINS.has(registrableDomain(url) ?? "") || !titleNamesCompany(title, row.company.name)) continue;
      if (known.some((k) => canonicalUrl(k) === canonicalUrl(url))) continue;
      wires.push({ url, title: title ?? undefined });
    }
  } catch {}
  return { candidates: dedupe(wires).slice(0, MAX_PAGES), credits };
}

function dedupe(list: CorroborationCandidate[]): CorroborationCandidate[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = canonicalUrl(c.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Look for this round's announcement and, with `apply`, attach the page whose reading confirms it.
 * Only the page and its sentence attach: the round's facts, investors, and day stay as they are
 * (the fill runs with protectFacts), so the row's audit fingerprint does not move.
 */
export async function findPrimarySource(
  handle: Db,
  client: NativeWebClient,
  row: RoundRow,
  opts: { apply: boolean; tiers?: Record<string, number>; now?: Date },
): Promise<PrimarySourceOutcome> {
  const tiers = opts.tiers ?? DEFAULT_TIERS;
  const outcome: PrimarySourceOutcome = {
    roundId: row.id,
    candidates: [],
    confirmed: null,
    reason: null,
    attached: false,
    creditsEstimated: 0,
  };
  const [aliases, newsrooms] = await Promise.all([
    handle
      .select({ domain: schema.companyAliases.aliasKey })
      .from(schema.companyAliases)
      .where(and(eq(schema.companyAliases.companyId, row.company.id), eq(schema.companyAliases.kind, "domain"))),
    handle
      .select({ url: schema.companyNewsrooms.url })
      .from(schema.companyNewsrooms)
      .where(eq(schema.companyNewsrooms.companyId, row.company.id)),
  ]);
  const domains = [row.company.domain, ...aliases.map((a) => a.domain)].filter((d): d is string => Boolean(d));
  const found = await findCandidates(
    client,
    row,
    domains,
    newsrooms.map((n) => n.url),
  );
  outcome.creditsEstimated += found.credits;
  outcome.candidates = found.candidates.map((c) => c.url);
  if (found.candidates.length === 0) {
    outcome.reason = "no announcement found on the company's site or a newswire";
    return outcome;
  }
  const input: CorroborationInput = {
    company_name: row.company.name,
    stage_as_written: row.stage_as_written,
    stage: row.stage,
    amount_as_written: row.amount.as_written,
    announced_date: row.announced_on,
    company_domain: row.company.domain,
    company_description: row.company.description,
    company_headquarters: row.company.hq,
    lead_investors: row.lead_investors,
    known_urls: row.sources.map((s) => s.url),
    date_basis: row.date_basis,
    date_precision: row.date_precision,
  };
  const read = await readCandidates(client, input, found.candidates, { tiers, now: opts.now, broad: true });
  outcome.creditsEstimated += read.creditsEstimated;
  const reasons: string[] = [];
  let confirmed: FeedRecord | null = null;
  const readings = [
    ...(read.readings ?? []).map((r) => ({ r, ownSite: false })),
    ...(read.ownSite ?? []).map((r) => ({ r, ownSite: true })),
  ];
  for (const { r: reading, ownSite } of readings) {
    const page = reading.sources.find((s) => found.candidates.some((c) => canonicalUrl(c.url) === canonicalUrl(s.url)));
    const kind = page ? sourceKind(page.url, domains, tiers) : "other";
    if (!page || (kind !== "company" && kind !== "wire") || (kind === "wire" && row.primary_source)) continue;
    const refusal = confirmsRound(row, reading, { ownSite });
    if (refusal) {
      reasons.push(`${page.url}: ${refusal}`);
      continue;
    }
    confirmed = { ...reading, sources: [page] };
    break;
  }
  if (!confirmed) {
    outcome.reason = reasons[0] ?? (read.rejected > 0 ? "the pages read describe another round" : "no page read states this round");
    return outcome;
  }
  const page = confirmed.sources[0];
  outcome.confirmed = page?.url ?? null;
  if (!opts.apply || !page) return outcome;
  const applied = await applyFill(
    handle,
    row,
    {
      announced_date: null,
      amount_as_written: null,
      lead_investors: [],
      other_investors: [],
      company_website: null,
      headquarters: null,
      sector: null,
      evidence_quotes: confirmed.evidence_quotes,
      sources: [
        {
          url: page.url,
          title: page.title ?? null,
          published: page.published ?? confirmed.announced_date,
          evidence: page.evidence ?? null,
          query: "corroborate",
        },
      ],
      query: "corroborate",
    },
    { rates: null, tiers, now: opts.now, protectFacts: true },
  );
  outcome.attached = applied.added.sources > 0;
  if (!outcome.attached) outcome.reason = applied.refused[0]?.reason ?? "the page did not attach";
  return outcome;
}
