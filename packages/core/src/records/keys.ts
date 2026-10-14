// Identity keys for company and investor names. Their own module with no imports, so client
// components (a link to an investor by name) can build a key without pulling normalize.ts's date
// parser and public-suffix list, or the Zod schema, into the browser bundle. normalize.ts
// re-exports both, so every other caller reads them from where they always have.

/** A corporate or generic suffix at the end of an already-lowercased, punctuation-free name, with the word before it. */
const CORPORATE_SUFFIX_TAIL =
  /\s(inc|llc|ltd|limited|corp|corporation|co|gmbh|ag|sas|sa|bv|plc|pte|pty|oy|ab|srl|technologies|technology|labs|ai)$/;

/**
 * The legal forms alone, for investors: "Sovereign AI" is not "Sovereign" (another firm keys there),
 * and a fund's "Labs" or "Technologies" is part of which fund it is.
 */
const LEGAL_SUFFIX_TAIL = /\s(inc|llc|ltd|limited|corp|corporation|co|gmbh|ag|sas|sa|bv|plc|pte|pty|oy|ab|srl)$/;

/**
 * Han, kana and Hangul, with the katakana long-vowel mark: a name written in them ("零一万物", "무신사")
 * has no ASCII letters to fold to, so a company key keeps them rather than keying to nothing. A run of
 * them is a word of its own, so a Latin name inside Chinese text ("企业MiniMax已完成") stays a word.
 */
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30fc]+/gu;
const CJK_KEY_CHARS = /[^a-z0-9\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30fc]/gu;
const ASCII_KEY_CHARS = /[^a-z0-9\s]/g;

function foldKey(name: string, tail: RegExp, strip: RegExp = ASCII_KEY_CHARS): string {
  let key = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(strip, " ")
    .replace(CJK_RUN, " $& ")
    .replace(/\s+/g, " ")
    .trim();
  // Suffixes come off the tail one at a time while a word remains before them: "Acme Labs Inc" is
  // "acme", and "Labs Companies, Inc." keeps its first word instead of becoming "companies".
  for (;;) {
    const next = key.replace(tail, "");
    if (next === key) break;
    key = next;
  }
  return key;
}

/** Canonical key for a company name: lowercase, ASCII or CJK letters and digits, suffixes and punctuation removed. */
export function normalizeCompanyKey(name: string): string {
  return foldKey(name, CORPORATE_SUFFIX_TAIL, CJK_KEY_CHARS);
}

/**
 * A legal form ending a company name as written: "Kalshi Inc.", "Upgrade, Inc.", "Dialybrid S.r.l.",
 * "Precision Neuroscience Corporation". "Sober & Co" is a brand.
 */
const LEGAL_FORM =
  /(?<!&)[\s,]+(inc|llc|ltd|limited|corp|corporation|co|gmbh|ag|sas|s\.?a|s\.?p\.?a|b\.?v|plc|pte|pty|oy|ab|s\.?r\.?l|aps|kk)\.?$/i;

/**
 * The name to show when a company is read again. Two names that share a key once their legal forms are
 * off, where only one carries a legal form, are the brand and its legal name: the brand stays ("Kalshi"
 * over "Kalshi Inc.", "ICON" over "Icon Technology Inc."), whichever came first. Otherwise the longer
 * name, the fuller reading.
 */
export function preferredCompanyName(stored: string, incoming: string): string {
  const legalStored = LEGAL_FORM.test(stored);
  const legalIncoming = LEGAL_FORM.test(incoming);
  const brandKey = (name: string) => normalizeCompanyKey(name.replace(LEGAL_FORM, ""));
  if (legalStored !== legalIncoming && brandKey(stored) === brandKey(incoming)) return legalStored ? incoming : stored;
  return incoming.length > stored.length ? incoming : stored;
}

/**
 * Vehicle nouns only, so the key keeps a region and a strategy: "sequoia capital china" and
 * "andreessen horowitz crypto" are their own investor pages and their own rows. `CORE_NOISE` in
 * investors.ts strips those words too, because a dedupe pass wants "Brand" and "Brand Asia" to meet
 * while an identity key wants them apart; the two lists overlap on purpose and cannot share a source.
 */
const INVESTOR_GENERIC_TAIL =
  /\s+(holdings?|ventures?|venture\s+partners|venture\s+capital|capital|partners|management|group|fund|investments?|vc|lp|llp|llc|accelerator|program|programme)$/;

/**
 * Investing arms named as their parent plus a vehicle word or a strategy, where the parent invests on its own. Each is
 * its own investor, as NVentures is not NVIDIA: the tail stays on ("Bain Capital Ventures" is not Bain Capital, "Google
 * Ventures" is GV and not Google), and the one-firm rules in investors.ts never fold an arm into its parent or a
 * sibling ("Bain Capital Crypto"). A firm whose bare name another firm holds is listed the same way: Fuel Ventures in
 * London and Fuel Venture Capital in Miami are not Fuel Capital in San Francisco. An arm publishers name either way stays keyed as its parent ("Qualcomm Ventures" is
 * Qualcomm, "Point72 Ventures" is Point72).
 */
export const INVESTOR_ARMS = new Set([
  "bain capital ventures",
  "bain capital crypto",
  "bain capital life sciences",
  "google ventures",
  "google capital",
  "microsoft venture",
  "microsoft ventures",
  "fuel ventures",
  "fuel venture capital",
]);

