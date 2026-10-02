// Take sources off stored rounds when the page is not about the round: the stored-data half of the
// source rule (sourceFit in core), for rows written before every lane asked it. A job posting, a front
// page, a search or tag page, a directory entry, and an aggregator's other story go on what the link
// already holds. A page whose title, URL, and stored evidence never name the company (a roundup, a
// newsletter) is read once when the caller supplies a reader: it stays when a sentence on it names the
// company and speaks of money, and that sentence is written onto the link so the next run needs no read;
// it goes when the page never names the company. A round's last source never goes: the round is held
// for a reviewer instead. `scripts/maintenance/prune-unrelated-sources.ts` is the command.

import type { SourceFitReason } from "@fireround/core";
import { sourceFit, textNamesSubject } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, sql } from "drizzle-orm";

const { companies, companyAliases, fundingRounds, sources, roundSources } = schema;

/** One link as the store holds it, with what the reading that attached it remembered. */
export interface AuditLink {
  sourceId: string;
  url: string;
  /** The source row's title, which the first round to link the page wrote. */
  title: string | null;
  /** The link's own claims: `{ evidence, title }` from the reading that attached it, when it was recorded. */
  claims: Record<string, unknown> | null;
}

/** A round as the audit sees it: whose it is and how much it was, which decide what may be its source. */
export interface AuditRound {
  roundId: string;
  company: { name: string; domain: string | null; aliases: string[] };
  amountValue: number | null;
  amountCurrency: string | null;
  disposition: string;
  links: AuditLink[];
}

/** Why a link goes: the rule's reason on stored data, or the page read and found never to name the company. */
export type DetachReason = SourceFitReason | "page_never_names_company";

export type LinkVerdict =
  | { action: "keep"; sourceId: string; url: string; evidence?: string }
  | { action: "detach"; sourceId: string; url: string; title: string | null; reason: DetachReason }
  /** Left alone for a person: nothing stored names the company and the page read cannot settle it (see readVerdict). */
  | { action: "unverified"; sourceId: string; url: string; title: string | null; note: UnverifiedNote };

/** Why a page read left a link alone: not read, too short to judge, in another script, or naming the company without a figure. */
export type UnverifiedNote = "unread" | "too_short" | "other_script" | "named_without_figure";

export interface RoundAudit {
  roundId: string;
  company: string;
  disposition: string;
  links: number;
  /** Links that go, with the reason. Empty when the round is held. */
  detach: Extract<LinkVerdict, { action: "detach" }>[];
  /** Links kept because the page read names the company; the sentence is written onto the link. */
  evidenced: Array<{ sourceId: string; url: string; evidence: string }>;
  unverified: Extract<LinkVerdict, { action: "unverified" }>[];
  /** Every link would go: nothing is detached, and the round is listed for a reviewer with what would have gone. */
  held: Extract<LinkVerdict, { action: "detach" }>[];
}

/** A page's text for the audit, or null when it cannot be read (gone, blocked, a timeline post). */
export type PageReader = (url: string) => Promise<string | null>;

const MONEY_WORDS =
  /\b(?:rais(?:e|es|ed|ing)|fund(?:ing|ed|raise)?|round|series [a-h]\d?\b|seed|pre-seed|invest(?:s|ed|ment|ors?)?|backed|led by|million|billion|valuation|crore|lakh)\b|(?:[$€£¥₹]|\bRs\.?|\bINR)\s?\d|\d\s?(?:m|mn|bn|b)\b/i;
const MAX_EVIDENCE = 400;
/** How many lines under a line that names the company may hold its figure: a roundup's entry is a heading, then "Funding: $12 million". */
const ENTRY_LINES = 3;
/** An entry's figure line opens with its field or its figure ("Funding: ...", "$12 million ..."), not with another company's name. */
const ENTRY_FIGURE =
  /^(?:funding|amount|round|raised|raise|investment|deal|stage|series|seed|pre-seed|valuation|[$€£¥₹]|rs\.?\s|inr|us\$|\d)/i;
