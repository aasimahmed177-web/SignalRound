// The rename backfill behind `pnpm clean-company-ids`: every company whose id is not clean
// (lib/company-ids.ts) moves to one that is. The id is the company's own domain when its homepage
// verified (the profile's website is that domain), else its name key hyphenated, numbered when a live
// row or a folded id already holds it; the most visible company of a name gets the plain slug. Each
// rename is a fold with `renamed` set (renameCompany in lib/persist.ts), so the old URL answers with
// a permanent redirect, and every round, enrichment, alias, ledger row, and flag moves with it.

import type { Enrichment } from "@fireround/core";
import { registrableDomain } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { inArray, sql } from "drizzle-orm";
import { companySlug, isCleanCompanyId, nextFreeId } from "./company-ids.ts";
import { isVerified } from "./enrich.ts";
import { renameCompany } from "./persist.ts";

export interface RenameCandidate {
  id: string;
  name: string;
  nameKey: string;
  domain: string | null;
  /** The profile verified a homepage on this very domain. */
  verifiedDomain: boolean;
  rounds: number;
  /** Published rounds that are not history: what a visitor or a post links to. */
  published: number;
}

export interface CompanyRename {
  from: string;
  to: string;
  /** domain: the verified domain; name: the name key hyphenated; numbered: that, with the next free number. */
  basis: "domain" | "name" | "numbered";
  name: string;
  rounds: number;
  published: number;
}

/** The new id for each unclean company, given every id already spoken for (clean live ids and folded ids). */
export function planRenames(candidates: RenameCandidate[], taken: ReadonlySet<string>): CompanyRename[] {
  const held = new Set(taken);
  const ordered = [...candidates].sort((a, b) => b.published - a.published || b.rounds - a.rounds || a.id.localeCompare(b.id));
  return ordered.map((c) => {
    let to: string;
    let basis: CompanyRename["basis"];
    if (c.verifiedDomain && c.domain && isCleanCompanyId(c.domain) && !held.has(c.domain)) {
      to = c.domain;
      basis = "domain";
    } else {
      const slug = companySlug(c.nameKey || c.name);
      to = nextFreeId(slug, held);
      basis = to === slug ? "name" : "numbered";
    }
    held.add(to);
    return { from: c.id, to, basis, name: c.name, rounds: c.rounds, published: c.published };
  });
}

/** Reads only: the unclean companies with what the plan weighs, and every id already spoken for. */
export async function loadRenamePlan(handle: Db): Promise<CompanyRename[]> {
  const res = await handle.execute(sql`
    select c.id, c.name, c.name_key, c.domain, e.data as profile,
      count(r.id)::int as rounds,
      count(r.id) filter (where r.disposition = 'publish' and not r.history)::int as published
    from companies c
    left join enrichments e on e.company_id = c.id and e.kind = 'profile'
    left join funding_rounds r on r.company_id = c.id
    group by c.id, e.data`);
  const rows = res.rows as Array<{
    id: string;
    name: string;
    name_key: string;
    domain: string | null;
    profile: Enrichment | null;
    rounds: number;
    published: number;
  }>;
  const folds = await handle.select({ id: schema.companyFolds.fromId }).from(schema.companyFolds);
  const taken = new Set([...rows.map((r) => r.id).filter(isCleanCompanyId), ...folds.map((f) => f.id)]);
  const candidates = rows
    .filter((r) => !isCleanCompanyId(r.id))
    .map((r) => ({
      id: r.id,
      name: r.name,
      nameKey: r.name_key,
      domain: r.domain,
      verifiedDomain: Boolean(r.profile && r.domain && isVerified(r.profile) && registrableDomain(r.profile.company_website) === r.domain),
      rounds: Number(r.rounds),
      published: Number(r.published),
    }));
  return planRenames(candidates, taken);
}

/** Every row a rename of these companies touches, by table, for the backup taken before writing. */
export async function renameBackup(handle: Db, ids: string[]): Promise<Record<string, unknown[]>> {
  if (ids.length === 0) return {};
  const s = schema;
  const [companies, rounds, enrichments, aliases, newsrooms, scans, history, requests, trending, flags, memory, folds] = await Promise.all([
    handle.select().from(s.companies).where(inArray(s.companies.id, ids)),
    handle
      .select({ id: s.fundingRounds.id, companyId: s.fundingRounds.companyId })
      .from(s.fundingRounds)
      .where(inArray(s.fundingRounds.companyId, ids)),
    handle.select().from(s.enrichments).where(inArray(s.enrichments.companyId, ids)),
    handle.select().from(s.companyAliases).where(inArray(s.companyAliases.companyId, ids)),
    handle.select().from(s.companyNewsrooms).where(inArray(s.companyNewsrooms.companyId, ids)),
    handle.select().from(s.companyNewsroomScans).where(inArray(s.companyNewsroomScans.companyId, ids)),
    handle.select().from(s.historyPromotions).where(inArray(s.historyPromotions.companyId, ids)),
    handle.select().from(s.companyRequests).where(inArray(s.companyRequests.companyId, ids)),
    handle.select().from(s.trendingRounds).where(inArray(s.trendingRounds.companyId, ids)),
    handle.select().from(s.accuracyFlags).where(inArray(s.accuracyFlags.companyId, ids)),
    handle.select().from(s.accuracyMemory).where(inArray(s.accuracyMemory.companyId, ids)),
    handle.select().from(s.companyFolds).where(inArray(s.companyFolds.intoId, ids)),
  ]);
  return {
    companies,
    funding_rounds: rounds,
    enrichments,
    company_aliases: aliases,
    company_newsrooms: newsrooms,
    company_newsroom_scans: scans,
    history_promotions: history,
    company_requests: requests,
    trending_rounds: trending,
    accuracy_flags: flags,
    accuracy_memory: memory,
    company_folds: folds,
  };
}

/** Carry the plan out, one transaction a company. A rename whose new id was taken since the plan is skipped; run again. */
export async function applyRenames(handle: Db, plan: CompanyRename[]): Promise<{ renamed: number; skipped: string[] }> {
  let renamed = 0;
  const skipped: string[] = [];
  for (const r of plan) {
    if (await renameCompany(handle, r.from, r.to)) renamed++;
    else skipped.push(r.from);
  }
  return { renamed, skipped };
}
