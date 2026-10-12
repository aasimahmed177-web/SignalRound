// One sector vocabulary for the whole product. The extractor picks from it (an enum in the
// JSON schema costs nothing extra and removes "AI" / "Artificial Intelligence (AI)" /
// "Consumer/AI" from the same store), and free text from older runs or the agent maps onto it.

export const SECTORS = [
  "ai",
  "ai infrastructure",
  "developer tools",
  "data and analytics",
  "cybersecurity",
  "enterprise software",
  "fintech",
  "payments",
  "insurtech",
  "crypto",
  "healthtech",
  "biotech",
  "medtech",
  "climate",
  "energy",
  "mobility",
  "robotics",
  "hardware",
  "semiconductors",
  "quantum",
  "space",
  "defense",
  "consumer",
  "ecommerce",
  "marketplace",
  "media and gaming",
  "edtech",
  "hr tech",
  "legal tech",
  "proptech",
  "logistics",
  "agtech and food",
  "manufacturing",
  "other",
] as const;
export type Sector = (typeof SECTORS)[number];

/**
 * What the extractors are told beside the list. Left alone, a reader files every GPU cloud and AI
 * chip maker under "ai" (27 of the 203 "ai" companies on visible rounds in October 2026), and a
 * search for AI infrastructure finds almost none of them.
 */
export const SECTOR_HINT =
  "ai infrastructure, not ai, for GPU and inference clouds, AI chips and interconnects, AI data centers, and platforms that train or serve models";

export const SECTOR_LABEL: Record<Sector, string> = {
  ai: "AI",
  "ai infrastructure": "AI infrastructure",
  "developer tools": "Developer tools",
  "data and analytics": "Data and analytics",
  cybersecurity: "Cybersecurity",
  "enterprise software": "Enterprise software",
  fintech: "Fintech",
  payments: "Payments",
  insurtech: "Insurtech",
  crypto: "Crypto",
  healthtech: "Healthtech",
  biotech: "Biotech",
  medtech: "Medtech",
  climate: "Climate",
  energy: "Energy",
  mobility: "Mobility",
  robotics: "Robotics",
  hardware: "Hardware",
  semiconductors: "Semiconductors",
  quantum: "Quantum",
  space: "Space",
  defense: "Defense",
  consumer: "Consumer",
  ecommerce: "Ecommerce",
  marketplace: "Marketplace",
  "media and gaming": "Media and gaming",
  edtech: "Edtech",
  "hr tech": "HR tech",
  "legal tech": "Legal tech",
  proptech: "Proptech",
  logistics: "Logistics",
  "agtech and food": "Agtech and food",
  manufacturing: "Manufacturing",
  other: "Other",
};

/**
 * The top of the taxonomy: a few groups, each holding the sectors under it. Every sector sits in
 * exactly one group. A filter on a group matches every sector it holds, so sector=ai finds the AI
 * infrastructure rounds too and sector=health finds biotech; a group named after a sector ("ai",
 * "climate") is that sector and the narrower ones beside it. A filter on any other sector matches it alone.
 */
export const SECTOR_GROUPS = {
  ai: ["ai", "ai infrastructure"],
  software: ["enterprise software", "developer tools", "data and analytics", "cybersecurity", "hr tech", "legal tech", "edtech"],
  fintech: ["fintech", "payments", "insurtech", "crypto"],
  health: ["healthtech", "biotech", "medtech"],
  climate: ["climate", "energy"],
  hardware: ["hardware", "semiconductors", "quantum", "robotics"],
  "aerospace and defense": ["space", "defense"],
  mobility: ["mobility", "logistics"],
  consumer: ["consumer", "ecommerce", "marketplace", "media and gaming"],
  industrials: ["manufacturing", "proptech", "agtech and food"],
  other: ["other"],
} as const satisfies Record<string, readonly Sector[]>;
export type SectorGroup = keyof typeof SECTOR_GROUPS;

export const SECTOR_GROUP_LABEL: Record<SectorGroup, string> = {
  ai: "AI",
  software: "Software",
  fintech: "Fintech",
  health: "Health",
  climate: "Climate and energy",
  hardware: "Hardware and deep tech",
  "aerospace and defense": "Aerospace and defense",
  mobility: "Mobility and logistics",
  consumer: "Consumer",
  industrials: "Industrials",
  other: "Other",
};

/** The stored sectors a filter word matches: the word itself and, for a group, every sector in it. Lowercase, as stored. */
export function sectorMembers(filter: string): string[] {
  const word = filter.trim().toLowerCase();
  return Object.hasOwn(SECTOR_GROUPS, word) ? [...new Set([word, ...SECTOR_GROUPS[word as SectorGroup]])] : [word];
}

/**
 * The feed's sector menu from the sectors its rounds carry: each group that holds one of them, then
 * its narrower sectors that are present, inset under it. A group's own sector is the group's line.
 */
