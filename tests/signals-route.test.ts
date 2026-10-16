import type { Db } from "@fireround/core/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb } from "./helpers";

let handle: Db;
vi.mock("@/lib/db", () => ({ db: async () => handle }));

const URL = "http://localhost/api/v1/signals";
const BODY = {
  channel: "linkedin",
  url: "https://example.com/company-post",
  title: "Example announces a new partner",
};

describe("POST /api/v1/signals", () => {
  beforeEach(async () => {
    handle = await testDb();
    vi.stubEnv("SIGNAL_INGEST_KEY", "test-signal-key");
  });

  afterEach(() => vi.unstubAllEnvs());

  test("requires its dedicated bearer", async () => {
    const { POST } = await import("../app/api/v1/signals/route");
    const response = await POST(new Request(URL, { method: "POST", body: JSON.stringify(BODY) }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/bearer/i) });
  });

  test("accepts batches and reports repeat sightings", async () => {
    const { POST } = await import("../app/api/v1/signals/route");
    const request = () =>
      new Request(URL, {
        method: "POST",
        headers: { authorization: "Bearer test-signal-key", "content-type": "application/json" },
        body: JSON.stringify({ data: [BODY] }),
      });
    const first = await POST(request());
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({ data: [{ channel: "linkedin", seen_count: 1 }] });

    const repeat = await POST(request());
    expect(repeat.status).toBe(200);
    await expect(repeat.json()).resolves.toMatchObject({ data: [{ seen_count: 2 }] });
  });
});
