export const ROUND_CERTAINTIES = ["announced", "reported", "expected", "unconfirmed"] as const;
export type RoundCertainty = (typeof ROUND_CERTAINTIES)[number];
export const ROUND_CERTAINTY_RANK: Record<RoundCertainty, number> = { unconfirmed: 0, expected: 1, reported: 2, announced: 3 };

const EXPECTED =
  /\b(?:in (?:advanced |early |late[- ]stage |exclusive |final )?(?:talks|discussions|negotiations)|(?:is|are|was|were)\s+(?:reportedly\s+)?raising|in (?:the )?process of raising|looking to raise|seeks? to raise|seeking to raise|seeks? (?:up to |about |around |roughly |some )?[$€£¥₹₩]|seeking (?:up to |about |around |roughly |some )?[$€£¥₹₩]|plans? to raise|planning to raise|preparing to raise|aims? to raise|aiming to raise|hopes? to raise|hoping to raise|(?:could|may|might) raise (?:up to |about |around |roughly |some )?[$€£¥₹₩]\d+|(?:could|may|might) raise (?:funding|capital|a round)|set to raise|poised to raise|expected to raise|close to (?:closing|raising|finalizing|finalising)|closing in on|nearing|yet to close|has not (?:yet )?closed|(?:weigh|consider)(?:s|ing|ed)? (?:joining|investing|backing|leading|participating|an? (?:investment|stake))|consider(?:s|ing|ed)? (?:expanding|doubling|increasing|upsizing|enlarging|extending|raising)|close to (?:securing|completing)|will (?:complete|close|finali[sz]e) [^.]{0,80}?\b(?:shortly|soon)|(?:is|are) closing (?:a|an|its|the)\b|about to (?:complete|close|raise|finali[sz]e)|term sheet|rumou?red to (?:raise|be raising)|en (?:discussions?|n[ée]gociations?)|cherche [àa] lever|s'appr[êe]te [àa] lever|pr[ée]voit de lever|en train de lever)\b|接近完成|即将完成|洽谈|正在融资|寻求融资|拟融资|調達を目指|交渉中|투자 유치를 추진|협상 중/i;
/** A raise the company opened, not one it closed: "has now launched a further $10 million funding round". */
const OPENED =
  /\b(?:(?:launch|open|kick)(?:es|s|ed|ing)?(?: off)?|launch of) (?:a|an|its|the) (?:further |new |second |fresh |next )?(?:(?:[$€£¥₹₩]|a\$|au\$|us\$|nz\$)\s?\d[\d.,]*\s?(?:k|m|mn|million|bn|billion)?\s+)?(?:funding|fundraising|investment|capital|equity|crowdfunding|seed|series [a-z])(?: financing| funding| investment)? ?(?:round|raise|campaign)/i;
const RAISING_HEADLINE =
  /^(?:scoop:\s*|exclusive:\s*|report:\s*)?(?!after\b|how\b)(?:[\w.&'\u2019\u2013-]+\s+){1,5}(?<!\b(?:announc|complet|confirm)(?:ed|es|s)\s+)raising\s+(?:up to |about |around |roughly |over |nearly |some |a |an )?(?:[$€£¥₹₩]\s?\d|\d+(?:\.\d+)?\s?(?:m|mn|million|b|bn|billion)\b)/i;
const REPORTED =
  /\b(?:reportedly\s+(?:has\s+|had\s+)?(?:raised|secured|closed)|(?:has|have|had)\s+reportedly\s+(?:raised|secured|closed)|rumou?red to have (?:raised|secured|closed)|is said to (?:have (?:raised|secured|closed)|be .{0,100}?already closed)|(?:sources?|people|persons) (?:familiar with|with knowledge of|say|said)|according to (?:unnamed |anonymous )?(?:sources|people|persons)|citing (?:unnamed |anonymous )?(?:sources|people|persons)|selon (?:nos |des |plusieurs )?(?:informations|sources)|aurait lev[ée]|seg[uú]n fuentes)\b|消息称|知情人士|据悉|关系人士|関係者によると|관계자에 따르면|업계에 따르면/i;
const CLOSED = /\b(?:raises|raised|secured|closed|completed|announced|announces|has (?:gotten|secured)|already secured)\b/i;

export function assertedRoundCertainty(text: string | null | undefined): RoundCertainty | null {
  if (!text) return null;
  if (EXPECTED.test(text) || RAISING_HEADLINE.test(text.trim())) return "expected";
  // A sentence that also closes a round ("has closed a $3.2 million pre-seed round and is opening its Seed round") is that round's.
  if (OPENED.test(text) && !/\b(?:closed|completed|raised|secured)\b/i.test(text)) return "expected";
  if (REPORTED.test(text)) return "reported";
  if (CLOSED.test(text)) return "announced";
  return null;
}

/**
 * The sentence wins over a model reading: a closing still in progress is never announced. The cues
 * include the French, Chinese, Japanese and Korean for talks, a close in progress ("已接近完成"), and
 * unnamed sources ("消息称", "知情人士"), which a reader of those pages reports as announced.
 */
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
