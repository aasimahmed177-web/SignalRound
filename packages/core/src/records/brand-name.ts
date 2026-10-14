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

/** A page's own label rather than a company's name: "About", "Notes on Roadtrips", "Blog". */
const PAGE_LABEL =
  /^(?:home|homepage|welcome|about|about us|blog|news|newsroom|press|contact|contact us|careers|jobs|log ?in|sign ?in|sign ?up|notes\b.*|official site|official website|main page|index)$/i;

/** A name at most five words long that is not a page's own label. A sentence ("Groceries delivered in minutes") still passes here; the domain decides. */
function nameLike(name: string): boolean {
  const words = name.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 5 && !PAGE_LABEL.test(name) && squash(name).length >= 2;
}

/**
 * Whether a name spells the domain's brand: either holds the other ("Flink" in goflink, "The Browser
 * Company" around thebrowser), one of its words is the label ("Hims & Hers" for hims.com), or the label
 * is the name's abbreviation in order from its first letter ("bsky" for Bluesky).
 */
function spellsDomain(name: string, domain: string | null): boolean {
  const label = domainLabel(domain);
  const key = squash(name);
  if (label.length < 2 || key.length < 2) return false;
  if (key.includes(label) || label.includes(key)) return true;
  if (name.split(/\s+/).some((w) => squash(w).length >= 3 && label.includes(squash(w)))) return true;
  if (label.length < 3 || label[0] !== key[0]) return false;
  let i = 0;
  for (const ch of key) if (ch === label[i]) i++;
  return i === label.length;
}

/** The domain's brand as a name: its first label, capitalized ("Goflink" for goflink.com). */
function domainBrand(domain: string | null): string | null {
  const label = (domain ?? "").replace(/^www\./, "").split(".")[0] ?? "";
  return label ? label[0].toUpperCase() + label.slice(1) : null;
}

/**
 * A new company's name from what its site says, strongest signal first. `siteName` is the page's
 * og:site_name, the site's own current name; `stated` the name the homepage reading itself gives,
 * which can recall a former name (xAI for SpaceXAI), so the site's name goes first;
 * `brand` (the branding read) and `title` (the page title) are weak: a homepage's hero line or a
 * subpage's title lands there ("Groceries delivered in minutes", "About", "Notes on Roadtrips").
 * A signal that spells the domain wins, strong before weak; then a strong one alone; else the
 * domain's brand. A weak signal that does not spell the domain never names a company.
 * Among the signals that spell the domain, one that writes it as a name outranks the bare label
 * ("glycoera" beside "GlycoEra", "hub-international" beside "Hub International") and the domain
 * written out ("manychat.com" beside "ManyChat"); the domain written out in lowercase alone is its
 * label ("noon"). `placeholder` is the name the reading was asked about: when the company's name is
 * not yet known that is the domain's label, and a stated name that only repeats it says nothing.
 */
export function companyNameFrom(
  signals: {
    stated?: string | null;
    siteName?: string | null;
    brand?: string | null;
    title?: string | null;
    placeholder?: string | null;
  },
  domain: string | null,
): string | null {
  const clean = (raw: string | null | undefined) => {
    const name = raw?.trim() ? cleanBrandName(raw, domain) : "";
    return name && name.length <= 80 && nameLike(name) ? name : null;
  };
  const stated = signals.placeholder && signals.stated?.trim() === signals.placeholder.trim() ? null : signals.stated;
  const strong = [signals.siteName, stated].map(clean).filter((n): n is string => n !== null);
  const weak = [signals.brand, signals.title].map(clean).filter((n): n is string => n !== null);
  const spelled = [...strong, ...weak].filter((n) => spellsDomain(n, domain));
  const site = squash(domain ?? "");
  const lowercase = (n: string) => n === n.toLowerCase();
  const writtenOut = (n: string) => squash(n) === site;
  const bare = (n: string) => lowercase(n) && squash(n) === domainLabel(domain);
  const best =
    spelled.find((n) => !writtenOut(n) && !bare(n)) ??
    spelled.find((n) => writtenOut(n) && !lowercase(n)) ??
    spelled.find((n) => bare(n)) ??
    spelled[0];
  if (best) return writtenOut(best) && lowercase(best) ? (domain ?? "").replace(/^www\./, "").split(".")[0] : best;
  return strong[0] ?? domainBrand(domain);
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
