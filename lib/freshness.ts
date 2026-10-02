import type { FeedRecord } from "@fireround/core";
import { DEFAULT_TIERS, hostOf, registrableDomain } from "@fireround/core";
import { visibilityEvidence } from "./round-verification.ts";

/** The earliest independently dated same-round reading, never an undated search snippet. */
export function earliestReport(
  readings: readonly FeedRecord[],
  companyDomain: string | null,
  investorDomains: readonly string[] = [],
  tiers: Record<string, number> = DEFAULT_TIERS,
): string | null {
  const dated = readings.filter((r) => r.announced_date && r.date_precision === "day" && r.date_basis !== "result");
  const weak = dated.filter((r) => {
    const source = r.sources[0];
    const domain = source && registrableDomain(source.url);
    return (
      domain && domain !== companyDomain && !investorDomains.includes(domain) && (tiers[hostOf(source.url)] ?? tiers[domain] ?? 0) < 0.7
    );
  });
  const independentlyReported = visibilityEvidence(
    weak.flatMap((r) => r.sources),
    null,
    [],
    tiers,
  );
  return (
    dated
      .filter((r) => {
        const source = r.sources[0];
        const domain = source && registrableDomain(source.url);
        return (
          domain &&
          (domain === companyDomain ||
            investorDomains.includes(domain) ||
            (tiers[hostOf(source.url)] ?? tiers[domain] ?? 0) >= 0.7 ||
            (independentlyReported && weak.includes(r)))
        );
      })
      .map((r) => r.announced_date as string)
      .sort()[0] ?? null
  );
}
