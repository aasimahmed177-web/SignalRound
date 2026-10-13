import { schema } from "@fireround/core/db";
import type { CompanyRequestStatus, CompanyRequestStep, CompanyRequestTally } from "@fireround/core/db/schema";
import { eq } from "drizzle-orm";
import { tallyMessage } from "@/lib/company-request-status";
import { requestTally } from "@/lib/company-requests";
import { db } from "@/lib/db";
import { dealLanes } from "@/lib/durable";
import { invalidateEntityPages } from "@/lib/entity-invalidation";
import { getFirecrawl } from "@/lib/firecrawl";
import { firecrawlHistoryReader } from "@/lib/history";
import { addTallies, emptyHistoryTally, type HistoryTally, tallyPromotion } from "@/lib/history-tally";
import { companyFromHomepage, fillRequestSector, queueFundingSearch, queueGapSearch, readBrand } from "@/lib/request-research";
import { awaitDiveStep, finishDiveStep, startDiveStep } from "@/workflows/dossiers";
import { processPrior, queueHistoryStep, recordCompanyStep, scheduleHistoryRetryStep } from "@/workflows/history";

const { companyRequests } = schema;

async function markRequest(
  id: string,
  set: {
    status: Exclude<CompanyRequestStatus, "queued">;
    message: string;
    companyId?: string;
    step?: CompanyRequestStep;
    tally?: CompanyRequestTally;
  },
) {
  "use step";
  const handle = await db();
  const [before] = await handle
    .select({ companyId: companyRequests.companyId })
    .from(companyRequests)
    .where(eq(companyRequests.id, id))
    .limit(1);
  await handle
    .update(companyRequests)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(companyRequests.id, id));
  if (set.status === "done" || set.tally) {
    const companyId = set.companyId ?? before?.companyId;
    if (companyId) await invalidateEntityPages(handle, { companyIds: [companyId] });
  }
}

/** A retried step checks the saved profile first, so it never pays twice for a finished identity check. */
export async function researchHomepage(id: string): Promise<{ status: "verified"; companyId: string } | { status: "refused" }> {
  "use step";
  const handle = await db();
  const [request] = await handle.select().from(companyRequests).where(eq(companyRequests.id, id)).limit(1);
  if (!request) throw new Error("Request not found");
  const identity = await companyFromHomepage(handle, getFirecrawl(), {
    domain: request.domain,
    url: request.submittedUrl,
    sites: request.brand?.sites ?? [],
  });
  if (identity.status === "refused") return identity;
  if (identity.fresh) {
    await handle.update(companyRequests).set({ step: "profile", updatedAt: new Date() }).where(eq(companyRequests.id, id));
    await invalidateEntityPages(handle, { companyIds: [identity.companyId] });
  }
  return { status: "verified", companyId: identity.companyId };
}

/** Run the existing durable agent steps without their usual fire-and-forget history hook. */
export async function researchDossier(companyId: string): Promise<"verified" | "failed"> {
  const started = await startDiveStep(companyId, false);
  if ("skipped" in started) return "failed";
  let result: Awaited<ReturnType<typeof awaitDiveStep>> | undefined;
  for (let i = 0; i < 4; i++) {
    result = await awaitDiveStep(started.jobId, started.startedAt, DIVE_POLL_SECONDS);
    if (result.status !== "processing") break;
  }
  if (!result) return "failed";
  const outcome = await finishDiveStep(companyId, started.jobId, result, started.startedAt);
  return outcome.status === "verified" ? "verified" : "failed";
}

/** The request's Deep dive is polled this often: its page is being watched. */
const DIVE_POLL_SECONDS = 3;
/** Earlier rounds verified at once per branch; each is its own chain of durable steps. */
export const VERIFY_CONCURRENCY = 4;

/** The homepage's branding, saved before the identity check so the page shows who it is researching. */
export async function brandStep(id: string): Promise<void> {
  "use step";
  const handle = await db();
  const [request] = await handle
    .select({ url: companyRequests.submittedUrl })
    .from(companyRequests)
    .where(eq(companyRequests.id, id))
    .limit(1);
  if (!request) return;
  const brand = await readBrand(getFirecrawl(), request.url);
  if (brand) await handle.update(companyRequests).set({ brand, updatedAt: new Date() }).where(eq(companyRequests.id, id));
}

/** Targeted searches for the rounds the known ones imply but nobody found; their leads are verified like any other. */
export async function gapSearchStep(companyId: string): Promise<number> {
  "use step";
  return (await queueGapSearch(await db(), firecrawlHistoryReader(getFirecrawl()), companyId)).queued;
}

/** A requested company whose rounds left its sector empty or other takes one from its verified profile or dossier. */
async function sectorStep(companyId: string): Promise<void> {
  "use step";
  const handle = await db();
  await fillRequestSector(handle, companyId);
  await invalidateEntityPages(handle, { companyIds: [companyId] });
}

/** The quick funding search, beside the Deep dive: its candidate rounds join the ledger as leads. */
export async function fundingSearchStep(companyId: string): Promise<number> {
  "use step";
  return (await queueFundingSearch(await db(), firecrawlHistoryReader(getFirecrawl()), companyId)).queued;
}

