-- The 2026-09-25 safeguards against old news posted as new, in one migration:
-- round_merges: one row per merged-away round, naming the row that absorbed it, so a later reading
-- that rebuilds the dropped id lands on the survivor and is never delivered again.
-- funding_rounds.hold: why a row is held from delivery as a likely late re-report, or null.
-- funding_rounds.pinned: facts a person set by hand (fix-records), which no later reading moves.
-- Idempotent (IF NOT EXISTS, no enum types) so two builds migrating one database at once both
-- finish; scripts/migrate.ts retries the loser of a catalog race.
CREATE TABLE IF NOT EXISTS "round_merges" (
	"dropped_id" text PRIMARY KEY,
	"kept_id" text NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "round_merges_kept_idx" ON "round_merges" ("kept_id");--> statement-breakpoint
ALTER TABLE "funding_rounds" ADD COLUMN IF NOT EXISTS "hold" text;--> statement-breakpoint
ALTER TABLE "funding_rounds" ADD COLUMN IF NOT EXISTS "pinned" jsonb;
