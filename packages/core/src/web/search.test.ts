import { describe, expect, test } from "vitest";
import { resolveSearchProvider, searchDateRange, searchProviderStatus, withinSearchDate } from "./search.ts";

describe("search provider configuration", () => {
  test("explicit provider overrides configured alternatives", () => {
    const env = { NATIVE_SEARCH_PROVIDER: "duckduckgo", SEARXNG_URL: "https://search.example", AGENT_REACH_MCPORTER: "/private/tool" };
    expect(resolveSearchProvider(env)).toBe("duckduckgo");
    expect(searchProviderStatus(env)).toContain("DuckDuckGo Lite selected");
    expect(resolveSearchProvider({ SEARXNG_URL: "https://search.example", AGENT_REACH_MCPORTER: "/private/tool" })).toBe("searxng");
    expect(resolveSearchProvider({ AGENT_REACH_MCPORTER: "/private/tool" })).toBe("agent-reach");
    expect(resolveSearchProvider({})).toBe("duckduckgo");
  });
  test("reports missing or invalid configuration without disclosing secrets", () => {
    expect(searchProviderStatus({ NATIVE_SEARCH_PROVIDER: "searxng" })).toContain("missing");
    for (const url of ["invalid", "file:///private/path", "https://user:secret@search.example"])
      expect(searchProviderStatus({ SEARXNG_URL: url })).toContain("invalid");
    expect(searchProviderStatus({ NATIVE_SEARCH_PROVIDER: "secret-bad-provider" })).not.toContain("secret-bad-provider");
    expect(searchProviderStatus({ NATIVE_SEARCH_PROVIDER: "agent-reach" })).toContain("Neither has been verified");
    const configured = searchProviderStatus({ AGENT_REACH_MCPORTER: "/private/tool" });
    expect(configured).not.toContain("/private/tool");
    expect(configured).toContain("have not been tested");
    expect(searchProviderStatus({ SEARXNG_URL: "https://search.example" })).toContain("have not been tested");
  });
});

describe("custom search date windows", () => {
  test("rejects invalid calendar days and incomplete windows", () => {
    for (const window of [
      "cdr:1,cd_min:2/31/2026,cd_max:3/1/2026",
      "cdr:1,cd_min:2/29/2026,cd_max:3/1/2026",
      "cdr:1,cd_min:13/1/2026,cd_max:13/2/2026",
      "cdr:1,cd_min:10/2/2026,cd_max:10/1/2026",
      "cdr:1,cd_min:10/1/2026",
    ])
      expect(() => searchDateRange(window)).toThrow("Invalid search date range");
    expect(searchDateRange("cdr:1,cd_min:2/29/2028,cd_max:3/1/2028")?.duckFilter).toBe("2028-02-29..2028-03-01");
  });
  test("includes the entire last day but excludes next-day midnight", () => {
    const tbs = "cdr:1,cd_min:10/1/2026,cd_max:10/2/2026";
    const hit = { url: "https://example.org" };
    expect(withinSearchDate({ ...hit, date: "2026-10-01T00:00:00.000Z" }, tbs)).toBe(true);
    expect(withinSearchDate({ ...hit, date: "2026-10-02T23:59:59.999Z" }, tbs)).toBe(true);
    expect(withinSearchDate({ ...hit, date: "2026-10-03T00:00:00.000Z" }, tbs)).toBe(false);
    expect(withinSearchDate({ ...hit, date: "2026-09-30T23:59:59.999Z" }, tbs)).toBe(false);
    expect(withinSearchDate(hit, tbs)).toBe(true);
  });
});