/**
 * Every earlier round due on the ledger, VERIFY_CONCURRENCY at once. `claimer` keeps two branches
 * from working one round: a round the other branch holds is skipped here and finished there.
 */
export async function verifyDue(companyId: string, claimer: string): Promise<HistoryTally> {
  const keys = await queueHistoryStep(companyId);
  const lanes = await Promise.all(
    dealLanes(keys, VERIFY_CONCURRENCY).map(async (lane) => {
      let tally = emptyHistoryTally();
      for (const key of lane) tally = tallyPromotion(tally, await processPrior(companyId, key, claimer, true));
      return tally;
    }),
  );
  return lanes.reduce(addTallies, emptyHistoryTally());
}

async function tallyStep(companyId: string): Promise<CompanyRequestTally> {
  "use step";
  return requestTally(await db(), companyId);
}

/** The Deep dive's own state on the request, so the page and the admin list can see it run on after the request is done. */
async function markDossier(id: string, status: "running" | "done" | "failed"): Promise<void> {
  "use step";
  const at = new Date();
  await (await db())
    .update(companyRequests)
    .set(status === "running" ? { dossierStatus: status, dossierStartedAt: at } : { dossierStatus: status, dossierFinishedAt: at })
    .where(eq(companyRequests.id, id));
}

/** The request's tally and message read again from the ledger, its status left as it is. */
async function retallyStep(id: string, companyId: string): Promise<void> {
  "use step";
  const handle = await db();
  const tally = await requestTally(handle, companyId);
  await handle
    .update(companyRequests)
    .set({ tally, message: tallyMessage(tally), updatedAt: new Date() })
    .where(eq(companyRequests.id, id));
  await invalidateEntityPages(handle, { companyIds: [companyId] });
}

/**
 * One request: the branding read and the identity check, which gates everything; then the funding
 * search and the Deep dive side by side. The request is done once the search's rounds are verified,
 * so the company page shows what is verified without waiting on the dossier; the Deep dive runs on
 * in the same durable run, and when it lands its rounds are merged into the ledger, verified, and
 * counted, and the page picks them up. Failed rounds are retried by the company's own pass on their
 * backoff, so nothing here waits hours for them.
 */
export async function companyRequestWorkflow(id: string): Promise<void> {
  "use workflow";
  await markRequest(id, { status: "running", message: "Checking the company website.", step: "website" });
  // Once done, the request stays done: a later failure only leaves the dossier or a round unfinished.
  let finished = false;
  try {
    await brandStep(id);
    const identity = await researchHomepage(id);
    if (identity.status === "refused") {
      await markRequest(id, { status: "refused", message: "The website could not be verified as a company homepage." });
      return;
    }
    const { companyId } = identity;
    const startedAt = new Date().toISOString();
    await markRequest(id, { status: "running", message: "Searching for the company's funding announcements.", companyId, step: "history" });
    const [fromDossier, fromSearch] = await Promise.all([
      (async () => {
        await markDossier(id, "running");
        try {
          if ((await researchDossier(companyId)) !== "verified") {
            await markDossier(id, "failed");
            return emptyHistoryTally();
          }
          let tally = await verifyDue(companyId, `request:${id}:dossier`);
          // The dossier's rounds can show a gap the search did not (its Series C with no Series B).
          if ((await gapSearchStep(companyId).catch(() => 0)) > 0)
            tally = addTallies(tally, await verifyDue(companyId, `request:${id}:dossier-gap`));
          await retallyStep(id, companyId);
          await markDossier(id, "done");
          return tally;
        } catch {
          await markDossier(id, "failed");
          return emptyHistoryTally();
        }
      })(),
      (async () => {
        // A search that fails only means fewer leads.
        await fundingSearchStep(companyId).catch(() => 0);
        await markRequest(id, {
          status: "running",
          message: "Verifying earlier rounds against their announcements.",
          companyId,
          step: "rounds",
        });
        let tally = await verifyDue(companyId, `request:${id}:search`);
        // The first pass can leave gaps (a Series C with no Series B): search for exactly those, then verify.
        if ((await gapSearchStep(companyId).catch(() => 0)) > 0) tally = addTallies(tally, await verifyDue(companyId, `request:${id}:gap`));
        await sectorStep(companyId).catch(() => undefined);
        const counted = await tallyStep(companyId);
        await markRequest(id, { status: "done", message: tallyMessage(counted), companyId, tally: counted });
        finished = true;
        return tally;
      })(),
    ]);
    const last = await verifyDue(companyId, `request:${id}:final`);
    await recordCompanyStep(
      companyId,
      startedAt,
      [fromDossier, fromSearch, last].reduce(addTallies, { ...emptyHistoryTally(), companies: 1 }),
    );
    await scheduleHistoryRetryStep(companyId);
    await sectorStep(companyId).catch(() => undefined);
    await retallyStep(id, companyId);
  } catch {
    if (!finished) await markRequest(id, { status: "failed", message: "Research could not be completed. Please try again later." });
  }
}
