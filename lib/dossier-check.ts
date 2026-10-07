// The dossier check at the store: everything the verifier needs about a company, read from our
// own rows (the company, the rounds the feed lists, the Alexandria facts for its domain), then the
// verifier itself with Firecrawl reading the pages and the configured model ruling on the claims.
// packages/core/src/llm/dossier-verify.ts is the check; this file is what feeds it.

import type {
  AlexandriaEnrichment,
  CompanyDossier,
  DossierCheck,
  DossierContext,
  OurRound,
  ReconcileModel,
  VerifyDossierDeps,
} from "@fireround/core";
import {
  dossierGenerator,
  dossierVerifyModel,
  firecrawlDossierReader,
  firecrawlDossierSearch,
  RATE,
  searchCredits,
  verifyDossier,
} from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { listRounds } from "./persist.ts";

const { companies, enrichments } = schema;

/** Thrown when there is no model to check with: nothing may be saved, and a dive should not start. */
export class DossierCheckUnavailable extends Error {
  constructor(message = "no model is configured to check the dossier (set AI_GATEWAY_API_KEY)") {
    super(message);
    this.name = "DossierCheckUnavailable";
  }
}

/** Our facts about the company, and the URLs of the rounds we verified, for the check to read. */
export async function dossierContext(
  handle: Db,
  companyId: string,
  now: Date = new Date(),
): Promise<{ ctx: DossierContext; ourSourceUrls: string[] } | null> {
  const [[company], { rows }, [alexRow]] = await Promise.all([
    handle.select().from(companies).where(eq(companies.id, companyId)).limit(1),
    listRounds(handle, { companyId, limit: 50 }),
    handle
      .select({ data: enrichments.data })
      .from(enrichments)
      .where(and(eq(enrichments.companyId, companyId), eq(enrichments.kind, "alexandria")))
      .limit(1),
  ]);
  if (!company) return null;
  const rounds: OurRound[] = rows.map((r) => ({
    stage_as_written: r.stage_as_written,
    amount_as_written: r.amount.as_written,
    amount_value: r.amount.value,
    amount_currency: r.amount.currency,
    usd_millions: r.amount.usd_millions,
    announced_on: r.announced_on,
    lead_investors: r.lead_investors,
    other_investors: r.other_investors,
    verified: r.disposition === "publish",
    evidence: r.evidence_quotes,
  }));
  const a = alexRow?.data as AlexandriaEnrichment | undefined;
  const facts: DossierContext["facts"] = a
    ? {
        yc:
          a.yc.status === "matched"
            ? {
                url: a.yc.url,
                batch: a.yc.batch,
                year_founded: a.yc.year_founded,
                team_size: a.yc.team_size,
                founders: a.yc.founders.map((f) => f.name),
              }
            : null,
      }
    : null;
  // The newest round's own sources first: the release that announced it usually states the total.
  const ourSourceUrls = [...new Set(rows.flatMap((r) => r.sources.map((s) => s.url)))];
  return {
    ctx: {
      company: {
        name: company.name,
        domain: company.domain,
        website: company.website,
        description: company.description,
        hq: company.hq,
        sector: company.sector,
      },
      rounds,
      facts,
      today: now.toISOString().slice(0, 10),
    },
    ourSourceUrls,
  };
}

export interface CheckDeps {
  model?: ReconcileModel | null;
  /** Injected in tests: the reads and the model calls, so no network is touched. */
  read?: VerifyDossierDeps["read"];
  search?: VerifyDossierDeps["search"];
  generate?: VerifyDossierDeps["generate"];
  now?: Date;
}

/** Whether a check can run at all: a dive that could never be saved should not be paid for. */
export function dossierCheckAvailable(deps: CheckDeps = {}): boolean {
  return (deps.model !== undefined ? deps.model : dossierVerifyModel()) !== null || deps.generate !== undefined;
}

/**
 * Check one dossier for one company. Throws DossierCheckUnavailable with no model, and passes on
 * any read or model failure: the caller saves nothing then.
 */
export async function checkDossier(
  handle: Db,
  client: Firecrawl,
  companyId: string,
  dossier: CompanyDossier,
  deps: CheckDeps = {},
): Promise<DossierCheck> {
  const model = deps.model !== undefined ? deps.model : dossierVerifyModel();
  if (!model && !deps.generate) throw new DossierCheckUnavailable();
  const now = deps.now ?? new Date();
  const loaded = await dossierContext(handle, companyId, now);
  if (!loaded) throw new Error("Company not found.");
  return verifyDossier(
    dossier,
    loaded.ctx,
    {
      read: deps.read ?? firecrawlDossierReader(client),
      search: deps.search ?? firecrawlDossierSearch(client),
      model: { label: model?.label ?? "test" },
      generate: deps.generate ?? dossierGenerator(model as ReconcileModel),
      credits: { page: RATE.scrapePage, search: (n) => searchCredits(n) + n * RATE.scrapePage },
    },
    { ourSourceUrls: loaded.ourSourceUrls, now },
  );
}
