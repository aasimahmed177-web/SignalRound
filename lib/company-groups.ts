// The company page's Sources and Investors panels, grouped by round, and where the dossier meets
// the record: one founders list, the backers no investor names, the prior rounds no round covers.
// Pure over what getCompany already returns (the page's rounds, the union of their sources, the
// investors with their per-round roles, the dossier), so a company with many rounds costs no extra
// query and the grouping is unit-tested.

import {
  type CompanyDossier,
  dedupeInvestorNames,
  duplicatesOurRound,
  type OurRound,
  parseAmount,
  priorKey,
  seriesLetter,
  totalBelowOurRound,
} from "@fireround/core";
import { orderSources, sourceGroupKey } from "./news";

/**
 * The funding to date a round's page stated beside its money, in USD millions, when it is more than
 * the round itself (Parallax's $117M beside its $75M Series A, the seed before it not yet on
 * record); null when there is none, it is not in dollars, or it adds nothing.
 */
export function totalToDate(r: { financing_total_as_written?: string | null; amount: { usd_millions: number | null } }): number | null {
  const t = parseAmount(r.financing_total_as_written);
  if (t.currency !== "USD" || t.value === null) return null;
  return r.amount.usd_millions !== null && t.value <= r.amount.usd_millions * 1.02 ? null : t.value;
}

/** The slice of a source the grouping reads; CompanyPage's sources satisfy it. */
export interface GroupableSource {
  url: string;
  host: string;
  title: string | null;
  published_at: string | null;
  round_ids: string[];
}

/** One line in a round's list: the copy shown, and the syndicated copies folded under it ("also on"). */
export interface SourceEntry<S extends GroupableSource> {
  primary: S;
  also: S[];
}

export interface RoundSources<R, S extends GroupableSource> {
  round: R;
  entries: Array<SourceEntry<S>>;
  /** Every source behind the round, the folded copies included: what the heading counts. */
  count: number;
}

/**
 * Syndicated copies fold to one entry per wire title, the best-tier publisher shown and the rest
 * named under it; a section index page never folds. Newest entry first.
 */
export function foldSyndicated<S extends GroupableSource>(sources: S[], tiers: Record<string, number>): Array<SourceEntry<S>> {
  const byTitle = new Map<string, S[]>();
  const entries: Array<SourceEntry<S>> = [];
  for (const s of sources) {
    const key = sourceGroupKey(s.title);
    if (key) byTitle.set(key, [...(byTitle.get(key) ?? []), s]);
    else entries.push({ primary: s, also: [] });
  }
  for (const group of byTitle.values()) {
    const [primary, ...also] = orderSources(group, tiers);
    entries.push({ primary, also });
  }
  return entries.sort((a, b) => (b.primary.published_at ?? "").localeCompare(a.primary.published_at ?? ""));
}

/**
 * The sources under the round each supports, in the rounds' order (the page's, newest first). A
 * source behind two rounds is listed under both: it is evidence for each. A round with no source
 * on record is left out rather than drawn as an empty heading.
 */
export function sourcesByRound<R extends { id: string }, S extends GroupableSource>(
  rounds: R[],
  sources: S[],
  tiers: Record<string, number>,
): Array<RoundSources<R, S>> {
  const out: Array<RoundSources<R, S>> = [];
  for (const round of rounds) {
    const own = sources.filter((s) => s.round_ids.includes(round.id));
    if (own.length === 0) continue;
    out.push({ round, entries: foldSyndicated(own, tiers), count: own.length });
  }
  return out;
}

/** The slice of an investor the grouping reads; CompanyPage's investors satisfy it. */
export interface GroupableInvestor {
  id: string;
  name: string;
  total: number;
  roles: Array<{ round_id: string; lead: boolean }>;
}

export interface RoundInvestors<R, I extends GroupableInvestor> {
  round: R;
  leads: I[];
  participants: I[];
}

