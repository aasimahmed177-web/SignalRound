CREATE TABLE IF NOT EXISTS "signal_observations" (
	"id" text PRIMARY KEY,
	"channel" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"summary" text,
	"company" text,
	"author" text,
	"published_at" timestamp with time zone,
	"status" text DEFAULT 'new' NOT NULL,
	"confidence" double precision,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"round_id" text REFERENCES "funding_rounds"("id") ON DELETE SET NULL,
	"seen_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signal_observations_channel_url_idx" ON "signal_observations" ("channel", "url");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_observations_status_seen_idx" ON "signal_observations" ("status", "last_seen_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_observations_round_idx" ON "signal_observations" ("round_id");
