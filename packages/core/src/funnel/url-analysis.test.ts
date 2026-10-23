import { describe, expect, it } from "vitest";
import { analyzeFunnelUrl, classifyFunnelParameter, inspectEventSnippets } from "./url-analysis.ts";

describe("funnel URL analysis", () => {
  it("classifies keys without exporting values", () => {
    const result = analyzeFunnelUrl(
      "https://example.com/quiz?utm_source=meta&utm_campaign=launch&fbclid=click-1&email=person%40example.com&visit_id=abc#step",
    );
    expect(result).toMatchObject({
      origin: "https://example.com",
      path: "/quiz",
      fragmentPresent: true,
      attributionKeys: ["utm_source", "utm_campaign", "fbclid"],
      identityKeys: ["email"],
    });
    expect(JSON.stringify(result)).not.toContain("person@example.com");
    expect(result.parameters.every((entry) => entry.value === "[redacted]")).toBe(true);
  });

  it.each([
    ["utm_content", "attribution"],
    ["gclid", "click-id"],
    ["name", "identity"],
    ["utm_name", "identity"],
    ["utm_email", "identity"],
    ["utm_phone", "identity"],
    ["external_id", "identity"],
    ["variant", "experiment"],
    ["session_id", "session"],
    ["custom", "other"],
  ] as const)("classifies %s as %s", (name, category) => expect(classifyFunnelParameter(name)).toBe(category));
});

describe("declared event snippets", () => {
  it("extracts vendor events and parameter names but scrubs values", () => {
    const source = `
      fbq('track', 'Lead', {email: 'person@example.com', value: 10});
      gtag('event', 'generate_lead', {currency: 'USD'});
      ttq.track('SubmitForm', {phone: '+1 202-555-0147'});
      dataLayer.push({event: 'qualified_lead', external_id: 'abcdef'});
    `;
    const events = inspectEventSnippets(source, "https://example.com/app.js");
    expect(events.map((event) => [event.vendor, event.event])).toEqual([
      ["meta", "Lead"],
      ["google", "generate_lead"],
      ["tiktok", "SubmitForm"],
      ["data-layer", "qualified_lead"],
    ]);
    expect(events[0]?.parameterNames).toEqual(expect.arrayContaining(["email", "value"]));
    expect(JSON.stringify(events)).not.toContain("person@example.com");
    expect(JSON.stringify(events)).not.toContain("202-555-0147");
    expect(events.every((event) => event.level === "declared-in-source")).toBe(true);
  });
});