/**
 * The investors under each round they are on, leads first, in the rounds' order (newest first). An
 * investor on three rounds appears under all three. Within a role, the backers who came back for
 * more rounds lead, then by name, so a reader sees who stayed. A round with no investor named
 * (every round off the feed, since getCompany reads investors for feed rounds only) is left out.
 */
export function investorsByRound<R extends { id: string }, I extends GroupableInvestor>(
  rounds: R[],
  investors: I[],
): Array<RoundInvestors<R, I>> {
  const order = (a: I, b: I) => b.total - a.total || a.name.localeCompare(b.name);
  const out: Array<RoundInvestors<R, I>> = [];
  for (const round of rounds) {
    const leads: I[] = [];
    const participants: I[] = [];
    for (const i of investors) {
      const role = i.roles.find((r) => r.round_id === round.id);
      if (!role) continue;
      (role.lead ? leads : participants).push(i);
    }
    if (leads.length + participants.length === 0) continue;
    out.push({ round, leads: leads.sort(order), participants: participants.sort(order) });
  }
  return out;
}

/** One founder as the page lists them: the dossier's role and background, YC's LinkedIn page. */
export interface FounderLine {
  name: string;
  role: string | null;
  background: string | null;
  linkedin_url: string | null;
}

/** "Andy Lapsa" and "andy  lapsa" are one person; so are "José" and "Jose". */
const personKey = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();

/**
 * One founders list from the dossier's and YC's: the dossier's people in its order, each with the
 * LinkedIn page YC lists for the same name, then the founders only YC names. The dossier's role
 * wins over YC's title; YC's title fills a role the dossier left empty.
 */
export function mergeFounders(
  dossier: Array<{ name: string; role: string | null; background: string | null }>,
  yc: Array<{ name: string; title: string | null; linkedin_url: string | null }>,
): FounderLine[] {
  const ycByKey = new Map(yc.map((f) => [personKey(f.name), f]));
  const seen = new Set<string>();
  const out: FounderLine[] = [];
  for (const f of dossier) {
    const key = personKey(f.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const match = ycByKey.get(key);
    out.push({ name: f.name, role: f.role ?? match?.title ?? null, background: f.background, linkedin_url: match?.linkedin_url ?? null });
  }
  for (const f of yc) {
    const key = personKey(f.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: f.name, role: f.title, background: null, linkedin_url: f.linkedin_url });
  }
  return out;
}

/**
 * The names research may print one investor under: the name itself, without its "L.P." tail, without
 * its parenthetical, each name inside the parenthetical ("Caisse de dépôt et placement du Québec (CDPQ /
 * La Caisse)"), the manager of "funds and accounts managed by BlackRock", the firm a unit belongs to
 * ("Growth Equity at Goldman Sachs Alternatives"), and the owner a possessive names ("Phoenix Court's Solar fund").
 */
function backerForms(name: string): string[] {
  const bare = name.replace(/,?\s+L\.?P\.?$/i, "").trim();
  const inner = [...bare.matchAll(/\(([^)]*)\)/g)].flatMap((m) => m[1].split(/\s*\/\s*/));
  const manager = /\b(?:managed|advised) by\s+(.+)$/i.exec(bare)?.[1];
  const parent = /^(?:growth equity|private equity|venture capital|growth|ventures?)\s+(?:at|of)\s+(.+)$/i.exec(bare)?.[1];
  const owner = /^(.+?)['\u2019]s\s+\S/.exec(bare)?.[1];
  return [name, bare, bare.replace(/\s*\([^)]*\)/g, "").trim(), ...inner, manager, parent, owner].filter(
    (f): f is string => !!f && f.trim().length > 0,
  );
}

/** The dossier's backers no investor on the page already names, in the dossier's order: "Glade Brook Capital Partners" is Glade Brook. */
export function unlistedBackers(backers: string[], investorNames: string[]): string[] {
  const out: string[] = [];
  for (const b of backers) {
    const forms = backerForms(b);
    if ([...investorNames, ...out].some((n) => forms.some((f) => dedupeInvestorNames([f, n]).length === 1))) continue;
    out.push(b);
  }
  return out;
}

