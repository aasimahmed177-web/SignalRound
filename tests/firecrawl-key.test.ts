// The one check every Firecrawl entry point makes: an unset key and the .env.example placeholder are both missing.
import { afterEach, expect, test, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("workflow/api", () => ({ start: vi.fn(async () => undefined) }));

import { startEnrich, startSweep } from "../app/(dashboard)/presets/actions";
import { firecrawlKey } from "../lib/firecrawl";

afterEach(() => vi.unstubAllEnvs());

test("an unset key and the .env.example placeholder are both missing", () => {
  vi.stubEnv("FIRECRAWL_API_KEY", "");
  expect(firecrawlKey()).toBeNull();
  vi.stubEnv("FIRECRAWL_API_KEY", "fc-YOUR-API-KEY");
  expect(firecrawlKey()).toBeNull();
  vi.stubEnv("FIRECRAWL_API_KEY", "fc-real");
  expect(firecrawlKey()).toBe("fc-real");
});

test("Run sweep and Enrich refuse up front without a key instead of starting a run that fails", async () => {
  vi.stubEnv("FIRECRAWL_API_KEY", "fc-YOUR-API-KEY");
  for (const result of [await startSweep("series-a-b", "week"), await startEnrich("series-a-b")]) {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/FIRECRAWL_API_KEY is not set/);
  }
});
