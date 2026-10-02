import { describe, expect, test } from "vitest";
import { concurrencyLimited, readOnlyBody, retryingFetch } from "../lib/db-retry";

/** undici's shape for a network failure: a TypeError "fetch failed" with the socket error as its cause. */
function fetchFailed(code?: string): TypeError {
  const err = new TypeError("fetch failed") as TypeError & { cause?: { code: string } };
  if (code) err.cause = { code };
  return err;
}

/** A fetch that throws the given errors in turn, then answers 200; it counts its calls. */
function flaky(errors: unknown[]) {
  let calls = 0;
  const fn = (async () => {
    const err = errors[calls++];
    if (err) throw err;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

const read = JSON.stringify({ query: "select * from funding_rounds where id = $1", params: ["a"] });
const write = JSON.stringify({ query: "insert into runs (id) values ($1)", params: ["r"] });

describe("readOnlyBody", () => {
  test("a SELECT or a writing-free WITH is a read; anything that writes is not", () => {
    expect(readOnlyBody(read)).toBe(true);
    expect(readOnlyBody(JSON.stringify({ query: "with x as (select 1) select * from x" }))).toBe(true);
    expect(readOnlyBody(JSON.stringify({ query: "select updated_at from runs" }))).toBe(true);
    expect(readOnlyBody(write)).toBe(false);
    expect(readOnlyBody(JSON.stringify({ query: "with x as (delete from runs returning id) select * from x" }))).toBe(false);
    expect(readOnlyBody(JSON.stringify({ query: "select * from runs for update" }))).toBe(false);
    expect(readOnlyBody(JSON.stringify({ queries: [{ query: "select 1" }, { query: "update runs set x = 1" }] }))).toBe(false);
    expect(readOnlyBody(JSON.stringify({ queries: [{ query: "select 1" }, { query: "select 2" }] }))).toBe(true);
    expect(readOnlyBody("not json")).toBe(false);
    expect(readOnlyBody(undefined)).toBe(false);
  });
});

describe("retryingFetch", () => {
  test("a read that failed on the network goes once more and answers", async () => {
    const f = flaky([fetchFailed("ECONNRESET")]);
    const res = await retryingFetch(f.fn, { delayMs: 0 })("https://db", { method: "POST", body: read });
    expect(res.status).toBe(200);
    expect(f.calls()).toBe(2);
  });

  test("a write is never sent twice unless the connection never opened", async () => {
    const reset = flaky([fetchFailed("ECONNRESET")]);
    await expect(retryingFetch(reset.fn, { delayMs: 0 })("https://db", { method: "POST", body: write })).rejects.toThrow("fetch failed");
    expect(reset.calls()).toBe(1);
    const refused = flaky([fetchFailed("ECONNREFUSED")]);
    expect((await retryingFetch(refused.fn, { delayMs: 0 })("https://db", { method: "POST", body: write })).status).toBe(200);
    expect(refused.calls()).toBe(2);
  });

  test("one retry only, and an abort is not retried", async () => {
    const twice = flaky([fetchFailed(), fetchFailed()]);
    await expect(retryingFetch(twice.fn, { delayMs: 0 })("https://db", { method: "POST", body: read })).rejects.toThrow("fetch failed");
    expect(twice.calls()).toBe(2);
    const abort = flaky([new DOMException("aborted", "AbortError")]);
    await expect(retryingFetch(abort.fn, { delayMs: 0 })("https://db", { method: "POST", body: read })).rejects.toThrow("aborted");
    expect(abort.calls()).toBe(1);
  });
});

describe("concurrencyLimited", () => {
  test("never runs more than max at once, and runs every request in arrival order", async () => {
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const base = (async (input: RequestInfo | URL) => {
      started.push(Number(String(input)));
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const limited = concurrencyLimited(base, 3);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => limited(String(i))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(peak).toBe(3);
    expect(started).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  test("a failed request frees its slot", async () => {
    let calls = 0;
    const base = (async () => {
      calls++;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const limited = concurrencyLimited(base, 1);
    const outcomes = await Promise.allSettled([limited("a"), limited("b"), limited("c")]);
    expect(outcomes.every((o) => o.status === "rejected")).toBe(true);
    expect(calls).toBe(3);
  });
});
