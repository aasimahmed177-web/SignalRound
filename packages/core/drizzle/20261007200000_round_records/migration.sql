ALTER TABLE funding_rounds ADD COLUMN IF NOT EXISTS valuation_disclosed boolean;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION round_audit_facts_as(r funding_rounds, company text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(concat_ws('|', company, r.stage, r.stage_as_written, r.is_extension, r.amount_as_written, r.amount_currency,
    r.amount_usd_millions, r.amount_scope, r.financing_total_as_written, r.valuation_as_written, r.announced_on, r.certainty, r.history))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION round_audit_facts(r funding_rounds) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT round_audit_facts_as(r, r.company_id)
$$;
