import { afterEach, expect, test, vi } from "vitest";
import { getWebClient } from "../lib/web-client";

afterEach(() => vi.unstubAllEnvs());

test("native web client initializes with no vendor key", () => {
  vi.stubEnv("FIRECRAWL_API_KEY", "");
  expect(getWebClient()).toBeDefined();
  expect(typeof getWebClient().scrape).toBe("function");
  expect(typeof getWebClient().search).toBe("function");
});
