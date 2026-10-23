import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { closeDb, getDb } from "../db/index.ts";
import { databaseWebState } from "./store.ts";

beforeAll(async () => {
  const db = await getDb({ pgliteDir: "memory://" });
  await db.execute(sql`create table settings (key text primary key, value jsonb not null, updated_at timestamptz default now())`);
}, 30_000);
afterAll(async () => {
  await closeDb();
});

test("durable JSON state claims are atomic and survive serializing undefined fields", async () => {
  const key = "native:research:cas-test";
  const initial = { result: { status: "processing" }, input: { prompt: "Research Acme" }, leaseUntil: undefined };
  await databaseWebState.put(key, initial);
  expect(await databaseWebState.get(key)).toEqual({ result: { status: "processing" }, input: { prompt: "Research Acme" } });
  const outcomes = await Promise.all([
    databaseWebState.compareAndSwap(key, initial, { ...initial, leaseId: "worker-a" }),
    databaseWebState.compareAndSwap(key, initial, { ...initial, leaseId: "worker-b" }),
  ]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  const claimed = await databaseWebState.get(key);
  expect(await databaseWebState.compareAndSwap(key, claimed, { result: { status: "completed" } })).toBe(true);
  expect(await databaseWebState.get(key)).toEqual({ result: { status: "completed" } });
  await databaseWebState.remove(key);
  expect(await databaseWebState.get(key)).toBeUndefined();
});
