ALTER TABLE funding_rounds ADD COLUMN IF NOT EXISTS certainty text NOT NULL DEFAULT 'announced';
--> statement-breakpoint
ALTER TABLE funding_rounds ADD COLUMN IF NOT EXISTS reported_on text;
