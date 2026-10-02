-- Public Add to Slack: one row per subscribed (workspace, channel), the webhook encrypted, the manage
-- token hashed. Idempotent (IF NOT EXISTS, no enum types) so two builds migrating one database at once
-- both finish; scripts/migrate.ts retries the loser of a catalog race.
CREATE TABLE IF NOT EXISTS "slack_subscriptions" (
	"id" text PRIMARY KEY,
	"team_id" text NOT NULL,
	"team_name" text,
	"channel_id" text NOT NULL,
	"channel_name" text,
	"webhook_ciphertext" text,
	"preset_slug" text DEFAULT 'all' NOT NULL,
	"cadence" text DEFAULT 'instant' NOT NULL,
	"manage_token_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_sent_at" timestamp with time zone,
	"last_digest_at" timestamp with time zone,
	"last_test_at" timestamp with time zone,
	"posts_day" text,
	"posts_today" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "slack_subscriptions_team_channel_idx" ON "slack_subscriptions" ("team_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "slack_subscriptions_manage_idx" ON "slack_subscriptions" ("manage_token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slack_subscriptions_status_idx" ON "slack_subscriptions" ("status","cadence");
