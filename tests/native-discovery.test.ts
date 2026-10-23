import { beforeEach, expect, test, vi } from "vitest";

const fakes = vi.hoisted(() => ({ search: vi.fn(), scrape: vi.fn(), collect: vi.fn(), contacts: vi.fn() }));
vi.mock("../lib/web-client.ts", () => ({ getWebClient: () => ({ search: fakes.search, scrape: fakes.scrape }) }));
vi.mock("../lib/native-collector.ts", () => ({ collectNativeSignals: fakes.collect, collectContacts: fakes.contacts }));

import { discoverNativeSignals } from "../lib/native-discovery";

beforeEach(() => {
  vi.resetAllMocks();
  fakes.collect.mockResolvedValue([]);
});

test("a blocked search is reported as limited feed coverage, not successful whole-web search", async () => {
  fakes.search.mockRejectedValue(new Error("Search rate limited"));
  const result = await discoverNativeSignals("robotics startups");
  expect(result.warnings.join(" ")).toContain("limited coverage");
  expect(result.warnings.join(" ")).toContain("Search rate limited");
  expect(fakes.collect).toHaveBeenCalledWith(
    expect.objectContaining({ query: "robotics startups", limit: 5, jinaFallback: false, signal: expect.any(AbortSignal) }),
  );
});

test("search results remain source leads and respect a bounded recent window", async () => {
  fakes.search.mockResolvedValue({
    web: [{ url: "https://news.example/acme", title: "Acme raises $2M seed funding", description: "Announcement" }],
  });
  await discoverNativeSignals("Acme");
  expect(fakes.search).toHaveBeenCalledWith(
    expect.stringContaining("Acme"),
    expect.objectContaining({ tbs: expect.stringMatching(/^cdr:1,cd_min:\d+\/\d+\/\d{4},cd_max:\d+\/\d+\/\d{4}$/), limit: 10 }),
  );
  expect(fakes.collect).toHaveBeenCalledWith(
    expect.objectContaining({ items: [expect.objectContaining({ url: "https://news.example/acme", feedUrl: "live-search" })] }),
  );
});

test("a website with no public inbox does not manufacture a contact or verified round", async () => {
  fakes.scrape.mockResolvedValue({ markdown: "Acme builds robots.", metadata: { sourceURL: "https://acme.example/", title: "Acme" } });
  fakes.contacts.mockResolvedValue({ contacts: [], methods: ["direct"] });
  const result = await discoverNativeSignals("https://acme.example/");
  expect(result.observations[0].contacts).toEqual([]);
  expect(result.observations[0].amountAsWritten).toBeNull();
  expect(result.observations[0].input.confidence).toBeNull();
  expect(result.warnings[0]).toContain("No address was guessed");
  expect(fakes.search).not.toHaveBeenCalled();
});
