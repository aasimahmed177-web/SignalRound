import { createHash } from "node:crypto";

export type FunnelParameterCategory = "attribution" | "click-id" | "identity" | "experiment" | "session" | "other";

const categories: Array<[FunnelParameterCategory, RegExp]> = [
  [
    "attribution",
    /^(?:utm_(?:source|medium|campaign|term|content|id)|campaign(?:_id|_name)?|ad(?:set)?(?:_id|_name)?|placement|site_source_name)$/i,
  ],
  ["click-id", /^(?:fbclid|gclid|dclid|msclkid|ttclid|twclid|li_fat_id|gbraid|wbraid|fbc|fbp)$/i],
  ["identity", /^(?:email|e-mail|phone|mobile|first_?name|last_?name|full_?name|address|external_?id|user_?id)$/i],
  ["experiment", /^(?:experiment|variant|variation|ab(?:_test)?|split|bucket|test_?id)$/i],
  ["session", /^(?:session|session_?id|visit_?id|visitor_?id|token|code|state|lead_?id)$/i],
];

export function classifyFunnelParameter(name: string): FunnelParameterCategory {
  return categories.find(([, pattern]) => pattern.test(name))?.[0] ?? "other";
}

export function analyzeFunnelUrl(raw: string) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 8192) throw new Error("Expected an HTTP(S) URL under 8192 characters");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Expected a valid URL");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Expected an HTTP(S) URL without credentials");
  const grouped = new Map<string, { category: FunnelParameterCategory; occurrences: number; hasValue: boolean }>();
  for (const [name, value] of url.searchParams) {
    const prior = grouped.get(name) ?? { category: classifyFunnelParameter(name), occurrences: 0, hasValue: false };
    prior.occurrences++;
    prior.hasValue ||= value.length > 0;
    grouped.set(name, prior);
  }
  const parameters = [...grouped].map(([name, facts]) => ({ name, ...facts, value: facts.hasValue ? "[redacted]" : "[empty]" }));
  return {
    origin: url.origin,
    path: url.pathname,
    fragmentPresent: Boolean(url.hash),
    parameters,
    attributionKeys: parameters
      .filter((entry) => entry.category === "attribution" || entry.category === "click-id")
      .map((entry) => entry.name),
    identityKeys: parameters.filter((entry) => entry.category === "identity").map((entry) => entry.name),
  };
}

const EVENT_PATTERNS = [
  { vendor: "meta", pattern: /fbq\s*\(\s*["'](?:track|trackCustom)["']\s*,\s*["']([^"']+)["']/gi },
  { vendor: "google", pattern: /gtag\s*\(\s*["']event["']\s*,\s*["']([^"']+)["']/gi },
  { vendor: "tiktok", pattern: /ttq\s*\.\s*track\s*\(\s*["']([^"']+)["']/gi },
  { vendor: "data-layer", pattern: /(?:dataLayer|window\.dataLayer)\s*\.\s*push\s*\(\s*\{[^{}]{0,500}?event\s*:\s*["']([^"']+)["']/gis },
] as const;

const parameterName =
  /["']?(email|em|phone|ph|first_?name|last_?name|external_?id|user_?id|fbclid|gclid|fbc|fbp|ttclid|value|currency|content_?id|content_?name)["']?\s*:/gi;

export function redactSnippetText(value: string) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d ()-]{8,}\d/g, "[phone]")
    .replace(/\b(?:sk[-_]|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_-]{12,}\b/g, "[secret]")
    .replace(/([?&][^\s?&#=]+)=([^\s&#]*)/g, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

/** Declared source code only. It does not prove invocation, transmission or acknowledgement. */
export function inspectEventSnippets(source: string, sourceURL: string) {
  if (typeof source !== "string" || source.length > 2_000_000) throw new Error("Event source exceeds the 2 MB analysis limit");
  const events: Array<{
    vendor: string;
    event: string;
    sourceURL: string;
    offset: number;
    level: "declared-in-source";
    parameterNames: string[];
    snippet: string;
    snippetHash: string;
  }> = [];
  const seen = new Set<string>();
  for (const { vendor, pattern } of EVENT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (events.length >= 100) break;
      const event = match[1]?.trim().slice(0, 120);
      if (!event) continue;
      const offset = match.index ?? 0;
      const window = source.slice(Math.max(0, offset - 80), Math.min(source.length, offset + Math.max(match[0].length, 600)));
      const parameterNames = [...new Set([...window.matchAll(parameterName)].map((entry) => entry[1].toLowerCase()))].slice(0, 40);
      const key = `${vendor}\u0000${event}\u0000${offset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        vendor,
        event,
        sourceURL,
        offset,
        level: "declared-in-source",
        parameterNames,
        snippet: redactSnippetText(window),
        snippetHash: createHash("sha256").update(window).digest("hex"),
      });
    }
  }
  return events;
}
