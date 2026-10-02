CREATE TABLE IF NOT EXISTS "round_verification" (
  "round_id" text PRIMARY KEY REFERENCES "funding_rounds"("id") ON DELETE CASCADE,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone NOT NULL,
  "last_checked_at" timestamp with time zone,
  "status" text DEFAULT 'pending' NOT NULL,
  "claimed_by" text,
  "credits" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "round_verification_due_idx" ON "round_verification" ("status", "next_attempt_at");
--> statement-breakpoint
ALTER TABLE "round_verification" ADD COLUMN IF NOT EXISTS "last_error" text;
