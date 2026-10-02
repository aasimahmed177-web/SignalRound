// The sourced-fact chips a header or feed detail renders from an alexandria row. Pure and
// client-safe: rounds-table.tsx is a client component and must not pull the batch writer's
// database imports into its bundle.

/** YC's batch as a chip: "Summer 2022" -> S22, "Winter 2025" -> W25, "Spring 2025" -> X25, "Fall 2025" -> F25. */
export function ycBatchShort(batch: string | null | undefined): string | null {
  if (!batch) return null;
  const m = batch.match(/^(summer|winter|spring|fall)\s+(\d{4})/i);
  if (!m) return batch;
  const letter = { summer: "S", winter: "W", spring: "X", fall: "F" }[m[1].toLowerCase()];
  return `${letter}${m[2].slice(2)}`;
}

export interface AlexandriaFact {
  label: string;
  title: string;
}

/** The flattened shape rows and the API carry; toAlexandria in lib/persist.ts produces it. */
export interface AlexandriaFactsInput {
  yc: { batch: string | null; team_size: number | null; year_founded: number | null } | null;
  firmographics: {
    headcount_range: string | null;
    year_founded: number | null;
    headcount?: number | null;
    linkedin_url?: string | null;
  } | null;
  /** What Apollo may add, measured before it shipped: a headcount and a checked LinkedIn page, each shown only where the others have none. */
  apollo?: { headcount: number | null; linkedin_url: string | null } | null;
}

const YC_TITLE = "From Y Combinator via Firecrawl Alexandria";
const FULLENRICH_TITLE = "From FullEnrich via Firecrawl Alexandria";
export const APOLLO_TITLE = "From Apollo via Firecrawl Alexandria";

/**
 * YC's founding year when it can be true: never after the batch the company joined (Firecrawl, YC S22,
 * reads 2024 on its YC page, the year the product took its name). Null otherwise.
 */
export function ycFoundedYear(yc: AlexandriaFactsInput["yc"]): number | null {
  const year = yc?.year_founded;
  if (!year || year <= 0) return null;
  const batch = Number(yc?.batch?.match(/\d{4}/)?.[0]);
  return batch && year > batch ? null : year;
}

/** FullEnrich's founding year, which it writes as 0 when it has none. */
export function fullEnrichFoundedYear(f: AlexandriaFactsInput["firmographics"]): number | null {
  return f?.year_founded && f.year_founded > 0 ? f.year_founded : null;
}

/**
 * The sourced facts a header or feed detail shows as mono chips: the YC batch, the founding year
 * (YC's when it can be true, else FullEnrich's), and the team size. FullEnrich's and Apollo's
 * headcounts come first and YC's last: YC's team size is what the company wrote when it applied,
 * and across the 23 YC companies in the store (September 2026) it was never higher than the other
 * two and a third or less of them for four (Firecrawl: YC 3, FullEnrich 52, Apollo 53).
 */
export function alexandriaFacts(e: AlexandriaFactsInput | null | undefined): AlexandriaFact[] {
  if (!e) return [];
  const out: AlexandriaFact[] = [];
  const batch = ycBatchShort(e.yc?.batch);
  if (batch) out.push({ label: `YC ${batch}`, title: YC_TITLE });
  const ycYear = ycFoundedYear(e.yc);
  const founded = ycYear ?? fullEnrichFoundedYear(e.firmographics);
  if (founded) out.push({ label: `founded ${founded}`, title: ycYear ? YC_TITLE : FULLENRICH_TITLE });
  const fullEnrich = e.firmographics?.headcount ?? e.firmographics?.headcount_range;
  const people = fullEnrich ?? e.apollo?.headcount ?? e.yc?.team_size;
  if (people) {
    const n = typeof people === "number" ? people : null;
    out.push({
      label: n ? `${n} ${n === 1 ? "person" : "people"}` : `${people} people`,
      title: fullEnrich ? FULLENRICH_TITLE : e.apollo?.headcount ? APOLLO_TITLE : YC_TITLE,
    });
  }
  return out;
}

/** The company's LinkedIn page and whose it is: FullEnrich's when it has one, else Apollo's checked one. */
export function companyLinkedin(e: AlexandriaFactsInput | null | undefined): { url: string; title: string } | null {
  if (e?.firmographics?.linkedin_url) return { url: e.firmographics.linkedin_url, title: FULLENRICH_TITLE };
  if (e?.apollo?.linkedin_url) return { url: e.apollo.linkedin_url, title: APOLLO_TITLE };
  return null;
}
