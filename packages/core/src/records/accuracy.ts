// The daily accuracy check's rules, pure. The companies a reader is most likely to look up (the
// largest rounds, the most raised) are the ones whose mistakes get noticed: an audit found OpenAI with
// no homepage, a "Series A" from a trend story beside its $40 billion round, its unlettered rounds
// shown as Other, no founders, a total raised far below what it raised, and Anthropic's Series B
// dated four years late. Each rule below names one of those shapes; lib/accuracy.ts loads what the
// store holds about each company, runs these, and keeps the flags an admin reviews.

import type { FundingLead, KnownRound } from "./history.ts";
import { missingLeads, priorAsKnown } from "./history.ts";
import { type StoredRound, stageRegression } from "./plausibility.ts";
import type { Stage } from "./stages.ts";

export type AccuracySeverity = "high" | "medium" | "low";

export const ACCURACY_RULES = [
  "no_domain",
  "no_description",
  "no_logo",
  "stage_regression",
  "list_only",
  "unverified",
  "apollo_total_gap",
  "apollo_missing_round",
  "dossier_missing",
  "dossier_no_founders",
  "founders_dropped",
  "stage_other_large",
  "possible_duplicate",
  "no_lead_large",
] as const;
export type AccuracyRule = (typeof ACCURACY_RULES)[number];

/**
 * A remedy the daily run may start on its own, because it only adds evidence and every result still
 * passes its lane's own checks: a profile refresh (the homepage identity check), a deep dive (the
 * dossier check), or a history lead (read back like any round). Everything else waits for a person.
 */
export type AccuracyRemedy = "profile" | "dossier" | "history";

/** Companies the check reads: the top N by largest round and by total raised, plus every $100M+ round. */
export const ACCURACY_TOP_N = 100;
/** A round this large makes its company prominent, and an Other stage on it is a mislabel a reader sees. */
export const BIG_ROUND_USD_MILLIONS = 100;
/** A round this large with no lead named reads as incomplete. */
export const LEAD_EXPECTED_USD_MILLIONS = 50;
/** The confidence a round needs to publish (lib/persist.ts dispositionFor). */
export const PUBLISH_CONFIDENCE = 0.75;
/** A round may sit under the publish bar this long while its lanes finish before it is flagged. */
export const UNVERIFIED_GRACE_HOURS = 24;
/** Our verified total under this share of Apollo's total is a gap worth a look... */
export const APOLLO_TOTAL_RATIO = 0.5;
/** ...when the gap is at least this many USD millions (a $3M company off by $2M is noise). */
export const APOLLO_TOTAL_MIN_GAP_USD_MILLIONS = 10;
/** Two rounds of one company inside this many days... */
export const DUPLICATE_WINDOW_DAYS = 30;
/** ...whose amounts agree within this share of the larger are likely one round. */
export const DUPLICATE_AMOUNT_RATIO = 0.1;

const SEVERITY: Record<AccuracyRule, AccuracySeverity> = {
  no_domain: "high",
  no_description: "medium",
  no_logo: "medium",
  stage_regression: "high",
  list_only: "medium",
  unverified: "high",
  apollo_total_gap: "medium",
  apollo_missing_round: "medium",
  dossier_missing: "high",
  dossier_no_founders: "medium",
  founders_dropped: "medium",
  stage_other_large: "medium",
  possible_duplicate: "high",
  no_lead_large: "low",
};

/** One visible round (publish or flagged) as the rules read it. */
export interface AccuracyRound {
  id: string;
  stage: Stage;
  stageAsWritten: string;
  amountUsdMillions: number | null;
  amountAsWritten: string | null;
  announcedOn: string | null;
  datePrecision: string;
  /** The read-back's status (confirmed, corrected, unverified, ...), or null when never read back. */
  verification: string | null;
  confidence: number;
  /** ISO time the store first saw the round. */
  firstSeenAt: string;
  history: boolean;
  /** The titles of the round's sources, one per source. */
  sourceTitles: Array<string | null>;
  leadCount: number;
}

