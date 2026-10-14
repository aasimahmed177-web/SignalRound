// Which preset keeps a round. A lettered round belongs to the preset that lists its stage; a round
// whose label names no stage ("$75 million in financing", "a $117m fundraise") belongs to the preset
// whose amount band holds it. Many large rounds are announced with no stage at all, and a feed that
// keys only on the label drops them everywhere. Pure: every lane asks the same questions here.

import type { Stage } from "./stages.ts";

/** The three bands the shipped presets split the market into: seed and pre-seed, Series A and B, Series C and later. */
export type StageBand = "early" | "mid" | "late";

export const STAGE_BANDS: readonly StageBand[] = ["early", "mid", "late"];

/** The band each equity stage sits in; debt, grants, secondaries, and convertibles sit in none. */
export const BAND_OF_STAGE: Partial<Record<Stage, StageBand>> = {
  pre_seed: "early",
  seed: "early",
  bridge: "early",
  pre_a: "mid",
  series_a: "mid",
  series_b: "mid",
  series_c: "late",
  series_d_plus: "late",
  growth: "late",
};

/**
 * Where the bands meet, in USD millions: under 10 is early, 10 up to 80 is mid, 80 and more is late.
 * Measured on the store's lettered rounds announced since January 2025 (September 2026): a $10M cut
 * misfiles 65 of the seed and Series A/B rounds (52 seeds above it, 13 A/Bs below), fewer than at $8M
 * (77) or $12M (70); an $80M cut misfiles 98 of the A/B and C-and-later rounds, fewer than at $60M
 * (108), $75M (100), or $100M (104).
 */
export const BAND_CUTS_USD_MILLIONS = { early: 10, mid: 80 } as const;

/** The band an amount falls in. */
export function bandForAmount(usdMillions: number): StageBand {
  if (usdMillions < BAND_CUTS_USD_MILLIONS.early) return "early";
  if (usdMillions < BAND_CUTS_USD_MILLIONS.mid) return "mid";
  return "late";
}

/**
 * The bands a preset's stages cover: the seed preset covers early, a Series C preset late. A bridge
 * ("pre-Series A") is a labelled round between two bands, so listing it claims no band: the Series A
 * and B preset keeps pre-Series rounds without taking the seed preset's unlabelled $4M rounds.
 */
export function bandsOf(stages: readonly Stage[]): StageBand[] {
  const out = new Set<StageBand>();
  for (const s of stages) {
    if (s === "bridge" || s === "pre_a") continue;
    const b = BAND_OF_STAGE[s];
    if (b) out.add(b);
  }
  return STAGE_BANDS.filter((b) => out.has(b));
}

/** A label that names no stage: the classifier's `other` and `undisclosed`. */
export function isStageless(stage: Stage): boolean {
  return stage === "other" || stage === "undisclosed";
}

/** A Form D names a filing, not a round, and keeps its own lane's rules. */
export function isFormDLabel(label: string | null | undefined): boolean {
  return /\bform d\b/i.test(label ?? "");
}

/** Labels of money that is not a venture round: an offering by a listed company, a buyout, a fund. */
const NOT_A_ROUND_LABEL: Array<[RegExp, string]> = [
  [/\b(?:ipo|initial public offering|public offering|direct listing|listing|spac|de-?spac|reverse merger|pipe)\b/i, "public offering"],
  [/\b(?:private placement|brokered|non-brokered|bought deal|flow-through|offering|units?)\b/i, "securities offering"],
  [/\b(?:acquisition|acquired|merger|buy-?out|takeover|take-private|divestiture|spin-?off)\b/i, "acquisition"],
  [/\b(?:fund|fund close|vehicle|lp commitments?)\b/i, "fund close"],
  [/\b(?:grant|award|prize|subsidy|contract|equity-free|non-dilutive|donations?|philanthrop\w*)\b/i, "grant or contract"],
  // "add-on" and "tap" are how the credit market names more of an existing bond or loan (Stonepeak Nile
  // Parent LLC's "$125m add-on" to its secured notes led the landing page on September 24, 2026).
  [
    /\b(?:revenue-based|credit|debt|loan|notes?|bonds?|facility|lending|warehouse|securiti[sz]ation|receivables|refinanc\w*|add-?on|tap|high[- ]yield|term loan)\b/i,
    "debt",
  ],
  [/\b(?:recapitali[sz]ation|registered direct|at-the-market|warrants?)\b/i, "securities offering"],
  [/\b(?:collaboration|partnership|licen[sc](?:e|ing)|upfront|milestones?|royalt\w*|joint venture)\b/i, "partnership"],
  [/\b(?:capital (?:investment|expenditure|spending)|capex)\b/i, "capital spending"],
  [/\b(?:token sale|ico|airdrop|crowdfunding campaign)\b/i, "token sale"],
  // "a $500 million commitment to Project Vault", "book advances": money promised or paid for something else.
  [/\b(?:commitments?|pledges?|book advances?|book deals?|settlement)\b/i, "not a round"],
];

