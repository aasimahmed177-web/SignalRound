// A visitor's read carries the server-side statement timeout in a transaction of its own, so the
// limit never reaches the pipeline's reads or a later client of a pooled server connection.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { db, READ_DEADLINE_MS, visitorRead } from "../lib/db";

const timeout = async (handle: Awaited<ReturnType<typeof db>>) =>
  ((await handle.execute(sql`select current_setting('statement_timeout') as t`)) as unknown as { rows: Array<{ t: string }> }).rows[0]?.t;

test("the read runs under the deadline as a statement timeout, and the setting ends with it", async () => {
  const before = await timeout(await db());
  expect(await visitorRead(timeout)).toBe(`${READ_DEADLINE_MS / 1000}s`);
  expect(await timeout(await db())).toBe(before);
  expect(before).not.toBe(`${READ_DEADLINE_MS / 1000}s`);
});

test("a read that throws rolls back and leaves the handle usable", async () => {
  await expect(
    visitorRead(async (handle) => {
      await handle.execute(sql`select 1`);
      throw new Error("read failed");
    }),
  ).rejects.toThrow("read failed");
  expect(await visitorRead(timeout)).toBe(`${READ_DEADLINE_MS / 1000}s`);
});
