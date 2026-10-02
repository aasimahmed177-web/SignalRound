// Every cron route takes CRON_SECRET through one helper, and in production refuses every call when the
// secret is missing or wrong. The routes are found on disk, so a new one is covered the day it lands.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: async () => {
    throw new Error("the store opened");
  },
}));
vi.mock("workflow/api", () => ({ start: vi.fn(async () => ({ runId: "mock" })) }));

import { cronAuthorized } from "../lib/cron-auth";

const CRON_DIR = path.resolve(__dirname, "../app/api/cron");
const routes = readdirSync(CRON_DIR).map((name) => ({ name, file: path.join(CRON_DIR, name, "route.ts") }));

afterEach(() => vi.unstubAllEnvs());

describe("cronAuthorized", () => {
  const req = (authorization?: string) => new Request("http://app.test/api/cron/x", { headers: authorization ? { authorization } : {} });

  test("the bearer must match; with no secret, open in development and closed in production", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(cronAuthorized(req("Bearer s3cret"))).toBe(true);
    expect(cronAuthorized(req("Bearer s3cre"))).toBe(false);
    expect(cronAuthorized(req("s3cret"))).toBe(false);
    expect(cronAuthorized(req())).toBe(false);
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(cronAuthorized(req("Bearer "))).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    expect(cronAuthorized(req())).toBe(true);
  });
});

describe("every /api/cron route", () => {
  test("uses the shared check and keeps no copy of its own", () => {
    expect(routes.length).toBeGreaterThanOrEqual(9);
    for (const { name, file } of routes) {
      const src = readFileSync(file, "utf8");
      expect(src, name).toContain('from "@/lib/cron-auth"');
      expect(src, name).not.toMatch(/process\.env\.CRON_SECRET/);
    }
  });

  test("answers 401 to every method in production without the right bearer, before the store opens", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const secret of ["", "s3cret"]) {
      vi.stubEnv("CRON_SECRET", secret);
      for (const { name, file } of routes) {
        const mod = (await import(file)) as Record<string, (r: Request) => Promise<Response>>;
        for (const method of ["GET", "POST"] as const) {
          if (!mod[method]) continue;
          const res = await mod[method](
            new Request(`http://app.test/api/cron/${name}`, { method, headers: { authorization: "Bearer wrong" } }),
          );
          expect(res.status, `${method} ${name}`).toBe(401);
        }
      }
    }
  });
});
