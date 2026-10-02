// A company's name as a request saves it. A homepage's brand name or title often carries a tagline
// ("Resend · Email for developers", "Linear | Plan and build products", "Acme: The AI platform",
// "Acme - Home"); the name is the part before or beside it, never the tagline. Pure, so the brand
// read, the company row, the repair, and the tests share one reading.

/** A separator with space on both sides; a colon only needs the space after it. "Cal.com" and "Hugging Face" hold none. */
const SEPARATOR = /\s+[·•|\u2013\u2014-]\s+|:\s+/;

/** Words a title segment carries that name no one. */
const GENERIC = /^(?:home|homepage|welcome|official site|official website|main page|index)$/i;

function squash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** The domain's first label, the name a company's site most often spells: "resend" for resend.com, "cal" for cal.com. */
function domainLabel(domain: string | null): string {
  return squash((domain ?? "").replace(/^www\./, "").split(".")[0] ?? "");
}

/**
 * The name without its tagline: the segment that spells the domain's label, else the first segment
 * that is not a word like "Home". A name with no separator is kept as it is.
 */
export function cleanBrandName(raw: string, domain: string | null): string {
  const name = raw.replace(/\s+/g, " ").trim();
  const segments = name
    .split(SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length < 2) return name;
  const label = domainLabel(domain);
  const spelled = label ? segments.find((s) => squash(s) === label || squash(s) === squash(domain ?? "")) : undefined;
  return spelled ?? segments.find((s) => !GENERIC.test(s)) ?? segments[0];
}

/** Remove a headline's location or category before treating the remainder as a company name. */
export function cleanHeadlineName(raw: string): string {
  const name = raw.trim();
  const withoutLocation = name.replace(/^\p{Lu}[\p{L} .'-]{1,35}-based\s+/u, "");
  return withoutLocation.replace(/^(?:neocloud|fintech|healthtech|medtech|biotech|cleantech|startup|start-up)\s+(?=\p{Lu}|\d)/iu, "");
}

/**
 * The name a search uses: the clean name, so a row saved with its tagline still searches as the
 * company; the domain when that name is too plain to search ("App", "Home", two letters).
 */
export function brandSearchName(name: string, domain: string | null): string {
  const clean = cleanBrandName(name, domain);
  return domain && (clean.length < 3 || GENERIC.test(clean) || /^(?:app|platform|dashboard|software|company)$/i.test(clean))
    ? domain
    : clean;
}
