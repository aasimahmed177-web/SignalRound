// Take investors off stored rounds when the round's own verification says the sources do not place
// them in it. Until the reconcile step learned to drop a record investor its lists left out, silence
// kept a seat: Ultraviolette's $85M Series E published with five existing backers as participants
// while its verdict said the sources "do not identify Lingotto, Qualcomm Ventures, Zoho Corporation,
// TVS Motors, or Speciale Invest as investors in this specific round". And persist put a demoted lead
// back as a lead, so rows whose verdict says "not leads: X" still showed X leading. This pass reads
// what the store already holds (the verdict's notes and the investor links), makes no model call and
// no Firecrawl call, and writes only with `apply`. `scripts/maintenance/prune-unsupported-investors.ts` is the command.

import { DEFAULT_TIERS, dedupeInvestorNames, type FeedRecord, hasLeadLanguage, investorMentions, scoreConfidence } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray } from "drizzle-orm";
import { dispositionFor, listRounds, type RoundRow } from "./persist.ts";
import { recordFromRow } from "./reconcile.ts";

const { fundingRounds, investors, roundInvestors } = schema;

/** One investor link as a round holds it. */
export interface InvestorLink {
  investorId: string;
  name: string;
  role: "lead" | "participant" | "unknown";
}

/** What the notes say about one linked investor: off the round, or off the lead list, and the words that say so. */
export interface NotedRejection {
  investorId: string;
  name: string;
  role: InvestorLink["role"];
  action: "remove" | "demote";
  evidence: string;
}

/** The lines applyCorrection writes, one list per line: their names are exact. */
const STRUCTURED: Array<{ prefix: string; action: NotedRejection["action"] }> = [
  { prefix: "not investors in this round:", action: "remove" },
  { prefix: "not supported for this round:", action: "remove" },
  { prefix: "not leads:", action: "demote" },
];

/** Lowercase ASCII words, for whole-word lookups of a name in prose. */
function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