/**
 * A page read shorter than this is a paywall's teaser, a consent wall, or an error page: it cannot show
 * that the company is absent, so the link stays unverified rather than going.
 */
const MIN_PAGE_TEXT = 1200;
/** Past this share of letters outside the Latin script, a page may name the company in its own script (Wrtn as リートン). */
const FOREIGN_SCRIPT_SHARE = 0.2;

/** A page's markdown as plain lines: images gone, links read as their text, emphasis and table rules dropped. */
function pageLines(text: string): string[] {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|]+/g, " ")
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function clip(s: string): string {
  return s.length > MAX_EVIDENCE ? `${s.slice(0, MAX_EVIDENCE - 1)}…` : s;
}

/**
 * The first place on a page that names the company and speaks of money: a sentence holding both, or a
 * roundup entry whose heading names the company and whose next lines state the figure ("Medulance",
 * then "Funding: Rs 24 crore, Series A2"). What a roundup must hold to be a source for one of its
 * rounds; a sidebar headline or a list of names without a figure does not count. Pure.
 */
export function evidenceOnPage(text: string, company: AuditRound["company"]): string | null {
  const lines = pageLines(text);
  for (const [i, line] of lines.entries()) {
    if (!textNamesSubject(line, company)) continue;
    for (const sentence of line.split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)) {
      if (sentence.length >= 12 && MONEY_WORDS.test(sentence) && textNamesSubject(sentence, company)) return clip(sentence);
    }
    // A heading-sized line (the entry's name) followed by its figure.
    if (line.length > 80) continue;
    const figure = lines.slice(i + 1, i + 1 + ENTRY_LINES).find((l) => ENTRY_FIGURE.test(l) && MONEY_WORDS.test(l));
    if (figure) return clip(`${line}: ${figure}`);
  }
  return null;
}

/** Whether a page is written largely outside the Latin script, where a Latin name proves nothing by its absence. */
function foreignScript(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return false;
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  return 1 - latin / letters.length > FOREIGN_SCRIPT_SHARE;
}

/**
 * What a page read says about a link: kept with the sentence that ties the company to money; unverified
 * when the page cannot show absence (unread, a teaser, another script) or names the company without a
 * figure (an interview, a profile); gone only when a full page never names the company at all.
 */
export function readVerdict(
  text: string | null,
  company: AuditRound["company"],
): { keep: string } | { unverified: UnverifiedNote } | { detach: true } {
  if (text === null) return { unverified: "unread" };
  const evidence = evidenceOnPage(text, company);
  if (evidence) return { keep: evidence };
  if (textNamesSubject(pageLines(text).join(" "), company)) return { unverified: "named_without_figure" };
  if (text.trim().length < MIN_PAGE_TEXT) return { unverified: "too_short" };
  if (foreignScript(text)) return { unverified: "other_script" };
  return { detach: true };
}

/** The evidence and the title a link carried when it was attached, if the store recorded them. */
function linkClaims(link: AuditLink): { evidence: string | null; title: string | null } {
  const c = link.claims ?? {};
  return {
    evidence: typeof c.evidence === "string" ? c.evidence : null,
    title: typeof c.title === "string" ? c.title : null,
  };
}

/**
 * The verdict on one round's links. Stored data first: a link sourceFit attaches stays; a job posting,
 * a non-article page, or an aggregator's other story goes. A link that fails only because nothing
 * stored names the company is read through `readPage` when given: kept with the sentence that ties
 * the company to money, dropped when a full page never names it, unverified otherwise (readVerdict).
 * When every link would go, none does and the round is held.
 */