/** What the store holds about one company, loaded by lib/accuracy.ts. */
export interface AccuracyCompany {
  id: string;
  name: string;
  domain: string | null;
  /** A homepage read accepted the domain as this company's (a verified profile row). */
  domainVerified: boolean;
  description: string | null;
  logoUrl: string | null;
  /** Visible rounds only: what a reader sees. */
  rounds: AccuracyRound[];
  /** The stored Apollo lookup when it matched, else null. */
  apollo: { totalFundingUsdMillions: number | null; events: FundingLead[] } | null;
  /** Every round the store, the history ledger, or the dossier already knows, as the lead check reads them. */
  known: KnownRound[];
  /** The dossier row: checked (schema version 2 with its check's record) or not, and its founders. */
  dossier: { checked: boolean; founders: string[] } | null;
  /** The founders of the dossier before the current one, when the check has seen one replace another. */
  previousFounders: string[] | null;
}

export interface AccuracyFlag {
  rule: AccuracyRule;
  severity: AccuracySeverity;
  /** One sentence a reviewer can act on. */
  reason: string;
  /**
   * What the flag is about (round ids, missing fields, names), sorted: a dismissal holds while the
   * flag stays about the same things, and a new round with the same problem opens it again.
   */
  subjects: string[];
  remedy: AccuracyRemedy | null;
}

const DAY = 86_400_000;

/** A USD millions figure as a reader writes it: $580M, $40B, $1.3B. */
export function usdLabel(m: number): string {
  if (m >= 1000) return `$${Number((m / 1000).toFixed(1))}B`;
  if (m >= 1) return `$${Number(m.toFixed(m >= 100 ? 0 : 1))}M`;
  return `$${Math.round(m * 1000)}K`;
}

function roundLabel(r: Pick<AccuracyRound, "stageAsWritten" | "amountUsdMillions" | "announcedOn">): string {
  const size = r.amountUsdMillions !== null ? ` ${usdLabel(r.amountUsdMillions)}` : "";
  return `${r.stageAsWritten}${size} (${r.announcedOn ?? "undated"})`;
}

/** Read back and confirmed or corrected, or promoted as history from its own announcement. */
export function roundVerified(r: Pick<AccuracyRound, "verification" | "history">): boolean {
  return r.history || r.verification === "confirmed" || r.verification === "corrected";
}

/** The sum of the verified visible rounds' USD amounts: the total raised a page shows, as far as it is checked. */
export function verifiedTotal(rounds: AccuracyRound[]): number {
  return rounds.reduce((n, r) => (roundVerified(r) && r.amountUsdMillions !== null ? n + r.amountUsdMillions : n), 0);
}

/** A title that reads as a weekly or monthly list rather than a story about one round. */
const LIST_TITLE =
  /\b(roundup|round-up|weekly|this week|week in|monthly|this month|recap|newsletter|biggest (funding )?rounds|top \d+|megarounds)\b/i;

/** Every source is a list: dated to a week or a month from one page, or every title reads as a roundup. */
function knownOnlyFromLists(r: AccuracyRound): boolean {
  // The persist rule's own test (plausibility.ts onlyFromLists): one source, dated to its week or month.
  if (r.sourceTitles.length <= 1 && (r.datePrecision === "week" || r.datePrecision === "month")) return true;
  return r.sourceTitles.length > 0 && r.sourceTitles.every((t) => t !== null && LIST_TITLE.test(t));
}

function asStored(r: AccuracyRound): StoredRound {
  return { stage: r.stage, announcedOn: r.announcedOn, amountUsdMillions: r.amountUsdMillions, verified: roundVerified(r) };
}

/** A name as two dossiers may spell it: case, accents, punctuation, and a middle initial aside. */
export function founderKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b[a-z]\.\s*/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Founders the previous dossier named that the current one does not. Pure. */
export function droppedFounders(previous: string[], current: string[]): string[] {
  const now = new Set(current.map(founderKey));
  return previous.filter((n) => founderKey(n) && !now.has(founderKey(n)));
}

function flag(
  rule: AccuracyRule,
  reason: string,
  subjects: string[],
  remedy: AccuracyRemedy | null = null,
  severity?: AccuracySeverity,
): AccuracyFlag {
  return { rule, severity: severity ?? SEVERITY[rule], reason, subjects: [...new Set(subjects)].sort(), remedy };
}

