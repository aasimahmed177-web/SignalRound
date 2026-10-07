// Whether a round's valuation was disclosed. A null valuation means two different things: the
// sources never mention one (unknown), or they say outright that it was not disclosed. The second
// is a fact a reader can use ("Firecrawl did not disclose its valuation"), so it is kept as
// `valuation_disclosed: false`; a stated valuation is `true`; anything else stays null.

import { namesCompany, titleNamesCompany } from "@fireround/core";

/** A sentence that says the valuation was withheld: "did not disclose its valuation", "at an undisclosed valuation". */
const UNDISCLOSED = [
  /\b(?:did\s+not|didn['\u2019]t|does\s+not|doesn['\u2019]t|declined\s+to|would\s+not|wouldn['\u2019]t|has\s+not|hasn['\u2019]t|chose\s+not\s+to|not\s+to)\s+(?:publicly\s+)?(?:disclose|reveal|share|comment\s+on|specify|release|announce)\s+(?:its|the|their|his|her|a|any)?\s*(?:new\s+|latest\s+|current\s+|post-money\s+|pre-money\s+|company['\u2019]s\s+)?valuation/i,
  /\bundisclosed\s+(?:post-money\s+|pre-money\s+)?valuation/i,
  /\bvaluation\s+(?:was|is|has\s+not\s+been|had\s+not\s+been|remains|wasn['\u2019]t|isn['\u2019]t)\s+(?:not\s+)?(?:disclosed|undisclosed|revealed|made\s+public|public)\b/i,
  /\bvaluation\s+(?:was\s+|is\s+)?not\s+(?:disclosed|revealed|made\s+public)\b/i,
  /\bwithout\s+disclosing\s+(?:its|the|a)?\s*valuation/i,
];
/** A negation the "was … disclosed" shape needs; "the valuation was disclosed at $1B" is a disclosure. */
const NEGATED = /\b(?:not|undisclosed|declined|without)\b|n['\u2019]t\b/i;

/** The sentences of a text, split on terminal punctuation and line breaks. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 0);
}

/** A page whose title is about several deals: its withholding sentences may be about any of them. */
const ROUNDUP_TITLE = /\b(?:round-?up|weekly|daily|digest|funding report|deals? of the|this week|newsletter|wrap)\b/i;

/** The withholding sentence in a text about this company, or null. */
export function undisclosedSentence(text: string, companyName: string, title?: string | null): string | null {
  const list = sentences(text);
  // A page about this one round ("Firecrawl raises $75M ..."): "The round's valuation was not disclosed" is about it.
  const aboutRound = Boolean(title) && titleNamesCompany(title, companyName) && !ROUNDUP_TITLE.test(title ?? "");
  const found = list.find((sentence, i) => {
    if (!UNDISCLOSED.some((re) => re.test(sentence)) || !NEGATED.test(sentence)) return false;
    return aboutRound || namesCompany(sentence, companyName) || (i > 0 && namesCompany(list[i - 1] ?? "", companyName));
  });
  return found?.trim() ?? null;
}

/** Whether the text says this company's valuation was not disclosed (a roundup's other deals never count). */
export function statesValuationUndisclosed(text: string, companyName: string, title?: string | null): boolean {
  return undisclosedSentence(text, companyName, title) !== null;
}

/** The stored answer: true when a valuation is stated, false when a text says it was withheld, null otherwise. */
export function valuationDisclosed(
  valuationAsWritten: string | null,
  texts: readonly (string | { text: string; title?: string | null })[],
  companyName: string,
): boolean | null {
  if (valuationAsWritten) return true;
  return texts.some((t) =>
    typeof t === "string" ? statesValuationUndisclosed(t, companyName) : statesValuationUndisclosed(t.text, companyName, t.title),
  )
    ? false
    : null;
}
