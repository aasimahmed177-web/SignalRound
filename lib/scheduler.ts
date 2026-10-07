// The in-process schedule for hosts with no Vercel Cron. vercel.json ticks /api/cron/sweep and
// /api/cron/trending hourly, /api/cron/verify-rounds and /api/cron/announcements every quarter hour,
// /api/cron/deliveries hourly, /api/cron/accuracy at 05:00 UTC,
// and /api/cron/slack-digest at 07:00 UTC on Vercel; everywhere else `pnpm start`
// arms this instead, calling the same routes on the same hours from inside the server.
// `pnpm dev` stays off unless SCHEDULE=1 asks for it; SCHEDULE=0 turns a self-host's off.
// The ten-minute health check (/api/cron/health) is not ticked here.

export interface SchedulerEnv {
  SCHEDULE?: string;
  NODE_ENV?: string;
  VERCEL?: string;
}

/** Off in dev unless SCHEDULE=1; on for a production self-host unless SCHEDULE=0; never on Vercel. */
export function schedulerEnabled(env: SchedulerEnv): boolean {
  if (env.SCHEDULE === "1") return true;
  if (env.SCHEDULE === "0") return false;
  return env.NODE_ENV === "production" && !env.VERCEL;
}

/**
 * Milliseconds until the next top of the hour plus a fixed five seconds, so the tick lands
 * after the boundary it means (a tick at exactly :00:00 races the cron window's own start).
 */
export function nextTickDelayMs(now: Date): number {
  const next = new Date(now);
  next.setUTCHours(now.getUTCHours() + 1, 0, 5, 0);
  return next.getTime() - now.getTime();
}

export function nextVerifyDelayMs(now: Date): number {
  const next = new Date(now);
  next.setUTCHours(now.getUTCHours(), (Math.floor(now.getUTCMinutes() / 15) + 1) * 15, 5, 0);
  if (next.getUTCMinutes() === 0) next.setUTCMinutes(15);
  return next.getTime() - now.getTime();
}

/**
 * The routes one tick calls, mirroring vercel.json: the sweep, Trending, and X announcements hourly,
 * deliveries (with the X lane) hourly, the accuracy check at 05:00 UTC, the Slack digest at 07:00 UTC.
 */
export function tickPaths(now: Date): string[] {
  const paths = ["/api/cron/sweep", "/api/cron/trending", "/api/cron/announcements", "/api/cron/verify-rounds", "/api/cron/deliveries"];
  if (now.getUTCHours() === 5) paths.push("/api/cron/accuracy");
  if (now.getUTCHours() === 6) paths.push("/api/cron/company-newsrooms");
  if (now.getUTCHours() === 7) paths.push("/api/cron/slack-digest");
  return paths;
}

/** The routes the quarter-hour tick calls between the hourly ticks, which call them too. */
export const QUARTER_HOUR_PATHS = ["/api/cron/verify-rounds", "/api/cron/announcements"];

/** The globalThis slot HMR re-runs share, so register() arming twice still ticks once. */
export const SCHEDULER_STARTED = Symbol.for("fireround.scheduler");

export interface SchedulerOpts {
  /** Where the server answers its own cron routes, e.g. http://localhost:3000. */
  origin: string;
  /** The bearer the cron routes expect (CRON_SECRET); unset means the routes are open, as in dev. */
  secret?: string;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

function summarize(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as { skipped?: string; runs?: Array<{ runId?: string }>; lanes?: Array<{ runId?: string }> };
  if (b.skipped) return `skipped: ${b.skipped}`;
  const ids = [...(b.runs ?? []), ...(b.lanes ?? [])].map((r) => r.runId).filter(Boolean);
  return ids.length > 0 ? `runs: ${ids.join(", ")}` : JSON.stringify(body).slice(0, 200);
}

/**
 * Arm the hourly and quarter-hour ticks. Idempotent across module reloads; each tick reschedules itself with
 * setTimeout rather than setInterval, so a slow tick can never overlap the next one. The
 * timer is unref'd: an armed scheduler never keeps a dying process alive.
 */
export function startScheduler(opts: SchedulerOpts): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[SCHEDULER_STARTED]) return;
  g[SCHEDULER_STARTED] = true;

  const f = opts.fetch ?? fetch;
  const log = opts.log ?? ((msg: string) => console.log(`[scheduler] ${msg}`));

  async function tick(now: Date, paths = tickPaths(now)): Promise<void> {
    for (const path of paths) {
      try {
        const res = await f(`${opts.origin}${path}`, {
          headers: opts.secret ? { authorization: `Bearer ${opts.secret}` } : undefined,
        });
        const body: unknown = await res.json().catch(() => null);
        log(`${path} -> ${res.status} ${summarize(body)}`);
      } catch (e) {
        log(`${path} -> ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  function arm(): void {
    const now = new Date();
    const delay = nextTickDelayMs(now);
    const t = setTimeout(() => {
      void tick(new Date(now.getTime() + delay)).finally(arm);
    }, delay);
    t.unref?.();
  }

  function armVerification(): void {
    const now = new Date();
    const delay = nextVerifyDelayMs(now);
    const t = setTimeout(() => {
      void tick(new Date(now.getTime() + delay), QUARTER_HOUR_PATHS).finally(armVerification);
    }, delay);
    t.unref?.();
  }

  log(`armed; next tick at ${new Date(Date.now() + nextTickDelayMs(new Date())).toISOString()}`);
  if (process.env.SCHEDULE_TICK_ON_START === "1") void tick(new Date());
  arm();
  armVerification();
}
