import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/core",
      {
        resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
        test: {
          name: "app",
          include: ["tests/**/*.test.ts"],
          environment: "node",
          env: { SLACK_WEBHOOK_KEY: "test-only-slack-webhook-key-not-for-production" },
          testTimeout: 30_000,
          // beforeAll boots an in-memory Postgres (PGlite WASM); cold, on a loaded machine, that passes 10s.
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
