-- The X announcements lane: one lead per funding post, what it says, and the search for its article
-- on a backoff to 48 hours. Idempotent (IF NOT EXISTS, no enum types) so two builds migrating one
-- database at once both finish; scripts/migrate.ts retries the loser of a catalog race.
CREATE TABLE IF NOT EXISTS "announcement_leads" (
	"key" text PRIMARY KEY,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"handle" text,
	"author_name" text,
	"via" text,
	"company" text,
	"company_handle" text,
	"amount_as_written" text NOT NULL,
	"amount_value" double precision NOT NULL,
	"currency" text,
	"usd_millions" double precision,
	"label" text NOT NULL,
	"lead_investors" jsonb DEFAULT '[]' NOT NULL,
	"text" text NOT NULL,
	"posted_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"round_id" text,
	"article_url" text,
	"read_urls" jsonb DEFAULT '[]' NOT NULL,
	"self_checked_at" timestamp with time zone,
	"self_verified" boolean DEFAULT false NOT NULL,
	"note" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcement_leads_due_idx" ON "announcement_leads" ("status","next_attempt_at");