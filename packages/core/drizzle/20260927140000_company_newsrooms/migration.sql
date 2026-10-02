CREATE TABLE IF NOT EXISTS "company_newsrooms" (
	"company_id" text NOT NULL REFERENCES "companies"("id"),
	"url" text NOT NULL,
	"monitor_id" text,
	"checked_at" timestamp with time zone,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("company_id", "url")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_newsrooms_checked_idx" ON "company_newsrooms" ("checked_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_newsroom_scans" (
	"company_id" text PRIMARY KEY REFERENCES "companies"("id"),
	"discovered_at" timestamp with time zone NOT NULL
);
