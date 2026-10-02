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
  return SECTOR_LABEL[sector as Sector] ?? sector;
}
