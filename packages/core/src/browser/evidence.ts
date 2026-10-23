import { createHash } from "node:crypto";
import { type EvidenceJson, type EvidenceRedactor, mapEvidenceJson, REDACTION_VERSION } from "./redaction.ts";

export const BROWSER_EVIDENCE_LEVELS = [
  "declared-in-source",
  "runtime-function-invoked",
  "request-attempted",
  "request-transmitted",
  "response-received",
] as const;
export type BrowserEvidenceLevel = (typeof BROWSER_EVIDENCE_LEVELS)[number];

export function canonicalEvidenceJson(input: unknown): string {
  const clean = mapEvidenceJson(input, (value) => value);
  function encode(value: EvidenceJson): string {
    if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
    if (value && typeof value === "object")
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(value[key])}`)
        .join(",")}}`;
    return JSON.stringify(value);
  }
  return encode(clean);
}

/** A response alone cannot establish platform acceptance or backend persistence.
 * Level is an explicit observation supplied by the caller, never inferred from payload/status.
 */
export function createBrowserEvidence(
  input: {
    observedAt: string;
    mode: "fixture" | "observation-only" | "authorized-synthetic";
    level: BrowserEvidenceLevel;
    source: { kind: "dom" | "runtime" | "network" | "source"; locator: string };
    payload: unknown;
  },
  redactor: EvidenceRedactor,
) {
  if (!BROWSER_EVIDENCE_LEVELS.includes(input.level)) throw new Error("Unsupported browser evidence level");
  if (!["fixture", "observation-only", "authorized-synthetic"].includes(input.mode)) throw new Error("Invalid evidence mode");
  if (!Number.isFinite(Date.parse(input.observedAt)) || new Date(input.observedAt).toISOString() !== input.observedAt)
    throw new Error("Evidence timestamp must be canonical UTC ISO");
  if (!["dom", "runtime", "network", "source"].includes(input.source.kind) || !input.source.locator)
    throw new Error("Invalid evidence source");
  const redacted = redactor.redact({ source: input.source, payload: input.payload });
  redactor.assertSafe(redacted);
  const body = {
    schemaVersion: "browser-evidence-v1",
    redactionVersion: REDACTION_VERSION,
    observedAt: input.observedAt,
    mode: input.mode,
    level: input.level,
    backendOutcome: "unknown",
    redacted,
  };
  const sha256 = createHash("sha256").update(canonicalEvidenceJson(body)).digest("hex");
  return {
    ...body,
    id: `evidence:${sha256}`,
    sha256,
    exportCheck: { passed: true, scope: "registered-values-and-recognized-patterns-only" },
  };
}
