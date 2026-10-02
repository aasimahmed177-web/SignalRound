CREATE OR REPLACE FUNCTION mark_reported_later_history() RETURNS trigger AS $$
BEGIN
  IF NOT NEW.history
    AND (NEW.hold IS NULL OR NEW.hold NOT LIKE 'held: %')
    AND NEW.announced_on IS NOT NULL
    AND NEW.date_precision = 'day'
    AND NEW.announced_on ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
    AND (NEW.first_seen_at AT TIME ZONE 'UTC')::date - NEW.announced_on::date > 14
    AND (
      NEW.pinned ? 'announced_on'
      OR (
        NEW.date_basis IN ('stated', 'page', 'url')
        AND NEW.verification->>'status' IN ('confirmed', 'corrected')
      )
    )
  THEN
    NEW.history := true;
    NEW.status := 'seen';
    IF NEW.hold IS NULL THEN
      NEW.hold := format('reported later: announced %s (%s), first seen %s',
        NEW.announced_on,
        CASE WHEN NEW.pinned ? 'announced_on' THEN 'pinned' ELSE NEW.date_basis END,
        (NEW.first_seen_at AT TIME ZONE 'UTC')::date);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS funding_rounds_reported_later ON funding_rounds;
--> statement-breakpoint
CREATE TRIGGER funding_rounds_reported_later
  BEFORE UPDATE ON funding_rounds
  FOR EACH ROW EXECUTE FUNCTION mark_reported_later_history();
