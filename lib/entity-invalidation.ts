import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { eq, inArray } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { companyTag, investorTag, TAG_ENTITY_DETAILS } from "@/lib/entity-tags";
import { siteOrigin } from "@/lib/origin";

type ChangedEntities = { companyIds?: string[]; investorIds?: string[]; roundIds?: string[] };

async function invalidateTags(tags: string[]): Promise<void> {
  if (!tags.length) return;
  try {
    for (const tag of tags) revalidateTag(tag, { expire: 0 });
    return;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("static generation store missing")) throw error;
  }
  if (process.env.NODE_ENV === "test" && !process.env.APP_ORIGIN) return;
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET is required to invalidate entity caches outside a Next request");
  const response = await fetch(`${siteOrigin()}/api/cache/invalidate`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ tags }),
  });
  if (!response.ok) throw new Error(`Entity cache invalidation failed (${response.status})`);
}

export async function invalidateAllEntityPages(): Promise<void> {
  await invalidateTags([TAG_ENTITY_DETAILS]);
}

export async function invalidateEntityPages(handle: Db, changed: ChangedEntities): Promise<void> {
  const companies = new Set(changed.companyIds ?? []);
  const investors = new Set(changed.investorIds ?? []);
  if (changed.roundIds?.length) {
    const [rounds, seats] = await Promise.all([
      handle
        .select({ companyId: schema.fundingRounds.companyId })
        .from(schema.fundingRounds)
        .where(inArray(schema.fundingRounds.id, changed.roundIds)),
      handle
        .select({ investorId: schema.roundInvestors.investorId })
        .from(schema.roundInvestors)
        .where(inArray(schema.roundInvestors.roundId, changed.roundIds)),
    ]);
    for (const row of rounds) companies.add(row.companyId);
    for (const row of seats) investors.add(row.investorId);
  }
  const [relatedInvestors, relatedCompanies] = await Promise.all([
    companies.size
      ? handle
          .select({ investorId: schema.roundInvestors.investorId })
          .from(schema.fundingRounds)
          .innerJoin(schema.roundInvestors, eq(schema.roundInvestors.roundId, schema.fundingRounds.id))
          .where(inArray(schema.fundingRounds.companyId, [...companies]))
      : [],
    investors.size
      ? handle
          .select({ companyId: schema.fundingRounds.companyId })
          .from(schema.roundInvestors)
          .innerJoin(schema.fundingRounds, eq(schema.fundingRounds.id, schema.roundInvestors.roundId))
          .where(inArray(schema.roundInvestors.investorId, [...investors]))
      : [],
  ]);
  for (const row of relatedInvestors) investors.add(row.investorId);
  for (const row of relatedCompanies) companies.add(row.companyId);
  await invalidateTags([
    ...[...companies].map(companyTag),
    ...[...investors].map(investorTag),
    ...(changed.roundIds?.length ? [TAG_ENTITY_DETAILS] : []),
  ]);
}
