// Outreach email drafts for funded companies and marketing roles. Drafts only: nothing here sends mail, talks to
// Gmail or calls an LLM. Every draft goes to an email that was printed publicly (kept with its source page and the
// words around it), opens with a fact from the data, and cites only the sender's real results for that industry.

import { classifyIndustry, type IndustryLabel } from "./industry.ts";

// --- Inputs: the shapes of evals/runs/funded-founders.json and evals/runs/marketing-jobs.json, loosely typed. ---

export interface PostedEmail {
  email: string;
  source_url: string;
  quote: string;
  kind?: string;
  inbox?: string;
}
export interface FounderLead {
  name: string;
  role?: string | null;
  source_url?: string | null;
  quote?: string | null;
  emails: PostedEmail[];
}
export interface FundedLead {
  company: string;
  website: string | null;
  brief: string | null;
  industry: { label: string; confidence: number; evidence_quote?: string | null; source_url?: string | null } | null;
  country?: string | null;
  stage: string;
  amount: string | null;
  announced_on: string;
  funding_source_url: string;
  /** Other articles about the same round. */
  other_sources?: string[] | null;
  founders: FounderLead[];
  company_emails: PostedEmail[];
}
export interface JobLead {
  title: string;
  company: string;
  company_brief: string | null;
  location?: string | null;
  posted_at: string;
  source: string;
  source_url: string;
  apply_url?: string | null;
  emails: string[];
  email_source_quote: string | null;
  fit?: { score: number } | null;
}

// --- Output ---

export interface Fact {
  fact: string;
  source_url: string;
}
export interface Draft {
  id: string;
  kind: "founder" | "job";
  to: { email: string; source_url: string; quote: string; name: string | null };
  company: string;
  website: string | null;
  role: string | null;
  /** Where the job was posted ("Indeed listing"); null for founder drafts. */
  posted_on: string | null;
  subject: string;
  body: string;
  /** What the sender must attach before sending: always the CV for jobs, plus a portfolio when the posting asks. */
  attachments: string[];
  /** Things to check by hand before sending, e.g. a subject line the posting dictates but the saved quote cut off. */
  check_before_sending: string[];
  proof_used: { key: ProofKey; industry: string; industry_confidence: number; lines: string[]; why?: string };
  facts_used: Fact[];
  fit_score?: number;
}
export interface Skipped {
  kind: "founder" | "job";
  company: string;
  reason: string;
}

export const CALL_ASK = "Let's have a quick call sometime this week or next.";
export const MAX_WORDS = 110;

// --- Proof: only the sender's real results, matched to the lead's industry. Never add a metric here that is not real. ---

export type ProofKey = "newton_school" | "healthcare" | "living_expert" | "hiring" | "workindia_app" | "leadgentic";

const LEADGENTIC_FULL =
  "As Head of Media Buying at Leadgentic (formerly Creators Collective) from 2023 to 2025, I ran B2B client acquisition that took agency revenue from about $50K to $200K+ a month.";
const LEADGENTIC_SHORT =
  "I was Head of Media Buying at Leadgentic (formerly Creators Collective) from 2023 to 2025, where B2B client acquisition took agency revenue from about $50K to $200K+ a month.";

const LEADGENTIC_TINY = "As Head of Media Buying at Leadgentic, 2023 to 2025, I took agency revenue from about $50K to $200K+ a month.";

export const PROOF: Record<ProofKey, string> = {
  newton_school: "At Newton School I halved the cost per application and cut the cost per paid test by 58%.",
  healthcare:
    "For Shraddha, a healthcare client, my campaigns returned 2.61x ROAS and brought in 142 patients, and I have also worked with Mave Health.",
  living_expert: "For Living Expert, a real estate client, I generated about 500 leads that turned into 3 closed deals in the UAE.",
  hiring: "I have worked on growth for WorkIndia and Vahan, both hiring platforms.",
  workindia_app: "I have worked on app user growth for WorkIndia, measured on its app metrics.",
  leadgentic: LEADGENTIC_FULL,
};

/** The numbers each proof may cite. A draft that shows any other figure fails the proof check. */
export const PROOF_METRICS: Record<ProofKey, string[]> = {
  newton_school: ["58%"],
  healthcare: ["2.61x", "142"],
  living_expert: ["500", "3"],
  hiring: [],
  workindia_app: [],
  leadgentic: ["$50K", "$200K+", "2023", "2025"],
};

const INDUSTRY_PROOF: Partial<Record<IndustryLabel, ProofKey>> = {
  edtech: "newton_school",
  healthcare: "healthcare",
  real_estate: "living_expert",
  hiring_marketplace: "hiring",
  consumer_app: "workindia_app",
  agency: "leadgentic",
  b2b_saas: "leadgentic",
};

/** Below this an industry tag rests on one or two weak words: a specific case study would be a stretch, so Leadgentic B2B. */
export const MIN_INDUSTRY_CONFIDENCE = 0.3;

export function proofFor(label: string | null | undefined, confidence = 1): ProofKey {
  if (!label || confidence < MIN_INDUSTRY_CONFIDENCE) return "leadgentic";
  return INDUSTRY_PROOF[label as IndustryLabel] ?? "leadgentic";
}

/**
 * The proof lines for a key: the matched case study plus the Leadgentic line, or Leadgentic alone. The Leadgentic
 * line is B2B client acquisition, so it is added only when the lead sells to businesses (withLeadgentic).
 */
export function proofLines(key: ProofKey, short = false, withLeadgentic = true): string[] {
  if (key === "leadgentic") return [short ? LEADGENTIC_TINY : LEADGENTIC_FULL];
  return short || !withLeadgentic ? [PROOF[key]] : [PROOF[key], LEADGENTIC_SHORT];
}

/**
 * A word that makes a brief about patients, clinics or care. "Healthcare" alone does not count, since a robot or
 * software vendor lists it among the sectors it serves (Ottonomy: "healthcare, industrial and parcel"), and neither do
 * "pain", "injury" or "wellness", which a gym, a law firm or a sports-data company also says.
 */
export const HEALTH_TERM =
  /\b(?:patients?|clinics?|clinical|clinicians?|hospitals?|doctors?|physicians?|dental|dentists?|orthodont\w*|therap(?:y|ies|ist|ists|eutic)|physio\w*|rehab(?:ilitation)?|surger(?:y|ies)|surgical|medical services|hearing|vertigo|pain management|nurs(?:e|es|ing)|mental health|care homes?|checkups?)\b/i;

/** Students, exams and courses: an education business, even when its teachers are doctors (PrepMed NEET coaching). */
export const EDTECH_TERM =
  /\b(?:students?|learners?|courses?|(?:exam|neet|jee|acca|cma|cia|upsc|ielts|online) coaching|coaching (?:classes|institutes?|cent(?:re|er)s?)|tuition|tutors?|exams?|exam prep\w*|neet|jee|bootcamps?|college|universit(?:y|ies)|ug & pg|industry-ready|e-?learning|online classes)\b/i;

/** The company's own product is an app (not an agency that builds apps for others). */
const APP_PRODUCT =
  /\b(?:the|our|an?)\s+(?:[\w-]+\s+){0,4}app\b(?!\s+(?:development|developers?|agency))|\bapp\s+for\b|app store|play store/i;

const REAL_ESTATE_TERM = /real estate|\bpropert(?:y|ies)\b|\brealtors?\b|home ?buyers|\bapartments\b|\bcondos?\b/i;

const HIRING_TERM =
  /\brecruit(?:ment|ers?|ing)\b|\bstaffing\b|job seekers|headhunt\w*|executive search|talent agency|hire (?:talent|a pre-vetted)|hr outsourcing|job board/i;

/**
 * A positive sign that the company sells to other businesses: the only case where the Leadgentic line (B2B client
 * acquisition for an agency) says something relevant.
 */
export const B2B_SIGNAL =
  /\bb2b\b|\bclients\b|\bbusinesses\b|\byour business\b|\benterprises?\b|\b(?:helps?|helping|for|with|your|serving|empowers?) brands\b|\bagenc(?:y|ies)\b|\bemployers\b|\boperators\b|\bteams\b|(?<!group of )\bcompanies\b|\borgani[sz]ations\b|\bstartups\b|\bmerchants\b|\bretailers\b|\bsmes?\b|\bsaas\b|\bmarketers\b|\butilities\b|\bcontractors\b|\baccountants\b|\bpublishers\b|\bsuppliers?\b|\bdistribut\w*|\bmanufactur\w*|\bwholesale\b|\bindustrial\b|\bthe [\w ]{1,30} industry\b|\bconsult(?:ing|ancy|ants?)\b|\boutsourc\w*|\boffshore\b|\bit solutions\b|\bmanaged it\b|\bcybersecurity\b|\bsoftware (?:development|engineering)\b|\bcustom (?:software|websites?)\b|\bweb(?:site)? (?:design|development)\b|\bdigital (?:marketing|solutions|products)\b|\bmarketing (?:agency|company|consult\w*|solutions|support)\b|\bmedia buying\b|\bcreative services\b|\blead generation\b|\baffiliate marketing\b|\bdata solutions\b|\bgrc\b|\binvoicing\b|\bcrm\b|\bprocurement\b|\bsourcing\b|warranty claims|\bclinical teams\b|professional clubs|investment office/i;

