CREATE TABLE IF NOT EXISTS cron_leases (
  route text NOT NULL,
  tick timestamp with time zone NOT NULL,
  claimed_at timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (route, tick)
);
