CREATE TABLE "page_verdicts" (
	"id" text PRIMARY KEY,
	"lane" text NOT NULL,
	"run_id" text,
	"preset_slug" text,
	"url" text NOT NULL,
	"title" text,
	"rules_kept" boolean NOT NULL,
	"about_raise" double precision NOT NULL,
	"is_round" double precision NOT NULL,
	"kind" text NOT NULL,
	"kind_confidence" double precision NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "page_verdicts_created_idx" ON "page_verdicts" ("created_at");