/**
 * Consumer and local businesses: a theme park, a bakery, a salon, a law firm for individuals. The Leadgentic B2B line
 * never goes to these, even when their copy says "clients" or "brands".
 */
export const CONSUMER_LOCAL =
  /theme park|adventure park|amusement|family entertainment|\bcakes?\b|\bbaker(?:y|ies)\b|\bbread\b|\bdurians?\b|\bsweets?\b|\bfudge\b|gift boxes|hair extensions|\bsalons?\b|\bdrama\b|\btravel\b|\bdestinations\b|\btours?\b|\btourism\b|orthodont|\bwedding|\bbridal\b|\bfloral\b|\bflorists?\b|\bflowers\b|\bf&b\b|\brestaurants?\b|\bcaf[eé]s?\b|\bcatering\b|\bhospitality\b|\bgyms?\b|\bfitness\b|\btaxi\b|diesel repair|vehicle sales|\blawyers?\b|law firm|\bsolicitors?\b|personal injury|criminal defen[cs]e|chikankari|embroidery|\bfashion\b|\bapparel\b|\bpodcasts?\b|\bcricket\b|club shop|\btickets\b|camp gear|\bhouseholds\b|\bhomeowners\b|\bauto group\b|\bdealerships?\b|\bskincare\b|\bmakeup\b|\briders\b|e-?bikes?\b|\bfragrance\b/i;

/** Charities and not-for-profits raise donations, not customers: none of the sender's results is about that. */
const NONPROFIT = /\bcharit(?:y|able)\b|not-for-profit|non-?profit|\bnpc\b|peak body|trade unions?/i;

/** Customers a consumer pays to reach: the Leadgentic B2B line says nothing about these. */
const CONSUMER_BUYERS = new Set<Buyer>(["install", "order", "signup", "lead", "test_ride", "visit"]);

export interface ProofFit {
  key: ProofKey;
  /** Add the Leadgentic B2B line after the case study: only when the brief shows a B2B buyer. */
  withLeadgentic: boolean;
  /** Why this proof fits the lead, recorded with the draft. */
  why: string;
}

/**
 * The proof a lead may get, read from the words of its own brief and failing closed. Education words get Newton
 * School; an app product gets WorkIndia app growth; patients, clinics or care get Shraddha and Mave Health; property
 * gets Living Expert; recruitment gets WorkIndia and Vahan. Leadgentic (B2B client acquisition) goes only to a brief
 * with a positive B2B signal and never to a consumer or local business. Anything else gets no proof, and the reason
 * says why, so the lead is skipped rather than sent an unrelated number.
 */
export function matchProof(
  label: string | null | undefined,
  confidence: number,
  text: string,
  buyer: Buyer | null,
): { fit: ProofFit | null; why: string } {
  const consumer = CONSUMER_LOCAL.test(text) || (buyer !== null && CONSUMER_BUYERS.has(buyer) && !B2B_SIGNAL.test(text));
  const b2b = !consumer && (buyer === "b2b" || B2B_SIGNAL.test(text));
  const tag = label && confidence >= MIN_INDUSTRY_CONFIDENCE ? `tagged ${label}; ` : "";
  const hit = (key: ProofKey, why: string) => ({ fit: { key, withLeadgentic: b2b, why: `${tag}${why}` }, why });
  if (NONPROFIT.test(text)) return { fit: null, why: "a charity or not-for-profit: no proof about donors or members" };
  const edu = EDTECH_TERM.exec(text);
  if (edu) return hit("newton_school", `education brief ("${edu[0]}"): Newton School`);
  if (buyer === "install" || APP_PRODUCT.test(text)) return hit("workindia_app", "the product is an app: WorkIndia app growth");
  const health = HEALTH_TERM.exec(text);
  if (health) return hit("healthcare", `patients, clinics or care in the brief ("${health[0]}"): Shraddha`);
  const property = REAL_ESTATE_TERM.exec(text);
  if (property) return hit("living_expert", `property brief ("${property[0]}"): Living Expert`);
  const hiring = HIRING_TERM.exec(text);
  if (hiring) return hit("hiring", `recruitment brief ("${hiring[0]}"): WorkIndia and Vahan`);
  if (consumer) return { fit: null, why: `consumer or local business${buyer ? ` (${buyer})` : ""} and no consumer case study fits` };
  const signal = buyer === "b2b" ? "a business buyer named in the copy" : `"${B2B_SIGNAL.exec(text)?.[0] ?? ""}"`;
  if (b2b) return { fit: { key: "leadgentic", withLeadgentic: true, why: `${tag}B2B signal (${signal}): Leadgentic` }, why: "" };
  return { fit: null, why: "no B2B signal and no matching case study in the brief" };
}

export function fitProof(label: string | null | undefined, confidence: number, text: string, buyer: Buyer | null): ProofFit | null {
  return matchProof(label, confidence, text, buyer).fit;
}

// --- Does the funding article describe the same company as the homepage? ---

/** Words in an article slug that say nothing about what a company does: funding vocabulary, money, filler. */
const SLUG_FILLER = new Set(
  (
    "raise raises raised raising secure secures secured bag bags bagged net nets close closes closed land lands get gets " +
    "funding fund funds fundraise fundraising round seed pre series extension investment invest invests capital million " +
    "millions mn mln billion bn cr crore crores rs inr usd eur gbp valuation led lead leads backed back backs participate " +
    "participates venture ventures partners help helps expand expands expansion scale scales scaling boost accelerate " +
    "advance develop launch launches bring make makes turn turns build builds grow growth drive push to the a an and of " +
    "for in on at by with from into as its it their new startup startups company platform solution solutions technology " +
    "tech global international operations week hits amid us uk eu india indian first more further html moves eyes " +
    "using across cut improve related people based powered own"
  ).split(" "),
);

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** A loose stem, so "trade" meets "trading" and "robots" meets "robotic". */
const stem = (word: string) => (word.length > 4 ? word.slice(0, 4) : word.replace(/s$/, ""));

/** Fewer topic words than this is too little to call two descriptions different (synonyms, investor names). */
const MIN_TOPIC_WORDS = 3;

/**
 * What the funding article says the company does, read from its URL slug: the words after the company's name and
 * the funding verb, without money, stage, investor or filler words. Empty when the slug does not name the company
 * after an investor clause, or names nothing but the round.
 */
export function articleTopicWords(url: string, company: string): string[] {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return [];
  }
  const slug = words(path).join(" ");
  if (/\braised \d+ mn this week\b|\bstartups raised\b/.test(slug)) return [];
  const name = words(company).join(" ");
  const at = slug.lastIndexOf(name);
  if (!name || at < 0) return [];
  const tail = slug
    .slice(at + name.length)
    .replace(/\b(?:led by|backed by|from)\b.*$/, "")
    .split(" ");
  return tail.filter((word) => word.length >= 2 && !/^(?:e|eur|usd|inr|rs)?\d/.test(word) && !SLUG_FILLER.has(word));
}

/**
 * True when the article's description of the company shares no word with the company's own homepage copy, so the
 * article is probably about a different company of the same name (Cowboy AI's round vs cowboy.com e-bikes).
 */
export function articleMismatch(url: string, company: string, homepage: string): boolean {
  const topic = articleTopicWords(url, company);
  if (topic.length < MIN_TOPIC_WORDS) return false;
  const home = new Set(words(homepage.replace(/\b(\w+)-(\w+)\b/g, "$1$2 $1 $2")).map(stem));
  return !topic.some((word) => home.has(stem(word)));
}

/**
 * The article topic that disagrees with the homepage, or null when they agree. Every article about the round is read:
 * if any of them describes the company in the homepage's words it is the same company; if the ones that describe it
 * at all share no word with the homepage, the round belongs to a different company of the same name.
 */
export function leadArticleMismatch(
  lead: Pick<FundedLead, "company" | "funding_source_url" | "other_sources">,
  homepage: string,
): string | null {
  const urls = [lead.funding_source_url, ...(lead.other_sources ?? [])];
  const described = urls.map((url) => articleTopicWords(url, lead.company)).filter((topic) => topic.length >= MIN_TOPIC_WORDS);
  if (!described.length) return null;
  const home = new Set(words(homepage.replace(/\b(\w+)-(\w+)\b/g, "$1$2 $1 $2")).map(stem));
  if (described.some((topic) => topic.some((word) => home.has(stem(word))))) return null;
  return (described[0] as string[]).join(" ");
}

// --- Style lint ---

