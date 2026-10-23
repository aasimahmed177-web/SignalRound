import { expect, test, vi } from "vitest";

vi.mock("@/lib/dashboard-auth.server", () => ({ requireDashboard: vi.fn() }));
const calls = vi.hoisted(() => ({ search: vi.fn(async () => ({ web: [], news: [] })), scrape: vi.fn(async () => ({ markdown: "Page" })) }));
vi.mock("@fireround/core/web", () => ({
  NativeWebClient: class {
    search = calls.search;
    scrape = calls.scrape;
  },
  auditFunnel: vi.fn(),
  readDiscussion: vi.fn(),
}));
vi.mock("@/lib/browser-audit", () => ({ auditRenderedPage: vi.fn() }));
vi.mock("@/lib/questionnaire-replay", () => ({
  runQuestionnaireDryRun: vi.fn(async () => {
    const nested = Object.create(null) as Record<string, unknown>;
    nested.safe = true;
    return { nested };
  }),
}));

import { analyzeFunnelUrlAction, runQuestionnaireReplayAction, runWebTool } from "../app/(dashboard)/scraper/actions";

test("external readers and search require explicit sharing consent before invoking a provider", async () => {
  for (const mode of ["reader", "search"]) {
    const result = await runWebTool(mode, "https://example.com", 5);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Confirm sharing") });
  }
  expect(calls.search).not.toHaveBeenCalled();
  expect(calls.scrape).not.toHaveBeenCalled();
});

test("direct reads need no intermediary consent; explicit consent permits search", async () => {
  expect(await runWebTool("scrape", "https://example.com", 5)).toMatchObject({ ok: true });
  expect(await runWebTool("search", "public documents", 5, true)).toMatchObject({ ok: true });
  expect(calls.search).toHaveBeenCalledWith("public documents", { limit: 5 });
});

test("URL analysis hides values and replay reports cross the action boundary as plain JSON", async () => {
  const url = await analyzeFunnelUrlAction("https://example.com/?utm_source=meta&email=person%40example.com");
  expect(url).toMatchObject({ ok: true, value: { attributionKeys: ["utm_source"], identityKeys: ["email"] } });
  expect(JSON.stringify(url)).not.toContain("person@example.com");
  const replay = await runQuestionnaireReplayAction('{"fixture":true}');
  expect(replay).toMatchObject({ ok: true, value: { nested: { safe: true } } });
  if (replay.ok) expect(Object.getPrototypeOf((replay.value as { nested: object }).nested)).toBe(Object.prototype);
});