export async function auditRound(round: AuditRound, readPage?: PageReader): Promise<RoundAudit> {
  const subject = round.company;
  const amount = { amountValue: round.amountValue, amountCurrency: round.amountCurrency };
  const verdicts: LinkVerdict[] = [];
  for (const link of round.links) {
    const claims = linkClaims(link);
    // The title the link was read under outranks the shared row's, which the first round to find the page wrote.
    const title = claims.title ?? link.title;
    const fit = sourceFit({ url: link.url, title, evidence: claims.evidence }, subject, amount);
    if (fit.attach) {
      verdicts.push({ action: "keep", sourceId: link.sourceId, url: link.url });
      continue;
    }
    if (fit.reason !== "not_about_company") {
      verdicts.push({ action: "detach", sourceId: link.sourceId, url: link.url, title: link.title, reason: fit.reason });
      continue;
    }
    const read = readVerdict(readPage ? await readPage(link.url) : null, subject);
    if ("keep" in read) verdicts.push({ action: "keep", sourceId: link.sourceId, url: link.url, evidence: read.keep });
    else if ("unverified" in read)
      verdicts.push({ action: "unverified", sourceId: link.sourceId, url: link.url, title: link.title, note: read.unverified });
    else verdicts.push({ action: "detach", sourceId: link.sourceId, url: link.url, title: link.title, reason: "page_never_names_company" });
  }
  const detach = verdicts.filter((v): v is Extract<LinkVerdict, { action: "detach" }> => v.action === "detach");
  const staying = verdicts.length - detach.length;
  return {
    roundId: round.roundId,
    company: subject.name,
    disposition: round.disposition,
    links: round.links.length,
    detach: staying > 0 ? detach : [],
    held: staying > 0 ? [] : detach,
    evidenced: verdicts.flatMap((v) =>
      v.action === "keep" && v.evidence ? [{ sourceId: v.sourceId, url: v.url, evidence: v.evidence }] : [],
    ),
    unverified: verdicts.filter((v): v is Extract<LinkVerdict, { action: "unverified" }> => v.action === "unverified"),
  };
}

export interface PruneSourcesSummary {
  rounds: number;
  links: number;
  audits: RoundAudit[];
  /** Detached (or, in a dry run, to be detached) links by reason. */
  byReason: Record<string, number>;
  /** Source rows the detaches leave linked to no round, which go with them. */
  orphans: number;
}

/** Every round's links with the company, its other names, and the amount, as the audit reads them. */
export async function loadAuditRounds(handle: Db, roundIds?: string[]): Promise<AuditRound[]> {
  const rows = await handle
    .select({
      roundId: roundSources.roundId,
      sourceId: sources.id,
      url: sources.url,
      title: sources.title,
      claims: roundSources.fieldClaims,
      companyId: companies.id,
      name: companies.name,
      domain: companies.domain,
      amountValue: fundingRounds.amountValue,
      amountCurrency: fundingRounds.amountCurrency,
      disposition: fundingRounds.disposition,
    })
    .from(roundSources)
    .innerJoin(sources, eq(sources.id, roundSources.sourceId))
    .innerJoin(fundingRounds, eq(fundingRounds.id, roundSources.roundId))
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    .where(roundIds?.length ? inArray(roundSources.roundId, roundIds) : undefined)
    .orderBy(roundSources.roundId, sources.id);
  const aliasRows = await handle
    .select({ companyId: companyAliases.companyId, alias: companyAliases.alias })
    .from(companyAliases)
    .where(eq(companyAliases.kind, "name"));
  const aliases = new Map<string, string[]>();
  for (const a of aliasRows) aliases.set(a.companyId, [...(aliases.get(a.companyId) ?? []), a.alias]);

  const byRound = new Map<string, AuditRound>();
  for (const r of rows) {
    const round = byRound.get(r.roundId) ?? {
      roundId: r.roundId,
      company: { name: r.name, domain: r.domain, aliases: aliases.get(r.companyId) ?? [] },
      amountValue: r.amountValue === null ? null : Number(r.amountValue),
      amountCurrency: r.amountCurrency,
      disposition: r.disposition,
      links: [],
    };
    round.links.push({ sourceId: r.sourceId, url: r.url, title: r.title, claims: r.claims ?? null });
    byRound.set(r.roundId, round);
  }
  return [...byRound.values()];
}

/**
 * The repair behind `pnpm prune-unrelated-sources`. Without `apply` it only reads (and reads pages
 * through `readPage` when given). With `apply` each round's detaches and evidence writes land in one
 * transaction, then source rows linked to no round go. Idempotent: a detached link is gone, and a link
 * kept on its page's sentence carries that sentence, so a second run finds nothing and reads nothing.
 */
