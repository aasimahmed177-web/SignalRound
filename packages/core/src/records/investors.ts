// Investor hygiene: pure rules over the two investor lists an extraction returns, judged against
// the round's own evidence sentence. Every rule here is deterministic and covered by
// investors.test.ts. The resolver calls `cleanInvestors` once per round, after `cleanRound` and
// before the lists are keyed into a record.
//
// The rules, each drawn from an audit of the live store (2026-09-04):
//   1. Leads need lead language. A name is a lead only when the evidence says "led by", "leads",
//      "co-led", "lead investor", "spearheaded by", "anchored by" of it; a name after "from",
//      "joined by", "backed by", "with participation from", "alongside" is a participant.
//   2. Placeholders are not investors ("undisclosed investors", "existing investors", "a group of",
//      a clause fragment opening on a preposition, a generic crowd "of" a firm, "funds managed
//      by Acme", and a lone owner-wrapped fund, which resolves to what it wraps or its owner).
//   3. A person of a firm is the firm ("Jane Doe of Acme Ventures" is Acme Ventures); a person
//      formerly of a firm is the person ("Jane Doe, formerly of Acme" is Jane Doe).
//   4. One firm, one entry, within the record (spellings, region suffixes, known aliases).
//   5. Lenders are not investors: the names inside a credit-facility clause drop from the equity round.
//   6. Typos are not new firms: one edit apart and one spelling in the evidence, the evidence wins.
//   7. Affiliations are not investors: the company before "founder" or "CEO", the manager or parent in
//      an appositive ("managed by", "a platform created by"), a vehicle after "via".
//   8. Prior backers and partners are not this round's investors: names inside a "previously",
//      "investor base also includes", or "partners include" clause drop, and so do names in a clause
//      dated to a month before the round's own date.
//   9. A lead of another round is not this round's lead: "$5 million in seed funding led by General
//      Catalyst, and $20 million Series A led by CRV" gives the Series A one lead. The firm stays a
//      participant only where the evidence puts it in the round ("with participation from").

import { GIVEN_NAMES } from "./given-names.ts";
import { INVESTOR_ALIASES, INVESTOR_ARMS, investorKeyForMerge } from "./keys.ts";
import { classifyStage, normalizeInvestorKey, parseAmount } from "./normalize.ts";
import type { Stage } from "./stages.ts";

export { investorKeyForMerge } from "./keys.ts";

export interface InvestorInput {
  lead_investors: string[];
  other_investors: string[];
  /** The round's evidence sentence(s); the only text the rules read. */
  evidence: string;
  amount_as_written: string | null;
  /** The round the leads are checked against (rule 9); without it no lead is placed on another round. */
  round?: LeadRound;
}

export interface InvestorOutput {
  lead_investors: string[];
  other_investors: string[];
  /** Every input spelling that is not in the output: placeholders, lenders, persons, and merged-away duplicates. */
  dropped: string[];
}

/** The most leads kept on the extractor's word alone when lead language exists but the names cannot be placed in it. */
export const MAX_UNATTRIBUTED_LEADS = 3;

/** How far back from a name a lead or participant marker still speaks for it, in characters. */
const MARKER_REACH = 200;

/** How far past a name a verb ("leads", "joined") still speaks for it: a short list of co-names and a verb. */
const VERB_REACH = 170;

// ---------------------------------------------------------------------------------------------
// Text folding and lookup

/**
 * Lowercase ASCII with every non-alphanumeric character turned into a space, one character out
 * per character in, so an index into the fold is an index into the original.
 */
function fold(text: string): string {
  let out = "";
  for (const ch of text) {
    const base = ch.normalize("NFKD")[0] ?? " ";
    out += /[a-z0-9]/i.test(base) ? base.toLowerCase() : " ";
    // A code point outside the BMP still folds to one UTF-16 unit; pad so indices stay aligned.
    if (ch.length > 1) out += " ".repeat(ch.length - 1);
  }
  return out;
}