export function sectorMenu(present: readonly string[]): Array<{ value: string; label: string; inset: boolean }> {
  const have = new Set(present);
  const menu: Array<{ value: string; label: string; inset: boolean }> = [];
  for (const [group, members] of Object.entries(SECTOR_GROUPS) as Array<[SectorGroup, readonly Sector[]]>) {
    const shown = members.filter((m) => have.has(m));
    if (shown.length === 0) continue;
    menu.push({ value: group, label: SECTOR_GROUP_LABEL[group], inset: false });
    for (const m of shown) if (m !== group) menu.push({ value: m, label: SECTOR_LABEL[m], inset: true });
  }
  return menu;
}

const SECTOR_SET = new Set<string>(SECTORS);

/** First match wins, so the specific rows sit above the general ones ("ai infrastructure" before "ai"). */
const RULES: Array<[RegExp, Sector]> = [
  [
    /\b(ai|ml|llm|inference|gpu|compute)\b.*\b(infra|infrastructure|cloud|chips?|data ?cent(er|re)s?)\b|\bdata ?cent(er|re)s?\b/,
    "ai infrastructure",
  ],
  [/\bsemiconductor|\bchips?\b|silicon|photonic/, "semiconductors"],
  [/quantum/, "quantum"],
  [/\bdev(eloper)?\s?tools?\b|devtools|developer platform|\bapi platform\b|\bsdk\b|\bdatabases?\b|\bfor developers\b/, "developer tools"],
  [/\bdata\b.*\b(analytics|platform|warehouse|pipeline)\b|\banalytics\b|business intelligence/, "data and analytics"],
  [/cyber|security|identity|fraud/, "cybersecurity"],
  [/\bpayments?\b|remittance|payroll|cross-border/, "payments"],
  [/insur/, "insurtech"],
  [/crypto|blockchain|web3|stablecoin|tokeni[sz]|defi|digital assets?/, "crypto"],
  [/fintech|\bbank(ing)?\b|lending|wealth|invest(ing|ment) platform|credit|neobank|treasury|accounting/, "fintech"],
  [/biotech|pharma|therapeutics?|drug|molecul|genomic|cell therapy|car-t|clinical/, "biotech"],
  [/medtech|medical device|diagnostic|imaging|surgical/, "medtech"],
  [/health|care|veterinary|wellness|mental|clinic|patient|ambulance|dental|pet/, "healthtech"],
  [/climate|carbon|cleantech|sustainab|decarboni|circular/, "climate"],
  [/energy|battery|batteries|solar|nuclear|fusion|geothermal|grid|power|storage|bess|hydrogen/, "energy"],
  [/mobility|electric vehicle|\bev\b|automotive|scooter|autonomous driving|transport|ride|micromobility/, "mobility"],
  [/robot|drone|automation|autonomous/, "robotics"],
  [/space|satellite|launch|orbit|rocket/, "space"],
  [/defen[cs]e|military|dual-use/, "defense"],
  [/logistic|supply chain|warehous|freight|delivery|shipping|last-mile/, "logistics"],
  [/agri|agtech|farm|food|nutrition|grocery|restaurant|beverage|protein/, "agtech and food"],
  [/manufactur|industrial|materials?|3d print|factory/, "manufacturing"],
  [/proptech|real estate|property|construction|housing/, "proptech"],
  [/legal|law\b|compliance|regulat|contract/, "legal tech"],
  [/\bhr\b|recruit|hiring|talent|workforce|people ops|employee|screening/, "hr tech"],
  [/edtech|education|learning|school|student|tutor/, "edtech"],
  [/media|gaming|game|video|music|creator|entertainment|streaming|sports/, "media and gaming"],
  [/marketplace/, "marketplace"],
  [/e-?commerce|retail|d2c|dtc|brand|sneaker|fashion|apparel|shopping/, "ecommerce"],
  [/consumer|social|dating|travel|hospitality|lifestyle|spiritual|devotion/, "consumer"],
  [/hardware|iot|device|sensor|wearable|electronics/, "hardware"],
  [
    /\bsaas\b|enterprise|b2b|workflow|productivity|crm|erp|software|collaborat|whiteboard|\bdocs\b|documents?\b|note-?taking|\bnotes app|\bwiki\b|knowledge base|project management|task management|spreadsheet|presentations?\b|\bcalendar/,
    "enterprise software",
  ],
  [/\bai\b|artificial intelligence|machine learning|agentic|agents?\b|\bllm\b|generative|copilot/, "ai"],
];

/**
 * Free text to a sector. Already-canonical values pass through; "Artificial Intelligence (AI)",
 * "Fintech/payments infrastructure", "D2C Sneakers" land on their rows; nothing recognizable
 * becomes "other"; empty stays null.
 */
export function normalizeSector(text: string | null | undefined): Sector | null {
  if (text === null || text === undefined) return null;
  const s = text.trim().toLowerCase();
  if (!s) return null;
  if (SECTOR_SET.has(s)) return s as Sector;
  for (const [re, sector] of RULES) if (re.test(s)) return sector;
  return "other";
}

export function sectorLabel(sector: string | null | undefined): string {
  if (!sector) return "";
  return SECTOR_LABEL[sector as Sector] ?? SECTOR_GROUP_LABEL[sector as SectorGroup] ?? sector;
}
