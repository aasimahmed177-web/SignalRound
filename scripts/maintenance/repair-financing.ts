import {
  amountInEvidence,
  classifyStage,
  DEFAULT_TIERS,
  extractRounds,
  fetchRates,
  hostOf,
  isArticleUrl,
  isFundingAggregatorUrl,
  namesCompany,
  normalizeCompanyKey,
  parseAmount,
  SOCIAL_AND_DIRECTORY_HOSTS,
} from "@fireround/core";
import { closeDb, schema } from "@fireround/core/db";
import { desc, eq } from "drizzle-orm";
import { openStore } from "../../lib/db.ts";
import { replayFinancing, sourceSentenceDecision } from "../../lib/financing-repair.ts";
import { invalidateScriptEntityPages } from "../../lib/script-cache-invalidation.ts";
import { getWebClient } from "../../lib/web-client.ts";

const apply = process.argv.includes("--apply");
const reground = process.argv.includes("--reground");
const verbose = process.argv.includes("--verbose");
const limitAt = process.argv.indexOf("--limit");
const limit = limitAt < 0 ? Number.POSITIVE_INFINITY : Number(process.argv[limitAt + 1]);
const idsAt = process.argv.indexOf("--ids");
const ids = idsAt < 0 ? null : new Set((process.argv[idsAt + 1] ?? "").split(","));
const client = reground ? getWebClient() : null;
const store = await openStore();
let readCount = 0;
const rates = new Map<string, Awaited<ReturnType<typeof fetchRates>>>();
const result = await replayFinancing(store, {
  apply,
  ...(client
    ? {
        readSource: async (
          row: {
            id: string;
            company: string;
            amount: string | null;
            stage?: string;
            announced?: string | null;
            quotes: string[];
            leadNames?: string[];
          },
          links: Array<{ url: string; host: string; published: string | null }>,
          domain: string | null,
          investorDomains: string[],
        ) => {
          if (ids && !ids.has(row.id)) return null;
          if (readCount >= limit) return null;
          const own = links.find(
            (link) =>
              domain &&
              (link.host === domain || link.host.endsWith(`.${domain}`)) &&
              /\b(?:press|news|blog|funding|series|round|financing|investment)\b/i.test(link.url),
          );
          const wire = links
            .filter((link) => /^(?:prnewswire|businesswire|globenewswire)\.com$/.test(link.host))
            .sort((a, b) => {
              const score = (url: string) =>
                Number(/\b(?:raises|secures|closes|funding|financing|series)\b/i.test(url)) -
                Number(/\b(?:anniversary|milestone|recap|year-in-review)\b/i.test(url));
              return score(b.url) - score(a.url);
            })[0];
          const attached = links
            .filter(
              (link) =>
                /\b(?:funding|financing|round|investment|follow-on|series)\b/i.test(link.url) &&
                !isFundingAggregatorUrl(link.url) &&
                !/\b(?:roundup|digest|anniversary|milestone)\b/i.test(link.url) &&
                link.published &&
                row.announced &&
                Math.abs(Date.parse(link.published) - Date.parse(row.announced)) <= 21 * 86_400_000,
            )
            .sort((a, b) => (DEFAULT_TIERS[b.host] ?? 0.3) - (DEFAULT_TIERS[a.host] ?? 0.3))[0];
          const disputedDollar = /(?:A|C|S|NZ|HK)\$\s*\d/i.test(row.amount ?? "") && /\([^)]*\$/.test(row.amount ?? "");
          let url: string | undefined = disputedDollar ? undefined : (own?.url ?? wire?.url ?? attached?.url);
          if (!url && !disputedDollar && investorDomains.length) {
            const words = new Set(
              row.quotes
                .join(" ")
                .toLowerCase()
                .match(/\b[a-z]{6,}\b/g)
                ?.filter((word) => !["raised", "million", "billion", "funding", "startup", "company", "series"].includes(word)) ?? [],
            );
            for (const site of [...investorDomains].sort().slice(0, 3)) {
              try {
                const mapped = await client.map(`https://${site}`, {
                  search: row.company,
                  includeSubdomains: true,
                  limit: 20,
                  timeout: 30_000,
                });
                url = mapped.links?.find(
                  (link) =>
                    isArticleUrl(link.url) &&
                    /\b(?:blog|news|press|stories)\b/i.test(link.url) &&
                    (link.title ?? link.url)
                      .toLowerCase()
                      .match(/\b[a-z]{6,}\b/g)
                      ?.some((word) => words.has(word)),
                )?.url;
                if (url) break;
              } catch {}
            }
          }
          if (!url) {
            try {
              const hits = await client.search(
                disputedDollar
                  ? `"${row.company}" "US$${/\d+(?:\.\d+)?/.exec(row.amount ?? "")?.[0] ?? ""}" ${row.stage && row.stage !== "other" ? row.stage.replaceAll("_", " ") : "funding"}`
                  : row.leadNames?.length === 0
                    ? `"${row.company}" ${Number.parseFloat(row.amount?.replace(/[^\d.]/g, "") ?? "0") >= 20 ? `"${row.amount ?? ""}" funding` : `${row.stage && row.stage !== "other" ? row.stage.replaceAll("_", " ") : "funding"} led by`} 2026`
                    : `"${row.company}" "${row.amount ?? ""}" ${row.stage && row.stage !== "other" ? row.stage.replaceAll("_", " ") : "funding"} 2026`,
                { sources: ["web", "news"], limit: 10, highlights: false },
              );
              const candidates = [...(hits.web ?? []), ...(hits.news ?? [])].flatMap((hit) =>
                "url" in hit &&
                typeof hit.url === "string" &&
                (isArticleUrl(hit.url) || (disputedDollar && /representative-work|news|press/i.test(hit.url))) &&
                !isFundingAggregatorUrl(hit.url) &&
                !/\/(?:press-releases?|news|blog|articles?)\/?(?:[?#]|$)/i.test(hit.url) &&
                !SOCIAL_AND_DIRECTORY_HOSTS.has(hostOf(hit.url)) &&
                (namesCompany("title" in hit ? String(hit.title ?? "") : hit.url, row.company) ||
                  hit.url.toLowerCase().includes(row.company.toLowerCase().replace(/\s+/g, "-")))
                  ? [
                      {
                        url: hit.url,
                        detail: `${"title" in hit ? String(hit.title ?? "") : ""} ${"description" in hit ? String(hit.description ?? "") : ""}`,
                      },
                    ]
                  : [],
              );
              url =
                candidates.find((candidate) => {
                  const host = hostOf(candidate.url);
                  return (
                    domain &&
                    (host === domain || host.endsWith(`.${domain}`)) &&
                    (row.leadNames?.length !== 0 ||
                      Number.parseFloat(row.amount?.replace(/[^\d.]/g, "") ?? "0") < 20 ||
                      amountInEvidence(row.amount, `${candidate.detail} ${candidate.url}`))
                  );
                })?.url ??
                (disputedDollar
                  ? candidates.find((candidate) => /\b(?:US\$|USD|US dollars?)\b/i.test(candidate.detail))?.url
                  : (candidates.find(
                      (candidate) =>
                        (DEFAULT_TIERS[hostOf(candidate.url)] ?? 0) >= 0.7 &&
                        (row.leadNames?.length !== 0 ||
                          Number.parseFloat(row.amount?.replace(/[^\d.]/g, "") ?? "0") < 20 ||
                          amountInEvidence(row.amount, `${candidate.detail} ${candidate.url}`)),
                    )?.url ??
                    candidates.find(
                      (candidate) =>
                        /(?:led-by|led by)/i.test(`${candidate.url} ${candidate.detail}`) &&
                        amountInEvidence(row.amount, `${candidate.detail} ${candidate.url}`),
                    )?.url ??
                    attached?.url));
            } catch {}
          }
          if (!url) return null;
          readCount++;
          try {
            const linkedPublished = links.find((link) => link.url === url)?.published;
            const cached = await store
              .select({ markdown: schema.pageSnapshots.markdown })
              .from(schema.pageSnapshotReads)
              .innerJoin(schema.pageSnapshots, eq(schema.pageSnapshots.hash, schema.pageSnapshotReads.snapshotHash))
              .where(eq(schema.pageSnapshotReads.sourceUrl, url))
              .orderBy(desc(schema.pageSnapshotReads.readAt))
              .limit(1);
            if (cached[0]) {
              const sentence = sourceSentenceDecision(
                row as Parameters<typeof sourceSentenceDecision>[0],
                cached[0].markdown,
                url,
                linkedPublished,
              );
              if (sentence?.published && (sentence.reviewReason || sentence.round.amount_as_written)) return sentence;
            }
            const page = await extractRounds(client, [{ url, published: linkedPublished ?? undefined }], { concurrency: 1 });
            if (verbose) console.log(`read ${row.id}: ${url}, ${page.pages[0]?.rounds ?? 0} extracted, ${page.pages[0]?.error ?? "ok"}`);
            const item = page.items
              .filter((item) => {
                const key = normalizeCompanyKey(item.round.company_name);
                const stored = normalizeCompanyKey(row.company);
                return key && (key === stored || stored.endsWith(` ${key}`));
              })
              .sort((a, b) => {
                const rank = (label: string) =>
                  ({ pre_seed: 0, seed: 1, series_a: 2, series_b: 3, series_c: 4, series_d_plus: 5, growth: 6 })[
                    classifyStage(label).stage as "pre_seed" | "seed" | "series_a" | "series_b" | "series_c" | "series_d_plus" | "growth"
                  ] ?? -1;
                return rank(b.round.round_type_as_written) - rank(a.round.round_type_as_written);
              })[0];
            const doc = await client.scrape(url, { formats: ["markdown"], onlyMainContent: true });
            if (!amountInEvidence(row.amount, doc.markdown ?? "")) return null;
            const published = item?.page_date ?? item?.source.published ?? linkedPublished;
            const sentence = sourceSentenceDecision(
              row as Parameters<typeof sourceSentenceDecision>[0],
              doc.markdown ?? "",
              url,
              published,
            );
            if (sentence) {
              if (
                !sentence.reviewReason &&
                !sentence.round.amount_as_written &&
                item?.grounded === true &&
                item.round.amount_as_written &&
                parseAmount(item.round.amount_as_written).value !== parseAmount(row.amount).value
              )
                return { round: item.round, url, published, markdown: doc.markdown ?? "" };
              return sentence;
            }
            if (item?.grounded === true) {
              if (verbose)
                console.log(
                  `grounded ${row.id}: ${item.round.amount_as_written ?? "no figure"}, ${item.round.money_kind ?? "unclassified"}`,
                );
              return { round: item.round, url, published, markdown: doc.markdown ?? "" };
            }
            return null;
          } catch {
            return null;
          }
        },
      }
    : {}),
  rateFor: async (date, currency, value) => {
    try {
      let table = rates.get(date);
      if (!table) {
        table = await fetchRates(date);
        rates.set(date, table);
      }
      const rate = table.perUsd[currency];
      return rate ? { usd: Math.round((value / rate) * 1000) / 1000, rate, date: table.date } : null;
    } catch {
      return null;
    }
  },
});
for (const change of result.changes)
  console.log(
    `${change.id} ${change.company}: ${change.reason}${change.review ? "; Review" : ""}\n  Quote: ${change.evidence}${change.sourceUrl ? `\n  Source: ${change.sourceUrl}` : ""}`,
  );
console.log(
  `${result.scanned} visible rows: ${result.amountCorrections} amounts corrected, ${result.toReview} moved to Review, ${result.currencyFixes} currencies fixed (${apply ? "applied" : "dry run"}).`,
);
console.log(`${result.leadCorrections} lead investor lists corrected${reground ? " with source rereads" : ""}.`);
console.log(`${result.stageCorrections} unlettered stages corrected from source sentences.`);
if (reground) console.log(`${readCount} source pages independently re-read with NativeWebClient.`);
await invalidateScriptEntityPages();
await closeDb();
