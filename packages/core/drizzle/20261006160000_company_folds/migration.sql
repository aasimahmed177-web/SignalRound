CREATE TABLE IF NOT EXISTS "company_folds" (
	"from_id" text PRIMARY KEY,
	"into_id" text NOT NULL,
	"folded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_folds_into_idx" ON "company_folds" ("into_id");
