CREATE TABLE "alias_rules" (
	"alias_key" text PRIMARY KEY,
	"canonical_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