const BANNED: Array<[RegExp, string]> = [
  [/caught my (?:eye|attention)/i, "compliment opener"],
  [/\bcongrat(?:s|ulations)\b/i, "compliment opener"],
  [/\bkudos\b/i, "compliment opener"],
  [/\bimpressed\b/i, "compliment opener"],
  [/\bi came across\b/i, "stock opener"],
  [/hope (?:this|you)[^.]*\b(?:finds|well|doing)\b/i, "stock opener"],
  [/\breach(?:ing)? out\b/i, "stock phrase"],
  [/\bi'?d welcome\b/i, "stock closer"],
  [/\bwould love to\b/i, "stock closer"],
  [/\bworth a (?:call|chat|conversation)\b/i, "stock closer"],
  [/\b\d+[- ]minute (?:call|chat)\b/i, "stock closer"],
  [/\bone[- ]page plan\b/i, "stock closer"],
  [/\blooking forward\b/i, "stock closer"],
  [/\bhop(?:e|ing) to hear\b/i, "stock closer"],
  [/\blet me know if\b/i, "stock closer"],
  [/\bexcited\b/i, "filler"],
  [/\bpassionate\b/i, "filler"],
  [/\bgame[- ]?chang/i, "filler"],
  [/\bleverag/i, "filler"],
  [/\bsynerg/i, "filler"],
  [/\btouch base\b/i, "filler"],
  [/\bcircle back\b/i, "filler"],
  [/^\s*(?:best|regards|best regards|kind regards|warm regards|thanks|thank you|cheers|sincerely)\b[^\n]*$/im, "sign-off"],
];

/** Problems with a draft body: banned phrases, dashes, a sign-off, length, and the closing line. Empty means it passes. */
export function lintDraft(body: string, subject = ""): string[] {
  const problems: string[] = [];
  const text = `${subject}\n${body}`;
  if (/[—–]/.test(text)) problems.push("em or en dash");
  if (/\s--\s/.test(text)) problems.push("double-hyphen dash");
  for (const [pattern, why] of BANNED) {
    const hit = text.match(pattern);
    if (hit) problems.push(`${why}: "${hit[0].trim()}"`);
  }
  if (/\baasim\b/i.test(body)) problems.push("signature: name in body");
  const words = wordCount(body);
  if (words > MAX_WORDS) problems.push(`too long: ${words} words`);
  const lines = body.trim().split("\n");
  if (lines.at(-1)?.trim() !== CALL_ASK) problems.push("must end with the call ask");
  if (body.split(CALL_ASK).length > 2) problems.push("call ask repeated");
  return problems;
}

export const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

// --- Which emails are worth writing to ---

const NOT_OUTREACH_LOCAL =
  /^(?:privacy|legal|security|dpo|accessibility|support|help|helpdesk|care|customercare|abuse|spam|press|media|pr|newsroom|compliance|gdpr|data-?protection|grievances?|no-?reply|do-?not-?reply|donotreply|postmaster|webmaster|unsubscribe|billing|prawnik)(?:[._+-][\w.+-]*)?$/i;
const NOT_OUTREACH_ANYWHERE = /privacy|no-?reply|grievance|accessib|security|legal|support|spam|abuse|press/i;

/** An inbox worth pitching: not a privacy, legal, security, DPO, press, spam, support or no-reply desk. */
export function isPitchable(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  return Boolean(local) && !NOT_OUTREACH_LOCAL.test(local) && !NOT_OUTREACH_ANYWHERE.test(local);
}

/** A privacy, terms, legal or cookie page: an address printed only there is for data requests, not for a pitch. */
export const POLICY_PAGE =
  /privacy|terms|legal|cookie|gdpr|impressum|imprint|aviso|disclaimer|polic(?:y|ies)|data-protection|accessibility|dpa\b/i;

export function onPolicyPage(sourceUrl: string | null | undefined): boolean {
  if (!sourceUrl) return false;
  try {
    return POLICY_PAGE.test(new URL(sourceUrl).pathname);
  } catch {
    return POLICY_PAGE.test(sourceUrl);
  }
}

/** The posting gives the address for something other than applications: reporting spam or fraud, adjustments. */
const NOT_FOR_APPLICATIONS = /\b(?:spam|fraud\w*|scams?|phishing|special requirements|reasonable adjustments|accommodations?)\b/i;

const NOT_A_NAME = new Set(
  (
    "email emails mail send apply applicant applicants application resume cv cover letter please interested candidates " +
    "marketing design lead manager hr head director team the and with for your our via attn attention contact subject " +
    "line role position job jobs digital media social content senior junior executive specialist officer"
  ).split(" "),
);

/**
 * The person a posting or page says to write to, when it names them next to the address: "email Jon Bugden at
 * jon.bugden@..." or "(Attn: Yulia)". A name that is only guessed from the address (kristie.lewis@) is not used,
 * since the local part can be a surname first.
 */
export function namedRecipient(email: string, quote: string | null | undefined): string | null {
  if (!quote) return null;
  const text = quote.replace(/[\w.+-]+@[\w.-]+/g, " ");
  const attn = /\b(?:[Aa]ttn|[Aa]ttention)\s*:?\s*([A-Z][a-z]{2,})\b/.exec(text);
  if (attn?.[1] && !NOT_A_NAME.has(attn[1].toLowerCase())) return attn[1];
  const local = (email.split("@")[0] ?? "").toLowerCase();
  const parts = local.split(/[._-]+/).filter((part) => part.length >= 3);
  const names = [...text.matchAll(/\b[A-Z][a-z]{2,}\b/g)].map((match) => match[0]);
  for (let i = 0; i < names.length; i++) {
    const word = names[i] as string;
    const lower = word.toLowerCase();
    if (NOT_A_NAME.has(lower)) continue;
    if (!parts.includes(lower) && !(lower.length >= 5 && local.includes(lower))) continue;
    // A surname in the address (aavdieieva@) means the word before it is the first name.
    const before = names[i - 1];
    if (before && !NOT_A_NAME.has(before.toLowerCase()) && !local.startsWith(lower) && text.includes(`${before} ${word}`)) return before;
    return word;
  }
  return null;
}

/** Printed on a public page we kept: a source URL and a quote containing the address verbatim. */
export function isPosted(email: { email: string; source_url?: string | null; quote?: string | null }): boolean {
  return Boolean(email.email && email.source_url && email.quote?.toLowerCase().includes(email.email.toLowerCase()));
}

const INBOX_RANK: Record<string, number> = { founders: 0, general: 1, person: 2, other: 3, sales: 4, careers: 5, press: 6 };
const LOCAL_RANK: Array<[RegExp, number]> = [
  [/^(?:founders?|ceo|team)$/i, 0],
  [/^(?:hello|hi|hey|contact|info|connect|office)$/i, 1],
  [/^(?:invest\w*|ir|investors?|partners?|partnerships|affiliates?)$/i, 7],
];

function inboxRank(email: PostedEmail): number {
  const local = email.email.split("@")[0] ?? "";
  for (const [pattern, rank] of LOCAL_RANK) if (pattern.test(local)) return rank;
  return INBOX_RANK[email.inbox ?? "other"] ?? 3;
}

// --- Text helpers ---

const clean = (text: string) => text.replace(/[—–]/g, "-").replace(/\s+/g, " ").trim();

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-11-06" as "November 6", or null when the date does not parse. */
export function dayLabel(iso: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}` : null;
}

export const firstName = (name: string) =>
  clean(name)
    .split(" ")[0]
    ?.replace(/[^\p{L}'-]/gu, "") || null;

const SOURCE_LABEL: Record<string, string> = {
  indeed: "Indeed listing",
  linkedin: "LinkedIn job post",
  "linkedin-post": "LinkedIn post",
  bayt: "Bayt listing",
  jobicy: "Jobicy listing",
  weworkremotely: "We Work Remotely listing",
  remotive: "Remotive listing",
  remoteok: "Remote OK listing",
  himalayas: "Himalayas listing",
  naukri: "Naukri listing",
  reddit: "Reddit post",
  x: "X post",
};
export const sourceLabel = (source: string) => SOURCE_LABEL[source] ?? `${source} listing`;

function assemble(parts: Array<string | null>): string {
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}

// --- The one sentence that could only be written for this recipient ---

const ENGLISH = /(?<!\p{L})(?:the|and|of|for|in|to|is|are|with|your|our|we|by|at|on|from|that|an?)(?!\p{L})/iu;
const NOT_A_DESCRIPTION = /[|·]|\b(?:raises?|raised|secures?|secured|funding|maintenance)\b|^industry:/i;

/**
 * The first clause of a brief or quote, short enough to quote: first sentence, cut at a colon, semicolon, dash or
 * comma when it runs long. Null for headlines, nav labels, bare company names and non-English text.
 */
export function clause(text: string | null | undefined, maxWords = 24): string | null {
  if (!text) return null;
  let s = clean(text)
    .replace(/[™®]/g, "")
    .replace(/\s*\[…\].*$/, "");
  s = (s.split(/(?<=[.!?])\s/)[0] ?? "").replace(/[.!?]+$/, "").trim();
  if (wordCount(s) > maxWords) s = (s.split(/\s*[:;]\s|\s-\s|\s\(/)[0] ?? "").trim();
  if (wordCount(s) > maxWords) {
    // A comma cut keeps only a whole leading phrase, never the first item of a list.
    const head = (s.split(/,\s/)[0] ?? "").trim();
    s = wordCount(head) >= 6 ? head : "";
  }
  s = s
    .replace(/[,:;]+$/, "")
    .replace(/\s+(?:and|or|but|with|for|of|the|an?|in|to)$/i, "")
    .replace(/"/g, "'");
  const words = wordCount(s);
  if (words < 4 || words > maxWords) return null;
  if (NOT_A_DESCRIPTION.test(s) || !ENGLISH.test(text)) return null;
  return s;
}

/** Industries and products that do not buy paid acquisition: deeptech, space, defence, chemicals, energy hardware. */
const NOT_PAID_BUYER_LABELS = new Set(["deeptech"]);
const NOT_PAID_BUYER =
  /satellite|orbit|spacecraft|space mission|aerospace|hypersonic|defen[cs]e|fusion|chemical|reactor|uranium|perovskite|solar|desalination|brine|sustainable materials|materials company|drug discovery|power conversion|power losses|microgravity/i;

export type Buyer = "b2b" | "install" | "order" | "signup" | "lead" | "test_ride" | "visit";

/** Who the company sells to, read from the words of its own brief. First match wins; order is most specific first. */
const AUDIENCES: Array<[RegExp, string, Buyer]> = [
  [/\bclinicians?\b|clinical teams?|\bclinics?\b|\bhospitals?\b/i, "clinics and clinical teams", "b2b"],
  [/\bcontractors?\b/i, "contractors", "b2b"],
  [/accountants?\b.*tax advis[eo]rs?/i, "accountants and tax advisers", "b2b"],
  [/\baccountants?\b|accounting firms?/i, "accounting firms", "b2b"],
  [/\butilit(?:y|ies)\b/i, "utilities", "b2b"],
  [/media owners?/i, "media owners", "b2b"],
  [/investment office/i, "investment offices", "b2b"],
  [/sales call|qualified meetings|linkedin content/i, "B2B sales teams", "b2b"],
  [/after-sales|warranty/i, "brands handling warranty claims", "b2b"],
  [/campus|last-mile/i, "campus and last-mile operators", "b2b"],
  [/\byard\b|\bdock\b/i, "yard and dock operators", "b2b"],
  [/\bsourcing\b|procurement/i, "sourcing and procurement teams", "b2b"],
  [/renewable energy assets?/i, "renewable asset owners", "b2b"],
  [/professional sport|professional clubs/i, "professional clubs", "b2b"],
  [/\bai\b.*\byour teams?\b|\byour teams?\b.*\bai\b/i, "companies rolling out AI to their teams", "b2b"],
  [/\benterprises?\b/i, "enterprise data teams", "b2b"],
  [/your audience|publishers?|\barticles\b/i, "publishers and platforms", "b2b"],
  [/on-demand delivery|delivery fleet|quick commerce/i, "brands that need on-demand delivery", "b2b"],
  [/\byour business\b|\bbusinesses\b/i, "businesses", "b2b"],
  [
    /custom websites|web(?:site)? development|software development|custom software|\bagency\b|\bagencies\b/i,
    "businesses that hire an agency",
    "b2b",
  ],
  [/\bjaw\b|\btmj\b|teeth grinding/i, "people with jaw pain and TMJ", "install"],
  [/urban riders|\briders\b|cyclists|commuters/i, "urban riders", "test_ride"],
  [/skincare|makeup|complexion/i, "skincare and makeup buyers", "order"],
  [
    /\bf&b\b|restaurants?|franchis|bakery|bakeries|\bcaf[eé]s?\b|coffee shop|\bhotels?\b|brewery|brewing|distiller/i,
    "customers near your outlets",
    "visit",
  ],
  [/wedding|bridal/i, "couples planning weddings", "lead"],
  [/florists?\b|floral|\bflowers\b/i, "flower buyers", "order"],
  [/boutique (?:store|shop)|fashion|apparel|clothing|jewell?ery|ethnic wear|handloom|retail (?:store|shop|brand)/i, "shoppers", "order"],
  [/\bpatients?\b/i, "patients", "signup"],
  [/\bstudents?\b|\blearners?\b|\bexams?\b/i, "students", "signup"],
  [/home ?buyers|property|apartments/i, "property buyers", "lead"],
  [/job seekers|\bcandidates\b|\bemployers\b/i, "employers and job seekers", "signup"],
  [/\bour app\b|app store|play store|download (?:the|our) app/i, "app users", "install"],
];

/** An app buyer is only assumed from the industry tag when the copy itself mentions an app. */
const MENTIONS_APP = /\b(?:our|the|an?) app\b|\bapp for\b|app store|play store/i;

/** When the brief names no buyer, these industries still have an obvious paid-acquisition buyer. */
const LABEL_AUDIENCE: Partial<Record<IndustryLabel, [string, Buyer]>> = {
  ecommerce: ["online shoppers", "order"],
  edtech: ["students", "signup"],
  real_estate: ["property buyers", "lead"],
  consumer_app: ["app users", "install"],
  hiring_marketplace: ["employers and job seekers", "signup"],
};

export function audienceFor(text: string, label: string | null | undefined): { audience: string; buyer: Buyer } | null {
  for (const [pattern, audience, buyer] of AUDIENCES) if (pattern.test(text)) return { audience, buyer };
  const fallback = LABEL_AUDIENCE[label as IndustryLabel];
  if (!fallback || (fallback[1] === "install" && !MENTIONS_APP.test(text))) return null;
  return { audience: fallback[0], buyer: fallback[1] };
}

// --- The sentence built from the funding article: what the money is for, a named customer, a market or the product ---

/**
 * What a funding article says about the round beyond the homepage line, read from its URL slug (the only part of the
 * article we keep): "home" moves the buyer to people at home, "market" names a new geography, "customer" names a
 * buyer, "launch" a product launch, "purpose" any other stated use of funds, "product" what the round is "for", and
 * "hq" the city the headline places the company in.
 */
export type AngleKind = "home" | "market" | "customer" | "launch" | "purpose" | "product" | "hq";

export interface ArticleAngle {
  kind: AngleKind;
  /** The slug's own words, tidied: "bring your AI-powered rehabilitation technology into the home". */
  phrase: string;
  source_url: string;
  host: string;
  /** For "market": "the US", "Europe"; null for "international growth". */
  market?: string | null;
  /** For "customer": "merchants", "tax firms". */
  customer?: string;
  /** For "hq": "Perth"; descriptor is the headline's label, "Perth logistics analysis startup". */
  place?: string;
  descriptor?: string;
}

const ANGLE_RANK: AngleKind[] = ["home", "market", "customer", "launch", "purpose", "product", "hq"];

/** Slug words lose hyphens, capitals and apostrophes: put back the ones a reader would notice. */
const PHRASE_FIXES: Array<[RegExp, string]> = [
  [/\bus\b/g, "US"],
  [/\buk\b/g, "UK"],
  [/\beu\b/g, "EU"],
  [/\bai\b/g, "AI"],
  [/\bb2b\b/g, "B2B"],
  [/\btmj\b/g, "TMJ"],
  [/\beuropean\b/g, "European"],
  [/\beurope\b/g, "Europe"],
  [/\b(?:its|their)\b/g, "your"],
];

/** Verbs that open a use-of-funds phrase; the object after one is a noun phrase. */
const PURPOSE_VERB =
  /^(?:help|reduce|bring|expand|improve|operate|trade|launch|drive|deploy|open|spot|scale|make|turn|build|grow|develop|boost|accelerate|advance|enter|take|cut|introduce|serve|support|adopt)$/;
/** Words that end the use-of-funds part of a headline: investor, valuation and filler clauses. */
const CLAUSE_END = new Set(["led", "backed", "from", "as", "amid", "at", "with", "after", "valued", "co"]);
const NOUN_HEAD = /\b(?:platform|product|technology|network|agent|engine|system|tool|app)\b/;

const MARKET_TERM =
  /\b(?:the US|US|Europe|European|the UK|UK|international|global|GCC|UAE|Middle East|Southeast Asia|Africa|Latin America)\b/;
const MARKET_LABEL: Array<[RegExp, string]> = [
  [/\bUS\b/, "the US"],
  [/\bEurope(?:an)?\b/, "Europe"],
  [/\bUK\b/, "the UK"],
  [/\b(?:GCC|UAE|Middle East)\b/, "the Gulf"],
  [/\bSoutheast Asia\b/, "Southeast Asia"],
  [/\bAfrica\b/, "Africa"],
  [/\bLatin America\b/, "Latin America"],
];
const HOME_TERM = /\b(?:home|homes|people|consumers|households|families)\b/;
const CUSTOMER_TERM: Array<[RegExp, string]> = [
  [/\bsports and military\b/, "sports teams and the military"],
  [/\bmerchants\b/, "merchants"],
  [/\btax firms\b/, "tax firms"],
  [/\baccounting firms\b/, "accounting firms"],
  [/\butilities\b/, "utilities"],
  [/\binstitutional investors\b/, "institutional investors"],
  [/\benterprises\b/, "enterprises"],
  [/\binsurers\b/, "insurers"],
  [/\bretailers\b/, "retailers"],
  [/\bcontractors\b/, "contractors"],
  [/\bclinics\b/, "clinics"],
  [/\bhospitals\b/, "hospitals"],
];

/** Cities a headline puts in front of a company name ("perth logistics analysis startup indrus"). */
const HEADLINE_CITIES = new Set(
  (
    "perth sydney melbourne brisbane auckland london manchester edinburgh glasgow dublin paris berlin munich hamburg " +
    "leipzig amsterdam stockholm helsinki oslo copenhagen barcelona madrid lisbon porto milan zurich vienna warsaw " +
    "prague tallinn oxford cambridge bengaluru bangalore mumbai delhi pune hyderabad chennai gurugram noida dubai " +
    "riyadh singapore jakarta lagos nairobi toronto vancouver montreal austin boston"
  ).split(" "),
);

const titleCase = (text: string) => text.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** The longest path segment of an article URL, as words: the headline slug. */
function headlineWords(url: string): string[] {
  try {
    const segments = decodeURIComponent(new URL(url).pathname)
      .split("/")
      .map((part) => part.replace(/\.html?$/, ""));
    const longest = segments.reduce((a, b) => (b.length > a.length ? b : a), "");
    return words(longest);
  } catch {
    return [];
  }
}

function findName(tokens: string[], company: string): { start: number; end: number } | null {
  const name = words(company);
  if (!name.length) return null;
  const last = name.length - 1;
  for (let i = 0; i + name.length <= tokens.length; i++) {
    const hit = name.every((word, k) => tokens[i + k] === word || (k === last && tokens[i + k] === `${word}s`));
    if (hit) return { start: i, end: i + name.length };
  }
  const joined = name.join("");
  const at = tokens.findIndex((token) => token === joined || token === `${joined}s`);
  return at >= 0 ? { start: at, end: at + 1 } : null;
}

const PHRASE_BREAK = /^(?:for|to|in|into|across|of|with|on|the|a|an|its|their|your)$/;

/**
 * A list the slug ran together ("reduce jaw pain bruxism and ..."): three or more words between the last verb or
 * preposition and "and" were a comma list, so only the first item is kept.
 */
function cutRunOnList(tokens: string[]): string[] {
  const and = tokens.indexOf("and");
  if (and < 0) return tokens;
  let verb = -1;
  for (let i = 0; i < and; i++) if (PURPOSE_VERB.test(tokens[i] as string) || PHRASE_BREAK.test(tokens[i] as string)) verb = i;
  const content = and - verb - 1;
  return content >= 3 ? tokens.slice(0, and - 1) : tokens;
}

/** Compounds a slug splits in two; joined before anything counts words. */
const COMPOUNDS: Array<[RegExp, string]> = [
  [/\bai powered\b/g, "AI-powered"],
  [/\breal time\b/g, "real-time"],
  [/\bhigh stakes\b/g, "high-stakes"],
  [/\btmj related\b/g, "TMJ-related"],
  [/\bu s\b/g, "US"],
];

function tidyPhrase(raw: string[]): string {
  let joined = raw.join(" ");
  for (const [pattern, replacement] of COMPOUNDS) joined = joined.replace(pattern, replacement);
  const tokens = joined.split(" ");
  let text = cutRunOnList(tokens).join(" ");
  // A slug drops the possessive: "expand ai powered b2b payments platform" reads as "expand your AI-powered ...".
  const [verb, next] = tokens;
  if (verb && next && PURPOSE_VERB.test(verb) && !/^(?:its|their|the|a|an|your)$/.test(next) && NOUN_HEAD.test(text))
    text = text.replace(/^(\w+) /, "$1 your ");
  for (const [pattern, replacement] of PHRASE_FIXES) text = text.replace(pattern, replacement);
  return text;
}

/** Every angle one article headline gives, best first; empty when the slug says nothing beyond the round. */
export function articleAngles(url: string, company: string): ArticleAngle[] {
  const tokens = headlineWords(url);
  const at = findName(tokens, company);
  const host = hostOf(url);
  if (!at || !host) return [];
  const angles: ArticleAngle[] = [];
  const base = { source_url: url, host };

  let tail = tokens.slice(at.end);
  const stop = tail.findIndex((word) => CLAUSE_END.has(word));
  if (stop >= 0) tail = tail.slice(0, stop);
  const to = tail.indexOf("to");
  const forAt = tail.indexOf("for");
  const usable = (part: string[]) =>
    part.length >= 2 &&
    part.length <= 14 &&
    !part.some((word) => /^(?:e|rs|usd|inr)?\d/.test(word)) &&
    !/^(?:raise|raises|raising|secure|bag|close|get)$/.test(part[0] as string);
  if (to >= 0 && usable(tail.slice(to + 1)) && PURPOSE_VERB.test(tail[to + 1] as string)) {
    const phrase = tidyPhrase(tail.slice(to + 1));
    const customer = CUSTOMER_TERM.find(([pattern]) => pattern.test(phrase));
    if (HOME_TERM.test(phrase)) angles.push({ ...base, kind: "home", phrase });
    else if (MARKET_TERM.test(phrase))
      angles.push({ ...base, kind: "market", phrase, market: MARKET_LABEL.find(([p]) => p.test(phrase))?.[1] ?? null });
    else if (customer) angles.push({ ...base, kind: "customer", phrase, customer: customer[1] });
    else if (/^launch\b/.test(phrase)) angles.push({ ...base, kind: "launch", phrase });
    else angles.push({ ...base, kind: "purpose", phrase });
  } else if (forAt >= 0 && usable(tail.slice(forAt + 1))) {
    angles.push({ ...base, kind: "product", phrase: tidyPhrase(tail.slice(forAt + 1)) });
  }

  const pre = tokens.slice(0, at.start);
  const based = pre.lastIndexOf("based");
  let place: string | null = null;
  let descriptor: string | null = null;
  if (based === pre.length - 1 && based >= 1) place = pre[based - 1] as string;
  else if (pre.length >= 2 && pre.at(-1) === "s") place = pre.at(-2) as string;
  else if (pre.length >= 1 && HEADLINE_CITIES.has((pre.at(-1) as string).replace(/s$/, "")))
    place = (pre.at(-1) as string).replace(/s$/, "");
  else {
    const city = pre.findIndex((word) => HEADLINE_CITIES.has(word));
    if (city >= 0 && pre.at(-1) === "startup") {
      place = pre[city] as string;
      descriptor = pre.slice(city).join(" ");
    }
  }
  if (place && HEADLINE_CITIES.has(place))
    angles.push({
      ...base,
      kind: "hq",
      phrase: descriptor ?? place,
      place: titleCase(place),
      ...(descriptor ? { descriptor: descriptor.replace(place, titleCase(place)) } : {}),
    });
  return angles;
}

/** The angles from every article about the round, the strongest kind first, the primary article first within a kind. */
export function leadAngles(lead: Pick<FundedLead, "company" | "funding_source_url" | "other_sources">): ArticleAngle[] {
  const urls = [lead.funding_source_url, ...(lead.other_sources ?? [])];
  const all = urls.flatMap((url) => articleAngles(url, lead.company));
  return all.sort((a, b) => ANGLE_RANK.indexOf(a.kind) - ANGLE_RANK.indexOf(b.kind));
}

/** Whose buyer the angle points at: a business (answered by Leadgentic) or a consumer (answered by a case study). */
export type AngleBuyer = "b2b" | "consumer";

const HEALTHY = /patient|rehab|therap|clinic|health|care|pain/i;

/**
 * The article sentence and what it implies for channel and buyer, ending on a question the founder can confirm or
 * deny. Null when this angle says nothing usable for this buyer (a bare product or city for a consumer business).
 */
export function angleSentence(
  angle: ArticleAngle,
  company: string,
  audience: { audience: string; buyer: Buyer },
): { text: string; buyer: AngleBuyer } | null {
  const a = audience.audience;
  const b2b = audience.buyer === "b2b";
  const channel = b2b ? "LinkedIn and search" : "paid social and search";
  const reports = `${angle.host} reports the round is to ${angle.phrase}.`;
  switch (angle.kind) {
    case "home": {
      if (!b2b)
        return {
          text: `${reports} If the money goes into reaching ${a} directly, paid social and search can carry that from the first month. Is that the plan?`,
          buyer: "consumer",
        };
      const people = HEALTHY.test(`${angle.phrase} ${a}`) ? "patients and families at home" : "people at home";
      return {
        text: `${reports} If so, the buyer moves from ${a} to ${people}, who are reached with paid social and search rather than a sales team. Is that the plan?`,
        buyer: "consumer",
      };
    }
    case "market":
      return {
        text: `${reports} A new market has no referrals yet, so the first ${a} there have to come from ${channel}. ${
          angle.market ? `Is ${angle.market} where you need pipeline first?` : "Do you know yet which country comes first?"
        }`,
        buyer: b2b ? "b2b" : "consumer",
      };
    case "customer":
      return {
        text: `${reports} That makes ${angle.customer} the buyer, reached through LinkedIn and search with a booked demo as the goal. Are ${angle.customer} the first market?`,
        buyer: "b2b",
      };
    case "launch":
      return {
        text: `${reports} A launch needs demand before the first sales calls, and ${channel} aimed at ${a} can build it. Are ${a} the first buyers for it?`,
        buyer: b2b ? "b2b" : "consumer",
      };
    case "purpose":
      if (!b2b) return null;
      return {
        text: `${reports} If that is what you lead with, ${a} are the buyers to reach, through LinkedIn and search before a sales call. Is that who you are selling to first?`,
        buyer: "b2b",
      };
    case "product":
      if (!b2b) return null;
      return {
        text: `The ${angle.host} headline ties the round to "${angle.phrase}". If that is the offer, ${a} are the buyers to reach, through LinkedIn and search. Is that who you are selling to first?`,
        buyer: "b2b",
      };
    case "hq":
      if (!b2b || !angle.place) return null;
      return {
        text: `${
          angle.descriptor
            ? `${angle.host} describes ${company} as a ${angle.descriptor}.`
            : `${angle.host} places ${company} in ${angle.place}.`
        } If your first ${a} are around ${angle.place}, a regional LinkedIn and search campaign reaches them before a national one would. Are they?`,
        buyer: "b2b",
      };
  }
}

// --- Founder (funded company) drafts ---

interface Recipient {
  email: PostedEmail;
  name: string | null;
  founder: FounderLead | null;
}

/** Posted, pitchable, and printed somewhere other than a privacy, terms or legal page. */
const usable = (email: PostedEmail) => isPosted(email) && isPitchable(email.email) && !onPolicyPage(email.source_url);

/**
 * The best posted, pitchable address: a named founder's own email first, then the most general company inbox. An
 * address found only on a privacy or terms page is never used; a page that names who to write to sets the name.
 */
export function pickFundedRecipient(lead: FundedLead): Recipient | null {
  for (const founder of lead.founders ?? []) {
    const email = founder.emails?.find(usable);
    if (email) return { email, name: firstName(founder.name), founder };
  }
  const inboxes = (lead.company_emails ?? []).filter((e) => usable(e) && e.inbox !== "support" && e.inbox !== "press");
  inboxes.sort((a, b) => inboxRank(a) - inboxRank(b));
  const email = inboxes[0];
  return email ? { email, name: namedRecipient(email.email, email.quote), founder: null } : null;
}

function roundPhrase(lead: FundedLead): string {
  const stage = clean(lead.stage || "funding");
  const round = /\bround\b/i.test(stage) ? stage : `${stage} round`;
  if (!lead.amount) return `a ${round}`;
  const amount = clean(lead.amount);
  // "an $80M", "an €8 million", "an $11M": the article follows how the number is said.
  return `${/^\D*(?:8|11(?!\d)|18(?!\d))/.test(amount) ? "an" : "a"} ${amount} ${round}`;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const hostOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
};

/** The company's own description: the homepage brief, or the industry quote when it comes from the company's site. */
function founderDescription(lead: FundedLead): { text: string; source_url: string } | null {
  const fromBrief = clause(lead.brief);
  if (fromBrief && lead.website) return { text: fromBrief, source_url: lead.website };
  const quote = clause(lead.industry?.evidence_quote);
  const site = hostOf(lead.website);
  if (quote && lead.industry?.source_url && site && hostOf(lead.industry.source_url) === site)
    return { text: quote, source_url: lead.industry.source_url };
  return null;
}

/**
 * The one proof line that answers the article sentence: a case study when the angle points at consumers or patients,
 * the Leadgentic B2B line when it points at a business buyer. Null when the lead's proof cannot answer it.
 */
export function answeringProof(fit: ProofFit, buyer: AngleBuyer, short = false): string | null {
  if (buyer === "consumer") return fit.key === "leadgentic" ? null : PROOF[fit.key];
  if (fit.key === "leadgentic" || fit.withLeadgentic) return short ? LEADGENTIC_TINY : LEADGENTIC_FULL;
  return null;
}

export function draftFounder(lead: FundedLead): Draft | Skipped {
  const skip = (reason: string): Skipped => ({ kind: "founder", company: lead.company, reason });
  const recipient = pickFundedRecipient(lead);
  if (!recipient) return skip("no posted, pitchable email outside privacy, terms, press and support pages");
  const company = clean(lead.company);
  const label = lead.industry?.label ?? "other";
  const confidence = lead.industry?.confidence ?? 0;
  const allText = `${lead.brief ?? ""} ${lead.industry?.evidence_quote ?? ""}`;
  if (NOT_PAID_BUYER_LABELS.has(label) || NOT_PAID_BUYER.test(allText))
    return skip(`not a paid-acquisition buyer (${label}): no specific pitch to make`);
  const description = founderDescription(lead);
  if (!description) return skip("no usable brief: nothing specific to say about what the company does");
  const buyer = audienceFor(allText, label);
  if (!buyer) return skip("brief does not say who the customer is: no specific paid-acquisition angle");
  const mismatch = leadArticleMismatch(lead, `${allText} ${description.text}`);
  if (mismatch) return skip(`funding article describes a different company ("${mismatch}" shares no word with the homepage brief)`);
  const match = matchProof(label, confidence, allText, buyer.buyer);
  const fit = match.fit;
  if (!fit) return skip(`no matching proof: ${match.why}`);
  const key = fit.key;

  // The article sentence: the first angle that says something for this buyer and that the proof can answer.
  let chosen: { angle: ArticleAngle; text: string; buyer: AngleBuyer } | null = null;
  // A city only says something about channel for an early round, when the first customers are still local.
  const early = /pre-?seed|\bseed\b|angel/i.test(lead.stage ?? "");
  const angles = leadAngles(lead).filter((angle) => angle.kind !== "hq" || early);
  for (const angle of angles) {
    const sentence = angleSentence(angle, company, buyer);
    if (sentence && answeringProof(fit, sentence.buyer)) {
      chosen = { angle, ...sentence };
      break;
    }
  }
  if (!chosen)
    return skip(
      angles.length
        ? `the funding article's angle (${angles.map((a) => a.kind).join(", ")}) is not one the ${key} proof answers`
        : "the funding articles say nothing beyond the round (no use of funds, customer, market or product): nothing to build on",
    );

  const day = dayLabel(lead.announced_on);
  const facts: Fact[] = [
    {
      fact: `${company} raised ${roundPhrase(lead)}${day ? ` (announced ${lead.announced_on})` : ""}`,
      source_url: lead.funding_source_url,
    },
    {
      fact: `Article on the round (${chosen.angle.kind}): "${chosen.angle.phrase}"`,
      source_url: chosen.angle.source_url,
    },
    {
      fact: `Recipient ${recipient.email.email} printed publicly: "${clean(recipient.email.quote)}"`,
      source_url: recipient.email.source_url,
    },
    { fact: `What ${company} does, in its own words: "${description.text}"`, source_url: description.source_url },
    { fact: `Customer named in its copy: ${buyer.audience} (${buyer.buyer})`, source_url: description.source_url },
  ];
  if (recipient.founder && recipient.name)
    facts.push({
      fact: `${clean(recipient.founder.name)} is ${clean(recipient.founder.role || "a founder")} of ${company}`,
      source_url: recipient.founder.source_url || recipient.email.source_url,
    });
  else if (recipient.name)
    facts.push({
      fact: `The page names ${recipient.name} as the person to write to`,
      source_url: recipient.email.source_url,
    });
  if (key !== "leadgentic" && key === proofFor(label, confidence) && lead.industry?.source_url)
    facts.push({ fact: `Industry ${label}: "${clean(lead.industry.evidence_quote ?? "")}"`, source_url: lead.industry.source_url });

  const greeting = recipient.name ? `Hi ${recipient.name},` : "Hi,";
  const subject = `Paid acquisition for ${company}`;
  const opening = `${company} announced ${roundPhrase(lead)}${day ? ` on ${day}` : ""}. ${chosen.text}`;
  const chosenBuyer = chosen.buyer;
  const build = (short: boolean) => {
    const line = answeringProof(fit, chosenBuyer, short) as string;
    return { body: assemble([greeting, opening, `I run paid acquisition. ${line}`, CALL_ASK]), line };
  };
  for (const short of [false, true]) {
    const { body, line } = build(short);
    if (lintDraft(body, subject).length) continue;
    return {
      id: `founder:${slug(company)}`,
      kind: "founder",
      to: {
        email: recipient.email.email,
        source_url: recipient.email.source_url,
        quote: clean(recipient.email.quote),
        name: recipient.name,
      },
      company,
      website: lead.website,
      role: null,
      posted_on: null,
      subject,
      body,
      attachments: [],
      check_before_sending: [],
      proof_used: { key, industry: label, industry_confidence: confidence, lines: [line], why: fit.why },
      facts_used: facts,
    };
  }
  return skip(`style lint failed: ${lintDraft(build(true).body, subject).join("; ")}`);
}