/**
 * Identity key for an investor name. Publishers write the same firm several ways
 * ("Arm" and "Arm Holdings", "M12" and "M12 – Microsoft's Venture Fund"): the
 * descriptor after a spaced dash, colon, or parenthesis is dropped, then generic
 * tail words come off one at a time while a name remains. "Sequoia Capital China"
 * keeps its "china" and stays distinct from "Sequoia Capital".
 */
export function normalizeInvestorKey(name: string): string {
  // A possessive is not a word ("a16z's Speedrun" keyed as "a16z s speedrun"), and "& Co." is a legal
  // tail like "Inc." ("Wells Fargo & Co" keyed as "wells fargo and").
  const head = (name.split(/\s+[\u2013\u2014-]\s+|\s*[:(]\s*/)[0] ?? name)
    .replace(/['\u2019]s\b/gi, "")
    .replace(/\s*(?:&|\band)\s*(?:co|company)\.?\s*$/i, "")
    .replace(/^\s*([a-z0-9])\s*\\?\*/i, "$1 star");
  let key = foldKey(head, LEGAL_SUFFIX_TAIL);
  for (;;) {
    if (/^plus (?:partners|capital)$/.test(key) || INVESTOR_ARMS.has(key)) return key;
    const next = key.replace(INVESTOR_GENERIC_TAIL, "");
    // One letter is no name: "A.Capital", "B Capital" and "e.ventures" are three firms, not "a", "b" and "e".
    if (next === key || next.length < 2) break;
    key = next;
  }
  return key;
}

/** Short forms publishers use for a firm, expanded inside the merge key only. */
export const INVESTOR_ALIASES: Record<string, string> = {
  a16z: "andreessen horowitz",
  gv: "google ventures",
  gsk: "glaxosmithkline",
  cpp: "canada pension plan",
  nea: "new enterprise associates",
  ivp: "institutional venture partners",
  lsvp: "lightspeed venture partners",
};

/** Misspellings of a firm that sources have printed, keyed as the firm ("Sequioa Capital" on a Chai Discovery listing). */
const MISSPELLED: Record<string, string> = { sequioa: "sequoia" };

/**
 * One firm or program under two names, as a whole key: a16z's crypto accelerator (CSX) became
 * speedrun; "YC" alone is Y Combinator; Sequoia's Indian and Chinese arms are printed with and without "Capital"; a firm's
 * short form or old name ("DST", "USV", "IVP" spelled out, "KPCB") is the firm; T. Rowe Price's adviser, "T. Rowe Price
 * Associates", is how releases name T. Rowe Price; "Founder's Fund" is a printed misspelling of Founders Fund; NVentures
 * printed with its parent's name is NVentures; SoftBank's first Vision Fund numbered is the Vision Fund; a firm's
 * operating or legal entity ("Sequoia Capital Operations", "Wellington Management Company", "BoxGroup Services") is the
 * firm; a person printed with a title ("Kleiner Perkins Chairman John Doerr") is the person; an arm under its old or
 * legal name is the arm ("Google Capital" is CapitalG, "Microsoft's Venture Fund" is M12); CPP Investments, "Canada Pension
 * Plan" and "CPPIB" are the Canada Pension Plan Investment Board; a firm's name printed split or joined ("SVAngel", "Signal
 * Fire", "Prosperity 7"), its spelled-out old name ("Charles River Ventures", "Technology Crossover Ventures", "Data Collective")
 * or its short form ("QIA", "JP Morgan", "The Invus Group") is the firm.
 */
const RENAMED: Record<string, string> = {
  "andreessen horowitz csx": "andreessen horowitz speedrun",
  yc: "y combinator",
  ycombinator: "y combinator",
  "yc continuity": "y combinator continuity",
  "sequoia india": "sequoia capital india",
  "sequoia china": "sequoia capital china",
  "sequoia global equities": "sequoia capital global equities",
  dst: "dst global",
  institutional: "institutional venture partners",
  usv: "union square",
  peakxv: "peak xv",
  kpcb: "kleiner perkins",
  "kleiner perkins caufield and byers": "kleiner perkins",
  "kleiner perkins caufield byers": "kleiner perkins",
  "t rowe price associates": "t rowe price",
  founder: "founders",
  "nvidia nventures": "nventures",
  "softbank vision fund 1": "softbank vision",
  "sequoia capital operations": "sequoia",
  "wellington management company": "wellington",
  "fidelity management and research": "fidelity management and research company",
  "boxgroup services": "boxgroup",
  "nexus vp": "nexus",
  "kleiner perkins chairman john doerr": "john doerr",
  "google capital": "capitalg",
  "microsoft venture": "m12",
  "microsoft ventures": "m12",
  "canada pension plan": "canada pension plan investment board",
  cppib: "canada pension plan investment board",
  svangel: "sv angel",
  "black rock": "blackrock",
  "charles river": "crv",
  "technology crossover": "tcv",
  qia: "qatar investment authority",
  "data collective": "dcvc",
  "peakx v": "peak xv",
  "jp morgan": "j p morgan",
  gsquared: "g squared",
  "the invus": "invus",
  "signal fire": "signalfire",
  "prosperity 7": "prosperity7",
  "next view": "nextview",
};

/** `normalizeInvestorKey` with known short forms expanded and known misspellings corrected: "a16z crypto" keys as "andreessen horowitz crypto". */
export function investorKeyForMerge(name: string): string {
  const key = normalizeInvestorKey(name)
    .split(" ")
    .map((t) => INVESTOR_ALIASES[t] ?? MISSPELLED[t] ?? t)
    .join(" ")
    .trim();
  return RENAMED[key] ?? key;
}
