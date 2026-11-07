// An industry tag for a funded company, read from words it and its funding headline actually use.
// Keyword matching only: every tag carries the verbatim words that decided it and the page they came from.
// Text that names no industry, or names two equally, is "other" with confidence 0 rather than a guess.

export type IndustryLabel =
  | "edtech"
  | "healthcare"
  | "real_estate"
  | "hiring_marketplace"
  | "b2b_saas"
  | "consumer_app"
  | "agency"
  | "fintech"
  | "ecommerce"
  | "climate"
  | "deeptech"
  | "other";

export interface Industry {
  label: IndustryLabel;
  confidence: number;
  evidence_quote: string | null;
  source_url: string | null;
}

export interface IndustryText {
  text: string | null | undefined;
  url: string | null | undefined;
  /** How much a hit here counts: the company's own one-line brief says more than a long homepage. */
  weight: number;
}

const KEYWORDS: Array<[Exclude<IndustryLabel, "other">, RegExp, number]> = [
  [
    "edtech",
    /\b(?:ed-?tech|education(?:al)?|e-?learning|learners?|students?|tutor(?:s|ing)?|upskill(?:ing)?|courses?|classrooms?|schools?|teachers?|exam prep)\b/gi,
    1,
  ],
  [
    "healthcare",
    /\b(?:health ?care|health ?tech|healthtech|medical|medicine|clinics?|clinical|hospitals?|patients?|doctors?|physicians?|diagnostics?|therap(?:y|ies|eutics)|biotech|drug discovery|pharma(?:ceuticals?)?|mental health|telehealth|care teams?)\b/gi,
    1,
  ],
  [
    "real_estate",
    /\b(?:real estate|prop-?tech|propert(?:y|ies)|landlords?|tenants?|rentals?|homebuyers?|home ?owners?|housing|co-?living|construction)\b/gi,
    1,
  ],
  [
    "hiring_marketplace",
    /\b(?:hiring|recruit(?:ing|ment|ers?)|talent (?:marketplace|platform)|job ?seekers?|job matching|staffing|freelancers?|gig workers?)\b/gi,
    1,
  ],
  [
    "fintech",
    /\b(?:fin-?tech|payments?|payroll|lending|loans?|credit|neo-?bank(?:ing)?|banking|banks?|insur(?:ance|tech)|wealth|investing|investment (?:office|management|platform|app)s?|trading|crypto|stablecoins?|remittances?|invoic(?:e|es|ing)|accounting|expense management)\b/gi,
    1,
  ],
  [
    "ecommerce",
    /\b(?:e-?commerce|d2c|dtc|direct-to-consumer|online (?:store|shop|retail)|shoppers?|shopping|retail(?:ers)?|apparel|fashion|beauty brand|skincare|grocer(?:y|ies)|quick commerce|q-?commerce)\b/gi,
    1,
  ],
  [
    "climate",
    /\b(?:climate|carbon|decarboni[sz](?:e|ing|ation)|net[- ]zero|renewables?|solar|wind (?:power|energy)|clean ?(?:tech|energy)|electric vehicles?|e-?bikes?|electric bikes?|evs?|ev charging|batter(?:y|ies)|energy storage|emissions|sustainab(?:le|ility)|recycl(?:e|ing)|hydrogen)\b/gi,
    1,
  ],
  [
    "deeptech",
    /\b(?:deep ?tech|semiconductors?|chips?|quantum|robots?|robotics|satellites?|space ?tech|spacecraft|launch vehicles?|aerospace|hypersonics?|drones?|autonomous (?:vehicles?|systems)|lidar|photonics|fusion|materials science|defen[cs]e tech)\b/gi,
    1,
  ],
  [
    "agency",
    /\b(?:agency|agencies|consultancy|consulting firm|marketing services|creative studio|design studio|dev(?:elopment)? shop|outsourc(?:ed|ing))\b/gi,
    1,
  ],
  [
    "consumer_app",
    /\b(?:consumer app|mobile app|social (?:app|network)|dating|creators?|gaming|mobile games?|community app|fitness app|meditation app)\b/gi,
    1,
  ],
  // Generic software words are weak: "SaaS for clinics" is healthcare, not b2b_saas.
  [
    "b2b_saas",
    /\b(?:saas|b2b|enterprises?|enterprise software|workflows?|automat(?:e|es|ion)|crm|erp|developer tools?|devtools|developers|api|apis|software platform|for teams|operations teams?|sales teams?|compliance|cybersecurity|security teams?|observability|data platform)\b/gi,
    0.5,
  ],
];

const QUOTE_MAX = 200;

/** The sentence (or line) around a match, as written, trimmed to QUOTE_MAX characters. */
function quoteAround(text: string, index: number, length: number): string {
  // A sentence ends at ".", "!" or "?" before a space, or at a line break: "$7.5M" stays whole.
  const ends = [...text.slice(0, index).matchAll(/[.!?](?=\s)|\n/g)];
  const start = Math.max((ends.at(-1)?.index ?? -1) + 1, index + length - QUOTE_MAX);
  const end = text.slice(index + length).search(/[.!?](?=\s|$)|\n/);
  const stop = end === -1 ? text.length : index + length + end + 1;
  return text.slice(start, Math.min(stop, start + QUOTE_MAX)).trim();
}

const NONE: Industry = { label: "other", confidence: 0, evidence_quote: null, source_url: null };

/** The industry a company's brief, funding headline and homepage text point to, or "other" with confidence 0. */
export function classifyIndustry(texts: IndustryText[]): Industry {
  const scores = new Map<IndustryLabel, number>();
  const best = new Map<IndustryLabel, { score: number; quote: string; url: string }>();
  for (const source of texts) {
    if (!source.text?.trim() || !source.url) continue;
    for (const [label, pattern, strength] of KEYWORDS) {
      const seen = new Set<string>();
      for (const match of source.text.matchAll(pattern)) {
        // Each distinct word counts once per text, so a homepage repeating "students" ten times does not drown the brief.
        const word = match[0].toLowerCase();
        if (seen.has(word)) continue;
        seen.add(word);
        const score = source.weight * strength;
        scores.set(label, (scores.get(label) ?? 0) + score);
        if (score > (best.get(label)?.score ?? 0))
          best.set(label, { score, quote: quoteAround(source.text, match.index, match[0].length), url: source.url });
      }
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (!top || top[1] === (second?.[1] ?? 0)) return NONE;
  const evidence = best.get(top[0]);
  if (!evidence) return NONE;
  // Margin over the runner-up, scaled down when the winner rests on a single weak hit.
  const confidence = ((top[1] - (second?.[1] ?? 0)) / top[1]) * Math.min(1, top[1] / 4);
  return { label: top[0], confidence: Math.round(confidence * 100) / 100, evidence_quote: evidence.quote, source_url: evidence.url };
}
