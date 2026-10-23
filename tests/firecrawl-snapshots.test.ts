import { beforeAll, beforeEach, expect, test, vi } from "vitest";

const { save, scrape, search } = vi.hoisted(() => ({
  save: vi.fn(async (_url: string, _markdown: string, _json?: unknown) => "hash"),
  scrape: vi.fn(async () => ({ markdown: "# Funding\nAcme raised $2 million.", json: { rounds: ["Acme"] } })),
  search: vi.fn(async () => ({ web: [{ url: "https://example.com/news", markdown: "# News\nAcme raised $2 million." }] })),
}));

vi.mock("@fireround/core/snapshots", () => ({ savePageSnapshot: save }));
vi.mock("@fireround/core/web", () => ({
  NativeWebClient: class {
    scrape = scrape;
    search = search;
  },
}));

import { getWebClient } from "../lib/web-client.ts";

beforeAll(() => {
  process.env.FIRECRAWL_API_KEY = "fc-test";
});
beforeEach(() => {
  save.mockReset().mockResolvedValue("hash");
  scrape.mockClear();
  search.mockClear();
});

test("captures extraction markdown and raw JSON but skips links-only scrapes", async () => {
  const client = getWebClient();
  const doc = await client.scrape("https://example.com/raise", { formats: ["markdown"] });
  expect(doc.markdown).toContain("Acme raised");
  expect(save).toHaveBeenCalledWith("https://example.com/raise", doc.markdown, doc.json);
  await client.scrape("https://example.com/links", { formats: ["links"] });
  expect(save).toHaveBeenCalledTimes(1);
});

test("a failed snapshot write never fails a scrape or search", async () => {
  const client = getWebClient();
  save.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(client.scrape("https://example.com/raise", { formats: ["markdown"] })).resolves.toHaveProperty("markdown");
  save.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(client.search("Acme", { scrapeOptions: { formats: ["markdown"] } })).resolves.toHaveProperty("web");
  expect(save).toHaveBeenCalledWith("https://example.com/news", "# News\nAcme raised $2 million.");
});
