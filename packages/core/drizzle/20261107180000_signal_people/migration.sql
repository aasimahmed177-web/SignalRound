CREATE TABLE IF NOT EXISTS "signal_people" (
	"id" text PRIMARY KEY,
	"signal_id" text NOT NULL REFERENCES "signal_observations"("id") ON DELETE CASCADE,
	"company" text NOT NULL,
	"company_website" text,
	"name" text NOT NULL,
	"role" text,
	"source_url" text NOT NULL,
	"quote" text,
	"linkedin_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signal_people_signal_name_idx" ON "signal_people" ("signal_id", "name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signal_emails" (
	"id" text PRIMARY KEY,
	"signal_id" text NOT NULL REFERENCES "signal_observations"("id") ON DELETE CASCADE,
	"person_id" text REFERENCES "signal_people"("id") ON DELETE SET NULL,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"inbox" text,
	"source_url" text NOT NULL,
	"quote" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signal_emails_signal_email_idx" ON "signal_emails" ("signal_id", "email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_emails_person_idx" ON "signal_emails" ("person_id");
