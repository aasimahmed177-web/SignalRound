// The investor directory under today's name hygiene (packages/core/src/records/investors.ts and
// keys.ts). Rows written before a rule existed keep their old id and name: "executives from OpenAI"
// and "a syndicated group of individual investors" had pages of their own, "a16z's Speedrun
// accelerator" sat beside "a16z speedrun", and "Wells Fargo & Co" keyed as "wells fargo and".
// Display hygiene rides along: a name whose key stays but whose shown form changes ("Eli Lilly (NYSE:
// LLY)", "Arm Holdings Inc") is renamed in place.
// `pnpm repair-investors` prints the plan and, with --apply, carries it out.

import { investorKeyForMerge, normalizeInvestorName } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, isNull, sql } from "drizzle-orm";

const { investors, investorFolds, roundInvestors } = schema;

/**
 * Record that an investor id now lives on another row, so its old page and API id lead there: ids
 * folded into the old one before follow it, and a row that comes back under the survivor's id is not
 * left pointing at itself.
 */
export async function recordInvestorFold(handle: Db, fromId: string, intoId: string): Promise<void> {
  if (fromId === intoId) return;
  await handle.update(investorFolds).set({ intoId }).where(eq(investorFolds.intoId, fromId));
  await handle
    .insert(investorFolds)
    .values({ fromId, intoId })
    .onConflictDoUpdate({ target: investorFolds.fromId, set: { intoId, foldedAt: new Date() } });
  await handle.delete(investorFolds).where(eq(investorFolds.fromId, intoId));
}

export interface InvestorRepairPlan {
  /** Rows that name nobody in particular: their links come off every round, and the row goes. */
  drop: Array<{ id: string; name: string; rounds: string[] }>;
  /** Rows that are another row's firm under today's key: links move to `into`, the row goes. */
  merge: Array<{ id: string; name: string; into: string; intoName: string; rounds: string[] }>;
  /** Rows no round links to anymore (a merge or a prune left them): the directory never showed them. */
  orphans: string[];
  /**
   * Rows whose key stays but whose shown name changes under today's display hygiene: "Eli Lilly (NYSE:
   * LLY)" is Eli Lilly, "Arm Holdings Inc" is Arm Holdings. Only the name is written.
   */
  rename: Array<{ id: string; name: string; to: string; domain?: string }>;
  /** Decisions whose row no longer holds the name they were made about: skipped, for a person to look at again. */
  stale: Array<{ id: string; expected: string; found: string | null }>;
  /**
   * Merges refused because the row already under the new key is another firm by its words ("Sovereign's
   * Capital" keys as "sovereign", where "Sovereign AI" already sits): left for a person.
   */
  conflicts: Array<{ id: string; name: string; into: string; intoName: string }>;
}

/** Nouns that name a kind of vehicle, not which one: "Fund", "Capital", "Venture Partners". */
const VEHICLE_WORDS = new Set([
  "fund",
  "funds",
  "capital",
  "venture",
  "ventures",
  "partners",
  "group",
  "holdings",
  "management",
  "investment",
  "investments",
  "vc",
]);

/** Words that say nothing about which firm a name is. */
const FILLER_WORDS = new Set(["the", "of", "and", "s", "co", "company", "inc", "llc", "ltd"]);

/**
 * A name's own words, with the key's short forms expanded but none of its tail words dropped: the key
 * folds "Sovereign's Capital" and "Sovereign AI" to one "sovereign", and their words tell them apart.
 */
