export interface BrandingProfile {
  brandName?: string;
  logo?: string;
  images?: { logo?: string };
  colors?: { primary?: string; background?: string };
  colorScheme?: string;
}
export interface Document {
  markdown?: string;
  html?: string;
  links?: string[];
  json?: unknown;
  branding?: BrandingProfile;
  metadata?: {
    sourceURL?: string;
    url?: string;
    title?: string;
    description?: string;
    favicon?: string | null;
    ogSiteName?: string;
    statusCode?: number;
    creditsUsed?: number;
    [key: string]: unknown;
  };
}
export interface SearchResultWeb extends Document {
  url: string;
  title?: string;
  description?: string;
  highlights?: string[];
}
export interface SearchResultNews extends SearchResultWeb {
  date?: string;
  snippet?: string;
}
export interface AlexandriaCall {
  provider: string;
  capability: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}
export type JsonFormat = { type: "json"; schema?: object; prompt?: string };
export interface ScrapeOptions {
  /** Explicit opt-in: sends the public URL to Agent Reach's Jina backend. */
  reader?: "direct" | "agent-reach";
  /** Structured public GitHub and RSS/Atom reads. */
  adaptive?: boolean;
  formats?: Array<string | JsonFormat>;
  onlyMainContent?: boolean;
  timeout?: number;
  maxAge?: number;
}
export interface SearchOptions {
  limit?: number;
  sources?: Array<string | { type: string }>;
  tbs?: string;
  highlights?: boolean;
  scrapeOptions?: ScrapeOptions;
  timeout?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}
export interface AgentOptions {
  prompt: string;
  schema?: object;
  model?: string;
  maxCredits?: number;
  effort?: string;
  pollInterval?: number;
  timeout?: number;
  urls?: string[];
}
export interface AgentResult {
  status: "completed" | "failed" | "processing";
  data?: unknown;
  error?: string;
  creditsUsed?: number;
  sources?: string[];
}
export interface MonitorOptions {
  name?: string;
  schedule?: { text: string; timezone?: string };
  goal?: string;
  targets?: Array<{
    type: string;
    queries?: string[];
    urls?: string[];
    maxResults?: number;
    searchWindow?: string;
    excludeDomains?: string[];
    includeDomains?: string[];
    scrapeOptions?: ScrapeOptions;
  }>;
  webhook?: { url: string; headers?: Record<string, string>; metadata?: Record<string, string>; events?: string[] };
  notification?: { email?: { enabled: boolean; recipients: string[]; includeDiffs?: boolean } };
  retentionDays?: number;
}
export interface Monitor extends MonitorOptions {
  id: string;
  estimatedCreditsPerMonth?: number | null;
}
export interface MonitorCheck {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  startedAt?: string;
  estimatedCredits?: number | null;
  actualCredits?: number | null;
  summary: { totalPages: number };
  pages?: Array<{ url: string; status: "new" | "unchanged"; judgment?: { reason?: string } }>;
  error?: string;
}
/** Only for callers that inspect structured provider failures; native transport never emits vendor codes. */
export class SdkError extends Error {
  statusCode?: number;
  code?: string;
  constructor(message: string, statusCode?: number, code?: string, ..._details: unknown[]) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}
