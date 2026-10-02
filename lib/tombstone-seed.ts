// Seeding merge tombstones from merges applied before round_merges existed (scripts/maintenance/seed-tombstones.ts).
// The record of those merges is the operator's files: `pnpm fix-records --apply` logs, fix files with
// `merge` entries, and the CSV backups taken before a merge. Every pair is checked against the store
// before a tombstone is written: the dropped row must be gone and the kept row (or the row it was later
// merged into) must be there.

import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { inArray, sql } from "drizzle-orm";
import { recordTombstone, tombstoneTargets } from "./persist.ts";

const { fundingRounds, roundMerges } = schema;

/** One merge as a file records it: the row that went, the row it went into, and where it was read. */
export interface SeedPair {
  drop: string;
  keep: string;
  from: string;
  /**
   * A fix file names a pair, not a direction: the merge picks its survivor by survivorOrder, so the
   * row the file called `drop` may be the one that stayed. The store says which one went.
   */
  unordered?: boolean;
}

/** The merges a `pnpm fix-records --apply` (or merge-duplicate-rounds) log carries: "merge <drop> into <keep> (...)". */
export function parseAppliedMerges(text: string, from: string): SeedPair[] {
  if (!/^APPLY: writing\./m.test(text)) return [];
  const out: SeedPair[] = [];
  for (const m of text.matchAll(/^merge (\S+) into (\S+) \(/gm)) out.push({ drop: m[1] as string, keep: m[2] as string, from });
  return out;
}

/** The `merge` entries of a fix file. Whether each was applied is for the store to say. */
export function parseMergeFixes(json: string, from: string): SeedPair[] {
  let fixes: unknown;
  try {
    fixes = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(fixes)) return [];
  return fixes.flatMap((f) =>
    f && typeof f === "object" && f.kind === "merge" && typeof f.keep === "string" && typeof f.drop === "string"
      ? [{ drop: f.drop, keep: f.keep, from, unordered: true }]
      : [],
  );
}

/** RFC 4180 rows: quoted fields may hold commas, quotes (doubled), and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * A pre-merge backup's round_sources.csv as each backed-up round's source ids. A merge copies every
 * source of the row that goes onto the survivor, so the survivor of a backed-up row now missing from
 * the store is the one row that holds all of its sources.
 */
export function backupSources(roundSourcesCsv: string): Map<string, string[]> {
  const [header, ...rows] = parseCsv(roundSourcesCsv);
  const roundAt = header?.indexOf("round_id") ?? -1;
  const sourceAt = header?.indexOf("source_id") ?? -1;
  const out = new Map<string, string[]>();
  if (roundAt < 0 || sourceAt < 0) return out;
  for (const r of rows) {
    const round = r[roundAt];
    const source = r[sourceAt];
    if (round && source) out.set(round, [...(out.get(round) ?? []), source]);
  }
  return out;
}

/** The backed-up rounds gone from the store, each with the one row that now holds every source it had. */
export async function backupPairs(
  handle: Db,
  sourcesByRound: Map<string, string[]>,
  from: string,
): Promise<{ pairs: SeedPair[]; lines: string[] }> {
  const ids = [...sourcesByRound.keys()];
  const lines: string[] = [];
  if (ids.length === 0) return { pairs: [], lines };
  const present = new Set(
    (await handle.select({ id: fundingRounds.id }).from(fundingRounds).where(inArray(fundingRounds.id, ids))).map((r) => r.id),
  );
  const pairs: SeedPair[] = [];
  for (const [drop, sourceIds] of sourcesByRound) {
    if (present.has(drop)) continue;
    const { rows } = await handle.execute<{ round_id: string }>(
      sql`select round_id from round_sources where source_id in (${sql.join(
        sourceIds.map((s) => sql`${s}`),
        sql`, `,
      )}) group by round_id having count(distinct source_id) = ${new Set(sourceIds).size}`,
    );
    const holders = rows.map((r) => r.round_id).filter((id) => id !== drop);
    if (holders.length === 1) pairs.push({ drop, keep: holders[0] as string, from });
    else
      lines.push(
        `skip ${drop} (${from}): ${holders.length === 0 ? "no row holds all its sources" : `${holders.length} rows hold all its sources: ${holders.join(", ")}`}`,
      );
  }
  return { pairs, lines };
}

/**
 * Check each pair against the store and write the tombstones it confirms. The dropped row must be gone
 * (a row still there was never merged, or was rebuilt and needs a merge first); the kept row must exist,
 * directly or through a later merge (another pair in the batch, or a tombstone already written). The
 * same pair from two files is one tombstone. Without `apply` nothing is written.
 */
export async function seedTombstones(
  handle: Db,
  pairs: SeedPair[],
  opts: { apply: boolean },
): Promise<{ lines: string[]; written: number; skipped: number; refused: number }> {
  const out = { lines: [] as string[], written: 0, skipped: 0, refused: 0 };
  const named = [...new Set(pairs.flatMap((p) => [p.drop, p.keep]))];
  const present = new Set(
    named.length
      ? (await handle.select({ id: fundingRounds.id }).from(fundingRounds).where(inArray(fundingRounds.id, named))).map((r) => r.id)
      : [],
  );
  const directed = pairs.map((p) =>
    p.unordered && present.has(p.drop) && !present.has(p.keep) ? { ...p, drop: p.keep, keep: p.drop } : p,
  );
  const seen = new Map<string, SeedPair>();
  for (const p of directed) {
    const prior = seen.get(p.drop);
    if (!prior) seen.set(p.drop, p);
    else if (prior.keep !== p.keep) {
      out.lines.push(`refuse ${p.drop}: ${prior.from} says into ${prior.keep}, ${p.from} says into ${p.keep}`);
      out.refused++;
    }
  }
  const unique = [...seen.values()];
  const ids = [...new Set(unique.flatMap((p) => [p.drop, p.keep]))];
  // A dry run before the migration reads an empty ledger; a write needs the table.
  const [ready] = (await handle.execute<{ t: string | null }>(sql`select to_regclass('round_merges')::text as t`)).rows;
  if (!ready?.t) {
    out.lines.push("round_merges does not exist yet: every pair is planned as new (run the migration before --apply)");
    if (opts.apply) {
      out.refused++;
      return out;
    }
  }
  const existing = new Map(
    (ids.length && ready?.t ? await handle.select().from(roundMerges).where(inArray(roundMerges.droppedId, ids)) : []).map((t) => [
      t.droppedId,
      t.keptId,
    ]),
  );
  const stored = ready?.t ? await tombstoneTargets(handle, ids) : new Map<string, string>();
  const batch = new Map(unique.map((p) => [p.drop, p.keep]));
  const settle = (id: string): string => {
    const hops = new Set<string>();
    let to = id;
    while (!present.has(to) && !hops.has(to)) {
      hops.add(to);
      const next = batch.get(to) ?? stored.get(to);
      if (!next) break;
      to = next;
    }
    return to;
  };
  for (const p of unique) {
    if (present.has(p.drop)) {
      out.lines.push(`skip ${p.drop} -> ${p.keep} (${p.from}): ${p.drop} is still in the store (never merged, or rebuilt; merge it first)`);
      out.skipped++;
      continue;
    }
    const survivor = settle(p.keep);
    if (!present.has(survivor)) {
      out.lines.push(
        `refuse ${p.drop} -> ${p.keep} (${p.from}): ${p.keep} is not in the store and no merge leads from it to a row that is`,
      );
      out.refused++;
      continue;
    }
    if (existing.get(p.drop) === p.keep || existing.get(p.drop) === survivor) {
      out.lines.push(`skip ${p.drop} -> ${existing.get(p.drop)} (${p.from}): already tombstoned`);
      out.skipped++;
      continue;
    }
    out.lines.push(`tombstone ${p.drop} -> ${p.keep}${survivor === p.keep ? "" : ` (now in ${survivor})`} (${p.from})`);
    out.written++;
    if (opts.apply) await recordTombstone(handle, p.drop, p.keep);
  }
  return out;
}
