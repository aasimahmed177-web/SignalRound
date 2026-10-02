-- The daily accuracy check: one flag per (company, rule) with its first and last sighting, its
-- clearing, a dismissal and its note, and the remedy last started with how many times; and what the
-- check remembers of a company's dossier founders between runs. Idempotent (IF NOT EXISTS, the
-- foreign keys inline, no enum types) so two builds migrating one database at once both finish;
-- scripts/migrate.ts retries the loser of a catalog race.
CREATE TABLE IF NOT EXISTS "accuracy_flags" (
	"company_id" text,
	"rule" text,
	"severity" text NOT NULL,
	"reason" text NOT NULL,
	"subjects" jsonb DEFAULT '[]' NOT NULL,
	"remedy" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"dismissed_note" text,
	"dismissed_subjects" jsonb,
	"remedied_at" timestamp with time zone,
	"remedy_note" text,
	"remedy_attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "accuracy_flags_pkey" PRIMARY KEY("company_id","rule"),
	CONSTRAINT "accuracy_flags_company_id_companies_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accuracy_memory" (
	"company_id" text PRIMARY KEY,
	"dossier_at" timestamp with time zone,
	"founders" jsonb DEFAULT '[]' NOT NULL,
	"previous_founders" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accuracy_memory_company_id_companies_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accuracy_flags_open_idx" ON "accuracy_flags" ("cleared_at","dismissed_at");
