import { describe, expect, it } from "vitest";
import { type BrowserEvidenceLevel, canonicalEvidenceJson, createBrowserEvidence } from "./evidence.ts";
import { createEvidenceRedactor } from "./redaction.ts";

const input = {
  observedAt: "2026-10-23T10:00:00.000Z",
  mode: "fixture" as const,
  level: "request-attempted" as const,
  source: { kind: "network" as const, locator: "https://example.test/?email=person@example.com" },
  payload: { b: 2, a: 1 },
};
describe("redacted browser evidence envelope", () => {
  it("hashes canonical redacted evidence independent of object order", () => {
    const redactor = createEvidenceRedactor([], Buffer.alloc(32, 1));
    const a = createBrowserEvidence(input, redactor);
    const b = createBrowserEvidence({ ...input, payload: { a: 1, b: 2 } }, redactor);
    expect(a.sha256).toBe(b.sha256);
    expect(a.id).toBe(`evidence:${a.sha256}`);
    expect(JSON.stringify(a)).not.toContain("person@example.com");
    expect(canonicalEvidenceJson({ z: 1, a: { z: 3, b: 2 } })).toBe('{"a":{"b":2,"z":3},"z":1}');
  });
  it("does not upgrade attempts or HTTP responses into acceptance", () => {
    const redactor = createEvidenceRedactor();
    const response = createBrowserEvidence({ ...input, level: "response-received", payload: { status: 200, accepted: true } }, redactor);
    expect(response.level).toBe("response-received");
    expect(response.backendOutcome).toBe("unknown");
    for (const level of ["platform-accepted", "backend-persisted", "fired"])
      expect(() => createBrowserEvidence({ ...input, level: level as BrowserEvidenceLevel }, redactor)).toThrow();
  });
  it("rejects invalid timestamps and unsupported payloads", () => {
    const redactor = createEvidenceRedactor();
    expect(() => createBrowserEvidence({ ...input, observedAt: "yesterday" }, redactor)).toThrow();
    expect(() => createBrowserEvidence({ ...input, payload: { number: NaN } }, redactor)).toThrow();
  });
});
