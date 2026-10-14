CREATE TABLE IF NOT EXISTS "investor_folds" (
	"from_id" text PRIMARY KEY,
	"into_id" text NOT NULL,
	"folded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "investor_folds_into_idx" ON "investor_folds" ("into_id");
