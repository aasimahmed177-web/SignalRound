// Read-only newsroom discovery on the top companies. No insert, monitor creation, or delivery.
// DATABASE_URL=... node --env-file=... scripts/newsroom-evidence.ts
import { classifyStage, extractRounds, NEWSROOM_PAGE_LIMIT, namesCompany, newsroomFundingLinks, parseAmount } from "@fireround/core";
import { discoverNewsrooms } from "@fireround/core/company-newsrooms";
import { schema } from "@fireround/core/db";
import { NativeWebClient } from "@fireround/core/web";
import { eq } from "drizzle-orm";
import { companyNewsroomTargets } from "../lib/company-newsrooms.ts";
import { openStore } from "../lib/db.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must point to the restored production copy");
const handle = await openStore();
const client = new NativeWebClient();
const targets = (await companyNewsroomTargets(handle)).slice(0, 100);
const findings: Array<{
  company: string;
  sections: string[];
  unmatched: Array<{ url: string; stage: string; amount: string | null; date: string | null }>;
}> = [];
let maps = 0;
let failed = 0;
let articles = 0;
let mapErrors = 0;
for (let i = 0; i < targets.length; i += 4) {
  await Promise.all(
    targets.slice(i, i + 4).map(async (target) => {
      try {
        const found = await discoverNewsrooms(client, target.homepage, target.aliases);
        maps += found.calls;
        const urls = new Set<string>();
        for (const section of found.sections) {
          try {
            const map = await client.map(section, { limit: NEWSROOM_PAGE_LIMIT, timeout: 30_000 });
            maps++;
            for (const url of newsroomFundingLinks(map.links ?? [], section, new Date(), Number.POSITIVE_INFINITY)) urls.add(url);
          } catch {
            mapErrors++;
          }
        }
        const stored = await handle
          .select({
            stage: schema.fundingRounds.stageAsWritten,
            amount: schema.fundingRounds.amountAsWritten,
            day: schema.fundingRounds.announcedOn,
          })
          .from(schema.fundingRounds)
          .where(eq(schema.fundingRounds.companyId, target.id));
        const extracted = await extractRounds(
          client,
          [...urls].slice(0, 5).map((url) => ({ url, query: `company:${target.id}` })),
          { concurrency: 2 },
        );
        articles += extracted.pages.filter((page) => page.ok).length;
        const unmatched = extracted.items
          .filter((item) => {
            if (item.grounded === false || !namesCompany(item.round.company_name, target.name, { share: 1 })) return false;
            const r = item.round;
            const amount = parseAmount(r.amount_as_written);
            return !stored.some((old) => {
              const known = parseAmount(old.amount);
              const sameAmount =
                amount.value !== null &&
                known.value !== null &&
                amount.currency === known.currency &&
                Math.abs(amount.value - known.value) <= 0.1 * Math.max(amount.value, known.value);
              const sameStage = classifyStage(old.stage).stage === classifyStage(r.round_type_as_written).stage;
              const days =
                r.announced_date && old.day
                  ? Math.abs(new Date(r.announced_date).getTime() - new Date(old.day).getTime()) / 86_400_000
                  : null;
              return (sameAmount || sameStage) && (days === null || days <= 45) && (sameAmount || days !== null);
            });
          })
          .map((item) => ({
            url: item.source.url,
            stage: item.round.round_type_as_written,
            amount: item.round.amount_as_written,
            date: item.round.announced_date,
          }));
        findings.push({ company: target.name, sections: found.sections, unmatched });
      } catch (err) {
        failed++;
        console.error(`Unable to inspect ${target.name}: ${err instanceof Error ? err.name : "unknown failure"}`);
      }
    }),
  );
  console.log(`Inspected ${Math.min(i + 4, targets.length)}/${targets.length} companies`);
}
console.log(
  JSON.stringify(
    {
      companies: targets.length,
      inspected: findings.length,
      failed,
      mapErrors,
      maps,
      articles,
      newsrooms: findings.filter((f) => f.sections.length > 0).length,
      sections: findings.reduce((n, f) => n + f.sections.length, 0),
      unverifiedClaimsNotMatched: findings.reduce((n, f) => n + f.unmatched.length, 0),
      articleCapPerCompany: 5,
      note: "Unverified extraction leads, including possible debt, grants, old republishing, and already known rounds. Review sources before calling these missing rounds.",
      findings: findings.filter((f) => f.sections.length > 0),
    },
    null,
    2,
  ),
);
