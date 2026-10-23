"use server";

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { start } from "workflow/api";
import { type ActionResult, attempt } from "@/lib/action-result";
import { requireDashboard } from "@/lib/dashboard-auth.server";
import { db } from "@/lib/db";
import { DossierCheckUnavailable, dossierCheckAvailable } from "@/lib/dossier-check";
import { clearProfile, enrichBatch, isVerified } from "@/lib/enrich";
import { invalidateEntityPages } from "@/lib/entity-invalidation";
import { companyHref } from "@/lib/links";
import { getCoverage } from "@/lib/settings";
import { getWebClient } from "@/lib/web-client";
import { companyDossierWorkflow } from "@/workflows/dossiers";

export interface DeepDiveActionResult {
  status: "started";
}

/**
 * Start a deep dive for one company: the durable one-company workflow in workflows/dossiers.ts
 * starts the agent, waits for it in steps, checks the dossier against its sources, and saves only
 * what the check keeps. The action returns once the run is queued; a dive at effort high takes
 * several minutes, longer than a page should hold a request open.
 *
 * Refused up front when no model is configured to check the result: an unchecked dossier is never
 * saved, so the credits would buy nothing.
 *
 * Admin only, in a public demo too: a visitor pressing it a few hundred times is a few hundred
 * thousand credits. The demo still shows dossiers, because the Max rung builds one for every new
 * company on its own (lib/intel.ts deepDiveTargets, worked by workflows/dossiers.ts).
 */
export async function deepDiveCompany(companyId: string): Promise<ActionResult<{ value: DeepDiveActionResult }>> {
  return attempt(async () => {
    await requireDashboard();
    const handle = await db();
    const [company] = await handle
      .select({ id: schema.companies.id })
      .from(schema.companies)
      .where(eq(schema.companies.id, companyId))
      .limit(1);
    if (!company) throw new Error(`No company ${companyId}`);
    if (!dossierCheckAvailable()) throw new DossierCheckUnavailable();
    await start(companyDossierWorkflow, [companyId]);
    revalidatePath("/runs");
    return { status: "started" as const };
  });
}

export interface ReenrichActionResult {
  status: "verified" | "unverified";
  /** The homepage the identity check accepted, or null. */
  website: string | null;
  /** Why nothing was written, when nothing was: the hosts tried and what each turned out to be. */
  error: string | null;
  creditsEstimated: number;
}

/**
 * Redo one company's profile: forget what the last enrichment learned (the profile row, the
 * logo, a website the old search guessed) and run the enrichment step once for this company,
 * grounded in the record's description and verified against the homepage before anything is
 * written. For a profile that named a namesake, this is the repair.
 */
export async function reenrichCompany(companyId: string): Promise<ActionResult<{ value: ReenrichActionResult }>> {
  return attempt(async () => {
    await requireDashboard();
    const handle = await db();
    await clearProfile(handle, companyId);
    await invalidateEntityPages(handle, { companyIds: [companyId] });
    const [company] = await handle
      .select({
        id: schema.companies.id,
        name: schema.companies.name,
        website: schema.companies.website,
        description: schema.companies.description,
        hq: schema.companies.hq,
        sector: schema.companies.sector,
      })
      .from(schema.companies)
      .where(eq(schema.companies.id, companyId))
      .limit(1);
    if (!company) throw new Error(`No company ${companyId}`);
    const plan = await getCoverage(handle);
    const result = await enrichBatch(handle, getWebClient(), [company], { pricingPage: plan.enrichment !== "homepage" });
    await invalidateEntityPages(handle, { companyIds: [companyId] });
    const [e] = result.enrichments;
    revalidatePath(companyHref(companyId));
    revalidatePath("/feed");
    return {
      status: e && isVerified(e) ? "verified" : "unverified",
      website: e?.company_website ?? null,
      error: e?.error ?? null,
      creditsEstimated: result.credits,
    };
  });
}
