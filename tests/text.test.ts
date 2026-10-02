import { describe, expect, test } from "vitest";
import { capitalizeFirst, groupDigits } from "../lib/text";

describe("capitalizeFirst", () => {
  test("a lowercase sentence start gets its capital, and nothing else changes", () => {
    expect(capitalizeFirst("a sales prospecting platform based in Europe")).toBe("A sales prospecting platform based in Europe");
    expect(capitalizeFirst("developer of AI tools for SMBs")).toBe("Developer of AI tools for SMBs");
    expect(capitalizeFirst("x")).toBe("X");
    expect(capitalizeFirst("élan for payroll")).toBe("Élan for payroll");
  });

  test("text that already starts with a capital is unchanged", () => {
    expect(capitalizeFirst("An AI platform for lawyers")).toBe("An AI platform for lawyers");
  });

  test("brand names written in lowercase-first camel case are left alone", () => {
    expect(capitalizeFirst("eBay for vintage watches")).toBe("eBay for vintage watches");
    expect(capitalizeFirst("iRobot's rival in lawn care")).toBe("iRobot's rival in lawn care");
    expect(capitalizeFirst("iOS-first banking")).toBe("iOS-first banking");
  });

  test("domains, leading numbers and non-letters are left alone", () => {
    expect(capitalizeFirst("stripe.com for invoices")).toBe("stripe.com for invoices");
    expect(capitalizeFirst("3d printing for dentists")).toBe("3d printing for dentists");
    expect(capitalizeFirst("b2b payments in Brazil")).toBe("b2b payments in Brazil");
    expect(capitalizeFirst("24/7 support desk")).toBe("24/7 support desk");
    expect(capitalizeFirst(" leading space")).toBe(" leading space");
    expect(capitalizeFirst('"quoted" start')).toBe('"quoted" start');
  });

  test("a trailing period on the first word is not a domain", () => {
    expect(capitalizeFirst("inc. filings, simplified")).toBe("Inc. filings, simplified");
  });

  test("nullish and empty pass through so a fallback still applies", () => {
    expect(capitalizeFirst(null)).toBeNull();
    expect(capitalizeFirst(undefined)).toBeUndefined();
    expect(capitalizeFirst("")).toBe("");
    expect(capitalizeFirst(null) ?? "example.com").toBe("example.com");
  });
});

describe("groupDigits", () => {
  test("groups thousands and leaves small counts alone", () => {
    expect(groupDigits(7)).toBe("7");
    expect(groupDigits(350)).toBe("350");
    expect(groupDigits(1565)).toBe("1,565");
    expect(groupDigits(1234567)).toBe("1,234,567");
  });
});
