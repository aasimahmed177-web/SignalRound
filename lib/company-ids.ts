// A company's id is its page's URL (/companies/<id>) and the id the API, the MCP server, the feeds, and
// every message link carry, so it has to read cleanly: lowercase letters, digits, dots, and hyphens.
// The company's own domain when it has one, else its name hyphenated ("nexbank-capital"), and a
// namesake that needs a row of its own takes the next free number ("ghost-2") rather than a news
// site's host. Pure, so persist (new rows) and the rename backfill (lib/company-renames.ts) share it.

/** Lowercase letters and digits in runs joined by single dots or hyphens: a domain or a hyphenated name. */
export function isCleanCompanyId(id: string): boolean {
  return /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id);
}

/** A name or name key as a URL segment: accents folded, every other run of characters one hyphen. */
export function companySlug(text: string): string {
  return (
    text
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "company"
  );
}

/** `base`, or the first of base-2, base-3, ... that `taken` does not hold. */
export function nextFreeId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}
