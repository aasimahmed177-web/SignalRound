CREATE TABLE IF NOT EXISTS "company_requests" (
	"id" text PRIMARY KEY,
	"domain" text NOT NULL,
	"submitted_url" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"company_id" text REFERENCES "companies"("id"),
	"message" text,
	"requester_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_requests_active_domain_idx" ON "company_requests" ("domain") WHERE "status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_requests_created_idx" ON "company_requests" ("created_at");