function list(items: string[], max = 3): string {
  const shown = items.slice(0, max).join("; ");
  return items.length > max ? `${shown}; and ${items.length - max} more` : shown;
}

/** A stage as a reason names it. */
const STAGE_WORD: Partial<Record<Stage, string>> = {
  pre_seed: "pre-seed",
  seed: "seed",
  series_a: "Series A",
  series_b: "Series B",
  series_c: "Series C",
  series_d_plus: "Series D or later",
  growth: "growth",
  bridge: "bridge",
  pre_a: "pre_a",
  other: "unlettered",
  undisclosed: "undisclosed",
};

/** The lettered stages in order; growth, bridge, and the rest say nothing about the letter. */
const LETTER_RANK: Partial<Record<Stage, number>> = { pre_seed: 0, seed: 1, series_a: 2, series_b: 3, series_c: 4, series_d_plus: 5 };

/**
 * The verified lettered round, dated on or before this one, at least two letters above it and at
 * least as large, that makes a lettered round with an amount read as misdated. Null when none. Pure.
 */
export function letteredRegression(r: AccuracyRound, others: AccuracyRound[]): StoredRound | null {
  const mine = LETTER_RANK[r.stage];
  if (mine === undefined || !r.announcedOn || r.amountUsdMillions === null) return null;
  let worst: AccuracyRound | null = null;
  for (const o of others) {
    const theirs = LETTER_RANK[o.stage];
    if (theirs === undefined || !roundVerified(o) || !o.announcedOn || o.announcedOn > r.announcedOn) continue;
    if (theirs - mine < 2 || (o.amountUsdMillions ?? 0) < r.amountUsdMillions) continue;
    if (!worst || theirs > (LETTER_RANK[worst.stage] ?? 0) || (o.amountUsdMillions ?? 0) > (worst.amountUsdMillions ?? 0)) worst = o;
  }
  return worst ? asStored(worst) : null;
}