function nameWords(name: string): Set<string> {
  const words = name
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['\u2019]s\b/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !FILLER_WORDS.has(w))
    // The key's short forms and its one rename (a16z's CSX accelerator became speedrun).
    .flatMap((w) => (w === "a16z" ? ["andreessen", "horowitz"] : w === "csx" ? ["speedrun"] : [w]));
  return new Set(words);
}

/** One set of words holds the other: "Slauson & Co" and "Slauson & Company", "a16z speedrun" and "a16z's Speedrun accelerator". */
function compatible(a: string, b: string): boolean {
  const x = nameWords(a);
  const y = nameWords(b);
  return [...x].every((w) => y.has(w)) || [...y].every((w) => x.has(w));
}

/**
 * The key of the vehicle an owner's possessive names, when the directory already holds that vehicle
 * under its own name: "Toyota's Woven Capital" is the "Woven Capital" row, "Nvidia's NVentures" the
 * "NVentures" row. Name rules alone cannot tell this from a possessive inside a name ("Monk's Hill
 * Ventures"), so it needs a row with exactly the vehicle's words to exist ("Sovereign's Capital" is
 * not "Capital Group"), and a vehicle of its own name: in "Founder's Fund", "Let's Venture" or
 * "Sovereign's Capital" the possessive is the name, and the bare "Fund" after it is not the "Fund+" row.
 */
function ownedVehicleKey(name: string, namesByKey: Map<string, string>): string | null {
  const vehicle = /^.+?['\u2019]s\s+([A-Z0-9].*)$/.exec(name)?.[1]?.trim();
  if (!vehicle || [...nameWords(vehicle)].every((w) => VEHICLE_WORDS.has(w))) return null;
  const key = investorKeyForMerge(vehicle);
  const stored = namesByKey.get(key);
  if (!stored) return null;
  const [a, b] = [nameWords(vehicle), nameWords(stored)];
  return a.size === b.size && [...a].every((w) => b.has(w)) ? key : null;
}

/**
 * A held case a person decided, with the page that decided it, so the repair can carry it out:
 * "rename" gives a row the name (and the site) of the firm its rounds really name, when the key once
 * sent another firm's rounds to it; "merge" folds a row into another the words alone kept apart.
 * Each names what the row holds now, so a row that has moved on is skipped, not rewritten.
 */
export type InvestorDecision =
  | { kind: "rename"; id: string; from: string; to: string; domain?: string; reason: string; evidence: string }
  | { kind: "merge"; id: string; from: string; into: string; reason: string; evidence: string };

/** What today's rules make of every stored investor, reading only, with a person's decisions carried out first. */
export async function planInvestorRepair(handle: Db, decisions: InvestorDecision[] = []): Promise<InvestorRepairPlan> {
  const stored = await handle.select({ id: investors.id, name: investors.name }).from(investors);
  const links = await handle.select({ roundId: roundInvestors.roundId, investorId: roundInvestors.investorId }).from(roundInvestors);
  const roundsOf = new Map<string, string[]>();
  for (const l of links) roundsOf.set(l.investorId, [...(roundsOf.get(l.investorId) ?? []), l.roundId]);
  const plan: InvestorRepairPlan = { drop: [], merge: [], orphans: [], conflicts: [], rename: [], stale: [] };
  const found = new Map(stored.map((r) => [r.id, r.name]));
  const decided = new Set<string>();
  for (const d of decisions) {
    if (found.get(d.id) !== d.from) {
      plan.stale.push({ id: d.id, expected: d.from, found: found.get(d.id) ?? null });
      continue;
    }
    decided.add(d.id);
    if (d.kind === "rename") plan.rename.push({ id: d.id, name: d.from, to: d.to, domain: d.domain });
    else if (found.has(d.into))
      plan.merge.push({ id: d.id, name: d.from, into: d.into, intoName: found.get(d.into) ?? d.into, rounds: roundsOf.get(d.id) ?? [] });
    else plan.stale.push({ id: d.into, expected: "a row to merge into", found: null });
  }
  // The rules read a renamed row under its new name; a merged one is done.
  const rows = stored.flatMap((r) => {
    const renamed = decisions.find((d) => d.kind === "rename" && d.id === r.id && decided.has(r.id));
    if (renamed?.kind === "rename") return [{ id: r.id, name: renamed.to }];
    return decided.has(r.id) ? [] : [r];
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Names under the keys the directory will hold: today's rows, and the keys a merge will create.
  const namesByKey = new Map(rows.map((r) => [r.id, r.name]));
  for (const r of rows) {
    const clean = normalizeInvestorName(r.name);
    const key = clean ? investorKeyForMerge(clean) : "";
    if (clean && key && !namesByKey.has(key)) namesByKey.set(key, clean);
  }
  // Where each linked row goes under today's key, first, so a row that is itself moving off a key
  // ("Sovereign AI" leaving "sovereign") frees it for the firm that belongs there in the same pass.
  const moves: Array<{ r: (typeof rows)[number]; clean: string; into: string; rounds: string[] }> = [];
  for (const r of rows) {
    const rounds = roundsOf.get(r.id) ?? [];
    if (rounds.length === 0) {
      plan.orphans.push(r.id);
      continue;
    }
    const clean = normalizeInvestorName(r.name);
    if (!clean) {
      plan.drop.push({ id: r.id, name: r.name, rounds });
      continue;
    }
    const into = ownedVehicleKey(clean, namesByKey) ?? investorKeyForMerge(clean);
    if (!into) continue;
    if (into === r.id) {
      // A name that differs only by trailing punctuation ("WS Investment Co.") is not worth a write.
      if (clean !== r.name.replace(/[\s,;.]+$/, "")) plan.rename.push({ id: r.id, name: r.name, to: clean });
      continue;
    }
    moves.push({ r, clean, into, rounds });
  }
  const leaving = new Set(moves.map((m) => m.r.id));
  const merges: InvestorRepairPlan["merge"] = [];
  for (const { r, clean, into, rounds } of moves) {
    const existing = leaving.has(into) ? undefined : byId.get(into);
    if (existing && !compatible(clean, existing.name)) {
      plan.conflicts.push({ id: r.id, name: r.name, into, intoName: existing.name });
      continue;
    }
    // A key the row holding it is leaving gets the newcomer's name, not the leaving row's.
    const intoName = existing?.name ?? (leaving.has(into) ? clean : (namesByKey.get(into) ?? clean));
    merges.push({ id: r.id, name: r.name, into, intoName, rounds });
  }
  // A row that vacates a key merges before the row that moves into it, so the newcomer's links never
  // land on the leaving row and travel with it.
  const vacates = (m: (typeof merges)[number]) => merges.some((o) => o.into === m.id);
  plan.merge.push(...merges.filter(vacates), ...merges.filter((m) => !vacates(m)));
  return plan;
}

/**
 * Carry out a plan. A merge keeps the target's row (created with the cleaned name, and the old row's
 * website, logo, and profile, when none exists),
 * moves each link over with the higher role when the round already links the target, and deletes the
 * old row; a drop deletes the links and the row; orphans go last. Each step is safe to repeat.
 */
export async function applyInvestorRepair(
  handle: Db,
  plan: InvestorRepairPlan,
): Promise<{ merged: number; dropped: number; orphans: number; renamed: number }> {
  for (const m of plan.merge) {
    const [from] = await handle.select().from(investors).where(eq(investors.id, m.id));
    if (!from) continue;
    await handle
      .insert(investors)
      .values({
        id: m.into,
        name: m.intoName,
        domain: from.domain,
        domainCheckedAt: from.domainCheckedAt,
        logoUrl: from.logoUrl,
        logoCheckedAt: from.logoCheckedAt,
        kind: from.kind,
        description: from.description,
        headquarters: from.headquarters,
      })
      .onConflictDoNothing();
    // A target that already existed without a website takes the merged row's, with its logo and profile.
    if (from.domain) {
      await handle
        .update(investors)
        .set({
          domain: from.domain,
          domainCheckedAt: from.domainCheckedAt,
          logoUrl: from.logoUrl,
          logoCheckedAt: from.logoCheckedAt,
          kind: from.kind,
          description: from.description,
          headquarters: from.headquarters,
        })
        .where(and(eq(investors.id, m.into), isNull(investors.domain)));
    }
    await handle.execute(
      sql`insert into round_investors (round_id, investor_id, role) select round_id, ${m.into}, role from round_investors where investor_id = ${m.id}
          on conflict (round_id, investor_id) do update set role = case when excluded.role = 'lead' then excluded.role else round_investors.role end`,
    );
    await handle.delete(roundInvestors).where(eq(roundInvestors.investorId, m.id));
    await handle.delete(investors).where(eq(investors.id, m.id));
    await recordInvestorFold(handle, m.id, m.into);
  }
  for (const r of plan.rename) {
    const site = r.domain ? { domain: r.domain, domainCheckedAt: new Date(), logoUrl: null, logoCheckedAt: null } : {};
    await handle
      .update(investors)
      .set({ name: r.to, ...site })
      .where(and(eq(investors.id, r.id), eq(investors.name, r.name)));
  }
  for (const d of plan.drop) {
    await handle.delete(roundInvestors).where(eq(roundInvestors.investorId, d.id));
    await handle.delete(investors).where(eq(investors.id, d.id));
  }
  const orphaned = await handle.execute(
    sql`delete from investors i where not exists (select 1 from round_investors ri where ri.investor_id = i.id)`,
  );
  return { merged: plan.merge.length, dropped: plan.drop.length, orphans: Number(orphaned.rowCount ?? 0), renamed: plan.rename.length };
}
