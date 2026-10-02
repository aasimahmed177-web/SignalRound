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

function foldKey(name: string, tail: RegExp): string {
  let key = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
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

/** Canonical key for a company name: lowercase, ASCII, suffixes and punctuation removed. */
export function normalizeCompanyKey(name: string): string {
  return foldKey(name, CORPORATE_SUFFIX_TAIL);
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
    .replace(/\s*(?:&|\band)\s*(?:co|company)\.?\s*$/i, "");
  let key = foldKey(head, LEGAL_SUFFIX_TAIL);
  for (;;) {
    if (/^plus (?:partners|capital)$/.test(key)) return key;
    const next = key.replace(INVESTOR_GENERIC_TAIL, "");
    if (next === key || !next) break;
    key = next;
  }
  return key;
}