/** Every rule over one company. Pure: `now` is the only clock. */
export function accuracyFlags(c: AccuracyCompany, now: Date): AccuracyFlag[] {
  const out: AccuracyFlag[] = [];

  // The profile a reader sees first.
  if (!c.domain) out.push(flag("no_domain", "No domain: the company has no homepage on record.", ["no domain"], "profile"));
  else if (!c.domainVerified)
    out.push(flag("no_domain", `No homepage read has verified ${c.domain} as this company's.`, [`unverified ${c.domain}`], "profile"));
  if (!c.description) out.push(flag("no_description", "No description: the page does not say what the company does.", ["no description"]));
  if (!c.logoUrl && !c.domain) out.push(flag("no_logo", "No logo, and no domain to find one by.", ["no logo"]));
  else if (!c.logoUrl) out.push(flag("no_logo", "No logo stored; the page falls back to a favicon lookup.", ["no logo"]));

  // Rounds that do not fit what the company verifiably raised. With no amount, the persist rule's own
  // test (a Series A after verified billion-dollar rounds). With an amount, only a lettered round two
  // or more letters below a larger verified lettered round: a Series B after a Series F reads as
  // misdated, while a Series D after an unlettered "growth" round, or a Series C of $4.5B after a
  // $1.2B Series B, is the company moving on.
  const regressions: Array<{ r: AccuracyRound; earlier: StoredRound }> = [];
  for (const r of c.rounds) {
    const others = c.rounds.filter((o) => o.id !== r.id);
    const earlier =
      r.amountAsWritten === null
        ? stageRegression({ stage: r.stage, announced_date: r.announcedOn }, others.map(asStored))
        : letteredRegression(r, others);
    if (earlier) regressions.push({ r, earlier });
  }
  if (regressions.length > 0) {
    const amountless = regressions.some(({ r }) => r.amountAsWritten === null);
    const what = regressions.map(({ r, earlier }) => {
      const size = earlier.amountUsdMillions !== null ? ` ${usdLabel(earlier.amountUsdMillions)}` : "";
      return `${roundLabel(r)} after a verified ${STAGE_WORD[earlier.stage as Stage] ?? earlier.stage}${size} round on ${earlier.announcedOn}`;
    });
    out.push(
      flag(
        "stage_regression",
        amountless
          ? `A round with no amount falls below what the company verifiably raised before: ${list(what)}.`
          : `A round sits letters below a larger verified round; misdated, or the company restarted its lettering: ${list(what)}.`,
        regressions.map(({ r }) => r.id),
        null,
        amountless ? "high" : "medium",
      ),
    );
  }
  const lists = c.rounds.filter((r) => r.amountAsWritten === null && knownOnlyFromLists(r));
  if (lists.length > 0) {
    out.push(
      flag(
        "list_only",
        `A round with no amount is known only from a weekly or monthly list: ${list(lists.map(roundLabel))}.`,
        lists.map((r) => r.id),
      ),
    );
  }

  // Rounds a reader sees that the read-back never confirmed, a day after they landed.
  const grace = now.getTime() - UNVERIFIED_GRACE_HOURS * 3_600_000;
  const weak = c.rounds.filter(
    (r) => new Date(r.firstSeenAt).getTime() < grace && (!roundVerified(r) || r.confidence < PUBLISH_CONFIDENCE),
  );
  if (weak.length > 0) {
    const unread = weak.filter((r) => !roundVerified(r));
    const what = weak.map(
      (r) => `${roundLabel(r)}, ${roundVerified(r) ? `confidence ${r.confidence.toFixed(2)}` : (r.verification ?? "never read back")}`,
    );
    out.push(
      flag(
        "unverified",
        unread.length > 0
          ? `${weak.length === 1 ? "A round has" : `${weak.length} rounds have`} sat unverified or under the publish bar for over a day: ${list(what)}.`
          : `${weak.length === 1 ? "A verified round sits" : `${weak.length} verified rounds sit`} under the publish bar (${PUBLISH_CONFIDENCE}) after a day: ${list(what)}.`,
        weak.map((r) => r.id),
        null,
        unread.length > 0 ? "high" : "low",
      ),
    );
  }

  // Apollo as a second opinion on the total and the rounds (never shown to a reader).
  if (c.apollo) {
    const ours = verifiedTotal(c.rounds);
    const theirs = c.apollo.totalFundingUsdMillions;
    if (theirs !== null && ours < theirs * APOLLO_TOTAL_RATIO && theirs - ours >= APOLLO_TOTAL_MIN_GAP_USD_MILLIONS) {
      out.push(
        flag("apollo_total_gap", `Total raised (verified) is ${usdLabel(ours)}, under half of the ${usdLabel(theirs)} Apollo lists.`, [
          "total gap",
        ]),
      );
    }
    const missing = missingLeads(c.apollo.events, c.known).filter((p) => (priorAsKnown(p).usd_millions ?? 0) >= BIG_ROUND_USD_MILLIONS);
    if (missing.length > 0) {
      const what = missing.map((p) =>
        `${p.stage_as_written} ${p.amount_as_written ?? ""} (${p.announced_date ?? "undated"})`.replace(/\s+/g, " "),
      );
      out.push(
        flag(
          "apollo_missing_round",
          `Apollo lists ${missing.length === 1 ? "a round" : `${missing.length} rounds`} of $100M or more that the store and the history ledger lack: ${list(what)}.`,
          missing.map((p) => `${p.stage_as_written}|${p.amount_as_written ?? ""}|${p.announced_date ?? ""}`.toLowerCase()),
          "history",
        ),
      );
    }
  }

  // The dossier: who founded it and what it raised before.
  if (!c.dossier)
    out.push(flag("dossier_missing", "No dossier: no founders, prior rounds, or backers on the page.", ["missing"], "dossier"));
  else if (!c.dossier.checked)
    out.push(
      flag(
        "dossier_missing",
        "The dossier predates the check and stays hidden from visitors until checked.",
        ["unchecked"],
        "dossier",
        "medium",
      ),
    );
  else if (c.dossier.founders.length === 0)
    out.push(flag("dossier_no_founders", "The checked dossier names no founders.", ["no founders"], "dossier"));
  if (c.dossier && c.previousFounders) {
    const dropped = droppedFounders(c.previousFounders, c.dossier.founders);
    if (dropped.length > 0) {
      out.push(
        flag(
          "founders_dropped",
          `The new dossier dropped ${dropped.length === 1 ? "a founder" : `${dropped.length} founders`} the previous one named: ${list(dropped, 5)}.`,
          dropped.map(founderKey),
        ),
      );
    }
  }

  // Labels and syndicates that read wrong on a large round.
  const other = c.rounds.filter(
    (r) => (r.stage === "other" || r.stage === "undisclosed") && (r.amountUsdMillions ?? 0) >= BIG_ROUND_USD_MILLIONS,
  );
  if (other.length > 0) {
    out.push(
      flag(
        "stage_other_large",
        `A round of $100M or more has no stage a reader can use: ${list(other.map(roundLabel))}.`,
        other.map((r) => r.id),
      ),
    );
  }
  const pairs = duplicatePairs(c.rounds);
  if (pairs.length > 0) {
    out.push(
      flag(
        "possible_duplicate",
        `Two rounds within ${DUPLICATE_WINDOW_DAYS} days with amounts within a tenth, likely one round: ${list(pairs.map(([a, b]) => `${roundLabel(a)} and ${roundLabel(b)}`))}.`,
        pairs.flatMap(([a, b]) => [a.id, b.id]),
      ),
    );
  }
  const leadless = c.rounds.filter((r) => r.leadCount === 0 && (r.amountUsdMillions ?? 0) >= LEAD_EXPECTED_USD_MILLIONS);
  if (leadless.length > 0) {
    out.push(
      flag(
        "no_lead_large",
        `A round of $50M or more names no lead: ${list(leadless.map(roundLabel))}.`,
        leadless.map((r) => r.id),
      ),
    );
  }
  return out;
}