function tokens(text: string): string[] {
  return fold(text).split(" ").filter(Boolean);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The display head of a name: what stands before a parenthesis, a colon, or a spaced dash. */
function head(name: string): string {
  return (name.split(/\s+[\u2013\u2014-]\s+|\s*[:(]\s*/)[0] ?? name).trim();
}

/**
 * Sentence spans of the evidence as [start, end) indexes; a single-letter abbreviation ("J.P.") does
 * not end one, an acronym ("led by GIC.") and a blank line do.
 */
function sentenceSpans(evidence: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /(?<=(?:[a-z\d)\]"”]|[A-Z]{2})[.!?])(?<!\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St)\.)\s+(?=["“(]?[A-Z0-9])|\n\s*\n\s*/g;
  let start = 0;
  for (const m of evidence.matchAll(re)) {
    spans.push([start, m.index]);
    start = m.index + m[0].length;
  }
  spans.push([start, evidence.length]);
  return spans;
}

function sentenceAt(spans: Array<[number, number]>, index: number): [number, number] {
  return spans.find(([s, e]) => index >= s && index < e) ?? [0, Number.MAX_SAFE_INTEGER];
}

/** Where a phrase (as tokens) occurs in folded text, whole words only. */
function findTokens(folded: string, parts: string[], from = 0): number {
  if (parts.length === 0) return -1;
  const re = new RegExp(`(?<![a-z0-9])${parts.map(escapeRegExp).join("\\s+")}(?![a-z0-9])`, "g");
  re.lastIndex = from;
  const m = re.exec(folded);
  return m ? m.index : -1;
}

interface Found {
  index: number;
  /** 2 when the name's own head is in the evidence, 1 when only its identity key is. */
  strength: 0 | 1 | 2;
}

/** Locate a name in the evidence: by its head first, then by its identity key ("acme" for "Acme Funds"). */
function locate(folded: string, name: string): Found {
  const byHead = findTokens(folded, tokens(head(name)));
  if (byHead >= 0) return { index: byHead, strength: 2 };
  const key = normalizeInvestorKey(name).split(" ").filter(Boolean);
  // A one-word identity key under four characters ("arm", "gv") matches too much prose to trust.
  if (key.length === 1 && (key[0]?.length ?? 0) < 4) return { index: -1, strength: 0 };
  const byKey = findTokens(folded, key);
  return byKey >= 0 ? { index: byKey, strength: 1 } : { index: -1, strength: 0 };
}

// ---------------------------------------------------------------------------------------------
// Rule 2: placeholders

/** An entry opening with one of these is generic whatever follows ("Unnamed publicly traded medical-device company"). */
const HARD_PLACEHOLDER =
  /^(?:(?:a|an|the)\s+)?(?:undisclosed|unnamed|unidentified|unspecified|anonymous|various|several|multiple|numerous|other|others|et al\.?|n\/a|none|tbd)(?:$|[\s,.])/i;

/** An entry opening with a preposition is a clause fragment, never a name ("from the payments, fintech and enterprise technology sectors"). A firm word after it does not rescue it. */
const PREPOSITION_OPEN = /^(?:from|in|at|across|within|among|of)\s/i;

/** "a consortium of", "a group of", "a number of": a collective noun for people not named. */
const COLLECTIVE =
  /^(?:(?:a|an|the)\s+)?(?:consortium|group|syndicate|number|mix|range|host|handful|roster|coalition|club|collection|selection|slate|series)\s+of\b/i;

/** Descriptors that qualify a generic noun ("existing", "strategic", "family"). */
const DESCRIPTORS = new Set([
  "existing",
  "new",
  "additional",
  "returning",
  "previous",
  "prior",
  "current",
  "strategic",
  "large",
  "major",
  "prominent",
  "leading",
  "notable",
  "select",
  "selected",
  "institutional",
  "individual",
  "private",
  "public",
  "publicly",
  "traded",
  "listed",
  "global",
  "international",
  "local",
  "regional",
  "family",
  "angel",
  "angels",
  "high",
  "net",
  "worth",
  "well",
  "known",
  "top",
  "tier",
  "sovereign",
  "wealth",
  "pension",
  "insurance",
  "medical",
  "device",
  "medtech",
  "healthcare",
  "health",
  "tech",
  "technology",
  "industry",
  "industrial",
  "corporate",
  "financial",
  "unnamed",
  "undisclosed",
  "several",
  "various",
  "other",
  // Nationality and region words qualify a crowd ("private U.S. investors").
  "u.s.",
  "us",
  "american",
  "european",
  "asian",
  "british",
  "uk",
  "canadian",
  "german",
  "french",
  "indian",
  "chinese",
  "japanese",
  "african",
  "nordic",
  "dutch",
  "swiss",
  "israeli",
  // Sector words do the same ("fintech investors", "the software ecosystem").
  "payments",
  "fintech",
  "enterprise",
  "software",
  "sector",
  "sectors",
  "ecosystem",
]);

/** Nouns that name a class of investor rather than an investor. */
const GENERIC_NOUNS = new Set([
  "investor",
  "investors",
  "angel",
  "angels",
  "backer",
  "backers",
  "office",
  "offices",
  "founder",
  "founders",
  "company",
  "companies",
  "firm",
  "firms",
  "institution",
  "institutions",
  "individual",
  "individuals",
  "executive",
  "executives",
  "entrepreneur",
  "entrepreneurs",
  "participant",
  "participants",
  "shareholder",
  "shareholders",
  "player",
  "players",
  "corporate",
  "corporates",
  "strategic",
  "strategics",
  "lp",
  "lps",
  "vc",
  "vcs",
  "others",
  "consortium",
  "group",
  "syndicate",
  "lender",
  "lenders",
  "bank",
  "banks",
  "partner",
  "startup",
  "startups",
  "operator",
  "operators",
  "client",
  "clients",
  "customer",
  "customers",
  "member",
  "members",
  "leader",
  "leaders",
  "professional",
  "professionals",
  "veteran",
  "veterans",
]);

/** A generic crowd "of" a firm names nobody in particular ("institutional clients of Hg", "the founders of Acme"). A firm word before "of" keeps the name ("Partners of Acme", "Bank of America"). */
const GENERIC_OF = /^(.+?)\s+of\s+\S/i;

const FILLER = new Set([
  "a",
  "an",
  "the",
  "of",
  "and",
  "or",
  "from",
  "its",
  "their",
  "with",
  "plus",
  "some",
  "many",
  "more",
  "than",
  "over",
  "about",
  "around",
  "nearly",
  "almost",
  "half",
  "few",
  "dozen",
  "dozens",
  "hundred",
  "hundreds",
  "based",
]);

/** A word the whole entry can be made of without naming anyone. */
function isGenericToken(t: string): boolean {
  return DESCRIPTORS.has(t) || GENERIC_NOUNS.has(t) || FILLER.has(t) || /^\d+$/.test(t);
}

/**
 * A fragment: one token and a place ("X1 in Berlin"), the shape an extractor leaves when it cuts a
 * sentence at the wrong word. A firm word on either side ("Partners in Equity") keeps it a name.
 */
const FRAGMENT = /^(\S+)\s+(?:in|at)\s+(\S+)$/;

/** True when the entry names a class of investor and nobody in particular. */
export function isPlaceholderInvestor(name: string): boolean {
  const s = head(name).trim();
  if (!s) return true;
  if (HARD_PLACEHOLDER.test(s) || COLLECTIVE.test(s) || PREPOSITION_OPEN.test(s)) return true;
  const of = GENERIC_OF.exec(s);
  if (of?.[1]) {
    const lhs = tokens(of[1]);
    if (lhs.length > 0 && lhs.every(isGenericToken) && lhs.some((t) => GENERIC_NOUNS.has(t)) && !lhs.some((t) => FIRM_WORDS.has(t)))
      return true;
  }
  const fragment = FRAGMENT.exec(s);
  if (fragment?.[1] && fragment[2] && !FIRM_WORDS.has(fold(fragment[1]).trim()) && !FIRM_WORDS.has(fold(fragment[2]).trim())) return true;
  // "U.S." folds to two tokens; read it as "us" so the descriptor list sees it.
  const parts = tokens(s.replace(/\bu\.\s?s\.?/gi, "us"));
  if (parts.length === 0) return true;
  return parts.every(isGenericToken) && parts.some((t) => GENERIC_NOUNS.has(t));
}

/** A clause inside an entry that makes it a description instead of a name. */
const VERB_PHRASE =
  /\b(?:including|include|includes|connected to|affiliated with|associated with|linked to|such as|as well as|among others|led by|backed by|participated|participating|joined by|and others|who|which|that)\b|, and\b/i;

/** Descriptors whose object is where the angels come from, not who invested ("angel investors connected to Acme, Beta"). */
const AFFILIATION = /\b(?:connected to|affiliated with|associated with|linked to)\b/i;

const MAX_NAME_LENGTH = 80;

/**
 * Leading role words the extractor copies from the page: "existing investor Acme Capital" is Acme
 * Capital. A bare "lead" or "investors" is never stripped ("Lead Edge Capital", "Investors Circle").
 */
const ROLE_PREFIX =
  /^(?:(?:existing|new|returning|strategic|previous|current|early|seed|other|angel|institutional)\s+(?:investors?|backers?|shareholders?)|(?:co-)?lead investors?|co-?investors?)\s+(?=[A-Z0-9])/i;

/** A bare lowercase "investor" before a name is a role word too; capitalized it may be the name ("Investor AB"). */
const BARE_INVESTOR_PREFIX = /^investor\s+(?=[A-Z0-9])/;

/**
 * A qualifier the extractor copied after the name: ", managed by Manager Co., Ltd." or ", a platform
 * created by Parent Capital". The name is what stands before it.
 */
const QUALIFIER_TAIL =
  /,\s*(?:(?:a|an|the)\s+[^,]{0,40}?\s+)?(?:managed|advised|created|formed|founded|launched|established|owned|operated|sponsored|run)\s+by\b.*$|,\s*(?:a|an|the)\s+(?:[\w-]+\s+){0,2}(?:subsidiary|affiliate|unit|division|arm|platform|portfolio company|vehicle|fund|part)\b.*$/i;

/** "funds managed by Acme", "accounts advised by Acme", "funds and accounts run by Acme": the vehicle goes unnamed, so the manager it names is the investor. */
const MANAGED_BY_PREFIX =
  /^(?:(?:affiliated\s+)?(?:funds and accounts|funds?|accounts?|vehicles?|entities)\s+(?:managed|advised|run)\s+by|affiliated\s+(?:funds?|entities|vehicles?)\s+of|(?:funds?|entities|vehicles?)\s+affiliated\s+with)\s+(?:its\s+|the\s+)?/i;

/**
 * A lowercase article or count before the rest: "a syndicated group of individual investors", "two
 * American private investors", "some business angels", "certain members of the company's management
 * team". A firm writes its own name capitalized ("Two Sigma Ventures", "A-Star Capital"), so only the
 * lowercase opener marks a description of investors rather than a name.
 */
const DESCRIPTIVE_OPEN =
  /^(?:a|an|the same|the other|the rest of|some|two|three|four|five|six|seven|eight|nine|ten|several|certain|various|numerous|multiple|many|few|other|unnamed|undisclosed|select|prominent|notable|leading|existing|additional)\s/;

/**
 * A crowd of a firm, lowercase as a description is written: "executives from OpenAI", "associates of
 * Smead Capital Management", "partners of DST Global". People who work somewhere are not that firm's
 * investment (a capitalized "Partners of Acme" can be a name and stays).
 */
const CROWD_OF =
  /^(?:the\s+)?(?:executives|employees|members|associates|partners|alumni|staff|leaders|management|team members|founders|co-?founders|ex-?founders?|former (?:executives|employees))\s+(?:from|of|at)\s/;

/** A person described, not named: "the ex-founder of Shutterstock", "a former CEO of Acme". */
const PERSON_DESCRIBED = /^(?:the\s+)?(?:ex-|former\s+)?(?:co-?)?(?:founder|ceo|cto|chairman|president)s?\s+(?:of|at)\s/i;

/**
 * A lowercase crowd noun at the end: "German business angels", "industry business angels", "two
 * Kellogg angels". A named angel group capitalizes itself ("Stanford Angels", "BAN Business Angels").
 */
const CROWD_TAIL =
  /\s(?:business angels|angel investors|angels|private investors|individual investors|strategic investors|institutional investors|investors|executives|shareholders)$/;

/**
 * An owner's vehicle named through lowercase descriptor words: "Microsoft's venture arm M12" is M12,
 * "Kevin Hart's firm Hartbeat Ventures" is Hartbeat Ventures, "Temasek's early-stage investment
 * platform Xora" is Xora, and "Tobias Lütke's family office", naming no vehicle, is Tobias Lütke. A
 * possessive that is part of a name ("Monk's Hill Ventures") has no lowercase words after it and stays.
 */
const OWNER_DESCRIPTOR = /^(.+?)['’]s\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*)*)(?:\s+(.+))?$/;

/**
 * A word inside a trailing parenthetical that makes it a description of the name's relation to
 * another firm, not part of the name: "(CVC of Cereal Docks Group)", "(formerly Acme Labs)",
 * "(part of Acme Corp)". A bare acronym or short name ("(a16z)", "(BDC)") carries none of these
 * and is left for the merge rules, which fold it into the written-out form.
 */
const DESCRIPTOR_PAREN_WORDS = new Set([
  "ex",
  "cvc",
  "arm",
  "fund",
  "unit",
  "division",
  "subsidiary",
  "affiliate",
  "vehicle",
  "of",
  "by",
  "formerly",
  "part",
]);

// ---------------------------------------------------------------------------------------------
// Rule 3: persons and firms

/** A role a person holds at another company: named this way they invest as themselves, not as the company. */
const EXEC_ROLE =
  /\b(?:co-?founders?|founders?|ceo|cto|coo|cfo|cpo|cmo|chairman|chairwoman|chair|president|executives?|directors?|vp|head)\b|\bex-|\bformer\b/i;

/** Words that make a capitalized pair a firm and never a person. */
const FIRM_WORDS = new Set([
  "capital",
  "ventures",
  "venture",
  "partners",
  "fund",
  "funds",
  "group",
  "holdings",
  "bank",
  "health",
  "labs",
  "technologies",
  "technology",
  "management",
  "investments",
  "investment",
  "equity",
  "growth",
  "foundation",
  "trust",
  "corporation",
  "company",
  "inc",
  "llc",
  "ltd",
  "global",
  "international",
  "associates",
  "advisors",
  "securities",
  "alternatives",
  "university",
  "institute",
  "government",
  "family",
  "office",
]);

/**
 * Places a publisher names an investor through: "Singapore's GIC", "Abu Dhabi's MGX", "Canada's OTPP".
 * A fixed list, so a possessive that is part of a name ("Monk's Hill Ventures") or an owner's
 * ("Alphabet's CapitalG") is never read as one.
 */
const PLACES = [
  "Abu Dhabi",
  "Africa",
  "America",
  "Argentina",
  "Asia",
  "Australia",
  "Austria",
  "Bahrain",
  "Bavaria",
  "Beijing",
  "Belgium",
  "Berlin",
  "Brazil",
  "Britain",
  "California",
  "Canada",
  "Chile",
  "China",
  "Colombia",
  "Denmark",
  "Dubai",
  "Egypt",
  "Estonia",
  "Europe",
  "Finland",
  "France",
  "Germany",
  "Hong Kong",
  "India",
  "Indonesia",
  "Ireland",
  "Israel",
  "Italy",
  "Japan",
  "Kenya",
  "Korea",
  "Kuwait",
  "Latin America",
  "London",
  "Luxembourg",
  "Malaysia",
  "Mexico",
  "Morocco",
  "Mumbai",
  "Netherlands",
  "New York",
  "New Zealand",
  "Nigeria",
  "Norway",
  "Oman",
  "Ontario",
  "Paris",
  "Philippines",
  "Poland",
  "Portugal",
  "Qatar",
  "Quebec",
  "Québec",
  "Riyadh",
  "Saudi Arabia",
  "Scotland",
  "Seoul",
  "Shanghai",
  "Shenzhen",
  "Silicon Valley",
  "Singapore",
  "South Africa",
  "South Korea",
  "Spain",
  "Sweden",
  "Switzerland",
  "Taiwan",
  "Texas",
  "Thailand",
  "the Gulf",
  "the Middle East",
  "the Netherlands",
  "the Philippines",
  "the U.K.",
  "the U.S.",
  "the UAE",
  "the UK",
  "the US",
  "Tokyo",
  "Turkey",
  "U.K.",
  "U.S.",
  "UAE",
  "UK",
  "US",
  "Vietnam",
  "Wales",
];
const PLACE_POSSESSIVE = new RegExp(`^(?:${PLACES.map(escapeRegExp).join("|")})['’]s\\s+([\\p{Lu}\\d].*)$`, "u");
/** Words that leave no name of its own once the place goes: "Kuwait's Investment Authority" is Kuwait's. */
const INSTITUTION_WORDS = new Set([
  ...FIRM_WORDS,
  "authority",
  "sovereign",
  "wealth",
  "development",
  "agency",
  "ministry",
  "government",
  "national",
  "state",
  "public",
  "pension",
  "central",
  "council",
  "of",
  "and",
  "the",
]);

/**
 * Two or three capitalized words, none a firm word: the shape of a person's name. Shape, not
 * proof: "Kleiner Perkins" has it too, which is why the investor-domain resolver treats a match
 * as a reason for stricter evidence rather than a refusal.
 */
export function isPersonShaped(text: string): boolean {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 3) return false;
  return parts.every((p) => /^[A-Z][\p{L}'’.-]*$/u.test(p) && !FIRM_WORDS.has(fold(p).trim()));
}

/** An honorific that makes the name a person's whatever follows it. */
const HONORIFIC = /^(?:dr|mr|mrs|ms|prof|sir|dame|lord)\.?\s+/i;
/** Lowercase particles inside a person's surname: "Ludwig van Beethoven", "Matthieu du Rausas". */
const SURNAME_PARTICLE = /^(?:de|del|della|der|di|da|dos|du|van|von|le|la|bin|al|el|ter|ten)$/i;

/**
 * Whether the name reads as one person (or a couple) rather than a firm named like one: two to four
 * capitalized words, no firm word, and either an honorific, a middle initial ("Jane Q. Doe"), or a
 * first word that is a common given name. "Jeff Hammerbacher" and "Terri and John Penshorn" are
 * people; "Kleiner Perkins" is only person-shaped. A firm whose first word is a given name ("Morgan
 * Stanley") reads as a person here too, so callers treat this as a reason to demand a firm's own
 * site, never as proof.
 */
export function isLikelyPerson(name: string): boolean {
  const base = head(name).trim();
  if (HONORIFIC.test(base) && isPersonShaped(base.replace(HONORIFIC, ""))) return true;
  const couple = /^(\S+)\s+(?:and|&)\s+(\S+)\s+(\S+)$/.exec(base);
  if (couple?.[1] && couple[2] && couple[3]) {
    return [couple[1], couple[2]].every((w) => GIVEN_NAMES.has(fold(w).trim())) && isPersonShaped(`${couple[2]} ${couple[3]}`);
  }
  const words = base.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  const named = words.filter((w) => !SURNAME_PARTICLE.test(w));
  if (!named.every((w) => /^[\p{Lu}][\p{L}'’.-]*$/u.test(w) && !FIRM_WORDS.has(fold(w).trim()))) return false;
  if (named.length < 2) return false;
  if (named.length === 3 && /^\p{Lu}\.?$/u.test(named[1] ?? "")) return true;
  return GIVEN_NAMES.has(fold(named[0] ?? "").trim());
}

/** The person's name inside "Acme co-founder Jane Doe" or "Jane Doe (Acme co-founder)", or null. */
function bareName(entry: string): string | null {
  const base = head(entry).replace(/,.*$/, "").trim();
  const words = base.split(/\s+/);
  let run: string[] = [];
  let best: string[] = [];
  for (const w of words) {
    const isCap = /^[A-Z][\p{L}'’.-]*$/u.test(w) && !EXEC_ROLE.test(w) && !FIRM_WORDS.has(fold(w).trim());
    if (isCap) run.push(w);
    else {
      if (run.length >= 2 && run.length <= 3) best = run;
      run = [];
    }
  }
  if (run.length >= 2 && run.length <= 3) best = run;
  return best.length ? best.join(" ") : null;
}

/**
 * A tail that names a person's prior firm: "formerly of", "previously of", "ex-", or "former
 * <role> at/of". What stands before it is the person, who invests as themselves.
 */
const FORMER_TAIL = /,?\s+(?:(?:formerly|previously)\s+(?:of|at|with)\s+\S|ex-\S|former\s+.+?\s+(?:of|at)\s+\S)/i;

/**
 * The firm a person or team stands for: "Jane Doe of Acme Ventures" and "Growth Equity at Acme
 * Alternatives" are Acme Ventures and Acme Alternatives. "Bank of America" is left alone (its head
 * is one word, not a person), and so is "co-founder of Acme" (a role at a company the person does
 * not invest for).
 */
export function firmOfPerson(name: string): string | null {
  const s = head(name).trim();
  const at = /^(.+?)\s+(?:at|from)\s+([A-Z0-9].+)$/.exec(s);
  if (at?.[1] && at[2] && !EXEC_ROLE.test(at[1])) return at[2].trim();
  const of = /^(.+?)\s+of\s+([A-Z0-9].+)$/.exec(s);
  if (!of?.[1] || !of[2]) return null;
  const lhs = of[1].trim();
  if (EXEC_ROLE.test(lhs)) return null;
  if (isPersonShaped(lhs) || /\b(?:partner|principal|team|desk|arm|division|unit|practice)\b/i.test(lhs)) return of[2].trim();
  return null;
}

// ---------------------------------------------------------------------------------------------
// Rule 5: lenders

/** A debt tranche named as such. A bare "loan" is not one: "the fintech loan platform Acme raised" is equity. */
const DEBT_TERM =
  /\b(?:credit facilit(?:y|ies)|debt facilit(?:y|ies)|loan facilit(?:y|ies)|venture debt|term loans?|debt financing|debt tranche|lenders?|loans? (?:from|of|led by|provided by|arranged by))\b/gi;

/** A clause boundary the debt clause starts after: the equity half of the sentence stays outside. */
const CLAUSE_BREAK = /,|;|\bwhile\b|\balongside\b|\bplus\b|\band an?\b|\bas well as\b/gi;

const MONEY = /[$€£¥₹₩]\s?\d|\d\s?(?:million|billion|m|bn|mn)\b/i;

/** How close to the start of its clause a debt term must sit for a clause without a figure to count as the tranche. */
const DEBT_TERM_LEAD_IN = 30;

/** [start, end) spans of the evidence that describe a debt tranche. Empty when the round itself is the debt. */
function debtSpans(evidence: string, amountAsWritten: string | null): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const sentences = sentenceSpans(evidence);
  for (const m of evidence.matchAll(DEBT_TERM)) {
    const [sStart, sEnd] = sentenceAt(sentences, m.index);
    let start = sStart;
    for (const b of evidence.slice(sStart, m.index).matchAll(CLAUSE_BREAK)) start = sStart + b.index + b[0].length;
    // The clause is about the facility when it carries its own figure or opens with the term.
    if (MONEY.test(evidence.slice(start, sEnd)) || m.index - start <= DEBT_TERM_LEAD_IN) spans.push([start, sEnd]);
  }
  if (spans.length === 0) return spans;
  // The round's own amount inside the clause means the round is the facility; its lenders are its investors.
  if (amountAsWritten) {
    const folded = fold(evidence);
    const at = findTokens(folded, tokens(amountAsWritten));
    if (at >= 0 && spans.some(([s, e]) => at >= s && at < e)) return [];
  }
  return spans;
}

// ---------------------------------------------------------------------------------------------
// Rule 7: affiliations

/** A role at a company, as the evidence writes it: the company stands right before or right after "of". */
const ROLE_WORDS =
  "co-?founders?|founders?|ceo|cto|coo|cfo|cpo|cmo|chairman|chairwoman|chair|president|executives?|alumn(?:us|i)|veterans?";

/** "Acme founders Jane Doe": the text right after a company that makes it an affiliation. */
const ROLE_AFTER_NAME = new RegExp(`^(?:'s|’s)?\\s+(?:${ROLE_WORDS})\\b`, "i");

/** "co-founder of Acme": the text right before a company that makes it an affiliation. */
const ROLE_BEFORE_NAME = new RegExp(`\\b(?:${ROLE_WORDS})\\s+(?:of|at)\\s*$`, "i");

/**
 * A manager, parent, or vehicle named in an appositive: "managed by Manager Co.", "a platform created
 * by Parent Capital", "led by Acme Labs via Acme Vehicle IV". "Backed by"
 * is not here: on its own it names a participant, and inside an appositive the qualifier strip has
 * already cut the parent off the name.
 */
const APPOSITIVE_BEFORE_NAME =
  /\b(?:(?:managed|advised|created|formed|founded|launched|established|owned|operated|sponsored|run)\s+by|(?:a|an|the)\s+(?:subsidiary|affiliate|unit|division|arm|platform|portfolio company|vehicle|part)\s+of|via)\s+(?:its\s+|the\s+)?$/i;

/** How far back an appositive marker speaks for the name after it: the marker and an article, no more. */
const APPOSITIVE_REACH = 60;

/** "funds managed by Acme" is no appositive: the fund goes unnamed, so the manager it names is the investor. */
const MANAGED_FUNDS_BEFORE = /\bfunds?\s+(?:managed|advised|run)\s+by\s+(?:its\s+|the\s+)?$/i;

/** Whether the text right around a located name makes it an affiliation rather than an investor. */
function isAffiliationAt(evidence: string, sentences: Array<[number, number]>, index: number, nameLength: number): boolean {
  const [sStart] = sentenceAt(sentences, index);
  const after = evidence.slice(index + nameLength, index + nameLength + 40);
  if (ROLE_AFTER_NAME.test(after)) return true;
  const before = evidence.slice(Math.max(sStart, index - APPOSITIVE_REACH), index);
  return ROLE_BEFORE_NAME.test(before) || (APPOSITIVE_BEFORE_NAME.test(before) && !MANAGED_FUNDS_BEFORE.test(before));
}

// ---------------------------------------------------------------------------------------------
// Rule 8: prior backers and partners

/**
 * The start of a clause about an earlier round or the wider investor base. "Existing backers" is not
 * here: it describes who is in this round as often as who was in the last, and "early backers" is
 * guarded below for the same reason. "Previously undisclosed" and "previously announced" describe
 * this round.
 */
const PRIOR_MARKER =
  /\b(?:previously(?!\s+(?:undisclosed|unannounced|unreported|announced))|earlier(?!\s+(?:today|this week|on))|past (?:investors?|backers?)|prior (?:round|investors?|backers?|funding)|previous (?:round|investors?|backers?|funding)|investor base (?:also )?includes?|early backers)\b/gi;

/** A relation to the company other than money in: names after these are partners and customers. */
const PARTNER_MARKER =
  /\b(?:(?:partners|customers|clients)\s+(?:include|includes|including|such as|like)|works? with|working with|integrates? with|integrations? with)\b/gi;

/** Where a clause that is not about this round's investors gives way to one that is. */
const ROUND_CLAUSE =
  /[,;]\s+(?:and\s+|but\s+|while\s+)?(?:the|this|its)\s+(?:round|financing|funding|deal|raise)\b|(?:[,;]\s*|\s+and\s+)(?:which\s+|who\s+|it\s+|has\s+|is\s+)?(?:raised|raises|raising|closed|closes|announced|announces|secured|secures)\b/i;

/** A verb inside a prior clause that puts its names in this round after all ("early backers X and Y also joined"). */
const REJOINED = /\b(?:joined|joining|joins|participated|participating|participates|also invested|returned|re-?upped|doubled down)\b/i;

/** Month names as the evidence writes them, with the ordinal a comparison needs. */
const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const MONTH_YEAR =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?((?:19|20)\d{2})\b/gi;

/** The span of a clause from `start` to the end of its sentence, cut where the sentence turns to this round. */
function clauseFrom(evidence: string, start: number, sEnd: number): [number, number] {
  const rest = evidence.slice(start, sEnd);
  const cut = ROUND_CLAUSE.exec(rest);
  return [start, cut ? start + cut.index : sEnd];
}

/**
 * The comma clause holding `index`, walked back over list commas (", Beta Fund, Gamma Ventures") to
 * the comma that opens a real clause (", following", ", with").
 */
function clauseAround(evidence: string, index: number, sStart: number, sEnd: number): [number, number] {
  let start = sStart;
  for (const m of evidence.slice(sStart, index).matchAll(/[,;]\s*(?=(?!and\b|or\b)[a-z])/g)) start = sStart + m.index;
  const after = /[,;]/.exec(evidence.slice(index, sEnd));
  return [start, after ? index + after.index : sEnd];
}

/**
 * [start, end) spans of the evidence whose names are prior backers, partners, or customers, not
 * this round's investors. A clause dated to a month earlier than the latest month the evidence
 * names is a prior round too ("received a strategic investment from Beta Fund in May 2026" in a
 * sentence closed on August 27, 2026); with one date or none, no clause is judged by its date.
 */
function nonInvestorSpans(evidence: string): Array<[number, number]> {
  const sentences = sentenceSpans(evidence);
  const spans: Array<[number, number]> = [];
  for (const m of evidence.matchAll(PRIOR_MARKER)) {
    const [sStart, sEnd] = sentenceAt(sentences, m.index);
    // "with participation from early backers X and Y": the marker describes this round's participants.
    if (
      /early backers$/i.test(m[0]) &&
      new RegExp(`${PART_BEFORE.source}\\s+(?:its\\s+|the\\s+)?$`, "i").test(evidence.slice(sStart, m.index))
    )
      continue;
    const span = clauseFrom(evidence, m.index + m[0].length, sEnd);
    if (REJOINED.test(evidence.slice(span[0], span[1]))) continue;
    spans.push(span);
  }
  for (const m of evidence.matchAll(PARTNER_MARKER)) {
    const [, sEnd] = sentenceAt(sentences, m.index);
    spans.push(clauseFrom(evidence, m.index + m[0].length, sEnd));
  }
  const dates = [...evidence.matchAll(MONTH_YEAR)].map((m) => ({
    index: m.index,
    ordinal: Number(m[2]) * 12 + (MONTHS[(m[1] ?? "").slice(0, 3).toLowerCase()] ?? 0),
  }));
  const latest = Math.max(...dates.map((d) => d.ordinal));
  for (const d of dates) {
    if (d.ordinal >= latest) continue;
    const [sStart, sEnd] = sentenceAt(sentences, d.index);
    const sharesSentence = dates.some((o) => o.ordinal === latest && o.index >= sStart && o.index < sEnd);
    spans.push(sharesSentence ? clauseAround(evidence, d.index, sStart, sEnd) : [sStart, sEnd]);
  }
  return spans;
}

// ---------------------------------------------------------------------------------------------
// Rule 4 and 6: identity within the record

/**
 * Words a publisher wraps around a brand when naming it through its owner: the vehicle nouns, legal
 * forms, connectives, and the possessive "s" the fold leaves behind. A region or a strategy is not
 * here on purpose: on the shorter name it marks a sibling fund, and the wrapped-form rule must not
 * fold a sibling into a possessive spelling of another fund.
 */
const WRAPPER_WORDS = new Set([
  "and",
  "of",
  "the",
  "its",
  "s",
  "fund",
  "funds",
  "venture",
  "ventures",
  "capital",
  "partners",
  "group",
  "management",
  "investment",
  "investments",
  "arm",
  "unit",
  "division",
  "company",
  "co",
  "corp",
  "corporation",
  "inc",
  "llc",
  "ltd",
  "limited",
  "plc",
  "holdings",
  "llp",
  "lp",
]);

/**
 * Everything a firm's name wears around its brand: the wrapper words plus regions, strategies, fund
 * numbers, and descriptor roles. The brand-core and token-prefix rules read this set, so a word that
 * is noise for one is noise for the other. `INVESTOR_GENERIC_TAIL` in keys.ts strips a narrower
 * set from the identity key, and keeps regions and strategies there so "Sequoia Capital China" stays
 * its own key; this set is for deciding two spellings are one firm, where those words are noise. Do
 * not derive one from the other: the tests for both pin the difference.
 */
const CORE_NOISE = new Set([
  ...WRAPPER_WORDS,
  "asia",
  "southeast",
  "south",
  "north",
  "east",
  "west",
  "europe",
  "european",
  "eu",
  "uk",
  "us",
  "usa",
  "america",
  "americas",
  "latam",
  "latin",
  "india",
  "china",
  "japan",
  "korea",
  "africa",
  "mena",
  "emea",
  "apac",
  "pacific",
  "israel",
  "canada",
  "australia",
  "singapore",
  "sea",
  "global",
  "international",
  "growth",
  "equity",
  "industries",
  "board",
  "centre",
  "center",
  "innovations",
  "collective",
  "opportunity",
  "opportunities",
  "seed",
  "early",
  "stage",
  "crypto",
  "bio",
  "health",
  "healthcare",
  "digital",
  "tech",
  "technology",
  "technologies",
  "labs",
  "blockchain",
  "climate",
  "associates",
  "advisers",
  "advisors",
  "strategic",
  "research",
  "managed",
  "i",
  "ii",
  "iii",
  "iv",
  "v",
  "vi",
  "vii",
  "viii",
  "ix",
  "x",
]);

/** The tokens of a full key that carry identity, with the wrapper words removed. */
function distinctiveTokens(fullKey: string): Set<string> {
  return new Set(fullKey.split(" ").filter((t) => t && !WRAPPER_WORDS.has(t)));
}

/**
 * True when one name is the other wrapped in an owner and a noun: a parent's fund named through the
 * parent ("Parent Corp.'s Brand fund" for "Brand"). Without this the owner's name makes the brand
 * core differ and the two spellings stay two entries. The shorter's distinctive tokens all sit in
 * the longer's, the longer carries a possessive (the mark of an owner, which a firm sharing a word
 * with another lacks), and the shorter's key is not a prefix of the longer's (a prefix is a longer
 * form of the same name, judged by the brand core so that a brand never swallows a sibling fund
 * that starts with it).
 */
function isWrappedForm(keyA: string, fullA: string, keyB: string, fullB: string): boolean {
  const da = distinctiveTokens(fullA);
  const db = distinctiveTokens(fullB);
  if (da.size === 0 || db.size === 0) return false;
  const [small, big, smallKey, bigKey, bigFull] = da.size <= db.size ? [da, db, keyA, keyB, fullB] : [db, da, keyB, keyA, fullA];
  if (bigKey.startsWith(smallKey)) return false;
  // The fold turns a possessive into a one-letter "s" token.
  if (!/(?:^| )s(?: |$)/.test(bigFull)) return false;
  return [...small].every((t) => big.has(t));
}

/** How short a token may be and still count as the stem of a longer one (a three-letter brand is not a stem of a longer brand that starts with it). */
const MIN_STEM_LENGTH = 4;

/**
 * True when each token of the shorter full key is the start of the token in the same position of the
 * longer, at least one strictly ("invest" for "investment"), and whatever the longer adds is noise
 * words: a publisher's clipped form of a firm's own name. Without this the clipped word is a
 * different brand core and the two spellings stay two entries. A one-token name is left to the
 * other rules.
 */
function isTokenPrefixForm(fullA: string, fullB: string): boolean {
  const ta = fullA.split(" ").filter(Boolean);
  const tb = fullB.split(" ").filter(Boolean);
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length < 2) return false;
  let strict = false;
  for (let i = 0; i < short.length; i++) {
    const s = short[i] ?? "";
    const l = long[i] ?? "";
    if (!l.startsWith(s)) return false;
    if (l !== s) {
      if (s.length < MIN_STEM_LENGTH) return false;
      strict = true;
    }
  }
  return strict && long.slice(short.length).every((w) => CORE_NOISE.has(w));
}

/**
 * Whether two spellings name one firm on their own, without the evidence: the same key, the same
 * brand core, an owner-wrapped form, or a token-prefix form. `fullA` and `fullB` are the names'
 * complete token strings, keys with the generic tail still on.
 */
function sameSpelling(keyA: string, fullA: string, keyB: string, fullB: string): boolean {
  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;
  if (/^plus (?:partners|capital)$/.test(keyA) || /^plus (?:partners|capital)$/.test(keyB)) return false;
  if (INVESTOR_ARMS.has(keyA) || INVESTOR_ARMS.has(keyB)) return false;
  if (sameBrandCore(keyA, keyB)) return true;
  if (isWrappedForm(keyA, fullA, keyB, fullB)) return true;
  return isTokenPrefixForm(fullA, fullB);
}

/** The spelling to show: fewer descriptor words (the firm's name over "Firm-managed funds"), then the longer name. */
function cleaner(_keyA: string, nameA: string, _keyB: string, nameB: string): boolean {
  // A phrase about the firm ("Firm-managed funds", "angel investor X") is not
  // its name; a name without one wins, then the longer name.
  const phrase = (n: string) =>
    /-(?:managed|backed|led|affiliated|owned|controlled)\b|^(?:angel|existing|new|lead|strategic|returning|prior) investors?\b/i.test(n);
  const pa = phrase(nameA);
  const pb = phrase(nameB);
  if (pa !== pb) return !pa;
  return nameA.length > nameB.length;
}

/** How short a brand core may be and still stand for a firm: a three-letter initialism is a brand, a two-letter one is an alias's job. */
const MIN_CORE_LENGTH = 3;

/**
 * The brand once every noise word is gone: "brand managed funds" and "brand group" are both "brand",
 * and so are a brand and the same brand with a region or a fund number after it. Two names with the
 * same non-empty core are one firm; a sibling fund with its own word ("brand heritage") keeps its
 * own core and stays distinct. Without this, a descriptor phrase around a brand, a region or fund
 * extension, and a spacing variant ("key 1" and "key1") each stay a second entry.
 */
function sameBrandCore(keyA: string, keyB: string): boolean {
  // Sorted, so two names that put the same words in a different order meet.
  const core = (k: string) =>
    k
      .split(/\s+/)
      .filter((t) => t && !CORE_NOISE.has(t))
      .sort()
      .join("");
  // In the order written, so a name written as one word and as two ("jpmorganchase" and "jpmorgan chase") meet.
  const plain = (k: string) =>
    k
      .split(/\s+/)
      .filter((t) => t && !CORE_NOISE.has(t))
      .join("");
  const a = core(keyA);
  const b = core(keyB);
  const pa = plain(keyA);
  const pb = plain(keyB);
  return (a.length >= MIN_CORE_LENGTH && a === b) || (pa.length >= MIN_CORE_LENGTH && pa === pb);
}

/** Edit distance, for the typo rule only. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

const MIN_TYPO_KEY_LENGTH = 5;

// ---------------------------------------------------------------------------------------------
// Rule 1: lead language

/** Markers a lead's name follows. */
const LEAD_BEFORE =
  /\b(?:(?:co-?)?led by (?:a |an |the )?(?:new |fresh )?(?:investments?|capital|funding) from|co-?led by|led (?:entirely |solely |jointly )?by|lead investors?(?: is| was| are| were|:)?|lead(?:ing)? investors? (?:is|was|are|were|:)|spearheaded by|anchored by|headed by|leading the round (?:is|was|are|were)|(?:from |with )?co-?leads|co-?leaders? (?:are|is|were|was|include|includes|included)|angeführt von|unter (?:der )?(?:Führung|Leitung) von|(?:co-?)?(?:mené|menée|dirigé|dirigée) par|(?:co-?)?(?:liderad[ao]|encabezad[ao]) por|(?:co-?)?guidat[ao] da|geleid door|onder leiding van)\b/gi;

/**
 * "Acme Capital was a leader in the startup's $10 million seed funding round": the noun form of leading,
 * when the round is what was led. "A leader in enterprise AI" describes a market and never matches.
 */
const LEADER_IN =
  "(?:was|is|were|are) (?:a |the )?(?:co-?)?leaders? (?:in|of)(?=.{0,80}\\b(?:round|financing|funding|investment|raise)\\b)";

/** A lead's role after its name: "with Acme as lead investor", "Beta joining as co-lead", "mit Acme als führendem Investor". */
const AS_LEAD =
  "(?:(?:joining|joins|joined|acting|serving|serves|served) )?as (?:the |a |an |its )?(?:anchor )?(?:co-?)?(?:(?:lead|anchor)(?: investors?| backers?|(?=\\s*(?:[,.;:)]|$|and\\b)))|leading (?:investors?|backers?))|as co-?leads|als (?:führende[mnr]?|Lead-?) ?Investor(?:en)?";

/**
 * A lead taken on as a step: "Eclipse stood up to lead, and our Series D came together", "Acme stepped
 * up to lead the round", "came in to lead", "agreed to lead a €3 billion round". What follows is the
 * clause's end or the round, so "agreed to lead US distribution" leads nothing.
 */
const STEPPED_UP_TO_LEAD =
  "(?:(?:stood|stepped|stands|steps|standing|stepping) up|(?:came|comes|coming) in|(?:agreed|agrees|agreeing)) to (?:co-?)?lead(?=\\s*(?:[,.;:)]|$)|\\s+(?:and|a|an|the|this|its|their|our)\\b|\\s+[$€£¥₹\\d])";

/** Verbs a lead's name precedes ("Acme Capital led the round", "with Acme leading"). */
const LEAD_AFTER = new RegExp(
  `\\b(?:leads|co-?leads|led|co-?led|lead(?= (?:a|an|the|this|its|[$€£¥₹]|\\d))|is (?:the |a )?lead investor|is leading|are leading|will lead|${STEPPED_UP_TO_LEAD}|to (?:co-?)?lead|leading|co-?leading|spearheaded|anchored|headed|${AS_LEAD}|${LEADER_IN})\\b`,
  "gi",
);

/** Lead language as a whole: the verb forms here exclude the adjective in "a leading AI startup". */
const LEAD_LANGUAGE = new RegExp(
  `\\b(?:leads|co-?leads|co-?led|led(?:\\s+(?:a|an|the|this|its|their)\\b|(?=[,.;:]|$))|is (?:the |a )?lead investor|is leading|are leading|will lead|${STEPPED_UP_TO_LEAD}|to (?:co-?)?lead (?:a|an|the|this|its)|(?:proud|excited|thrilled|pleased|delighted) to (?:co-?)?lead|leading the|co-?leading|spearheaded|anchored|${AS_LEAD}|${LEADER_IN})\\b`,
  "i",
);

/** Markers a participant's name follows. A descriptor like "existing investor" is not one: "co-led by A and existing investor B" has two leads. */
const PART_BEFORE =
  /\b(?:with (?:strategic )?participation (?:from|of|by)|participation (?:from|of)|participated in by|participants? (?:included|include|includes|were|are|was|is)|joined by|backed by|supported by|alongside|investors? (?:including|include|includes|included|such as)|including|include|includes|included|such as|(?:new |additional |further )?investments? from|from|with|together with|strategic co-?investors?|co-?investors?|also from|as well as)\b/gi;

/** Verbs a participant's name precedes. */
const PART_AFTER =
  /\b(?:joined|joining|joins|participated|participating|participates|also invested|also backed|also took part|also participated|also joined|took part|invested|backed|contributed|supported|returned)\b/gi;

/** Whether the evidence carries any lead language at all. */
export function hasLeadLanguage(evidence: string): boolean {
  return new RegExp(LEAD_BEFORE.source, "i").test(evidence) || LEAD_LANGUAGE.test(evidence);
}

function hasParticipantLanguage(evidence: string): boolean {
  return new RegExp(PART_BEFORE.source, "i").test(evidence) || new RegExp(PART_AFTER.source, "i").test(evidence);
}

interface Marker {
  index: number;
  end: number;
  kind: "lead" | "participant";
}

function markersOf(evidence: string): { before: Marker[]; after: Marker[] } {
  const collect = (re: RegExp, kind: Marker["kind"]): Marker[] =>
    [...evidence.matchAll(new RegExp(re.source, "gi"))].map((m) => ({ index: m.index, end: m.index + m[0].length, kind }));
  const before = [...collect(LEAD_BEFORE, "lead"), ...collect(PART_BEFORE, "participant")].sort((a, b) => a.index - b.index);
  const after = [...collect(LEAD_AFTER, "lead"), ...collect(PART_AFTER, "participant")].sort((a, b) => a.index - b.index);
  return { before, after };
}

export type Attribution = "lead" | "participant" | "unattributed";

/** What may stand between a name and its verb: more names, commas, "and", a parenthesis, "who". */
const VERB_GAP = /^-?[\s,]*(?:and\s+|&\s+)?(?:(?:[A-Z0-9][\w'’.&-]*|\([^)]*\))\s*,?\s*(?:and\s+|&\s+)?)*(?:[(,]\s*(?:who|which)\s+)?$/;

/** An appositive after a name: ", the Boston firm," or " – known for its portfolio – ". */
const APPOSITIVE = /^\s*(?:,\s+(?:a|an|the|its|which|who)\s[^,;]{0,100},|\s[-\u2013\u2014]\s[^-\u2013\u2014;]{0,140}\s[-\u2013\u2014])\s*/i;

/**
 * Words that describe the investors a lead marker names: "new key industry", "Arc's existing", "a group
 * of investors,", "a handful of hedge funds and P/E firms". An "and" or "or" joins two kinds of firm only
 * between plain lowercase words; a name on either side ("Acme and others", "a16z and others") ends it.
 */
const DESCRIBING_WORD = "(?:[a-z][\\w-]*|[A-Z][\\w.&-]*['’]s|[A-Z]{1,3}/[A-Z]{1,3})";
const LEAD_DESCRIBED = new RegExp(
  `^\\s*(?:(?!(?:and|or|that|which|who)\\b)${DESCRIBING_WORD}\\s+(?:(?<=\\b[a-z]+\\s+)(?:and|or)\\s+(?=[a-z]+\\s|[A-Z]{1,3}/))?)*(?:[a-z][\\w-]*,\\s*)?$`,
);

/**
 * The marker that speaks for a name at `index`: the nearest marker before it inside its sentence
 * and within reach; failing that, a verb shortly after it; failing both, none. Where the sentence's
 * shape puts a lead on the name the nearest marker does not ("with Acme leading", "Acme co-led
 * alongside Beta", "Co-leading the round with Beta is Acme", "$200M from Acme, with participation
 * from Beta"), the marker returned is that lead's: its verb, or the marker that opened its list.
 */
function markerFor(
  evidence: string,
  sentences: Array<[number, number]>,
  markers: { before: Marker[]; after: Marker[] },
  index: number,
  nameLength: number,
): Marker | undefined {
  const said = nearestMarker(evidence, sentences, markers, index, nameLength);
  if (said?.kind === "lead") return said;
  const [sStart] = sentenceAt(sentences, index);
  const inverted = INVERTED_LEAD.exec(evidence.slice(sStart, index));
  if (inverted) {
    const at = sStart + inverted.index;
    return { index: at, end: at + (/^\S+/.exec(inverted[0])?.[0].length ?? 0), kind: "lead" };
  }
  const subject = leadsAsSubject(evidence, sentences, markers, index, nameLength);
  if (subject) return subject;
  if (said?.kind !== "participant") return said;
  const continued = leadListContinued(evidence, sentences, markers, index);
  if (continued) return continued;
  const after = evidence.slice(index + nameLength).replace(APPOSITIVE, "");
  if (/\bfrom\s+(?:\S+\s+){0,3}$/i.test(evidence.slice(Math.max(0, index - 40), index)) && SET_APART.test(after)) {
    return { ...said, kind: "lead" };
  }
  return said;
}

/** The marker nearest a name that speaks for it, with the lead a "with", "alongside", "together with", or "including" carries. */
function nearestMarker(
  evidence: string,
  sentences: Array<[number, number]>,
  markers: { before: Marker[]; after: Marker[] },
  index: number,
  nameLength: number,
): Marker | undefined {
  const [sStart, sEnd] = sentenceAt(sentences, index);
  let nearest: Marker | undefined;
  for (const m of markers.before) {
    if (m.end > index || m.index < sStart || index - m.end > MARKER_REACH) continue;
    if (!nearest || m.end > nearest.end || (m.end === nearest.end && m.index < nearest.index)) nearest = m;
  }
  // "A, B and C led the round", "a B Capital-led round", "S2G Investments (S2G) leading", "Acme, the
  // Boston firm, led": nothing but names, commas, a hyphen, a parenthesis, and an appositive may stand
  // between the name and the verb, and the appositive's own words ("the Thiel-backed VC") mark nothing.
  const nameEnd = index + nameLength + (APPOSITIVE.exec(evidence.slice(index + nameLength))?.[0].length ?? 0);
  const following = markers.after.find((m) => m.index >= nameEnd && m.index < sEnd && m.index - nameEnd <= VERB_REACH);
  const gap = evidence.slice(nameEnd, following?.index ?? nameEnd);
  // "Acme, who led this round", "Acme (which led its seed)": a relative clause speaks for the round only when its verb names it.
  const relative = /[(,]\s*(?:who|which)\s+$/.test(gap);
  const verb =
    following &&
    VERB_GAP.test(gap) &&
    (!relative || /^(?:co-?)?led (?:the|this) (?:round|financing|investment)/i.test(evidence.slice(following.index)))
      ? following
      : undefined;
  // "led by Accel; South Park Commons and Lightspeed also participated": a clause after a semicolon
  // that says what its own names did is not the lead list before it.
  if (nearest?.kind === "lead" && verb?.kind === "participant" && evidence.slice(nearest.end, index).includes(";")) return verb;
  if (nearest?.kind !== "participant") return nearest ?? verb;
  // "with Acme leading the round": a lead verb right after the name outranks the "with" before it,
  // though not the adjective in "from Acme and Beta, leading investors in fintech".
  if (
    verb?.kind === "lead" &&
    !/^leading\s+(?!(?:the|this|its|a|an|and|or|with|alongside|as|in|for|while)\b)\w/i.test(evidence.slice(verb.index))
  ) {
    return verb;
  }
  const opening = evidence.slice(sStart, nearest.index);
  const marker = evidence.slice(nearest.index, nearest.end);
  // "Acme co-led the round alongside Beta", "Acme led the round together with Beta": whom a lead
  // leads together with, or a co-lead alongside, is the other lead, under the same lead verb.
  if (
    (/^alongside$/i.test(marker) && /\bco-?(?:lead|leads|leading|led)\b(?!\s+by\b)/i.test(opening)) ||
    (/^together with$/i.test(marker) && /\b(?:co-?)?(?:led|leads|leading|headed)\s+(?:the|this|its)\s+\w+\s*$/i.test(opening))
  ) {
    const leadVerb = [...markers.before, ...markers.after]
      .filter((m) => m.kind === "lead" && m.index >= sStart && m.end <= nearest.index)
      .sort((a, b) => a.end - b.end)
      .at(-1);
    return leadVerb ?? { ...nearest, kind: "lead" };
  }
  const prior = markers.before.filter((m) => m.index >= sStart && m.end <= nearest.index).at(-1);
  // "led by new industry investors including Acme", "led by Arc's existing investors including Acme":
  // the investors the lead marker named, when only words describing them stand between. A lead list
  // that names its firms, or a clause that goes on, ends before it: "co-led by A and B and includes
  // C", "with A as lead investor and a syndicate that includes C" name C no lead.
  if (
    /^(?:investors?\s+)?(?:including|includes|included|include|such as)$/i.test(marker) &&
    prior?.kind === "lead" &&
    nearest.index - prior.end <= 100 &&
    LEAD_DESCRIBED.test(evidence.slice(prior.end, nearest.index))
  ) {
    return prior;
  }
  return nearest;
}

/**
 * What the evidence says about a name at `index` for investor hygiene: the kind of the nearest marker
 * that speaks for it, or nothing. The leads markerFor reads from a sentence's shape are not read here.
 */
function attribute(
  evidence: string,
  sentences: Array<[number, number]>,
  markers: { before: Marker[]; after: Marker[] },
  index: number,
  nameLength: number,
): Attribution {
  return nearestMarker(evidence, sentences, markers, index, nameLength)?.kind ?? "unattributed";
}

/**
 * The lead list a "together with" continues: "co-led by A, B, together with C, and D", "led by
 * long-term shareholder A, together with B". The lead marker that opened the list, or none.
 */
function leadListContinued(
  text: string,
  sentences: Array<[number, number]>,
  markers: { before: Marker[]; after: Marker[] },
  index: number,
): Marker | undefined {
  const [sStart] = sentenceAt(sentences, index);
  const before = markers.before.filter((m) => m.index >= sStart && m.end <= index);
  const joint = before.at(-1);
  const opened = before.at(-2);
  if (!joint || !opened || opened.kind !== "lead" || !/^together with$/i.test(text.slice(joint.index, joint.end))) return undefined;
  return VERB_GAP.test(text.slice(opened.end, joint.index).replace(/^[a-z\s-]+(?=[A-Z])/, " ")) ? opened : undefined;
}

/** Participation set against the firm just named: ", with participation from", "with continued participation by". */
const SET_APART = /^[\s,]*(?:with|and)\s+(?:further\s+|continued\s+|additional\s+|follow-on\s+)?participation\s+(?:from|of|by)\b/i;

/** The lead named after its verb: "Leading the round is Acme", "Co-leading the round with Beta is Acme". */
const INVERTED_LEAD =
  /\b(?:co-?)?leading\s+(?:the|this)\s+(?:[\w$€£.,-]+\s+){0,4}?(?:round|financing|investment)\b[^.;]{0,80}?\b(?:is|are|was|were)\s+$/i;

/** Lead language as the verb of a sentence an investor opens: "leading a combined investment", "delighted to be leading" too. */
const SUBJECT_LEAD = new RegExp(`${LEAD_LANGUAGE.source}|\\bleading (?:a|an)\\b|\\bto be (?:co-?)?leading\\b`, "i");

/**
 * The lead verb of a sentence the name opens: "The IFC has announced plans to lead an equity round",
 * "Aspirity acquires majority stake in Onomondo, leads €100M investment". No investor marker may
 * stand between the name and the verb.
 */
function leadsAsSubject(
  text: string,
  sentences: Array<[number, number]>,
  markers: { before: Marker[]; after: Marker[] },
  index: number,
  nameLength: number,
): Marker | undefined {
  const [sentenceStart, sEnd] = sentenceAt(sentences, index);
  // Quoted speech opens a clause of its own: 'Jane Doe, partner at Acme, said: "Acme is delighted to be leading'.
  const quoteMark = Math.max(text.lastIndexOf("“", index), text.lastIndexOf('"', index));
  const sStart = quoteMark >= sentenceStart ? quoteMark + 1 : sentenceStart;
  const opening = text.slice(sStart, index);
  if (opening.length > 60 || /[,;:]/.test(opening) || markers.before.some((m) => m.index >= sStart && m.end <= index)) return undefined;
  const rest = text.slice(index + nameLength, Math.min(sEnd, text.length));
  const verb = SUBJECT_LEAD.exec(rest);
  if (!verb) return undefined;
  const verbAt = index + nameLength + verb.index;
  if (markers.before.some((m) => m.index > index && m.index < verbAt)) return undefined;
  return { index: verbAt, end: verbAt + verb[0].length, kind: "lead" };
}

/**
 * What the evidence says of one investor across all its texts: "lead" when some sentence puts lead
 * language on it ("led by Acme", "Acme co-led"), "participant" when it is named only as investing
 * ("from Acme", "backed by Acme", "Acme joined"), "unattributed" when it is not named or no role is said.
 */
export function statedRole(name: string, evidence: string[]): Attribution {
  // The name's head, the head without a region it ends on ("UntroD Capital Japan" is "UntroD Capital"),
  // and an acronym it carries in parentheses ("Qatar Investment Authority (QIA)") speak for either role.
  // A lead is often written shorter ("a Vista-led round", "SBI Group as anchor investor"), so the
  // identity key and its first word speak for a lead, never for a participant.
  const key = normalizeInvestorKey(name).split(" ").filter(Boolean);
  const short = key[0] && key[0].length >= 3 && key[0] !== "the" ? [key[0]] : [];
  const regional = new RegExp(`^(\\S+\\s+\\S.*?)\\s+(?:${PLACES.map(escapeRegExp).join("|")})$`).exec(head(name))?.[1] ?? "";
  const forms = [
    [tokens(head(name)), false],
    [tokens(regional), false],
    [tokens(/\(([^)]{2,})\)/.exec(name)?.[1] ?? ""), false],
    [key, true],
    [short, true],
  ] as const;
  let role: Attribution = "unattributed";
  for (const raw of evidence) {
    const text = raw.replace(/[\u2010-\u2015]/g, "-");
    const folded = fold(text);
    const sentences = sentenceSpans(text);
    const markers = markersOf(text);
    for (const [form, leadOnly] of forms) {
      if (form.length === 0) continue;
      for (let i = findTokens(folded, form); i >= 0; i = findTokens(folded, form, i + 1)) {
        const said = markerFor(text, sentences, markers, i, form.join(" ").length)?.kind ?? "unattributed";
        if (said === "lead") return "lead";
        // Lead language the sentence places on no one may be this name's: "Jane Doe of Acme, who is
        // one of the lead investors in this round".
        const [sStart, sEnd] = sentenceAt(sentences, i);
        if (said === "unattributed" && hasLeadLanguage(text.slice(sStart, sEnd))) return "lead";
        if (said === "participant" && !leadOnly) role = "participant";
      }
    }
  }
  return role;
}

/** Words before a firm that make it the source of a sentence's money: "investment with", "funding from venture capital firm". */
const SOLE_SOURCE_BEFORE =
  /\b(?:investments?|funding|financing|round|capital|raise|stake|million|billion|bn|mn)\b(?:(?!participation|backing|support)[^.;]){0,50}?\b(?:from|with|(?:funded|financed|provided|made)\s+by)\s+(?:(?:the\s+)?(?:(?:venture capital|private equity|growth equity|investment|growth)\s+)?firm\s+|(?:funds|accounts|vehicles)\s+(?:managed|advised)\s+by\s+)?$/i;
/** Words after a firm that make it the one paying: "SoftBank has made a $1 billion investment", "Acme invests $10 million". */
const SOLE_SOURCE_AFTER = /^\s+(?:has\s+|have\s+)?(?:made\s+an?\s+|invest(?:s|ed)\s+|put\s+|pour(?:s|ed)\s+|commit(?:s|ted)\s+)/i;
/** What continues a list of investors after a name, rather than describing the one named: ", Beta", "and Beta", "alongside". */
const LIST_GOES_ON =
  /^\s*(?:,(?!\s+(?:a|an|the|which|who|its|one|based|headquartered)\b)|\band\b|&|\+|\balong|\btogether|\bas well|\bplus\b|\bjoined|\bwith\b|\bamong|\bco-|\bet al)/i;
/** Words that put a firm among a round's other investors, or its money in a loan: "among others", "included participation from", "venture debt". */
const AMONG_OTHERS =
  /\b(?:among others|and others|participation|participated|participating|alongside|joined|included|including|debt|loans?|credit facility)\b/i;
const FIGURES =
  /(?:US\$|[$€£¥])\s?\d[\d,.]*(?:\s*(?:million|billion|bn|mn|m|b|k)\b)?|\b\d[\d,.]*\s*(?:million|billion)\s+(?:dollars|euros|pounds|usd|eur|gbp)\b/gi;

/**
 * Whether a page states the round's money as coming from this one firm alone: "a $150 million investment
 * with PSG", "$13 million in series-A funding from venture capital firm Index Ventures", "a strategic
 * growth investment of $165 million from funds managed by Rubicon Founders", "SoftBank Group Corp. has
 * made a $1 billion investment in Rappi". The sentence names the firm and no other beside it, and the
 * figure nearest it is the round's whole amount, so a round with no amount known never qualifies. A
 * round whose only named investor is its whole source is that firm's lead, though no sentence says "led".
 */
export function soleInvestor(name: string, evidence: string[], amount: string | null): boolean {
  const want = parseAmount(amount);
  if (want.value === null) return false;
  const isAmount = (figure: string | undefined) => {
    const got = parseAmount(figure ?? null);
    return (
      got.value !== null && got.currency === want.currency && Math.abs(got.value - (want.value as number)) <= 0.01 * (want.value as number)
    );
  };
  const form = tokens(head(name));
  if (form.length === 0) return false;
  let sole = false;
  for (const raw of evidence) {
    const text = raw.replace(/[\u2010-\u2015]/g, "-").replace(/[“”]/g, '"');
    const folded = fold(text);
    const sentences = sentenceSpans(text);
    for (let i = findTokens(folded, form); i >= 0; i = findTokens(folded, form, i + 1)) {
      const [start, end] = sentenceAt(sentences, i);
      const sentence = text.slice(start, end);
      // A sentence stating the round's amount that places the firm among others, or calls the money a loan,
      // says it is not the whole round's source. Another round recalled beside it ("$3 million in seed
      // funding from Google Ventures, Index Ventures, ...") does not.
      if (AMONG_OTHERS.test(sentence) && [...sentence.matchAll(FIGURES)].some((m) => isAmount(m[0]))) return false;
      if (sole || hasLeadLanguage(sentence)) continue;
      const before = text.slice(start, i);
      // The firm's name as the sentence writes it may run on ("D1 Capital" in "D1 Capital Partners", "Group Corp.").
      const rest = text.slice(i + form.join(" ").length, end).replace(/^(?:[\s.]+(?:[A-Z][\w&'’-]*\.?|&|of))*/, "");
      if (LIST_GOES_ON.test(rest)) continue;
      // The figure the money clause states, nearest the firm, is the round's whole amount, not a part of it.
      if (SOLE_SOURCE_BEFORE.test(before) && isAmount([...before.matchAll(FIGURES)].at(-1)?.[0])) sole = true;
      const lead = before.slice(-40).replace(/^.*[.:]\s*/, "");
      if (SOLE_SOURCE_AFTER.test(rest) && !/[,;]|\band\b|&/.test(lead) && isAmount(rest.match(FIGURES)?.[0])) sole = true;
    }
  }
  return sole;
}

// ---------------------------------------------------------------------------------------------
// Rule 9: a lead of another round

/** The round a lead is checked against: its stage, its label as written, and its amount as written. */
export interface LeadRound {
  stage: Stage;
  stage_as_written?: string | null;
  amount_as_written: string | null;
}

/**
 * Stages a lead's round label is compared on. An unlabelled round ("other", "growth"), a bridge, and a
 * pre-A are printed under a lettered label by some source often enough that no label contradicts them.
 */
const LABELLED: ReadonlySet<Stage> = new Set<Stage>(["pre_seed", "seed", "series_a", "series_b", "series_c", "series_d_plus"]);

/** A round label in a sentence. */
const ROUND_LABEL = /\b(?:pre[\s\u2010-\u2013-]?seed|seed|series\s+[a-k](?:[-\s]?\d)?|s[eé]rie\s+[a-k])\b/gi;

/** A money figure in a sentence, with its currency. */
const ROUND_FIGURE =
  /(?:(?:US|CA|AU|NZ|HK|S|A|C|R)?\$|[€£¥₹]|\b(?:USD|EUR|GBP|INR|CNY|RMB|JPY|CHF|Rs\.?)\s?)\d[\d,]*(?:\.\d+)?\s?(?:million|billion|mn|bn|crore|cr|lakh|m|b)\b/gi;

/** A figure that is a valuation, not money raised: "at a $10 billion valuation", "valued at $2 billion". */
const VALUATION_FIGURE =
  /^\s*(?:\([^)]*\)\s*)?(?:pre|post)?[\s-]*(?:money\s+)?valuation|(?:valu(?:ed|es|ing)\b[^,;]{0,30}?\bat|valuation\s+(?:of|to|at)|worth)\s+(?:about|around|roughly|over|nearly|some|more than)?\s*$/i;

/** Words that make a figure a total across rounds rather than one round's money. */
const TOTAL_WORDS = /\b(?:total|to date|in all|altogether|so far|cumulative)\b/i;

/** Words that place a lead at an earlier round: "previously led", "led its last round", "had previously co-led". */
const EARLIER_LEAD = /\b(?:previously|previous|prior|earlier|last(?!\s+(?:week|month|year|quarter))|predecessor)\b/i;

/** How far before a lead marker an earlier-round word still speaks for it: "previously led by", "had earlier co-led". */
const EARLIER_REACH = 20;

/** How far from its lead marker a round label or figure still names the round led, in characters. */
const LEAD_ROUND_REACH = 70;

/**
 * What one lead marker's round is, read from the label or figure next to it ("$5 million in seed
 * funding led by", "Storm Ventures led a $6 million seed", "which led its seed round"): this round
 * (its own figure or label), another round (a different figure or label), an earlier round (an
 * earlier-round word on the marker: "previously led", "led its last round"), or unnamed.
 */
function leadRoundOf(
  evidence: string,
  sentences: Array<[number, number]>,
  marker: Marker,
  before: boolean,
  leads: Marker[],
  round: LeadRound,
): "this" | "another" | "earlier" | "unnamed" {
  const [sStart, sEnd] = sentenceAt(sentences, marker.index);
  let window: string;
  if (before) {
    // "$20 million Series A led by X": the round stands before the marker, after any earlier lead clause.
    const prior = leads.filter((m) => m.end <= marker.index && m.index >= sStart).pop();
    window = evidence.slice(Math.max(prior?.end ?? sStart, sStart, marker.index - LEAD_ROUND_REACH), marker.index);
  } else {
    // "X, which led its seed round in 2024": the round follows the verb, up to the clause's end.
    window = evidence.slice(marker.end, Math.min(sEnd, marker.end + LEAD_ROUND_REACH)).split(/[;,]|\s+(?:and|while|but)\s+/)[0] ?? "";
  }
  // The label or figure nearest the marker: the last one before it, the first one after it.
  const nearest = <T>(list: T[]) => (before ? list.at(-1) : list[0]);
  const target = parseAmount(round.amount_as_written);
  const figure = TOTAL_WORDS.test(window)
    ? undefined
    : nearest(
        [...window.matchAll(ROUND_FIGURE)]
          .filter((m) => !VALUATION_FIGURE.test(window.slice(m.index + m[0].length)) && !VALUATION_FIGURE.test(window.slice(0, m.index)))
          .map((m) => parseAmount(m[0])),
      );
  const gap =
    target.value !== null && figure?.value != null && figure.currency === target.currency
      ? Math.abs(figure.value - target.value) / Math.max(figure.value, target.value)
      : null;
  // "$1.1 million pre-seed round led by" on a round stored as seed: this round's own figure makes it this round.
  if (gap !== null && gap <= 0.05) return "this";
  // "a pre-seed and seed round led by": a window that names this round's own label is about this round.
  const labels = [...window.matchAll(ROUND_LABEL)].map((m) => classifyStage(m[0].replace(/[\u2010-\u2013]/g, "-")).stage);
  const labelled = labels.length > 0 && LABELLED.has(round.stage);
  if (labelled && labels.includes(round.stage)) return "this";
  const onMarker = evidence.slice(Math.max(sStart, marker.index - EARLIER_REACH), marker.index);
  if (EARLIER_LEAD.test(onMarker) || (!before && EARLIER_LEAD.test(window))) return "earlier";
  return labelled || gap !== null ? "another" : "unnamed";
}

/** Whether the names a marker speaks for follow it ("led by Acme") rather than precede it ("Acme led"). */
function namesFollow(markers: { before: Marker[]; after: Marker[] }, marker: Marker): boolean {
  return markers.before.some((m) => m.index === marker.index && m.end === marker.end);
}

/**
 * Whether the evidence calls `name` a lead only of another round than `round`. Every lead marker that
 * speaks for it must sit on another round, and the evidence must say so: an earlier-round word on the
 * marker ("previously led", "which led its last round"), or two rounds side by side with this one's
 * own lead ("$5 million in seed funding led by General Catalyst, and $20 million Series A led by CRV"
 * for the Series A). A figure or label that differs with nothing beside it is a source disagreeing
 * about this round, and its lead stands. A round labelled with two stages ("seed and Series A") is
 * not judged: either could be the one the lead's sentence means.
 */
export function leadOfAnotherRound(evidence: string, name: string, round: LeadRound): boolean {
  const written = [...(round.stage_as_written ?? "").matchAll(ROUND_LABEL)].map((m) => classifyStage(m[0]).stage);
  if (new Set(written).size > 1) return false;
  const folded = fold(evidence);
  const sentences = sentenceSpans(evidence);
  const markers = markersOf(evidence);
  const leadBefore = markers.before.filter((m) => m.kind === "lead");
  const leads = [...leadBefore, ...markers.after.filter((m) => m.kind === "lead")].sort((a, b) => a.index - b.index);
  const roundOf = (m: Marker) => leadRoundOf(evidence, sentences, m, namesFollow(markers, m), leads, round);
  const parts = tokens(head(name));
  const kinds: string[] = [];
  for (let at = findTokens(folded, parts); at >= 0; at = findTokens(folded, parts, at + 1)) {
    const marker = markerFor(evidence, sentences, markers, at, head(name).length);
    if (marker?.kind === "lead") kinds.push(roundOf(marker));
  }
  if (kinds.length === 0 || kinds.some((k) => k === "this" || k === "unnamed")) return false;
  return kinds.includes("earlier") || leads.some((m) => roundOf(m) === "this");
}

/**
 * Whether the evidence names `name` as a participant anywhere: a participant marker speaks for it
 * ("joined by", "also invested"), or one stands right before the lead words that describe it ("with
 * participation from previous lead investor Acme").
 */
export function investedInRound(evidence: string, name: string): boolean {
  const folded = fold(evidence);
  const sentences = sentenceSpans(evidence);
  const markers = markersOf(evidence);
  const parts = tokens(head(name));
  for (let at = findTokens(folded, parts); at >= 0; at = findTokens(folded, parts, at + 1)) {
    const marker = markerFor(evidence, sentences, markers, at, head(name).length);
    if (marker?.kind === "participant") return true;
    if (marker?.kind !== "lead" || !namesFollow(markers, marker)) continue;
    const described = markers.before.some(
      (m) => m.kind === "participant" && m.end <= marker.index && /^\s+(?:[a-z]+\s+){0,2}$/.test(evidence.slice(m.end, marker.index)),
    );
    if (described) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The entry point

interface Entry {
  original: string;
  name: string;
  role: "lead" | "other";
  order: number;
  found: Found;
}

function tidy(name: string): string {
  return name
    .trim()
    .replace(/^(?:and|&)\s+/i, "")
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(/[\s,;.]+$/g, "")
    .trim();
}

/**
 * The per-name hygiene `cleanInvestors` applies without the evidence: role-word and qualifier
 * strips, the owner-wrapped-fund and managed-by rules, the placeholder drop, and the
 * person-of-a-firm rules. Returns the name to store, or null when the entry names a placeholder
 * or describes nobody. Investor lists that never passed through `cleanInvestors` (a verdict's, a
 * gap fill's) run through this so the model's phrasing cannot reach a stored record.
 */
export function normalizeInvestorName(name: string): string | null {
  let s = tidy(displayHygiene(name));
  if (!s) return null;
  const unqualified = tidy(s.replace(QUALIFIER_TAIL, ""));
  if (unqualified) s = unqualified;
  if (s.length > MAX_NAME_LENGTH || VERB_PHRASE.test(s)) return null;
  s = s.replace(ROLE_PREFIX, "").replace(BARE_INVESTOR_PREFIX, "").trim() || s;
  // Descriptions of investors, not names (the pre-launch audit's directory held "executives from
  // OpenAI", "a syndicated group of individual investors", "some business angels").
  if (DESCRIPTIVE_OPEN.test(s) || CROWD_OF.test(s) || PERSON_DESCRIBED.test(s) || CROWD_TAIL.test(s)) return null;
  // A lowercase "the" before a capitalized name is the sentence's article ("the University of
  // Michigan", "the Raine Group"); a firm that is "The Column Group" writes its own capital T.
  s = s.replace(/^the\s+(?=[A-Z0-9])/, "");
  // A place's possessive says where the investor is, not who: "Singapore's GIC" is GIC.
  const placed = PLACE_POSSESSIVE.exec(s)?.[1];
  if (placed && !tokens(placed).every((t) => INSTITUTION_WORDS.has(t))) s = placed;
  const owned = OWNER_DESCRIPTOR.exec(head(s));
  if (owned?.[1] && owned[2]) {
    const vehicle = owned[3]?.trim();
    s = vehicle && /[A-Z0-9]/.test(vehicle.charAt(0)) ? vehicle : owned[1].trim();
  }
  const paren = /\s*\(([^)]*)\)\s*$/.exec(s);
  if (paren?.[1] && tokens(paren[1]).some((t) => DESCRIPTOR_PAREN_WORDS.has(t))) s = s.slice(0, paren.index).trim();
  // An owner-wrapped fund named alone: "Microsoft's M12 fund" is M12, "Acme's scout fund" is Acme.
  // A capital-F "Fund" is part of the wrapped name, a lowercase one the descriptor that wraps it.
  // Parentheses strip first so an acronym after the owner ("Canada's (BDC) Industrial fund") is
  // neither part of the wrapped name nor the place head() cuts it.
  const ownerHead = head(s.replace(/\s*\([^)]*\)\s*/g, " "));
  const ownerFund = /^(.+?)(?:'s|’s)\s+(.+?)\s+([Ff]und)$/.exec(ownerHead);
  if (ownerFund?.[1] && ownerFund[2] && ownerFund[3]) {
    const wrapped = ownerFund[3] === "Fund" ? `${ownerFund[2]} Fund` : ownerFund[2];
    s = wrapped.split(/\s+/).some((w) => /^[A-Z]/.test(w)) ? wrapped.trim() : ownerFund[1];
  }
  s = s.replace(MANAGED_BY_PREFIX, "");
  if (isPlaceholderInvestor(s)) return null;
  // "Jane Doe, formerly of Acme" is the person, investing as themselves: the tail names a prior
  // firm, not who invests now.
  const former = FORMER_TAIL.exec(s);
  if (former) {
    const person = tidy(s.slice(0, former.index));
    if (isPersonShaped(person)) return person;
  }
  const firm = firmOfPerson(s);
  if (firm) return tidy(firm);
  return s || null;
}

/** A trademark sign a press release prints after a firm's name ("Energy Capital Ventures®"). */
const TRADEMARK = /\s*[®™©℠]/g;
/** An exchange listing written into the name: "Eli Lilly (NYSE: LLY)", "Acme, Nasdaq: ACME". */
const TICKER =
  /\s*(?:,\s*|\(\s*)?\b(?:NYSE(?:\s+American)?|NASDAQ|Nasdaq|TSXV?|LSE|AIM|ASX|OTC(?:QX|QB)?|HKEX|SEHK|SGX|BSE|NSE|TSE|TYO|Euronext|SIX|XETRA|FWB|KRX|KOSDAQ|TWSE|NZX|JSE)\s*:\s*[A-Z0-9][A-Z0-9.-]{0,9}\s*\)?/g;
/**
 * A legal form at the end of the name, which the key already ignores and the page should not show:
 * "Arm Holdings Inc", "Eni Next LLC", "HSBC Holdings plc", "Seika Daiya Engine Co., Ltd". A brand's
 * own "& Co." stays ("Slauson & Co."), and so do the two-letter forms a brand can be ("Investor AB").
 */
const LEGAL_FORM =
  /,?\s+(?:Inc\.?|Incorporated|L\.?L\.?C\.?|L\.?L\.?P\.?|L\.?P\.?|Ltd\.?|Limited|Corp\.?|Corporation|PLC|[Pp]lc|GmbH|S\.A\.|N\.V\.|B\.V\.|(?:Co\.,?\s*|Pte\.?\s*|Pty\.?\s*)Ltd\.?)$/;
/** An owner's investing unit named without the possessive: "Relativity investment arm Rel Labs". */
const OWNER_ARM = /^\S.*?\s(?:venture|investment|investing|corporate venture|strategic investment)\s(?:arm|unit|vehicle)\s+([A-Z0-9].*)$/;
/** An honorific before a person's name, and whatever described them before it: "orthopaedic surgeon Dr Michael Solomon". */
const HONORIFIC_PERSON = /^(?:.*?\s)?(?:Dr|Prof|Professor|Mr|Mrs|Ms)\.?\s+(\S+(?:\s+\S+){1,2})$/;

/**
 * The display-only cleanup every stored name gets before the rules read it: trademark signs, an
 * exchange ticker, trailing legal forms, and an honorific with the description before it. None of
 * it names a different investor, so the key rarely moves; the page stops showing "(NYSE: LLY)".
 */
function displayHygiene(name: string): string {
  let s = name.replace(TRADEMARK, "").replace(TICKER, "").replace(/\s+/g, " ").trim();
  for (;;) {
    const form = LEGAL_FORM.exec(s)?.[0] ?? "";
    const next = s.slice(0, s.length - form.length).trim();
    // The form stays where it is the only thing saying this is a company: "Fred Olsen Ltd" is not a
    // person, and a spelled-out form after one word ("Realty Corporation") is part of the name.
    const spelled = /Corporation|Limited|Incorporated/.test(form);
    if (!form || !next || isLikelyPerson(next) || (spelled && !/\s/.test(next))) break;
    s = next;
  }
  // "Relativity investment arm Rel Labs" is Rel Labs, as "Relativity's investment arm Rel Labs" is.
  const arm = OWNER_ARM.exec(s)?.[1];
  if (arm) s = arm;
  // Only a person's name after the honorific: "Dr. Reddy's Laboratories" is a company.
  const person = HONORIFIC_PERSON.exec(s)?.[1];
  if (person && isLikelyPerson(person)) s = person;
  return s;
}

/**
 * Apply the investor rules to one round's lists against its evidence. Order in each output
 * list follows the input; a firm named in both lists is a lead only.
 */
export function cleanInvestors(input: InvestorInput): InvestorOutput {
  const evidence = input.evidence ?? "";
  const folded = fold(evidence);
  const sentences = sentenceSpans(evidence);
  const dropped: string[] = [];

  // The two lists as one ordered list of entries, leads first.
  let entries: Entry[] = [];
  let order = 0;
  for (const [role, list] of [
    ["lead", input.lead_investors],
    ["other", input.other_investors],
  ] as const) {
    for (const raw of list ?? []) {
      const name = tidy(raw ?? "");
      if (!name) {
        if (raw) dropped.push(raw);
        continue;
      }
      entries.push({ original: raw, name, role, order: order++, found: { index: -1, strength: 0 } });
    }
  }
  const locateAll = () => {
    for (const e of entries) e.found = locate(folded, e.name);
  };
  locateAll();

  // Rule 5: names inside a debt clause are lenders.
  const debt = debtSpans(evidence, input.amount_as_written);
  if (debt.length) {
    entries = entries.filter((e) => {
      const inDebt = e.found.index >= 0 && debt.some(([s, x]) => e.found.index >= s && e.found.index < x);
      if (inDebt) dropped.push(e.original);
      return !inDebt;
    });
  }

  // Rule 2: placeholders, descriptions, and the names an affiliation phrase lists.
  const affiliationSpans: Array<[number, number]> = [];
  entries = entries.flatMap((entry) => {
    // "Acme Fund I, managed by Manager Co., Ltd.": the fund is the name, the manager a qualifier.
    const unqualified = tidy(entry.name.replace(QUALIFIER_TAIL, ""));
    const e = unqualified && unqualified !== entry.name ? { ...entry, name: unqualified, found: locate(folded, unqualified) } : entry;
    const name = e.name;
    if (name.length > MAX_NAME_LENGTH || VERB_PHRASE.test(name)) {
      if (AFFILIATION.test(name) && e.found.strength === 2) affiliationSpans.push([e.found.index, sentenceAt(sentences, e.found.index)[1]]);
      // "..., including Acme co-founder Jane Doe": a firm after "including" may survive as a participant.
      const tail = /\bincluding\s+(.+)$/i.exec(name)?.[1]?.trim();
      if (tail && tail.length <= MAX_NAME_LENGTH && !VERB_PHRASE.test(tail) && !EXEC_ROLE.test(tail) && !isPlaceholderInvestor(tail)) {
        return [{ ...e, name: tidy(tail), role: "other" as const, found: locate(folded, tail) }];
      }
      dropped.push(e.original);
      return [];
    }
    // The rest of the per-name hygiene needs no evidence and is shared with every list that
    // never passed through here (a verdict's, a fill's): normalizeInvestorName.
    const normalized = normalizeInvestorName(name);
    if (normalized === null) {
      dropped.push(e.original);
      return [];
    }
    return [{ ...e, name: normalized }];
  });
  if (affiliationSpans.length) {
    entries = entries.filter((e) => {
      const inside = e.found.index >= 0 && affiliationSpans.some(([s, x]) => e.found.index > s && e.found.index < x);
      if (inside) dropped.push(e.original);
      return !inside;
    });
  }

  // Rule 3: a person of a firm is the firm; a person named by their role elsewhere is dropped
  // unless the evidence lists them plainly.
  entries = entries.flatMap((e) => {
    // "Jane Doe, formerly of Acme" is the person, investing as themselves: the tail names a
    // prior firm, not who invests now.
    const former = FORMER_TAIL.exec(e.name);
    if (former) {
      const person = tidy(e.name.slice(0, former.index));
      if (isPersonShaped(person)) return [{ ...e, name: person }];
    }
    const firm = firmOfPerson(e.name);
    if (firm) return [{ ...e, name: tidy(firm) }];
    if (EXEC_ROLE.test(e.name)) {
      // "Founders Fund" carries a role word and no person: it is a firm and stays.
      const person = bareName(e.name);
      if (!person) return [{ ...e, name: head(e.name) || e.name }];
      const at = findTokens(folded, tokens(person));
      const before = at >= 0 ? evidence.slice(Math.max(0, at - 40), at) : "";
      if (at >= 0 && !EXEC_ROLE.test(before)) return [{ ...e, name: person }];
      dropped.push(e.original);
      return [];
    }
    return [e];
  });
  locateAll();

  // Rule 7: the company a founder or executive is named for, a manager, a parent, a vehicle.
  // Rule 8: a name inside a prior-round, investor-base, partner, or customer clause.
  const outside = nonInvestorSpans(evidence);
  entries = entries.filter((e) => {
    if (e.found.strength < 2) return true;
    const nameLength = head(e.name).length;
    const affiliated = isAffiliationAt(evidence, sentences, e.found.index, nameLength);
    const prior = outside.some(([s, x]) => e.found.index >= s && e.found.index < x);
    if (affiliated || prior) dropped.push(e.original);
    return !affiliated && !prior;
  });

  // Rule 1, first pass: what the evidence says about each surviving entry.
  const markers = markersOf(evidence);
  const attributions = new Map<Entry, Attribution>();
  for (const e of entries) {
    attributions.set(e, e.found.index >= 0 ? attribute(evidence, sentences, markers, e.found.index, head(e.name).length) : "unattributed");
  }

  // Rules 4 and 6: one firm, one entry.
  const groups: Entry[][] = [];
  const keyOf = (e: Entry) => investorKeyForMerge(e.name);
  // The typo key keeps every word: `normalizeCompanyKey` would read "AG" as a corporate suffix and drop it.
  const fullKey = (e: Entry) => tokens(head(e.name)).join(" ");
  const sameFirm = (a: Entry, b: Entry): boolean => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    const fa = fullKey(a);
    const fb = fullKey(b);
    if (sameSpelling(ka, fa, kb, fb)) return true;
    // Rule 6: one edit apart (a dropped letter), or a truncation (a clipped tail), and exactly one
    // spelling in the evidence.
    if (ka && kb && fa.length >= MIN_TYPO_KEY_LENGTH && fb.length >= MIN_TYPO_KEY_LENGTH) {
      const distance = levenshtein(fa, fb);
      const truncation = fa.startsWith(fb) || fb.startsWith(fa);
      if (distance === 1 || (distance === 2 && truncation)) return (a.found.strength === 2) !== (b.found.strength === 2);
    }
    return false;
  };
  for (const e of entries) {
    const g = groups.find((members) => members.some((m) => sameFirm(m, e)));
    if (g) g.push(e);
    else groups.push([e]);
  }

  const noLeadLanguage = !hasLeadLanguage(evidence);
  const silent = noLeadLanguage && !hasParticipantLanguage(evidence) && entries.every((e) => e.found.index < 0);

  interface Merged {
    name: string;
    order: number;
    extractorLead: boolean;
    attribution: Attribution;
    /** Whether the evidence sentence mentions the firm at all. */
    inEvidence: boolean;
    /** The input spelling the name came from. */
    original: string;
  }
  // A name written out ("Andreessen Horowitz") outranks its short form ("a16z"), whichever the evidence used.
  const canonical = (e: Entry) => (Object.values(INVESTOR_ALIASES).some((full) => normalizeInvestorKey(e.name).includes(full)) ? 1 : 0);
  let merged: Merged[] = groups.map((members) => {
    // The canonical form, then the spelling in the evidence, then the longer one (the fuller form of a
    // firm), then the entry that arrived as-is over one rewritten from a person ("Acme" over "Jane Doe of Acme").
    const asIs = (e: Entry) => (e.name === tidy(e.original) ? 1 : 0);
    const best = [...members].sort(
      (a, b) =>
        canonical(b) - canonical(a) ||
        b.found.strength - a.found.strength ||
        b.name.length - a.name.length ||
        asIs(b) - asIs(a) ||
        a.order - b.order,
    )[0];
    if (!best) throw new Error("empty investor group");
    for (const m of members) if (m !== best) dropped.push(m.original);
    const attrs = members.map((m) => attributions.get(m) ?? "unattributed");
    const attribution: Attribution = attrs.includes("lead") ? "lead" : attrs.includes("participant") ? "participant" : "unattributed";
    return {
      name: best.name,
      order: Math.min(...members.map((m) => m.order)),
      extractorLead: members.some((m) => m.role === "lead"),
      attribution,
      inEvidence: members.some((m) => m.found.index >= 0),
      original: best.original,
    };
  });
  merged.sort((a, b) => a.order - b.order);

  // Rule 9: a lead of another round, a participant only where the evidence puts it in this one. A name
  // no marker places is checked too: the extractor's lead it would keep may be another round's.
  const round = input.round;
  if (round) {
    merged = merged.filter((m) => {
      if (m.attribution === "participant" || !leadOfAnotherRound(evidence, m.name, round)) return true;
      if (investedInRound(evidence, m.name)) {
        m.attribution = "participant";
        return true;
      }
      dropped.push(m.original);
      return false;
    });
  }

  // Rule 1, second pass: leads.
  const leads = new Set<Merged>();
  if (silent) {
    // The evidence never speaks of investors: the extractor's word stands, capped.
    for (const m of merged) if (m.extractorLead && leads.size < MAX_UNATTRIBUTED_LEADS) leads.add(m);
  } else if (!noLeadLanguage) {
    for (const m of merged) if (m.attribution === "lead") leads.add(m);
    for (const m of merged) {
      if (m.attribution === "unattributed" && m.extractorLead && leads.size < MAX_UNATTRIBUTED_LEADS) leads.add(m);
    }
  }

  // Rule 10: the round's one named investor, when the evidence states the money as coming from it alone.
  const only = merged.length === 1 ? merged[0] : undefined;
  if (only && leads.size === 0 && soleInvestor(only.name, [evidence], input.amount_as_written ?? null)) leads.add(only);

  return {
    lead_investors: merged.filter((m) => leads.has(m)).map((m) => m.name),
    other_investors: merged.filter((m) => !leads.has(m)).map((m) => m.name),
    dropped,
  };
}

/**
 * A test of whether a text names an investor: the name's head ("Lip-Bu Tan"), or its identity key
 * ("Qualcomm" for "Qualcomm Ventures", "Andreessen Horowitz" for "a16z"), as whole words
 * of the folded text. The text folds once, so one page can be asked about every record name. The
 * reconcile step asks it of the pages it read: a record investor those pages name, and the verdict
 * still leaves out of this round, was seen and not placed in it.
 */
export function investorMentions(text: string): (name: string) => boolean {
  const hay = ` ${tokens(text).join(" ")} `;
  return (name) => {
    const forms = [tokens(head(name)).join(" "), tokens(normalizeInvestorKey(name)).join(" "), tokens(investorKeyForMerge(name)).join(" ")];
    return forms.some((f) => f.length > 1 && hay.includes(` ${f} `));
  };
}

/**
 * One firm, one entry, for a list assembled from several sources: names that key the same after
 * alias expansion, a region or fund extension of another name, and one-edit spellings collapse into
 * the fullest form, in first-seen order. The within-record rules in cleanInvestors apply this too.
 */
export function dedupeInvestorNames(names: string[]): string[] {
  const kept: Array<{ name: string; key: string; full: string }> = [];
  for (const raw of names) {
    const name = raw.trim();
    // A placeholder is not a firm, whichever list carried it in.
    if (isPlaceholderInvestor(name)) continue;
    // A leading article is not part of the firm: "The Acme Group" and "Acme" are one.
    const key = investorKeyForMerge(name).replace(/^the /, "");
    const full = tokens(head(name)).join(" ");
    if (!key) continue;
    const i = kept.findIndex(
      (k) =>
        sameSpelling(k.key, k.full, key, full) ||
        (Math.min(k.key.length, key.length) >= MIN_TYPO_KEY_LENGTH && levenshtein(k.key, key) === 1),
    );
    if (i === -1) kept.push({ name, key, full });
    else if (cleaner(key, name, kept[i].key, kept[i].name)) {
      const longerKey = key.length >= kept[i].key.length;
      kept[i] = { name, key: longerKey ? key : kept[i].key, full: longerKey ? full : kept[i].full };
    }
  }
  return kept.map((k) => k.name);
}
