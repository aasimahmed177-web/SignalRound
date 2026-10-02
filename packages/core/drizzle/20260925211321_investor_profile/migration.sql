-- What an investor's page shows beyond its rounds, from the investor's own homepage: its kind (the
-- homepage verdict's, or "person" for an individual no firm's site claimed), one sentence on what it
-- does, and its headquarters as the site states them. Null until the resolver has read the site.
-- Idempotent (IF NOT EXISTS) so two builds migrating one database at once both finish.
ALTER TABLE "investors" ADD COLUMN IF NOT EXISTS "kind" text;--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN IF NOT EXISTS "headquarters" text;
