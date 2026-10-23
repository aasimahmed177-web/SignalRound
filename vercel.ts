// Vercel's project configuration. Vercel runs this file at build time with the project's environment
// variables, so the cron schedule follows FIREROUND_SCHEDULE:
//   unset (the default)        every route once a day: what a Vercel Hobby project accepts, and enough for the
//                              default Lite coverage, whose sweep runs Mondays at 06:00 UTC
//   FIREROUND_SCHEDULE=frequent the full cadence (hourly lanes, quarter-hour verification, the five-minute audit,
//                              the ten-minute health check). Needs Vercel Pro: Hobby refuses sub-daily crons.
// A change to FIREROUND_SCHEDULE takes effect at the next deployment. Off Vercel, `pnpm start` runs its own
// schedule (lib/scheduler.ts) and this file is not read.

interface Cron {
  path: string;
  schedule: string;
}

const FREQUENT: Cron[] = [
  { path: "/api/cron/native-monitors", schedule: "0 * * * *" },
  { path: "/api/cron/sweep", schedule: "0 * * * *" },
  { path: "/api/cron/deliveries", schedule: "0 * * * *" },
  { path: "/api/cron/trending", schedule: "0 * * * *" },
  { path: "/api/cron/announcements", schedule: "*/15 * * * *" },
  { path: "/api/cron/slack-digest", schedule: "0 7 * * *" },
  { path: "/api/cron/accuracy", schedule: "0 5 * * *" },
  { path: "/api/cron/company-newsrooms", schedule: "0 6 * * *" },
  { path: "/api/cron/verify-rounds", schedule: "*/15 * * * *" },
  { path: "/api/cron/publication-audit", schedule: "*/5 * * * *" },
  { path: "/api/cron/health", schedule: "*/10 * * * *" },
];

// Hobby runs a daily cron at any minute of its hour, so each hour leaves room for the one before it: the
// sweep at 06 (the hour Lite's weekly sweep and Deep's announcements search are due), then delivery,
// verification, and the audit of what it found.
const DAILY: Cron[] = [
  { path: "/api/cron/native-monitors", schedule: "0 9 * * *" },
  { path: "/api/cron/accuracy", schedule: "0 5 * * *" },
  { path: "/api/cron/sweep", schedule: "0 6 * * *" },
  { path: "/api/cron/company-newsrooms", schedule: "0 6 * * *" },
  { path: "/api/cron/announcements", schedule: "0 6 * * *" },
  { path: "/api/cron/slack-digest", schedule: "0 7 * * *" },
  { path: "/api/cron/trending", schedule: "0 8 * * *" },
  { path: "/api/cron/deliveries", schedule: "0 9 * * *" },
  { path: "/api/cron/verify-rounds", schedule: "0 10 * * *" },
  { path: "/api/cron/publication-audit", schedule: "0 11 * * *" },
  { path: "/api/cron/health", schedule: "0 12 * * *" },
];

/** The crons for a FIREROUND_SCHEDULE value: the full cadence for `frequent`, once a day otherwise. */
export function cronsFor(schedule: string | undefined): Cron[] {
  return schedule?.trim().toLowerCase() === "frequent" ? FREQUENT : DAILY;
}

export const config = {
  crons: cronsFor(process.env.FIREROUND_SCHEDULE),
};
