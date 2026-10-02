-- rate_limits: the public demo's per-client hit counts (lib/rate-limit.ts), one row per bucket and
-- hashed client address in a fixed window. Idempotent (IF NOT EXISTS) so two builds migrating one
-- database at once both finish; scripts/migrate.ts retries the loser of a catalog race.
CREATE TABLE IF NOT EXISTS "rate_limits" (
	"key" text PRIMARY KEY,
	"window_start" timestamp with time zone NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limits_window_idx" ON "rate_limits" ("window_start");
