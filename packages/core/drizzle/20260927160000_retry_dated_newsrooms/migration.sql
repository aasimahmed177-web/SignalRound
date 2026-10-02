UPDATE history_promotions
SET status = 'pending',
    next_attempt_at = now(),
    claimed_by = NULL,
    updated_at = now()
WHERE status = 'no_source'
  AND prior->>'announced_date' IS NULL
  AND outcome->'tried' @> '[{"result":"refused: undated round on the company''s own site"}]'::jsonb;