/** Pairs of dated rounds inside the window whose amounts agree within a tenth of the larger. Pure. */
export function duplicatePairs(rounds: AccuracyRound[]): Array<[AccuracyRound, AccuracyRound]> {
  const dated = rounds
    .filter((r) => r.announcedOn && r.amountUsdMillions !== null && r.amountUsdMillions > 0)
    .sort((a, b) => (a.announcedOn as string).localeCompare(b.announcedOn as string));
  const out: Array<[AccuracyRound, AccuracyRound]> = [];
  for (let i = 0; i < dated.length; i++) {
    for (let j = i + 1; j < dated.length; j++) {
      const a = dated[i];
      const b = dated[j];
      const days = (Date.parse(b.announcedOn as string) - Date.parse(a.announcedOn as string)) / DAY;
      if (days > DUPLICATE_WINDOW_DAYS) break;
      const x = a.amountUsdMillions as number;
      const y = b.amountUsdMillions as number;
      if (Math.abs(x - y) / Math.max(x, y) <= DUPLICATE_AMOUNT_RATIO) out.push([a, b]);
    }
  }
  return out;
}

/** One visible company's size, as the scope reads it. */
export interface CompanySize {
  id: string;
  /** Largest visible round, USD millions. */
  largest: number | null;
  /** Sum of visible rounds, USD millions. */
  total: number | null;
}

/**
 * The companies that matter most: the top N by largest single round, the top N by total raised, and
 * every company with a round of $100M or more. Ordered by largest round, then total, then id, so a
 * remedy cap spends on the biggest names first. Pure.
 */
export function prominentCompanyIds(sizes: CompanySize[], topN: number = ACCURACY_TOP_N): string[] {
  const by = (key: "largest" | "total") =>
    sizes
      .filter((s) => (s[key] ?? 0) > 0)
      .sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0) || a.id.localeCompare(b.id))
      .slice(0, topN)
      .map((s) => s.id);
  const chosen = new Set([
    ...by("largest"),
    ...by("total"),
    ...sizes.filter((s) => (s.largest ?? 0) >= BIG_ROUND_USD_MILLIONS).map((s) => s.id),
  ]);
  return sizes
    .filter((s) => chosen.has(s.id))
    .sort((a, b) => (b.largest ?? 0) - (a.largest ?? 0) || (b.total ?? 0) - (a.total ?? 0) || a.id.localeCompare(b.id))
    .map((s) => s.id);
}

