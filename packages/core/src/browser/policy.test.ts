import { describe, expect, it } from "vitest";
import { authorizationManifestSchema, evaluateRequestPolicy } from "./policy.ts";

const origin = "https://forms.example.com";
const manifest = {
  version: 1,
  mode: "authorized-synthetic-experiment",
  allowedOrigins: [origin],
  allowedWrites: [
    {
      origin,
      path: "/api/submissions",
      method: "POST",
      purpose: "synthetic-questionnaire",
      payload: { name: "Synthetic Audit", income: 0 },
    },
  ],
  forbiddenOrigins: [],
  forbiddenEndpoints: [],
  forbiddenActions: [],
  syntheticIdentityProfile: "fixture-only",
  maxSubmissions: 2,
  expiresAt: "2026-10-24T00:00:00Z",
};
const state = { now: Date.parse("2026-10-23T00:00:00Z"), submissionsUsed: 0 };
const request = {
  url: `${origin}/api/submissions`,
  method: "POST",
  action: "synthetic-questionnaire",
  hasCredentials: false,
  payload: { name: "Synthetic Audit", income: 0 },
};
const decide = (change = {}, policy: unknown = manifest) => evaluateRequestPolicy(policy, { ...request, ...change }, state);

describe("phase-zero request policy", () => {
  it("allows only exact scoped synthetic payload and endpoint", () => {
    expect(decide()).toEqual({ allowed: true, reason: "synthetic-write-preflight-only" });
    for (const url of [
      `${origin}/api/submissions-extra`,
      `${origin}/api/submissions/`,
      `${origin}/api/submissions?admin=1`,
      "https://forms.example.com.evil.com/api/submissions",
    ]) {
      expect(decide({ url }).allowed).toBe(false);
    }
    for (const payload of [{ name: "Real Person", income: 0 }, { name: "Synthetic Audit" }, { ...request.payload, admin: true }])
      expect(decide({ payload }).reason).toBe("payload-not-authorized");
    expect(decide({ method: "DELETE" }).allowed).toBe(false);
  });
  it("has no permissive manifest defaults", () => {
    expect(authorizationManifestSchema.safeParse({}).success).toBe(false);
    expect(authorizationManifestSchema.safeParse({ ...manifest, unexpected: true }).success).toBe(false);
    expect(authorizationManifestSchema.safeParse({ ...manifest, maxSubmissions: "2" }).success).toBe(false);
    expect(authorizationManifestSchema.safeParse({ ...manifest, allowedOrigins: [`${origin}/`] }).success).toBe(false);
    expect(authorizationManifestSchema.safeParse({ ...manifest, syntheticIdentityProfile: undefined }).success).toBe(false);
  });
  it.each(["passive-map", "interactive-dry-run"])("blocks writes in %s", (mode) => {
    const passive = { ...manifest, mode, allowedWrites: [], maxSubmissions: 0 };
    expect(evaluateRequestPolicy(passive, request, state).reason).toBe("writes-disabled");
    expect(
      evaluateRequestPolicy(passive, { url: `${origin}/survey`, method: "GET", action: "read", hasCredentials: false }, state).allowed,
    ).toBe(true);
    expect(authorizationManifestSchema.safeParse({ ...manifest, mode }).success).toBe(false);
  });
  it("rejects expiry and exhausted or invalid budgets", () => {
    expect(evaluateRequestPolicy(manifest, request, { ...state, now: Date.parse(manifest.expiresAt) }).reason).toBe("manifest-expired");
    expect(evaluateRequestPolicy(manifest, request, { ...state, submissionsUsed: 2 }).reason).toBe("submission-budget-exhausted");
    for (const submissionsUsed of [-1, NaN, 0.5])
      expect(evaluateRequestPolicy(manifest, request, { ...state, submissionsUsed }).reason).toBe("invalid-state");
  });
  it("gives prohibitions precedence over authorization", () => {
    expect(decide({}, { ...manifest, forbiddenOrigins: [origin] }).reason).toBe("forbidden-origin");
    expect(decide({}, { ...manifest, forbiddenEndpoints: [{ origin, path: "/api/submissions" }] }).reason).toBe("forbidden-endpoint");
    expect(decide({}, { ...manifest, forbiddenActions: [request.action] }).reason).toBe("forbidden-action");
    expect(decide({ action: "purchase" }).reason).toBe("forbidden-action");
    expect(decide({ hasCredentials: true }).reason).toBe("credentials-forbidden");
    const payment = { ...manifest, allowedWrites: [{ ...manifest.allowedWrites[0], path: "/api/payment" }] };
    expect(decide({ url: `${origin}/api/payment` }, payment).reason).toBe("dangerous-url");
  });
  it.each([
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://[::1]/",
    "http://192.168.1.1/",
    "https://host.local/",
    "https://localhost/",
    "https://forms.example.com:8443/",
    "https://user:password@forms.example.com/",
    "file:///etc/passwd",
  ])("rejects unsafe URL %s", (url) => {
    expect(decide({ url }).reason).toBe("unsafe-url");
  });
  it.each(["/checkout", "/api?act=delete", "/api?action=%70urchase", "/%63heckout", "/api?redirect=/send", "/register"])(
    "blocks dangerous GET %s",
    (path) => {
      expect(
        evaluateRequestPolicy(manifest, { url: origin + path, method: "GET", action: "read", hasCredentials: false }, state).allowed,
      ).toBe(false);
    },
  );
  it("fails closed for unclassified actions or incomplete request facts", () => {
    expect(
      evaluateRequestPolicy(
        manifest,
        { url: `${origin}/api?action=%2570urchase`, method: "GET", action: "read", hasCredentials: false },
        state,
      ).reason,
    ).toBe("ambiguous-query");
    expect(decide({ action: "unknown" }).allowed).toBe(false);
    expect(decide({ hasCredentials: undefined }).reason).toBe("invalid-request");
    expect(decide({ method: "post" }).reason).toBe("invalid-request");
  });
});
