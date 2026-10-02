ALTER TABLE delivery_targets ADD COLUMN IF NOT EXISTS slack_team_id text;
--> statement-breakpoint
ALTER TABLE delivery_targets ADD COLUMN IF NOT EXISTS slack_bot_user_id text;
--> statement-breakpoint
ALTER TABLE delivery_targets ADD COLUMN IF NOT EXISTS slack_user_id text;
--> statement-breakpoint
ALTER TABLE slack_subscriptions ADD COLUMN IF NOT EXISTS bot_user_id text;
--> statement-breakpoint
ALTER TABLE slack_subscriptions ADD COLUMN IF NOT EXISTS user_id text;
