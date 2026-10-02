CREATE TABLE "delivery_targets" (
	"id" text PRIMARY KEY,
	"channel" "delivery_channel" NOT NULL,
	"target" text NOT NULL,
	"label" text,
	"secret" text,
	"preset_slug" text,
	"min_confidence" numeric(4,2) DEFAULT '0.5' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
