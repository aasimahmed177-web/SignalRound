ALTER TABLE delivery_targets ADD COLUMN IF NOT EXISTS include_expected boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE slack_subscriptions ADD COLUMN IF NOT EXISTS include_expected boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE feed_tokens ADD COLUMN IF NOT EXISTS include_expected boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS delivered_certainty text;
