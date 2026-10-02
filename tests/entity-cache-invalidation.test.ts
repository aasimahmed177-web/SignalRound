import { afterEach, describe, expect, test, vi } from "vitest";

const { revalidateTag } = vi.hoisted(() => ({ revalidateTag: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag }));

import { POST } from "../app/api/cache/invalidate/route";
import { invalidateAllEntityPages, invalidateEntityPages } from "../lib/entity-invalidation";
import { companyTag, investorTag, TAG_ENTITY_DETAILS } from "../lib/entity-tags";
import { persistRecords } from "../lib/persist";
import { invalidateScriptEntityPages } from "../lib/script-cache-invalidation";
import { record, testDb } from "./helpers";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  revalidateTag.mockReset();
});

test("a workflow without a Next render context sends an authenticated invalidation", async () => {
  vi.stubEnv("APP_ORIGIN", "https://example.test");
  vi.stubEnv("CRON_SECRET", "test-secret");
  revalidateTag.mockImplementation(() => {
    throw new Error("Invariant: static generation store missing in revalidateTag");
  });
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetch);

  await invalidateAllEntityPages();
  expect(fetch).toHaveBeenCalledWith("https://example.test/api/cache/invalidate", {
    method: "POST",
    headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
    body: JSON.stringify({ tags: ["entity-details"] }),
  });
});

describe("entity cache invalidation endpoint", () => {
  const post = (tags: unknown, token = "test-secret") =>
    POST(
      new Request("http://localhost/api/cache/invalidate", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ tags }),
      }),
    );

  test("requires the cron secret before invalidating anything", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await post([companyTag("acme")], "")).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "test-secret");
    expect((await post([companyTag("acme")], "wrong")).status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  test("rejects malformed or overlarge requests without partial invalidation", async () => {
    vi.stubEnv("CRON_SECRET", "test-secret");
    expect((await post([companyTag("acme"), "rounds"])).status).toBe(400);
    expect((await post(Array(5001).fill(companyTag("acme")))).status).toBe(400);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  test("only accepts bounded entity tags and invalidates duplicates once", async () => {
    vi.stubEnv("CRON_SECRET", "test-secret");
    expect((await post(["rounds"])).status).toBe(400);
    expect((await post(["company:"])).status).toBe(400);
    expect((await post(Array(5001).fill(companyTag("acme")))).status).toBe(400);
    expect((await post([companyTag("acme"), companyTag("acme"), investorTag("fund"), "entity-details"])).status).toBe(204);
    expect(revalidateTag.mock.calls).toEqual([
      [companyTag("acme"), { expire: 0 }],
      [investorTag("fund"), { expire: 0 }],
      ["entity-details", { expire: 0 }],
    ]);
  });
});

test("a script targeting a remote database requires credentials and propagates invalidation failure", async () => {
  vi.stubEnv("DATABASE_URL", "postgres://user:pass@db.example.test/fireround");
  vi.stubEnv("APP_ORIGIN", "https://example.test");
  vi.stubEnv("CRON_SECRET", "");
  await expect(invalidateScriptEntityPages()).rejects.toThrow("CRON_SECRET");
  vi.stubEnv("CRON_SECRET", "test-secret");
  const fetch = vi.fn(async () => new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  await expect(invalidateScriptEntityPages()).rejects.toThrow("503");
  expect(fetch).toHaveBeenCalledWith("https://example.test/api/cache/invalidate", {
    method: "POST",
    headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
    body: JSON.stringify({ tags: ["entity-details"] }),
  });
});

test("a changed round expires its company and investors, including investors on sibling rounds", async () => {
  const handle = await testDb();
  const first = record({
    company_name: "Acme",
    company_domain: "acme.example",
    lead_investors: ["First Fund"],
    sources: [{ url: "https://wire.example/first", host: "wire.example", title: "First" }],
  });
  const second = record({
    company_name: "Acme",
    company_domain: "acme.example",
    announced_date: "2026-01-02",
    lead_investors: ["Second Fund"],
    sources: [{ url: "https://wire.example/second", host: "wire.example", title: "Second" }],
  });
  const summary = await persistRecords(handle, [first, second], "series-a-b", "run-1");

  await invalidateEntityPages(handle, { roundIds: [summary.changedIds[0]] });
  expect(new Set(revalidateTag.mock.calls.map(([tag]) => tag))).toEqual(
    new Set([companyTag("acme.example"), investorTag("first"), investorTag("second"), TAG_ENTITY_DETAILS]),
  );
  expect(revalidateTag.mock.calls.every(([, profile]) => profile.expire === 0)).toBe(true);
});