/**
 * What the round's sentence must do for a stageless reading: say that money came in. "Acme raised $20
 * million", "secures $450m financing", "led by Bain". A data point in an analysis ("It is followed by
 * Engitix ($25 million)", "Vinpearl's $255 million round was about three-quarters of that") names a
 * figure and no raise, and without a label to go on it is not read as one. Chinese, Japanese and Korean
 * write no spaces, so their words count anywhere ("完成新一轮融资", "資金調達を実施", "투자 유치"); Japanese
 * 融資 is a loan and is not one of them.
 */
const RAISE_STATED =
  /\b(?:rais(?:es|ed|ing)|secur(?:es|ed|ing)|clos(?:es|ed|ing)|land(?:s|ed)|bag(?:s|ged)|announc(?:es|ed|ing)|complet(?:es|ed)|receiv(?:es|ed)|obtain(?:s|ed)|pull(?:s|ed|ing) in|nets?|netted|garner(?:s|ed)|attract(?:s|ed)|nab(?:s|bed)|snag(?:s|ged)|scor(?:es|ed)|gets?|got|gotten|putting|puts?|emerg(?:es|ed|ing) from stealth|launch(?:es|ed|ing) with|led by|co-led|leads|leading|invest(?:s|ed|ing|ment)?|backed|injects?|fundraise|financing|funding)\b|\b(?:l[eè]ve|lev[ée]e|a lev[ée]|boucle|inject|r[ée]uni|tour de table|au capital|sammelt|erh[äa]lt|finanzierung\w*|investiert|recauda|levanta|ronda|financiaci[oó]n|inversi[oó]n|raccoglie|raccolt[aeio]|chiude|chiuso|finanziamento|investimento|capta|rodada|aporte)|融资|募资|领投|获投|投资|增资|資金調達|出資|増資|投資|투자|펀딩|조달/i;

