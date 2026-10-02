// The review queue's writes: a decision, its Undo, and the Research route's refusals (none of
// which reach Firecrawl).
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  updateTag: () => {},
  cacheLife: () => {},
  cacheTag: () => {},
}));

import { POST as researchPost } from "../app/(dashboard)/review/research/route";
import { decide, undoDecision } from "../app/actions";
import { db } from "../lib/db";
import { listRounds, persistRecords, setDisposition } from "../lib/persist";
import { record } from "./helpers";

let id = "";

async function dispositionOf(roundId: string): Promise<string | undefined> {
  const { rows } = await listRounds(await db(), { ids: [roundId], includeReview: true, limit: 1 });
  return rows[0]?.disposition;
}

beforeAll(async () => {
  const handle = await db();
  const summary = await persistRecords(
    handle,
    [record({ company_name: "Queue Alpha", company_key: "queue-alpha", announced_date: null, confidence: 0.3 })],
    "series-a-b",
    "run-review-actions",
    { startIn: "review" },
  );
  id = summary.persistedIds[0];
});

describe("undoDecision", () => {
  test("publish then undo puts the record back in review; reject then undo the same", async () => {
    expect(await dispositionOf(id)).toBe("review");
    expect(await decide(id, "publish")).toEqual({ ok: true });
    expect(await dispositionOf(id)).toBe("publish");
    expect(await undoDecision(id, "publish")).toEqual({ ok: true });
    expect(await dispositionOf(id)).toBe("review");

    expect(await decide(id, "rejected")).toEqual({ ok: true });
    expect(await undoDecision(id, "rejected")).toEqual({ ok: true });
    expect(await dispositionOf(id)).toBe("review");
  });

  test("an undo that no longer matches the row refuses and leaves the newer state alone", async () => {
    await decide(id, "publish");
    // Something else moved it since (a sweep, a report): the Undo names a decision that no longer stands.
    await setDisposition(await db(), id, "flagged");
    const res = await undoDecision(id, "publish");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/changed since/);
    expect(await dispositionOf(id)).toBe("flagged");
    await setDisposition(await db(), id, "review");
  });

  test("an unknown id is an error, not a silent success", async () => {
    const res = await undoDecision("no-such-round", "rejected");
    expect(res.ok).toBe(false);
  });
});

describe("POST /review/research", () => {
  const post = (body: string, headers: Record<string, string>) =>
    researchPost(new Request("http://app.test/review/research", { method: "POST", body, headers }));

  test("a request without this origin, or without a JSON body, is refused before anything runs", async () => {
    const noOrigin = await post(JSON.stringify({ id }), { "content-type": "application/json", host: "app.test" });
    expect(noOrigin.status).toBe(403);
    const foreign = await post(JSON.stringify({ id }), {
      "content-type": "application/json",
      host: "app.test",
      origin: "https://evil.test",
    });
    expect(foreign.status).toBe(403);
    const form = await post(`id=${id}`, {
      "content-type": "application/x-www-form-urlencoded",
      host: "app.test",
      origin: "http://app.test",
    });
    expect(form.status).toBe(403);
  });

  test("a same-origin request naming no record, or an unknown one, answers the reason as an ActionResult", async () => {
    const headers = { "content-type": "application/json", host: "app.test", origin: "http://app.test" };
    const empty = await post("{}", headers);
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ ok: false, error: "The request named no record." });
    // A placeholder key: the lookup fails before the client is ever used.
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test-placeholder");
    const unknown = await post(JSON.stringify({ id: "no-such-round" }), headers);
    vi.unstubAllEnvs();
    expect(await unknown.json()).toEqual({ ok: false, error: "Record not found." });
  });
});
