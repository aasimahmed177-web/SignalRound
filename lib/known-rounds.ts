// What the store already knows about a company's rounds, as the lead check reads them: a lead found
// by a search, a gap search, or a page is queued only when none of these already covers it.

import type { KnownRound } from "@fireround/core";
import { parseStoredDossier, priorAsKnown, priorKey } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq } from "drizzle-orm";

const { enrichments, fundingRounds, historyPromotions } = schema;

/** Every round the store, the ledger, and the dossiers already know for a company. */
export async function knownRounds(handle: Db, companyId: string): Promise<KnownRound[]> {
  const [rounds, ledger, dossiers] = await Promise.all([
    handle
      .select({
        stage: fundingRounds.stage,
        label: fundingRounds.stageAsWritten,
        ext: fundingRounds.isExtension,
        usd: fundingRounds.amountUsdMillions,
        on: fundingRounds.announcedOn,
      })
      .from(fundingRounds)
      .where(eq(fundingRounds.companyId, companyId)),
    handle
      .select({ prior: historyPromotions.prior, status: historyPromotions.status })
      .from(historyPromotions)
      .where(eq(historyPromotions.companyId, companyId)),
    handle
      .select({ data: enrichments.data })
      .from(enrichments)
      .where(and(eq(enrichments.companyId, companyId), eq(enrichments.kind, "deep_dive"))),
  ]);
  const unavailable = new Set(ledger.filter((l) => l.status === "no_source" || l.status === "skipped").map((l) => priorKey(l.prior)));
  return [
    ...rounds.map((r) => ({
      stage: r.stage,
      stage_as_written: r.label,
      is_extension: r.ext,
      usd_millions: r.usd === null ? null : Number(r.usd),
      announced_on: r.on,
    })),
    ...ledger.filter((l) => !unavailable.has(priorKey(l.prior))).map((l) => priorAsKnown(l.prior)),
    ...dossiers.flatMap((d) =>
      (parseStoredDossier(d.data)?.prior_rounds ?? []).filter((p) => !unavailable.has(priorKey(p))).map(priorAsKnown),
    ),
  ];
}