/** The slice of a round the dossier's prior rounds are matched against; RoundRow satisfies it. */
export interface MatchableRound {
  stage_as_written: string;
  amount: { value: number | null; currency: string | null; as_written: string | null; usd_millions: number | null };
  announced_on: string | null;
  lead_investors: string[];
  other_investors: string[];
  disposition: string;
  history: boolean;
  first_seen_at: string;
}

/**
 * The dossier's prior rounds that match no round on the page (duplicatesOurRound: the same stage
 * inside four months, or the same amount), newest first as the page lists its rounds: the dossier
 * lists them oldest first, so its order is turned over. A round the page already lists, history or
 * not, is the page's to show. `ruledOut` holds the ledger keys the history lane searched without
 * finding a page (no_source) or found too vague to search (skipped): OpenAI's dossier called
 * Microsoft's 2023 investment a "Series C" no page states, and the page should not repeat it.
 * A prior whose series letter a round on the page already carries is the dossier's guess at a label,
 * shown as a plain funding round: Anthropic's dossier called Amazon's $2.75B tranche a "Series E"
 * beside the record's sourced $3.5B Series E, and a company has one Series E.
 */
export function priorsOffRecord(
  priors: CompanyDossier["prior_rounds"],
  rounds: MatchableRound[],
  ruledOut: ReadonlySet<string> = new Set(),
): CompanyDossier["prior_rounds"] {
  const ours = asOurRounds(rounds);
  const letters = new Set(rounds.map((r) => seriesLetter(r.stage_as_written)).filter(Boolean));
  return priors
    .filter((p) => !duplicatesOurRound(p, ours) && !ruledOut.has(priorKey(p)))
    .map((p) => (letters.has(seriesLetter(p.stage_as_written)) ? { ...p, stage_as_written: "Funding round" } : p))
    .reverse();
}

/**
 * The round on the page the dossier was written before: one first recorded after it, history aside
 * (history rows come out of the dossier itself). The same rule outdates a dossier in the pipeline
 * (dossierStates in lib/intel.ts), so what the page says and what the next sweep re-dives agree.
 */
export function roundAfter<R extends MatchableRound>(rounds: R[], writtenAt: string): R | null {
  const written = Date.parse(writtenAt);
  return rounds.find((r) => !r.history && Date.parse(r.first_seen_at) > written) ?? null;
}

/**
 * The dossier's total raised, when it still says something the page does not. It goes when it
 * cannot be right against the record: below one of our rounds alone, or written before a round on
 * the page (a total from before a Series B leaves the B out). It also goes when it adds nothing: in
 * dollars and no more than the rounds here already add up to, which the Total raised card shows.
 * What is left is a total above ours, the rounds the record has not caught yet. The check applies
 * the first two rules when a dossier is saved; this keeps them true after the next round lands.
 */
export function dossierTotal(
  total: string | null,
  rounds: MatchableRound[],
  ourUsdMillions: number | null,
  writtenAt: string,
): string | null {
  if (!total) return null;
  if (totalBelowOurRound(total, asOurRounds(rounds)) || roundAfter(rounds, writtenAt)) return null;
  const t = parseAmount(total);
  if (t.currency === "USD" && t.value !== null && ourUsdMillions !== null && t.value <= ourUsdMillions * 1.02) return null;
  return total;
}

function asOurRounds(rounds: MatchableRound[]): OurRound[] {
  return rounds.map((r) => ({
    stage_as_written: r.stage_as_written,
    amount_as_written: r.amount.as_written,
    amount_value: r.amount.value,
    amount_currency: r.amount.currency,
    usd_millions: r.amount.usd_millions,
    announced_on: r.announced_on,
    lead_investors: r.lead_investors,
    other_investors: r.other_investors,
    verified: r.disposition === "publish",
    evidence: [],
  }));
}
