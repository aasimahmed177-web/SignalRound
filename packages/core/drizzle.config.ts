import { defineConfig } from "drizzle-kit";

// Generates migrations from src/db/schema.ts. Applying them: `pnpm db:push` (dev)
// or `pnpm db:migrate` against DATABASE_URL. PGlite dev databases are pushed on boot.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost:5432/funding_feed" },
});