// --- Job drafts ---

/**
 * Posted, pitchable addresses from a job: each must sit verbatim in the quoted line of the posting, and the line must
 * not give it for something other than applications (reporting spam or fraud, asking for adjustments).
 */
export function jobEmails(job: JobLead): string[] {
  if (NOT_FOR_APPLICATIONS.test(job.email_source_quote ?? "")) return [];
  return (job.emails ?? []).filter(
    (email) => isPosted({ email, source_url: job.source_url, quote: job.email_source_quote }) && isPitchable(email),
  );
}

export function jobIndustry(job: JobLead): {
  label: IndustryLabel;
  confidence: number;
  evidence_quote: string | null;
  source_url: string | null;
} {
  return classifyIndustry([
    { text: job.company_brief, url: job.source_url, weight: 2 },
    { text: `${job.company}. ${job.title}`, url: job.source_url, weight: 1 },
  ]);
}

export type RoleKind = "seo" | "paid" | "email" | "social" | "brand" | "content" | "growth" | "design" | "sales" | "marketing";

const ROLE_KINDS: Array<[RegExp, RoleKind]> = [
  [/\bseo\b|\bgeo\b|search engine|link building/i, "seo"],
  [/\bppc\b|google ads|media buy|\bpaid\b|performance|\bsem\b|meta ads|campaign analyst/i, "paid"],
  [/\bemail\b|\bcrm\b|lifecycle|retention/i, "email"],
  [/videograph|graphic|designer|\bdesign\b|photograph|video editor|motion/i, "design"],
  [/social|community|influencer|tiktok|creator/i, "social"],
  [/\bbrand/i, "brand"],
  [/content|copywrit|\bwriter\b|editor|podcast/i, "content"],
  [/growth|demand gen/i, "growth"],
  [/\bsales\b|account manager|client success|admission/i, "sales"],
];

