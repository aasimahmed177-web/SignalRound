process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { expect, test, vi } from "vitest";
import { testDb } from "./helpers";

vi.mock("@/lib/db", async () => ({ db: async () => (globalThis as { __db?: unknown }).__db }));
vi.mock("@/lib/dossier-check", () => ({ dossierCheckAvailable: () => true }));

test("a company merged into another after it was queued is skipped, not dived", async () => {
  (globalThis as { __db?: unknown }).__db = await testDb();
  const { startDiveStep } = await import("@/workflows/dossiers");
  expect(await startDiveStep("gone.example", true)).toEqual({ skipped: "company merged into another" });
});
