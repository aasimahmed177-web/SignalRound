// Pure readers for funding news: which rounds count (pre-seed to Series C), the company a headline names, the
// founders an article names, whether a domain is the company's own, and the public emails a page prints.
// Nothing here guesses an email: every address returned was found verbatim in the page it came from.

import { load } from "cheerio";
import { emailQuote, extractEmails } from "./linkedin-posts.ts";

export type StageKey = "pre_seed" | "seed" | "series_a" | "series_b" | "series_c";
export interface StageRead {
  key: StageKey;
  asWritten: string;
}
export type StageResult = StageRead | { excluded: string } | null;

const DASH = "[-‐‑–—\\s]?";
const STAGE_RE = new RegExp(
  String.raw`\b(pre${DASH}series${DASH}([a-z])|series${DASH}([a-z])(?:\d|\+)?|pre${DASH}seed|seed|angel)\b(?![-‐‑–—\s]?(?:stage|fund\b|funds\b|investors?\b|vc\b|capital\b|accelerator|one\b|list\b|network\b))`,
  "gi",
);
const RAISE_VERB =
  /\b(?:raises?|raised|raising|secures?|secured|bags?|bagged|lands?|landed|closes?|closed|nets?|netted|grabs?|snags?|scores?|picks? up|pulls? in|rakes? in|gets?|receives?|received|banks?|attracts?|draws?|mops? up|hauls?|clinches?|completes?|completed|announces?|announced|adds?|moves? on|takes? off with|collects?|locks? in|kicks? off|funding|round)\b/i;

/** The round a text names, as written. Series D and later are excluded, not skipped silently. */
export function readStage(text: string): StageResult {
  const raise = text.search(RAISE_VERB);
  const matches = [...text.matchAll(STAGE_RE)];
  if (!matches.length) return null;
  const match = matches.find((m) => raise < 0 || (m.index ?? 0) >= raise) ?? matches[0];
  if (!match) return null;
  const word = match[0];
  const preLetter = match[2]?.toLowerCase();
  const letter = match[3]?.toLowerCase();
  if (preLetter) {
    if (preLetter > "c") return { excluded: `pre-series ${preLetter}` };
    return { key: preLetter === "a" ? "seed" : preLetter === "b" ? "series_a" : "series_b", asWritten: tidyStage(word) };
  }
  if (letter) {
    if (letter > "c") return { excluded: `series ${letter}` };
    return { key: `series_${letter}` as StageKey, asWritten: tidyStage(word) };
  }
  if (/^pre/i.test(word)) return { key: "pre_seed", asWritten: tidyStage(word) };
  if (/^angel/i.test(word)) return { key: "pre_seed", asWritten: "Angel" };
  return { key: "seed", asWritten: "Seed" };
}

function tidyStage(word: string): string {
  return word
    .replace(/[-‐‑–—\s]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/^Pre /, "Pre-")
    .replace(/Series(?=[A-Z])/, "Series ");
}

const EXCLUSIONS: Array<[RegExp, string]> = [
  [/\b(?:acquires?|acquired|acquisition|acquihire|merges?|merger|buys|buyout|takeover|stake sale)\b/i, "acquisition"],
  [/\b(?:IPO|DRHP|public listing|goes public|lists on|SPAC)\b/, "ipo"],
  [
    /\b(?:fund (?:I|II|III|IV|V|\d)\b|first close|final close|(?:maiden|debut|new|venture|second|third) fund|corpus|limited partners)/i,
    "fund launch",
  ],
  [
    /\b(?:this week|weekly|round-?up|funding galore|biggest (?:funding )?rounds|top \d+|startups raised|deals? (?:tracker|report))\b/i,
    "roundup",
  ],
];
const DEBT = /\b(?:venture debt|debt (?:financing|funding|round)|in debt|credit (?:line|facility)|loan|NCDs?|working capital)\b/i;
const GRANT = /\b(?:grants?|prize|award)\b/i;

/** Why a headline is not an equity round we want, or null when it may be one. */
export function excludedDeal(title: string): string | null {
  for (const [re, reason] of EXCLUSIONS) if (re.test(title)) return reason;
  const stage = readStage(title);
  if (stage && "excluded" in stage) return stage.excluded;
  if (!stage && DEBT.test(title)) return "debt";
  if (!stage && GRANT.test(title)) return "grant";
  return null;
}

const AMOUNT =
  /(?:(?:US|A|AU|C|CA|S|NZ|HK)?\$|€|£|₹|¥|Rs\.?\s?|INR\s?|USD\s?|EUR\s?|GBP\s?|AUD\s?|CAD\s?|SGD\s?|NGN\s?|KES\s?|ZAR\s?|R\s?(?=\d))\s?\d[\d,]*(?:\.\d+)?\s?(?:k\b|K\b|m\b|M\b|mn\b|Mn\b|MN\b|million\b|Million\b|bn\b|Bn\b|B\b|billion\b|Billion\b|cr\b|Cr\b|crore\b|Crore\b|lakh\b|Lakh\b)?(?:\s?million)?|\d[\d,]*(?:\.\d+)?\s?(?:million|Million|crore|Crore|Cr|Mn)\s?(?:dollars|euros|pounds|rupees|USD|EUR|GBP|AUD)?/g;