/** Money raised for someone else, or by many at once: a charity drive, a cohort's combined total, a fund's deployed capital. */
const NOT_A_RAISE: Array<[RegExp, string]> = [
  [/\bfor (?:charity|charities|nonprofits?|non-profits?)\b|\bdonat(?:ed|ion|ions)\b|\bphilanthrop/i, "charity"],
  [
    /\b(?:collectively|cumulatively|in aggregate|combined (?:funding|capital)|portfolio companies|(?:student|alumni) (?:ventures|startups|founders)|startups (?:have |had )?(?:raised|secured)|founders (?:have |had )?raised|an average of)\b/i,
    "aggregate",
  ],
  [/\b(?:deployed|assets under management|aum)\b/i, "fund close"],
  // The lender's side of a loan: "IDB approves $400 million in financing", "JLL arranges $406M financing",
  // "Signet Bank provides EUR 4 million in financing", "received EUR 4 million in financing from Signet Bank".
  [
    /\b(?:approv(?:es|ed)|commit(?:s|ted)|extend(?:s|ed)|disburs(?:es|ed)|arrang(?:es|ed)|provid(?:es|ed))\s+(?:a\s+|an\s+|the\s+)?(?:funding\s+of\s+)?(?:up\s+to\s+)?(?:us)?(?:[$€£]|[a-z]{3}\s)?\s?[\d.,]+\s*(?:m|mn|million|b|bn|billion)?\s+(?:in\s+)?(?:financing|loans?|funding|credit)\b|\bapprov(?:es|ed) funding\b|\b(?:financing|loans?|credit)\s+(?:from|by|provided by)\s+(?:[\w&.'-]+\s+){0,3}bank\b/i,
    "debt",
  ],
  // The credit market's own words, which a startup's announcement never uses: a high-yield or
  // leveraged-loan desk's note on a new issue or an add-on ("priced 7.25% at 100", "notes due
  // 03/15/32", "joint bookrunners"). Debt beside equity in a release ("a $30 million term loan") is
  // amountIsDebt's, clause by clause.
  [/\b(?:high[- ]yield|leveraged loans?|new[- ]issue market|notes due|priced (?:at|to yield)|bookrunners?|cusip)\b/i, "debt"],
  [/\bfor (?:a |the |its )?(?:proposed )?acquisition of\b/i, "acquisition"],
  [/\brecapitali[sz]ation\b|\bgross (?:cash )?proceeds\b|\bnotes and warrants\b/i, "securities offering"],
  [
    /\b(?:real estate|mortgage|self[- ]storage|multifamily|apartments?|hotel|resort|industrial portfolio|office (?:tower|building)|distribution center|property portfolio|construction loan)\b/i,
    "property financing",
  ],
  // A public body as the sentence's subject: "the Trump Administration announced today that a $13 million investment".
  [
    /^\W*(?:[\w\u2019'.-]+\s+){0,4}(?:administration|government|ministry|department|agency|commission|council|county|municipality|governor|mayor|minister|senator)\b/i,
    "public funding",
  ],
];

/** What a headline alone can say about a stageless reading: the financing is a property's, or a lender's. */
const NOT_A_RAISE_TITLE = NOT_A_RAISE.filter(([, reason]) => reason === "property financing" || reason === "debt" || reason === "charity");

/**
 * A company named as a financing vehicle: a parent, bidco, holdco, borrower, or issuer entity with its
 * legal form ("Stonepeak Nile Parent LLC", "Acme Bidco Ltd"), or an SPV. A private-equity deal's
 * borrowing entity takes debt, not a venture round.
 */
const FINANCING_VEHICLE_NAME =
  /\b(?:parent|bidco|topco|midco|holdco|finco|borrower|issuer|merger sub|intermediate)(?:\s+(?:holdings?|co|company))?,?\s+(?:llc|l\.l\.c\.|lp|l\.p\.|inc|corp|ltd|limited|s\.?a\.?r\.?l|b\.?v)\b|\b(?:spv|special purpose vehicle)\b/i;

/** A company named as an investment firm is raising a fund, not a round, when its label names no stage. */
const FIRM_NAME = /\b(?:ventures|venture partners|partners|asset management|capital management|capital partners|fund|investments)\s*$/i;

/**
 * A company named as a public body, a lender, a school, or a project: "Asian Infrastructure Investment
 * Bank (AIIB) and Government of Benin" agreeing a USD730 million pipeline, "Troy Housing Authority",
 * "Project Vault" taking a $500 million commitment. With no stage named, what it takes in is public or
 * project money, not a venture round (the September 24, 2026 live pass read all three).
 */
const PUBLIC_OR_PROJECT_NAME =
  /\b(?:government|ministry|authority|agency|council|municipality|county|commission|department of|city of|state of|republic of|investment bank|development bank|central bank|housing|academy|university|college)\b|^project\s/i;

/**
 * A company raising a fund is a firm, not a startup: "closes $300M second fund", "launches a $50 million
 * climate fund", "announced the final close of Fund III". The fund must be the object of the verb, so a
 * round "led by the Acme Climate Fund" is not one.
 */
const FUND_RAISE =
  /\b(?:clos(?:es|ed|ing)|launch(?:es|ed|ing)|rais(?:es|ed|ing)|announc(?:es|ed|ing)|secur(?:es|ed|ing)|hits?)\s+(?:the\s+|its\s+|a\s+|an\s+|first\s+|final\s+|oversubscribed\s+)*(?:(?:close\s+of\s+(?:its\s+|the\s+)?)?)(?:(?:us)?[$€£]\s?[\d.,]+\s*(?:m|mn|million|b|bn|billion)?\s+)?(?:(?!from\b|by\b|led\b|with\b|including\b|and\b|in\b|for\b|to\b|of\b|at\b|as\b|that\b|which\b|will\b)[a-z0-9-]+\s+){0,3}fund\b(?!ing|ed|s\b)/i;
const FUND_CLOSE =
  /\b(?:first|final|second|interim)\s+close\s+of\s+(?:its\s+|the\s+)?(?:[\w$.,-]+\s+){0,4}fund\b|\bfund\s+(?:i{1,3}|iv|v|vi{1,3}|ix|x)\b|\bcommitments from limited partners\b/i;

/** A clause of the evidence: split on the breaks a sentence joins an equity and a debt half with. */
const CLAUSE = /[^,;]+/g;
const DEBT_WORDS =
  /\b(?:debt|credit facilit(?:y|ies)|credit line|line of credit|loan|lenders?|venture debt|equipment financing|revenue-based financing|notes? offering|convertible notes?|bonds?|warehouse facility|asset-backed|notes due|(?:senior|sr\.?) (?:secured|sec\.?|unsecured) notes|(?:1st|first|2nd|second)[- ]lien|term loan|high[- ]yield|revolv(?:er|ing (?:credit )?facility)|securiti[sz]ation)\b/i;

/**
 * Whether the round's own figure sits in a clause about debt: "secured a $50 million credit facility",
 * "It also includes $30 million in debt and equipment financing". A stageless reading whose money is
 * debt is a facility, not a round; debt beside equity ("$45 million in equity ... plus $30 million in
 * debt") leaves the equity figure the round.
 */
export function amountIsDebt(evidence: string | null | undefined, amountAsWritten: string | null | undefined): boolean {
  const e = evidence ?? "";
  const figure = /(\d+(?:[.,]\d+)?)/.exec(amountAsWritten ?? "")?.[1];
  if (!figure) return false;
  return figureClauses(e, figure).some((clause) => DEBT_WORDS.test(clause) && !/\bequity\b/i.test(clause));
}

/** The clauses of `evidence` that print `figure` ("45" of "$45 million"), split where a sentence joins two halves. */
function figureClauses(evidence: string, figure: string): string[] {
  const re = new RegExp(`(?:^|[^\\d.])${figure.replace(".", "\\.")}(?![\\d])`);
  return [...evidence.matchAll(CLAUSE)].map((m) => m[0]).filter((clause) => re.test(clause));
}

/**
 * Whether an aggregate's words describe the round's own figure: "the spin-out brings Arc and F2's combined
 * capital raised to nearly $200 million" beside a $10M round is a total, not the round. With no figure to
 * place, the sentence's words decide.
 */
function aggregateIsTheFigure(evidence: string, amountAsWritten: string | null | undefined, aggregate: RegExp): boolean {
  const figure = /(\d+(?:[.,]\d+)?)/.exec(amountAsWritten ?? "")?.[1];
  if (!figure) return aggregate.test(evidence);
  return figureClauses(evidence, figure).some((clause) => aggregate.test(clause));
}

/**
 * Right after the company's name, the company as a listed one: "Hyperscale Data, Inc., an NYSE American
 * listed company", "Acme (Nasdaq: ACME)", "which is listed on NewConnect". Only the company's own
 * appositive counts: "backed by Nasdaq-listed Tencent" is an investor's listing.
 */
const LISTED_PHRASE =
  /^(?:,?\s*(?:inc|corp|corporation|ltd|limited|plc|s\.?a|ag|ab|asa|n\.?v|se)\.?)*\s*(?:\((?:nyse(?:\s+american)?|nasdaq|tsx(?:-?v)?|tsxv|asx|otc(?:qb|qx)?|lse|aim|cse)\s*:\s*[a-z.]{1,6}\)|,\s*(?:an?|the)\s+(?:[\w-]+\s+){0,3}(?:\w+-)?(?:listed|publicly traded|publicly listed)\s+(?:company|firm|group|issuer|entity)\b|,?\s*(?:which is\s+|is\s+)?(?:listed|publicly traded) on\b)/i;

/**
 * Shares sold by a company that is already public, or its existing holders' rights: never a venture
 * round. A preferential issue or allotment, and a qualified institutional placement, are how an Indian
 * listed company sells shares: BSE-listed Prime Industries' "preferential issue raised ₹11.86 crore at
 * ₹42 per share" was on the feed as a startup's funding round. So was AceVector's IPO anchor book ("raised
 * Rs 189 crore from anchor investors ahead of its initial public offering").
 */
const SHARE_OFFERING =
  /\b(?:rights issue|rights offering|subscription rights|share offering|share issue|share placement|preferential (?:issue|allotment|allocation)|qualified institutional placement|anchor (?:book|allocation|portion)|from anchor investors ahead of|allocat(?:ed|ing|es) (?:all )?(?:the )?[\d.,]+\s*(?:million\s+)?(?:new\s+)?shares|convertible preferred stock)\b/i;

/**
 * The round's figure is a fund's size: "Norrsken Evolve's €62 million pre-seed fund", "a $300M second
 * fund", "limited partner in". A fund is raised by a firm from its limited partners; the money is not a
 * startup's round, whatever stage word names the fund.
 */
const FUND_FIGURE =
  /(?:[$€£]|\b(?:usd|eur|gbp|sek|nok|dkk|chf))\s?[\d.,]+\s*(?:m|mn|million|b|bn|billion)?\s+(?:(?!from\b|by\b|led\b|with\b|including\b|and\b|in\b|for\b|to\b|of\b|at\b|round\b)[a-z0-9-]+\s+){0,3}fund\b(?!ing|ed|s?\s+(?:round|raise))|\blimited partners?\s+(?:in|of)\b/i;

/** A bank's or an asset manager's own name as the company: it invests, it does not raise a round. */
const INVESTOR_FIRM_NAME =
  /\b(?:j\.?\s?p\.?\s?morgan|jpmorgan|goldman sachs|morgan stanley|blackrock|blackstone|kkr|carlyle|apollo global|brookfield|bank of america|citigroup|citibank|hsbc|barclays|ubs|deutsche bank|bnp paribas|nomura|macquarie|temasek|mubadala|softbank vision fund)\b|\b(?:asset management|natural capital|investment management|wealth management)\b/i;

/** The sentence calls the company an investor ("Exergy, an Africa-focused integrated energy investor, ..."). */
const INVESTOR_APPOSITIVE =
  /^,\s*(?:an?|the)\s+(?:(?!backed\b|by\b|with\b|from\b|whose\b|that\b|which\b|funded\b|supported\b)[\w-]+\s+){0,5}(?:investor|investment (?:firm|company|manager|group|platform)|asset manager|private equity (?:firm|group)|venture (?:capital )?firm|family office|sovereign (?:wealth )?fund)\b(?![-\w])/i;

/** Two parties signing a financing: "have signed a US$250 million financing deal", a project's investment agreement. */
const FINANCING_AGREEMENT =
  /\bsign(?:s|ed|ing)?\s+(?:a|an|the)\s+(?:[\w$.,-]+\s+){0,4}(?:financing|investment|funding|offtake|loan)\s+(?:deal|agreement|facility|mou|memorandum)\b|\bannounc(?:e|es|ed)\s+an\s+investment\s+of\b[^.]{0,80}\bto\s+(?:develop|build|create|establish)\b/i;

/** A headline about projects, not a company: "Investment Deal To Accelerate African Power Projects". */
const PROJECT_TITLE = /\b(?:power|energy|solar|wind|hydro|infrastructure|mining|forestry|housing)\s+projects?\b/i;

/** The text right after the company's name in the sentence, where an appositive or a ticker sits. */
function afterName(evidence: string, companyName: string | null | undefined): string[] {
  const first = (companyName ?? "").trim();
  if (first.length < 3) return [];
  const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...evidence.matchAll(new RegExp(escaped, "gi"))].map((m) =>
    evidence.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 120),
  );
}

/**
 * Why a reading is not a startup's venture round whatever its label says, or null. The company is
 * listed on an exchange (Hyperscale Data, "an NYSE American listed company"), the money is a share
 * offering or a rights issue by a public company (Eco5Tech's "series D share offering, allocating all 5.4
 * million shares"), or the figure is a fund's size (Norrsken Evolve's "€62 million pre-seed fund").
 * These held a stage label or none, and all came through the 2026-09-25 store audit.
 */
export function notAStartupRound(
  label: string | null | undefined,
  evidence: string | null | undefined,
  companyName?: string | null,
): string | null {
  const e = evidence ?? "";
  if (afterName(e, companyName).some((tail) => LISTED_PHRASE.test(tail))) return "listed company";
  if (SHARE_OFFERING.test(label ?? "") || SHARE_OFFERING.test(e)) return "securities offering";
  if (FUND_FIGURE.test(e)) return "fund close";
  return null;
}

/**
 * Why a stageless reading is not a venture round, or null when it may be one. The label decides first
 * (a "public offering", a "management buyout", "flagship fund BVP XII", a "grant"), then the sentence
 * (a firm closing a fund, a figure that is a debt facility). A lettered round never comes here.
 */
export function notARound(
  label: string | null | undefined,
  evidence: string | null | undefined,
  amountAsWritten?: string | null,
  companyName?: string | null,
  title?: string | null,
): string | null {
  const startup = notAStartupRound(label, evidence, companyName);
  if (startup) return startup;
  const l = (label ?? "").toLowerCase();
  // "funding", "fundraise", and "refunding" carry the letters of "fund" and are not one.
  const labelSansFunding = l.replace(/\bfund(?:ing|raise|raising|ed)\b/g, " ");
  for (const [re, reason] of NOT_A_ROUND_LABEL) if (re.test(labelSansFunding)) return reason;
  const e = evidence ?? "";
  if (FUND_RAISE.test(e) || FUND_CLOSE.test(e)) return "fund close";
  if (amountIsDebt(e, amountAsWritten)) return "debt";
  for (const [re, reason] of NOT_A_RAISE) {
    if (reason === "aggregate" ? aggregateIsTheFigure(e, amountAsWritten, re) : re.test(e)) return reason;
  }
  // "$482.5 Million In Financing Secured for New Luxury Ski Resort": the sentence said only "secured $482.5 million in financing".
  for (const [re, reason] of NOT_A_RAISE_TITLE) if (title && re.test(title)) return reason;
  if (companyName && FIRM_NAME.test(companyName.trim())) return "fund close";
  if (companyName && FINANCING_VEHICLE_NAME.test(companyName.trim())) return "financing vehicle";
  if (companyName && PUBLIC_OR_PROJECT_NAME.test(companyName.trim())) return "public or project funding";
  // A bank or an asset manager named as the company (J.P. Morgan Natural Capital's forestry investment in
  // Paraguay), a company the sentence calls an investor (Exergy), a signed financing deal, or a headline
  // about projects (Exergy's "African Power Projects"): the money is invested, not raised.
  if (companyName && INVESTOR_FIRM_NAME.test(companyName.trim())) return "investor named as the company";
  if (afterName(e, companyName).some((tail) => INVESTOR_APPOSITIVE.test(tail))) return "investor named as the company";
  if (FINANCING_AGREEMENT.test(e)) return "financing agreement";
  if (title && PROJECT_TITLE.test(title)) return "project financing";
  // The headline counts: "Nuclear Startup Backed by Luckey ... Raises $130 Million" over "investors are putting $130 million into Valar".
  if (!RAISE_STATED.test(e) && !(title && RAISE_STATED.test(title))) return "no raise stated";
  return null;
}

/** What a preset needs for routing: its slug and the stages it keeps, in the order presets are listed. */
export interface RoutablePreset {
  slug: string;
  stages: readonly Stage[];
}

/** Whether a preset keeps a round of this stage and size: its stage directly, or, with no stage, its amount's band. */
export function presetKeeps(preset: Pick<RoutablePreset, "stages">, stage: Stage, usdMillions: number | null): boolean {
  if (stage === "pre_a" && preset.stages.includes("series_a")) return true;
  if (preset.stages.includes(stage)) return true;
  if (!isStageless(stage) || usdMillions === null) return false;
  return bandsOf(preset.stages).includes(bandForAmount(usdMillions));
}

/**
 * The preset a record lands under: the lane's own preset (`home`) when it keeps the round, else the
 * first preset in list order that does (the shipped files come first, so a custom topic preset never
 * takes a round it did not find itself). A stageless record no band holds (the read-back took its
 * amount away) stays with the lane that found it. Null when no preset keeps it: a record the read-back
 * found to be debt, a grant, or a secondary is no preset's round.
 */
export function routePreset(
  record: { stage: Stage; amount: { usd_millions: number | null } },
  presets: readonly RoutablePreset[],
  home?: string | null,
): string | null {
  const own = home ? presets.find((p) => p.slug === home) : undefined;
  if (own && presetKeeps(own, record.stage, record.amount.usd_millions)) return own.slug;
  const first = presets.find((p) => presetKeeps(p, record.stage, record.amount.usd_millions))?.slug;
  if (first) return first;
  return own && isStageless(record.stage) ? own.slug : null;
}

/** Records grouped by the preset each lands under; a record no preset keeps is left out and counted. */
export function groupByPreset<R extends { stage: Stage; amount: { usd_millions: number | null } }>(
  records: readonly R[],
  presets: readonly RoutablePreset[],
  home?: string | null,
): { groups: Map<string, R[]>; unrouted: number } {
  const groups = new Map<string, R[]>();
  let unrouted = 0;
  for (const r of records) {
    const slug = routePreset(r, presets, home);
    if (!slug) {
      unrouted++;
      continue;
    }
    groups.set(slug, [...(groups.get(slug) ?? []), r]);
  }
  return { groups, unrouted };
}
