export const ROUND_CERTAINTIES = ["announced", "reported", "expected", "unconfirmed"] as const;
export type RoundCertainty = (typeof ROUND_CERTAINTIES)[number];
export const ROUND_CERTAINTY_RANK: Record<RoundCertainty, number> = { unconfirmed: 0, expected: 1, reported: 2, announced: 3 };

const EXPECTED =
  /\b(?:in (?:advanced |early |late[- ]stage |exclusive |final )?(?:talks|discussions|negotiations)|(?:is|are|was|were)\s+(?:reportedly\s+)?raising|in (?:the )?process of raising|looking to raise|seeks? to raise|seeking to raise|seeks? (?:up to |about |around |roughly |some )?[$€£¥₹₩]|seeking (?:up to |about |around |roughly |some )?[$€£¥₹₩]|plans? to raise|planning to raise|preparing to raise|aims? to raise|aiming to raise|hopes? to raise|hoping to raise|(?:could|may|might) raise (?:up to |about |around |roughly |some )?[$€£¥₹₩]\d+|(?:could|may|might) raise (?:funding|capital|a round)|set to raise|poised to raise|expected to raise|close to (?:closing|raising|finalizing|finalising)|closing in on|nearing|yet to close|has not (?:yet )?closed|(?:weigh|consider)(?:s|ing|ed)? (?:joining|investing|backing|leading|participating|an? (?:investment|stake))|(?:is|are) closing (?:a|an|its|the)\b|about to (?:complete|close|raise|finali[sz]e)|term sheet|rumou?red to (?:raise|be raising))\b/i;
const RAISING_HEADLINE =
  /^(?:scoop:\s*|exclusive:\s*|report:\s*)?(?!after\b|how\b)(?:[\w.&'\u2019\u2013-]+\s+){1,5}raising\s+(?:up to |about |around |roughly |over |nearly |some |a |an )?(?:[$€£¥₹₩]\s?\d|\d+(?:\.\d+)?\s?(?:m|mn|million|b|bn|billion)\b)/i;
const REPORTED =
  /\b(?:reportedly\s+(?:has\s+|had\s+)?(?:raised|secured|closed)|(?:has|have|had)\s+reportedly\s+(?:raised|secured|closed)|rumou?red to have (?:raised|secured|closed)|is said to (?:have (?:raised|secured|closed)|be .{0,100}?already closed)|(?:sources?|people|persons) (?:familiar with|with knowledge of|say|said)|according to (?:unnamed |anonymous )?(?:sources|people|persons)|citing (?:unnamed |anonymous )?(?:sources|people|persons))\b/i;
const CLOSED = /\b(?:raises|raised|secured|closed|completed|announced|has (?:gotten|secured)|already secured)\b/i;

export function assertedRoundCertainty(text: string | null | undefined): RoundCertainty | null {
  if (!text) return null;
  if (EXPECTED.test(text) || RAISING_HEADLINE.test(text.trim())) return "expected";
  if (REPORTED.test(text)) return "reported";
  if (CLOSED.test(text)) return "announced";
  return null;
}

/** The sentence wins over a model reading: a closing still in progress is never announced. */
export function classifyRoundCertainty(
  evidence: string | null | undefined,
  label?: string | null,
  extracted?: RoundCertainty | null,
  checked?: RoundCertainty | null,
  legacyRumor = false,
): RoundCertainty {
  const text = [evidence, label].filter(Boolean).join(". ");
  const asserted = assertedRoundCertainty(text);
  if (asserted) return asserted;
  if (checked && checked !== "unconfirmed") return checked;
  if (extracted && extracted !== "unconfirmed") return extracted;
  return legacyRumor ? "expected" : "announced";
}