/** The name's display head (before a parenthesis, colon, or spaced dash), folded. */
function foldedHead(name: string): string {
  return fold(name.split(/\s+[\u2013\u2014-]\s+|\s*[:(]\s*/)[0] ?? name).trim();
}

/** Where a name stands in a piece of prose, by its whole head; -1 when absent. */
function positionIn(text: string, name: string): number {
  const head = foldedHead(name);
  if (head.length < 2) return -1;
  return ` ${fold(text)} `.indexOf(` ${head} `);
}

/** Cues that a clause's subject is not in this round at all ("Sherpa Capital and InnoPinnacle Fund are not named as investors in this round"). */
const NOT_IN_ROUND = [
  /\bnot (?:explicitly |specifically |separately )?(?:named |identified |listed |described |stated |mentioned |cited |confirmed |included )?as (?:an? |the )?(?:separate |round |new )*(?:investors?|participants?)\b/i,
  /\bnot (?:as )?participat\w* in (?:this|the) (?:specific )?round\b/i,
  /\bexcluded from (?:the |this )?(?:investor lists?|investors|other_investors|lead_investors|round)\b/i,
  /\brather than (?:as )?an? investor\b/i,
  /\b(?:described|mentioned|named|listed) only as (?:backing|a backer|backers|an existing|existing)\b/i,
];

/** Cues that a clause's subject is not a lead of this round ("identified as lead investors in the continuation vehicle, not explicitly as leads of the Series B"). */
const NOT_A_LEAD = [
  /\bnot (?:explicitly |specifically )?(?:named |identified |described |called |included |listed )?as (?:an? |the )?(?:co-)?leads?\b/i,
  /\b(?:is|are) not (?:an? |the )?(?:co-)?leads?\b/i,
];

/** "do not identify A, B, or C as investors in this specific round": the names between the verb and the role. */
const OBJECT_NOT_IN_ROUND =
  /\bdo(?:es)? not (?:explicitly )?(?:identify|name|list|mention|support|include|cite|confirm|count)\s+(.+?)\s+(?:as (?:an? |the )?(?:separate )?(?:investors?|participants?|backers?)|(?:for|in) (?:this|the) (?:specific )?round)\b/i;

/** "does not explicitly state that Insight Partners led this round". */
const OBJECT_NOT_A_LEAD = /\bdo(?:es)? not (?:explicitly )?(?:state|say) that (.+?)\s+(?:led|co-led)\b/i;

/** "mention ... Anthropic, OpenAI, and Thinking Machines, but do not state that those firms invested": the names before it. */
const BACK_REFERENCE =
  /\bdo(?:es)? not (?:explicitly )?(?:state|say|show) that (?:those|these|the|any of the) (?:firms?|companies|investors?|entities)\s+invested\b/i;

/** An active verb whose object a trailing "not as ..." speaks of ("describe X and Y as existing investors ..., not as participants"). */
const ACTIVE_VERB = /\b(?:describes?|identif(?:y|ies)|names?|lists?|calls?|mentions?|places?|treats?)\b/gi;
/** The auxiliary of a passive subject ("EQT is named as the manager of the fund, not as a separate investor"). */
const AUXILIARY = /\b(?:is|are|was|were)\b/gi;

function lastMatchBefore(re: RegExp, text: string, end: number): { index: number; length: number } | null {
  let last: { index: number; length: number } | null = null;
  for (const m of text.matchAll(re)) {
    if (m.index >= end) break;
    last = { index: m.index, length: m[0].length };
  }
  return last;
}

/**
 * The names a subject-shaped cue speaks of: after the last active verb before it when that verb
 * comes after any auxiliary (the object of "describe X as ..."), else before the auxiliary (the
 * subject of "X is named as ..."), else everything before the cue.
 */
function subjectOf(clause: string, cueAt: number, names: string[]): string[] {
  const aux = lastMatchBefore(AUXILIARY, clause, cueAt);
  const active = lastMatchBefore(ACTIVE_VERB, clause, cueAt);
  let from = 0;
  let to = cueAt;
  if (active && (!aux || active.index > aux.index)) from = active.index + active.length;
  else if (aux) {
    to = aux.index;
    const before = lastMatchBefore(ACTIVE_VERB, clause, aux.index);
    if (before) from = before.index + before.length;
  }
  const span = clause.slice(from, to);
  return names.filter((n) => positionIn(span, n) >= 0);
}

/** Prose split into sentences, then into clauses at a contrast or a consequence. */
function clausesOf(note: string): Array<{ sentence: string; clauses: string[] }> {
  return note.split(/(?<=[.;!?])\s+/).map((sentence) => ({
    sentence,
    clauses: sentence
      .split(/,\s*(?:but|while|whereas|so|although|though)\s+|;\s*|\s+but\s+/i)
      .map((c) => c.trim())
      .filter(Boolean),
  }));
}

/**
 * The names a free-text verdict note says are not in this round (remove) or did not lead it
 * (demote), each with the sentence that says so. Deliberately narrow: a note that disagrees about a
 * spelling ("names Scale AI, not Scale Venture Partners") or about a figure is not read as an
 * investor verdict, and a name counts only when its whole head appears in the clause.
 */
function remarkRejections(note: string, names: string[]): Array<{ name: string; action: NotedRejection["action"]; evidence: string }> {
  const out: Array<{ name: string; action: NotedRejection["action"]; evidence: string }> = [];
  for (const { sentence, clauses } of clausesOf(note)) {
    clauses.forEach((clause, i) => {
      const inClause = names.filter((n) => positionIn(clause, n) >= 0);
      const push = (hit: string[], action: NotedRejection["action"]) => {
        for (const name of hit) out.push({ name, action, evidence: sentence });
      };
      const object = OBJECT_NOT_IN_ROUND.exec(clause);
      if (object?.[1])
        push(
          names.filter((n) => positionIn(object[1] ?? "", n) >= 0),
          "remove",
        );
      const objectLead = OBJECT_NOT_A_LEAD.exec(clause);
      if (objectLead?.[1])
        push(
          names.filter((n) => positionIn(objectLead[1] ?? "", n) >= 0),
          "demote",
        );
      if (BACK_REFERENCE.test(clause) && i > 0)
        push(
          names.filter((n) => positionIn(clauses[i - 1] ?? "", n) >= 0),
          "remove",
        );
      for (const [cues, action] of [
        [NOT_IN_ROUND, "remove"],
        [NOT_A_LEAD, "demote"],
      ] as const) {
        for (const cue of cues) {
          const m = cue.exec(clause);
          if (!m) continue;
          if (inClause.length > 0) push(subjectOf(clause, m.index, inClause), action);
          else if (i > 0 && /^(?:but\s+)?not\b/i.test(clause)) {
            // "Sovereign AI venture fund is mentioned as a backer, but not explicitly as an investor in this round."
            const prev = clauses[i - 1] ?? "";
            push(
              subjectOf(
                prev,
                prev.length,
                names.filter((n) => positionIn(prev, n) >= 0),
              ),
              action,
            );
          }
        }
      }
    });
  }
  return out;
}

function sameFirm(a: string, b: string): boolean {
  return dedupeInvestorNames([a, b]).length === 1;
}

/**
 * What a round's verification notes say about its linked investors. The structured lines the
 * applier writes ("not investors in this round: A, B", "not supported for this round: A",
 * "not leads: C") name exactly; the verdict's own remark is read narrowly (remarkRejections). A
 * removal outranks a demotion, a demotion applies only to a link that is a lead, and a firm the
 * verdict itself made a lead ("leads: Mercury Fund (prnewswire.com)") is never touched by its
 * remark: Venus Aerospace's remark calls the record's "Mercury" unsupported only for its spelling.
 */
export function notedRejections(notes: string[], links: InvestorLink[]): NotedRejection[] {
  const found = new Map<string, NotedRejection>();
  const affirmed = notes
    .filter((line) => line.startsWith("leads: "))
    .flatMap((line) => line.slice("leads: ".length).split(/,\s+/))
    .map((n) => n.replace(/\s*\([^)]*\)\s*$/, "").trim())
    .filter(Boolean);
  const note = (link: InvestorLink, action: NotedRejection["action"], evidence: string) => {
    if (action === "demote" && link.role !== "lead") return;
    if (affirmed.some((n) => sameFirm(n, link.name)) && !STRUCTURED.some((s) => evidence.startsWith(s.prefix))) return;
    const prior = found.get(link.investorId);
    if (prior && (prior.action === "remove" || action === "demote")) return;
    found.set(link.investorId, { investorId: link.investorId, name: link.name, role: link.role, action, evidence });
  };
  for (const line of notes) {
    const structured = STRUCTURED.find((s) => line.startsWith(s.prefix));
    if (structured) {
      const listed = line
        .slice(structured.prefix.length)
        .split(/,\s+/)
        .map((n) => n.trim())
        .filter(Boolean);
      for (const link of links) if (listed.some((n) => sameFirm(n, link.name))) note(link, structured.action, line);
      continue;
    }
    // Other applier lines ("date ... read as ...", "leads: X (host)", "amount ...") state no rejection.
    if (/^(?:date|amount|stage|leads|headquarters|the page|reported):?\s/i.test(line)) continue;
    for (const r of remarkRejections(
      line,
      links.map((l) => l.name),
    )) {
      const link = links.find((l) => l.name === r.name);
      if (link) note(link, r.action, r.evidence);
    }
  }
  return [...found.values()];
}

