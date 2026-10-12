import { DEFAULT_TIERS } from "@fireround/core";
import { closeDb, schema } from "@fireround/core/db";
import { eq, inArray } from "drizzle-orm";
import { openStore } from "../../lib/db.ts";
import { listRounds } from "../../lib/persist.ts";
import { classifyStoredCertainty } from "../../lib/repair-certainty.ts";
import { loadPublisherTiers } from "../../lib/rules.ts";

const apply = process.argv.includes("--apply");
const handle = await openStore();
const tiers = { ...DEFAULT_TIERS, ...(await loadPublisherTiers()) };
const counts = { visible: 0, announced: 0, reported: 0, expected: 0, unconfirmed: 0, toReview: 0, changes: 0 };
let cursor: string | undefined;
while (true) {
  const page = await listRounds(handle, { limit: 200, cursor, certainty: "all" });
  const claims = page.rows.length
    ? await handle
        .select({ roundId: schema.roundSources.roundId, sourceId: schema.roundSources.sourceId, fields: schema.roundSources.fieldClaims })
        .from(schema.roundSources)
        .where(
          inArray(
            schema.roundSources.roundId,
            page.rows.map((row) => row.id),
          ),
        )
    : [];
  const evidenceByRound = new Map<string, Map<string, string>>();
  for (const claim of claims) {
    const evidence = (claim.fields as { evidence?: string | null } | null)?.evidence;
    if (!evidence) continue;
    const byUrl = evidenceByRound.get(claim.roundId) ?? new Map<string, string>();
    byUrl.set(claim.sourceId, evidence);
    evidenceByRound.set(claim.roundId, byUrl);
  }
  for (const row of page.rows) {
    counts.visible++;
    // A certainty a person pinned (fix-records) is not the classifier's to move.
    if (row.pinned?.certainty) continue;
    const decision = classifyStoredCertainty(row, tiers, new Date(), evidenceByRound.get(row.id));
    counts[decision.certainty]++;
    const untrusted = decision.certainty !== "announced" && !decision.tiered;
    if (untrusted) counts.toReview++;
    if (decision.certainty !== row.certainty || untrusted) counts.changes++;
    if (decision.certainty !== "announced" || decision.certainty !== row.certainty) {
      console.log(
        `${row.id}: ${decision.certainty}${untrusted ? " (review: no tiered publication)" : ""} | ${decision.source ?? "no source"} | "${decision.quote}"`,
      );
    }
    if (!apply || (decision.certainty === row.certainty && !untrusted)) continue;
    await handle
      .update(schema.fundingRounds)
      .set({
        certainty: decision.certainty,
        reportedOn: decision.reportedOn,
        ...(untrusted ? { disposition: "review" as const } : {}),
      })
      .where(eq(schema.fundingRounds.id, row.id));
  }
  if (!page.nextCursor) break;
  cursor = page.nextCursor;
}
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...counts }));
await closeDb();
