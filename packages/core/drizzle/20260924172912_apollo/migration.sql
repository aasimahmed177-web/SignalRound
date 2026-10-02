-- Apollo through Alexandria: its own enrichment kind, and the ledger's origin so an Apollo funding
-- event taken as a lead is measured apart from a dossier's prior round. Idempotent (IF NOT EXISTS) so
-- two builds migrating one database at once both finish.
ALTER TYPE "enrichment_kind" ADD VALUE IF NOT EXISTS 'apollo';--> statement-breakpoint
ALTER TABLE "history_promotions" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'dossier' NOT NULL;
