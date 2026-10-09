// A visitor's read gives up rather than hang on a pool the database cannot serve: the render fails,
// the cache keeps its last copy, and nothing is stored from the failure.

import { expect, test } from "vitest";
import { withinDeadline } from "../lib/db";

test("a read inside the deadline returns its value; one past it fails fast with a plain message", async () => {
  expect(await withinDeadline(Promise.resolve(42), 50)).toBe(42);
  const started = Date.now();
  await expect(withinDeadline(new Promise(() => {}), 50)).rejects.toThrow("database read took longer than 0.05s");
  expect(Date.now() - started).toBeLessThan(1_000);
  await expect(withinDeadline(Promise.reject(new Error("client_login_timeout")), 50)).rejects.toThrow("client_login_timeout");
});
