CREATE TABLE IF NOT EXISTS "job_postings" (
	"id" text PRIMARY KEY,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"company" text NOT NULL,
	"company_website" text,
	"board_url" text,
	"signal_id" text REFERENCES "signal_observations"("id") ON DELETE SET NULL,
	"location" text,
	"remote" boolean,
	"department" text,
	"employment_type" text,
	"salary" text,
	"description" text,
	"posted_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_postings_source_external_idx" ON "job_postings" ("source", "external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_postings_status_seen_idx" ON "job_postings" ("status", "last_seen_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_postings_board_idx" ON "job_postings" ("board_url");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_postings_signal_idx" ON "job_postings" ("signal_id");
