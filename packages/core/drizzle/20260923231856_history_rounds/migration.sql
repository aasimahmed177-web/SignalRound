-- History rounds: a flag on funding_rounds for earlier rounds promoted from checked dossiers, and the
-- promotion ledger, one row per prior round. Idempotent (IF NOT EXISTS, the foreign key inline) so two
-- builds migrating one database at once both finish; scripts/migrate.ts retries the loser of a catalog race.
CREATE TABLE IF NOT EXISTS "history_promotions" (
	"company_id" text,
	"prior_key" text,
	"prior" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"round_id" text,
	"source_url" text,
	"outcome" jsonb,
	"credits" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "history_promotions_pkey" PRIMARY KEY("company_id","prior_key"),
	CONSTRAINT "history_promotions_company_id_companies_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE "funding_rounds" ADD COLUMN IF NOT EXISTS "history" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "history_promotions_due_idx" ON "history_promotions" ("status","next_attempt_at");