export async function pruneUnrelatedSources(
  handle: Db,
  opts: { apply?: boolean; roundIds?: string[]; readPage?: PageReader } = {},
): Promise<PruneSourcesSummary> {
  const rounds = await loadAuditRounds(handle, opts.roundIds);
  const summary: PruneSourcesSummary = { rounds: rounds.length, links: 0, audits: [], byReason: {}, orphans: 0 };
  const titleOf = new Map<string, string | null>();
  for (const round of rounds) {
    summary.links += round.links.length;
    for (const l of round.links) titleOf.set(`${round.roundId}\u0000${l.sourceId}`, linkClaims(l).title ?? l.title);
    const audit = await auditRound(round, opts.readPage);
    if (audit.detach.length || audit.held.length || audit.evidenced.length || audit.unverified.length) summary.audits.push(audit);
    for (const d of audit.detach) summary.byReason[d.reason] = (summary.byReason[d.reason] ?? 0) + 1;
  }

  const detachedIds = [...new Set(summary.audits.flatMap((a) => a.detach.map((d) => d.sourceId)))];
  if (!opts.apply) {
    if (detachedIds.length === 0) return summary;
    // What the detaches would orphan: sources every one of whose links is on the list.
    const linkCounts = await handle
      .select({ sourceId: roundSources.sourceId, n: sql<number>`count(*)::int` })
      .from(roundSources)
      .where(inArray(roundSources.sourceId, detachedIds))
      .groupBy(roundSources.sourceId);
    const perSource = new Map<string, number>();
    for (const a of summary.audits) for (const d of a.detach) perSource.set(d.sourceId, (perSource.get(d.sourceId) ?? 0) + 1);
    summary.orphans = linkCounts.filter((c) => (perSource.get(c.sourceId) ?? 0) >= c.n).length;
    return summary;
  }

  for (const audit of summary.audits) {
    if (audit.detach.length === 0 && audit.evidenced.length === 0) continue;
    await handle.transaction(async (tx) => {
      for (const d of audit.detach)
        await tx.delete(roundSources).where(and(eq(roundSources.roundId, audit.roundId), eq(roundSources.sourceId, d.sourceId)));
      for (const e of audit.evidenced)
        await tx
          .update(roundSources)
          .set({ fieldClaims: { evidence: e.evidence, title: titleOf.get(`${audit.roundId}\u0000${e.sourceId}`) ?? null } })
          .where(and(eq(roundSources.roundId, audit.roundId), eq(roundSources.sourceId, e.sourceId)));
    });
  }
  if (detachedIds.length) {
    const orphaned = await handle
      .delete(sources)
      .where(and(inArray(sources.id, detachedIds), sql`not exists (select 1 from ${roundSources} rs where rs.source_id = ${sources.id})`))
      .returning({ id: sources.id });
    summary.orphans = orphaned.length;
  }
  return summary;
}

/** A round's audit as the operator reads it: each link that goes and why, what is held, what was read. */
export function describeSourcePrune(a: RoundAudit, apply: boolean): string[] {
  const lines: string[] = [];
  const head = `${a.roundId}  (${a.company}, ${a.disposition}, ${a.links} source${a.links === 1 ? "" : "s"})`;
  for (const d of a.detach)
    lines.push(`${apply ? "detached" : "would detach"}  ${head}  x  ${d.url}  [${d.reason}]  ${JSON.stringify(d.title)}`);
  for (const d of a.held) lines.push(`held for review  ${head}  last source kept  ${d.url}  [${d.reason}]  ${JSON.stringify(d.title)}`);
  for (const u of a.unverified) lines.push(`unverified  ${head}  ${u.url}  [${u.note}]  ${JSON.stringify(u.title)}`);
  for (const e of a.evidenced)
    lines.push(`${apply ? "evidenced" : "would evidence"}  ${head}  ${e.url}  ${JSON.stringify(e.evidence.slice(0, 140))}`);
  return lines;
}
