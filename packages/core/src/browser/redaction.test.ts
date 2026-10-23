import { describe, expect, it } from "vitest";
import { createEvidenceRedactor, mapEvidenceJson } from "./redaction.ts";

describe("bounded JSON evidence redaction", () => {
  it("redacts seeded values including URL/base64 encodings and correlates repeats", () => {
    const name = "Synthetic Audit Person";
    const redactor = createEvidenceRedactor([name], Buffer.alloc(32, 7));
    const output = redactor.redact({
      first: name,
      again: name,
      encoded: encodeURIComponent(encodeURIComponent(name)),
      base64: Buffer.from(name).toString("base64"),
      url: `https://example.test/${encodeURIComponent(name)}?unusual=anything&empty=`,
    });
    const fields = output as Record<string, string>;
    expect(fields.first).toBe(fields.again);
    expect(fields.encoded).toBe(fields.first);
    expect(fields.base64).toBe(fields.first);
    expect(JSON.stringify(output)).not.toContain("anything");
    expect(redactor.scan(output).safeToShare).toBe(true);
    expect(redactor.scan({ encoded: encodeURIComponent(name) }).safeToShare).toBe(false);
    expect(() => redactor.assertSafe({ name })).toThrow("export blocked");
  });
  it("redacts common sensitive strings, sensitive fields, keys, and URL credentials", () => {
    const redactor = createEvidenceRedactor();
    const result = redactor.redact({
      raw: "person@example.com +1 202-555-0147 sk-abcdefghijklmnopqrstuv eyJabcd.efgh.ijkl",
      password: "short",
      "person@example.com": "https://user:pass@example.test/?tracking=visitor-123",
    });
    expect(redactor.scan(result).safeToShare).toBe(true);
    for (const secret of ["person@example.com", "202-555-0147", "short", "user:pass", "visitor-123"])
      expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("uses different per-report salts without exporting them", () => {
    const a = createEvidenceRedactor(["unique-seed"]);
    const b = createEvidenceRedactor(["unique-seed"]);
    expect(a.redact("unique-seed")).not.toBe(b.redact("unique-seed"));
    expect(JSON.stringify(a)).toBe("{}");
  });
  it("rejects cycles, getters, nonfinite numbers, exotic objects and oversized input", () => {
    const bad: Record<string, unknown> = {};
    bad.self = bad;
    for (const value of [
      bad,
      NaN,
      Infinity,
      undefined,
      new Date(),
      "x".repeat(100001),
      {
        get secret() {
          throw new Error("getter ran");
        },
      },
    ])
      expect(() => mapEvidenceJson(value, (s) => s)).toThrow();
    let deep: unknown = "x";
    for (let i = 0; i < 18; i++) deep = { deep };
    expect(() => mapEvidenceJson(deep, (s) => s)).toThrow("budget");
    expect(() => mapEvidenceJson(Array(10001).fill(0), (s) => s)).toThrow("budget");
  });
  it("fails closed on residual patterns and arbitrary query values", () => {
    const redactor = createEvidenceRedactor();
    for (const input of [
      "contact: test@example.com",
      "test%40example.com",
      { password: "tiny" },
      "/path?arbitrary=private",
      "x".repeat(50),
    ])
      expect(() => redactor.assertSafe(input)).toThrow();
  });
  it("does not re-redact generated pseudonyms as phone numbers or short seeds", () => {
    const redactor = createEvidenceRedactor(["a"], Buffer.alloc(32, 2));
    const result = redactor.redact("a");
    expect(result).toMatch(/^\[redacted:[a-f0-9]{24}\]$/);
    expect(redactor.scan(result).safeToShare).toBe(true);
  });
  it("keeps seeded identity correlation across text, fields and queries and is idempotent", () => {
    const email = "synthetic.person@example.com";
    const redactor = createEvidenceRedactor([email], Buffer.alloc(32, 3));
    const result = redactor.redact({
      note: email,
      email,
      url: `https://example.test/?email=${encodeURIComponent(email)}`,
      password: "short",
    }) as Record<string, string>;
    expect(result.note).toBe(result.email);
    expect(result.url).toBe(`https://example.test/?email=${result.note}`);
    expect(redactor.redact(result)).toEqual(result);
    expect(redactor.scan(result).safeToShare).toBe(true);
  });
  it("redacts and gates URL fragments including short OAuth tokens", () => {
    const redactor = createEvidenceRedactor();
    for (const url of ["https://example.test/#access_token=short&state=private", "/callback#token", "URL https://example.test/#private"]) {
      expect(redactor.scan(url).findings).toContain("url-fragment");
      const result = redactor.redact(url);
      expect(result).not.toContain("private");
      expect(result).not.toContain("short");
      expect(redactor.scan(result).safeToShare).toBe(true);
      expect(redactor.redact(result)).toEqual(result);
    }
    expect(redactor.scan("https://example.test/#").safeToShare).toBe(true);
  });
});
