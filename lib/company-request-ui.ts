/** A directory term only prefills the form when it looks like a website, never a company name. */
export function websiteFromQuery(query: string): string {
  const term = query.trim();
  return /^(?:https?:\/\/)?(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,}(?:\/[^\s]*)?$/i.test(term) ? term : "";
}

export function shouldSuggestCompany(query: string, rows: { name: string; domain: string | null }[]): boolean {
  const term = normalizedCompanyQuery(query);
  if (!term) return false;
  return !rows.some(({ name, domain }) => [name, domain].some((value) => value?.toLowerCase().startsWith(term)));
}

export function normalizedCompanyQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}
