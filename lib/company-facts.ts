// The sourced company facts a header, a feed detail, and the API carry: YC's batch through NativeWebClient
// Alexandria, the founding year and team size from YC or the company's checked research dossier, and
// the LinkedIn page the company's own homepage links. Pure and client-safe: rounds-table.tsx is a
// client component and must not pull the store's database imports into its bundle.

/** YC's batch as a chip: "Summer 2022" -> S22, "Winter 2025" -> W25, "Spring 2025" -> X25, "Fall 2025" -> F25. */
export function ycBatchShort(batch: string | null | undefined): string | null {
  if (!batch) return null;
  const m = batch.match(/^(summer|winter|spring|fall)\s+(\d{4})/i);
  if (!m) return batch;
  const letter = { summer: "S", winter: "W", spring: "X", fall: "F" }[m[1].toLowerCase()];
  return `${letter}${m[2].slice(2)}`;
}

/** YC's record as rows and the API carry it. */
export interface YcFacts {
  batch: string | null;
  team_size: number | null;
  year_founded: number | null;
}

/** Where a fact came from: YC's record via Alexandria, or the company's checked research dossier. */
export type FactSource = "yc" | "dossier";

export interface CompanyFacts {
  founded_year: { value: number; source: FactSource } | null;
  /** As the source states it: "51 to 200", "about 40 people", or YC's count. */
  headcount: { value: string; source: FactSource } | null;
  /** The company page on LinkedIn that its verified homepage links. */
  linkedin_url: string | null;
}

/** What the checked dossier states, when a page backs it. */
export interface DossierFacts {
  founded_year: number | null;
  headcount_estimate: string | null;
}

/**
 * YC's founding year when it can be true: never after the batch the company joined (NativeWebClient, YC S22,
 * reads 2024 on its YC page, the year the product took its name). Null otherwise.
 */
export function ycFoundedYear(yc: YcFacts | null | undefined): number | null {
  const year = yc?.year_founded;
  if (!year || year <= 0) return null;
  const batch = Number(yc?.batch?.match(/\d{4}/)?.[0]);
  return batch && year > batch ? null : year;
}

/**
 * One company's facts: the founding year YC's when it can be true, else the dossier's; the team size
 * the dossier's, else YC's. YC's team size is what the company wrote when it applied, so a page's
 * newer figure comes first.
 */
export function companyFacts(
  yc: YcFacts | null | undefined,
  dossier: DossierFacts | null | undefined,
  linkedinUrl: string | null,
): CompanyFacts {
  const ycYear = ycFoundedYear(yc);
  const dossierYear = dossier?.founded_year && dossier.founded_year > 0 ? dossier.founded_year : null;
  const dossierPeople = dossier?.headcount_estimate?.trim() || null;
  const ycPeople = yc?.team_size && yc.team_size > 0 ? String(yc.team_size) : null;
  return {
    founded_year: ycYear ? { value: ycYear, source: "yc" } : dossierYear ? { value: dossierYear, source: "dossier" } : null,
    headcount: dossierPeople ? { value: dossierPeople, source: "dossier" } : ycPeople ? { value: ycPeople, source: "yc" } : null,
    linkedin_url: linkedinUrl,
  };
}

export interface FactChip {
  label: string;
  title: string;
}

const TITLES: Record<FactSource, string> = {
  yc: "From Y Combinator public company profile",
  dossier: "From company research",
};
export const LINKEDIN_TITLE = "The LinkedIn page the company's own site links";

/** "51 to 200" and "12" read as people; "about 40 people" already does. */
export function peopleLabel(headcount: string): string {
  if (/\b(people|person|employees|staff)\b/i.test(headcount)) return headcount;
  return headcount === "1" ? "1 person" : `${headcount} people`;
}

/** The mono chips a header or feed detail shows: the YC batch, the founding year, and the team size, each with its source. */
export function factChips(
  yc: Pick<YcFacts, "batch"> | null | undefined,
  facts: Pick<CompanyFacts, "founded_year" | "headcount"> | null | undefined,
): FactChip[] {
  const out: FactChip[] = [];
  const batch = ycBatchShort(yc?.batch);
  if (batch) out.push({ label: `YC ${batch}`, title: TITLES.yc });
  if (facts?.founded_year) out.push({ label: `founded ${facts.founded_year.value}`, title: TITLES[facts.founded_year.source] });
  if (facts?.headcount) out.push({ label: peopleLabel(facts.headcount.value), title: TITLES[facts.headcount.source] });
  return out;
}
