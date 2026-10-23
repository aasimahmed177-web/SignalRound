import assert from "node:assert/strict";
import { type BrowserEvidenceLevel, createBrowserEvidence } from "../packages/core/src/browser/evidence.ts";
import { authorizationManifestSchema, evaluateRequestPolicy } from "../packages/core/src/browser/policy.ts";
import { createEvidenceRedactor } from "../packages/core/src/browser/redaction.ts";

// Offline foundation checks only. This does not run a browser, contact a website, or submit a form.
const origin = "https://forms.example.com";
const email = "fixture-audit@example.com";
const state = { now: Date.parse("2026-10-23T00:00:00Z"), submissionsUsed: 0 };
const manifest = authorizationManifestSchema.parse({
  version: 1,
  mode: "authorized-synthetic-experiment",
  allowedOrigins: [origin],
  allowedWrites: [{ origin, path: "/api/submissions", method: "POST", purpose: "synthetic-questionnaire", payload: { email, income: 0 } }],
  forbiddenOrigins: [],
  forbiddenEndpoints: [],
  forbiddenActions: [],
  syntheticIdentityProfile: "offline-fixture",
  maxSubmissions: 1,
  expiresAt: "2026-10-24T00:00:00Z",
});
const request = {
  url: `${origin}/api/submissions`,
  method: "POST",
  action: "synthetic-questionnaire",
  hasCredentials: false,
  payload: { email, income: 0 },
};
const checks: string[] = [];
function check(name: string, run: () => void) {
  run();
  checks.push(name);
}

for (const mode of ["passive-map", "interactive-dry-run"]) {
  check(`${mode}: writes denied`, () => {
    const observation = { ...manifest, mode, allowedWrites: [], maxSubmissions: 0 };
    assert.equal(evaluateRequestPolicy(observation, request, state).allowed, false);
  });
}
check("approved synthetic payload: preflight only", () => {
  assert.deepEqual(evaluateRequestPolicy(manifest, request, state), { allowed: true, reason: "synthetic-write-preflight-only" });
  assert.equal(
    evaluateRequestPolicy(manifest, { ...request, payload: { email: "unapproved@example.com", income: 0 } }, state).allowed,
    false,
  );
});
check("submission budget exhausted: denied", () => {
  assert.equal(evaluateRequestPolicy(manifest, request, { ...state, submissionsUsed: 1 }).reason, "submission-budget-exhausted");
});
check("purchase: forbidden even in synthetic mode", () => {
  assert.equal(evaluateRequestPolicy(manifest, { ...request, action: "purchase" }, state).reason, "forbidden-action");
});

// Fixed salt is only for reproducible fixtures; production defaults to a fresh random salt per report.
const redactor = createEvidenceRedactor([email], new Uint8Array(32).fill(17));
const input = {
  observedAt: "2026-10-23T00:00:00.000Z",
  mode: "fixture" as const,
  level: "response-received" as const,
  source: { kind: "network" as const, locator: `${origin}/api/submissions` },
  payload: { status: 200, email, note: `Synthetic identity ${email}` },
};
const evidence = createBrowserEvidence(input, redactor);
check("evidence hashes ignore object key order", () => {
  const reordered = createBrowserEvidence({ ...input, payload: { note: input.payload.note, email, status: 200 } }, redactor);
  assert.equal(evidence.sha256, reordered.sha256);
});
check("fixture email redacted; raw seeded export blocked", () => {
  assert.equal(JSON.stringify(evidence).includes(email), false);
  redactor.assertSafe(evidence.redacted);
  assert.throws(() => redactor.assertSafe(input.payload), /export blocked/);
});
check("response does not prove platform acceptance or persistence", () => {
  assert.equal(evidence.backendOutcome, "unknown");
  assert.equal(evidence.level, "response-received");
  assert.throws(() => createBrowserEvidence({ ...input, level: "platform-accepted" as BrowserEvidenceLevel }, redactor), /Unsupported/);
});

console.log(
  JSON.stringify(
    {
      benchmark: "funnel-phase-zero-offline",
      passed: checks.length,
      checks,
      evidenceHash: evidence.sha256,
      scope: "Pure policy and JSON evidence only; no browser execution, network traffic, or live parity claim.",
    },
    null,
    2,
  ),
);
