ALTER TYPE "delivery_channel" ADD VALUE IF NOT EXISTS 'x';
--> statement-breakpoint
ALTER TYPE "delivery_status" ADD VALUE IF NOT EXISTS 'previewed';
--> statement-breakpoint
ALTER TYPE "delivery_status" ADD VALUE IF NOT EXISTS 'retracted';
--> statement-breakpoint
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS external_id text;
--> statement-breakpoint
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS snapshot jsonb;