/** The first amount the text states, as written ("$6 Mn", "Rs 100 Cr", "€1.9M"). */
export function amountAsWritten(text: string): string | null {
  for (const match of text.matchAll(AMOUNT)) {
    const value = match[0].trim();
    // "$1B valuation" is not the round.
    const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 14);
    if (/^\s*(?:valuation|post-money|pre-money)/i.test(after)) continue;
    if (/\d/.test(value)) return value.replace(/\s+/g, " ").replace(/[*]+$/, "");
  }
  return null;
}

const SUBJECT_VERB =
  /^(.+?)\s+(?:has\s+|have\s+|just\s+)?(?:raises?|raised|secures?|secured|bags?|bagged|lands?|landed|closes?|closed|nets?|grabs?|snags?|scores?|picks? up|pulls? in|rakes? in|gets?|receives?|banks?|attracts?|draws?|mops? up|hauls?|clinches?|completes?|announces?|adds?|moves? on|takes? off with|collects?|locks? in|kicks? off|wins?|(?:is\s+)?(?:set\s+)?to\s+raise)\b/i;
const INVESTOR_FIRST = /\b(?:leads?|co-leads?|backs?|invests?|bets?|participates?)\b(.*)$/i;
const DESCRIPTOR =
  /\b(?:start-?ups?|platform|company|firm|maker|developer|provider|marketplace|brand|player|operator|manufacturer|unicorn|specialist|outfit|innovator|pioneer|venture|business|solution|spinout|spin-off|scaleup|scale-up)\b/gi;
const PARTICLES = new Set(["of", "and", "&", "the", "de", "on", "for", "by", "in", "x", "la", "le", "du", "da", "von", "van"]);
const NOT_A_NAME = new Set([
  "startup",
  "startups",
  "company",
  "it",
  "this",
  "the startup",
  "indian startups",
  "firm",
  "platform",
  "stealth",
  "report",
]);

