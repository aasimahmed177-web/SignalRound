ALTER TABLE "company_requests" ADD COLUMN IF NOT EXISTS "dossier_status" text;--> statement-breakpoint
ALTER TABLE "company_requests" ADD COLUMN IF NOT EXISTS "dossier_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_requests" ADD COLUMN IF NOT EXISTS "dossier_finished_at" timestamp with time zone;