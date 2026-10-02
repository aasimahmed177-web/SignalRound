CREATE TABLE IF NOT EXISTS "page_snapshots" (
	"hash" text PRIMARY KEY,
	"markdown" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_snapshot_reads" (
	"source_url" text NOT NULL,
	"snapshot_hash" text NOT NULL REFERENCES "page_snapshots"("hash"),
	"raw_extraction" jsonb,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("source_url", "snapshot_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_snapshot_reads_at_idx" ON "page_snapshot_reads" ("read_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_snapshots_created_idx" ON "page_snapshots" ("created_at");
