import {
  amountInEvidence,
  assertedRoundCertainty,
  DEFAULT_TIERS,
  hostOf,
  namesCompany,
  ROUND_CERTAINTY_RANK,
  type RoundCertainty,
} from "@fireround/core";
import type { RoundRow } from "./persist.ts";

export interface CertaintyDecision {
  certainty: RoundCertainty;
  quote: string;
  source: string | null;
  tiered: boolean;
  reportedOn: string | null;
}

export function classifyStoredCertainty(
  row: Pick<RoundRow, "evidence_quotes" | "first_seen_at" | "announced_on" | "reported_on"> & {
    sources: Array<Pick<RoundRow["sources"][number], "url" | "host" | "title">>;
    amount?: Pick<RoundRow["amount"], "as_written">;
    company?: Pick<RoundRow["company"], "name">;
  },
  tiers: Record<string, number> = DEFAULT_TIERS,
  now = new Date(),
  sourceEvidence: ReadonlyMap<string, string> = new Map(),
): CertaintyDecision {
  const trusted = (url: string) => {
    const host = hostOf(url).replace(/^www\./, "");
    return (tiers[host] ?? 0) >= 0.7;
  };
  const sourced = row.sources.flatMap((source) => {
    const evidence = sourceEvidence.get(source.url);
    const quote = evidence ?? source.title;
    if (
      !quote ||
      (row.amount?.as_written && !amountInEvidence(row.amount.as_written, quote)) ||
      (!evidence &&
        (!row.company ||
          !namesCompany(quote, row.company.name) ||
          !/\b(?:funding|financing|round|series|investment|raises?|raised|seeks?|closing)\b/i.test(quote)))
    )
      return [];
    return [{ quote, source: source.url }];
  });
  const statements = [
    ...sourced,
    ...row.evidence_quotes
      .filter((quote) => !sourced.some((statement) => statement.quote === quote))
      .filter((quote) => !row.amount?.as_written || amountInEvidence(row.amount.as_written, quote))
      .map((quote) => ({ quote, source: row.sources.length === 1 ? row.sources[0].url : null })),
  ];
  const readings = statements.flatMap((statement) => {
    const certainty = assertedRoundCertainty(statement.quote);
    return certainty ? [{ ...statement, certainty }] : [];
  });
  const selected = readings.sort((a, b) => ROUND_CERTAINTY_RANK[b.certainty] - ROUND_CERTAINTY_RANK[a.certainty])[0];
  const chosen = selected?.certainty ?? "announced";
  const firstSeen = Date.parse(row.first_seen_at);
  const stale = Number.isFinite(firstSeen) && now.getTime() - firstSeen >= 90 * 86_400_000;
  const certainty = chosen !== "announced" && stale ? "unconfirmed" : chosen;
  return {
    certainty,
    quote: selected?.quote ?? "",
    source: selected?.source ?? row.sources[0]?.url ?? null,
    tiered: Boolean(selected?.source && trusted(selected.source)),
    reportedOn: certainty !== "announced" ? (row.reported_on ?? row.announced_on ?? row.first_seen_at.slice(0, 10)) : row.reported_on,
  };
}
