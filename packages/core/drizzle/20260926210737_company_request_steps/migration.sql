ALTER TABLE "company_requests" ADD COLUMN IF NOT EXISTS "step" text;--> statement-breakpoint
ALTER TABLE "company_requests" ADD COLUMN IF NOT EXISTS "tally" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_requests_domain_idx" ON "company_requests" ("domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_requests_company_idx" ON "company_requests" ("company_id");