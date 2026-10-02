-- The Trending lane: rounds it follows and the X posts it found. Idempotent (IF NOT EXISTS, foreign
-- keys inline) so two builds migrating one database at once both finish.
CREATE TABLE IF NOT EXISTS "trending_posts" (
	"round_id" text NOT NULL,
	"post_key" text NOT NULL,
	"kind" text NOT NULL,
	"status_id" text,
	"handle" text,
	"author_name" text,
	"url" text NOT NULL,
	"snippet" text NOT NULL,
	"posted_at" timestamp with time zone,
	"relevant" boolean DEFAULT false NOT NULL,
	"name_hit" boolean DEFAULT false NOT NULL,
	"amount_hit" boolean DEFAULT false NOT NULL,
	"is_self" boolean DEFAULT false NOT NULL,
	"is_outlet" boolean DEFAULT false NOT NULL,
	"queries" jsonb DEFAULT '[]' NOT NULL,
	"likes" integer,
	"reposts" integer,
	"engagement_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trending_posts_pkey" PRIMARY KEY("round_id","post_key"),
	CONSTRAINT "trending_posts_round_id_funding_rounds_id_fkey" FOREIGN KEY ("round_id") REFERENCES "funding_rounds"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trending_rounds" (
	"round_id" text PRIMARY KEY,
	"company_id" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"x_handle" text,
	"x_handle_source" text,
	"handle_checked_at" timestamp with time zone,
	"checkpoints" integer DEFAULT 0 NOT NULL,
	"searched_at" timestamp with time zone,
	"hn" jsonb DEFAULT '[]' NOT NULL,
	"hn_checked_at" timestamp with time zone,
	"people" integer DEFAULT 0 NOT NULL,
	"outlet_accounts" integer DEFAULT 0 NOT NULL,
	"outlets" integer DEFAULT 0 NOT NULL,
	"hn_points" integer DEFAULT 0 NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"signals" jsonb,
	"rank" integer,
	"label" boolean DEFAULT false NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"stale_reason" text,
	"scored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trending_rounds_round_id_funding_rounds_id_fkey" FOREIGN KEY ("round_id") REFERENCES "funding_rounds"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trending_posts_handle_idx" ON "trending_posts" ("handle");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trending_rounds_score_idx" ON "trending_rounds" ("score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trending_rounds_company_idx" ON "trending_rounds" ("company_id");