export function roleKind(title: string): RoleKind {
  for (const [pattern, kind] of ROLE_KINDS) if (pattern.test(title)) return kind;
  return "marketing";
}

/** The employer's own description: the first clause of its brief. "Industry: X" stubs and bare names do not count. */
export function employerFact(job: JobLead): string | null {
  const text = clause(job.company_brief, 18);
  if (!text) return null;
  const name = shortCompany(job.company).toLowerCase();
  if (text.toLowerCase() === name || name.startsWith(text.toLowerCase())) return null;
  return text;
}

/**
 * The employer's brief when it is too long to quote as one clause: still enough to match a proof against, since the
 * draft no longer quotes it. Stubs ("Industry: X"), bare names and non-English text do not count.
 */
export function employerBrief(job: JobLead): string | null {
  const text = clean(job.company_brief ?? "");
  if (wordCount(text) < 6 || /^industry:/i.test(text) || !ENGLISH.test(text)) return null;
  const head = text.split(/\s+/).slice(0, 30).join(" ");
  return head.length < text.length ? `${head}...` : text;
}

const NAME_PLACEHOLDER = /\[\s*your\s*(?:full\s*)?name\s*\]/i;
const SENDER_NAME = "Aasim";
const QUOTED = /["“]\s*([^"“”]+?)\s*["”]|\*([^*]+)\*|\(([^()]+)\)|'([A-Z][^']+)'/g;

/**
 * The subject line the posting asks for, if it dictates one. "rule" says how: "title" when it asks for the job title,
 * "quoted" for an exact string, "missing" when it asks for a subject the quote cut off. Null when it does not ask.
 */
export function postedSubject(quote: string | null | undefined, title: string): { subject: string | null; rule: string } | null {
  if (!quote || !/subject/i.test(quote)) return null;
  const q = quote.replace(/\s+/g, " ");
  const titleRule =
    /(?:using|with|mention\w*)\s+(?:the\s+)?(?:job\s*position|job\s*tit+le|position\s*title|position you'?re applying for)|(?:job\s*position|position\s*title|position you'?re applying for)[^.]{0,30}subject/i;
  if (titleRule.test(q)) return { subject: clean(title), rule: "title" };
  const at = q.search(/subject/i);
  let best: { text: string; distance: number } | null = null;
  for (const match of q.matchAll(QUOTED)) {
    const text = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!text || text.includes("@") || wordCount(text) > 16 || /^s\b/i.test(text)) continue;
    const startIdx = match.index ?? 0;
    const endIdx = startIdx + match[0].length;
    const distance = Math.min(Math.abs(at - endIdx), Math.abs(startIdx - at - 7));
    if (distance <= 40 && (!best || distance < best.distance)) best = { text, distance };
  }
  if (best) return { subject: tidySubject(best.text), rule: "quoted" };
  const before = /(?:using|with)\s+(?:the job title\s+)?\*?([A-Z][^"“”.,]{2,80}?)\s+as the (?:e-?mail )?subject/i.exec(q);
  if (before?.[1]) return { subject: tidySubject(before[1]), rule: "quoted" };
  const after = /subject(?: line)?:?\s+([A-Z][^\n]*?)(?:\.\*?(?:\s|$)|\s—\s|$)/.exec(q);
  if (after?.[1] && wordCount(after[1]) <= 16) return { subject: tidySubject(after[1]), rule: "quoted" };
  if (/subject(?: line)?\s*:\s*$/i.test(q.trim()) || /with the subject(?: line)?\s*:?\s*$/i.test(q.trim()))
    return { subject: null, rule: "missing" };
  return null;
}

function tidySubject(text: string): string {
  return clean(text.replace(/\*/g, "")).replace(NAME_PLACEHOLDER, SENDER_NAME).replace(/[.]+$/, "").trim();
}

const LEGAL_SUFFIX =
  /(?:[\s,]+(?:\((?:pvt|opc|uk|private)\)|pvt\.?|private|ltd\.?|limited|inc\.?|llc|l\.l\.c\.|co\.?|corp\.?|plc|gmbh|pte\.?|sdn\.?|bhd\.?|\(uk\)|\(opc\)))+\.?$/i;

/** "Ouranos Technologies PVT. LTD." as "Ouranos Technologies": the name a person would write in an email. */
export function shortCompany(name: string): string {
  // "Skinfinity- Skin and laser clinic": the name ends where a dangling dash starts a description.
  const short = clean(name)
    .replace(/(?<=\S)-\s+.*$/, "")
    .replace(LEGAL_SUFFIX, "")
    .trim();
  return short || clean(name);
}

// --- The requirement from the listing itself, and the one line of the record that answers it ---

/** Phrases in a listing that ask for something specific from the applicant. Group 1 is the requirement. */
const REQUIREMENT_ASKS: RegExp[] = [
  /\bif you(?:'re|’re| are)\s+(an?\s+[^,.;!?]+)/i,
  /\b((?:two or three|one|two|three|\d\s*-\s*\d|\d)\s+(?:examples?\s+of\s+)?(?:(?:marketing|ad|paid)\s+)?campaigns?\b[^.;]*)/i,
  /\b(examples?\s+of\s+(?:(?:marketing|ad|paid)\s+)?campaigns?\b[^.;]*)/i,
  /\b((?:ad|marketing|paid) campaign results)\b/i,
  /\b((?:details|a (?:brief )?summary) of (?:your|their) [^.;:]*?experience[^.;:]*)/i,
  /\b(\d\+?\s*years?\s+(?:of\s+)?[^.;:]*experience[^.;:]*)/i,
  /\b((?:proven |hands-on )?experience (?:with|in|running|managing) [^.;:]+)/i,
];

/** Campaigns and their results: any of the sender's proof lines is a campaign with a result. */
const ASKS_RESULTS = /\bcampaigns?\b|\bpipeline\b|return on investment|\broi\b|\broas\b|\bcost per\b/i;
/** Paid media skills: the sender's core work. */
const ASKS_PAID =
  /google ads|meta ads|facebook ads|\bppc\b|media buy\w*|paid (?:media|social|search|ads|acquisition)|performance marketing|ad budgets?|\bsem\b/i;

const SECTOR_OF: Array<[RegExp, ProofKey, string]> = [
  [/\bhealth ?care\b|\bmedical\b|\bpatients?\b|\bclinics?\b|\bdental\b|\bdermatolog\w*/i, "healthcare", "Healthcare"],
  [/\beducation\b|\bedtech\b|\bstudents?\b|\bcourses?\b/i, "newton_school", "Education"],
  [/real estate|\bpropert(?:y|ies)\b/i, "living_expert", "Real estate"],
  [/\brecruit\w*|\bstaffing\b|\bhiring\b/i, "hiring", "Hiring"],
  [/\bapps?\b|\binstalls?\b/i, "workindia_app", "App growth"],
  [/\bb2b\b|\bagency\b|\bclient acquisition\b/i, "leadgentic", "B2B client acquisition"],
];

export interface ListingRequirement {
  /** The listing's own words, without the address or the name it is sent to. */
  text: string;
  /** How the record answers it: results (a campaign with a result), sector (the same industry), paid (core skill). */
  answer: "results" | "sector" | "paid";
  /** The sentence that hands over to the proof line. */
  bridge: string;
}

/**
 * One requirement or responsibility quoted from the listing (the posting text we kept, not the company blurb) that the
 * lead's proof line answers. Null when the listing asks for nothing specific or asks for work the record does not
 * cover (SEO samples, email platforms, videography).
 */
export function listingRequirement(quote: string | null | undefined, key: ProofKey): ListingRequirement | null {
  if (!quote) return null;
  const text = clean(quote);
  for (const pattern of REQUIREMENT_ASKS) {
    const hit = pattern.exec(text)?.[1];
    if (!hit) continue;
    let req = hit.replace(/\s*[\w.+-]+@[\w.-]+.*$/, "");
    req = req
      .replace(/,?\s+(?:to|at|on)(?:\s+[A-Z][\w]*)*(?:\s+at)?\s*:?\s*$/, "")
      .replace(/[\s,:;(]+$/, "")
      .replace(/"/g, "'")
      .trim();
    if (/\([^)]*$/.test(req)) req = `${req})`;
    if (wordCount(req) < 3 || wordCount(req) > 22) continue;
    const sector = SECTOR_OF.find(([pattern]) => pattern.test(req));
    if (sector && sector[1] === key) return { text: req, answer: "sector", bridge: `${sector[2]} is where my strongest result is.` };
    if (ASKS_RESULTS.test(req)) return { text: req, answer: "results", bridge: "Here is one." };
    if (ASKS_PAID.test(req)) return { text: req, answer: "paid", bridge: "That is my core work." };
  }
  return null;
}

export function draftJob(job: JobLead): Draft | Skipped {
  const skip = (reason: string): Skipped => ({ kind: "job", company: job.company, reason });
  const email = jobEmails(job)[0];
  if (!email) return skip("no posted, pitchable email");
  const company = shortCompany(job.company);
  const title = clean(job.title).replace(/\s+job at$/i, "");
  const employer = employerFact(job) ?? employerBrief(job);
  if (!employer) return skip("no usable company brief: nothing to match the record against");
  const industry = jobIndustry(job);
  const brief = `${job.company_brief ?? ""} ${company}`;
  const match = matchProof(industry.label, industry.confidence, brief, audienceFor(job.company_brief ?? "", industry.label)?.buyer ?? null);
  const fit = match.fit;
  if (!fit) return skip(`no matching proof for the employer: ${match.why}`);
  const key = fit.key;
  const requirement = listingRequirement(job.email_source_quote, key);
  if (!requirement)
    return skip("the listing text we kept states no requirement or responsibility that the record answers: nothing to build on");
  const where = sourceLabel(job.source);
  const quote = clean(job.email_source_quote ?? "");
  const asked = postedSubject(job.email_source_quote, title);
  const subject = asked?.subject ?? `Application: ${title}`;
  const portfolio = /portfolio|showreel|work samples|writing samples/i.test(quote);
  const facts: Fact[] = [
    { fact: `${company} posted "${title}" (${where}, ${job.posted_at.slice(0, 10)})`, source_url: job.source_url },
    { fact: `Listing asks for: "${requirement.text}" (answered by ${requirement.answer})`, source_url: job.source_url },
    { fact: `Recipient ${email} printed in the posting: "${quote}"`, source_url: job.source_url },
    { fact: `${company} describes itself: "${employer}"`, source_url: job.source_url },
  ];
  if (asked)
    facts.push({
      fact:
        asked.rule === "missing"
          ? "Posting asks for a specific subject line that the saved quote cuts off: check the posting before sending"
          : `Posting dictates the subject line (${asked.rule}): "${subject}"`,
      source_url: job.source_url,
    });
  if (portfolio) facts.push({ fact: "Posting asks for a portfolio or work samples", source_url: job.source_url });
  if (key !== "leadgentic" && key === proofFor(industry.label, industry.confidence) && industry.evidence_quote)
    facts.push({
      fact: `Industry ${industry.label}: "${clean(industry.evidence_quote)}"`,
      source_url: industry.source_url ?? job.source_url,
    });
  const name = namedRecipient(email, job.email_source_quote);
  if (name) facts.push({ fact: `The posting names ${name} as the person to write to`, source_url: job.source_url });
  const attachments = portfolio ? ["CV", "portfolio of campaign results"] : ["CV"];
  const attach = portfolio ? "My CV and a portfolio of campaign results are attached, as the posting asks." : "My CV is attached.";
  const greeting = name ? `Hi ${name},` : "Hi,";
  const opening = `I'm applying for the ${title} role at ${company} from your ${where}.`;
  const build = (short: boolean) => {
    const line = key === "leadgentic" ? (short ? LEADGENTIC_TINY : LEADGENTIC_FULL) : PROOF[key];
    const ask = `The listing asks for "${requirement.text}". ${requirement.bridge} ${line}`;
    return { body: assemble([greeting, `${opening} ${ask}`, attach, CALL_ASK]), line };
  };
  for (const short of [false, true]) {
    const { body, line } = build(short);
    if (lintDraft(body, subject).length) continue;
    return {
      id: `job:${slug(company)}:${slug(title)}:${slug(email)}`,
      kind: "job",
      to: { email, source_url: job.source_url, quote, name },
      company,
      website: job.apply_url && job.apply_url !== job.source_url ? job.apply_url : null,
      role: title,
      posted_on: where,
      subject,
      body,
      attachments,
      check_before_sending:
        asked?.rule === "missing"
          ? ["The posting asks for a specific subject line that the saved quote cuts off: open the posting and copy it."]
          : [],
      proof_used: { key, industry: industry.label, industry_confidence: industry.confidence, lines: [line], why: fit.why },
      facts_used: facts,
      ...(job.fit ? { fit_score: job.fit.score } : {}),
    };
  }
  return skip(`style lint failed: ${lintDraft(build(true).body, subject).join("; ")}`);
}

/**
 * The body with the company, role and board name taken out. Two drafts with the same fingerprint say nothing
 * specific to either recipient, so the later one is dropped.
 */
export function fingerprint(draft: Pick<Draft, "body" | "company" | "role" | "posted_on" | "to">): string {
  let body = draft.body;
  const strip = (value: string | null | undefined, token: string) => {
    if (value) body = body.split(value).join(token);
  };
  strip(draft.role, "<role>");
  strip(draft.company, "<company>");
  strip(draft.posted_on, "<board>");
  strip(draft.to.name, "<name>");
  return body;
}

// --- All drafts ---

export interface DraftRun {
  generated_at: string;
  stats: Record<string, number>;
  drafts: Draft[];
  skipped: Skipped[];
}

export function isDraft(result: Draft | Skipped): result is Draft {
  return "body" in result;
}

/** One draft per lead: funded companies, then ranked jobs, then the rest of the jobs with a posted email. */
export function buildDrafts(input: { funded: FundedLead[]; ranked?: JobLead[]; jobs?: JobLead[]; maxJobs?: number; now?: Date }): DraftRun {
  const drafts: Draft[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();
  const bodies = new Map<string, string>();
  const add = (result: Draft | Skipped) => {
    if (!isDraft(result)) return skipped.push(result);
    const key = result.kind === "founder" ? result.id : `${result.to.email.toLowerCase()}|${result.role?.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const print = fingerprint(result);
    const twin = bodies.get(print);
    if (twin)
      return skipped.push({ kind: result.kind, company: result.company, reason: `body is the same as ${twin} once names are taken out` });
    bodies.set(print, result.id);
    drafts.push(result);
  };
  for (const lead of input.funded) add(draftFounder(lead));
  const founders = drafts.length;
  let jobCount = 0;
  for (const job of [...(input.ranked ?? []), ...(input.jobs ?? [])]) {
    if (input.maxJobs !== undefined && jobCount >= input.maxJobs) break;
    const before = drafts.length;
    add(draftJob(job));
    if (drafts.length > before) jobCount++;
  }
  const byProof: Record<string, number> = {};
  for (const draft of drafts) byProof[`proof_${draft.proof_used.key}`] = (byProof[`proof_${draft.proof_used.key}`] ?? 0) + 1;
  return {
    generated_at: (input.now ?? new Date()).toISOString(),
    stats: { founder_drafts: founders, job_drafts: drafts.length - founders, skipped: skipped.length, ...byProof },
    drafts,
    skipped,
  };
}

/** A readable review copy of the drafts. */
export function draftsMarkdown(run: DraftRun): string {
  const out = [
    "# Outreach drafts",
    "",
    `Generated ${run.generated_at}. Drafts only: nothing was sent and nothing was put into Gmail.`,
    "",
    Object.entries(run.stats)
      .map(([key, value]) => `- ${key}: ${value}`)
      .join("\n"),
    "",
  ];
  for (const draft of run.drafts) {
    out.push(
      `## ${draft.kind === "founder" ? "Founder" : "Job"}: ${draft.company}${draft.role ? `, ${draft.role}` : ""}`,
      "",
      `- To: ${draft.to.email}${draft.to.name ? ` (${draft.to.name})` : ""}`,
      `- Email source: ${draft.to.source_url}`,
      `- Subject: ${draft.subject}`,
      ...(draft.attachments.length ? [`- Attach: ${draft.attachments.join(", ")}`] : []),
      ...draft.check_before_sending.map((note) => `- Check before sending: ${note}`),
      `- Proof: ${draft.proof_used.key} (industry ${draft.proof_used.industry}, ${draft.proof_used.industry_confidence})`,
      ...(draft.fit_score !== undefined ? [`- Fit score: ${draft.fit_score}`] : []),
      "",
      "```text",
      draft.body,
      "```",
      "",
      "Facts used:",
      ...draft.facts_used.map((fact) => `- ${fact.fact} (${fact.source_url})`),
      "",
    );
  }
  if (run.skipped.length) {
    out.push("## Skipped", "");
    for (const skip of run.skipped) out.push(`- ${skip.kind}: ${skip.company}: ${skip.reason}`);
    out.push("");
  }
  return out.join("\n");
}
