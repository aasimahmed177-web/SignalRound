import { createHmac, randomBytes } from "node:crypto";

export type EvidenceJson = null | boolean | number | string | EvidenceJson[] | { [key: string]: EvidenceJson };
export const REDACTION_VERSION = "json-v1";
const MAX_STRING = 100_000;
const MAX_NODES = 10_000;
const MAX_DEPTH = 16;
const patterns = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  /\+?\d[\d ()-]{8,}\d/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(?:sk[-_]|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_-]{12,}\b/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];
const sensitiveKey =
  /^(?:authorization|cookie|set-cookie|password|secret|token|api[_-]?key|email|phone|name|address|user[_-]?id|click[_-]?id|fbclid|gclid)$/i;
const marker = /\[redacted:[a-f0-9]{24}\]/g;
const completeMarker = /^\[redacted:[a-f0-9]{24}\]$/;
const urlFragment = /((?:https?:\/\/|\/)[^\s#]*)#([^\s]*)/g;

/** JSON only. Reject rather than silently truncate evidence or invoke toJSON/getters. */
export function mapEvidenceJson(input: unknown, transform: (value: string) => string): EvidenceJson {
  let nodes = 0;
  let characters = 0;
  const active = new Set<object>();
  function string(value: string) {
    characters += value.length;
    if (value.length > MAX_STRING || characters > 1_000_000) throw new Error("Evidence text budget exceeded");
    return transform(value);
  }
  function visit(value: unknown, depth: number): EvidenceJson {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("Evidence structure budget exceeded");
    if (typeof value === "string") return string(value);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null) throw new Error("Evidence must contain JSON values only");
    if (active.has(value)) throw new Error("Cyclic evidence rejected");
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Error("Evidence must contain plain JSON objects");
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length) throw new Error("Symbol evidence rejected");
    const keys = Object.keys(descriptors).filter((key) => !(Array.isArray(value) && key === "length"));
    if (keys.length > MAX_NODES) throw new Error("Evidence key budget exceeded");
    const output: Record<string, EvidenceJson> = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("Non-JSON property rejected");
      const cleanKey = string(key);
      if (Object.hasOwn(output, cleanKey)) throw new Error("Redacted key collision");
      output[cleanKey] = visit(descriptor.value, depth + 1);
    }
    active.delete(value);
    if (Array.isArray(value)) {
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new Error("Non-JSON array rejected");
      return keys.map((key) => output[key]);
    }
    return output;
  }
  return visit(input, 0);
}

function variants(value: string): string[] {
  const encoded = encodeURIComponent(value);
  return [
    ...new Set([
      value,
      encoded,
      encodeURIComponent(encoded),
      encoded.replace(/%20/g, "+"),
      Buffer.from(value).toString("base64"),
      Buffer.from(value).toString("base64url"),
      JSON.stringify(value).slice(1, -1),
    ]),
  ];
}

/** In-memory per-report registry. Never serialize this object; only export checked JSON.
 * Detects common patterns and registered values, not arbitrary names/PII or screenshots.
 */
export function createEvidenceRedactor(seededValues: readonly string[] = [], salt: Uint8Array = randomBytes(32)) {
  if (salt.byteLength < 32) throw new Error("Redaction salt must contain at least 32 bytes");
  if (seededValues.length > 256 || seededValues.some((value) => !value.length || value.length > 4096))
    throw new Error("Invalid synthetic value registry");
  const secret = Buffer.from(salt);
  const pseudonym = (value: string) => `[redacted:${createHmac("sha256", secret).update(value).digest("hex").slice(0, 24)}]`;
  const protect = (value: string) => (completeMarker.test(value) ? value : pseudonym(value));
  const registry = seededValues
    .flatMap((value) => variants(value).map((variant) => ({ variant, replacement: pseudonym(value) })))
    .sort((a, b) => b.variant.length - a.variant.length);
  function outsideMarkers(value: string, transform: (part: string) => string): string {
    return value
      .split(/(\[redacted:[a-f0-9]{24}\])/g)
      .map((part, index) => (index % 2 ? part : transform(part)))
      .join("");
  }
  function redactString(input: string): string {
    let value = input;
    for (const item of registry) value = outsideMarkers(value, (part) => part.split(item.variant).join(item.replacement));
    // Query values are private even when they do not resemble known PII. Applies to relative URLs too.
    value = value.replace(/([?&][^\s?&#=]+)=([^\s&#]*)/g, (_all, key: string, raw: string) => `${key}=${protect(raw)}`);
    // Fragments can carry OAuth tokens or application state; do not retain their values.
    value = value.replace(urlFragment, (_all, url: string, fragment: string) => `${url}#${fragment ? protect(fragment) : ""}`);
    value = value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, (_all, scheme: string) => `${scheme}[credentials-redacted]@`);
    for (const pattern of patterns) value = outsideMarkers(value, (part) => part.replace(pattern, (match) => pseudonym(match)));
    return value;
  }
  function scan(input: unknown): { safeToShare: boolean; findings: string[]; version: string } {
    const findings = new Set<string>();
    mapEvidenceJson(input, (value) => {
      const unmarked = value.replace(marker, "");
      if (registry.some(({ variant }) => unmarked.includes(variant))) findings.add("seeded-value");
      let decoded = unmarked;
      for (let round = 0; round < 3; round++) {
        for (const pattern of patterns) {
          pattern.lastIndex = 0;
          if (pattern.test(decoded)) findings.add("sensitive-pattern");
        }
        try {
          decoded = decodeURIComponent(decoded);
        } catch {
          break;
        }
      }
      if (/[?&][^\s?&#=]+=[^\s&#]+/.test(unmarked)) findings.add("query-value");
      for (const match of value.matchAll(urlFragment)) {
        if (match[2] && !completeMarker.test(match[2])) findings.add("url-fragment");
      }
      if (/https?:\/\/[^\s/@]+:[^\s/@]+@/i.test(unmarked)) findings.add("url-credentials");
      return value;
    });
    function inspectFields(value: unknown): void {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (sensitiveKey.test(key) && !(typeof child === "string" && completeMarker.test(child))) findings.add("sensitive-field");
        inspectFields(child);
      }
    }
    // Input has already passed bounded, accessor-free JSON validation above.
    inspectFields(input);
    return { safeToShare: findings.size === 0, findings: [...findings].sort(), version: REDACTION_VERSION };
  }
  function redact(input: unknown): EvidenceJson {
    const clean = mapEvidenceJson(input, redactString);
    function scrub(value: EvidenceJson): EvidenceJson {
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === "object") {
        for (const key of Object.keys(value))
          value[key] = sensitiveKey.test(key)
            ? protect(typeof value[key] === "string" ? value[key] : JSON.stringify(value[key]))
            : scrub(value[key]);
      }
      return value;
    }
    return scrub(clean);
  }
  function assertSafe(input: unknown): void {
    if (!scan(input).safeToShare) throw new Error("Evidence export blocked: residual sensitive data");
  }
  return { redact, scan, assertSafe };
}

export type EvidenceRedactor = ReturnType<typeof createEvidenceRedactor>;