/** A flag as the store keeps it, as far as the reconciliation reads it. */
export interface StoredAccuracyFlag {
  companyId: string;
  rule: string;
  subjects: string[];
  clearedAt: Date | null;
  dismissedAt: Date | null;
  dismissedSubjects: string[] | null;
}

export interface FlagWrite {
  companyId: string;
  flag: AccuracyFlag;
  /** new: first seen (or seen again after it cleared); open: still open; dismissed: still dismissed; reopened: a dismissal that no longer covers it. */
  state: "new" | "open" | "dismissed" | "reopened";
}

export interface FlagPlan {
  writes: FlagWrite[];
  /** Open or dismissed flags whose condition no longer holds: they clear. */
  clears: Array<{ companyId: string; rule: string }>;
}

/**
 * What one run changes: each flag seen now is new, still open, still dismissed, or reopened (a
 * dismissal covers the subjects it was made on, so a new round with the same problem asks again);
 * each open or dismissed flag not seen now clears. A cleared flag seen again later is new. Pure.
 */
export function planFlagChanges(stored: StoredAccuracyFlag[], current: Array<{ companyId: string; flag: AccuracyFlag }>): FlagPlan {
  const key = (companyId: string, rule: string) => `${companyId}\u0000${rule}`;
  const byKey = new Map(stored.map((s) => [key(s.companyId, s.rule), s]));
  const seen = new Set<string>();
  const writes: FlagWrite[] = [];
  for (const c of current) {
    const k = key(c.companyId, c.flag.rule);
    seen.add(k);
    const s = byKey.get(k);
    let state: FlagWrite["state"];
    if (!s || s.clearedAt) state = "new";
    else if (s.dismissedAt) {
      const covered = new Set(s.dismissedSubjects ?? s.subjects);
      state = c.flag.subjects.every((x) => covered.has(x)) ? "dismissed" : "reopened";
    } else state = "open";
    writes.push({ companyId: c.companyId, flag: c.flag, state });
  }
  const clears = stored
    .filter((s) => !s.clearedAt && !seen.has(key(s.companyId, s.rule)))
    .map((s) => ({ companyId: s.companyId, rule: s.rule }));
  return { writes, clears };
}

const SEVERITY_ORDER: Record<AccuracySeverity, number> = { high: 0, medium: 1, low: 2 };

/** Flags most urgent first: severity, then the rule's order above. Pure. */
export function compareFlags(a: { severity: string; rule: string }, b: { severity: string; rule: string }): number {
  return (
    (SEVERITY_ORDER[a.severity as AccuracySeverity] ?? 3) - (SEVERITY_ORDER[b.severity as AccuracySeverity] ?? 3) ||
    ACCURACY_RULES.indexOf(a.rule as AccuracyRule) - ACCURACY_RULES.indexOf(b.rule as AccuracyRule)
  );
}

/** What the check remembers of a company's dossier between runs. */
export interface FounderMemory {
  /** The dossier's check time (or its fetch time when unchecked), ISO: the founders below are that dossier's. */
  dossierAt: string | null;
  founders: string[];
  previousFounders: string[] | null;
}

/**
 * The memory after seeing the current dossier, and the founders to compare it against. The same
 * dossier keeps its comparison (a drop stays flagged until the next dossier); a new one moves the
 * last one's founders into `previousFounders`. Pure.
 */
export function advanceFounderMemory(
  memory: FounderMemory | null,
  dossier: { at: string; founders: string[] },
): { memory: FounderMemory; previous: string[] | null; changed: boolean } {
  if (!memory)
    return { memory: { dossierAt: dossier.at, founders: dossier.founders, previousFounders: null }, previous: null, changed: true };
  if (memory.dossierAt === dossier.at) return { memory, previous: memory.previousFounders, changed: false };
  const next = { dossierAt: dossier.at, founders: dossier.founders, previousFounders: memory.founders };
  return { memory: next, previous: memory.founders, changed: true };
}
