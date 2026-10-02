ALTER TABLE "funding_rounds" ADD COLUMN IF NOT EXISTS "valuation_claims" jsonb;--> statement-breakpoint
ALTER TABLE "funding_rounds" ADD COLUMN IF NOT EXISTS "financing_total_as_written" text;--> statement-breakpoint
ALTER TABLE "funding_rounds" ADD COLUMN IF NOT EXISTS "financing_total_quote" text;--> statement-breakpoint
ALTER TABLE "funding_rounds" ADD COLUMN IF NOT EXISTS "amount_scope" text;