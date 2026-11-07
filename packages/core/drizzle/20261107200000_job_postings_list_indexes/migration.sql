CREATE INDEX IF NOT EXISTS "job_postings_source_idx" ON "job_postings" ("source");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_postings_open_posted_idx" ON "job_postings" ("status", (coalesce("posted_at", "first_seen_at")) DESC);
