// Investor URLs use hyphen slugs, and the "%20" URLs handed out before them redirect (P1-12).
import { NextRequest } from "next/server";
import { describe, expect, test, vi } from "vitest";
import { investorHref, investorIdFromParam, legacyInvestorPath } from "../lib/links";
import { proxy } from "../proxy";

describe("investor slugs", () => {
  test("an id's spaces become hyphens, and the slug reads back to the id", () => {
    expect(investorHref("sequoia capital india")).toBe("/investors/sequoia-capital-india");
    expect(investorHref("sequoia")).toBe("/investors/sequoia");
    expect(investorIdFromParam("sequoia-capital-india")).toBe("sequoia capital india");
    // An old URL's param, encoded or not, reads to the same id.
    expect(investorIdFromParam("sequoia%20capital%20india")).toBe("sequoia capital india");
    expect(investorIdFromParam("sequoia capital india")).toBe("sequoia capital india");
  });

  test("an old %20 URL moves to the slug, its tail kept; a slug URL and other paths stay", () => {
    expect(legacyInvestorPath("/investors/sequoia%20capital%20india")).toBe("/investors/sequoia-capital-india");
    expect(legacyInvestorPath("/investors/the%20moon/opengraph-image-jndh0d")).toBe("/investors/the-moon/opengraph-image-jndh0d");
    expect(legacyInvestorPath("/investors/sequoia-capital-india")).toBeNull();
    expect(legacyInvestorPath("/investors")).toBeNull();
    expect(legacyInvestorPath("/companies/prevision%20medicine")).toBeNull();
  });
});

describe("the proxy", () => {
  test("answers an old investor URL with a permanent redirect to its slug, query kept", async () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    const res = await proxy(new NextRequest("https://fireround.dev/investors/sequoia%20capital%20india?tab=rounds"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://fireround.dev/investors/sequoia-capital-india?tab=rounds");
    vi.unstubAllEnvs();
  });
});
