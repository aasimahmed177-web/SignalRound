// Companies saved under a slug or a lowercase name ("sandboxaq", "firstdue", "hub-international")
// while the pages behind their rounds write the name properly ("SandboxAQ", "First Due"). The
// proper name is read from the company's own evidence: its rounds' quotes, its sources' titles, and
// its homepage's site name and brand. Display name and name key only; the id, and so every URL, stays.

import { normalizeCompanyKey } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray } from "drizzle-orm";

const { companies, companyAliases, enrichments, fundingRounds, roundSources, sources } = schema;

function squash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function domainLabel(domain: string | null): string {
  return (domain ?? "").replace(/^www\./, "").split(".")[0] ?? "";
}

/**
 * Whether a stored name is a slug rather than a name: written all in lowercase ("sandboxaq",
 * "hub-international", "manychat.com"). A name with any capital is the way someone wrote it.
 */
export function slugLikeName(name: string): boolean {
  return /\p{L}/u.test(name) && name === name.toLowerCase();
}

/** The words a text writes a name with, one to three at a time, without the punctuation around them. */
function spellings(text: string, target: string): Array<{ variant: string; start: boolean }> {
  const words = text.split(/\s+/).filter(Boolean);
  const out: Array<{ variant: string; start: boolean }> = [];
  for (let i = 0; i < words.length; i++)
    for (let n = 1; n <= 3 && i + n <= words.length; n++) {
      const variant = words
        .slice(i, i + n)
        .join(" ")
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
        .replace(/['\u2019]s$/u, "");
      if (squash(variant) === target) out.push({ variant, start: i === 0 || /[.!?:]$/.test(words[i - 1] ?? "") });
    }
  return out;
}

/**
 * The name a company's evidence writes, when it writes the stored slug with capitals: the company's
 * own site's spelling first, else the most frequent one found at least twice. A spelling that only
 * raises the first letter does not count at the start of a sentence, where every word is capitalized,
 * and is reported as weaker; one in capitals throughout is a headline's unless the site writes it so.
 * A company whose own site writes it in lowercase ("bunq", "noon.com") keeps its name. Null when no
 * evidence names it otherwise.
 */
export function properNameIn(
  name: string,
  domain: string | null,
  evidence: { texts: string[]; site: string[] },
): { name: string; count: number; initialOnly: boolean } | null {
  const label = domainLabel(domain);
  const target = squash(name) === squash(domain ?? "") ? squash(label) : squash(name);
  if (target.length < 2) return null;
  if (evidence.site.some((s) => s === s.toLowerCase() && (squash(s) === target || squash(s) === squash(domain ?? "")))) return null;
  const counts = new Map<string, number>();
  const own = new Set<string>();
  const capitalized = name.toLowerCase().charAt(0).toUpperCase() + name.toLowerCase().slice(1);
  const tally = (text: string, site: boolean) => {
    for (const { variant, start } of spellings(text, target)) {
      if (variant === variant.toLowerCase() || variant === name) continue;
      if (start && !site && variant === capitalized) continue;
      counts.set(variant, (counts.get(variant) ?? 0) + 1);
      if (site) own.add(variant);
    }
  };
  for (const t of evidence.texts) tally(t, false);
  for (const s of evidence.site) tally(s, true);
  const shouted = (v: string) => v === v.toUpperCase() && !own.has(v);
  const ranked = [...counts]
    .filter(([v, c]) => (c >= 2 || own.has(v)) && !shouted(v))
    .sort((a, b) => Number(own.has(b[0])) - Number(own.has(a[0])) || b[1] - a[1]);
  const best = ranked[0];
  if (!best) return null;
  return { name: best[0], count: best[1], initialOnly: best[0] === capitalized };
}

export interface CompanyNameRepair {
  id: string;
  from: string;
  to: string;
  count: number;
  /** Only the first letter differs: the press capitalizes a lowercase brand too, so read these first. */
  initialOnly: boolean;
  example: string | null;
}

/** Every company whose stored name is a slug while its evidence writes a proper name. Reads only. */
export async function planCompanyNameRepair(handle: Db): Promise<CompanyNameRepair[]> {
  const rows = (await handle.select({ id: companies.id, name: companies.name, domain: companies.domain }).from(companies)).filter((r) =>
    slugLikeName(r.name),
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const rounds = await handle
    .select({ id: fundingRounds.id, companyId: fundingRounds.companyId, quotes: fundingRounds.evidenceQuotes })
    .from(fundingRounds)
    .where(inArray(fundingRounds.companyId, ids));
  const titles = await handle
    .select({ companyId: fundingRounds.companyId, title: sources.title, url: sources.url })
    .from(roundSources)
    .innerJoin(fundingRounds, eq(fundingRounds.id, roundSources.roundId))
    .innerJoin(sources, eq(sources.id, roundSources.sourceId))
    .where(inArray(fundingRounds.companyId, ids));
  const profiles = await handle
    .select({ companyId: enrichments.companyId, data: enrichments.data })
    .from(enrichments)
    .where(and(eq(enrichments.kind, "profile"), inArray(enrichments.companyId, ids)));
  const plan: CompanyNameRepair[] = [];
  for (const row of rows) {
    const data = profiles.find((p) => p.companyId === row.id)?.data as
      | { site_name?: string | null; brand?: { name?: string | null } }
      | undefined;
    const site = [data?.site_name, data?.brand?.name].filter((s): s is string => Boolean(s?.trim()));
    const own = titles.filter((t) => t.companyId === row.id);
    const texts = [...rounds.filter((r) => r.companyId === row.id).flatMap((r) => r.quotes ?? []), ...own.map((t) => t.title ?? "")];
    const found = properNameIn(row.name, row.domain, { texts, site });
    if (!found) continue;
    const example = own.find((t) => t.title?.includes(found.name))?.url ?? null;
    plan.push({ id: row.id, from: row.name, to: found.name, count: found.count, initialOnly: found.initialOnly, example });
  }
  return plan.sort((a, b) => Number(a.initialOnly) - Number(b.initialOnly) || a.id.localeCompare(b.id));
}

/**
 * Carry out a plan, one row at a time and only while the row still holds the name the plan read. When
 * the name key changes ("firstdue" to "first due") the old name stays as one of the company's names,
 * so a reading that writes the slug still finds it. Returns the rows renamed.
 */
export async function applyCompanyNameRepair(handle: Db, plan: CompanyNameRepair[]): Promise<CompanyNameRepair[]> {
  const done: CompanyNameRepair[] = [];
  for (const r of plan) {
    const renamed = await handle
      .update(companies)
      .set({ name: r.to, nameKey: normalizeCompanyKey(r.to), updatedAt: new Date() })
      .where(and(eq(companies.id, r.id), eq(companies.name, r.from)))
      .returning({ id: companies.id });
    if (renamed.length === 0) continue;
    const oldKey = normalizeCompanyKey(r.from);
    if (oldKey && oldKey !== normalizeCompanyKey(r.to))
      await handle
        .insert(companyAliases)
        .values({ companyId: r.id, kind: "name", aliasKey: oldKey, alias: r.from, sourceUrl: r.example })
        .onConflictDoNothing();
    done.push(r);
  }
  return done;
}