/** One round the pass would change: the links it takes off, the leads it clears, and the row after. */
export interface InvestorPrune {
  roundId: string;
  company: string;
  disposition: RoundRow["disposition"];
  verification: string | null;
  removals: NotedRejection[];
  demotions: NotedRejection[];
  /** Rejections the remark made that the row's own evidence overrules: printed, never applied. */
  kept: NotedRejection[];
  sources: Array<{ title: string | null; url: string }>;
  confidence: { before: number; after: number };
  nextDisposition: RoundRow["disposition"];
}

/**
 * Where a row goes once its investors are corrected: a reviewer's reject stands; a published row
 * that published on its score and no longer does (a cleared lead lowers it) drops to flagged, as a
 * row with a cleared amount does (ungroundAmounts), while one published below the line (a reviewer's
 * word) stays; the machine's states follow dispositionFor.
 */
function nextDispositionFor(row: RoundRow, confidence: number): RoundRow["disposition"] {
  if (row.disposition === "rejected") return "rejected";
  const at = (c: number) =>
    dispositionFor({
      undated: row.announced_on === null,
      confidence: c,
      amount: { as_written: row.amount.as_written },
      verification: (row.verification as FeedRecord["verification"]) ?? undefined,
    });
  if (row.disposition === "publish") return at(row.confidence) === "publish" && at(confidence) !== "publish" ? "flagged" : "publish";
  return at(confidence);
}

