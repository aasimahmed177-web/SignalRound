CREATE TYPE "alias_kind" AS ENUM('name', 'domain', 'linkedin');--> statement-breakpoint
CREATE TYPE "amount_kind" AS ENUM('round', 'total_funding', 'valuation', 'unknown');--> statement-breakpoint
CREATE TYPE "delivery_channel" AS ENUM('slack', 'webhook', 'email');--> statement-breakpoint
CREATE TYPE "delivery_status" AS ENUM('pending', 'sent', 'failed', 'dead_letter');--> statement-breakpoint
CREATE TYPE "disposition" AS ENUM('publish', 'flagged', 'review', 'rejected');--> statement-breakpoint
CREATE TYPE "enrichment_kind" AS ENUM('profile', 'pricing', 'founders');--> statement-breakpoint
CREATE TYPE "investor_role" AS ENUM('lead', 'participant', 'unknown');--> statement-breakpoint
CREATE TYPE "record_status" AS ENUM('new', 'updated', 'seen');--> statement-breakpoint
CREATE TYPE "stage" AS ENUM('pre_seed', 'seed', 'series_a', 'series_b', 'series_c', 'series_d_plus', 'growth', 'bridge', 'debt', 'grant', 'convertible', 'secondary', 'undisclosed', 'other');--> statement-breakpoint
CREATE TABLE "candidates" (
	"monitor_id" text,
	"url" text,
	"check_id" text,
	"judge_reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidates_pkey" PRIMARY KEY("monitor_id","url")
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"domain" text,
	"linkedin_slug" text,
	"website" text,
	"description" text,
	"hq" text,
	"sector" text,
	"owner_id" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_aliases" (
	"company_id" text NOT NULL,
	"kind" "alias_kind",
	"alias_key" text,
	"alias" text NOT NULL,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_aliases_pkey" PRIMARY KEY("kind","alias_key")
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"round_id" text,
	"channel" "delivery_channel",
	"target" text,
	"status" "delivery_status" DEFAULT 'pending'::"delivery_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_pkey" PRIMARY KEY("round_id","channel","target")
);
--> statement-breakpoint
CREATE TABLE "enrichments" (
	"company_id" text,
	"kind" "enrichment_kind",
	"data" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source_url" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrichments_pkey" PRIMARY KEY("company_id","kind")
);
--> statement-breakpoint
CREATE TABLE "feed_tokens" (
	"token_hash" text PRIMARY KEY,
	"label" text,
	"preset_slug" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funding_rounds" (
	"id" text PRIMARY KEY,
	"company_id" text NOT NULL,
	"preset_slug" text NOT NULL,
	"stage" "stage" NOT NULL,
	"stage_as_written" text NOT NULL,
	"is_extension" boolean DEFAULT false NOT NULL,
	"amount_value" numeric(18,3),
	"amount_currency" text,
	"amount_as_written" text,
	"amount_usd_millions" numeric(18,3),
	"fx_rate" numeric(18,8),
	"fx_date" text,
	"valuation_as_written" text,
	"announced_on" text,
	"date_precision" text DEFAULT 'unknown' NOT NULL,
	"headquarters" text,
	"sector" text,
	"evidence_quotes" jsonb DEFAULT '[]' NOT NULL,
	"confidence" numeric(4,2) DEFAULT '0' NOT NULL,
	"status" "record_status" DEFAULT 'new'::"record_status" NOT NULL,
	"disposition" "disposition" DEFAULT 'review'::"disposition" NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investors" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"domain" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preset_monitors" (
	"preset_slug" text PRIMARY KEY,
	"monitor_id" text NOT NULL,
	"estimated_credits_per_month" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "round_investors" (
	"round_id" text,
	"investor_id" text,
	"role" "investor_role" DEFAULT 'unknown'::"investor_role" NOT NULL,
	CONSTRAINT "round_investors_pkey" PRIMARY KEY("round_id","investor_id")
);
--> statement-breakpoint
CREATE TABLE "round_sources" (
	"round_id" text,
	"source_id" text,
	"field_claims" jsonb,
	CONSTRAINT "round_sources_pkey" PRIMARY KEY("round_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY,
	"preset_slug" text NOT NULL,
	"lane" text NOT NULL,
	"window" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"credits_estimated" integer,
	"credits_measured" integer,
	"counts" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY,
	"url" text NOT NULL,
	"host" text NOT NULL,
	"title" text,
	"published_at" text,
	"query" text,
	"run_id" text,
	"raw_extraction" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "companies_domain_idx" ON "companies" ("domain");--> statement-breakpoint
CREATE INDEX "companies_name_key_idx" ON "companies" ("name_key");--> statement-breakpoint
CREATE INDEX "funding_rounds_company_idx" ON "funding_rounds" ("company_id");--> statement-breakpoint
CREATE INDEX "funding_rounds_announced_idx" ON "funding_rounds" ("announced_on");--> statement-breakpoint
CREATE INDEX "funding_rounds_status_idx" ON "funding_rounds" ("status");--> statement-breakpoint
CREATE INDEX "funding_rounds_preset_idx" ON "funding_rounds" ("preset_slug");--> statement-breakpoint
CREATE INDEX "sources_host_idx" ON "sources" ("host");--> statement-breakpoint
ALTER TABLE "company_aliases" ADD CONSTRAINT "company_aliases_company_id_companies_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_round_id_funding_rounds_id_fkey" FOREIGN KEY ("round_id") REFERENCES "funding_rounds"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "enrichments" ADD CONSTRAINT "enrichments_company_id_companies_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id");--> statement-breakpoint
ALTER TABLE "funding_rounds" ADD CONSTRAINT "funding_rounds_company_id_companies_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id");--> statement-breakpoint
ALTER TABLE "round_investors" ADD CONSTRAINT "round_investors_round_id_funding_rounds_id_fkey" FOREIGN KEY ("round_id") REFERENCES "funding_rounds"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "round_investors" ADD CONSTRAINT "round_investors_investor_id_investors_id_fkey" FOREIGN KEY ("investor_id") REFERENCES "investors"("id");--> statement-breakpoint
ALTER TABLE "round_sources" ADD CONSTRAINT "round_sources_round_id_funding_rounds_id_fkey" FOREIGN KEY ("round_id") REFERENCES "funding_rounds"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "round_sources" ADD CONSTRAINT "round_sources_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id");