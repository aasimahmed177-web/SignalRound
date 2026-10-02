import type { Instrumentation } from "next";

export async function register() {
  // A private instance with no password is open to anyone; a demo with none has no admin tier at all
  // (lib/access.ts), so its admin paths answer 404 and every write is refused.
  if (process.env.NODE_ENV === "production" && !process.env.DASHBOARD_PASSWORD) {
    if (process.env.PUBLIC_DEMO === "1") {
      console.info(
        `PUBLIC_DEMO is set without DASHBOARD_PASSWORD: a read-only demo. Presets, Review, and Settings answer 404 and operator writes are refused.${process.env.COMPANY_REQUESTS === "1" ? " Public company requests are enabled." : ""}`,
      );
    } else {
      console.warn("DASHBOARD_PASSWORD is not set: every button that spends Firecrawl credits is open to anyone who reaches this URL.");
    }
  }
  if (process.env.NODE_ENV === "production" && !process.env.CRON_SECRET) {
    console.warn(
      "CRON_SECRET is not set: the cron routes refuse every call in production, so nothing sweeps on a schedule. Add it in the Vercel project settings.",
    );
  }
  // The in-process schedule: Vercel Cron hits the same routes on Vercel, so this arms only off it.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { schedulerEnabled, startScheduler } = await import("@/lib/scheduler");
    if (schedulerEnabled(process.env)) {
      startScheduler({
        origin: process.env.APP_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`,
        secret: process.env.CRON_SECRET,
      });
    }
  }
}

/**
 * One line per server error with the digest the error page shows a reader, so "reference 1a2b3c"
 * finds its log. Next still logs the stack on its own; this adds the path and the digest together.
 */
export const onRequestError: Instrumentation.onRequestError = (err, request, context) => {
  const digest = typeof err === "object" && err !== null && "digest" in err ? String(err.digest) : "none";
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[request-error] ${request.method} ${request.path} (${context.routeType}) digest=${digest}: ${message}`);
};