export interface PruneInvestorsSummary {
  /** Rounds whose verification notes were read. */
  checked: number;
  prunes: InvestorPrune[];
  /** Rounds whose only rejections the row's evidence overrules: printed for an operator, left alone. */
  held: InvestorPrune[];
  removed: { lead: number; participant: number };
  demoted: number;
  applied: boolean;
}

/**
 * Read every verified round's notes against its investor links and, with `apply`, take off what
 * the notes reject: removed links go, cleared leads become participants, the verification gains the
 * applier's own lines for what changed (a confirmed row becomes corrected), and the row is rescored.
 * Idempotent: a removed link is gone and a cleared lead is no longer a lead, so a second run finds
 * nothing. `roundIds` limits the pass to those rows.
 */
export async function pruneUnsupportedInvestors(
  handle: Db,
  opts: { apply?: boolean; tiers?: Record<string, number>; roundIds?: string[] } = {},
): Promise<PruneInvestorsSummary> {
  const tiers = { ...DEFAULT_TIERS, ...(opts.tiers ?? {}) };
  const summary: PruneInvestorsSummary = {
    checked: 0,
    prunes: [],
    held: [],
    removed: { lead: 0, participant: 0 },
    demoted: 0,
    applied: Boolean(opts.apply),
  };
  const rows: RoundRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await listRounds(handle, { includeReview: true, limit: 200, cursor, ids: opts.roundIds });
    rows.push(...page.rows);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const verified = rows.filter((r) => (r.verification?.notes.length ?? 0) > 0);
  summary.checked = verified.length;
  if (verified.length === 0) return summary;

  const links = await handle
    .select({ roundId: roundInvestors.roundId, investorId: roundInvestors.investorId, role: roundInvestors.role, name: investors.name })
    .from(roundInvestors)
    .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
    .where(
      inArray(
        roundInvestors.roundId,
        verified.map((r) => r.id),
      ),
    );
  const byRound = new Map<string, InvestorLink[]>();
  for (const l of links)
    byRound.set(l.roundId, [...(byRound.get(l.roundId) ?? []), { investorId: l.investorId, name: l.name, role: l.role }]);

  for (const row of verified) {
    const held = byRound.get(row.id) ?? [];
    const noted = notedRejections(row.verification?.notes ?? [], held);
    // A rejection read off the remark yields to the row's own evidence: a quote or a source title that
    // names the firm keeps it on the round, and one that names it with lead language keeps it leading
    // (Kastle's remark doubts Insight Partners led while PR Newswire's headline says "Led by Insight
    // Partners"). The applier's structured lines are the verdict's exact word and stand.
    const evidence = [...row.evidence_quotes, ...row.sources.map((s) => s.title ?? "")].filter(Boolean);
    const named = evidence.map((line) => ({ line, mentions: investorMentions(line), lead: hasLeadLanguage(line) }));
    const kept: NotedRejection[] = [];
    const rejections = noted.filter((r) => {
      if (STRUCTURED.some((x) => r.evidence.startsWith(x.prefix))) return true;
      const standsOn = named.some((e) => e.mentions(r.name) && (r.action === "remove" || e.lead));
      if (standsOn) kept.push(r);
      return !standsOn;
    });
    if (rejections.length === 0 && kept.length === 0) continue;
    const removals = rejections.filter((r) => r.action === "remove");
    const demotions = rejections.filter((r) => r.action === "demote");
    const gone = new Set(removals.map((r) => r.investorId));
    const cleared = new Set(demotions.map((r) => r.investorId));
    const after = held.filter((l) => !gone.has(l.investorId));
    // Rescored by the investors' own effect alone (a lead's presence is part of the score): the score's
    // other inputs moved since the row was scored, and this pass corrects investors, nothing else.
    const record = recordFromRow(row);
    record.lead_investors = held.filter((l) => l.role === "lead").map((l) => l.name);
    record.other_investors = held.filter((l) => l.role !== "lead").map((l) => l.name);
    const scoreBefore = scoreConfidence(record, tiers);
    record.lead_investors = after.filter((l) => l.role === "lead" && !cleared.has(l.investorId)).map((l) => l.name);
    record.other_investors = after.filter((l) => l.role !== "lead" || cleared.has(l.investorId)).map((l) => l.name);
    const confidence = Math.min(1, Math.max(0, Math.round((row.confidence + scoreConfidence(record, tiers) - scoreBefore) * 100) / 100));
    const prune: InvestorPrune = {
      roundId: row.id,
      company: row.company.name,
      disposition: row.disposition,
      verification: row.verification?.status ?? null,
      removals,
      demotions,
      kept,
      sources: row.sources.map((s) => ({ title: s.title, url: s.url })),
      confidence: { before: row.confidence, after: confidence },
      nextDisposition: nextDispositionFor(row, confidence),
    };
    if (removals.length + demotions.length === 0) {
      summary.held.push(prune);
      continue;
    }
    summary.prunes.push(prune);
    for (const r of removals) {
      if (r.role === "lead") summary.removed.lead++;
      else summary.removed.participant++;
    }
    summary.demoted += demotions.length;
    if (!opts.apply) continue;

    for (const r of removals)
      await handle.delete(roundInvestors).where(and(eq(roundInvestors.roundId, row.id), eq(roundInvestors.investorId, r.investorId)));
    for (const r of demotions)
      await handle
        .update(roundInvestors)
        .set({ role: "participant" })
        .where(and(eq(roundInvestors.roundId, row.id), eq(roundInvestors.investorId, r.investorId)));
    // A rejection read off the verdict's remark gains the applier's own line; one already on a
    // structured line is not written twice.
    const current = row.verification ?? { status: "unverified", notes: [], url: null };
    const fromRemark = (r: NotedRejection) => !STRUCTURED.some((s) => r.evidence.startsWith(s.prefix));
    const newRemovals = removals.filter(fromRemark).map((r) => r.name);
    const newDemotions = demotions.filter(fromRemark).map((r) => r.name);
    const lines = [
      ...(newRemovals.length ? [`not supported for this round: ${newRemovals.join(", ")}`] : []),
      ...(newDemotions.length ? [`not leads: ${newDemotions.join(", ")}`] : []),
    ];
    await handle
      .update(fundingRounds)
      .set({
        verification: {
          ...current,
          status: current.status === "confirmed" ? "corrected" : current.status,
          notes: [...lines, ...current.notes],
        },
        confidence: confidence.toFixed(2),
        disposition: prune.nextDisposition,
        updatedAt: new Date(),
      })
      .where(eq(fundingRounds.id, row.id));
  }
  return summary;
}

/** The dry run's lines for one round, the evidence under each change. No en or em dash: an operator reads it. */
export function describeInvestorPrune(p: InvestorPrune): string[] {
  const lines = [
    `${p.roundId}  (${p.company}, ${p.disposition}, verification ${p.verification ?? "none"}, confidence ${p.confidence.before.toFixed(2)} to ${p.confidence.after.toFixed(2)}${p.nextDisposition !== p.disposition ? `, ${p.disposition} to ${p.nextDisposition}` : ""})`,
  ];
  for (const r of p.removals) lines.push(`  remove ${r.role === "lead" ? "lead" : r.role} ${r.name}: "${r.evidence}"`);
  for (const r of p.demotions) lines.push(`  clear lead ${r.name} (stays a participant): "${r.evidence}"`);
  for (const r of p.kept) lines.push(`  keep ${r.name}: the row's own quote or source title names it; the remark said "${r.evidence}"`);
  for (const s of p.sources) lines.push(`  source: ${s.title ?? "untitled"} <${s.url}>`);
  return lines;
}
