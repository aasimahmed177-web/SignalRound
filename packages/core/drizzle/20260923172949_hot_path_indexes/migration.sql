CREATE INDEX "funding_rounds_visible_announced_idx" ON "funding_rounds" ("announced_on" DESC NULLS LAST,"id" DESC) WHERE "disposition" in ('publish', 'flagged');--> statement-breakpoint
CREATE INDEX "funding_rounds_visible_amount_idx" ON "funding_rounds" ("amount_usd_millions" DESC NULLS LAST,"id" DESC) WHERE "disposition" in ('publish', 'flagged');--> statement-breakpoint
CREATE INDEX "round_investors_investor_idx" ON "round_investors" ("investor_id");--> statement-breakpoint
CREATE INDEX "round_sources_source_idx" ON "round_sources" ("source_id");--> statement-breakpoint
CREATE INDEX "runs_started_idx" ON "runs" ("started_at");--> statement-breakpoint
CREATE INDEX "sources_fetched_idx" ON "sources" ("fetched_at");