/** The company a funding headline is about, without the descriptors around it ("Spacetech startup X" → "X"). */
export function companyFromHeadline(title: string): string | null {
  const text = title
    .normalize("NFKC")
    .replace(/^\s*(?:\[[^\]]*\]|exclusive|breaking|funding|update|news|report|scoop)\s*[:|–—-]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const direct = SUBJECT_VERB.exec(text)?.[1];
  if (direct && !INVESTOR_FIRST.test(direct)) return cleanCompanyName(direct);
  const rest = INVESTOR_FIRST.exec(text)?.[1];
  if (!rest) return direct ? cleanCompanyName(direct) : null;
  // "Antler leads pre-seed round in delivery startup Dispatch Network", "X participates in Ottonomy's Rs 40 Cr round"
  const target = /\b(?:in|into|on)\s+(.+)$/i.exec(rest)?.[1] ?? rest;
  const subject = target.split(/['’]s\b|\s+(?:to|for|with|as|at|after|amid)\s+|\s+[-–—|]\s+/i)[0] ?? "";
  return cleanCompanyName(subject.replace(AMOUNT, " ").replace(STAGE_RE, " "));
}

/** Strip the words around a company name that headlines add. Returns null when nothing name-like is left. */
export function cleanCompanyName(raw: string): string | null {
  let name = raw
    .normalize("NFKC")
    .replace(/\([^)]*\)/g, " ")
    .replace(/["“”‘’']/g, (c) => (c === "'" || c === "’" ? c : " "))
    .replace(/\s+/g, " ")
    .trim();
  // Appositive: "Ana Example’s adtech, Snipwise," → "Snipwise"
  const parts = name
    .split(/\s*,\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) name = parts.at(-1) ?? name;
  // Possessive lead: "Nigeria’s Moniepoint" → "Moniepoint"
  const possessive = /^(.+?)['’]s\s+(.+)$/.exec(name);
  if (possessive?.[2] && /\p{Lu}/u.test(possessive[2])) name = possessive[2];
  name = name.replace(/\b[\p{L}\d.&-]+(?:\s[\p{L}\d.&-]+)?-(?:based|backed|founded|headquartered|led)\b/giu, " ").trim();
  let cut = -1;
  for (const match of name.matchAll(DESCRIPTOR)) cut = (match.index ?? 0) + match[0].length;
  if (cut > 0 && name.slice(cut).trim()) name = name.slice(cut).trim();
  let tokens = name.split(" ").filter(Boolean);
  if (tokens.length > 1 && /^[\p{L}-]+tech$/iu.test(tokens[0] ?? "")) tokens = tokens.slice(1);
  // Sentence-case headlines describe in lowercase and name in capitals: "Unified AI workspace CurvetAI" → "CurvetAI".
  const lastLower = tokens.findLastIndex((token) => /^[a-z][a-z-]+$/.test(token) && !PARTICLES.has(token));
  if (lastLower >= 0 && lastLower < tokens.length - 1) tokens = tokens.slice(lastLower + 1);
  name = tokens
    .join(" ")
    .replace(/^(?:[Tt]he|[Aa]n?)\s+(?=\p{Ll})/u, "")
    .replace(/\s+(?:Inc\.?|Ltd\.?|LLC|GmbH|Pvt\.?(?:\s+Ltd\.?)?|Private Limited|Limited|Corp\.?|S\.A\.|SAS|B\.V\.|AG|Oy|AB)$/i, "")
    .replace(/^[\s:,.–—-]+|[\s:,.–—-]+$/g, "")
    .trim();
  if (!name || name.length > 50 || name.split(" ").length > 5 || !/\p{L}/u.test(name)) return null;
  name = name.replace(/^(?:(?:of|and|in|for|by|on|the)\s+)+(?=\p{Lu})/u, "");
  if (NOT_A_NAME.has(name.toLowerCase()) || /[;:]/.test(name)) return null;
  // "AI coworker startup": a description with no name in it.
  if (/\b(?:start-?ups?|company|firm|platform|maker|developer|provider|unicorn|manufacturer)$/i.test(name)) return null;
  return name;
}

const GENERIC = new Set([
  "ai",
  "app",
  "apps",
  "hq",
  "inc",
  "labs",
  "lab",
  "technologies",
  "technology",
  "tech",
  "solutions",
  "group",
  "io",
  "co",
]);

/** A key two spellings of one company share: "Venomics AI" and "Venomics" → "venomics". */
export function companyKey(name: string): string {
  const tokens = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
  const core = tokens.filter((token) => !GENERIC.has(token));
  return (core.length ? core : tokens).join("");
}

const compact = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");

const TWO_PART_SUFFIXES = new Set([
  "co.in",
  "co.uk",
  "com.au",
  "co.nz",
  "com.sg",
  "co.za",
  "com.br",
  "com.ng",
  "co.ke",
  "com.my",
  "co.id",
  "com.mx",
]);

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function rootDomain(host: string): string {
  const parts = host.replace(/^www\./, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  return TWO_PART_SUFFIXES.has(parts.slice(-2).join(".")) ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
}

/** The registrable label: "app.cosmoserve.space" → "cosmoserve", "acme.co.in" → "acme". */
export function domainStem(url: string): string {
  return rootDomain(hostOf(url)).split(".")[0] ?? "";
}

const NOT_COMPANY_HOSTS =
  /(?:^|\.)(?:linkedin|facebook|instagram|twitter|x|youtube|tiktok|medium|substack|wikipedia|crunchbase|tracxn|pitchbook|dealroom|cbinsights|zaubacorp|tofler|google|bing|apple|play\.google|github|notion|wix|wordpress|blogspot|entrackr|inc42|yourstory|techcrunch|eu-startups|tech|techcabal|startupdaily|businesswire|prnewswire|globenewswire|einpresswire|economictimes|indiatimes|moneycontrol|livemint|business-standard|vccircle|thehindubusinessline|pulse2|finsmes|venturebeat|bloomberg|reuters|forbes|cnbc|siliconangle|crowdfundinsider|techfundingnews|sifted|axios|fintech|news|newswire|press|ipocentral|barandbench|indianstartuptimes|citybiz|miragenews|tradersunion|wowtale|law|unite)\.[a-z.]+$/i;

/** Whether a URL is the company's own site: its domain spells the name, or the page names itself after it. */
export function websiteMatches(company: string, url: string, page?: { title?: string; siteName?: string }): boolean {
  const host = hostOf(url);
  if (!host || NOT_COMPANY_HOSTS.test(rootDomain(host))) return false;
  const stem = compact(domainStem(url));
  const full = compact(company);
  const core = compactCore(company);
  if (stem.length < 2) return false;
  if (stem === full || stem === core) return true;
  const titled = compact(`${page?.title ?? ""} ${page?.siteName ?? ""}`);
  const named = core.length >= 3 && titled.includes(core);
  // getcosmoserve, cosmoservespace, cosmoserve-hq: the stem contains the name (or the name the stem) and the page agrees.
  const related = (core.length >= 4 && stem.includes(core)) || (stem.length >= 4 && (full.startsWith(stem) || core.startsWith(stem)));
  return (
    related &&
    (named ||
      stem.replace(/^(?:get|try|use|join|go|hello|with|my|the)/, "").replace(/(?:hq|app|ai|labs|tech|io|inc|global|india)$/, "") === core)
  );
}

function compactCore(company: string): string {
  const tokens = company.split(/\s+/).filter((token) => !GENERIC.has(token.toLowerCase()));
  return compact(tokens.length ? tokens.join("") : company);
}

/** Domains worth trying for a company before searching: its name on common startup TLDs. */
export function domainGuesses(company: string): string[] {
  const full = compact(company);
  const core = compactCore(company);
  const words = company
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
  const stems = [...new Set([full, core, words.join("-")])].filter((stem) => stem.length >= 3);
  const tlds = [
    "com",
    "ai",
    "io",
    "co",
    "in",
    "app",
    "tech",
    "xyz",
    "so",
    "dev",
    "co.in",
    "eu",
    "de",
    "co.uk",
    "com.au",
    "health",
    "space",
  ];
  const hosts: string[] = [];
  // "Venomics AI" → venomics.ai first: a trailing TLD-like word usually is the TLD.
  const last = words.at(-1);
  if (words.length > 1 && last && ["ai", "io", "app", "co", "tech", "health", "space"].includes(last))
    hosts.push(`${words.slice(0, -1).join("")}.${last}`);
  for (const stem of stems) for (const tld of tlds) hosts.push(`${stem}.${tld}`);
  return [...new Set(hosts)];
}

const COUNTRIES: Array<[RegExp, string]> = [
  [
    /\b(?:India|Indian|Bengaluru|Bangalore|Mumbai|Delhi|New Delhi|Gurugram|Gurgaon|Noida|Pune|Hyderabad|Chennai|Kolkata|Ahmedabad|Jaipur|Kochi|Gandhinagar|Indore|Chandigarh)\b/,
    "India",
  ],
  [/\b(?:Nigeria|Nigerian|Lagos|Abuja)\b/, "Nigeria"],
  [/\b(?:Kenya|Kenyan|Nairobi)\b/, "Kenya"],
  [/\b(?:South Africa|South African|Cape Town|Johannesburg)\b/, "South Africa"],
  [/\b(?:Egypt|Egyptian|Cairo)\b/, "Egypt"],
  [/\b(?:Ghana|Ghanaian|Accra)\b/, "Ghana"],
  [/\b(?:UAE|Emirati|Dubai|Abu Dhabi)\b/, "United Arab Emirates"],
  [/\b(?:Saudi|Riyadh)\b/, "Saudi Arabia"],
  [/\b(?:UK|U\.K\.|British|London|Manchester|Edinburgh|Cambridge, UK|Oxford)\b/, "United Kingdom"],
  [/\b(?:Germany|German|Berlin|Munich|Hamburg|Cologne)\b/, "Germany"],
  [/\b(?:France|French|Paris|Lyon)\b/, "France"],
  [/\b(?:Spain|Spanish|Madrid|Barcelona)\b/, "Spain"],
  [/\b(?:Italy|Italian|Milan|Rome|Turin)\b/, "Italy"],
  [/\b(?:Netherlands|Dutch|Amsterdam|Rotterdam|Utrecht)\b/, "Netherlands"],
  [/\b(?:Sweden|Swedish|Stockholm)\b/, "Sweden"],
  [/\b(?:Denmark|Danish|Copenhagen)\b/, "Denmark"],
  [/\b(?:Norway|Norwegian|Oslo)\b/, "Norway"],
  [/\b(?:Finland|Finnish|Helsinki)\b/, "Finland"],
  [/\b(?:Ireland|Irish|Dublin)\b/, "Ireland"],
  [/\b(?:Switzerland|Swiss|Zurich|Geneva|Lausanne)\b/, "Switzerland"],
  [/\b(?:Austria|Austrian|Vienna)\b/, "Austria"],
  [/\b(?:Belgium|Belgian|Brussels|Ghent)\b/, "Belgium"],
  [/\b(?:Portugal|Portuguese|Lisbon|Porto)\b/, "Portugal"],
  [/\b(?:Poland|Polish|Warsaw|Krakow)\b/, "Poland"],
  [/\b(?:Estonia|Estonian|Tallinn)\b/, "Estonia"],
  [/\b(?:Lithuania|Lithuanian|Vilnius)\b/, "Lithuania"],
  [/\b(?:Czech|Prague)\b/, "Czech Republic"],
  [/\b(?:Greece|Greek|Athens)\b/, "Greece"],
  [/\b(?:Israel|Israeli|Tel Aviv)\b/, "Israel"],
  [/\b(?:Australia|Australian|Sydney|Melbourne|Brisbane|Perth|Adelaide)\b/, "Australia"],
  [/\b(?:New Zealand|Auckland|Wellington)\b/, "New Zealand"],
  [/\b(?:Singapore|Singaporean)\b/, "Singapore"],
  [/\b(?:Indonesia|Indonesian|Jakarta)\b/, "Indonesia"],
  [/\b(?:Japan|Japanese|Tokyo)\b/, "Japan"],
  [/\b(?:Korea|Korean|Seoul)\b/, "South Korea"],
  [/\b(?:Canada|Canadian|Toronto|Vancouver|Montreal)\b/, "Canada"],
  [/\b(?:Brazil|Brazilian|São Paulo|Sao Paulo)\b/, "Brazil"],
  [/\b(?:Mexico|Mexican)\b/, "Mexico"],
  [
    /\b(?:US|U\.S\.|American|San Francisco|New York|NYC|Boston|Seattle|Austin|Los Angeles|Chicago|Miami|Denver|Palo Alto|Silicon Valley|Delaware)\b/,
    "United States",
  ],
];

/** The country the opening of an article places the company in, or the source's default. */
export function countryFromText(text: string, fallback: string | null = null): string | null {
  const opening = text.slice(0, 600);
  if (fallback && COUNTRIES.some(([re, country]) => country === fallback && re.test(text.slice(0, 1500)))) return fallback;
  let best: { at: number; country: string } | null = null;
  for (const [re, country] of COUNTRIES) {
    for (const match of opening.matchAll(new RegExp(re.source, "g"))) {
      const at = match.index ?? 0;
      // "Japan-based Rebright Partners" places an investor, not the company.
      const after = opening.slice(at + match[0].length, at + match[0].length + 40);
      if (
        /^(?:-based|\s)?\s*(?:investors?|VCs?|venture|fund|family office|angels?|firm|\p{Lu}[\p{L}]+ (?:Capital|Ventures|Partners))/iu.test(
          after,
        )
      )
        continue;
      if (country === fallback) return fallback;
      if (!best || at < best.at) best = { at, country };
      break;
    }
  }
  return best?.country ?? fallback;
}

export interface FounderMention {
  name: string;
  role: string;
  quote: string;
}

const NAME_TOKEN = String.raw`\p{Lu}[\p{Ll}\p{Lu}'’.-]*`;
const NAME = String.raw`(?:(?:Dr|Prof|Mr|Ms|Mrs)\.?\s+)?${NAME_TOKEN}(?:\s+(?:${NAME_TOKEN}|de|da|van|von|der|bin|al|el|di|du|dos|la|le)){1,3}`;
const LIST = String.raw`${NAME}(?:\s*,\s*${NAME})*(?:,?\s+(?:and|&)\s+${NAME})?`;
const ROLE = String.raw`(?i:co-?founders?|founders?|ceo|chief executive(?: officer)?|managing director|owner)(?:\s*(?:,|&|and)\s*(?i:co-?founder|founder|ceo|cto|coo|cfo|cpo|chief [a-z]+ officer|managing director|president|chair(?:man|person)?))*`;
const ORG_WORDS =
  /\b(?:Ventures?|Capital|Partners|Fund|Funds|Labs?|Technologies|Technology|Holdings|Group|Bank|Angels?|Network|Investments?|Advisors|Equity|Inc|Ltd|LLP|LLC|Foundation|University|Institute|Space|Robotics|AI|Series|Seed|Round|Global|India|Media|Studio|Health|Systems|Partner|Accelerator|Combinator|Venture|Family|Office|Bharat|Group|Startup|Platform|Company|Officer|Founder|CEO|Chief)\b/;
const NON_PERSON_TOKEN =
  /^(?:The|This|That|Its|Our|In|With|Said|According|Mr|Ms|Mrs|Founded|Launched|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|Also|Earlier|Last|While|After|Before|President|Chairman|Chairperson|Credit|Photo|Image|Source|Partner|Director)$/;

export function personName(raw: string, company: string): string | null {
  const name = raw
    .replace(/^(?:Dr|Prof|Mr|Ms|Mrs)\.?\s+/, "")
    .replace(/\s+(?:de|da|van|von|der|bin|al|el|di|du|dos|la|le)$/, "")
    .replace(/['’]s$/, "")
    .replace(/[.,]+$/, "")
    .trim();
  const tokens = name.replace(/\s+(?:de|da|van|von|der|bin|al|el|di|du|dos|la|le)$/, "").split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4) return null;
  // "Joe JablonskiCo" is a name run into the "Co-Founder" title beside it.
  if (tokens.some((token) => /\p{Ll}(?:Co|CEO|Founder|CTO)$/u.test(token))) return null;
  if (ORG_WORDS.test(name) || tokens.some((token) => NON_PERSON_TOKEN.test(token))) return null;
  const companyTokens = new Set(company.toLowerCase().split(/\s+/));
  if (tokens.some((token) => companyTokens.has(token.toLowerCase()))) return null;
  if (tokens.some((token) => token.length > 1 && token === token.toUpperCase() && !/[.]/.test(token))) return null;
  return name;
}

function splitList(list: string): string[] {
  return list
    .split(/\s*,\s*(?:(?:and|&)\s+)?|\s+(?:and|&)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function tidyRole(role: string, plural = false): string {
  const value = role
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\bco-?founders?\b/, "co-founder")
    .replace(/\bfounders\b/, "founder")
    .replace(/\bceo\b/, "CEO")
    .replace(/\bcto\b/, "CTO")
    .replace(/\bcoo\b/, "COO")
    .replace(/\bcfo\b/, "CFO")
    .replace(/\bcpo\b/, "CPO")
    .trim();
  const out = plural && value === "founder" ? "co-founder" : value;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

const sentences = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[\p{Lu}"“])/u)
    .filter((sentence) => sentence.length < 600);

/** People an article says founded or run the company, with the sentence that says so. */
export function foundersFromText(text: string, company: string, options: { strict?: boolean } = {}): FounderMention[] {
  const found = new Map<string, FounderMention>();
  const companyTokens = company
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 2 && !GENERIC.has(token));
  const mentionsCompany = (value: string) => companyTokens.some((token) => value.toLowerCase().includes(token));
  const add = (raw: string, role: string, quote: string) => {
    const name = personName(raw, company);
    if (!name) return;
    const key = name.toLowerCase();
    const old = found.get(key);
    if (!old || (old.role.length < role.length && /ceo|cto|coo/i.test(role))) found.set(key, { name, role, quote: quote.trim() });
  };
  for (const sentence of sentences(text)) {
    if (options.strict && !mentionsCompany(sentence)) continue;
    // "Founded in 2023 by A and B, X builds…" / "co-founded by A, B and C"
    for (const m of sentence.matchAll(
      new RegExp(String.raw`\b((?i:co-?founded|founded|started|set up|launched|established))\b[^.;]{0,40}?\bby\s+(${LIST})`, "gu"),
    )) {
      const names = splitList(m[2] ?? "");
      const before = sentence.slice(0, m.index ?? 0);
      // "Acme, the investor co-founded by …" is about another organisation unless the sentence is about the company.
      if (!mentionsCompany(sentence) && /\b(?:fund|ventures?|capital|investor)\b/i.test(before)) continue;
      for (const name of names) add(name, tidyRole(/co/i.test(m[1] ?? "") || names.length > 1 ? "co-founder" : "founder"), sentence);
    }
    // "A and B founded X in 2022"
    for (const m of sentence.matchAll(
      new RegExp(
        String.raw`(${LIST})\s+(?:co-?founded|founded|started|launched)\s+(?:the\s+(?:company|startup)|it|([\p{L}\d .&-]{2,40}?))\b`,
        "gu",
      ),
    )) {
      if (m[2] && !mentionsCompany(m[2])) continue;
      const names = splitList(m[1] ?? "");
      for (const name of names) add(name, tidyRole(names.length > 1 ? "co-founder" : "founder"), sentence);
    }
    // "A, co-founder and CEO of X," / "said A, founder, X"
    for (const m of sentence.matchAll(
      new RegExp(String.raw`(${NAME})\s*,\s*(?:the\s+|its\s+|a\s+)?(${ROLE})\b(?:\s+(?:of|at)\s+([^,.;]{2,60}))?`, "gu"),
    )) {
      if (m[3] && !mentionsCompany(m[3])) continue;
      if (!m[3] && !mentionsCompany(sentence)) continue;
      add(m[1] ?? "", tidyRole(m[2] ?? ""), sentence);
    }
    // "X founder and CEO A said" / "co-founders A and B" / "its CEO, A,"
    for (const m of sentence.matchAll(new RegExp(String.raw`(${ROLE})\s*,?\s+(${LIST})`, "gu"))) {
      const before = sentence.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
      const ownsRole =
        mentionsCompany(before) || /\b(?:its|the company['’]s|the startup['’]s|the firm['’]s)\s*$/i.test(before) || /^\s*$/.test(before);
      if (!ownsRole) continue;
      if (/\b(?:of|at)\s*$/i.test(before)) continue;
      const names = splitList(m[2] ?? "");
      for (const name of names) add(name, tidyRole(m[1] ?? "", names.length > 1), sentence);
    }
  }
  return [...found.values()];
}

/** The visible text of a page, one block per line, as a reader would see it. */
export function pageText(html: string): string {
  const $ = load(html);
  $("script,style,noscript,template,svg,iframe").remove();
  $("br").replaceWith("\n");
  $("p,div,li,h1,h2,h3,h4,h5,h6,tr,td,th,section,article,footer,header,address,span,a,dd,dt").each((_, element) => {
    $(element).append("\n");
  });
  return $.root()
    .text()
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export interface FoundEmail {
  email: string;
  source_url: string;
  quote: string;
}

const JUNK_EMAIL =
  /(?:^|[@.])(?:example|domain|email|yourdomain|yourcompany|company|test|sentry|wixpress|sentry-next|cloudflare|godaddy|wordpress|w3|schema|png|jpg)\.|^(?:no-?reply|donotreply|do-not-reply|user|name|your(?:name|email)?|first(?:name)?|email|abc|xyz|mailer-daemon|postmaster)@|\.(?:png|jpe?g|gif|webp|svg|css|js)$/i;

/** Every email the page prints or links (mailto), each with the text that shows it. */
export function pageEmails(html: string, url: string): FoundEmail[] {
  const text = pageText(html);
  const out = new Map<string, FoundEmail>();
  for (const email of extractEmails(text)) {
    if (JUNK_EMAIL.test(email)) continue;
    const quote = emailQuote(text, email);
    if (quote) out.set(email, { email, source_url: url, quote: shorten(quote, email) });
  }
  const $ = load(html);
  $("a[href^='mailto:' i]").each((_, element) => {
    const href = $(element).attr("href") ?? "";
    let email = "";
    try {
      email = decodeURIComponent(href.slice(7).split("?")[0] ?? "")
        .trim()
        .toLowerCase();
    } catch {
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) || JUNK_EMAIL.test(email) || out.has(email)) return;
    // The page shows only the link's words ("Email us"); the quote keeps those words and the address the link opens.
    const label = $(element).text().replace(/\s+/g, " ").trim();
    const block = $(element).closest("p,li,dd,td,address,h1,h2,h3,h4,h5,h6").first().text().replace(/\s+/g, " ").trim();
    const words = (block && block.length <= 160 ? block : label).slice(0, 160);
    out.set(email, { email, source_url: url, quote: words ? `${words} (mailto:${email})` : `mailto:${email}` });
  });
  return [...out.values()];
}

/** A quote that only shows a mailto link's words, not the address printed in text. */
export const linkOnlyQuote = (quote: string) => /\(?mailto:[^\s)]+\)?$/.test(quote.trim());

function shorten(quote: string, email: string): string {
  if (quote.length <= 220) return quote;
  const at = quote.toLowerCase().indexOf(email.toLowerCase());
  const start = Math.max(0, at - 100);
  return `${start ? "…" : ""}${quote.slice(start, at + email.length + 100).trim()}…`;
}

export type InboxType = "founders" | "general" | "sales" | "press" | "careers" | "support" | "person" | "other";

const fold = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");

// Locals that name a desk, not a person: "dev@" is not Dev Patel's own address unless the page says so.
const ROLE_LOCAL =
  /^(?:dev|devs|sales|press|media|news|info|hello|hi|hey|contact|team|support|admin|office|jobs|careers|hr|mail|marketing|ops|help|care|billing|legal|privacy|security|partner|partners|growth|design|data|hiring|talent|people|founders?|ceo|finance|accounts|service|studio|bill|apply|recruiting|recruit|events|community|investors|ir|pr|social)$/;

/**
 * Whether an address is this person's own because its local part spells their name: first+last in either order,
 * initial+last, first+initial, or the whole first name alone (never a fragment of it, never the surname alone, and
 * never a first name that is also a desk word like "dev" or "sales").
 */
export function emailNamesPerson(email: string, name: string): boolean {
  const parts = fold(name)
    .replace(/[^a-z\s-]/g, "")
    .split(/[\s-]+/)
    .filter((part) => part.length >= 2);
  const first = parts[0];
  const last = parts.at(-1);
  if (!first || !last || first === last) return false;
  const local = fold(email.split("@")[0] ?? "").replace(/[^a-z]/g, "");
  if (!local) return false;
  if ([`${first}${last}`, `${last}${first}`, `${first[0]}${last}`, `${first}${last[0]}`].includes(local)) return true;
  return first.length >= 3 && local === first && !ROLE_LOCAL.test(local);
}

/** "amit.testkar@" printed beside Ashwin Testkar: a first.last address whose first name is not theirs is someone else's. */
function namesSomeoneElse(email: string, name: string): boolean {
  const pieces = fold(email.split("@")[0] ?? "")
    .split(/[._-]+/)
    .filter((piece) => /^[a-z]{2,}$/.test(piece));
  if (pieces.length < 2) return false;
  const parts = fold(name).split(/[\s-]+/);
  return !parts.includes(pieces[0] ?? "");
}

/** Whether the words printed with an address name this person, so the page itself says the address is theirs. */
export function quoteNamesPerson(quote: string, name: string): boolean {
  return fold(quote).includes(fold(name));
}

/**
 * Whether an email is a founder's own, and which inbox a company address is. A founder's own address either spells
 * their name (emailNamesPerson) or is printed next to their full name; a desk address (sales@, careers@…) never is.
 */
export function classifyEmail(email: string, founders: Array<{ name: string }>, quote = ""): { founder?: string; inbox: InboxType } {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  const desk = founders.length ? classifyEmail(email, []).inbox : "other";
  for (const founder of founders) {
    if (emailNamesPerson(email, founder.name)) return { founder: founder.name, inbox: "person" };
    if (desk === "other" && quoteNamesPerson(quote, founder.name) && !namesSomeoneElse(email, founder.name))
      return { founder: founder.name, inbox: "person" };
  }
  if (/^(?:founders?|ceo|founder\.?office|cofounders?)$/.test(local)) return { inbox: "founders" };
  if (
    /^(?:hello|hi(?![a-z])|hey(?![a-z])|info|contact|team|office|enquir(?:y|ies)|inquir(?:y|ies)|general|admin|mail|connect|reachus|letstalk)/.test(
      local,
    )
  )
    return { inbox: "general" };
  if (/sales|business|partner|bd|growth|deals/.test(local)) return { inbox: "sales" };
  if (/press|media|pr$|news|comms/.test(local)) return { inbox: "press" };
  if (/career|jobs|hr|hiring|talent|recruit|people/.test(local)) return { inbox: "careers" };
  if (/support|help|care|service|privacy|legal|dpo|grievance|compliance|security|billing|accounts/.test(local)) return { inbox: "support" };
  return { inbox: "other" };
}

/** The founder's public LinkedIn profile, when a page links one whose slug or label carries their name. */
export function linkedinFor(name: string, links: Array<{ href: string; text: string }>): string | null {
  const parts = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z\s]/g, "")
    .split(/\s+/)
    .filter((part) => part.length >= 2);
  const first = parts[0];
  const last = parts.at(-1);
  if (!first || !last) return null;
  for (const link of links) {
    const slug = /linkedin\.com\/in\/([^/?#]+)/i.exec(link.href)?.[1];
    if (!slug) continue;
    const flat = decodeURIComponent(slug)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z]/g, "");
    const label = link.text.toLowerCase();
    if ((flat.includes(first) && flat.includes(last)) || (label.includes(first) && label.includes(last)))
      return `https://www.linkedin.com/in/${slug.replace(/\/$/, "")}`;
  }
  return null;
}

const TEAM_ROLE = /^(?:co-?founder|founder|ceo|chief executive)(?!['’]s)/i;

/** Founders a company's own team/about page lists: a name line followed by a founder or CEO title line. */
export function foundersFromTeamPage(html: string, company: string): FounderMention[] {
  const out: FounderMention[] = [];
  const $ = load(html);
  $("script[type='application/ld+json']").each((_, element) => {
    try {
      const data = JSON.parse($(element).text());
      for (const node of [data, ...(Array.isArray(data?.["@graph"]) ? data["@graph"] : [])].flat()) {
        for (const founder of [node?.founder ?? node?.founders ?? []].flat()) {
          const name = typeof founder === "string" ? founder : founder?.name;
          if (typeof name === "string" && personName(name, company))
            out.push({ name: name.trim(), role: "Founder", quote: `"founder": "${name.trim()}"` });
        }
      }
    } catch {
      /* not JSON */
    }
  });
  const lines = pageText(html)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const inline = new RegExp(String.raw`^(${NAME})\s*[,|–—-]\s*(${ROLE})\s*$`, "u").exec(line);
    // Only a bare title ("Co-founder & CEO"): "CEO, Restaurant Group" under a name is a testimonial.
    const role = TEAM_ROLE.test(line) && new RegExp(String.raw`^${ROLE}$`, "u").test(line.replace(/[|/]/g, "&").trim()) ? line : null;
    if (inline?.[1] && line.length <= 80) {
      const name = personName(inline[1], company);
      if (name) out.push({ name, role: tidyRole(inline[2] ?? ""), quote: line });
    } else if (role) {
      const previous = lines[i - 1] ?? "";
      if (previous.length > 40 || !new RegExp(String.raw`^${NAME}$`, "u").test(previous)) continue;
      const name = personName(previous, company);
      if (name) out.push({ name, role: tidyRole(role), quote: `${previous} — ${role}` });
    }
  }
  const unique = new Map(out.map((founder) => [founder.name.toLowerCase(), founder]));
  return [...unique.values()];
}

// ---- Leaders an imprint, press kit, team or contact page names line by line, and the words printed with an email ----

const LINE_PERSON = String.raw`\p{Lu}[\p{Ll}\p{Lu}'’-]+(?:\s+(?:["“][^"”]{1,20}["”]\s+)?(?:\p{Lu}[\p{Ll}\p{Lu}'’-]+|de|da|van|von|der|di|du|dos|la|le|al|el|bin)){1,3}`;
const OFFICER = String.raw`(?:cto|coo|cfo|cpo|cmo|ceo|president)`;
const LEADER_TITLE = String.raw`(?i:managing directors?|geschäftsführer(?:in)?|geschaeftsfuehrer(?:in)?|chief executive officer|ceo|co-?founders?(?:\s*(?:&|and|,)\s*${OFFICER})?|founders?(?:\s*(?:&|and|,)\s*${OFFICER})?)`;
// "Represented by (Managing Director): Ana Example", "Geschäftsführer: Max Muster und Erika Muster", "CEO: Ana Lane"
const TITLE_THEN_NAMES = new RegExp(
  String.raw`(?:^|[\s(])(${LEADER_TITLE})\)?\s*[:：]\s*(${LINE_PERSON}(?:\s*(?:,|&|and|und)\s*${LINE_PERSON})*)`,
  "u",
);
// "Ana Example — Co-Founder & CTO: Space engineer…", "Ana Lane, CEO"
const NAME_THEN_TITLE = new RegExp(String.raw`^(${LINE_PERSON})\s*(?:[—–|,]|\s-\s)\s*(${LEADER_TITLE})(?=\s*(?:[:.(,;]|$))`, "u");
// A contact card: the name on one line and the title alone on the next ("Ana Example" / "CEO" / "ana@acme.example").
const NAME_LINE = new RegExp(String.raw`^(${LINE_PERSON})$`, "u");
const TITLE_LINE = new RegExp(String.raw`^(${LEADER_TITLE})$`, "u");

const tidy = (value: string) => value.replace(/\s+/g, " ").trim();
const dropNickname = (name: string) => tidy(name.replace(/["“][^"”]*["”]/g, " "));
const roleLabel = (title: string) => (/gesch/i.test(title) ? "Managing director" : tidyRole(title));

/** Leaders an imprint, press kit, team or contact page names line by line ("Managing Director: Name", "Name — CEO"). */
export function leadersFromText(body: string, company: string): FounderMention[] {
  const out: FounderMention[] = [];
  const lines = body.split("\n").map(tidy);
  for (const [index, line] of lines.entries()) {
    if (!line || line.length > 300) continue;
    const next = lines[index + 1] ?? "";
    const card = NAME_LINE.exec(line);
    const cardTitle = card ? TITLE_LINE.exec(next) : null;
    if (card?.[1] && cardTitle?.[1]) {
      const name = personName(dropNickname(card[1]), company);
      if (name) out.push({ name, role: roleLabel(cardTitle[1]), quote: `${line} · ${next}` });
      continue;
    }
    const titled = TITLE_THEN_NAMES.exec(line);
    if (titled?.[1] && titled[2])
      for (const part of titled[2].split(/\s*(?:,|&|\band\b|\bund\b)\s*/)) {
        const name = personName(dropNickname(part), company);
        if (name) out.push({ name, role: roleLabel(titled[1]), quote: line.slice(0, 240) });
      }
    const named = NAME_THEN_TITLE.exec(line);
    if (named?.[1] && named[2]) {
      const name = personName(dropNickname(named[1]), company);
      if (name) out.push({ name, role: roleLabel(named[2]), quote: line.slice(0, 240) });
    }
  }
  return out;
}

/**
 * The words around an email a page prints bare (a contact card's address line, or a mailto link): up to two short
 * lines just above it on the page, joined with " · " ("Ana Example · CEO · ana@acme.example"). Other quotes are kept.
 */
export function cardQuote(body: string, found: FoundEmail): FoundEmail {
  const bare = found.quote.trim().toLowerCase() === found.email || linkOnlyQuote(found.quote);
  if (!bare) return found;
  const lines = body.split("\n").map(tidy);
  const at = lines.findIndex((line) => line.toLowerCase().includes(found.email) && line.length <= found.email.length + 40);
  if (at < 0) return found;
  const above: string[] = [];
  for (const line of lines.slice(Math.max(0, at - 2), at).reverse()) {
    if (!line || line.length > 60 || line.includes("@")) break;
    above.unshift(line);
  }
  return above.length ? { ...found, quote: [...above, lines[at]].join(" · ") } : found;
}

/** Every email a page prints, with a contact card's name and title joined into the quote of a bare address. */
export function pageEmailsInContext(html: string, url: string): FoundEmail[] {
  const body = pageText(html);
  return pageEmails(html, url).map((email) => cardQuote(body, email));
}
