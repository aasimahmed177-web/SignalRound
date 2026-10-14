// Maintenance passes for a store built before the current rules. The persist path (lib/persist.ts)
// applies every rule to new data; these apply the same rules to what is already stored, so a rule
// that improved after the store was built reaches old rows. `pnpm merge-duplicates` and
// `pnpm reset-data` are the commands (scripts/maintenance/merge-duplicates.ts, scripts/maintenance/reset-data.ts);
// lib/prune-corroboration.ts is the same shape, kept apart because its rule and SQL are its own.

import type { FeedRecord, RoundCertainty, Sector, Stage } from "@fireround/core";
import {
  amountInEvidence,
  canonicalUrl,
  hostOf,
  investorKeyForMerge,
  isArticleUrl,
  isDirectoryTitle,
  isTableRowQuote,
  MONTHLY_LIST,
  normalizeCompanyKey,
  normalizeInvestorName,
  normalizeSector,
  parseAmount,
  priorKey,
  promotable,
  reconcileInvestorLists,
  registrableDomain,
  SECTORS,
  settleDate,
  WEEKLY_LIST,
  wireReleaseDay,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import type { HistoryPrior } from "@fireround/core/db/schema";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { recordInvestorFold } from "./investor-repair.ts";
import {
  applyRoundMerge,
  dispositionFor,
  findDuplicateRounds,
  isDuplicateRound,
  listRounds,
  type MergeRow,
  mergeCompanies,
  mergeDuplicateRounds,
  neverLater,
  planRoundInvestors,
  planRoundMerge,
  type RoundMerge,
  type RoundRow,
  roundsForMerge,
  setDisposition,
  survivorOrder,
  syncRoundInvestors,
} from "./persist.ts";
import { loadPublisherTiers } from "./rules.ts";

const { companies, companyAliases, fundingRounds, historyPromotions, investors, roundInvestors, sources, roundSources, enrichments } =
  schema;

/**
 * Re-key investors under normalizeInvestorKey so spellings of one firm ("Arm", "Arm Holdings")
 * share a row: links move to the canonical id, the longer name is kept, the old row goes.
 * Run after a rule change; new writes already use the key.
 */
export async function rekeyInvestors(handle: Db): Promise<{ merged: number }> {
  const rows = await handle.select().from(investors);
  let merged = 0;
  for (const inv of rows) {
    const key = investorKeyForMerge(inv.name);
    if (!key || key === inv.id) continue;
    await handle
      .insert(investors)
      .values({ id: key, name: inv.name, domain: inv.domain })
      .onConflictDoUpdate({
        target: investors.id,
        set: {
          name: sql`CASE WHEN length(excluded.name) > length(${investors.name}) THEN excluded.name ELSE ${investors.name} END`,
          domain: sql`COALESCE(${investors.domain}, excluded.domain)`,
        },
      });
    await handle.execute(
      sql`insert into round_investors (round_id, investor_id, role) select round_id, ${key}, role from round_investors where investor_id = ${inv.id} on conflict do nothing`,
    );
    await handle.delete(roundInvestors).where(eq(roundInvestors.investorId, inv.id));
    await handle.delete(investors).where(eq(investors.id, inv.id));
    await recordInvestorFold(handle, inv.id, key);
    merged++;
  }
  return { merged };
}

/**
 * Sources whose URLs canonicalize to the same page (one with tracking parameters, one without)
 * fold into the row with the canonical id: links move over, the duplicate goes.
 */
export async function mergeDuplicateSources(handle: Db): Promise<{ merged: number }> {
  const rows = await handle
    .select({ id: sources.id, url: sources.url, title: sources.title, publishedAt: sources.publishedAt })
    .from(sources);
  let merged = 0;
  const byCanonical = new Map<string, (typeof rows)[number]>();
  for (const s of rows) {
    const key = canonicalUrl(s.url);
    const keep = byCanonical.get(key);
    if (!keep) {
      byCanonical.set(key, s);
      continue;
    }
    // Prefer the row already keyed by the canonical URL; otherwise the first seen.
    const [into, from] = s.id === key ? [s, keep] : [keep, s];
    byCanonical.set(key, into);
    await handle.execute(
      sql`insert into round_sources (round_id, source_id, field_claims) select round_id, ${into.id}, field_claims from round_sources where source_id = ${from.id} on conflict do nothing`,
    );
    await handle.delete(roundSources).where(eq(roundSources.sourceId, from.id));
    await handle
      .update(sources)
      .set({
        url: into.id,
        title: sql`coalesce(${sources.title}, ${from.title})`,
        publishedAt: sql`coalesce(${sources.publishedAt}, ${from.publishedAt})`,
      })
      .where(eq(sources.id, into.id));
    await handle.delete(sources).where(eq(sources.id, from.id));
    merged++;
  }
  return { merged };
}

/** A round as one line of a merge plan. */
function roundLine(r: MergeRow): string {
  const amount = r.amountAsWritten ?? "no amount";
  const day = r.announcedOn ? `${r.announcedOn} (${r.datePrecision}, ${r.dateBasis ?? "basis unknown"})` : "undated";
  const company = `${r.companyName} [company ${r.companyId}${r.domain ? `, ${r.domain}` : ", no domain"}]`;
  return `${r.id}: ${company}, ${r.stage} "${r.stageAsWritten}", ${amount}, ${day}, ${r.disposition}/${r.status}, confidence ${r.confidence.toFixed(2)}, ${r.verificationStatus ?? "unverified"}, ${r.sourceIds.length} source(s), first seen ${r.firstSeenAt.toISOString()}`;
}

/** A value in a plan line: dates as ISO, lists by length, text as written. */
function planValue(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return `${v.length} item(s)`;
  return v === null || v === undefined ? "null" : String(v);
}

/** A planned merge as the operator reads it before saying yes: what survives, what moves, what changes, what goes. */
export function describeRoundMerge(m: RoundMerge): string[] {
  const lines = [`merge ${m.dup.id} into ${m.keep.id} (${m.match ? `rule: ${m.match} company` : "forced"})`];
  lines.push(`  keep: ${roundLine(m.keep)}`);
  lines.push(`  drop: ${roundLine(m.dup)}`);
  if (m.company) {
    const from = m.company.from === m.keep.companyId ? m.keep : m.dup;
    const into = m.company.into === m.keep.companyId ? m.keep : m.dup;
    const name = from.companyName.length > into.companyName.length ? from.companyName : into.companyName;
    lines.push(
      `  company: fold "${m.company.from}" into "${m.company.into}" (every round of "${m.company.from}" moves; name becomes "${name}"; key "${from.nameKey}" kept as an alias${!into.domain && from.domain ? `; domain ${from.domain} moves over` : ""})`,
    );
    lines.push(
      `  enrichments: move ${m.enrichments.moved.join(", ") || "none"}; drop ${m.enrichments.dropped.join(", ") || "none"} (the survivor has its own)`,
    );
  } else if (m.keep.companyId !== m.dup.companyId) {
    lines.push(`  company: two domains, two companies that share a name; only the round moves, both company rows stay`);
  }
  lines.push(`  sources gained: ${m.sources.length}${m.sources.map((s) => `\n    + ${s}`).join("")}`);
  lines.push(`  investor links gained: ${m.investors.length ? m.investors.map((i) => `${i.name} (${i.role})`).join(", ") : "none"}`);
  lines.push(`  deliveries repointed: ${m.deliveries}`);
  const changes = Object.entries(m.set).map(([k, v]) => `${k} = ${planValue(v)}`);
  lines.push(`  survivor fields: ${changes.length ? changes.join("; ") : "unchanged"}`);
  lines.push(`  delete: funding_rounds ${m.dup.id} (its round_sources, round_investors, and deliveries rows go with it)`);
  lines.push(`  tombstone: round_merges ${m.dup.id} -> ${m.keep.id} (a later reading of the dropped id lands on the survivor)`);
  return lines;
}

export interface MergeRoundPairsOptions {
  /** Write. Without it nothing is written: every step only reads. */
  apply: boolean;
  /** Only these pairs, in either order; the survivor is chosen the same way as for a found pair. */
  pairs?: Array<[string, string]>;
  /** Merge a named pair even when the rule does not call it one round, or one side is rejected. */
  force?: boolean;
}

/**
 * The duplicate-round repair behind `pnpm merge-duplicate-rounds`: every pair the rule finds, or only
 * the pairs named, each planned from the store as it stands. With `apply`, each pair is planned again
 * right before it merges, so it sees the merges before it, and rounds a company fold brought together
 * get the same-company pass after.
 */
export async function mergeRoundPairs(
  handle: Db,
  opts: MergeRoundPairsOptions,
): Promise<{ planned: RoundMerge[]; merged: number; followUps: number; refused: string[] }> {
  const refused: string[] = [];
  let pairs: Array<{ keep: MergeRow; dup: MergeRow }>;
  if (opts.pairs) {
    pairs = [];
    for (const [a, b] of opts.pairs) {
      const rows = await roundsForMerge(handle, inArray(fundingRounds.id, [a, b]));
      const [keep, dup] = rows.sort(survivorOrder);
      if (rows.length !== 2 || !keep || !dup) {
        refused.push(`${a} + ${b}: ${a === b ? "the same id twice" : "not both in the store"}`);
        continue;
      }
      const rejected = keep.disposition === "rejected" || dup.disposition === "rejected";
      if (!opts.force && (rejected || !isDuplicateRound(keep, dup))) {
        refused.push(
          `${a} + ${b}: ${rejected ? "one side is rejected" : "the rule does not call these one round"} (--force merges anyway)`,
        );
        continue;
      }
      pairs.push({ keep, dup });
    }
  } else {
    pairs = await findDuplicateRounds(handle);
  }

  const planned: RoundMerge[] = [];
  const folded = new Set<string>();
  let merged = 0;
  for (const { keep, dup } of pairs) {
    const m = await planRoundMerge(handle, keep.id, dup.id);
    if (!m) {
      refused.push(`${dup.id} into ${keep.id}: a round is gone (an earlier merge took it)`);
      continue;
    }
    planned.push(m);
    if (!opts.apply) continue;
    await applyRoundMerge(handle, m);
    if (m.company) folded.add(m.company.into);
    merged++;
  }
  let followUps = 0;
  for (const companyId of folded) followUps += (await mergeDuplicateRounds(handle, { companyId })).merged;
  return { planned, merged, followUps, refused };
}

/** Companies left with no round after merges are gone from the product; remove them and what hangs off them. */
export async function removeOrphanCompanies(handle: Db): Promise<{ removed: number }> {
  const orphans = await handle
    .select({ id: companies.id })
    .from(companies)
    .where(sql`not exists (select 1 from ${fundingRounds} f where f.company_id = ${companies.id})`);
  if (orphans.length === 0) return { removed: 0 };
  const ids = orphans.map((o) => o.id);
  await handle.delete(enrichments).where(inArray(enrichments.companyId, ids));
  await handle.delete(schema.companyAliases).where(inArray(schema.companyAliases.companyId, ids));
  await handle.delete(companies).where(inArray(companies.id, ids));
  return { removed: ids.length };
}

/** Map free-text sectors written before the vocabulary onto it, on companies and rounds. */
export async function normalizeSectors(handle: Db): Promise<{ companies: number; rounds: number }> {
  let changedCompanies = 0;
  let changedRounds = 0;
  const cs = await handle
    .select({ id: companies.id, sector: companies.sector })
    .from(companies)
    .where(sql`${companies.sector} is not null`);
  for (const c of cs) {
    const next = normalizeSector(c.sector);
    if (next === c.sector) continue;
    await handle.update(companies).set({ sector: next, updatedAt: new Date() }).where(eq(companies.id, c.id));
    changedCompanies++;
  }
  const rs = await handle
    .select({ id: fundingRounds.id, sector: fundingRounds.sector })
    .from(fundingRounds)
    .where(sql`${fundingRounds.sector} is not null`);
  for (const r of rs) {
    const next = normalizeSector(r.sector);
    if (next === r.sector) continue;
    await handle.update(fundingRounds).set({ sector: next, updatedAt: new Date() }).where(eq(fundingRounds.id, r.id));
    changedRounds++;
  }
  return { companies: changedCompanies, rounds: changedRounds };
}

/**
 * Start the data over: everything the pipeline wrote goes (rounds and their links, sources,
 * investors, companies with their aliases and enrichments, the candidates ledger, deliveries,
 * webhook receipts, runs); everything the operator configured stays (coverage, feed tokens,
 * delivery targets, monitors). `scripts/maintenance/reset-data.ts` is the command; a backfill through a
 * corrected pipeline is the reason to run it.
 */
export async function resetData(handle: Db): Promise<{ rounds: number; companies: number; sources: number }> {
  const [[r], [c], [s]] = await Promise.all([
    handle.select({ n: sql<number>`count(*)::int` }).from(fundingRounds),
    handle.select({ n: sql<number>`count(*)::int` }).from(companies),
    handle.select({ n: sql<number>`count(*)::int` }).from(sources),
  ]);
  // Children before parents, so foreign keys hold at every step.
  await handle.delete(schema.deliveries);
  await handle.delete(roundSources);
  await handle.delete(roundInvestors);
  await handle.delete(fundingRounds);
  await handle.delete(schema.roundMerges);
  await handle.delete(sources);
  await handle.delete(investors);
  await handle.delete(enrichments);
  await handle.delete(schema.companyAliases);
  await handle.delete(schema.companyFolds);
  await handle.delete(companies);
  await handle.delete(schema.candidates);
  await handle.delete(schema.webhookDeliveries);
  await handle.delete(schema.runs);
  return { rounds: r?.n ?? 0, companies: c?.n ?? 0, sources: s?.n ?? 0 };
}

/**
 * Re-settle every stored row's day from its sources under the current rule: a borrowed day (a byline, a
 * URL, a search result) yields to a dated release or a ranked publisher's dated URL in the same row; a
 * stated day stands; a row that does not know where its day came from moves only a rough date. The
 * maintenance pass for a dating rule that improved after the store was built.
 */
export async function settleStoredDates(handle: Db): Promise<{ moved: number; sharpened: number }> {
  let moved = 0;
  let sharpened = 0;
  let cursor: string | null = null;
  do {
    const page: { rows: RoundRow[]; nextCursor: string | null } = await listRounds(handle, {
      includeReview: true,
      limit: 200,
      cursor: cursor ?? undefined,
    });
    for (const row of page.rows) {
      // A day a person pinned is not the rule's to move.
      if (row.pinned?.announced_on) continue;
      const record = {
        id: row.id,
        company_key: normalizeCompanyKey(row.company.name),
        stage: row.stage,
        announced_date: row.announced_on,
        date_precision: row.date_precision,
        date_basis: row.date_basis ?? undefined,
        undated: row.announced_on === null,
        company_domain: row.company.domain,
        sources: row.sources.map((s) => ({ url: s.url, host: s.host, title: s.title ?? undefined, published: s.published ?? undefined })),
        evidence_quotes: row.evidence_quotes,
      } as FeedRecord;
      const settled = settleDate(record, { onlyRough: record.date_basis === undefined });
      if (settled.announced_date === row.announced_on && settled.date_precision === row.date_precision) continue;
      // A wire release's dateline may move a day later; nothing else does.
      if (
        settled.announced_date !== wireReleaseDay(row.evidence_quotes) &&
        neverLater({ announcedOn: row.announced_on, datePrecision: row.date_precision, dateBasis: row.date_basis }, settled.announced_date)
      )
        continue;
      await handle
        .update(fundingRounds)
        .set({ announcedOn: settled.announced_date, datePrecision: settled.date_precision, dateBasis: settled.date_basis ?? null })
        .where(eq(fundingRounds.id, row.id));
      if (settled.announced_date !== row.announced_on) moved++;
      else sharpened++;
    }
    cursor = page.nextCursor;
  } while (cursor);
  return { moved, sharpened };
}

/**
 * Reject rows the non-article rules would refuse today: every source is a directory page (a portfolio,
 * an investor's list, a tracker) by URL or title, or every evidence quote is a table row rather than a
 * sentence. Such a row is history listed as data, dated to the list's own week. Kept as rejected for the
 * reviewer, with the reason on the verification.
 */
export async function rejectDirectoryRounds(handle: Db): Promise<{ rejected: number }> {
  let rejected = 0;
  let cursor: string | undefined;
  do {
    const page: { rows: RoundRow[]; nextCursor: string | null } = await listRounds(handle, { includeReview: true, limit: 200, cursor });
    for (const row of page.rows) {
      if (row.disposition === "rejected" || row.sources.length === 0) continue;
      const allDirectory = row.sources.every((s) => !isArticleUrl(s.url) || isDirectoryTitle(s.title));
      // A weekly or monthly roundup lists this period's rounds as rows; only a page that is not one makes a table row history.
      const roundup = row.sources.some(
        (s) => WEEKLY_LIST.test(s.title ?? "") || WEEKLY_LIST.test(s.url) || MONTHLY_LIST.test(s.title ?? ""),
      );
      const allTableRows = !roundup && row.evidence_quotes.length > 0 && row.evidence_quotes.every((q) => isTableRowQuote(q));
      if (!allDirectory && !allTableRows) continue;
      const reason = allDirectory ? "every source is a directory page, not an announcement" : "the evidence is a table row, not a sentence";
      const verification = row.verification ?? { status: "unverified", notes: [], url: null };
      await handle
        .update(fundingRounds)
        .set({
          disposition: "rejected",
          verification: { ...verification, status: "not_news", notes: [...verification.notes, `rejected: ${reason}`] },
        })
        .where(eq(fundingRounds.id, row.id));
      rejected++;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { rejected };
}

/**
 * Recompute the disposition of every row in a machine-owned state (review, flagged) from what the row
 * knows now. A row flagged before the read-back confirmed it, or read back into a store built before
 * flagged rows followed the evidence, publishes here; a reviewer's publish or reject is never touched.
 */
export async function settleDispositions(handle: Db): Promise<{ published: number; reviewed: number; flagged: number }> {
  const moved = { published: 0, reviewed: 0, flagged: 0 };
  let cursor: string | undefined;
  do {
    const page: { rows: RoundRow[]; nextCursor: string | null } = await listRounds(handle, { includeReview: true, limit: 200, cursor });
    for (const row of page.rows) {
      if (row.disposition !== "review" && row.disposition !== "flagged") continue;
      const next = dispositionFor({
        undated: row.announced_on === null,
        confidence: row.confidence,
        amount: { as_written: row.amount.as_written },
        verification: (row.verification as FeedRecord["verification"]) ?? undefined,
      });
      if (next === row.disposition) continue;
      await handle.update(fundingRounds).set({ disposition: next, updatedAt: new Date() }).where(eq(fundingRounds.id, row.id));
      if (next === "publish") moved.published++;
      else if (next === "review") moved.reviewed++;
      else moved.flagged++;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return moved;
}

/**
 * Amounts the evidence never stated, written before the rule: the figure comes off the row (a
 * headline's partnership value under a Series A), and a published row drops to flagged so the reader
 * sees a record that is complete except for the amount rather than one that is wrong.
 */
export async function ungroundAmounts(handle: Db): Promise<{ cleared: number }> {
  const rows = await handle
    .select({
      id: fundingRounds.id,
      asWritten: fundingRounds.amountAsWritten,
      evidence: fundingRounds.evidenceQuotes,
      disposition: fundingRounds.disposition,
    })
    .from(fundingRounds)
    .where(sql`${fundingRounds.amountAsWritten} is not null`);
  let cleared = 0;
  for (const r of rows) {
    const quotes = (r.evidence as string[] | null) ?? [];
    if (amountInEvidence(r.asWritten, quotes.join(" "))) continue;
    await handle
      .update(fundingRounds)
      .set({
        amountAsWritten: null,
        amountValue: null,
        amountCurrency: null,
        amountUsdMillions: null,
        fxRate: null,
        fxDate: null,
        disposition: r.disposition === "publish" ? "flagged" : r.disposition,
      })
      .where(eq(fundingRounds.id, r.id));
    cleared++;
  }
  return { cleared };
}

/**
 * Every round's investor links as one set, for rows written before persist reconciled spellings:
 * two spellings of one firm on a round fold into the fuller one (a lead stays a lead), placeholders
 * drop, and an investor row nothing links to anymore goes.
 */
export async function reconcileRoundInvestors(handle: Db): Promise<{ folded: number; orphans: number }> {
  const links = await handle
    .select({ roundId: roundInvestors.roundId, investorId: roundInvestors.investorId, name: investors.name, role: roundInvestors.role })
    .from(roundInvestors)
    .innerJoin(investors, eq(investors.id, roundInvestors.investorId));
  const byRound = new Map<string, typeof links>();
  for (const l of links) byRound.set(l.roundId, [...(byRound.get(l.roundId) ?? []), l]);
  let folded = 0;
  for (const [roundId, rows] of byRound) {
    const set = reconcileInvestorLists(
      rows.filter((r) => r.role === "lead").flatMap((r) => normalizeInvestorName(r.name) ?? []),
      rows.filter((r) => r.role !== "lead").flatMap((r) => normalizeInvestorName(r.name) ?? []),
    );
    const leadIds = new Set(set.lead_investors.map((n) => investorKeyForMerge(n)));
    const survivors = new Set([...set.lead_investors, ...set.other_investors].map((n) => investorKeyForMerge(n)));
    for (const r of rows) {
      if (!survivors.has(r.investorId)) {
        await handle.delete(roundInvestors).where(and(eq(roundInvestors.roundId, roundId), eq(roundInvestors.investorId, r.investorId)));
        folded++;
      } else if (leadIds.has(r.investorId) && r.role !== "lead") {
        await handle
          .update(roundInvestors)
          .set({ role: "lead" })
          .where(and(eq(roundInvestors.roundId, roundId), eq(roundInvestors.investorId, r.investorId)));
      }
    }
    // A surviving spelling with no link yet (the fuller form was on the other role's row) is linked now.
    for (const name of [...set.lead_investors, ...set.other_investors]) {
      const id = investorKeyForMerge(name);
      if (rows.some((r) => r.investorId === id)) continue;
      await handle.insert(investors).values({ id, name }).onConflictDoNothing();
      await handle
        .insert(roundInvestors)
        .values({ roundId, investorId: id, role: leadIds.has(id) ? "lead" : "participant" })
        .onConflictDoNothing();
    }
  }
  const orphaned = await handle.execute(
    sql`delete from investors i where not exists (select 1 from round_investors ri where ri.investor_id = i.id)`,
  );
  return { folded, orphans: Number(orphaned.rowCount ?? 0) };
}

/** The page that fixes a repaired row's day: stored as a source on the row, so a reader and the read-back both see it. */
export interface FixEvidence {
  url: string;
  title: string;
  /** The page's own day, YYYY-MM-DD. */
  published: string;
  /** The sentence that states the round and its day, appended to the row's evidence. */
  quote?: string;
}

/**
 * One confirmed correction to a stored row, checked by hand against the sources. `from` is what the row
 * holds when the fix was written: a row that has moved on since is refused rather than overwritten.
 */
export type RecordFix =
  | {
      kind: "redate";
      round: string;
      from: string;
      announced_on: string;
      /** "stated" when the evidence's text or dateline states the day, "url" when its URL carries it. */
      basis: "stated" | "url";
      evidence: FixEvidence;
      note: string;
      /**
       * A USD figure the release states when the row carried another page's figure, or null when the
       * row's figure is not this round's (a total raised to date): the amount comes off, and a published
       * row drops to flagged, as ungroundAmounts does.
       */
      amount_as_written?: string | null;
      stage_as_written?: string;
      is_extension?: boolean;
    }
  | {
      kind: "reject";
      round: string;
      reason: string;
      /** The page that shows the row is not this company's round, kept in the row's notes. */
      evidence?: string;
    }
  /** Two rows for one round the window rule keeps apart (a trend story's months-late reading): the app's merge, forced. */
  | { kind: "merge"; keep: string; drop: string }
  /**
   * A company row with no domain that is another row's company (a second "Ramp" a news roundup made),
   * folded into it by the app's merge: its rounds, enrichments, aliases and history ledger move, and
   * its id redirects to the survivor. The evidence is the page that shows the two are one company.
   */
  | { kind: "fold"; from: string; into: string; evidence: string; note: string }
  | {
      kind: "domain";
      company: string;
      /** The domain the row holds now; null for a company the identity check never placed (OpenAI). */
      from: string | null;
      domain: string;
      website: string;
      /** What was read on the wrong domain (or on none) and goes, so the next enrichment pass rebuilds it for the right one. */
      clear: Array<"logo" | "profile" | "alexandria" | "deep_dive">;
      note: string;
      /** The page that shows the domain is the company's: its own homepage naming it, or press linking it. */
      evidence?: string;
    }
  /**
   * A stage the page names more precisely, or a round mislabelled (a $40 billion "funding round" is a
   * growth round, a customer-value-fund deal is not a Series). The id stays, as a re-date's does.
   */
  | {
      kind: "restage";
      round: string;
      from: string;
      stage: Stage;
      stage_as_written: string;
      evidence: string;
      note: string;
    }
  /**
   * How sure the round is, as its pages say: a round shown as announced whose only established source
   * says the company is still raising ("set to raise", "in talks") is expected. Pinned, so no later
   * reading moves it back.
   */
  /**
   * A page linked to a round that is another round's: a reading of a second deal merged into this row
   * (Immunomatics' September cheque on its October row). The link goes, with the quotes taken from that
   * page; the page itself stays for the round it belongs to. A row keeps at least one source.
   */
  | { kind: "unlink"; round: string; source: string; quotes: string[]; note: string }
  | {
      kind: "certainty";
      round: string;
      from: RoundCertainty;
      certainty: RoundCertainty;
      evidence: string;
      quote: string;
      note: string;
    }
  /**
   * A round's valuation as a page states it, in the page's own words ("$61.5 billion post-money"):
   * one the readings missed, or one a weaker page worded for it. The quote must state the figure. Pinned,
   * so no later reading moves it, and kept as a valuation claim with its page.
   */
  | {
      kind: "valuation";
      round: string;
      from: string | null;
      valuation: string;
      evidence: string;
      quote: string;
      note: string;
    }
  /**
   * A flagged or review row checked by hand against a page it already cites: a person's publish, as the
   * review queue's (lib/persist.ts setDisposition). The quote must state the row's amount, and the read-back
   * must have confirmed or corrected the row. A held row is published only when `hold` names its hold.
   */
  | {
      kind: "publish";
      round: string;
      from: "flagged" | "review";
      evidence: string;
      quote: string;
      note: string;
      hold?: string;
    }
  /**
   * A company description that says nothing ("an artificial intelligence company") or is a headline,
   * replaced by one sentence the company's own page supports. A re-enrichment never replaces a
   * description the record already has, so a vague one stays until a fix like this.
   */
  | { kind: "describe"; company: string; from: string | null; description: string; evidence: string; note: string }
  /**
   * An earlier round the audit found missing, queued on the history ledger as a lead (origin audit)
   * with the page that states it. It is never written as a row here: the history pass reads that page
   * (and searches for its announcement) through extraction, the resolver, and the read-back, and only a
   * page that states the round makes one.
   */
  | {
      kind: "history_lead";
      company: string;
      stage_as_written: string;
      amount_as_written: string | null;
      announced_date: string | null;
      lead_investors: string[];
      evidence: string;
      note: string;
      /**
       * A lead already on the ledger that ended without a source (no_source, failed, skipped) goes back
       * to pending with this page, when the page is not the one it already tried: a cited post that never
       * stated the figure is not the last word on a round another page states.
       */
      requeue?: boolean;
    }
  /**
   * A round's whole syndicate as its announcement states it: who led and who joined. `from` is the row's
   * lists when the fix was written, compared by investor key, so a row a later read-back changed is
   * refused. Written the way persist writes a verified list (syncRoundInvestors, replace), so a firm
   * neither list names leaves the row and a new firm gets its investor row.
   */
  | {
      kind: "investors";
      round: string;
      from: InvestorLists;
      to: InvestorLists;
      evidence: string;
      note: string;
    }
  /**
   * A domain the company published on under an earlier name (Mondo's getmondo.co.uk for Monzo), kept as
   * one of its sites so the history check takes pages giving that domain as the company's own. Refused
   * when the domain is another company's, or another company's site.
   */
  | { kind: "site"; company: string; domain: string; evidence: string; note: string }
  /**
   * A name the company went by before a rebrand (Hampton Creek for Eat Just, LimeBike for Lime), stored as
   * a name alias with the page that shows it is the same company. Pages from before the rename use that
   * name, and a history reading of one is the company's only when its name is one the company is known by.
   * A name another company is stored under is refused: the alias would hand that company's readings to this one.
   */
  | { kind: "alias"; company: string; name: string; evidence: string; note: string }
  /** A company's headquarters when the stored one is wrong or missing (a factory town, a founder's birthplace). */
  | { kind: "hq"; company: string; from: string | null; hq: string; evidence: string; note: string }
  /** A company's sector from the vocabulary when the stored one is wrong (a rocket maker filed under AI). */
  | { kind: "sector"; company: string; from: string | null; sector: Sector; evidence: string; note: string };

/** A round's investors by role, as names. */
export interface InvestorLists {
  leads: string[];
  participants: string[];
}

/** One role's names as investor keys, so two spellings of one firm ("NEA", "New Enterprise Associates") compare equal. */
function investorKeys(names: string[]): string {
  return [...new Set(names.map((n) => investorKeyForMerge(n)))].sort().join("|");
}

function sameInvestors(a: InvestorLists, b: InvestorLists): boolean {
  return investorKeys(a.leads) === investorKeys(b.leads) && investorKeys(a.participants) === investorKeys(b.participants);
}

function showInvestors(l: InvestorLists): string {
  return `leads [${l.leads.join(", ")}], participants [${l.participants.join(", ")}]`;
}

export interface RecordFixResult {
  lines: string[];
  applied: number;
  skipped: number;
  refused: number;
}

/**
 * Apply hand-checked corrections to stored rows, printing each before it is made. Without `apply` every
 * step only reads. A re-dated row keeps its id, as the dating repairs do (settleStoredDates): the id
 * records the day a row was first written, and deliveries, sources, and investor links stay pointed at
 * it. Every fix is idempotent: one already in place is reported and skipped.
 */
export async function applyRecordFixes(handle: Db, fixes: RecordFix[], opts: { apply: boolean }): Promise<RecordFixResult> {
  const out: RecordFixResult = { lines: [], applied: 0, skipped: 0, refused: 0 };
  const say = (line: string) => out.lines.push(line);
  const redated = new Set<string>();
  for (const fix of fixes) {
    if (fix.kind === "merge") {
      const result = await mergeRoundPairs(handle, { apply: opts.apply, force: true, pairs: [[fix.keep, fix.drop]] });
      if (result.planned.length === 0) {
        say(`skip merge ${fix.drop} into ${fix.keep}: ${result.refused.join("; ") || "nothing to merge"}`);
        out.skipped++;
        continue;
      }
      for (const m of result.planned) for (const l of describeRoundMerge(m)) say(l);
      if (opts.apply) out.applied++;
      continue;
    }
    if (fix.kind === "site") {
      const domain = registrableDomain(
        `https://${fix.domain
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, "")}`,
      );
      const [company] = await handle
        .select({ name: companies.name, domain: companies.domain })
        .from(companies)
        .where(eq(companies.id, fix.company));
      if (!company || !domain) {
        say(`refuse site ${fix.company}: ${company ? `${fix.domain} is not a domain` : "no such company"}`);
        out.refused++;
        continue;
      }
      const [held] = await handle
        .select({ companyId: companyAliases.companyId })
        .from(companyAliases)
        .where(and(eq(companyAliases.kind, "domain"), eq(companyAliases.aliasKey, domain)));
      if (company.domain === domain || held?.companyId === fix.company) {
        say(`skip site ${fix.company}: ${domain} is already its site`);
        out.skipped++;
        continue;
      }
      const [owner] = await handle.select({ id: companies.id }).from(companies).where(eq(companies.domain, domain));
      if (owner || held) {
        say(`refuse site ${fix.company}: ${domain} belongs to company ${owner?.id ?? held?.companyId}`);
        out.refused++;
        continue;
      }
      say(`site ${fix.company} (${company.name}): + ${domain}`);
      say(`  evidence: ${fix.evidence}`);
      say(`  why: ${fix.note}`);
      if (!opts.apply) continue;
      await handle
        .insert(companyAliases)
        .values({ companyId: fix.company, kind: "domain", aliasKey: domain, alias: domain, sourceUrl: fix.evidence })
        .onConflictDoNothing();
      out.applied++;
      continue;
    }
    if (fix.kind === "describe") {
      const [company] = await handle
        .select({ name: companies.name, description: companies.description })
        .from(companies)
        .where(eq(companies.id, fix.company));
      if (!company) {
        say(`refuse describe ${fix.company}: no such company`);
        out.refused++;
        continue;
      }
      if (company.description === fix.description) {
        say(`skip describe ${fix.company}: already described so`);
        out.skipped++;
        continue;
      }
      if (company.description !== fix.from) {
        say(`refuse describe ${fix.company}: description is ${JSON.stringify(company.description)}, expected ${JSON.stringify(fix.from)}`);
        out.refused++;
        continue;
      }
      say(`describe ${fix.company} (${company.name}): ${JSON.stringify(company.description)} -> ${JSON.stringify(fix.description)}`);
      say(`  evidence: ${fix.evidence}`);
      say(`  why: ${fix.note}`);
      if (!opts.apply) continue;
      await handle.update(companies).set({ description: fix.description, updatedAt: new Date() }).where(eq(companies.id, fix.company));
      out.applied++;
      continue;
    }
    if (fix.kind === "alias") {
      const key = normalizeCompanyKey(fix.name);
      const [company] = await handle
        .select({ name: companies.name, nameKey: companies.nameKey })
        .from(companies)
        .where(eq(companies.id, fix.company));
      if (!company) {
        say(`refuse alias ${fix.company}: no such company`);
        out.refused++;
        continue;
      }
      if (!key || key === company.nameKey) {
        say(`refuse alias ${fix.company}: ${JSON.stringify(fix.name)} is not another name for ${company.name}`);
        out.refused++;
        continue;
      }
      const holders = await handle
        .select({ id: companies.id })
        .from(companies)
        .where(
          and(
            ne(companies.id, fix.company),
            or(
              eq(companies.nameKey, key),
              sql`exists (select 1 from company_aliases a where a.company_id = ${companies.id} and a.kind = 'name' and a.alias_key = ${key})`,
            ),
          ),
        );
      if (holders.length > 0) {
        say(`refuse alias ${fix.company}: ${JSON.stringify(fix.name)} is also ${holders.map((h) => h.id).join(", ")}'s name`);
        out.refused++;
        continue;
      }
      const [held] = await handle
        .select({ alias: schema.companyAliases.alias })
        .from(schema.companyAliases)
        .where(
          and(
            eq(schema.companyAliases.companyId, fix.company),
            eq(schema.companyAliases.kind, "name"),
            eq(schema.companyAliases.aliasKey, key),
          ),
        );
      if (held) {
        say(`skip alias ${fix.company}: already known as ${JSON.stringify(held.alias)}`);
        out.skipped++;
        continue;
      }
      say(`alias ${fix.company} (${company.name}): also known as ${JSON.stringify(fix.name)}`);
      say(`  evidence: ${fix.evidence}`);
      say(`  why: ${fix.note}`);
      if (!opts.apply) continue;
      await handle
        .insert(schema.companyAliases)
        .values({ companyId: fix.company, kind: "name", aliasKey: key, alias: fix.name.trim(), sourceUrl: fix.evidence })
        .onConflictDoNothing();
      out.applied++;
      continue;
    }
    if (fix.kind === "hq" || fix.kind === "sector") {
      const to = fix.kind === "hq" ? fix.hq.trim() : fix.sector;
      if (fix.kind === "sector" && !(SECTORS as readonly string[]).includes(fix.sector)) {
        say(`refuse sector ${fix.company}: ${JSON.stringify(fix.sector)} is not in the sector vocabulary`);
        out.refused++;
        continue;
      }
      if (!to) {
        say(`refuse hq ${fix.company}: an empty headquarters`);
        out.refused++;
        continue;
      }
      const [company] = await handle
        .select({ name: companies.name, hq: companies.hq, sector: companies.sector })
        .from(companies)
        .where(eq(companies.id, fix.company));
      if (!company) {
        say(`refuse ${fix.kind} ${fix.company}: no such company`);
        out.refused++;
        continue;
      }
      const now = company[fix.kind];
      if (now === to) {
        say(`skip ${fix.kind} ${fix.company}: already ${JSON.stringify(to)}`);
        out.skipped++;
        continue;
      }
      if (now !== fix.from) {
        say(`refuse ${fix.kind} ${fix.company}: ${fix.kind} is ${JSON.stringify(now)}, expected ${JSON.stringify(fix.from)}`);
        out.refused++;
        continue;
      }
      say(`${fix.kind} ${fix.company} (${company.name}): ${JSON.stringify(now)} -> ${JSON.stringify(to)}`);
      say(`  evidence: ${fix.evidence}`);
      say(`  why: ${fix.note}`);
      if (!opts.apply) continue;
      await handle
        .update(companies)
        .set({ ...(fix.kind === "hq" ? { hq: to } : { sector: to }), updatedAt: new Date() })
        .where(eq(companies.id, fix.company));
      out.applied++;
      continue;
    }
    if (fix.kind === "history_lead") {
      const [company] = await handle
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(eq(companies.id, fix.company));
      if (!company) {
        say(`refuse history_lead ${fix.company}: no such company`);
        out.refused++;
        continue;
      }
      const prior: HistoryPrior = {
        stage_as_written: fix.stage_as_written,
        amount_as_written: fix.amount_as_written,
        announced_date: fix.announced_date,
        lead_investors: fix.lead_investors,
        source_url: fix.evidence,
      };
      if (!promotable(prior)) {
        say(`refuse history_lead ${fix.company}: ${fix.stage_as_written} is too vague to recognise (no stage, amount, or day)`);
        out.refused++;
        continue;
      }
      const key = priorKey(prior);
      const [queued] = await handle
        .select({ status: historyPromotions.status, origin: historyPromotions.origin, prior: historyPromotions.prior })
        .from(historyPromotions)
        .where(and(eq(historyPromotions.companyId, fix.company), eq(historyPromotions.priorKey, key)));
      const ended = queued && ["no_source", "failed", "skipped"].includes(queued.status);
      if (fix.requeue && queued && ended && queued.prior.source_url !== fix.evidence) {
        say(
          `history_lead ${fix.company} (${company.name}) ${key}: requeue ${queued.status} -> pending with a new page (was ${queued.prior.source_url ?? "none"})`,
        );
        say(`  evidence: ${fix.evidence}`);
        say(`  why: ${fix.note}`);
        if (!opts.apply) continue;
        // Guarded on the status read above, so a lane that claimed the row since is not overwritten.
        await handle
          .update(historyPromotions)
          .set({
            prior,
            status: "pending",
            attempts: 0,
            nextAttemptAt: new Date(),
            claimedBy: null,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(historyPromotions.companyId, fix.company),
              eq(historyPromotions.priorKey, key),
              eq(historyPromotions.status, queued.status),
            ),
          );
        out.applied++;
        continue;
      }
      if (queued) {
        say(`skip history_lead ${fix.company} ${key}: already on the ledger (${queued.origin}, ${queued.status})`);
        out.skipped++;
        continue;
      }
      say(
        `history_lead ${fix.company} (${company.name}): ${[fix.stage_as_written, fix.amount_as_written, fix.announced_date].filter(Boolean).join(" ")}${fix.lead_investors.length ? ` led by ${fix.lead_investors.join(", ")}` : ""} -> ledger as audit, pending`,
      );
      say(`  evidence: ${fix.evidence}`);
      say(`  why: ${fix.note}`);
      if (!opts.apply) continue;
      await handle
        .insert(historyPromotions)
        .values({ companyId: fix.company, priorKey: key, prior, origin: "audit", status: "pending", nextAttemptAt: new Date() })
        .onConflictDoNothing();
      out.applied++;
      continue;
    }
    if (fix.kind === "fold") {
      const [from] = await handle.select().from(companies).where(eq(companies.id, fix.from));
      const [into] = await handle.select().from(companies).where(eq(companies.id, fix.into));
      if (!from) {
        const [fold] = await handle.select().from(schema.companyFolds).where(eq(schema.companyFolds.fromId, fix.from));
        if (fold?.intoId === fix.into) {
          say(`skip fold ${fix.from}: already folded into ${fix.into}`);
          out.skipped++;
        } else {
          say(`refuse fold ${fix.from}: no such company`);
          out.refused++;
        }
        continue;
      }
      if (!into?.domain) {
        say(`refuse fold ${fix.from}: ${fix.into} ${into ? "has no domain" : "is not a company"}`);
        out.refused++;
        continue;
      }
      if (from.domain && from.domain !== into.domain) {
        say(`refuse fold ${fix.from}: its domain ${from.domain} is not ${into.domain}; two domains are two companies`);
        out.refused++;
        continue;
      }
      const moving = await handle
        .select({ id: fundingRounds.id, disposition: fundingRounds.disposition })
        .from(fundingRounds)
        .where(eq(fundingRounds.companyId, fix.from));
      say(`fold ${fix.from} (${from.name}, site ${from.website ?? "none"}) into ${fix.into} (${into.name}, ${into.domain})`);
      say(`  rounds moving: ${moving.length ? moving.map((r) => `${r.id} (${r.disposition})`).join(", ") : "none"}`);
      say(`  why: ${fix.note}`);
      say(`  evidence: ${fix.evidence}`);
      if (!opts.apply) continue;
      await mergeCompanies(handle, fix.from, fix.into);
      out.applied++;
      continue;
    }

    if (fix.kind === "domain") {
      const [company] = await handle.select().from(companies).where(eq(companies.id, fix.company));
      if (!company) {
        say(`refuse domain ${fix.company}: no such company`);
        out.refused++;
        continue;
      }
      // The move is done once the domain is the right one: what the next pass rebuilds on it is not cleared again.
      if (company.domain === fix.domain) {
        say(`skip domain ${fix.company}: already ${fix.domain}`);
        out.skipped++;
        continue;
      }
      if (company.domain !== fix.from) {
        say(`refuse domain ${fix.company}: domain is ${company.domain ?? "none"}, expected ${fix.from ?? "none"}`);
        out.refused++;
        continue;
      }
      const [owner] = await handle
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.domain, fix.domain), sql`${companies.id} <> ${fix.company}`));
      if (owner) {
        say(`refuse domain ${fix.company}: ${fix.domain} belongs to company ${owner.id} (fold them with the app's merge instead)`);
        out.refused++;
        continue;
      }
      const kindsToClear = fix.clear.filter((k): k is Exclude<typeof k, "logo"> => k !== "logo");
      const kinds =
        kindsToClear.length === 0
          ? []
          : (
              await handle
                .select({ kind: enrichments.kind })
                .from(enrichments)
                .where(and(eq(enrichments.companyId, fix.company), inArray(enrichments.kind, kindsToClear)))
            ).map((e) => e.kind);
      const logoToClear = fix.clear.includes("logo") && company.logoUrl !== null;
      say(
        `domain ${fix.company} (${company.name}): ${company.domain ?? "none"} -> ${fix.domain}; website ${company.website ?? "none"} -> ${fix.website}`,
      );
      if (logoToClear) say(`  logo: ${company.logoUrl} -> null`);
      say(`  delete enrichments: ${kinds.join(", ") || "none"}`);
      say(`  why: ${fix.note}`);
      if (fix.evidence) say(`  evidence: ${fix.evidence}`);
      if (!opts.apply) continue;
      // The enrichments go first: the domain moving last is what marks the fix done.
      if (kinds.length > 0) {
        await handle.delete(enrichments).where(and(eq(enrichments.companyId, fix.company), inArray(enrichments.kind, kinds)));
      }
      await handle
        .update(companies)
        .set({ domain: fix.domain, website: fix.website, ...(logoToClear ? { logoUrl: null } : {}), updatedAt: new Date() })
        .where(eq(companies.id, fix.company));
      out.applied++;
      continue;
    }

    const [row] = await handle.select().from(fundingRounds).where(eq(fundingRounds.id, fix.round));
    if (!row) {
      say(`refuse ${fix.kind} ${fix.round}: no such round`);
      out.refused++;
      continue;
    }
    const verification = (row.verification as FeedRecord["verification"]) ?? { status: "unverified" as const, notes: [], url: null };

    if (fix.kind === "unlink") {
      const sourceId = canonicalUrl(fix.source);
      const links = await handle.select({ sourceId: roundSources.sourceId }).from(roundSources).where(eq(roundSources.roundId, fix.round));
      if (!links.some((l) => l.sourceId === sourceId)) {
        say(`skip unlink ${fix.round}: ${sourceId} is not one of its sources`);
        out.skipped++;
        continue;
      }
      if (links.length < 2) {
        say(`refuse unlink ${fix.round}: ${sourceId} is its only source`);
        out.refused++;
        continue;
      }
      const quotes = (row.evidenceQuotes as string[] | null) ?? [];
      const dropped = quotes.filter((q) => fix.quotes.includes(q));
      const noteLine = `unlinked ${sourceId}: ${fix.note}`;
      say(`unlink ${fix.round}: ${sourceId}; ${dropped.length} quote(s) go with it`);
      say(`  why: ${fix.note}`);
      if (!opts.apply) continue;
      await handle.delete(roundSources).where(and(eq(roundSources.roundId, fix.round), eq(roundSources.sourceId, sourceId)));
      await handle
        .update(fundingRounds)
        .set({
          evidenceQuotes: quotes.filter((q) => !fix.quotes.includes(q)),
          verification: {
            ...verification,
            notes: verification.notes.includes(noteLine) ? verification.notes : [...verification.notes, noteLine],
          },
          status: sql`CASE WHEN ${fundingRounds.status} = 'seen' AND NOT ${fundingRounds.history} THEN 'updated' ELSE ${fundingRounds.status} END`,
          updatedAt: new Date(),
        })
        .where(eq(fundingRounds.id, fix.round));
      out.applied++;
      continue;
    }

    if (fix.kind === "reject") {
      if (row.disposition === "rejected") {
        say(`skip reject ${fix.round}: already rejected`);
        out.skipped++;
        continue;
      }
      say(`reject ${fix.round}: ${row.disposition} -> rejected, verification ${verification.status} -> not_news`);
      say(`  why: ${fix.reason}`);
      if (fix.evidence) say(`  evidence: ${fix.evidence}`);
      if (!opts.apply) continue;
      const rejectNote = `rejected: ${fix.reason}${fix.evidence ? ` (${fix.evidence})` : ""}`;
      await handle
        .update(fundingRounds)
        .set({
          disposition: "rejected",
          verification: { ...verification, status: "not_news", notes: [...verification.notes, rejectNote] },
          updatedAt: new Date(),
        })
        .where(eq(fundingRounds.id, fix.round));
      out.applied++;
      continue;
    }

    if (fix.kind === "investors") {
      const linked = await handle
        .select({ investorId: roundInvestors.investorId, name: investors.name, role: roundInvestors.role })
        .from(roundInvestors)
        .innerJoin(investors, eq(investors.id, roundInvestors.investorId))
        .where(eq(roundInvestors.roundId, fix.round));
      const now: InvestorLists = {
        leads: linked.filter((l) => l.role === "lead").map((l) => l.name),
        participants: linked.filter((l) => l.role !== "lead").map((l) => l.name),
      };
      const planned = planRoundInvestors(linked, fix.to.leads, fix.to.participants, { replace: true });
      const will: InvestorLists = { leads: planned.lead_investors, participants: planned.other_investors };
      // The hygiene a write passes through may drop or fold a name; a fix whose lists would not land as written is refused.
      if (!sameInvestors(will, fix.to)) {
        say(`refuse investors ${fix.round}: the write would leave ${showInvestors(will)}, not ${showInvestors(fix.to)}`);
        out.refused++;
        continue;
      }
      if (sameInvestors(now, fix.to)) {
        say(`skip investors ${fix.round}: already ${showInvestors(now)}`);
        out.skipped++;
        continue;
      }
      if (!sameInvestors(now, fix.from)) {
        say(`refuse investors ${fix.round}: the row holds ${showInvestors(now)}, expected ${showInvestors(fix.from)}`);
        out.refused++;
        continue;
      }
      const noteLine = `investors read as ${showInvestors(will)} (${hostOf(fix.evidence)}): ${fix.note}`;
      say(`investors ${fix.round}: ${showInvestors(now)} -> ${showInvestors(will)}`);
      say(`  evidence: ${fix.evidence}`);
      say(`  why: ${fix.note}`);
      if (!opts.apply) continue;
      await syncRoundInvestors(handle, fix.round, fix.to.leads, fix.to.participants, { replace: true });
      // A firm only this round named goes with its last link, as the maintenance passes drop orphans.
      const kept = new Set([...will.leads, ...will.participants].map((n) => investorKeyForMerge(n)));
      const dropped = linked.map((l) => l.investorId).filter((id) => !kept.has(id));
      if (dropped.length > 0) {
        await handle.execute(
          sql`delete from investors i where i.id in (${sql.join(
            dropped.map((id) => sql`${id}`),
            sql`, `,
          )}) and not exists (select 1 from round_investors ri where ri.investor_id = i.id)`,
        );
      }
      const notes = verification.notes.includes(noteLine) ? verification.notes : [...verification.notes, noteLine];
      await handle
        .update(fundingRounds)
        .set({
          verification: { ...verification, notes },
          status: sql`CASE WHEN ${fundingRounds.status} = 'seen' AND NOT ${fundingRounds.history} THEN 'updated' ELSE ${fundingRounds.status} END`,
          updatedAt: new Date(),
        })
        .where(eq(fundingRounds.id, fix.round));
      out.applied++;
      continue;
    }

    if (fix.kind === "publish") {
      if (row.disposition === "publish") {
        say(`skip publish ${fix.round}: already published`);
        out.skipped++;
        continue;
      }
      if (row.disposition !== fix.from) {
        say(`refuse publish ${fix.round}: the row is ${row.disposition}, expected ${fix.from}`);
        out.refused++;
        continue;
      }
      if (verification.status !== "confirmed" && verification.status !== "corrected") {
        say(`refuse publish ${fix.round}: the read-back left it ${verification.status}`);
        out.refused++;
        continue;
      }
      if (row.hold && row.hold !== fix.hold) {
        say(`refuse publish ${fix.round}: held (${row.hold})`);
        out.refused++;
        continue;
      }
      if (!amountInEvidence(row.amountAsWritten, fix.quote)) {
        say(`refuse publish ${fix.round}: the quote does not state ${row.amountAsWritten}`);
        out.refused++;
        continue;
      }
      const [cited] = await handle
        .select({ url: roundSources.sourceId })
        .from(roundSources)
        .where(and(eq(roundSources.roundId, fix.round), eq(roundSources.sourceId, canonicalUrl(fix.evidence))));
      if (!cited) {
        say(`refuse publish ${fix.round}: ${fix.evidence} is not one of its sources`);
        out.refused++;
        continue;
      }
      const noteLine = `published by hand (${hostOf(fix.evidence)}): "${fix.quote}": ${fix.note}`;
      say(`publish ${fix.round}: ${row.disposition} -> publish${row.hold ? `, hold lifted (${row.hold})` : ""}`);
      say(`  evidence: ${fix.evidence}`);
      say(`  why: ${fix.note}`);
      if (!opts.apply) continue;
      await setDisposition(handle, fix.round, "publish");
      const notes = verification.notes.includes(noteLine) ? verification.notes : [...verification.notes, noteLine];
      await handle
        .update(fundingRounds)
        .set({ verification: { ...verification, notes }, updatedAt: new Date() })
        .where(eq(fundingRounds.id, fix.round));
      out.applied++;
      continue;
    }

    if (fix.kind === "valuation") {
      if (!amountInEvidence(fix.valuation, fix.quote)) {
        say(`refuse valuation ${fix.round}: the quote does not state ${fix.valuation}`);
        out.refused++;
        continue;
      }
      if (row.valuationAsWritten === fix.valuation && row.pinned?.valuation === fix.valuation) {
        say(`skip valuation ${fix.round}: already ${fix.valuation}, pinned`);
        out.skipped++;
        continue;
      }
      if (row.valuationAsWritten !== fix.valuation && row.valuationAsWritten !== fix.from) {
        say(`refuse valuation ${fix.round}: valuation is ${row.valuationAsWritten ?? "none"}, expected ${fix.from ?? "none"}`);
        out.refused++;
        continue;
      }
      const noteLine = `valuation ${row.valuationAsWritten ?? "none"} read as ${fix.valuation} (${hostOf(fix.evidence)}): "${fix.quote}": ${fix.note}`;
      say(`valuation ${fix.round}: ${row.valuationAsWritten ?? "none"} -> ${fix.valuation}`);
      say(`  evidence: ${fix.evidence}`);
      say(`  why: ${fix.note}`);
      if (!opts.apply) continue;
      const tiers = await loadPublisherTiers();
      const claim = { value: fix.valuation, quote: fix.quote, url: fix.evidence, tier: tiers[hostOf(fix.evidence)] ?? 0.3 };
      const claims = (row.valuationClaims ?? []).filter((c) => !(c.url === claim.url && c.value === claim.value));
      const notes = verification.notes.includes(noteLine) ? verification.notes : [...verification.notes, noteLine];
      await handle
        .update(fundingRounds)
        .set({
          valuationAsWritten: fix.valuation,
          valuationDisclosed: true,
          valuationClaims: [...claims, claim],
          pinned: { ...(row.pinned ?? {}), valuation: fix.valuation },
          verification: { ...verification, notes },
          status: sql`CASE WHEN ${fundingRounds.status} = 'seen' AND NOT ${fundingRounds.history} THEN 'updated' ELSE ${fundingRounds.status} END`,
          updatedAt: new Date(),
        })
        .where(eq(fundingRounds.id, fix.round));
      out.applied++;
      continue;
    }

    if (fix.kind === "certainty") {
      if (row.certainty === fix.certainty) {
        if (row.pinned?.certainty === fix.certainty) {
          say(`skip certainty ${fix.round}: already ${fix.certainty}, pinned`);
          out.skipped++;
          continue;
        }
        say(`pin certainty ${fix.round}: already ${fix.certainty}; pinned so no later reading moves it`);
        if (opts.apply) {
          await handle
            .update(fundingRounds)
            .set({ pinned: { ...(row.pinned ?? {}), certainty: fix.certainty }, updatedAt: new Date() })
            .where(eq(fundingRounds.id, fix.round));
          out.applied++;
        }
        continue;
      }
      if (row.certainty !== fix.from) {
        say(`refuse certainty ${fix.round}: certainty is ${row.certainty}, expected ${fix.from}`);
        out.refused++;
        continue;
      }
      const noteLine = `certainty ${row.certainty} read as ${fix.certainty} (${hostOf(fix.evidence)}): "${fix.quote}": ${fix.note}`;
      say(`certainty ${fix.round}: ${row.certainty} -> ${fix.certainty}`);
      say(`  evidence: ${fix.evidence}`);
      say(`  why: ${fix.note}`);
      if (!opts.apply) continue;
      const notes = verification.notes.includes(noteLine) ? verification.notes : [...verification.notes, noteLine];
      await handle
        .update(fundingRounds)
        .set({
          certainty: fix.certainty,
          reportedOn: fix.certainty === "announced" ? row.reportedOn : (row.reportedOn ?? row.announcedOn),
          pinned: { ...(row.pinned ?? {}), certainty: fix.certainty },
          verification: { ...verification, notes },
          status: sql`CASE WHEN ${fundingRounds.status} = 'seen' AND NOT ${fundingRounds.history} THEN 'updated' ELSE ${fundingRounds.status} END`,
          updatedAt: new Date(),
        })
        .where(eq(fundingRounds.id, fix.round));
      out.applied++;
      continue;
    }

    if (fix.kind === "restage") {
      if (row.stage === fix.stage && row.stageAsWritten === fix.stage_as_written) {
        // Applied before pins existed: the stage is right but a later reading could still move it.
        if (row.pinned?.stage === fix.stage) {
          say(`skip restage ${fix.round}: already ${fix.stage} (${fix.stage_as_written}), pinned`);
          out.skipped++;
          continue;
        }
        say(`pin restage ${fix.round}: already ${fix.stage} (${fix.stage_as_written}); pinned so no later reading moves it`);
        if (opts.apply) {
          await handle
            .update(fundingRounds)
            .set({ pinned: { ...(row.pinned ?? {}), stage: fix.stage }, updatedAt: new Date() })
            .where(eq(fundingRounds.id, fix.round));
          out.applied++;
        }
        continue;
      }
      if (row.stage !== fix.from && row.stage !== fix.stage) {
        say(`refuse restage ${fix.round}: stage is ${row.stage}, expected ${fix.from}`);
        out.refused++;
        continue;
      }
      const noteLine = `stage ${row.stage} (${row.stageAsWritten}) read as ${fix.stage} (${fix.stage_as_written}, ${hostOf(fix.evidence)}): ${fix.note}`;
      say(`restage ${fix.round}: ${row.stage} (${row.stageAsWritten}) -> ${fix.stage} (${fix.stage_as_written})`);
      say(`  evidence: ${fix.evidence}`);
      say(`  why: ${fix.note}`);
      if (!opts.apply) continue;
      const notes = verification.notes.includes(noteLine) ? verification.notes : [...verification.notes, noteLine];
      await handle
        .update(fundingRounds)
        .set({
          stage: fix.stage,
          stageAsWritten: fix.stage_as_written,
          pinned: { ...(row.pinned ?? {}), stage: fix.stage },
          verification: { ...verification, notes },
          status: sql`CASE WHEN ${fundingRounds.status} = 'seen' AND NOT ${fundingRounds.history} THEN 'updated' ELSE ${fundingRounds.status} END`,
          updatedAt: new Date(),
        })
        .where(eq(fundingRounds.id, fix.round));
      out.applied++;
      continue;
    }

    // Re-date.
    const sourceId = canonicalUrl(fix.evidence.url);
    const [linked] = await handle
      .select({ sourceId: roundSources.sourceId })
      .from(roundSources)
      .where(and(eq(roundSources.roundId, fix.round), eq(roundSources.sourceId, sourceId)));
    const amount = fix.amount_as_written ? parseAmount(fix.amount_as_written) : null;
    if (amount && (amount.value === null || amount.currency !== "USD")) {
      say(`refuse redate ${fix.round}: amount ${fix.amount_as_written} is not a USD figure the repair can store without a rate`);
      out.refused++;
      continue;
    }
    const clearAmount = fix.amount_as_written === null;
    const amountDone = fix.amount_as_written === undefined || row.amountAsWritten === fix.amount_as_written;
    const disposition = clearAmount && !amountDone && row.disposition === "publish" ? "flagged" : row.disposition;
    const stageDone =
      (fix.stage_as_written === undefined || row.stageAsWritten === fix.stage_as_written) &&
      (fix.is_extension === undefined || row.isExtension === fix.is_extension);
    if (row.announcedOn === fix.announced_on && row.datePrecision === "day" && linked && amountDone && stageDone) {
      // Applied before pins existed: the day is right but a later reading could still move it.
      if (row.pinned?.announced_on === fix.announced_on) {
        say(`skip redate ${fix.round}: already ${fix.announced_on} with ${fix.evidence.url}, pinned`);
        out.skipped++;
        continue;
      }
      say(`pin redate ${fix.round}: already ${fix.announced_on} with ${fix.evidence.url}; pinned so no later reading moves it`);
      if (opts.apply) {
        await handle
          .update(fundingRounds)
          .set({ pinned: { ...(row.pinned ?? {}), announced_on: fix.announced_on }, updatedAt: new Date() })
          .where(eq(fundingRounds.id, fix.round));
        out.applied++;
      }
      continue;
    }
    if (row.announcedOn !== fix.from && row.announcedOn !== fix.announced_on) {
      say(`refuse redate ${fix.round}: announced_on is ${row.announcedOn ?? "none"}, expected ${fix.from}`);
      out.refused++;
      continue;
    }
    const noteLine = `date ${row.announcedOn ?? "none"} (${row.datePrecision}) read as ${fix.announced_on} (day, ${hostOf(fix.evidence.url)}): ${fix.note}`;
    say(
      `redate ${fix.round}: ${row.announcedOn ?? "none"} (${row.datePrecision}, ${row.dateBasis ?? "basis unknown"}) -> ${fix.announced_on} (day, ${fix.basis}); ${disposition === row.disposition ? `${row.disposition} stays` : `${row.disposition} -> ${disposition}`}`,
    );
    say(`  evidence: ${fix.evidence.url} (${fix.evidence.published})${linked ? ", already a source" : ", added as a source"}`);
    if (fix.amount_as_written !== undefined && !amountDone)
      say(`  amount: ${row.amountAsWritten ?? "none"} -> ${fix.amount_as_written ?? "none"}`);
    if (fix.stage_as_written !== undefined && row.stageAsWritten !== fix.stage_as_written)
      say(`  stage as written: ${row.stageAsWritten} -> ${fix.stage_as_written}`);
    if (fix.is_extension !== undefined && row.isExtension !== fix.is_extension)
      say(`  extension: ${row.isExtension} -> ${fix.is_extension}`);
    say(`  note: ${noteLine}`);
    if (!opts.apply) continue;

    const quotes = (row.evidenceQuotes as string[] | null) ?? [];
    const notes = verification.notes.includes(noteLine) ? verification.notes : [...verification.notes, noteLine];
    await handle
      .update(fundingRounds)
      .set({
        announcedOn: fix.announced_on,
        datePrecision: "day",
        dateBasis: fix.basis,
        pinned: { ...(row.pinned ?? {}), announced_on: fix.announced_on },
        ...(fix.evidence.quote && !quotes.includes(fix.evidence.quote) ? { evidenceQuotes: [...quotes, fix.evidence.quote] } : {}),
        ...(amount && amount.value !== null
          ? {
              amountAsWritten: fix.amount_as_written,
              amountValue: amount.value.toString(),
              amountCurrency: "USD",
              amountUsdMillions: amount.value.toString(),
              fxRate: "1",
              fxDate: fix.announced_on,
            }
          : {}),
        ...(clearAmount
          ? {
              amountAsWritten: null,
              amountValue: null,
              amountCurrency: null,
              amountUsdMillions: null,
              fxRate: null,
              fxDate: null,
              disposition,
            }
          : {}),
        ...(fix.stage_as_written !== undefined ? { stageAsWritten: fix.stage_as_written } : {}),
        ...(fix.is_extension !== undefined ? { isExtension: fix.is_extension } : {}),
        verification: { ...verification, notes },
        // A changed fact is news only to someone who already read the row.
        status: sql`CASE WHEN ${fundingRounds.status} = 'seen' THEN 'updated' ELSE ${fundingRounds.status} END`,
        updatedAt: new Date(),
      })
      .where(eq(fundingRounds.id, fix.round));
    await handle
      .insert(sources)
      .values({
        id: sourceId,
        url: sourceId,
        host: hostOf(fix.evidence.url),
        title: fix.evidence.title,
        publishedAt: fix.evidence.published,
        query: "repair",
      })
      .onConflictDoNothing();
    await handle.insert(roundSources).values({ roundId: fix.round, sourceId }).onConflictDoNothing();
    redated.add(row.companyId);
    out.applied++;
  }
  // A re-dated row can land on a round the store already holds under its true date (Keyfactor's
  // September row moved onto its July one), so each company a re-date touched gets the same-company pass.
  for (const companyId of redated) {
    const { merged } = await mergeDuplicateRounds(handle, { companyId });
    if (merged > 0) say(`merged ${merged} round(s) of ${companyId} that the re-date made one round`);
  }
  if (!opts.apply && fixes.some((f) => f.kind === "redate")) {
    say("on --apply, each re-dated company's rounds are checked again and merged where they are now one round");
  }
  return out;
}
